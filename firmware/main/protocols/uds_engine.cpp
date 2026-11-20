#include "uds_engine.h"
#include "can.h"
#include "vbat_sensor.h"
#include "can_engine.h"
#include "api.h"
#include "gvret_server.h"
#include "mqtt_mgr.h"
#include "network_mgr.h"
#include "power_mgr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <ctime>
#include <cstring>
#include <atomic>

static const char* TAG = "UDS_ENGINE";

// BMS Diagnostic CAN IDs (Hyundai/Kia E-GMP)
#define BMS_REQ_CAN_ID   0x7E4
#define BMS_RESP_CAN_ID  0x7EC

static uds_config_t s_config = {
    .enabled = true,
    .awake_interval_sec = 15,
    .sleep_delay_sec = 10,
    .min_12v_gate_voltage = 12.2f,
    .quiet_hours_enabled = false,
    .quiet_hours_start_min = 22 * 60, // 22:00
    .quiet_hours_end_min = 7 * 60     // 07:00
};

uds_config_t uds_engine_get_config(void) {
    return s_config;
}

void uds_engine_set_config(const uds_config_t* cfg) {
    if (cfg) {
        s_config = *cfg;
    }
}

static std::atomic<uint32_t> s_last_can_traffic_ms{0};
static bms_live_data_t s_bms_data = {};

// ISO-TP Multi-frame Assembly & Poll Session state
#define ISOTP_NCR_TIMEOUT_MS         1000
#define ISOTP_SESSION_TIMEOUT_MS     2000
#define UDS_POLL_RESPONSE_TIMEOUT_MS 1000

static uint8_t s_isotp_buf[256];
static std::atomic<size_t> s_isotp_expected_len{0};
static std::atomic<size_t> s_isotp_received_len{0};
static std::atomic<uint32_t> s_isotp_start_ms{0};
static std::atomic<uint32_t> s_isotp_last_frame_ms{0};
static std::atomic<uint8_t> s_isotp_next_sn{1};
static std::atomic<bool> s_poll_inflight{false};
static std::atomic<uint32_t> s_poll_sent_ms{0};

static inline void reset_isotp_session(void) {
    s_isotp_expected_len.store(0, std::memory_order_release);
    s_isotp_received_len.store(0, std::memory_order_relaxed);
    s_isotp_start_ms.store(0, std::memory_order_relaxed);
    s_isotp_last_frame_ms.store(0, std::memory_order_relaxed);
    s_isotp_next_sn.store(1, std::memory_order_relaxed);
}

static inline uint32_t get_time_ms(void) {
    return (uint32_t)(esp_timer_get_time() / 1000ULL);
}

bool uds_engine_is_vehicle_awake(void) {
    // 1. Physical 12V hardware rail fallback: If LDC is active (>= 13.2V), vehicle HV system is ON
    if (vbat_sensor_get_last() >= 13.2f) {
        return true;
    }

    uint32_t last = s_last_can_traffic_ms.load();
    if (last == 0) return false;

    // 2. Passive CAN traffic within sleep delay window (defaults to s_config.sleep_delay_sec, min 10s)
    uint32_t sleep_sec = s_config.sleep_delay_sec > 0 ? s_config.sleep_delay_sec : 10;
    return (get_time_ms() - last) <= (sleep_sec * 1000);
}

static bool is_quiet_hours(void) {
    if (!s_config.quiet_hours_enabled) return false;
    time_t now;
    time(&now);
    struct tm tm;
    localtime_r(&now, &tm);
    if (tm.tm_year < (2024 - 1900)) return false; // Clock unassigned

    int cur_min = tm.tm_hour * 60 + tm.tm_min;
    if (s_config.quiet_hours_start_min <= s_config.quiet_hours_end_min) {
        return (cur_min >= s_config.quiet_hours_start_min && cur_min < s_config.quiet_hours_end_min);
    } else {
        // Spans midnight, e.g. 22:00 to 07:00
        return (cur_min >= s_config.quiet_hours_start_min || cur_min < s_config.quiet_hours_end_min);
    }
}

static bool is_uds_tx_mode_allowed(void) {
    return s_config.enabled &&
           !g_sniffer_mode.load() &&
           !g_hardware_listen_only.load() &&
           !power_mgr_is_restarting() &&
           !g_catalog_reloading.load() &&
           !api_is_ota_in_progress() &&
           (gvret_get_client_count() == 0);
}

bool uds_engine_is_gate_open(void) {
    if (!is_uds_tx_mode_allowed()) return false;

    // Gate 1: 12V Battery Gate (Hardware ADC on GPIO 4)
    float vbat = vbat_sensor_get_last();
    if (vbat > 5.0f && vbat < s_config.min_12v_gate_voltage) {
        return false;
    }

    // Gate 2: Quiet / Offline Hours
    if (is_quiet_hours()) {
        return false;
    }

    // Gate 3: Passive Vehicle Awake Gate - require passive CAN traffic within the last 500ms
    // to avoid transmitting onto the bus while ECUs are powering down / sleeping
    uint32_t last = s_last_can_traffic_ms.load();
    if (last == 0 || (get_time_ms() - last) > 500) {
        return false;
    }

    return true;
}

bms_live_data_t uds_engine_get_bms_data(void) {
    return s_bms_data;
}

static bool send_can_frame(uint32_t id, const uint8_t* data, uint8_t dlc) {
    if (!data || dlc > 8) return false;
    twai_status_info_t info;
    if (can_engine_get_status_info(&info) != ESP_OK || info.state != TWAI_STATE_RUNNING) {
        return false;
    }
    if (info.tx_error_counter >= 16) {
        ESP_LOGW(TAG, "CAN TX error counter elevated (%lu), suppressing UDS TX", 
                 (unsigned long)info.tx_error_counter);
        return false;
    }
    twai_message_t tx_msg = {};
    tx_msg.identifier = id;
    tx_msg.data_length_code = dlc;
    tx_msg.extd = 0;
    tx_msg.rtr = 0;
    tx_msg.ss = 1; // Single-Shot mode: never loop in hardware retries on un-ACKed frames, eliminating BUS_OFF
    memcpy(tx_msg.data, data, dlc);
    return can_send(CAN_BUS_0, &tx_msg, pdMS_TO_TICKS(20)) == ESP_OK;
}

static void decode_bms_payload(const uint8_t* payload, size_t len) {
    // Expected response format: 0x62 0x01 0x01 ...
    if (len < 36 || payload[0] != 0x62 || payload[1] != 0x01 || payload[2] != 0x01) {
        return;
    }

    // WiCAN 1-indexed to 0-indexed: B1 = 0, B10 = 9, B17 = 16, B19 = 18, etc.
    float soc = payload[9] / 2.0f;

    int16_t raw_current = (int16_t)((payload[16] << 8) | payload[17]);
    float current_a = raw_current / 10.0f;

    uint16_t raw_voltage = (uint16_t)((payload[18] << 8) | payload[19]);
    float voltage_v = raw_voltage / 10.0f;

    float power_kw = (voltage_v * current_a) / 1000.0f;

    int8_t temp_max = (int8_t)payload[20];
    int8_t temp_min = (int8_t)payload[21];

    float cell_max_v = payload[30] / 50.0f;
    float cell_min_v = payload[33] / 50.0f;
    float cell_delta_mv = (cell_max_v - cell_min_v) * 1000.0f;

    s_bms_data.hv_voltage = voltage_v;
    s_bms_data.hv_current = current_a;
    s_bms_data.hv_power_kw = power_kw;
    s_bms_data.bms_soc = soc;
    s_bms_data.cell_delta_mv = cell_delta_mv;
    s_bms_data.temp_min_c = temp_min;
    s_bms_data.temp_max_c = temp_max;
    s_bms_data.last_update_ms = get_time_ms();

    ESP_LOGI(TAG, "BMS Live: %.1fV | %.1fA | %.2fkW | SOC: %.1f%% | Delta: %.0fmV | T: %dC..%dC",
             voltage_v, current_a, power_kw, soc, cell_delta_mv, temp_min, temp_max);

    // Broadcast live over WebSocket
    char buf[128];
    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"bms_hv_power_kw\",\"state\":\"%.2f kW\"}", power_kw);
    broadcast_ws_raw(buf);

    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"bms_display_soc\",\"state\":\"%.1f %%\"}", soc);
    broadcast_ws_raw(buf);

    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"bms_hv_voltage\",\"state\":\"%.1f V\"}", voltage_v);
    broadcast_ws_raw(buf);

    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"bms_hv_current\",\"state\":\"%.1f A\"}", current_a);
    broadcast_ws_raw(buf);

    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"bms_cell_delta_mv\",\"state\":\"%.0f mV\"}", cell_delta_mv);
    broadcast_ws_raw(buf);

    // Publish to MQTT
    mqtt_mgr_publish_bms(power_kw, soc, voltage_v, current_a, cell_delta_mv, temp_min, temp_max);
}

void uds_engine_on_can_rx(const twai_message_t* msg, can_bus_t bus, bool from_physical_bus) {
    if (!msg) return;

    // Only process real physical CAN_BUS_0 frames for passive wake tracking and BMS ISO-TP reassembly
    if (!from_physical_bus || bus != CAN_BUS_0) return;

    // Filter out our own UDS traffic (0x7E4/0x7EC) and RTR frames from passive wake tracking
    // so BMS responses to our polls cannot create a self-wake feedback loop
    if (!msg->rtr && msg->identifier != BMS_REQ_CAN_ID && msg->identifier != BMS_RESP_CAN_ID) {
        uint32_t now = get_time_ms();
        uint32_t last = s_last_can_traffic_ms.exchange(now);
        uint32_t sleep_sec = s_config.sleep_delay_sec > 0 ? s_config.sleep_delay_sec : 10;
        if (last == 0 || (now - last) > (sleep_sec * 1000)) {
            // Vehicle transitioned from asleep to awake: instantly disable Wi-Fi modem sleep and set active tier
            network_mgr_on_vehicle_awake();
            power_mgr_set_tier(POWER_TIER_ACTIVE);
        }
    }

    // Process ISO-TP response from BMS (standard 11-bit classic CAN data frames only)
    if (msg->identifier == BMS_RESP_CAN_ID &&
        !msg->extd && !msg->rtr &&
        msg->data_length_code >= 2 && msg->data_length_code <= 8) {
        uint8_t pci = msg->data[0] & 0xF0;
        uint32_t now = get_time_ms();

        if (pci == 0x10) {
            // First Frame (FF): always reset any previous ISO-TP session first
            reset_isotp_session();

            // Classic CAN ISO-TP First Frame requires full 8-byte DLC
            if (msg->data_length_code != 8) {
                return;
            }

            // Only transmit Flow Control (0x30) when CAN Do has an active, un-timed-out 0x7E4 poll in flight
            bool inflight = s_poll_inflight.load(std::memory_order_acquire);
            uint32_t poll_sent_ms = s_poll_sent_ms.load(std::memory_order_relaxed);
            if (!inflight || (now - poll_sent_ms) > UDS_POLL_RESPONSE_TIMEOUT_MS) {
                s_poll_inflight.store(false, std::memory_order_release);
                return;
            }
            // Consume the in-flight poll so at most one FC is emitted per 0x7E4 request
            s_poll_inflight.store(false, std::memory_order_release);

            // Enforce all mode & lifecycle gates before transmitting Flow Control (0x30)
            if (!is_uds_tx_mode_allowed()) {
                return;
            }

            // Parse 12-bit ISO-TP length into local size_t and validate bounds before arming
            size_t expected_len = ((size_t)(msg->data[0] & 0x0F) << 8) | msg->data[1];
            if (expected_len < 8 || expected_len > sizeof(s_isotp_buf)) {
                return;
            }

            constexpr size_t ff_chunk = 6;
            memcpy(s_isotp_buf, &msg->data[2], ff_chunk);
            s_isotp_start_ms.store(now, std::memory_order_relaxed);
            s_isotp_last_frame_ms.store(now, std::memory_order_relaxed);
            s_isotp_next_sn.store(1, std::memory_order_relaxed);
            s_isotp_received_len.store(ff_chunk, std::memory_order_relaxed);
            s_isotp_expected_len.store(expected_len, std::memory_order_release);

            // Send Flow Control (FC) frame: CTS, BlockSize=0, STmin=0
            uint8_t fc[8] = { 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
            if (!send_can_frame(BMS_REQ_CAN_ID, fc, 8)) {
                reset_isotp_session();
            }
        } else if (pci == 0x20) {
            // Consecutive Frame (CF)
            size_t expected_len = s_isotp_expected_len.load(std::memory_order_acquire);
            size_t received_len = s_isotp_received_len.load(std::memory_order_relaxed);
            if (expected_len == 0 || expected_len > sizeof(s_isotp_buf) || received_len >= expected_len) {
                if (expected_len > sizeof(s_isotp_buf)) {
                    reset_isotp_session();
                }
                return;
            }

            // Enforce N_Cr (1000ms inter-frame) and total session (2000ms) timeouts
            uint32_t last_frame_ms = s_isotp_last_frame_ms.load(std::memory_order_relaxed);
            uint32_t start_ms = s_isotp_start_ms.load(std::memory_order_relaxed);
            if ((now - last_frame_ms) > ISOTP_NCR_TIMEOUT_MS || (now - start_ms) > ISOTP_SESSION_TIMEOUT_MS) {
                reset_isotp_session();
                return;
            }

            // Validate Sequence Number (SN): 1..15 wrapping to 0..15; abort on mismatch
            uint8_t sn = msg->data[0] & 0x0F;
            uint8_t expected_sn = s_isotp_next_sn.load(std::memory_order_relaxed);
            if (sn != expected_sn) {
                reset_isotp_session();
                return;
            }

            size_t remaining = expected_len - received_len;
            size_t available_data = (size_t)(msg->data_length_code - 1);

            // Require DLC == 8 on non-final CFs (remaining >= 7), and sufficient bytes on final CF
            if (remaining >= 7) {
                if (msg->data_length_code != 8) {
                    reset_isotp_session();
                    return;
                }
            } else {
                if (available_data < remaining) {
                    reset_isotp_session();
                    return;
                }
            }

            size_t chunk = available_data;
            if (chunk > remaining) {
                chunk = remaining;
            }
            size_t buf_space = sizeof(s_isotp_buf) - received_len;
            if (chunk > buf_space) {
                chunk = buf_space;
            }

            memcpy(&s_isotp_buf[received_len], &msg->data[1], chunk);
            received_len += chunk;
            s_isotp_received_len.store(received_len, std::memory_order_relaxed);
            s_isotp_last_frame_ms.store(now, std::memory_order_relaxed);
            s_isotp_next_sn.store((expected_sn + 1) & 0x0F, std::memory_order_relaxed);

            if (received_len >= expected_len) {
                decode_bms_payload(s_isotp_buf, received_len);
                reset_isotp_session();
            }
        }
    }
}

static void uds_worker_task(void* arg) {
    ESP_LOGI(TAG, "UDS diagnostic worker task running");

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));

        if (uds_engine_is_gate_open()) {
            // Suppress active UDS queries while vehicle is in motion / driving:
            // E-GMP gateway isolates OBD-II UDS while driving, and passive broadcast frames (0x152, 0x2FC, 0x30E) stream live telemetry
            uint8_t speed_frame[8];
            if (get_cached_can_frame(0x1AC, speed_frame)) {
                // 0x1AC (CLU_01_20ms_2 / cluster_vehicle_speed): D1 (data[0]) = road speed in km/h (0..255, factor 1)
                if (speed_frame[0] > 0) {
                    continue;
                }
            }
            // Active gear check (0x045 D6 / 0x070 D8, mask 0x70: 0x00=P, 0x50=D, 0x60=N, 0x70=R).
            // Note: 0x038 D1 low nibble 0x04 is VCU car_ready_state (READY), not a gear selector.
            uint8_t gear_frame[8];
            if (get_cached_can_frame(0x045, gear_frame)) {
                uint8_t gear = gear_frame[5] & 0x70;
                if (gear == 0x50 || gear == 0x70) { // Drive (0x50) or Reverse (0x70)
                    continue;
                }
            }
            if (get_cached_can_frame(0x070, gear_frame)) {
                uint8_t gear = gear_frame[7] & 0x70;
                if (gear == 0x50 || gear == 0x70) { // Drive (0x50) or Reverse (0x70)
                    continue;
                }
            }

            static uint32_t s_last_poll_ms = 0;
            uint32_t now = get_time_ms();

            if (now - s_last_poll_ms >= (s_config.awake_interval_sec * 1000)) {
                // Drop any stale ISO-TP session before initiating a new poll; avoid overlapping an active one
                if (s_isotp_expected_len.load(std::memory_order_acquire) > 0) {
                    uint32_t last_frame_ms = s_isotp_last_frame_ms.load(std::memory_order_relaxed);
                    uint32_t start_ms = s_isotp_start_ms.load(std::memory_order_relaxed);
                    if ((now - last_frame_ms) > ISOTP_NCR_TIMEOUT_MS || (now - start_ms) > ISOTP_SESSION_TIMEOUT_MS) {
                        reset_isotp_session();
                    } else {
                        continue;
                    }
                }

                s_last_poll_ms = now;

                // Arm in-flight poll window before TX so an immediate BMS reply on CAN_RX is accepted
                s_poll_sent_ms.store(now, std::memory_order_relaxed);
                s_poll_inflight.store(true, std::memory_order_release);

                // Dispatch UDS Request for PID 220101 to BMS (0x7E4)
                uint8_t req[8] = { 0x03, 0x22, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00 };
                if (!send_can_frame(BMS_REQ_CAN_ID, req, 8)) {
                    s_poll_inflight.store(false, std::memory_order_release);
                }
            }
        }
    }
}

void uds_engine_load_preferences(void) {
    FILE* f = fopen("/spiffs/preferences.json", "r");
    if (!f) return;

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0) { fclose(f); return; }

    char* buf = (char*)malloc(sz + 1);
    if (!buf) { fclose(f); return; }

    fread(buf, 1, sz, f);
    buf[sz] = '\0';
    fclose(f);

    cJSON* root = cJSON_Parse(buf);
    free(buf);
    if (!root) return;

    cJSON* en = cJSON_GetObjectItem(root, "uds_enabled");
    if (cJSON_IsBool(en)) s_config.enabled = cJSON_IsTrue(en);

    cJSON* awake_int = cJSON_GetObjectItem(root, "uds_awake_interval_sec");
    if (cJSON_IsNumber(awake_int) && awake_int->valueint > 0) s_config.awake_interval_sec = awake_int->valueint;

    cJSON* sleep_del = cJSON_GetObjectItem(root, "uds_sleep_delay_sec");
    if (cJSON_IsNumber(sleep_del) && sleep_del->valueint > 0) s_config.sleep_delay_sec = sleep_del->valueint;

    cJSON* v_gate = cJSON_GetObjectItem(root, "min_12v_gate_voltage");
    if (cJSON_IsNumber(v_gate) && v_gate->valuedouble > 5.0) s_config.min_12v_gate_voltage = (float)v_gate->valuedouble;

    cJSON* q_en = cJSON_GetObjectItem(root, "quiet_hours_enabled");
    if (cJSON_IsBool(q_en)) s_config.quiet_hours_enabled = cJSON_IsTrue(q_en);

    cJSON* q_start = cJSON_GetObjectItem(root, "quiet_hours_start");
    if (cJSON_IsString(q_start) && q_start->valuestring) {
        int h = 22, m = 0;
        if (sscanf(q_start->valuestring, "%d:%d", &h, &m) >= 2) {
            s_config.quiet_hours_start_min = h * 60 + m;
        }
    }

    cJSON* q_end = cJSON_GetObjectItem(root, "quiet_hours_end");
    if (cJSON_IsString(q_end) && q_end->valuestring) {
        int h = 7, m = 0;
        if (sscanf(q_end->valuestring, "%d:%d", &h, &m) >= 2) {
            s_config.quiet_hours_end_min = h * 60 + m;
        }
    }

    cJSON_Delete(root);
    ESP_LOGI(TAG, "UDS preferences loaded: 12V Gate: %.2fV | Quiet: %s (%02d:%02d-%02d:%02d) | Sleep delay: %lus",
             s_config.min_12v_gate_voltage,
             s_config.quiet_hours_enabled ? "ON" : "OFF",
             s_config.quiet_hours_start_min / 60, s_config.quiet_hours_start_min % 60,
             s_config.quiet_hours_end_min / 60, s_config.quiet_hours_end_min % 60,
             (unsigned long)s_config.sleep_delay_sec);
}

void uds_engine_init(void) {
    uds_engine_load_preferences();
    xTaskCreate(uds_worker_task, "UDS_WORKER", 4096, nullptr, 3, nullptr);
    ESP_LOGI(TAG, "UDS BMS Engine initialized (Triple-Gate Protected)");
}

