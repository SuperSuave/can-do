#include "remote_climate.h"
#include "can.h"
#include "can_engine.h"
#include "api.h"
#include "mqtt_mgr.h"
#include "driver/twai.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <atomic>
#include <cmath>
#include <cstring>
#include <string>

static const char* TAG = "REMOTE_CLIMATE";

static std::atomic<bool> s_active{false};
static std::atomic<float> s_target_temp_c{22.0f};
static std::atomic<bool> s_defrost{false};
static std::atomic<uint32_t> s_duration_sec{900};
static std::atomic<uint32_t> s_start_time_ms{0};
static std::atomic<uint8_t> s_alive_counter{0};
static std::atomic<uint32_t> s_last_uds_tx_ms{0};
static std::atomic<uint32_t> s_last_nm_tx_ms{0};
static std::atomic<uint32_t> s_last_tmu_tx_ms{0};
static SemaphoreHandle_t s_climate_mutex{nullptr};

static const uint8_t UDS_TESTER_PRESENT[8] = { 0x02, 0x3E, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00 };
// AUTOSAR Network Management Cluster frames for E-GMP Gateway Wakeup
static const uint8_t AUTOSAR_NM_62[8] = { 0x62, 0x01, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF };
static const uint8_t AUTOSAR_NM_61[8] = { 0x61, 0x01, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF };
static const uint8_t AUTOSAR_NM_65[8] = { 0x65, 0x01, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF };
static const uint8_t AUTOSAR_NM_63[8] = { 0x63, 0x01, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF };

static void send_can_frame(uint32_t id, const uint8_t* data, uint8_t dlc) {
    twai_status_info_t info;
    if (can_engine_get_status_info(&info) != ESP_OK || info.state != TWAI_STATE_RUNNING || info.tx_error_counter >= 128) {
        return;
    }
    twai_message_t tx_msg = {};
    tx_msg.identifier = id;
    tx_msg.data_length_code = dlc;
    tx_msg.extd = 0;
    tx_msg.rtr = 0;
    tx_msg.ss = 1; // Single-Shot mode: prevent infinite hardware retry loop on bus error
    memcpy(tx_msg.data, data, dlc);
    can_send(CAN_BUS_0, &tx_msg, pdMS_TO_TICKS(20));
}

static void pack_tmu_01(uint8_t* data, bool aircon_on, float temp_c, bool defrost, uint8_t alive_cnt) {
    memset(data, 0, 8);

    uint8_t veh_sld_bit = 1; // CF_Tmu_VehSld: 1 = Active / Authorized subscription
    uint8_t aircon_bit = aircon_on ? 1 : 0;
    uint8_t temp_md_bit = 0; // 0 = Celsius (E-GMP DATC default)

    // OEM E-GMP DATC Celsius range: 14.0 deg C to 32.0 deg C in 0.5 deg C steps (indices 0 to 36 / 0x00 to 0x24).
    // E.g., 14.0 C -> 0 (0x00), 22.0 C (72 F) -> 16 (0x10), 32.0 C -> 36 (0x24).
    if (temp_c < 14.0f) {
        temp_c = 14.0f;
    } else if (temp_c > 32.0f) {
        temp_c = 32.0f;
    }
    int temp_code = (int)roundf((temp_c - 14.0f) / 0.5f);
    if (temp_code < 0) {
        temp_code = 0;
    } else if (temp_code > 36) {
        temp_code = 36;
    }

    // Byte 0:
    //   Bit 0: CF_Tmu_VehSld (1)
    //   Bit 4: CF_Tmu_AirconCtr (1 = Start, 0 = Stop)
    //   Bit 5: CF_Tmu_TempMd (0 = Celsius, 1 = Fahrenheit)
    //   Bits 6-7: CF_Tmu_TempSet lower 2 bits
    data[0] = (veh_sld_bit << 0) | (aircon_bit << 4) | (temp_md_bit << 5) | ((temp_code & 0x03) << 6);

    // Byte 1:
    //   Bits 0-5: CF_Tmu_TempSet upper 6 bits
    //   Bit 6: CF_Tmu_DefrostCtr (1 = Front windshield defrost active, 0 = Off)
    uint8_t defrost_bit = defrost ? 1 : 0;
    data[1] = ((temp_code >> 2) & 0x3F) | (defrost_bit << 6);

    // Byte 2:
    //   Bits 0-1: CF_Tmu_IG3Rly (3 = IG3 Relay ON / Armed, 0 = OFF)
    //   Bit 4: CF_Tmu_SepZoneDisp (1 = Active TMU Drive State, 0 = Inactive)
    if (aircon_on) {
        data[2] = 0x03 | (1 << 4); // 0x13
    } else {
        data[2] = 0x00;
    }

    // Bytes 3 - 6: 0x00 (Byte 3: CF_Tmu_AirconCtr_Cancel = 0, Bytes 4-6: Reserved)

    // Byte 7:
    //   Bits 0-3: CF_Tmu_AliveCnt1 (0 to 15 rolling counter)
    data[7] = alive_cnt & 0x0F;
}

static void publish_climate_state(bool active) {
    mqtt_mgr_publish_entity_state("remote_climate", active ? "ON" : "OFF");
    mqtt_mgr_publish_entity_state("remote_climate_tmu", active ? "Remote Climate On" : "Remote Climate Off");
    broadcast_ws_state("remote_climate", active ? "ON" : "OFF");
    broadcast_ws_state("remote_climate_tmu", active ? "Remote Climate On" : "Remote Climate Off");
}

static void remote_climate_task(void* pvParameters) {
    ESP_LOGI(TAG, "E-GMP Remote Climate background task started");
    bool was_active = false;

    while (true) {
        bool active = s_active.load();
        if (!active) {
            was_active = false;
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

        // Transition from inactive to active: send initial wakeup burst
        if (!was_active) {
            ESP_LOGI(TAG, "Waking up vehicle bus (AUTOSAR NM cluster + UDS 0x7DF)...");
            for (int i = 0; i < 15; i++) {
                send_can_frame(0x0562, AUTOSAR_NM_62, 8);
                send_can_frame(0x0561, AUTOSAR_NM_61, 8);
                send_can_frame(0x0565, AUTOSAR_NM_65, 8);
                send_can_frame(0x0563, AUTOSAR_NM_63, 8);
                send_can_frame(0x07DF, UDS_TESTER_PRESENT, 8);
                vTaskDelay(pdMS_TO_TICKS(100));
            }
            now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
            s_last_nm_tx_ms.store(now_ms);
            s_last_uds_tx_ms.store(now_ms);
            s_last_tmu_tx_ms.store(0);
            was_active = true;
        }

        // Check if duration expired
        uint32_t dur = s_duration_sec.load();
        if (dur > 0 && (now_ms - s_start_time_ms.load()) >= (dur * 1000ULL)) {
            ESP_LOGI(TAG, "Remote climate session duration (%lu s) expired. Stopping.", (unsigned long)dur);
            remote_climate_stop();
            continue;
        }

        // 1. AUTOSAR Network Management (0x0563) keepalive @ 500ms
        if ((now_ms - s_last_nm_tx_ms.load()) >= 500) {
            send_can_frame(0x0563, AUTOSAR_NM_63, 8);
            s_last_nm_tx_ms.store(now_ms);
        }

        // 2. UDS Functional TesterPresent keepalive (0x07DF) @ 500ms
        if ((now_ms - s_last_uds_tx_ms.load()) >= 500) {
            send_can_frame(0x07DF, UDS_TESTER_PRESENT, 8);
            s_last_uds_tx_ms.store(now_ms);
        }

        // 3. TMU_01_200ms frame (0x039B) @ 200ms (5Hz)
        if ((now_ms - s_last_tmu_tx_ms.load()) >= 200) {
            uint8_t payload[8];
            uint8_t cnt = s_alive_counter.load();
            pack_tmu_01(payload, true, s_target_temp_c.load(), s_defrost.load(), cnt);
            send_can_frame(0x039B, payload, 8);

            s_alive_counter.store((cnt + 1) & 0x0F);
            s_last_tmu_tx_ms.store(now_ms);
        }

        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void remote_climate_init(void) {
    if (!s_climate_mutex) {
        s_climate_mutex = xSemaphoreCreateMutex();
    }
    xTaskCreate(remote_climate_task, "REMOTE_CLIM", 3072, nullptr, 4, nullptr);
    ESP_LOGI(TAG, "Remote climate subsystem initialized");
}

esp_err_t remote_climate_start(float target_temp_c, bool defrost, uint32_t duration_sec) {
    if (s_climate_mutex) {
        xSemaphoreTake(s_climate_mutex, portMAX_DELAY);
    }

    // Auto-convert Fahrenheit input (e.g., 72.0 F) to Celsius
    if (target_temp_c > 40.0f) {
        target_temp_c = (target_temp_c - 32.0f) * 5.0f / 9.0f;
    }

    s_target_temp_c.store(target_temp_c);
    s_defrost.store(defrost);
    s_duration_sec.store(duration_sec > 0 ? duration_sec : 900);
    s_start_time_ms.store((uint32_t)(esp_timer_get_time() / 1000ULL));
    s_last_uds_tx_ms.store(0);
    s_last_nm_tx_ms.store(0);
    s_last_tmu_tx_ms.store(0);
    s_active.store(true);

    ESP_LOGI(TAG, "Starting remote climate: %.1f C, defrost=%d, duration=%lu s", 
             target_temp_c, defrost ? 1 : 0, (unsigned long)(duration_sec > 0 ? duration_sec : 900));

    publish_climate_state(true);

    if (s_climate_mutex) {
        xSemaphoreGive(s_climate_mutex);
    }
    return ESP_OK;
}

esp_err_t remote_climate_stop(void) {
    if (s_climate_mutex) {
        xSemaphoreTake(s_climate_mutex, portMAX_DELAY);
    }

    if (!s_active.load()) {
        if (s_climate_mutex) {
            xSemaphoreGive(s_climate_mutex);
        }
        return ESP_OK;
    }
    ESP_LOGI(TAG, "Stopping remote climate session and sending release burst...");
    s_active.store(false);

    // Send 5 release bursts (aircon_on = false) at 50ms intervals
    uint8_t stop_payload[8];
    for (int i = 0; i < 5; i++) {
        uint8_t cnt = s_alive_counter.load();
        pack_tmu_01(stop_payload, false, s_target_temp_c.load(), false, cnt);
        send_can_frame(0x039B, stop_payload, 8);
        s_alive_counter.store((cnt + 1) & 0x0F);
        vTaskDelay(pdMS_TO_TICKS(50));
    }

    publish_climate_state(false);
    ESP_LOGI(TAG, "Remote climate session released successfully");

    if (s_climate_mutex) {
        xSemaphoreGive(s_climate_mutex);
    }
    return ESP_OK;
}

bool remote_climate_is_active(void) {
    return s_active.load();
}

void remote_climate_get_status(bool* active, float* target_temp, bool* defrost, uint32_t* remaining_sec) {
    bool act = s_active.load();
    if (active) *active = act;
    if (target_temp) *target_temp = s_target_temp_c.load();
    if (defrost) *defrost = s_defrost.load();
    if (remaining_sec) {
        if (!act) {
            *remaining_sec = 0;
        } else {
            uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
            uint32_t elapsed_sec = (now_ms - s_start_time_ms.load()) / 1000ULL;
            uint32_t dur = s_duration_sec.load();
            *remaining_sec = (elapsed_sec >= dur) ? 0 : (dur - elapsed_sec);
        }
    }
}
