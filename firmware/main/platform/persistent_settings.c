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

#include "persistent_settings.h"
#include <stdatomic.h>
#include <stdint.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "PERSIST_CFG";
static const char *NVS_NS = "cando_cfg";
static const char *NVS_KEY_PRECON_ENABLED = "precon_en";

static _Atomic bool s_initialized = false;
static _Atomic bool s_precon_enabled = false;
static _Atomic bool s_persisted_precon_enabled = false;
static _Atomic int64_t s_dirty_since_us = 0;
static StaticSemaphore_t s_nvs_mutex_buf;
static SemaphoreHandle_t s_nvs_mutex = NULL;
static int64_t s_last_err_us = 0;

void persistent_settings_init(void) {
    if (atomic_exchange_explicit(&s_initialized, true, memory_order_acq_rel)) {
        return;
    }

    s_nvs_mutex = xSemaphoreCreateMutexStatic(&s_nvs_mutex_buf);

    bool restored = false;
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &handle);
    if (err == ESP_OK) {
        uint8_t val = 0;
        err = nvs_get_u8(handle, NVS_KEY_PRECON_ENABLED, &val);
        nvs_close(handle);
        if (err == ESP_OK) {
            restored = (val != 0);
        } else if (err != ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGW(TAG, "Failed reading NVS key %s: %s", NVS_KEY_PRECON_ENABLED, esp_err_to_name(err));
        }
    } else if (err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGW(TAG, "Failed opening NVS namespace %s: %s", NVS_NS, esp_err_to_name(err));
    }

    atomic_store_explicit(&s_precon_enabled, restored, memory_order_release);
    atomic_store_explicit(&s_persisted_precon_enabled, restored, memory_order_release);
    atomic_store_explicit(&s_dirty_since_us, 0, memory_order_release);
    ESP_LOGI(TAG, "Restored precon_enabled=%s from NVS", restored ? "true" : "false");
}

bool persistent_settings_get_precon_enabled(void) {
    return atomic_load_explicit(&s_precon_enabled, memory_order_relaxed);
}

void persistent_settings_set_precon_enabled(bool enabled) {
    atomic_store_explicit(&s_precon_enabled, enabled, memory_order_release);
    if (enabled != atomic_load_explicit(&s_persisted_precon_enabled, memory_order_acquire)) {
        atomic_store_explicit(&s_dirty_since_us, esp_timer_get_time(), memory_order_release);
    } else {
        atomic_store_explicit(&s_dirty_since_us, 0, memory_order_release);
    }
}

void persistent_settings_flush(bool force) {
    if (!atomic_load_explicit(&s_initialized, memory_order_acquire) || s_nvs_mutex == NULL) {
        return;
    }

    bool desired = atomic_load_explicit(&s_precon_enabled, memory_order_acquire);
    bool persisted = atomic_load_explicit(&s_persisted_precon_enabled, memory_order_acquire);
    if (desired == persisted) {
        return;
    }

    int64_t now_us = esp_timer_get_time();
    if (!force) {
        int64_t dirty_since = atomic_load_explicit(&s_dirty_since_us, memory_order_acquire);
        if (dirty_since == 0 || (now_us - dirty_since) < 250000LL) {
            return;
        }
    }

    TickType_t wait_ticks = force ? portMAX_DELAY : pdMS_TO_TICKS(5);
    if (xSemaphoreTake(s_nvs_mutex, wait_ticks) != pdTRUE) {
        return;
    }

    desired = atomic_load_explicit(&s_precon_enabled, memory_order_acquire);
    persisted = atomic_load_explicit(&s_persisted_precon_enabled, memory_order_acquire);
    if (desired == persisted) {
        xSemaphoreGive(s_nvs_mutex);
        return;
    }

    now_us = esp_timer_get_time();
    if (!force && s_last_err_us > 0 && (now_us - s_last_err_us) < 5000000LL) {
        xSemaphoreGive(s_nvs_mutex);
        return;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &handle);
    if (err == ESP_OK) {
        err = nvs_set_u8(handle, NVS_KEY_PRECON_ENABLED, desired ? 1U : 0U);
        if (err == ESP_OK) {
            err = nvs_commit(handle);
        }
        nvs_close(handle);
    }

    if (err == ESP_OK) {
        atomic_store_explicit(&s_persisted_precon_enabled, desired, memory_order_release);
        s_last_err_us = 0;
        ESP_LOGI(TAG, "Persisted precon_enabled=%s to NVS", desired ? "true" : "false");
    } else {
        s_last_err_us = now_us;
        ESP_LOGW(TAG, "Failed persisting precon_enabled to NVS: %s", esp_err_to_name(err));
    }

    xSemaphoreGive(s_nvs_mutex);
}
