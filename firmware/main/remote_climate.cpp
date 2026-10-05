#include "remote_climate.h"
#include <atomic>
#include <cmath>
#include <cstring>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/twai.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "board_pins.h"
#include "api.h"
#include "vbat_sensor.h"

static const char* TAG = "REMOTE_CLIMATE";

static std::atomic<bool> s_climate_running{false};
static std::atomic<bool> s_stop_requested{false};
static TaskHandle_t s_climate_task_handle = nullptr;

static float s_target_temp_c = 22.0f;
static uint32_t s_duration_min = 10;

static void remote_climate_worker_task(void* pvParameters) {
    s_climate_running.store(true);
    s_stop_requested.store(false);

    float temp_c = s_target_temp_c;
    uint32_t dur_min = s_duration_min;
    if (dur_min == 0) dur_min = 10;

    float temp_f = (temp_c * 9.0f / 5.0f) + 32.0f;
    uint8_t temp_byte = static_cast<uint8_t>(std::round(temp_c * 2.0f));

    ESP_LOGI(TAG, "Starting HKMC Remote Climate loop for %lu mins at %.1f°C (%.0f°F, raw: 0x%02X)",
             (unsigned long)dur_min, temp_c, temp_f, temp_byte);

    char state_buf[64];
    snprintf(state_buf, sizeof(state_buf), "Running (%.0f°F)", temp_f);
    broadcast_ws_state("hvac_direct_climate_cmd", state_buf);

    // Frame 1: 0x4F1 CLU11 Keep-Alive / Wake frame
    twai_message_t wake_msg = {};
    wake_msg.identifier = 0x4F1;
    wake_msg.extd = 0;
    wake_msg.data_length_code = 8;
    wake_msg.data[0] = 0x00;
    wake_msg.data[1] = 0xD0;
    wake_msg.data[2] = 0x00;
    wake_msg.data[3] = 0x00;
    wake_msg.data[4] = 0x00;
    wake_msg.data[5] = 0x00;
    wake_msg.data[6] = 0x00;
    wake_msg.data[7] = 0x00;

    // Frame 2: 0x520 DATC11 Remote Climate Command frame
    twai_message_t datc_msg = {};
    datc_msg.identifier = 0x520;
    datc_msg.extd = 0;
    datc_msg.data_length_code = 8;
    datc_msg.data[0] = 0x01; // Power ON
    datc_msg.data[1] = temp_byte; // Setpoint (Temp_C * 2)
    datc_msg.data[2] = 0x04; // Auto mode / blower
    datc_msg.data[3] = 0x01; // Distribution
    datc_msg.data[4] = 0x00;
    datc_msg.data[5] = 0x00;
    datc_msg.data[6] = 0x00;
    datc_msg.data[7] = 0x00;

    int64_t start_us = esp_timer_get_time();
    int64_t max_duration_us = (int64_t)dur_min * 60ULL * 1000000ULL;

    while (!s_stop_requested.load()) {
        int64_t elapsed_us = esp_timer_get_time() - start_us;
        if (elapsed_us >= max_duration_us) {
            ESP_LOGI(TAG, "Duration expired (%lu mins). Stopping climate.", (unsigned long)dur_min);
            break;
        }

        // Safety gate: Check 12V battery voltage (don't drain dead battery)
        float vbat = vbat_sensor_get_last();
        if (vbat > 5.0f && vbat < 11.5f) {
            ESP_LOGW(TAG, "12V Battery too low (%.2fV)! Aborting climate for safety.", vbat);
            break;
        }

        // 1. Send 0x4F1 Keep-Alive
        twai_transmit(&wake_msg, pdMS_TO_TICKS(10));

        // 2. Send 0x520 DATC Climate Command
        twai_transmit(&datc_msg, pdMS_TO_TICKS(10));
        board_led_can_activity();

        // 100ms cycle
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    // Send OFF frame (Byte 0 = 0x00) 5 times to cleanly stop HVAC
    datc_msg.data[0] = 0x00;
    for (int i = 0; i < 5; i++) {
        twai_transmit(&datc_msg, pdMS_TO_TICKS(10));
        vTaskDelay(pdMS_TO_TICKS(50));
    }

    s_climate_running.store(false);
    s_stop_requested.store(false);
    s_climate_task_handle = nullptr;

    broadcast_ws_state("hvac_direct_climate_cmd", "Off");
    ESP_LOGI(TAG, "HKMC Remote Climate stopped.");
    vTaskDelete(NULL);
}

void remote_climate_init(void) {
    s_climate_running.store(false);
    s_stop_requested.store(false);
}

bool remote_climate_start(float target_temp_c, uint32_t duration_minutes) {
    if (s_climate_running.load()) {
        ESP_LOGW(TAG, "Remote climate already running");
        return true;
    }
    s_target_temp_c = target_temp_c > 0.0f ? target_temp_c : 22.0f;
    s_duration_min = duration_minutes > 0 ? duration_minutes : 10;
    s_stop_requested.store(false);

    BaseType_t ret = xTaskCreate(remote_climate_worker_task, "rem_climate", 3072, nullptr, 4, &s_climate_task_handle);
    return (ret == pdPASS);
}

void remote_climate_stop(void) {
    if (s_climate_running.load()) {
        s_stop_requested.store(true);
    }
}

void remote_climate_toggle(float target_temp_c, uint32_t duration_minutes) {
    if (s_climate_running.load()) {
        remote_climate_stop();
    } else {
        remote_climate_start(target_temp_c, duration_minutes);
    }
}

bool remote_climate_is_active(void) {
    return s_climate_running.load();
}
