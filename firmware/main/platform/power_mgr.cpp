#include "power_mgr.h"
#include "board_pins.h"
#include "uds_engine.h"
#include "vbat_sensor.h"
#include "network_mgr.h"
#include "api.h"
#include "mcp2518fd.h"
#include "ble_mgr.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <atomic>
#include <cstdio>

static const char* TAG = "POWER_MGR";
static power_tier_t s_current_tier = POWER_TIER_ACTIVE;
static bool s_wifi_ps_modem = false;
static std::atomic<bool> s_restart_scheduled{false};
static std::atomic<bool> s_restarting{false};

void power_mgr_set_tier(power_tier_t tier) {
    bool want_modem_sleep = false;
#if !CONFIG_BT_ENABLED
    if (tier == POWER_TIER_STANDBY) {
        NetworkStatusInfo net_st = network_mgr_get_status();
        // Only enable 802.11 Modem Sleep when connected as pure Station (SoftAP inactive and not scanning)
        want_modem_sleep = net_st.sta_connected && !net_st.ap_active && !network_mgr_is_scanning();
    }
#endif

    bool tier_changed = (s_current_tier != tier);
    if (tier_changed || s_wifi_ps_modem != want_modem_sleep) {
        esp_wifi_set_ps(want_modem_sleep ? WIFI_PS_MIN_MODEM : WIFI_PS_NONE);
        s_wifi_ps_modem = want_modem_sleep;
        if (tier_changed) {
            if (tier == POWER_TIER_STANDBY) {
                ESP_LOGI(TAG, "Entering Tier 2 Standby (%s)",
                         want_modem_sleep ? "Wi-Fi Modem Sleep enabled" : "Coex/SoftAP/Scan active, keeping Wi-Fi PS NONE");
            } else {
                ESP_LOGI(TAG, "Entering Tier 1 Active (Full performance)");
            }
        }
    }
    s_current_tier = tier;
}

power_tier_t power_mgr_get_tier(void) {
    return s_current_tier;
}

void power_mgr_enter_deep_sleep(uint32_t sleep_duration_sec) {
    ESP_LOGI(TAG, "Entering Tier 3 Emergency Deep Sleep (<1mA). Wake sources: CAN RX (GPIO %d) + %lu s timer",
             (int)CAN_RX_PIN, (unsigned long)sleep_duration_sec);

    // 1. Ensure CAN transceiver STB is LOW (0 = enabled) if wired
    if (CAN_STB_PIN >= 0) {
        gpio_set_level(CAN_STB_PIN, 0);
    }

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
        bool ws_active = has_active_websocket_clients();

        // Stay in Active tier if vehicle is awake, LDC is active, Web UI is connected, OR if device is powered via USB bench power (vbat < 5.0V)
        if (awake || ldc_active || ws_active || vbat < 5.0f) {
            power_mgr_set_tier(POWER_TIER_ACTIVE);
            critical_low_vbat_count = 0;
        } else {
            // Vehicle bus is silent and running on 12V vehicle battery:
            // Enter Tier 2 Standby (Modem Sleep: ~18mA @ 3.3V / ~6mA @ 12V).
            // This maintains 100% active Wi-Fi, MQTT, web dashboard, and instant CAN responsiveness
            // without draining the car battery (takes ~1 year to drain a 60Ah battery).
            power_mgr_set_tier(POWER_TIER_STANDBY);

            // When vehicle bus is silent and running on 12V battery, maintain Tier 2 Standby
            // (Modem Sleep: ~18mA @ 3.3V / ~6mA @ 12V). This provides active CAN reception,
            // Wi-Fi connectivity, and web dashboard responsiveness without draining the 12V battery.
            if (vbat > 5.0f && vbat < 11.0f) {
                critical_low_vbat_count++;
                if (critical_low_vbat_count % 12 == 1) {
                    ESP_LOGW(TAG, "12V Battery low (%.2fV < 11.0V). Maintaining Tier 2 Standby (~6mA).", vbat);
                }
            } else {
                critical_low_vbat_count = 0;
            }
        }
    }
}

void power_mgr_init(void) {
    xTaskCreate(power_mgr_task, "PWR_MGR", 4096, nullptr, 1, nullptr);
    ESP_LOGI(TAG, "Multi-Tier Smart Power Manager initialized");
}

bool power_mgr_is_restarting(void) {
    return s_restarting.load(std::memory_order_relaxed);
}

static void restart_worker_task(void* arg) {
    uint32_t delay_ms = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(arg));
    if (delay_ms > 0) {
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }

    s_restarting.store(true, std::memory_order_relaxed);
    // Allow CAN_RX / CAN_TX tasks to observe restart flag and release SPI mutexes cleanly
    vTaskDelay(pdMS_TO_TICKS(60));

    ble_mgr_shutdown();
    dual_can_shutdown();

    ESP_LOGI(TAG, "Restarting ESP32 cleanly...");
    fflush(stdout);
    vTaskDelay(pdMS_TO_TICKS(40));

    esp_restart();
    vTaskDelete(nullptr);
}

void power_mgr_schedule_restart(uint32_t delay_ms) {
    if (s_restart_scheduled.exchange(true)) return;
    BaseType_t ok = xTaskCreatePinnedToCore(
        restart_worker_task,
        "SYS_RESTART",
        4096,
        reinterpret_cast<void*>(static_cast<uintptr_t>(delay_ms)),
        6,
        nullptr,
        0
    );
    if (ok != pdPASS) {
        s_restarting.store(true, std::memory_order_relaxed);
        if (delay_ms > 0) {
            vTaskDelay(pdMS_TO_TICKS(delay_ms));
        }
        dual_can_shutdown();
        fflush(stdout);
        esp_restart();
    }
}
