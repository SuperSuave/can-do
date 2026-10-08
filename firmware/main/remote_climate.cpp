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

struct ClimateTaskParams {
    float target_temp_c;
    uint32_t duration_min;
    bool monitor_0x38;
};

static std::atomic<bool> s_climate_running{false};
static std::atomic<bool> s_stop_requested{false};
static std::atomic<bool> s_hv_ready{false};
static TaskHandle_t s_climate_task_handle = nullptr;

static float s_target_temp_c = 22.0f;
static uint32_t s_duration_min = 10;
static bool s_monitor_0x38 = true;

void remote_climate_on_can_rx(const twai_message_t* rx_msg) {
    if (!rx_msg || rx_msg->rtr) return;
    // Power State frame 0x038: Wait until Byte 6 == 0x82 (HV Ready).
    // Support both 0-indexed byte 6 (data[6]) and 1-indexed byte 6 (data[5])
    if (rx_msg->identifier == 0x038 && rx_msg->data_length_code >= 6) {
        if ((rx_msg->data_length_code >= 7 && rx_msg->data[6] == 0x82) ||
            rx_msg->data[5] == 0x82) {
            s_hv_ready.store(true);
        }
    }
}

static void send_can_frame(uint32_t id, const uint8_t data[8]) {
    twai_message_t msg = {};
    msg.identifier = id;
    msg.extd = 0;
    msg.data_length_code = 8;
    memcpy(msg.data, data, 8);
    esp_err_t res = twai_transmit(&msg, pdMS_TO_TICKS(50));
    if (res == ESP_OK) {
        board_led_can_activity();
    } else {
        ESP_LOGW(TAG, "Failed to transmit CAN ID 0x%03lX (err %d)", (unsigned long)id, res);
    }
}

static void remote_climate_worker_task(void* pvParameters) {
    s_climate_running.store(true);
    s_stop_requested.store(false);
    s_hv_ready.store(false);

    ClimateTaskParams params = { s_target_temp_c, s_duration_min, s_monitor_0x38 };
    if (pvParameters) {
        params = *(ClimateTaskParams*)pvParameters;
        delete (ClimateTaskParams*)pvParameters;
    }

    ESP_LOGI(TAG, "Starting HKMC Remote Climate Sequence (Mode: %s, Setpoint: %.1f°C)...",
             params.monitor_0x38 ? "SMART [Monitor 0x038]" : "DUMB [15s Fallback]",
             params.target_temp_c);

    // Safety gate: Check 12V battery voltage (don't drain dead battery)
    float vbat = vbat_sensor_get_last();
    if (vbat > 5.0f && vbat < 11.5f) {
        ESP_LOGW(TAG, "12V Battery too low (%.2fV)! Aborting climate for safety.", vbat);
        goto cleanup;
    }

    // ==========================================
    // Phase 1: Bus Wakeup (Wake the ECUs)
    // Send: 0x562 | 62 01 00 00 00 00 FF FF (x1 frame)
    // Delay: 400 ms (Let Central Gateway, BMS, HVAC modules boot up)
    // ==========================================
    if (s_stop_requested.load()) goto cleanup;
    broadcast_ws_state("remote_climate_state", "Phase 1: Bus Wakeup (0x562)");
    {
        const uint8_t wake_562[8] = { 0x62, 0x01, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF };
        send_can_frame(0x562, wake_562);
        ESP_LOGI(TAG, "Phase 1: 0x562 ECU wakeup frame transmitted. Dwell 400ms...");
        vTaskDelay(pdMS_TO_TICKS(400));
    }

    // ==========================================
    // Phase 2: HV Pre-Charge Loop (Init Phase)
    // Broadcast: 0x4F1 | 00 F0 00 00 00 00 00 00 once every 1,000 ms (1s)
    // Smart: Listen for 0x038 Byte 6 == 0x82 (HV Ready)
    // Dumb: Repeat 15 times (15 seconds fallback)
    // ==========================================
    if (s_stop_requested.load()) goto cleanup;
    broadcast_ws_state("remote_climate_state", params.monitor_0x38 ? "Phase 2: HV Pre-Charge (Listening 0x038)" : "Phase 2: HV Pre-Charge (Timed 15s)");
    {
        const uint8_t init_4f1[8] = { 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };

        if (params.monitor_0x38) {
            ESP_LOGI(TAG, "Phase 2 (Smart): Broadcasting 0x4F1 (00 F0) every 1s, listening for 0x038 Byte 6 == 0x82...");
            int elapsed_sec = 0;
            const int max_wait_sec = 30; // 30s timeout

            while (!s_stop_requested.load() && elapsed_sec < max_wait_sec) {
                send_can_frame(0x4F1, init_4f1);

                // Dwell 1000ms in 100ms slices to react immediately when 0x038 arrives
                for (int slice = 0; slice < 10; slice++) {
                    vTaskDelay(pdMS_TO_TICKS(100));
                    if (s_stop_requested.load()) break;
                    if (s_hv_ready.load()) {
                        ESP_LOGI(TAG, "0x038 HV Ready (0x82) received at second %d! Proceeding immediately to Phase 3.", elapsed_sec + 1);
                        break;
                    }
                }
                if (s_hv_ready.load() || s_stop_requested.load()) break;
                elapsed_sec++;
            }

            if (!s_hv_ready.load() && !s_stop_requested.load()) {
                ESP_LOGW(TAG, "0x038 HV Ready not detected within %ds timeout. Proceeding with command anyway...", max_wait_sec);
            }
        } else {
            ESP_LOGI(TAG, "Phase 2 (Dumb): Broadcasting 0x4F1 (00 F0) 15 times (15 seconds fallback)...");
            for (int sec = 0; sec < 15; sec++) {
                if (s_stop_requested.load()) break;
                send_can_frame(0x4F1, init_4f1);
                vTaskDelay(pdMS_TO_TICKS(1000));
            }
        }
    }

    // ==========================================
    // Phase 3 & 4: Command Active Phase & HVAC Execution
    // Broadcast: 0x4F1 | 00 D0 00 00 00 00 00 00 once every 1s for 4s total.
    // Immediately fire 0x4A2 execution macro:
    // 0x4A2 | 00 00 0C 00 00 00 00 00 (x3, 40ms delay between each) (Prepare)
    // 0x4A2 | 00 03 FC 00 FF FF 00 00 (x3, 40ms delay between each) (Execute)
    // ==========================================
    if (s_stop_requested.load()) goto cleanup;
    broadcast_ws_state("remote_climate_state", "Phase 3: Command Active & Trigger (0x4A2)");
    {
        const uint8_t cmd_active_4f1[8] = { 0x00, 0xD0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
        const uint8_t prep_4a2[8]       = { 0x00, 0x00, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00 };
        const uint8_t exec_4a2[8]       = { 0x00, 0x03, 0xFC, 0x00, 0xFF, 0xFF, 0x00, 0x00 };

        ESP_LOGI(TAG, "Phase 3 & 4: Broadcasting 0x4F1 (00 D0) for 4s, firing 0x4A2 execution macro...");

        // Second 1: Send 0x4F1 (00 D0) and fire 0x4A2 macros immediately
        send_can_frame(0x4F1, cmd_active_4f1);

        // 3x Prepare frames (40ms spacing)
        for (int r = 0; r < 3; r++) {
            send_can_frame(0x4A2, prep_4a2);
            vTaskDelay(pdMS_TO_TICKS(40));
        }

        // 3x Execute frames (40ms spacing)
        for (int r = 0; r < 3; r++) {
            send_can_frame(0x4A2, exec_4a2);
            vTaskDelay(pdMS_TO_TICKS(40));
        }

        // Remainder of second 1 (~760ms)
        vTaskDelay(pdMS_TO_TICKS(760));

        // Seconds 2, 3, 4: Keep broadcasting 0x4F1 (00 D0) every 1s
        for (int sec = 2; sec <= 4; sec++) {
            if (s_stop_requested.load()) break;
            send_can_frame(0x4F1, cmd_active_4f1);
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    // ==========================================
    // Phase 5: Cleanup & Idle
    // Broadcast: 0x4F1 | 00 C0 00 00 00 00 00 00 (Idle)
    // Broadcast for 3 seconds (once every 1,000 ms), then Stop.
    // ==========================================
    if (s_stop_requested.load()) goto cleanup;
    broadcast_ws_state("remote_climate_state", "Phase 5: Session Close (0x4F1 Idle)");
    {
        const uint8_t idle_4f1[8] = { 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
        ESP_LOGI(TAG, "Phase 5: Broadcasting 0x4F1 (00 C0) for 3 seconds to close session...");

        for (int sec = 0; sec < 3; sec++) {
            if (s_stop_requested.load()) break;
            send_can_frame(0x4F1, idle_4f1);
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

cleanup:
    s_climate_running.store(false);
    s_stop_requested.store(false);
    s_hv_ready.store(false);
    s_climate_task_handle = nullptr;

    broadcast_ws_state("remote_climate_state", "Idle");
    broadcast_ws_state("hvac_direct_climate_cmd", "Active");
    ESP_LOGI(TAG, "HKMC Remote Climate sequence completed.");
    vTaskDelete(NULL);
}

void remote_climate_init(void) {
    s_climate_running.store(false);
    s_stop_requested.store(false);
    s_hv_ready.store(false);
}

bool remote_climate_start_ext(float target_temp_c, uint32_t duration_minutes, bool monitor_0x38) {
    if (s_climate_running.load()) {
        ESP_LOGW(TAG, "Remote climate sequence already active");
        return true;
    }
    s_target_temp_c = target_temp_c > 0.0f ? target_temp_c : 22.0f;
    s_duration_min = duration_minutes > 0 ? duration_minutes : 10;
    s_monitor_0x38 = monitor_0x38;
    s_stop_requested.store(false);
    s_hv_ready.store(false);

    ClimateTaskParams* p = new ClimateTaskParams{ s_target_temp_c, s_duration_min, s_monitor_0x38 };
    BaseType_t ret = xTaskCreate(remote_climate_worker_task, "rem_climate", 4096, p, 4, &s_climate_task_handle);
    if (ret != pdPASS) {
        delete p;
        return false;
    }
    return true;
}

bool remote_climate_start(float target_temp_c, uint32_t duration_minutes) {
    return remote_climate_start_ext(target_temp_c, duration_minutes, true);
}

bool remote_climate_start_dumb(float target_temp_c, uint32_t duration_minutes) {
    return remote_climate_start_ext(target_temp_c, duration_minutes, false);
}

bool remote_climate_start_smart(float target_temp_c, uint32_t duration_minutes) {
    return remote_climate_start_ext(target_temp_c, duration_minutes, true);
}

void remote_climate_stop(void) {
    if (s_climate_running.load()) {
        s_stop_requested.store(true);
    }
}

void remote_climate_toggle_ext(float target_temp_c, uint32_t duration_minutes, bool monitor_0x38) {
    if (s_climate_running.load()) {
        remote_climate_stop();
    } else {
        remote_climate_start_ext(target_temp_c, duration_minutes, monitor_0x38);
    }
}

void remote_climate_toggle(float target_temp_c, uint32_t duration_minutes) {
    remote_climate_toggle_ext(target_temp_c, duration_minutes, true);
}

bool remote_climate_is_active(void) {
    return s_climate_running.load();
}
