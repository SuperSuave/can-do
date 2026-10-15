#include "power_mgr.h"
#include "board_pins.h"
#include "uds_engine.h"
#include "vbat_sensor.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char* TAG = "POWER_MGR";
static power_tier_t s_current_tier = POWER_TIER_ACTIVE;

void power_mgr_set_tier(power_tier_t tier) {
    if (s_current_tier == tier) return;

    if (tier == POWER_TIER_STANDBY) {
        // Enable 802.11 Modem Sleep (drops current from ~85mA to ~18mA while remaining 100% connected)
        esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
        ESP_LOGI(TAG, "Entering Tier 2 Standby (Wi-Fi Modem Sleep enabled)");
    } else if (tier == POWER_TIER_ACTIVE) {
        // Disable power-save for minimal latency during active driving/telemetry
        esp_wifi_set_ps(WIFI_PS_NONE);
        ESP_LOGI(TAG, "Entering Tier 1 Active (Full performance)");
    }
    s_current_tier = tier;
}

power_tier_t power_mgr_get_tier(void) {
    return s_current_tier;
}

void power_mgr_enter_deep_sleep(uint32_t sleep_duration_sec) {
    ESP_LOGI(TAG, "Entering Tier 3 Emergency Deep Sleep (<1mA). Wake sources: CAN RX (GPIO %d) + %lu s timer",
             (int)CAN_RX_PIN, (unsigned long)sleep_duration_sec);

    // 1. Ensure CAN transceiver STB is LOW (0 = enabled) so dominant CAN pulses pull CAN_RX LOW
    gpio_set_level(CAN_STB_PIN, 0);

    // 2. Configure native ESP32-C3 Deep Sleep GPIO wakeup on CAN RX falling edge (dominant bus state)
    gpio_wakeup_enable((gpio_num_t)CAN_RX_PIN, GPIO_INTR_LOW_LEVEL);
    esp_sleep_enable_gpio_wakeup();

    // 3. Configure periodic timer wake for heartbeat / 12V check
    if (sleep_duration_sec > 0) {
        esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(sleep_duration_sec) * 1000000ULL);
    }

    // 4. Flush logs and enter deep sleep
    vTaskDelay(pdMS_TO_TICKS(100));
    esp_deep_sleep_start();
}

static void power_mgr_task(void* arg) {
    ESP_LOGI(TAG, "Smart power manager task running");
    int critical_low_vbat_count = 0;

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(5000));

        bool awake = uds_engine_is_vehicle_awake();
        float vbat = vbat_sensor_get_last();
        // 12V rail >= 13.2V indicates high-voltage LDC converter is energized (vehicle is ON/driving or actively charging)
        bool ldc_active = (vbat >= 13.2f);

        // Stay in Active tier if vehicle is awake, LDC is active, OR if device is powered via USB bench power (vbat < 5.0V)
        if (awake || ldc_active || vbat < 5.0f) {
            power_mgr_set_tier(POWER_TIER_ACTIVE);
            critical_low_vbat_count = 0;
        } else {
            // Vehicle bus is silent and running on 12V vehicle battery:
            // Enter Tier 2 Standby (Modem Sleep: ~18mA @ 3.3V / ~6mA @ 12V).
            // This maintains 100% active Wi-Fi, MQTT, web dashboard, and instant CAN responsiveness
            // without draining the car battery (takes ~1 year to drain a 60Ah battery).
            power_mgr_set_tier(POWER_TIER_STANDBY);

            // Tier 3 Deep Sleep is an EMERGENCY fail-safe ONLY if 12V battery is genuinely depleted
            // (< 11.0V) continuously for 12 consecutive checks (60 seconds debounced).
            // 11.0V indicates deep discharge where battery health or starting capability is in danger.
            // 12.0V is a completely normal resting voltage for a healthy parked vehicle!
            if (vbat > 5.0f && vbat < 11.0f) {
                critical_low_vbat_count++;
                ESP_LOGW(TAG, "12V Battery critically low (%.2fV < 11.0V) [check %d/12]", 
                         vbat, critical_low_vbat_count);
                if (critical_low_vbat_count >= 12) {
                    ESP_LOGE(TAG, "12V Battery critically low for 60s (%.2fV). Entering Emergency Deep Sleep protection.", vbat);
                    power_mgr_enter_deep_sleep(1800); // 30 min timer check
                }
            } else {
                critical_low_vbat_count = 0;
            }
        }
    }
}

void power_mgr_init(void) {
    xTaskCreate(power_mgr_task, "PWR_MGR", 2560, nullptr, 1, nullptr);
    ESP_LOGI(TAG, "Multi-Tier Smart Power Manager initialized");
}
