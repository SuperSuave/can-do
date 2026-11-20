#include "uds_engine.h"
#include "can.h"
#include "vbat_sensor.h"
#include "can_engine.h"
#include "api.h"
#include "gvret_server.h"
#include "mqtt_mgr.h"
#include "network_mgr.h"
#include "power_mgr.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <mutex>

static const char* TAG = "UDS_ENGINE";

// BMS Diagnostic CAN IDs (Hyundai/Kia E-GMP)
#define BMS_REQ_CAN_ID   0x7E4
#define BMS_RESP_CAN_ID  0x7EC

// ISO-TP Multi-frame Assembly, Poll Session & Backoff Constants
#define ISOTP_NCR_TIMEOUT_MS         1000LL
#define ISOTP_SESSION_TIMEOUT_MS     2000LL
#define UDS_POLL_RESPONSE_TIMEOUT_MS 1000LL
#define UDS_MAX_BACKOFF_MS           (5LL * 60LL * 1000LL) // 5 minutes
#define UDS_TEC_WARN_INTERVAL_MS     5000LL

// Mutex guarding s_config, s_bms_data, and passive CAN traffic timestamp.
// Never held across I/O, WS broadcasts, MQTT publishes, or CAN TX calls.
static std::mutex s_uds_mutex;

static uds_config_t s_config = {
    .enabled = true,
    .awake_interval_sec = 15,
    .sleep_delay_sec = 10,
    .min_12v_gate_voltage = 12.2f,
    .quiet_hours_enabled = false,
    .quiet_hours_start_min = 22 * 60, // 22:00
    .quiet_hours_end_min = 7 * 60     // 07:00
};

static std::atomic<bool> s_has_seen_can_traffic{false};
static int64_t s_last_can_traffic_ms = 0; // Guarded by s_uds_mutex
static bms_live_data_t s_bms_data = {};   // Guarded by s_uds_mutex

// Deferred wake & worker notification state (CAN_RX -> UDS_WORKER)
static std::atomic<TaskHandle_t> s_worker_task_handle{nullptr};
static std::atomic<bool> s_wake_pending{false};
static std::atomic<bool> s_nrc_received{false};
static std::atomic<uint8_t> s_last_nrc_code{0};
static std::atomic<bool> s_fc_tx_failed{false};
static std::atomic<int> s_fc_tx_err{ESP_OK};

// Rate-limiting state for CAN TX Error Counter (TEC) warning
static std::mutex s_tec_log_mutex;
static bool s_has_tec_warned = false;
static int64_t s_last_tec_warn_ms = 0;

// ISO-TP Multi-frame Assembly & Handoff Slot (guarded by s_isotp_mutex)
struct isotp_completed_slot_t {
    uint8_t data[256];
    size_t len;
    bool ready;
};

static std::mutex s_isotp_mutex;
static uint8_t s_isotp_buf[256];
static size_t s_isotp_expected_len = 0;
static size_t s_isotp_received_len = 0;
static int64_t s_isotp_start_ms = 0;
static int64_t s_isotp_last_frame_ms = 0;
static uint8_t s_isotp_next_sn = 1;
static bool s_poll_inflight = false;
static int64_t s_poll_sent_ms = 0;
static isotp_completed_slot_t s_isotp_completed = {};

// Scratch buffer used exclusively by uds_worker_task for offloaded BMS decoding
static uint8_t s_worker_decode_buf[256];

static inline void reset_isotp_session_locked(void) {
    s_isotp_expected_len = 0;
    s_isotp_received_len = 0;
    s_isotp_start_ms = 0;
    s_isotp_last_frame_ms = 0;
    s_isotp_next_sn = 1;
}

static inline int64_t get_time_ms(void) {
    return esp_timer_get_time() / 1000LL;
}

static inline void notify_worker_task(void) {
    TaskHandle_t worker = s_worker_task_handle.load(std::memory_order_acquire);
    if (worker != nullptr) {
        xTaskNotifyGive(worker);
    }
}

static uds_config_t get_config_snapshot(void) {
    std::lock_guard<std::mutex> lock(s_uds_mutex);
    return s_config;
}

bool uds_engine_is_vehicle_awake(void) {
    // 1. Physical 12V hardware rail (or fresh <10s CAN 0x1CF) fallback: If LDC is active (>= 13.2V), vehicle HV system is ON
    if (vbat_sensor_is_fresh() && vbat_sensor_get_last() >= 13.2f) {
        return true;
    }

    bool had_traffic = false;
    int64_t last = 0;
    uint32_t sleep_sec = 10;
    {
        std::lock_guard<std::mutex> lock(s_uds_mutex);
        had_traffic = s_has_seen_can_traffic.load(std::memory_order_acquire);
        last = s_last_can_traffic_ms;
        sleep_sec = s_config.sleep_delay_sec > 0 ? s_config.sleep_delay_sec : 10;
    }
    if (!had_traffic) return false;

    // 2. Passive CAN traffic within sleep delay window (defaults to s_config.sleep_delay_sec, min 10s)
    return (get_time_ms() - last) <= ((int64_t)sleep_sec * 1000LL);
}

static bool is_quiet_hours(const uds_config_t& cfg) {
    if (!cfg.quiet_hours_enabled) return false;
    time_t now;
    time(&now);
    struct tm tm;
    localtime_r(&now, &tm);
    if (tm.tm_year < (2024 - 1900)) return false; // Clock unassigned

    int cur_min = tm.tm_hour * 60 + tm.tm_min;
    if (cfg.quiet_hours_start_min <= cfg.quiet_hours_end_min) {
        return (cur_min >= cfg.quiet_hours_start_min && cur_min < cfg.quiet_hours_end_min);
    } else {
        // Spans midnight, e.g. 22:00 to 07:00
        return (cur_min >= cfg.quiet_hours_start_min || cur_min < cfg.quiet_hours_end_min);
    }
}

static bool is_uds_tx_mode_allowed(const uds_config_t& cfg) {
    return cfg.enabled &&
           !g_sniffer_mode.load() &&
           !g_hardware_listen_only.load() &&
           !power_mgr_is_restarting() &&
           !g_catalog_reloading.load() &&
           !api_is_ota_in_progress() &&
           (gvret_get_client_count() == 0);
}

static bool uds_engine_is_gate_open(const uds_config_t& cfg) {
    if (!is_uds_tx_mode_allowed(cfg)) return false;

    // Gate 1: 12V Battery Gate (Hardware ADC or fresh <10s CAN 0x1CF telemetry)
    if (vbat_sensor_is_fresh()) {
        float vbat = vbat_sensor_get_last();
        if (vbat > 5.0f && vbat < cfg.min_12v_gate_voltage) {
            return false;
        }
    }

    // Gate 2: Quiet / Offline Hours
    if (is_quiet_hours(cfg)) {
        return false;
    }

    // Gate 3: Passive Vehicle Awake Gate - require passive CAN traffic within the last 500ms
    // to avoid transmitting onto the bus while ECUs are powering down / sleeping
    bool had_traffic = false;
    int64_t last = 0;
    {
        std::lock_guard<std::mutex> lock(s_uds_mutex);
        had_traffic = s_has_seen_can_traffic.load(std::memory_order_acquire);
        last = s_last_can_traffic_ms;
    }
    if (!had_traffic || (get_time_ms() - last) > 500LL) {
        return false;
    }

    return true;
}

static esp_err_t send_can_frame(uint32_t id, const uint8_t* data, uint8_t dlc, TickType_t wait_ticks) {
    if (!data || dlc > 8) return ESP_ERR_INVALID_ARG;
    twai_status_info_t info;
    esp_err_t st_err = can_engine_get_status_info(&info);
    if (st_err != ESP_OK) {
        return st_err;
    }
    if (info.state != TWAI_STATE_RUNNING) {
        return ESP_ERR_INVALID_STATE;
    }
    if (info.tx_error_counter >= 16) {
        int64_t now = get_time_ms();
        bool should_log = false;
        {
            std::lock_guard<std::mutex> lock(s_tec_log_mutex);
            if (!s_has_tec_warned || (now - s_last_tec_warn_ms) >= UDS_TEC_WARN_INTERVAL_MS) {
                s_last_tec_warn_ms = now;
                s_has_tec_warned = true;
                should_log = true;
            }
        }
        if (should_log) {
            ESP_LOGW(TAG, "CAN TX error counter elevated (%lu), suppressing UDS TX",
                     (unsigned long)info.tx_error_counter);
        }
        return ESP_ERR_INVALID_STATE;
    }
    twai_message_t tx_msg = {};
    tx_msg.identifier = id;
    tx_msg.data_length_code = dlc;
    tx_msg.extd = 0;
    tx_msg.rtr = 0;
    tx_msg.ss = 1; // Single-Shot mode: never loop in hardware retries on un-ACKed frames, eliminating BUS_OFF
    memcpy(tx_msg.data, data, dlc);
    return can_send(CAN_BUS_0, &tx_msg, wait_ticks);
}

static bool decode_bms_payload(const uint8_t* payload, size_t len) {
    // Expected response format: 0x62 0x01 0x01 ...
    if (len < 36 || payload[0] != 0x62 || payload[1] != 0x01 || payload[2] != 0x01) {
        return false;
    }

    // WiCAN 1-indexed to 0-indexed: B1 = 0, B10 = 9, B17 = 16, B19 = 18, etc.
    float soc = payload[9] / 2.0f;

    int16_t raw_current = (int16_t)(((uint16_t)payload[16] << 8) | payload[17]);
    float current_a = raw_current / 10.0f;

    uint16_t raw_voltage = (uint16_t)(((uint16_t)payload[18] << 8) | payload[19]);
    float voltage_v = raw_voltage / 10.0f;

    float power_kw = (voltage_v * current_a) / 1000.0f;

    int8_t temp_max = (int8_t)payload[20];
    int8_t temp_min = (int8_t)payload[21];

    uint8_t cell_max_raw = payload[30];
    uint8_t cell_min_raw = payload[33];

    // Plausibility validation: reject out-of-range or SNA (0xFF/0x00) BMS frames
    if (soc < 0.0f || soc > 100.0f ||
        voltage_v < 200.0f || voltage_v > 950.0f ||
        current_a < -500.0f || current_a > 1000.0f ||
        temp_min < -40 || temp_max > 100 || temp_min > temp_max ||
        cell_min_raw == 0 || cell_max_raw >= 0xFF || cell_max_raw < cell_min_raw) {
        ESP_LOGW(TAG, "Rejecting implausible/SNA BMS frame: %.1fV | %.1fA | SOC: %.1f%% | T: %dC..%dC | CellRaw: max=0x%02X min=0x%02X",
                 voltage_v, current_a, soc, (int)temp_min, (int)temp_max, cell_max_raw, cell_min_raw);
        return false;
    }

    int delta_mv = (int)(cell_max_raw - cell_min_raw) * 20;
    float cell_delta_mv = (float)delta_mv;

    {
        std::lock_guard<std::mutex> lock(s_uds_mutex);
        s_bms_data.hv_voltage = voltage_v;
        s_bms_data.hv_current = current_a;
        s_bms_data.hv_power_kw = power_kw;
        s_bms_data.bms_soc = soc;
        s_bms_data.cell_delta_mv = cell_delta_mv;
        s_bms_data.temp_min_c = temp_min;
        s_bms_data.temp_max_c = temp_max;
        s_bms_data.last_update_ms = get_time_ms();
    }

    ESP_LOGD(TAG, "BMS Live: %.1fV | %.1fA | %.2fkW | SOC: %.1f%% | Delta: %dmV | T: %dC..%dC",
             voltage_v, current_a, power_kw, soc, delta_mv, (int)temp_min, (int)temp_max);

    // Broadcast live over WebSocket (populates s_live_state_cache, /api/states & deduplicates)
    char val_str[32];
    snprintf(val_str, sizeof(val_str), "%.2f kW", power_kw);
    broadcast_ws_state("bms_hv_power_kw", val_str);

    snprintf(val_str, sizeof(val_str), "%.1f %%", soc);
    broadcast_ws_state("bms_display_soc", val_str);

    snprintf(val_str, sizeof(val_str), "%.1f V", voltage_v);
    broadcast_ws_state("bms_hv_voltage", val_str);

    snprintf(val_str, sizeof(val_str), "%.1f A", current_a);
    broadcast_ws_state("bms_hv_current", val_str);

    snprintf(val_str, sizeof(val_str), "%d mV", delta_mv);
    broadcast_ws_state("bms_cell_delta_mv", val_str);

    snprintf(val_str, sizeof(val_str), "%d °C", (int)temp_min);
    broadcast_ws_state("bms_temp_min_c", val_str);

    snprintf(val_str, sizeof(val_str), "%d °C", (int)temp_max);
    broadcast_ws_state("bms_temp_max_c", val_str);

    // Publish to MQTT
    mqtt_mgr_publish_bms(power_kw, soc, voltage_v, current_a, cell_delta_mv, temp_min, temp_max);
    return true;
}

void uds_engine_on_can_rx(const twai_message_t* msg, can_bus_t bus, bool from_physical_bus) {
    if (!msg) return;

    // Only process real physical CAN_BUS_0 frames for passive wake tracking and BMS ISO-TP reassembly
    if (!from_physical_bus || bus != CAN_BUS_0) return;

    // Filter out our own UDS traffic (0x7E4/0x7EC) and RTR frames from passive wake tracking
    // so BMS responses to our polls cannot create a self-wake feedback loop
    if (!msg->rtr && msg->identifier != BMS_REQ_CAN_ID && msg->identifier != BMS_RESP_CAN_ID) {
        int64_t now = get_time_ms();
        bool woke_from_sleep = false;
        {
            std::lock_guard<std::mutex> lock(s_uds_mutex);
            bool had_traffic = s_has_seen_can_traffic.load(std::memory_order_relaxed);
            int64_t last = s_last_can_traffic_ms;
            uint32_t sleep_sec = s_config.sleep_delay_sec > 0 ? s_config.sleep_delay_sec : 10;
            s_last_can_traffic_ms = now;
            s_has_seen_can_traffic.store(true, std::memory_order_release);
            if (!had_traffic || (now - last) > ((int64_t)sleep_sec * 1000LL)) {
                woke_from_sleep = true;
            }
        }
        if (woke_from_sleep) {
            // Vehicle transitioned from asleep to awake: defer Wi-Fi/power tier update off CAN_RX
            s_wake_pending.store(true, std::memory_order_release);
            notify_worker_task();
        }
    }

    // Process ISO-TP response from BMS (standard 11-bit classic CAN data frames only)
    if (msg->identifier == BMS_RESP_CAN_ID &&
        !msg->extd && !msg->rtr &&
        msg->data_length_code >= 2 && msg->data_length_code <= 8) {
        uint8_t pci = msg->data[0] & 0xF0;
        int64_t now = get_time_ms();

        if (pci == 0x00) {
            // Single Frame (SF): detect UDS Negative Response (0x03 0x7F 0x22 <NRC>)
            uint8_t sf_len = msg->data[0] & 0x0F;
            if (sf_len == 0x03 && msg->data_length_code >= 4 &&
                msg->data[1] == 0x7F && msg->data[2] == 0x22) {
                bool had_active_poll = false;
                {
                    std::lock_guard<std::mutex> lock(s_isotp_mutex);
                    had_active_poll = s_poll_inflight || (s_isotp_expected_len > 0);
                    s_poll_inflight = false;
                    reset_isotp_session_locked();
                }
                if (had_active_poll) {
                    s_last_nrc_code.store(msg->data[3], std::memory_order_relaxed);
                    s_nrc_received.store(true, std::memory_order_release);
                    notify_worker_task();
                }
            }
        } else if (pci == 0x10) {
            // First Frame (FF): always reset any previous ISO-TP session and check in-flight poll
            bool poll_valid = false;
            {
                std::lock_guard<std::mutex> lock(s_isotp_mutex);
                reset_isotp_session_locked();

                // Classic CAN ISO-TP First Frame requires full 8-byte DLC
                if (msg->data_length_code == 8 && s_poll_inflight) {
                    if ((now - s_poll_sent_ms) <= UDS_POLL_RESPONSE_TIMEOUT_MS) {
                        poll_valid = true;
                    }
                    // Consume the in-flight poll so at most one FC is emitted per 0x7E4 request
                    s_poll_inflight = false;
                }
            }

            if (!poll_valid) {
                return;
            }

            // Enforce all mode & lifecycle gates before transmitting Flow Control (0x30)
            uds_config_t cfg = get_config_snapshot();
            if (!is_uds_tx_mode_allowed(cfg)) {
                return;
            }

            // Parse 12-bit ISO-TP length into local size_t and validate bounds before arming
            size_t expected_len = ((size_t)(msg->data[0] & 0x0F) << 8) | msg->data[1];
            if (expected_len < 8 || expected_len > sizeof(s_isotp_buf)) {
                return;
            }

            constexpr size_t ff_chunk = 6;
            {
                std::lock_guard<std::mutex> lock(s_isotp_mutex);
                memcpy(s_isotp_buf, &msg->data[2], ff_chunk);
                s_isotp_start_ms = now;
                s_isotp_last_frame_ms = now;
                s_isotp_next_sn = 1;
                s_isotp_received_len = ff_chunk;
                s_isotp_expected_len = expected_len;
            }

            // Send Flow Control (FC) frame non-blocking (wait_ticks = 0) so CAN_RX never stalls
            uint8_t fc[8] = { 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
            esp_err_t fc_err = send_can_frame(BMS_REQ_CAN_ID, fc, 8, 0);
            if (fc_err != ESP_OK) {
                {
                    std::lock_guard<std::mutex> lock(s_isotp_mutex);
                    reset_isotp_session_locked();
                }
                s_fc_tx_err.store((int)fc_err, std::memory_order_relaxed);
                s_fc_tx_failed.store(true, std::memory_order_release);
                notify_worker_task();
            }
        } else if (pci == 0x20) {
            // Consecutive Frame (CF)
            bool completed = false;
            {
                std::lock_guard<std::mutex> lock(s_isotp_mutex);
                if (s_isotp_expected_len == 0 ||
                    s_isotp_expected_len > sizeof(s_isotp_buf) ||
                    s_isotp_received_len >= s_isotp_expected_len) {
                    if (s_isotp_expected_len > sizeof(s_isotp_buf)) {
                        reset_isotp_session_locked();
                    }
                    return;
                }

                // Enforce N_Cr (1000ms inter-frame) and total session (2000ms) timeouts
                if ((now - s_isotp_last_frame_ms) > ISOTP_NCR_TIMEOUT_MS ||
                    (now - s_isotp_start_ms) > ISOTP_SESSION_TIMEOUT_MS) {
                    reset_isotp_session_locked();
                    return;
                }

                // Validate Sequence Number (SN): 1..15 wrapping to 0..15; abort on mismatch
                uint8_t sn = msg->data[0] & 0x0F;
                if (sn != s_isotp_next_sn) {
                    reset_isotp_session_locked();
                    return;
                }

                size_t remaining = s_isotp_expected_len - s_isotp_received_len;
                size_t available_data = (size_t)(msg->data_length_code - 1);

                // Require DLC == 8 on non-final CFs (remaining >= 7), and sufficient bytes on final CF
                if (remaining >= 7) {
                    if (msg->data_length_code != 8) {
                        reset_isotp_session_locked();
                        return;
                    }
                } else {
                    if (available_data < remaining) {
                        reset_isotp_session_locked();
                        return;
                    }
                }

                size_t chunk = available_data;
                if (chunk > remaining) {
                    chunk = remaining;
                }
                size_t buf_space = sizeof(s_isotp_buf) - s_isotp_received_len;
                if (chunk > buf_space) {
                    chunk = buf_space;
                }

                memcpy(&s_isotp_buf[s_isotp_received_len], &msg->data[1], chunk);
                s_isotp_received_len += chunk;
                s_isotp_last_frame_ms = now;
                s_isotp_next_sn = (s_isotp_next_sn + 1) & 0x0F;

                if (s_isotp_received_len >= s_isotp_expected_len) {
                    // Hand off completed payload to uds_worker_task so decode/WS/MQTT never run on CAN_RX
                    memcpy(s_isotp_completed.data, s_isotp_buf, s_isotp_received_len);
                    s_isotp_completed.len = s_isotp_received_len;
                    s_isotp_completed.ready = true;
                    reset_isotp_session_locked();
                    completed = true;
                }
            }

            if (completed) {
                notify_worker_task();
            }
        }
    }
}

static int64_t compute_poll_interval_ms(uint32_t awake_interval_sec, uint8_t backoff_shift) {
    int64_t base_ms = (int64_t)(awake_interval_sec > 0 ? awake_interval_sec : 15) * 1000LL;
    int64_t interval_ms = base_ms;
    for (uint8_t i = 0; i < backoff_shift && interval_ms < UDS_MAX_BACKOFF_MS; ++i) {
        interval_ms *= 2;
    }
    if (interval_ms > UDS_MAX_BACKOFF_MS) {
        interval_ms = UDS_MAX_BACKOFF_MS;
    }
    return interval_ms;
}

static void uds_worker_task(void* arg) {
    s_worker_task_handle.store(xTaskGetCurrentTaskHandle(), std::memory_order_release);
    ESP_LOGI(TAG, "UDS diagnostic worker task running");

    int64_t last_poll_ms = 0;
    bool has_polled = false;
    bool poll_pending_outcome = false;
    uint8_t backoff_shift = 0;

    while (true) {
        // 1. Handle vehicle wake transition safely off CAN_RX
        if (s_wake_pending.exchange(false, std::memory_order_acq_rel)) {
            network_mgr_on_vehicle_awake();
            power_mgr_set_tier(POWER_TIER_ACTIVE);
        }

        uds_config_t cfg = get_config_snapshot();

        // 2. Drain any completed ISO-TP payload offloaded from CAN_RX
        size_t completed_len = 0;
        {
            std::lock_guard<std::mutex> lock(s_isotp_mutex);
            if (s_isotp_completed.ready) {
                completed_len = s_isotp_completed.len;
                if (completed_len > sizeof(s_worker_decode_buf)) {
                    completed_len = sizeof(s_worker_decode_buf);
                }
                memcpy(s_worker_decode_buf, s_isotp_completed.data, completed_len);
                s_isotp_completed.ready = false;
            }
        }
        if (completed_len > 0) {
            if (decode_bms_payload(s_worker_decode_buf, completed_len)) {
                if (backoff_shift > 0) {
                    ESP_LOGI(TAG, "Valid BMS decode received; resetting UDS poll backoff");
                    backoff_shift = 0;
                }
            }
            poll_pending_outcome = false;
        }

        // 3. Handle Single-Frame UDS Negative Response Code (0x03 0x7F 0x22 <NRC>)
        if (s_nrc_received.exchange(false, std::memory_order_acq_rel)) {
            uint8_t nrc = s_last_nrc_code.load(std::memory_order_relaxed);
            if (backoff_shift < 10) {
                backoff_shift++;
            }
            int64_t next_ms = compute_poll_interval_ms(cfg.awake_interval_sec, backoff_shift);
            ESP_LOGW(TAG, "BMS UDS NRC 0x%02X for PID 0x220101; backing off poll interval to %lus",
                     nrc, (unsigned long)(next_ms / 1000LL));
            poll_pending_outcome = false;
        }

        // 4. Handle Flow Control (0x30) TX failure from CAN_RX
        if (s_fc_tx_failed.exchange(false, std::memory_order_acq_rel)) {
            esp_err_t fc_err = (esp_err_t)s_fc_tx_err.load(std::memory_order_relaxed);
            if (backoff_shift < 10) {
                backoff_shift++;
            }
            int64_t next_ms = compute_poll_interval_ms(cfg.awake_interval_sec, backoff_shift);
            ESP_LOGW(TAG, "BMS ISO-TP Flow Control TX failed (%s); backing off poll interval to %lus",
                     esp_err_to_name(fc_err), (unsigned long)(next_ms / 1000LL));
            poll_pending_outcome = false;
        }

        // 5. Detect unanswered polls or timed-out ISO-TP sessions and apply exponential backoff
        int64_t now = get_time_ms();
        if (poll_pending_outcome) {
            bool timed_out = false;
            const char* timeout_reason = nullptr;
            {
                std::lock_guard<std::mutex> lock(s_isotp_mutex);
                if (s_poll_inflight) {
                    if ((now - s_poll_sent_ms) > UDS_POLL_RESPONSE_TIMEOUT_MS) {
                        s_poll_inflight = false;
                        timed_out = true;
                        timeout_reason = "BMS UDS poll unanswered (timeout)";
                    }
                } else if (s_isotp_expected_len > 0) {
                    if ((now - s_isotp_last_frame_ms) > ISOTP_NCR_TIMEOUT_MS ||
                        (now - s_isotp_start_ms) > ISOTP_SESSION_TIMEOUT_MS) {
                        reset_isotp_session_locked();
                        timed_out = true;
                        timeout_reason = "BMS ISO-TP session timed out";
                    }
                } else if (!s_isotp_completed.ready &&
                           !s_nrc_received.load(std::memory_order_acquire) &&
                           !s_fc_tx_failed.load(std::memory_order_acquire) &&
                           (now - s_poll_sent_ms) > UDS_POLL_RESPONSE_TIMEOUT_MS) {
                    timed_out = true;
                    timeout_reason = "BMS ISO-TP response incomplete/aborted";
                }
            }
            if (timed_out) {
                if (backoff_shift < 10) {
                    backoff_shift++;
                }
                int64_t next_ms = compute_poll_interval_ms(cfg.awake_interval_sec, backoff_shift);
                ESP_LOGW(TAG, "%s; backing off poll interval to %lus",
                         timeout_reason, (unsigned long)(next_ms / 1000LL));
                poll_pending_outcome = false;
            }
        }

        // 6. Schedule active UDS query if triple-gate is open and vehicle is stationary
        if (uds_engine_is_gate_open(cfg)) {
            // Suppress active UDS queries while vehicle is in motion / driving:
            // E-GMP gateway isolates OBD-II UDS while driving, and passive broadcast frames (0x152, 0x2FC, 0x30E) stream live telemetry
            bool driving = false;
            uint8_t speed_frame[8];
            if (get_cached_can_frame(0x1AC, speed_frame)) {
                // 0x1AC (CLU_01_20ms_2 / cluster_vehicle_speed): D1 (data[0]) = road speed in km/h (0..255, factor 1)
                if (speed_frame[0] > 0) {
                    driving = true;
                }
            }
            // Active gear check (0x045 D6 / 0x070 D8, mask 0x70: 0x00=P, 0x50=D, 0x60=N, 0x70=R).
            // Note: 0x038 D1 low nibble 0x04 is VCU car_ready_state (READY), not a gear selector.
            if (!driving) {
                uint8_t gear_frame[8];
                if (get_cached_can_frame(0x045, gear_frame)) {
                    uint8_t gear = gear_frame[5] & 0x70;
                    if (gear == 0x50 || gear == 0x70) { // Drive (0x50) or Reverse (0x70)
                        driving = true;
                    }
                }
            }
            if (!driving) {
                uint8_t gear_frame[8];
                if (get_cached_can_frame(0x070, gear_frame)) {
                    uint8_t gear = gear_frame[7] & 0x70;
                    if (gear == 0x50 || gear == 0x70) { // Drive (0x50) or Reverse (0x70)
                        driving = true;
                    }
                }
            }

            if (!driving) {
                int64_t interval_ms = compute_poll_interval_ms(cfg.awake_interval_sec, backoff_shift);
                if (!has_polled || (now - last_poll_ms) >= interval_ms) {
                    bool session_active = false;
                    {
                        std::lock_guard<std::mutex> lock(s_isotp_mutex);
                        // Drop any stale ISO-TP session before initiating a new poll; avoid overlapping an active one
                        if (s_isotp_expected_len > 0) {
                            if ((now - s_isotp_last_frame_ms) > ISOTP_NCR_TIMEOUT_MS ||
                                (now - s_isotp_start_ms) > ISOTP_SESSION_TIMEOUT_MS) {
                                reset_isotp_session_locked();
                            } else {
                                session_active = true;
                            }
                        }
                        if (!session_active) {
                            // Arm in-flight poll window before TX so an immediate BMS reply on CAN_RX is accepted
                            s_poll_sent_ms = now;
                            s_poll_inflight = true;
                        }
                    }

                    if (!session_active) {
                        last_poll_ms = now;
                        has_polled = true;

                        // Dispatch UDS Request for PID 220101 to BMS (0x7E4)
                        uint8_t req[8] = { 0x03, 0x22, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00 };
                        esp_err_t tx_err = send_can_frame(BMS_REQ_CAN_ID, req, 8, pdMS_TO_TICKS(20));
                        if (tx_err != ESP_OK) {
                            {
                                std::lock_guard<std::mutex> lock(s_isotp_mutex);
                                s_poll_inflight = false;
                            }
                            if (backoff_shift < 10) {
                                backoff_shift++;
                            }
                            int64_t next_ms = compute_poll_interval_ms(cfg.awake_interval_sec, backoff_shift);
                            ESP_LOGW(TAG, "BMS UDS poll TX failed (%s); backing off poll interval to %lus",
                                     esp_err_to_name(tx_err), (unsigned long)(next_ms / 1000LL));
                            poll_pending_outcome = false;
                        } else {
                            poll_pending_outcome = true;
                        }
                    }
                }
            }
        }

        // Wait up to 1s, or wake immediately on CAN_RX notification (wake transition, completed BMS payload, NRC, FC failure)
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
    }
}

void uds_engine_load_preferences(void) {
    FILE* f = fopen("/spiffs/preferences.json", "r");
    if (!f) return;

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > 8192) {
        if (sz > 8192) {
            ESP_LOGW(TAG, "Ignoring oversized preferences.json (%ld bytes)", sz);
        }
        fclose(f);
        return;
    }

    char* buf = (char*)malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return;
    }

    size_t n = fread(buf, 1, (size_t)sz, f);
    buf[n] = '\0';
    fclose(f);

    cJSON* root = cJSON_Parse(buf);
    free(buf);
    if (!root) return;

    // Stage parsed preferences into a local copy and swap under lock
    uds_config_t next_cfg = get_config_snapshot();

    cJSON* en = cJSON_GetObjectItem(root, "uds_enabled");
    if (cJSON_IsBool(en)) next_cfg.enabled = cJSON_IsTrue(en);

    cJSON* awake_int = cJSON_GetObjectItem(root, "uds_awake_interval_sec");
    if (cJSON_IsNumber(awake_int)) {
        int val = awake_int->valueint;
        if (val < 5) val = 5;
        if (val > 3600) val = 3600;
        next_cfg.awake_interval_sec = (uint32_t)val;
    }

    cJSON* sleep_del = cJSON_GetObjectItem(root, "uds_sleep_delay_sec");
    if (cJSON_IsNumber(sleep_del)) {
        int val = sleep_del->valueint;
        if (val < 5) val = 5;
        if (val > 300) val = 300;
        next_cfg.sleep_delay_sec = (uint32_t)val;
    }

    cJSON* v_gate = cJSON_GetObjectItem(root, "min_12v_gate_voltage");
    if (cJSON_IsNumber(v_gate) && std::isfinite(v_gate->valuedouble)) {
        float val = (float)v_gate->valuedouble;
        if (val < 10.0f) val = 10.0f;
        if (val > 14.5f) val = 14.5f;
        next_cfg.min_12v_gate_voltage = val;
    }

    cJSON* q_en = cJSON_GetObjectItem(root, "quiet_hours_enabled");
    if (cJSON_IsBool(q_en)) next_cfg.quiet_hours_enabled = cJSON_IsTrue(q_en);

    cJSON* q_start = cJSON_GetObjectItem(root, "quiet_hours_start");
    if (cJSON_IsString(q_start) && q_start->valuestring) {
        int h = 22, m = 0;
        if (sscanf(q_start->valuestring, "%d:%d", &h, &m) >= 2) {
            if (h < 0) h = 0;
            if (h > 23) h = 23;
            if (m < 0) m = 0;
            if (m > 59) m = 59;
            next_cfg.quiet_hours_start_min = (uint16_t)(h * 60 + m);
        }
    }

    cJSON* q_end = cJSON_GetObjectItem(root, "quiet_hours_end");
    if (cJSON_IsString(q_end) && q_end->valuestring) {
        int h = 7, m = 0;
        if (sscanf(q_end->valuestring, "%d:%d", &h, &m) >= 2) {
            if (h < 0) h = 0;
            if (h > 23) h = 23;
            if (m < 0) m = 0;
            if (m > 59) m = 59;
            next_cfg.quiet_hours_end_min = (uint16_t)(h * 60 + m);
        }
    }

    cJSON_Delete(root);

    {
        std::lock_guard<std::mutex> lock(s_uds_mutex);
        s_config = next_cfg;
    }

    ESP_LOGI(TAG, "UDS preferences loaded: 12V Gate: %.2fV | Quiet: %s (%02d:%02d-%02d:%02d) | Sleep delay: %lus",
             next_cfg.min_12v_gate_voltage,
             next_cfg.quiet_hours_enabled ? "ON" : "OFF",
             next_cfg.quiet_hours_start_min / 60, next_cfg.quiet_hours_start_min % 60,
             next_cfg.quiet_hours_end_min / 60, next_cfg.quiet_hours_end_min % 60,
             (unsigned long)next_cfg.sleep_delay_sec);
}

void uds_engine_init(void) {
    uds_engine_load_preferences();
    TaskHandle_t worker = nullptr;
    BaseType_t ok = xTaskCreate(uds_worker_task, "UDS_WORKER", 4096, nullptr, 3, &worker);
    if (ok != pdPASS || worker == nullptr) {
        ESP_LOGE(TAG, "Failed to create UDS_WORKER task (internal_free_heap=%u bytes)",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        return;
    }
    s_worker_task_handle.store(worker, std::memory_order_release);
    ESP_LOGI(TAG, "UDS BMS Engine initialized (Triple-Gate Protected)");
}

