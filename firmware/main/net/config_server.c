/*
 * Adapted from L1Z3/wicant-i-precondition:
 * https://github.com/L1Z3/wicant-i-precondition
 *
 * Original authors: L1Z3, Tyler Harvey (@tylerharvey), and contributors
 * Upstream base: meatpiHQ/wican-fw (https://github.com/meatpiHQ/wican-fw)
 * License: GPL-3.0
 *
 * Modified and maintained in sync for CAN Do (https://github.com/SuperSuave/can-do).
 */

#include "config_server.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "CONFIG_SRV";

static int8_t s_button = BUTTON_DISABLED;
static int8_t s_press = PRESS_SHORT;
static int8_t s_mode = PERSISTENT;
static _Atomic bool s_temp_fahrenheit = false;

static bool parse_temp_unit_str(const char *val, bool *out_fahrenheit) {
    if (val == NULL || val[0] == '\0' || out_fahrenheit == NULL) {
        return false;
    }
    if (strcasecmp(val, "f") == 0
            || strcasecmp(val, "\xC2\xB0""f") == 0
            || strcasecmp(val, "fahrenheit") == 0
            || strcasecmp(val, "imperial") == 0
            || strcasecmp(val, "us") == 0) {
        *out_fahrenheit = true;
        return true;
    }
    if (strcasecmp(val, "c") == 0
            || strcasecmp(val, "\xC2\xB0""c") == 0
            || strcasecmp(val, "celsius") == 0
            || strcasecmp(val, "metric") == 0
            || strcasecmp(val, "si") == 0) {
        *out_fahrenheit = false;
        return true;
    }
    return false;
}

int8_t config_server_precon_button(void) {
    return s_button;
}

int8_t config_server_precon_press(void) {
    return s_press;
}

int8_t config_server_precon_mode(void) {
    return s_mode;
}

bool config_server_temperature_fahrenheit(void) {
    return atomic_load_explicit(&s_temp_fahrenheit, memory_order_relaxed);
}

void config_server_set_temperature_fahrenheit(bool fahrenheit) {
    atomic_store_explicit(&s_temp_fahrenheit, fahrenheit, memory_order_relaxed);
}

void config_server_load_preferences(void) {
    bool is_f = false;
    FILE *f = fopen("/spiffs/preferences.json", "r");
    if (f != NULL) {
        if (fseek(f, 0, SEEK_END) == 0) {
            long sz = ftell(f);
            if (sz > 0 && sz <= 8192 && fseek(f, 0, SEEK_SET) == 0) {
#if CONFIG_SPIRAM
                char *buf = (char *)heap_caps_malloc_prefer(
                    (size_t)sz + 1U, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT);
#else
                char *buf = (char *)malloc((size_t)sz + 1U);
#endif
                if (buf != NULL) {
                    size_t n = fread(buf, 1, (size_t)sz, f);
                    buf[n] = '\0';
                    cJSON *root = cJSON_Parse(buf);
                    free(buf);
                    if (root != NULL && cJSON_IsObject(root)) {
                        const char *unit_keys[] = {
                            "temperature_unit",
                            "temp_unit",
                            "unit_system",
                            "units",
                        };
                        bool matched = false;
                        for (size_t i = 0; i < sizeof(unit_keys) / sizeof(unit_keys[0]); i++) {
                            const cJSON *item = cJSON_GetObjectItemCaseSensitive(root, unit_keys[i]);
                            if (cJSON_IsString(item) && item->valuestring != NULL) {
                                if (parse_temp_unit_str(item->valuestring, &is_f)) {
                                    matched = true;
                                    break;
                                }
                            }
                        }
                        if (!matched) {
                            const cJSON *fb = cJSON_GetObjectItemCaseSensitive(root, "temperature_fahrenheit");
                            if (cJSON_IsBool(fb)) {
                                is_f = cJSON_IsTrue(fb);
                            }
                        }
                    }
                    if (root != NULL) {
                        cJSON_Delete(root);
                    }
                }
            }
        }
        fclose(f);
    }

    config_server_set_temperature_fahrenheit(is_f);
    ESP_LOGI(TAG, "Cluster OSD temperature unit: %s", is_f ? "Fahrenheit (F)" : "Celsius (C)");
}
