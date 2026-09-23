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
    ESP_LOGI(TAG, "Entering Tier 3 Deep Sleep (<1mA). Wake sources: CAN RX (GPIO 3) falling edge + %lu s timer",
             (unsigned long)sleep_duration_sec);

    // 1. Put CAN transceiver into low-power Standby mode (CAN_STB_PIN GPIO 6 = 1)
    gpio_set_level(CAN_STB_PIN, 1);

    // 2. Configure instant wake on CAN RX (GPIO 3) when vehicle bus transitions to dominant (LOW)
    gpio_wakeup_enable(CAN_RX_PIN, GPIO_INTR_LOW_LEVEL);
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

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(5000));

        bool awake = uds_engine_is_vehicle_awake();
        float vbat = vbat_sensor_get_last();

        if (awake) {
            power_mgr_set_tier(POWER_TIER_ACTIVE);
        } else {
            // Vehicle bus is silent
            power_mgr_set_tier(POWER_TIER_STANDBY);

            // Check if extreme power save (Tier 3 Deep Sleep) is warranted:
            // 1. Critical 12V battery protection (< 12.0V)
            // 2. Or quiet hours are active
            if (vbat > 5.0f && vbat < 12.0f) {
                ESP_LOGW(TAG, "12V Battery critical (%.2fV < 12.0V). Triggering Deep Sleep protection.", vbat);
                power_mgr_enter_deep_sleep(1800); // 30 min timer check
            }
        }
    }
}

void power_mgr_init(void) {
    xTaskCreate(power_mgr_task, "PWR_MGR", 2048, nullptr, 1, nullptr);
    ESP_LOGI(TAG, "Multi-Tier Smart Power Manager initialized");
}
