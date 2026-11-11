#include "vbat_sensor.h"
#include "board_pins.h"
#include "parser.h"
#include "api.h"
#include "mqtt_mgr.h"
#include "esp_log.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#if CONFIG_IDF_TARGET_ESP32S3
#include "driver/gpio.h"
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <cmath>

static const char* TAG = "VBAT_ADC";

static adc_oneshot_unit_handle_t s_adc1_handle = nullptr;
static adc_cali_handle_t s_adc1_cali_handle = nullptr;
static adc_channel_t s_adc_channel = ADC_CHANNEL_0;
static bool s_adc_calibrated = false;
static bool s_has_adc_divider = true;

static float s_last_vbat_val = 0.0f;
static char s_last_vbat_str[16] = "Unknown";

float vbat_sensor_get_last(void) {
    return s_last_vbat_val;
}

const char* vbat_sensor_get_last_str(void) {
    return s_last_vbat_str;
}

void vbat_sensor_set_from_can(float voltage) {
    if (s_has_adc_divider) return;
    if (voltage >= 5.0f && voltage <= 18.0f) {
        s_last_vbat_val = voltage;
        snprintf(s_last_vbat_str, sizeof(s_last_vbat_str), "%.1f V", voltage);
    }
}

static void vbat_monitor_task(void* arg) {
    ESP_LOGI(TAG, "MeatPi WiCAN 12V Battery monitor task started");
    float last_vbat = -1.0f;

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(3000));

        float v = vbat_sensor_read();
        if (v < 5.0f || v > 18.0f) {
            continue;
        }

        s_last_vbat_val = v;
        snprintf(s_last_vbat_str, sizeof(s_last_vbat_str), "%.1f V", v);

        // Update catalog entity current_state
        for (auto& entity : global_catalog) {
            if (entity.id == "cond_aux_12v_battery") {
                entity.current_state = s_last_vbat_str;
                break;
            }
        }

        // Broadcast to Web Dashboard WebSocket
        broadcast_ws_state("cond_aux_12v_battery", s_last_vbat_str);

        // Publish to MQTT
        mqtt_mgr_publish_vbat(v);

        if (std::abs(v - last_vbat) >= 0.2f) {
            ESP_LOGI(TAG, "12V Battery Voltage: %.2f V", v);
            last_vbat = v;
        }
    }
}

void vbat_sensor_init(void) {
    if (VBAT_ADC_PIN < 0) {
        s_has_adc_divider = false;
        ESP_LOGI(TAG, "VBAT ADC disabled (no pin configured); relying on CAN 12V telemetry");
        return;
    }

    adc_unit_t adc_unit = ADC_UNIT_1;
    esp_err_t ret = adc_oneshot_io_to_channel(VBAT_ADC_PIN, &adc_unit, &s_adc_channel);
    if (ret != ESP_OK || adc_unit != ADC_UNIT_1) {
        s_has_adc_divider = false;
        ESP_LOGW(TAG, "VBAT_ADC_PIN (GPIO %d) is not an ADC1 pin (%s)", (int)VBAT_ADC_PIN, esp_err_to_name(ret));
        return;
    }

    adc_oneshot_unit_init_cfg_t init_config = {};
    init_config.unit_id = ADC_UNIT_1;
    init_config.ulp_mode = ADC_ULP_MODE_DISABLE;

    ret = adc_oneshot_new_unit(&init_config, &s_adc1_handle);
    if (ret != ESP_OK) {
        s_has_adc_divider = false;
        ESP_LOGE(TAG, "Failed to initialize ADC1 unit (%s)", esp_err_to_name(ret));
        return;
    }

    adc_oneshot_chan_cfg_t chan_cfg = {};
    chan_cfg.atten = ADC_ATTEN_DB_12;
    chan_cfg.bitwidth = ADC_BITWIDTH_DEFAULT;

    ret = adc_oneshot_config_channel(s_adc1_handle, s_adc_channel, &chan_cfg);
    if (ret != ESP_OK) {
        s_has_adc_divider = false;
        ESP_LOGE(TAG, "Failed to configure ADC1 channel %d (%s)", (int)s_adc_channel, esp_err_to_name(ret));
        return;
    }

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t cali_cfg = {};
    cali_cfg.unit_id = ADC_UNIT_1;
    cali_cfg.chan = s_adc_channel;
    cali_cfg.atten = ADC_ATTEN_DB_12;
    cali_cfg.bitwidth = ADC_BITWIDTH_DEFAULT;

    if (adc_cali_create_scheme_curve_fitting(&cali_cfg, &s_adc1_cali_handle) == ESP_OK) {
        s_adc_calibrated = true;
        ESP_LOGI(TAG, "ADC1 calibrated with curve fitting");
    }
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_line_fitting_config_t cali_cfg = {};
    cali_cfg.unit_id = ADC_UNIT_1;
    cali_cfg.atten = ADC_ATTEN_DB_12;
    cali_cfg.bitwidth = ADC_BITWIDTH_DEFAULT;

    if (adc_cali_create_scheme_line_fitting(&cali_cfg, &s_adc1_cali_handle) == ESP_OK) {
        s_adc_calibrated = true;
        ESP_LOGI(TAG, "ADC1 calibrated with line fitting");
    }
#endif

    if (!s_adc_calibrated) {
        ESP_LOGW(TAG, "ADC1 calibration scheme unavailable, falling back to nominal scaling");
    }

#if CONFIG_IDF_TARGET_ESP32S3
    // Detect floating/unwired ADC pin on prototype boards so phantom noise doesn't gate UDS or power_mgr.
    // adc_oneshot_config_channel() invokes gpio_config_as_analog() -> rtc_gpio_deinit(), routing pulls to IO_MUX.
    if (GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)VBAT_ADC_PIN)) {
        auto read_pin_mv = []() -> int {
            int raw_sum = 0;
            int valid = 0;
            for (int i = 0; i < 4; ++i) {
                int raw = 0;
                if (adc_oneshot_read(s_adc1_handle, s_adc_channel, &raw) == ESP_OK) {
                    raw_sum += raw;
                    valid++;
                }
            }
            if (valid == 0) return -1;
            int raw_avg = raw_sum / valid;
            int mv = 0;
            if (s_adc_calibrated && s_adc1_cali_handle) {
                adc_cali_raw_to_voltage(s_adc1_cali_handle, raw_avg, &mv);
            } else {
                mv = (raw_avg * 3100) / 4095;
            }
            return mv;
        };

        gpio_pullup_en((gpio_num_t)VBAT_ADC_PIN);
        vTaskDelay(pdMS_TO_TICKS(5));
        int mv_pu = read_pin_mv();
        gpio_pullup_dis((gpio_num_t)VBAT_ADC_PIN);

        gpio_pulldown_en((gpio_num_t)VBAT_ADC_PIN);
        vTaskDelay(pdMS_TO_TICKS(5));
        int mv_pd = read_pin_mv();
        gpio_pulldown_dis((gpio_num_t)VBAT_ADC_PIN);

        if (mv_pu > 2600 && mv_pd >= 0 && mv_pd < 400) {
            s_has_adc_divider = false;
            if (s_adc1_cali_handle) {
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
                adc_cali_delete_scheme_curve_fitting(s_adc1_cali_handle);
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
                adc_cali_delete_scheme_line_fitting(s_adc1_cali_handle);
#endif
                s_adc1_cali_handle = nullptr;
                s_adc_calibrated = false;
            }
            adc_oneshot_del_unit(s_adc1_handle);
            s_adc1_handle = nullptr;
            ESP_LOGW(TAG, "VBAT GPIO %d appears floating (PU=%dmV, PD=%dmV); disabling ADC monitor and using CAN 12V telemetry",
                     (int)VBAT_ADC_PIN, mv_pu, mv_pd);
            return;
        }

        // Restore pure high-Z analog configuration when an external divider is present
        adc_oneshot_config_channel(s_adc1_handle, s_adc_channel, &chan_cfg);
    }
#endif

    ESP_LOGI(TAG, "12V Battery ADC initialized on GPIO %d (ADC1_CH%d)", (int)VBAT_ADC_PIN, (int)s_adc_channel);

    // Spawn 24/7 background voltage monitor task
    xTaskCreate(vbat_monitor_task, "VBAT_MON", 4096, nullptr, 2, nullptr);
}

float vbat_sensor_read(void) {
    if (!s_adc1_handle || !s_has_adc_divider) return 0.0f;

    // Multisampling across 8 consecutive readings to eliminate transient noise
    int raw_sum = 0;
    const int samples = 8;
    for (int i = 0; i < samples; ++i) {
        int raw = 0;
        if (adc_oneshot_read(s_adc1_handle, s_adc_channel, &raw) == ESP_OK) {
            raw_sum += raw;
        }
    }
    int raw_avg = raw_sum / samples;

    int voltage_mv = 0;
    if (s_adc_calibrated && s_adc1_cali_handle) {
        adc_cali_raw_to_voltage(s_adc1_cali_handle, raw_avg, &voltage_mv);
    } else {
        // Fallback for 12dB attenuation (~3100mV on S3, ~2500mV on C3)
#if CONFIG_IDF_TARGET_ESP32S3
        voltage_mv = (raw_avg * 3100) / 4095;
#else
        voltage_mv = (raw_avg * 2500) / 4095;
#endif
    }

    // Hardware voltage divider ratio: 100k / 16k => (100 + 16) / 16 = 116 / 16 = 7.25
    float vbat = (static_cast<float>(voltage_mv) * 116.0f) / (16.0f * 1000.0f);
    return vbat;
}
