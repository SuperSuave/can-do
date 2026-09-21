#include "uds_engine.h"
#include "vbat_sensor.h"
#include "api.h"
#include "mqtt_mgr.h"
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

// ISO-TP Multi-frame Assembly state
static uint8_t s_isotp_buf[256];
static size_t s_isotp_expected_len = 0;
static size_t s_isotp_received_len = 0;
static uint32_t s_isotp_start_ms = 0;

static inline uint32_t get_time_ms(void) {
    return (uint32_t)(esp_timer_get_time() / 1000ULL);
}

bool uds_engine_is_vehicle_awake(void) {
    uint32_t last = s_last_can_traffic_ms.load();
    if (last == 0) return false;
    return (get_time_ms() - last) <= (s_config.sleep_delay_sec * 1000);
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

bool uds_engine_is_gate_open(void) {
    if (!s_config.enabled) return false;

    // Gate 1: 12V Battery Gate (Hardware ADC on GPIO 4)
    float vbat = vbat_sensor_get_last();
    if (vbat > 5.0f && vbat < s_config.min_12v_gate_voltage) {
        return false;
    }

    // Gate 2: Quiet / Offline Hours
    if (is_quiet_hours()) {
        return false;
    }

    // Gate 3: Passive Vehicle Awake Gate
    if (!uds_engine_is_vehicle_awake()) {
        return false;
    }

    return true;
}

bms_live_data_t uds_engine_get_bms_data(void) {
    return s_bms_data;
}

static void send_can_frame(uint32_t id, const uint8_t* data, uint8_t dlc) {
    twai_message_t tx_msg = {};
    tx_msg.identifier = id;
    tx_msg.data_length_code = dlc;
    tx_msg.extd = 0;
    tx_msg.rtr = 0;
    memcpy(tx_msg.data, data, dlc);
    twai_transmit(&tx_msg, pdMS_TO_TICKS(50));
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
    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"hv_power_kw\",\"state\":\"%.2f kW\"}", power_kw);
    broadcast_ws_raw(buf);

    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"bms_soc\",\"state\":\"%.1f %%\"}", soc);
    broadcast_ws_raw(buf);

    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"hv_battery_voltage\",\"state\":\"%.1f V\"}", voltage_v);
    broadcast_ws_raw(buf);

    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"hv_battery_current\",\"state\":\"%.1f A\"}", current_a);
    broadcast_ws_raw(buf);

    snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"hv_cell_delta_mv\",\"state\":\"%.0f mV\"}", cell_delta_mv);
    broadcast_ws_raw(buf);

    // Publish to MQTT
    mqtt_mgr_publish_bms(power_kw, soc, voltage_v, current_a, cell_delta_mv, temp_min, temp_max);
}

void uds_engine_on_can_rx(const twai_message_t* msg) {
    if (!msg) return;

    // Filter out our own transmitted frames
    if (msg->identifier != BMS_REQ_CAN_ID) {
        s_last_can_traffic_ms.store(get_time_ms());
    }

    // Process ISO-TP response from BMS
    if (msg->identifier == BMS_RESP_CAN_ID && msg->data_length_code > 0) {
        uint8_t pci = msg->data[0] & 0xF0;

        if (pci == 0x10) {
            // First Frame (FF): Extract length and data
            s_isotp_expected_len = ((msg->data[0] & 0x0F) << 8) | msg->data[1];
            s_isotp_received_len = 0;
            s_isotp_start_ms = get_time_ms();

            if (s_isotp_expected_len <= sizeof(s_isotp_buf)) {
                size_t chunk = msg->data_length_code - 2;
                memcpy(s_isotp_buf, &msg->data[2], chunk);
                s_isotp_received_len = chunk;

                // Send Flow Control (FC) frame: CTS, BlockSize=0, STmin=0
                uint8_t fc[8] = { 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
                send_can_frame(BMS_REQ_CAN_ID, fc, 8);
            }
        } else if (pci == 0x20) {
            // Consecutive Frame (CF)
            if (s_isotp_expected_len > 0 && s_isotp_received_len < s_isotp_expected_len) {
                size_t chunk = msg->data_length_code - 1;
                if (s_isotp_received_len + chunk > s_isotp_expected_len) {
                    chunk = s_isotp_expected_len - s_isotp_received_len;
                }
                memcpy(&s_isotp_buf[s_isotp_received_len], &msg->data[1], chunk);
                s_isotp_received_len += chunk;

                if (s_isotp_received_len >= s_isotp_expected_len) {
                    decode_bms_payload(s_isotp_buf, s_isotp_received_len);
                    s_isotp_expected_len = 0;
                }
            }
        }
    }
}

static void uds_worker_task(void* arg) {
    ESP_LOGI(TAG, "UDS diagnostic worker task running");

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));

        if (uds_engine_is_gate_open()) {
            static uint32_t s_last_poll_ms = 0;
            uint32_t now = get_time_ms();

            if (now - s_last_poll_ms >= (s_config.awake_interval_sec * 1000)) {
                s_last_poll_ms = now;

                // Dispatch UDS Request for PID 220101 to BMS (0x7E4)
                uint8_t req[8] = { 0x03, 0x22, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00 };
                send_can_frame(BMS_REQ_CAN_ID, req, 8);
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
    xTaskCreate(uds_worker_task, "UDS_WORKER", 3072, nullptr, 3, nullptr);
    ESP_LOGI(TAG, "UDS BMS Engine initialized (Triple-Gate Protected)");
}

