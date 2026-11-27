#include "power_mgr.h"
#include "board_pins.h"
#include "uds_engine.h"
#include "vbat_sensor.h"
#include "network_mgr.h"
#include "api.h"
#include "can_engine.h"
#include "mcp2518fd.h"
#include "ble_mgr.h"
#include "persistent_settings.h"
#include "cJSON.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "soc/soc_caps.h"
#if CONFIG_IDF_TARGET_ESP32S3
#include "driver/rtc_io.h"
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>

static const char* TAG = "POWER_MGR";
static constexpr float DEFAULT_LOW_VBAT_CUTOFF_VOLTS = 11.5f;
static constexpr float MIN_LOW_VBAT_CUTOFF_VOLTS = 9.0f;
static constexpr float MAX_LOW_VBAT_CUTOFF_VOLTS = 12.8f;
static constexpr int LOW_VBAT_CUTOFF_SAMPLES = 12;          // 12 * 5s = 60s sustained below threshold
static constexpr uint32_t LOW_VBAT_WAKE_INTERVAL_SEC = 1800U; // 30 minutes periodic check

static std::atomic<power_tier_t> s_current_tier{POWER_TIER_ACTIVE};
static bool s_wifi_ps_modem = false;
static std::atomic<float> s_low_vbat_cutoff_volts{DEFAULT_LOW_VBAT_CUTOFF_VOLTS};
static std::atomic<bool> s_restart_scheduled{false};
static std::atomic<bool> s_restarting{false};

void power_mgr_load_preferences(void) {
    float cutoff = DEFAULT_LOW_VBAT_CUTOFF_VOLTS;
    FILE* f = fopen("/spiffs/preferences.json", "r");
    if (f) {
        fseek(f, 0, SEEK_END);
        long sz = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (sz > 0 && sz <= 8192) {
#if CONFIG_SPIRAM
            char* buf = static_cast<char*>(heap_caps_malloc_prefer(
                static_cast<size_t>(sz) + 1, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT));
#else
            char* buf = static_cast<char*>(malloc(static_cast<size_t>(sz) + 1));
#endif
            if (buf) {
                size_t n = fread(buf, 1, static_cast<size_t>(sz), f);
                buf[n] = '\0';
                cJSON* root = cJSON_Parse(buf);
                free(buf);
                if (root) {
                    cJSON* item = cJSON_GetObjectItem(root, "low_vbat_cutoff_volts");
                    if (cJSON_IsNumber(item) && std::isfinite(item->valuedouble)) {
                        float val = static_cast<float>(item->valuedouble);
                        if (val <= 0.0f) {
                            cutoff = 0.0f;
                        } else {
                            if (val < MIN_LOW_VBAT_CUTOFF_VOLTS) val = MIN_LOW_VBAT_CUTOFF_VOLTS;
                            if (val > MAX_LOW_VBAT_CUTOFF_VOLTS) val = MAX_LOW_VBAT_CUTOFF_VOLTS;
                            cutoff = val;
                        }
                    }
                    cJSON_Delete(root);
                }
            }
        }
        fclose(f);
    }

    s_low_vbat_cutoff_volts.store(cutoff, std::memory_order_relaxed);
    if (cutoff <= 0.0f) {
        ESP_LOGI(TAG, "Low-12V emergency deep-sleep cutoff: DISABLED");
    } else {
        ESP_LOGI(TAG, "Low-12V emergency deep-sleep cutoff: %.2fV (sustained %ds, wake every %lus)",
                 cutoff, LOW_VBAT_CUTOFF_SAMPLES * 5, (unsigned long)LOW_VBAT_WAKE_INTERVAL_SEC);
    }
}

float power_mgr_get_low_vbat_cutoff(void) {
    return s_low_vbat_cutoff_volts.load(std::memory_order_relaxed);
}

void power_mgr_set_tier(power_tier_t tier) {
    bool want_modem_sleep = false;
#if !CONFIG_BT_ENABLED
    if (tier == POWER_TIER_STANDBY) {
        NetworkStatusInfo net_st = network_mgr_get_status();
        // Only enable 802.11 Modem Sleep when connected as pure Station (SoftAP inactive and not scanning)
        want_modem_sleep = net_st.sta_connected && !net_st.ap_active && !network_mgr_is_scanning();
    }
#endif

    power_tier_t prev_tier = s_current_tier.load(std::memory_order_relaxed);
    bool tier_changed = (prev_tier != tier);
    if (tier_changed || s_wifi_ps_modem != want_modem_sleep) {
        esp_wifi_set_ps(want_modem_sleep ? WIFI_PS_MIN_MODEM : WIFI_PS_NONE);
        s_wifi_ps_modem = want_modem_sleep;
        if (tier_changed) {
            ble_mgr_set_standby(tier == POWER_TIER_STANDBY);
            if (tier == POWER_TIER_STANDBY) {
                ESP_LOGI(TAG, "Entering Tier 2 Standby (%s)",
                         want_modem_sleep ? "Wi-Fi Modem Sleep enabled" : "Coex/SoftAP/Scan active, keeping Wi-Fi PS NONE");
            } else {
                ESP_LOGI(TAG, "Entering Tier 1 Active (Full performance)");
            }
        }
    }
    s_current_tier.store(tier, std::memory_order_relaxed);
}

power_tier_t power_mgr_get_tier(void) {
    return s_current_tier.load(std::memory_order_relaxed);
}

void power_mgr_enter_deep_sleep(uint32_t sleep_duration_sec) {
    s_restarting.store(true, std::memory_order_relaxed);
    s_current_tier.store(POWER_TIER_DEEP_SLEEP, std::memory_order_relaxed);

    // Allow CAN_RX / CAN_TX / UDS tasks to observe quiesce flag and stop touching SPI/TWAI
    vTaskDelay(pdMS_TO_TICKS(60));

    rtc_can_state_save();
    rtc_crash_record_event("deep_sleep_low_vbat");

    ble_mgr_shutdown();
    network_mgr_shutdown();
    can_engine_prepare_deep_sleep();
    persistent_settings_flush(true);

    board_led_wifi(false);
    board_led_can_set(false);
    if (LED_POWER_PIN >= 0) {
        gpio_set_level(LED_POWER_PIN, 0);
    }

    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);

#if CONFIG_IDF_TARGET_ESP32S3
    esp_sleep_disable_ext1_wakeup_io(0);
    uint64_t ext1_mask = 0;

    if (CAN0_INT_PIN >= 0 && dual_can_is_available(CAN_BUS_0) &&
        esp_sleep_is_valid_wakeup_gpio(static_cast<gpio_num_t>(CAN0_INT_PIN))) {
        rtc_gpio_pullup_en(static_cast<gpio_num_t>(CAN0_INT_PIN));
        rtc_gpio_pulldown_dis(static_cast<gpio_num_t>(CAN0_INT_PIN));
        ext1_mask |= (1ULL << CAN0_INT_PIN);
    }
    if (CAN1_INT_PIN >= 0 && dual_can_is_available(CAN_BUS_1) &&
        esp_sleep_is_valid_wakeup_gpio(static_cast<gpio_num_t>(CAN1_INT_PIN))) {
        rtc_gpio_pullup_en(static_cast<gpio_num_t>(CAN1_INT_PIN));
        rtc_gpio_pulldown_dis(static_cast<gpio_num_t>(CAN1_INT_PIN));
        ext1_mask |= (1ULL << CAN1_INT_PIN);
    }
    if (ext1_mask == 0 && CAN_RX_PIN >= 0 &&
        esp_sleep_is_valid_wakeup_gpio(static_cast<gpio_num_t>(CAN_RX_PIN))) {
        rtc_gpio_pullup_en(static_cast<gpio_num_t>(CAN_RX_PIN));
        rtc_gpio_pulldown_dis(static_cast<gpio_num_t>(CAN_RX_PIN));
        ext1_mask |= (1ULL << CAN_RX_PIN);
    }

    if (ext1_mask != 0) {
        esp_err_t wake_err = esp_sleep_enable_ext1_wakeup_io(ext1_mask, ESP_EXT1_WAKEUP_ANY_LOW);
        if (wake_err != ESP_OK) {
            ESP_LOGW(TAG, "EXT1 wakeup setup failed (mask=0x%llX): %s",
                     (unsigned long long)ext1_mask, esp_err_to_name(wake_err));
        }
    }
    ESP_LOGI(TAG, "Entering Tier 3 Deep Sleep (S3 EXT1 mask=0x%llX, timer=%lus)",
             (unsigned long long)ext1_mask, (unsigned long)sleep_duration_sec);
#else
    // Ensure CAN transceiver STB is LOW (0 = enabled) if wired so CAN RX passes bus wake edges
    if (CAN_STB_PIN >= 0) {
        gpio_set_level(CAN_STB_PIN, 0);
    }

    gpio_config_t rx_cfg = {};
    rx_cfg.pin_bit_mask = (1ULL << CAN_RX_PIN);
    rx_cfg.mode = GPIO_MODE_INPUT;
    rx_cfg.pull_up_en = GPIO_PULLUP_ENABLE;
    rx_cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
    gpio_config(&rx_cfg);

    gpio_wakeup_enable(static_cast<gpio_num_t>(CAN_RX_PIN), GPIO_INTR_LOW_LEVEL);
    esp_sleep_enable_gpio_wakeup();
#if SOC_GPIO_SUPPORT_HP_PERIPH_PD_SLEEP_WAKEUP
    if (((1ULL << CAN_RX_PIN) & SOC_GPIO_HP_PERIPH_PD_SLEEP_WAKEABLE_MASK) != 0) {
        esp_sleep_enable_gpio_wakeup_on_hp_periph_powerdown(
            1ULL << CAN_RX_PIN, ESP_GPIO_WAKEUP_GPIO_LOW);
    }
#endif
    ESP_LOGI(TAG, "Entering Tier 3 Deep Sleep (C3 CAN RX GPIO %d, timer=%lus)",
             (int)CAN_RX_PIN, (unsigned long)sleep_duration_sec);
#endif

    if (sleep_duration_sec > 0) {
        esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(sleep_duration_sec) * 1000000ULL);
    }

    fflush(stdout);
    vTaskDelay(pdMS_TO_TICKS(100));
    esp_deep_sleep_start();
}

static void power_mgr_task(void* arg) {
    ESP_LOGI(TAG, "Smart power manager task running");
    int critical_low_vbat_count = 0;

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(5000));

        if (power_mgr_is_restarting()) {
            continue;
        }

        bool awake = uds_engine_is_vehicle_awake();
        bool vbat_fresh = vbat_sensor_is_fresh();
        float vbat = vbat_sensor_get_last();
        // 12V rail >= 13.2V indicates high-voltage LDC converter is energized (vehicle is ON/driving or actively charging)
        bool ldc_active = vbat_fresh && (vbat >= 13.2f);
        bool ws_active = has_active_websocket_clients();
        bool ota_active = api_is_ota_in_progress();

        // Stay in Active tier if vehicle is awake, LDC is active, Web UI/OTA is active, OR powered via USB bench power (fresh ADC vbat < 5.0V)
        if (awake || ldc_active || ws_active || ota_active || (vbat_fresh && vbat < 5.0f)) {
            power_mgr_set_tier(POWER_TIER_ACTIVE);
        } else {
            power_mgr_set_tier(POWER_TIER_STANDBY);
        }

        // Emergency 12V protection runs even if a browser WebSocket client was left open,
        // as long as the vehicle bus is asleep, LDC is off, no OTA is active, and 12V telemetry is fresh >= 5.0V.
        float cutoff = s_low_vbat_cutoff_volts.load(std::memory_order_relaxed);
        if (!awake && !ldc_active && !ota_active &&
            vbat_fresh && vbat >= 5.0f && cutoff > 0.0f && vbat < cutoff) {
            critical_low_vbat_count++;
            if (critical_low_vbat_count == 1 || critical_low_vbat_count % 6 == 0) {
                ESP_LOGW(TAG, "12V Battery low (%.2fV < %.2fV, sample %d/%d)",
                         vbat, cutoff, critical_low_vbat_count, LOW_VBAT_CUTOFF_SAMPLES);
            }
            if (critical_low_vbat_count >= LOW_VBAT_CUTOFF_SAMPLES) {
                ESP_LOGE(TAG, "Sustained low 12V battery (%.2fV < %.2fV for %ds). Entering emergency deep sleep.",
                         vbat, cutoff, LOW_VBAT_CUTOFF_SAMPLES * 5);
                power_mgr_enter_deep_sleep(LOW_VBAT_WAKE_INTERVAL_SEC);
            }
        } else {
            critical_low_vbat_count = 0;
        }
    }
}

void power_mgr_init(void) {
    power_mgr_load_preferences();
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
    persistent_settings_flush(true);

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
        persistent_settings_flush(true);
        fflush(stdout);
        esp_restart();
    }
}
