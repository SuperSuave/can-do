#include "can_engine.h"
#include "psram_alloc.h"
#include "parser.h"
#include "api.h"
#include "gvret_server.h"
#include <cstring>
#include <ctime>
#include <cmath>
#include <algorithm>
#include <bitset>
#include <cctype>
#include <mutex>
#include <new>
#include <unordered_set>
#include <sys/time.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "track_popup.h"
#include "beep.h"
#include "hud_nav.h"
#include "precondition.h"
#include "board_pins.h"
#include "can.h"
#include "mcp2518fd.h"
#include "mqtt_mgr.h"
#include "uds_engine.h"
#include "network_mgr.h"
#include "timezone_mgr.h"
#include "remote_climate.h"
#include "ambient_anim.h"
#include "vbat_sensor.h"
#include "power_mgr.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "esp_task_wdt.h"
#include "esp_system.h"
#include "esp_heap_caps.h"
#include "cJSON.h"
#include <cstdio>

static bool mac_matches(const std::string& a, const std::string& b) {
    const char* pa = a.c_str();
    const char* pb = b.c_str();
    bool matched_any = false;
    while (true) {
        while (*pa && !isxdigit((unsigned char)*pa)) ++pa;
        while (*pb && !isxdigit((unsigned char)*pb)) ++pb;
        if (!*pa || !*pb) {
            return matched_any && (*pa == '\0') && (*pb == '\0');
        }
        if (tolower((unsigned char)*pa) != tolower((unsigned char)*pb)) {
            return false;
        }
        matched_any = true;
        ++pa;
        ++pb;
    }
}


#if defined(_WIN32) && !defined(__GNUC__)
#define strcasecmp _stricmp
#endif

static StaticSemaphore_t s_twai_mutex_buf;
static std::atomic<SemaphoreHandle_t> s_twai_mutex{nullptr};
static std::mutex s_twai_mutex_init_lock;
static std::atomic<uint32_t> s_last_can_rx_ms{0};
static std::atomic<uint32_t> s_last_bus_rx_ms[CAN_BUS_COUNT]{};
static std::atomic<uint32_t> s_dual_tec_check_ms[CAN_BUS_COUNT]{};
static std::atomic<uint8_t>  s_dual_cached_tec[CAN_BUS_COUNT]{};
static std::atomic<bool>     s_dual_cached_bo[CAN_BUS_COUNT]{};
static std::atomic<uint32_t> s_dual_last_tx_fail[CAN_BUS_COUNT]{};
static std::atomic<uint32_t> s_dual_last_tec_log_ms[CAN_BUS_COUNT]{};

static inline SemaphoreHandle_t get_or_create_twai_mutex(void) {
    SemaphoreHandle_t mtx = s_twai_mutex.load(std::memory_order_acquire);
    if (!mtx) {
        std::lock_guard<std::mutex> lock(s_twai_mutex_init_lock);
        mtx = s_twai_mutex.load(std::memory_order_relaxed);
        if (!mtx) {
            mtx = xSemaphoreCreateMutexStatic(&s_twai_mutex_buf);
            s_twai_mutex.store(mtx, std::memory_order_release);
        }
    }
    return mtx;
}

esp_err_t can_engine_get_status_info(twai_status_info_t* status_info) {
    if (!status_info) return ESP_ERR_INVALID_ARG;
    if (dual_can_is_available(CAN_BUS_0)) {
        memset(status_info, 0, sizeof(twai_status_info_t));
        mcp2518fd_t* dev = dual_can_get_device(CAN_BUS_0);
        uint8_t tec = 0, rec = 0;
        bool bo = false;
        esp_err_t ret = mcp2518fd_get_error_counts(dev, &tec, &rec, &bo);
        if (ret != ESP_OK) return ret;
        status_info->state = bo ? TWAI_STATE_BUS_OFF : TWAI_STATE_RUNNING;
        status_info->tx_error_counter = tec;
        status_info->rx_error_counter = rec;
        status_info->rx_overrun_count = dev ? dev->rx_overflow_count : 0;
        status_info->bus_error_count = dev ? dev->tx_fail_count : 0;
        return ESP_OK;
    }
    SemaphoreHandle_t mtx = get_or_create_twai_mutex();
    if (mtx) {
        if (xSemaphoreTake(mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
            return ESP_ERR_TIMEOUT;
        }
    }
    esp_err_t err = twai_get_status_info(status_info);
    if (mtx) {
        xSemaphoreGive(mtx);
    }
    return err;
}

extern "C" bool can_engine_is_bus_awake(uint32_t max_silence_ms) {
    uint32_t last_rx = s_last_can_rx_ms.load(std::memory_order_relaxed);
    if (last_rx == 0) return false;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    return (now_ms - last_rx) <= max_silence_ms;
}

extern "C" bool can_bus_is_available(can_bus_t bus) {
    if (dual_can_is_available(bus)) return true;
    if (bus == CAN_BUS_0) {
        twai_status_info_t info;
        return (can_engine_get_status_info(&info) == ESP_OK && info.state == TWAI_STATE_RUNNING);
    }
    return false;
}

static esp_err_t dual_can_tx_guard(can_bus_t bus) {
    if (bus >= CAN_BUS_COUNT) return ESP_ERR_INVALID_ARG;
    mcp2518fd_t* dev = dual_can_get_device(bus);
    if (!dev || !dev->initialized || dev->config.listen_only) {
        return ESP_ERR_INVALID_STATE;
    }

    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    uint32_t last_rx = s_last_bus_rx_ms[bus].load(std::memory_order_relaxed);
    bool bus_silent = (last_rx == 0) || ((now_ms - last_rx) > 1500);

    uint8_t tec = s_dual_cached_tec[bus].load(std::memory_order_relaxed);
    bool bus_off = s_dual_cached_bo[bus].load(std::memory_order_relaxed);
    uint32_t last_chk = s_dual_tec_check_ms[bus].load(std::memory_order_relaxed);
    uint32_t cur_tx_fail = dev->tx_fail_count;
    uint32_t prev_tx_fail = s_dual_last_tx_fail[bus].load(std::memory_order_relaxed);

    if (bus_silent || bus_off || tec >= 16 || cur_tx_fail != prev_tx_fail ||
        last_chk == 0 || (now_ms - last_chk) >= 50) {
        uint8_t fresh_tec = tec;
        uint8_t fresh_rec = 0;
        bool fresh_bo = bus_off;
        esp_err_t err = mcp2518fd_get_error_counts(dev, &fresh_tec, &fresh_rec, &fresh_bo);
        if (err == ESP_OK) {
            tec = fresh_tec;
            bus_off = fresh_bo;
            s_dual_cached_tec[bus].store(tec, std::memory_order_relaxed);
            s_dual_cached_bo[bus].store(bus_off, std::memory_order_relaxed);
            s_dual_tec_check_ms[bus].store(now_ms, std::memory_order_relaxed);
            s_dual_last_tx_fail[bus].store(cur_tx_fail, std::memory_order_relaxed);
        } else if (err != ESP_ERR_TIMEOUT) {
            return ESP_ERR_INVALID_STATE;
        }
    }

    if (bus_off || tec >= 96 || (bus_silent && tec >= 16)) {
        uint32_t last_log = s_dual_last_tec_log_ms[bus].load(std::memory_order_relaxed);
        if (last_log == 0 || (now_ms - last_log) >= 2000) {
            s_dual_last_tec_log_ms[bus].store(now_ms, std::memory_order_relaxed);
            ESP_LOGW("CAN_ENGINE", "Dual-CAN bus %d TX suppressed: TEC=%u bus_off=%d (silent=%d)",
                     (int)bus, (unsigned)tec, bus_off ? 1 : 0, bus_silent ? 1 : 0);
        }
        return ESP_ERR_INVALID_STATE;
    }

    return ESP_OK;
}

extern "C" esp_err_t can_send_fd(can_bus_t bus, const can_fd_frame_t *frame, TickType_t ticks_to_wait) {
    if (!frame) return ESP_ERR_INVALID_ARG;
    if (g_sniffer_mode.load()) return ESP_ERR_INVALID_STATE;

    if (dual_can_is_available(bus)) {
        esp_err_t guard_err = dual_can_tx_guard(bus);
        if (guard_err != ESP_OK) return guard_err;
        can_fd_frame_t tx_frame = *frame;
        tx_frame.flags.ss = 1;
        return dual_can_send(bus, &tx_frame, ticks_to_wait);
    }

    if (bus == CAN_BUS_0) {
        twai_message_t msg;
        can_fd_to_twai(frame, &msg);
        return can_send(CAN_BUS_0, &msg, ticks_to_wait);
    }
    return ESP_ERR_NOT_SUPPORTED;
}

extern "C" esp_err_t can_send(can_bus_t bus, twai_message_t *message, TickType_t ticks_to_wait) {
    if (!message) return ESP_ERR_INVALID_ARG;
    if (g_sniffer_mode.load()) {
        return ESP_ERR_INVALID_STATE;
    }

    if (dual_can_is_available(bus)) {
        esp_err_t guard_err = dual_can_tx_guard(bus);
        if (guard_err != ESP_OK) return guard_err;
        message->ss = 1;
        return dual_can_send_twai(bus, message, ticks_to_wait);
    }

    if (bus != CAN_BUS_0) {
        return ESP_ERR_NOT_FOUND;
    }

    const TickType_t max_wait = pdMS_TO_TICKS(50);
    if (ticks_to_wait > max_wait) {
        ticks_to_wait = max_wait;
    }

    SemaphoreHandle_t mtx = get_or_create_twai_mutex();
    if (mtx) {
        if (xSemaphoreTake(mtx, max_wait) != pdTRUE) {
            return ESP_ERR_TIMEOUT;
        }
    }

    esp_err_t ret = ESP_OK;
    twai_status_info_t info;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    uint32_t last_rx = s_last_can_rx_ms.load(std::memory_order_relaxed);
    bool bus_silent = (last_rx == 0) || ((now_ms - last_rx) > 1500);

    if (twai_get_status_info(&info) != ESP_OK || info.state != TWAI_STATE_RUNNING) {
        ret = ESP_ERR_INVALID_STATE;
    } else if (info.tx_error_counter >= 96 || (bus_silent && info.tx_error_counter >= 16)) {
        if (info.msgs_to_tx > 0) {
            twai_clear_transmit_queue();
        }
        static uint32_t s_last_tec_log_ms = 0;
        if (now_ms - s_last_tec_log_ms >= 2000) {
            s_last_tec_log_ms = now_ms;
            ESP_LOGW("CAN_ENGINE", "CAN TX suppressed: TEC=%lu (silent or sleeping bus)", (unsigned long)info.tx_error_counter);
        }
        ret = ESP_ERR_INVALID_STATE;
    } else {
        // Single-Shot mode: never loop in hardware retries on unacknowledged frames, eliminating BUS_OFF
        message->ss = 1;
        ret = twai_transmit(message, ticks_to_wait);
    }

    if (mtx) {
        xSemaphoreGive(mtx);
    }
    return ret;
}

static const char* TAG = "CAN_ENGINE";

#include "esp_attr.h"

static RTC_NOINIT_ATTR RtcCrashInfo s_rtc_crash;
static RTC_NOINIT_ATTR RtcCanStateCache s_rtc_can_cache;
std::atomic<bool> g_state_restored_from_rtc{false};

static uint32_t calc_can_cache_crc32(const uint8_t* data, size_t length) {
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < length; ++i) {
        crc ^= data[i];
        for (int j = 0; j < 8; ++j) {
            crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
        }
    }
    return ~crc;
}

const RtcCrashInfo* get_rtc_crash_info(void) {
    if (s_rtc_crash.magic == RTC_CRASH_MAGIC) {
        return &s_rtc_crash;
    }
    return nullptr;
}

static inline void copy_rtc_str(char* dst, const char* src, size_t max_len) {
    if (!dst || !src || max_len == 0) return;
    size_t i = 0;
    while (i + 1 < max_len && src[i] != '\0') {
        dst[i] = src[i];
        i++;
    }
    dst[i] = '\0';
}

static void rtc_crash_ensure_init(void) {
    if (s_rtc_crash.magic != RTC_CRASH_MAGIC) {
        memset((void*)&s_rtc_crash, 0, sizeof(s_rtc_crash));
        s_rtc_crash.magic = RTC_CRASH_MAGIC;
    }
}

static void rtc_crash_snapshot_stats(void) {
    rtc_crash_ensure_init();
    s_rtc_crash.uptime_sec = (uint32_t)(esp_timer_get_time() / 1000000ULL);
    s_rtc_crash.free_heap = esp_get_free_heap_size();
    s_rtc_crash.min_free_heap = esp_get_minimum_free_heap_size();
    s_rtc_crash.internal_free_heap = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    mcp2518fd_t* dev0 = dual_can_get_device(CAN_BUS_0);
    mcp2518fd_t* dev1 = dual_can_get_device(CAN_BUS_1);
    s_rtc_crash.can0_rx_overflow = (dev0 && dev0->initialized) ? dev0->rx_overflow_count : 0;
    s_rtc_crash.can1_rx_overflow = (dev1 && dev1->initialized) ? dev1->rx_overflow_count : 0;
}

void rtc_crash_record(uint32_t can_id, uint8_t dlc, const uint8_t* data, uint32_t step, const char* decoder) {
    rtc_crash_ensure_init();
    s_rtc_crash.can_id = can_id;
    s_rtc_crash.dlc = dlc;
    if (data && dlc > 0) {
        memcpy(s_rtc_crash.data, data, dlc > 8 ? 8 : dlc);
    }
    s_rtc_crash.step_marker = step;
    if (decoder) {
        copy_rtc_str(s_rtc_crash.last_decoder, decoder, sizeof(s_rtc_crash.last_decoder));
    }
    s_rtc_crash.uptime_sec = (uint32_t)(esp_timer_get_time() / 1000000ULL);
}

static inline void rtc_crash_step_label(uint32_t step, const char* decoder) {
    s_rtc_crash.step_marker = step;
    if (decoder) {
        copy_rtc_str(s_rtc_crash.last_decoder, decoder, sizeof(s_rtc_crash.last_decoder));
    }
}

void rtc_crash_record_event(const char* event_name) {
    rtc_crash_snapshot_stats();
    if (event_name) {
        copy_rtc_str(s_rtc_crash.last_event, event_name, sizeof(s_rtc_crash.last_event));
    }
}

extern "C" void esp_task_wdt_isr_user_handler(void) {
    s_rtc_crash.magic = RTC_CRASH_MAGIC;
    s_rtc_crash.twdt_triggered = 1;
    s_rtc_crash.uptime_sec = (uint32_t)(esp_timer_get_time() / 1000000ULL);
    TaskHandle_t t0 = xTaskGetCurrentTaskHandleForCore(0);
    if (t0) {
        copy_rtc_str(s_rtc_crash.cpu0_task, pcTaskGetName(t0), sizeof(s_rtc_crash.cpu0_task));
    }
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1
    TaskHandle_t t1 = xTaskGetCurrentTaskHandleForCore(1);
    if (t1) {
        copy_rtc_str(s_rtc_crash.cpu1_task, pcTaskGetName(t1), sizeof(s_rtc_crash.cpu1_task));
    }
#endif
}

static void crash_diag_shutdown_handler(void) {
    rtc_can_state_save();
    rtc_crash_record_event("clean_shutdown");
}

static const char* diag_reset_reason_str(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_POWERON: return "power_on";
        case ESP_RST_EXT: return "external";
        case ESP_RST_SW: return "software";
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_INT_WDT: return "int_wdt";
        case ESP_RST_TASK_WDT: return "task_wdt";
        case ESP_RST_WDT: return "wdt";
        case ESP_RST_DEEPSLEEP: return "deep_sleep";
        case ESP_RST_BROWNOUT: return "brownout";
        case ESP_RST_SDIO: return "sdio";
        default: return "unknown";
    }
}

void init_crash_diagnostics(void) {
    esp_reset_reason_t reason = esp_reset_reason();
    const bool abnormal_reason = (reason != ESP_RST_POWERON && reason != ESP_RST_SW && reason != ESP_RST_DEEPSLEEP);
    const bool valid_rtc = (s_rtc_crash.magic == RTC_CRASH_MAGIC);

    if (valid_rtc && (abnormal_reason || s_rtc_crash.twdt_triggered == 1)) {
        s_rtc_crash.last_abnormal_reset_reason = (uint8_t)reason;
        cJSON* root = cJSON_CreateObject();
        if (root) {
            cJSON_AddStringToObject(root, "reset_reason", diag_reset_reason_str(reason));
            cJSON_AddNumberToObject(root, "reset_reason_code", (int)reason);
            cJSON_AddBoolToObject(root, "twdt_triggered", s_rtc_crash.twdt_triggered != 0);
            cJSON_AddNumberToObject(root, "uptime_sec", s_rtc_crash.uptime_sec);
            cJSON_AddNumberToObject(root, "free_heap", s_rtc_crash.free_heap);
            cJSON_AddNumberToObject(root, "min_free_heap", s_rtc_crash.min_free_heap);
            cJSON_AddNumberToObject(root, "internal_free_heap", s_rtc_crash.internal_free_heap);
            cJSON_AddNumberToObject(root, "can0_rx_overflow", s_rtc_crash.can0_rx_overflow);
            cJSON_AddNumberToObject(root, "can1_rx_overflow", s_rtc_crash.can1_rx_overflow);
            cJSON_AddStringToObject(root, "cpu0_task", s_rtc_crash.cpu0_task);
            cJSON_AddStringToObject(root, "cpu1_task", s_rtc_crash.cpu1_task);
            cJSON_AddStringToObject(root, "last_event", s_rtc_crash.last_event);
            char id_str[16];
            snprintf(id_str, sizeof(id_str), "0x%03lX", (unsigned long)s_rtc_crash.can_id);
            cJSON_AddStringToObject(root, "can_id", id_str);
            cJSON_AddNumberToObject(root, "dlc", s_rtc_crash.dlc);
            char hex[17] = {0};
            int dlc = s_rtc_crash.dlc > 8 ? 8 : s_rtc_crash.dlc;
            for (int i = 0; i < dlc; i++) {
                snprintf(&hex[i * 2], 3, "%02X", s_rtc_crash.data[i]);
            }
            cJSON_AddStringToObject(root, "data", hex);
            cJSON_AddNumberToObject(root, "step_marker", s_rtc_crash.step_marker);
            cJSON_AddStringToObject(root, "last_decoder", s_rtc_crash.last_decoder);

            char* json_str = cJSON_PrintUnformatted(root);
            if (json_str) {
                FILE* f = fopen("/spiffs/crash_diag.json", "w");
                if (f) {
                    fwrite(json_str, 1, strlen(json_str), f);
                    fclose(f);
                    ESP_LOGW(TAG, "Persisted abnormal reset diagnostics (%s, uptime=%lus, event=%s, cpu0=%s, cpu1=%s)",
                             diag_reset_reason_str(reason), (unsigned long)s_rtc_crash.uptime_sec,
                             s_rtc_crash.last_event, s_rtc_crash.cpu0_task, s_rtc_crash.cpu1_task);
                }
                cJSON_free(json_str);
            }
            cJSON_Delete(root);
        }
        s_rtc_crash.twdt_triggered = 0;
        s_rtc_crash.cpu0_task[0] = '\0';
        s_rtc_crash.cpu1_task[0] = '\0';
        rtc_crash_record_event("boot_diag_saved");
    } else {
        if (!valid_rtc || reason == ESP_RST_POWERON) {
            memset((void*)&s_rtc_crash, 0, sizeof(s_rtc_crash));
            s_rtc_crash.magic = RTC_CRASH_MAGIC;
        } else {
            s_rtc_crash.twdt_triggered = 0;
            s_rtc_crash.cpu0_task[0] = '\0';
            s_rtc_crash.cpu1_task[0] = '\0';
        }
        rtc_crash_record_event(reason == ESP_RST_SW ? "boot_sw" : "boot_poweron");
    }

    esp_register_shutdown_handler(crash_diag_shutdown_handler);
}

struct EvalContext {
    const char* firing_trigger_id = "";
    uint32_t wait_for_start_ms = 0;
};

static std::mutex s_ble_mutex;

struct LastBleEvent {
    std::string address;
    std::string button;
    std::string combo;
    std::string action;
    uint32_t hold_seconds = 0;
    uint32_t timestamp_ms = 0;
};
static LastBleEvent s_last_ble_event;

static bool ble_button_matches(const std::string& target, const std::string& button, const std::string& combo) {
    if (target.empty() || target == "any") return true;
    // Combos match exclusively against the full chord string so single-key rules do not fire on chords.
    const std::string& effective = !combo.empty() ? combo : button;
    return strcasecmp(target.c_str(), effective.c_str()) == 0;
}

static bool ble_action_matches(const std::string& expected, const std::string& actual, uint32_t hold_seconds) {
    if (expected.empty() || expected == "any") return true;
    if (strcasecmp(expected.c_str(), actual.c_str()) == 0) return true;
    if (strcasecmp(expected.c_str(), "press") == 0 && actual.rfind("combo_", 0) == 0) return true;
    if (strcasecmp(expected.c_str(), "tap") == 0 && strcasecmp(actual.c_str(), "release") == 0 && hold_seconds == 0) return true;
    if (strcasecmp(expected.c_str(), "hold") == 0 && actual.rfind("hold_", 0) == 0) return true;
    return false;
}

struct BleDeviceInfo {
    std::string address;
    std::string name;
    bool connected = false;
    int8_t rssi = -100;
    uint32_t last_seen_ms = 0;
};
static std::unordered_map<std::string, BleDeviceInfo> s_ble_devices;
static std::atomic<uint32_t> s_ble_learn_until_ms{0};

struct BleBeaconState {
    std::string uuid;
    std::string mac;
    std::string name;
    int8_t rssi = -100;
    uint16_t major = 0;
    uint16_t minor = 0;
    bool present = false;
    uint32_t last_seen_ms = 0;
};
static std::unordered_map<std::string, BleBeaconState> s_ble_beacons;

static PsramUnorderedMap<uint32_t, CachedCanFrame> can_state_cache;
QueueHandle_t tx_command_queue = nullptr;

std::atomic<bool> g_automations_enabled{true};
std::atomic<bool> g_catalog_reloading{false};
std::atomic<bool> g_sniffer_mode{false};
std::atomic<bool> g_hardware_listen_only{false};
std::atomic<bool> g_mitm_bridge_enabled{false};
std::atomic<bool> g_twai_reconfig_pending{false};
std::atomic<twai_mode_t> g_twai_requested_mode{TWAI_MODE_NORMAL};

static inline bool are_automations_active(void) {
    return g_automations_enabled.load(std::memory_order_relaxed) &&
           !g_catalog_reloading.load(std::memory_order_acquire);
}

void set_automations_enabled(bool enabled) {
    g_automations_enabled.store(enabled);
    ESP_LOGI(TAG, "Automations execution: %s", enabled ? "ENABLED" : "DISABLED");
}

void set_mitm_bridge_enabled(bool enabled) {
    g_mitm_bridge_enabled.store(enabled, std::memory_order_release);
    ESP_LOGI(TAG, "Dual-CAN MITM bridge: %s", enabled ? "ENABLED (CAN0 <-> CAN1 filtering)" : "DISABLED (Bypass)");
}

void can_engine_load_preferences(void) {
    FILE* f = fopen("/spiffs/preferences.json", "r");
    if (!f) {
        g_mitm_bridge_enabled.store(false, std::memory_order_release);
        return;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > 32768) {
        fclose(f);
        return;
    }
    char* buf = static_cast<char*>(malloc(sz + 1));
    if (!buf) {
        fclose(f);
        return;
    }
    size_t nread = fread(buf, 1, sz, f);
    buf[nread] = '\0';
    fclose(f);

    cJSON* root = cJSON_Parse(buf);
    free(buf);
    if (!root) return;

    bool mitm_en = false;
    cJSON* mitm_item = cJSON_GetObjectItem(root, "mitm_bridge_enabled");
    if (cJSON_IsBool(mitm_item)) {
        mitm_en = cJSON_IsTrue(mitm_item);
    }
    cJSON_Delete(root);
    set_mitm_bridge_enabled(mitm_en);
}

void set_sniffer_mode(bool enabled, bool hardware_listen_only) {
    g_sniffer_mode.store(enabled);
    g_hardware_listen_only.store(hardware_listen_only);

    twai_mode_t target_mode = (enabled && hardware_listen_only) ? TWAI_MODE_LISTEN_ONLY : TWAI_MODE_NORMAL;
    if (target_mode != g_twai_requested_mode.load()) {
        g_twai_requested_mode.store(target_mode);
        g_twai_reconfig_pending.store(true);
        ESP_LOGI(TAG, "Requesting TWAI mode switch to: %s",
                 target_mode == TWAI_MODE_LISTEN_ONLY ? "LISTEN_ONLY (No PHY ACK)" : "NORMAL (PHY ACK)");
    }
    ESP_LOGI(TAG, "Sniffer mode: %s (HW listen-only=%d)", enabled ? "ACTIVE" : "OFF", hardware_listen_only ? 1 : 0);
}

static std::mutex s_cache_mutex;

bool get_cached_can_frame(uint32_t can_id, uint8_t out_data[8], uint8_t* out_dlc) {
    std::lock_guard<std::mutex> lock(s_cache_mutex);
    auto it = can_state_cache.find(can_id);
    bool found = (it != can_state_cache.end());
    if (found) {
        if (out_data) {
            memcpy(out_data, it->second.data, 8);
        }
        if (out_dlc) {
            *out_dlc = it->second.dlc;
        }
    }
    return found;
}

static QueueHandle_t s_can_inject_queue = nullptr;
#if CONFIG_SPIRAM
static StaticQueue_t s_can_inject_queue_struct;
static uint8_t* s_can_inject_queue_storage = nullptr;
#endif

bool can_engine_inject_frame(const twai_message_t* msg) {
    if (!s_can_inject_queue || !msg) return false;
    return xQueueSend(s_can_inject_queue, msg, 0) == pdTRUE;
}

void init_can_engine(void) {
    (void)get_or_create_twai_mutex();
    if (!tx_command_queue) {
        tx_command_queue = xQueueCreate(32, sizeof(CanBurstCmd*));
    }
    if (!s_can_inject_queue) {
#if CONFIG_SPIRAM
        s_can_inject_queue_storage = static_cast<uint8_t*>(
            heap_caps_malloc_prefer(128 * sizeof(twai_message_t), 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT));
        if (s_can_inject_queue_storage) {
            s_can_inject_queue = xQueueCreateStatic(128, sizeof(twai_message_t), s_can_inject_queue_storage, &s_can_inject_queue_struct);
        }
#endif
        if (!s_can_inject_queue) {
            s_can_inject_queue = xQueueCreate(128, sizeof(twai_message_t));
        }
    }
    hud_nav_init(HUD_PLATFORM_EGMP_CANFD);
}

static bool exchange_cached_can_frame(uint32_t can_id, const uint8_t* new_data, uint8_t new_dlc,
                                      uint8_t prev_out[8], uint8_t* prev_dlc_out = nullptr) {
    uint8_t clamped_dlc = new_dlc > 8 ? 8 : new_dlc;
    std::lock_guard<std::mutex> lock(s_cache_mutex);
    auto it = can_state_cache.find(can_id);
    if (it != can_state_cache.end()) {
        if (prev_out) {
            memcpy(prev_out, it->second.data, 8);
        }
        if (prev_dlc_out) {
            *prev_dlc_out = it->second.dlc;
        }
        it->second.dlc = clamped_dlc;
        memset(it->second.data, 0, 8);
        if (new_data && clamped_dlc > 0) {
            memcpy(it->second.data, new_data, clamped_dlc);
        }
        return true;
    }
    CachedCanFrame entry = {};
    entry.dlc = clamped_dlc;
    if (new_data && clamped_dlc > 0) {
        memcpy(entry.data, new_data, clamped_dlc);
    }
    can_state_cache.emplace(can_id, entry);
    return false;
}

static std::bitset<2048> s_seen_std_ids;
static PsramUnorderedSet<uint32_t> s_active_can_ids;
static std::mutex s_active_ids_mutex;
static std::atomic<bool> s_active_ids_changed{false};

void can_engine_record_active_id(uint32_t can_id) {
    std::lock_guard<std::mutex> lock(s_active_ids_mutex);
    if (can_id < 2048) {
        if (!s_seen_std_ids.test(can_id)) {
            s_seen_std_ids.set(can_id);
            s_active_can_ids.insert(can_id);
            s_active_ids_changed.store(true, std::memory_order_release);
        }
    } else {
        if (s_active_can_ids.find(can_id) == s_active_can_ids.end()) {
            s_active_can_ids.insert(can_id);
            s_active_ids_changed.store(true, std::memory_order_release);
        }
    }
}

std::vector<uint32_t> can_engine_get_active_ids(void) {
    std::lock_guard<std::mutex> lock(s_active_ids_mutex);
    std::vector<uint32_t> res(s_active_can_ids.begin(), s_active_can_ids.end());
    std::sort(res.begin(), res.end());
    return res;
}

bool can_engine_has_active_ids_changed(void) {
    return s_active_ids_changed.load(std::memory_order_acquire);
}

void can_engine_clear_active_ids_changed(void) {
    s_active_ids_changed.store(false, std::memory_order_release);
}

void rtc_clock_anchor_update(uint64_t epoch_sec) {
    if (epoch_sec < 1704067200) return; // Must be >= Jan 1, 2024
    std::lock_guard<std::mutex> lock(s_cache_mutex);
    s_rtc_can_cache.wall_time_epoch_at_sync = epoch_sec;
    s_rtc_can_cache.esp_timer_us_at_sync = esp_timer_get_time();
    s_rtc_can_cache.time_valid = 1;
}

void rtc_can_state_save(void) {
    std::lock_guard<std::mutex> lock(s_cache_mutex);
    uint32_t count = 0;
    for (const auto& pair : can_state_cache) {
        if (count >= RTC_MAX_SAVED_FRAMES) break;
        s_rtc_can_cache.frames[count].can_id = pair.first;
        s_rtc_can_cache.frames[count].dlc = pair.second.dlc > 8 ? 8 : pair.second.dlc;
        memcpy(s_rtc_can_cache.frames[count].data, pair.second.data, 8);
        count++;
    }
    s_rtc_can_cache.count = count;
    s_rtc_can_cache.timestamp_sec = (uint32_t)(esp_timer_get_time() / 1000000ULL);

    time_t now = time(nullptr);
    if (now >= 1704067200) {
        s_rtc_can_cache.wall_time_epoch_at_sync = (uint64_t)now;
        s_rtc_can_cache.esp_timer_us_at_sync = esp_timer_get_time();
        s_rtc_can_cache.time_valid = 1;
    }

    size_t payload_len = sizeof(RtcCanFrameEntry) * count;
    s_rtc_can_cache.crc32 = calc_can_cache_crc32((const uint8_t*)s_rtc_can_cache.frames, payload_len);
    s_rtc_can_cache.magic = RTC_CAN_STATE_MAGIC;
    ESP_LOGD(TAG, "Saved %lu CAN frames and clock to RTC Fast Memory (CRC: 0x%08lX)",
             (unsigned long)count, (unsigned long)s_rtc_can_cache.crc32);
}

void can_engine_hydrate_from_mqtt(const std::string& entity_id, const std::string& state) {
    if (entity_id.empty() || state.empty()) return;
    bool updated = false;
    {
        std::lock_guard<std::mutex> lock(g_catalog_mutex);
        for (auto& entity : global_catalog) {
            if (entity.id == entity_id) {
                if (entity.current_state.empty() || entity.current_state == "Unknown") {
                    entity.current_state = state;
                    updated = true;
                }
                break;
            }
        }
    }
    if (updated) {
        broadcast_ws_state(entity_id, state);
        ESP_LOGI(TAG, "Hydrated entity state from MQTT: %s = %s", entity_id.c_str(), state.c_str());
    }
}

bool rtc_can_state_restore(void) {
    esp_reset_reason_t reason = esp_reset_reason();
    if (reason == ESP_RST_POWERON) {
        ESP_LOGI(TAG, "Cold power-on detected: RTC state cache uninitialized");
        s_rtc_can_cache.magic = 0;
        g_state_restored_from_rtc.store(false);
        return false;
    }

    if (s_rtc_can_cache.magic != RTC_CAN_STATE_MAGIC) {
        ESP_LOGI(TAG, "RTC state cache uninitialized or invalid magic (0x%08lX)", (unsigned long)s_rtc_can_cache.magic);
        g_state_restored_from_rtc.store(false);
        return false;
    }

    uint32_t count = s_rtc_can_cache.count;
    if (count > RTC_MAX_SAVED_FRAMES) {
        ESP_LOGE(TAG, "RTC state cache corrupted count: %lu", (unsigned long)count);
        s_rtc_can_cache.magic = 0;
        g_state_restored_from_rtc.store(false);
        return false;
    }

    size_t payload_len = sizeof(RtcCanFrameEntry) * count;
    uint32_t computed_crc = calc_can_cache_crc32((const uint8_t*)s_rtc_can_cache.frames, payload_len);
    if (computed_crc != s_rtc_can_cache.crc32) {
        ESP_LOGE(TAG, "RTC state cache CRC mismatch: expected 0x%08lX, got 0x%08lX",
                 (unsigned long)s_rtc_can_cache.crc32, (unsigned long)computed_crc);
        s_rtc_can_cache.magic = 0;
        g_state_restored_from_rtc.store(false);
        return false;
    }

    // 1. Restore system clock if anchor is valid
    if (s_rtc_can_cache.time_valid && s_rtc_can_cache.wall_time_epoch_at_sync >= 1704067200) {
        time_t restore_time = (time_t)s_rtc_can_cache.wall_time_epoch_at_sync;
        struct timeval tv = { .tv_sec = restore_time, .tv_usec = 0 };
        settimeofday(&tv, nullptr);
        char strftime_buf[64];
        timezone_mgr_format_local(restore_time, strftime_buf, sizeof(strftime_buf));
        ESP_LOGI(TAG, "Restored device clock from RTC memory: %s (%s)", strftime_buf, timezone_mgr_get_id());
        broadcast_ws_state("system_time", strftime_buf);
    }

    // 2. Restore CAN state cache
    {
        std::lock_guard<std::mutex> lock(s_cache_mutex);
        can_state_cache.clear();
        for (uint32_t i = 0; i < count; ++i) {
            const auto& entry = s_rtc_can_cache.frames[i];
            CachedCanFrame cached = {};
            uint8_t dlc = entry.dlc > 8 ? 8 : entry.dlc;
            cached.dlc = dlc;
            if (dlc > 0) {
                memcpy(cached.data, entry.data, dlc);
            }
            can_state_cache.emplace(entry.can_id, cached);
        }
    }

    g_state_restored_from_rtc.store(true);
    ESP_LOGI(TAG, "Successfully restored %lu CAN frames from RTC memory across %s reset",
             (unsigned long)count, diag_reset_reason_str(reason));

    // 3. Decode restored frames into catalog entities and live UI state
    for (uint32_t i = 0; i < count; ++i) {
        const auto& entry = s_rtc_can_cache.frames[i];
        decode_can_frame_entities(entry.can_id, entry.data, entry.dlc);
    }

    return true;
}

static bool evaluate_condition_ctx(const AutomationCondition& cond, const EvalContext& ctx);

static bool evaluate_condition_raw(const AutomationCondition& cond, const EvalContext& ctx) {
    switch (cond.logic) {
        case ConditionLogic::AND_GROUP: {
            for (const auto& sub : cond.sub_conditions) {
                if (!evaluate_condition_ctx(sub, ctx)) return false;
            }
            return true;
        }
        case ConditionLogic::OR_GROUP: {
            if (cond.sub_conditions.empty()) return false;
            for (const auto& sub : cond.sub_conditions) {
                if (evaluate_condition_ctx(sub, ctx)) return true;
            }
            return false;
        }
        case ConditionLogic::NOT_GROUP: {
            if (cond.sub_conditions.empty()) return true;
            for (const auto& sub : cond.sub_conditions) {
                if (evaluate_condition_ctx(sub, ctx)) return false;
            }
            return true;
        }
        case ConditionLogic::LEAF:
        default: {
            if (cond.type == "triggered_by") {
                if (cond.trigger_id.empty()) return true;
                return ctx.firing_trigger_id && cond.trigger_id == ctx.firing_trigger_id;
            }

            if (cond.type == "time_condition") {
                time_t now;
                time(&now);
                struct tm timeinfo;
                localtime_r(&now, &timeinfo);

                // Check day of week (bit 0=Sun .. bit 6=Sat)
                if ((cond.weekdays_mask & (1 << timeinfo.tm_wday)) == 0) {
                    return false;
                }

                uint16_t cur_min = static_cast<uint16_t>(timeinfo.tm_hour * 60 + timeinfo.tm_min);

                // Normal daytime window (e.g. 08:00 to 18:00)
                if (cond.start_time_min <= cond.end_time_min) {
                    return cur_min >= cond.start_time_min && cur_min <= cond.end_time_min;
                } else {
                    // Overnight window spanning midnight (e.g. 22:00 to 06:00)
                    return cur_min >= cond.start_time_min || cur_min <= cond.end_time_min;
                }
            }

            if (cond.type == "device_state" || cond.type == "wifi_condition" || cond.type == "wifi") {
                NetworkStatusInfo net_status = network_mgr_get_status();
                if (cond.device_property == "wifi_ssid" || cond.device_property == "ssid") {
                    if (cond.op == ConditionOperator::NOT_EQUAL) {
                        return strcasecmp(net_status.sta_ssid.c_str(), cond.target_string.c_str()) != 0;
                    }
                    if (strcasecmp(net_status.sta_ssid.c_str(), cond.target_string.c_str()) != 0) return false;
                    if (cond.target_rssi != 0) {
                        switch (cond.op) {
                            case ConditionOperator::GREATER_THAN:          return net_status.sta_rssi > cond.target_rssi;
                            case ConditionOperator::GREATER_THAN_OR_EQUAL: return net_status.sta_rssi >= cond.target_rssi;
                            case ConditionOperator::LESS_THAN:             return net_status.sta_rssi < cond.target_rssi;
                            case ConditionOperator::LESS_THAN_OR_EQUAL:    return net_status.sta_rssi <= cond.target_rssi;
                            case ConditionOperator::EQUAL:                 return net_status.sta_rssi == cond.target_rssi;
                            case ConditionOperator::NOT_EQUAL:             return net_status.sta_rssi != cond.target_rssi;
                            default: return false;
                        }
                    }
                    return true;
                } else if (cond.device_property == "wifi_connected" || cond.device_property == "connected") {
                    if (net_status.sta_connected != cond.target_bool) return false;
                    if (cond.target_bool && cond.target_rssi != 0) {
                        switch (cond.op) {
                            case ConditionOperator::GREATER_THAN:          return net_status.sta_rssi > cond.target_rssi;
                            case ConditionOperator::GREATER_THAN_OR_EQUAL: return net_status.sta_rssi >= cond.target_rssi;
                            case ConditionOperator::LESS_THAN:             return net_status.sta_rssi < cond.target_rssi;
                            case ConditionOperator::LESS_THAN_OR_EQUAL:    return net_status.sta_rssi <= cond.target_rssi;
                            case ConditionOperator::EQUAL:                 return net_status.sta_rssi == cond.target_rssi;
                            case ConditionOperator::NOT_EQUAL:             return net_status.sta_rssi != cond.target_rssi;
                            default: return false;
                        }
                    }
                    return true;
                } else if (cond.device_property == "wifi_rssi" || cond.device_property == "wifi_station_rssi" || cond.device_property == "sta_rssi") {
                    if (!net_status.sta_connected) return false;
                    if (!cond.target_string.empty() && strcasecmp(net_status.sta_ssid.c_str(), cond.target_string.c_str()) != 0) {
                        return false;
                    }
                    switch (cond.op) {
                        case ConditionOperator::GREATER_THAN:          return net_status.sta_rssi > cond.target_rssi;
                        case ConditionOperator::GREATER_THAN_OR_EQUAL: return net_status.sta_rssi >= cond.target_rssi;
                        case ConditionOperator::LESS_THAN:             return net_status.sta_rssi < cond.target_rssi;
                        case ConditionOperator::LESS_THAN_OR_EQUAL:    return net_status.sta_rssi <= cond.target_rssi;
                        case ConditionOperator::EQUAL:                 return net_status.sta_rssi == cond.target_rssi;
                        case ConditionOperator::NOT_EQUAL:             return net_status.sta_rssi != cond.target_rssi;
                        default: return false;
                    }
                } else if (cond.device_property == "wifi_mode" || cond.device_property == "ap_mode") {
                    if (cond.target_string == "ap") return net_status.ap_active && !net_status.sta_connected;
                    if (cond.target_string == "sta") return net_status.sta_connected && !net_status.ap_active;
                    if (cond.target_string == "both" || cond.target_string == "ap_sta") return net_status.ap_active && net_status.sta_connected;
                    return net_status.ap_active == cond.target_bool;
                } else if (cond.device_property == "ap_client_connected") {
                    auto stations = network_mgr_get_ap_stations();
                    if (cond.target_string.empty()) {
                        return cond.target_bool ? !stations.empty() : stations.empty();
                    }
                    bool found = false;
                    for (const auto& sta : stations) {
                        if (mac_matches(sta.mac, cond.target_string)) {
                            found = true;
                            break;
                        }
                    }
                    return found == cond.target_bool;
                } else if (cond.device_property == "ap_client_rssi") {
                    auto stations = network_mgr_get_ap_stations();
                    for (const auto& sta : stations) {
                        if (cond.target_string.empty() || mac_matches(sta.mac, cond.target_string)) {
                            switch (cond.op) {
                                case ConditionOperator::GREATER_THAN:          return sta.rssi > cond.target_rssi;
                                case ConditionOperator::GREATER_THAN_OR_EQUAL: return sta.rssi >= cond.target_rssi;
                                case ConditionOperator::LESS_THAN:             return sta.rssi < cond.target_rssi;
                                case ConditionOperator::LESS_THAN_OR_EQUAL:    return sta.rssi <= cond.target_rssi;
                                case ConditionOperator::EQUAL:                 return sta.rssi == cond.target_rssi;
                                case ConditionOperator::NOT_EQUAL:             return sta.rssi != cond.target_rssi;
                                default: return false;
                            }
                        }
                    }
                    return false;
                }
                return false;
            }

            if (cond.type == "ble_button" || cond.type == "ble" || cond.type == "bluetooth") {
                std::lock_guard<std::mutex> lock(s_ble_mutex);
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                uint32_t threshold_ms = (ctx.wait_for_start_ms > 0) ? ctx.wait_for_start_ms : (now_ms > 2500 ? now_ms - 2500 : 0);
                if (ctx.wait_for_start_ms > 0) {
                    if (s_last_ble_event.timestamp_ms <= ctx.wait_for_start_ms) {
                        return false;
                    }
                } else if (s_last_ble_event.timestamp_ms < threshold_ms) {
                    return false;
                }

                const std::string& target_btn = !cond.ble_button.empty() ? cond.ble_button : cond.target_string;
                if (!ble_button_matches(target_btn, s_last_ble_event.button, s_last_ble_event.combo)) {
                    return false;
                }

                if (!ble_action_matches(cond.ble_action, s_last_ble_event.action, s_last_ble_event.hold_seconds)) {
                    return false;
                }

                const std::string& target_dev = !cond.ble_device.empty() ? cond.ble_device : cond.target_string;
                if (!target_dev.empty()) {
                    if (!mac_matches(target_dev, s_last_ble_event.address)) {
                        return false;
                    }
                }

                return true;
            }

            if (cond.type == "ble_beacon" || cond.type == "beacon" || (cond.type == "ble_presence" && (!cond.beacon_uuid.empty() || cond.device_property == "beacon_present" || cond.device_property == "present" || cond.device_property == "away"))) {
                std::lock_guard<std::mutex> lock(s_ble_mutex);
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                const std::string& target_uuid = !cond.beacon_uuid.empty() ? cond.beacon_uuid : (!cond.ble_device.empty() ? cond.ble_device : cond.target_string);
                bool check_away = (cond.device_property == "away" || (!cond.target_bool && (cond.device_property == "present" || cond.device_property == "beacon_present")));

                if (target_uuid.empty()) {
                    bool any_present = false;
                    for (const auto& kv : s_ble_beacons) {
                        if (kv.second.present && (now_ms - kv.second.last_seen_ms <= 60000)) {
                            any_present = true;
                            break;
                        }
                    }
                    if (check_away) return !any_present;
                    return any_present == cond.target_bool;
                }

                for (const auto& kv : s_ble_beacons) {
                    bool match = false;
                    if (!kv.second.uuid.empty() && strcasestr(kv.second.uuid.c_str(), target_uuid.c_str()) != nullptr) match = true;
                    if (!kv.second.mac.empty() && mac_matches(target_uuid, kv.second.mac)) match = true;
                    if (!kv.second.name.empty() && strcasecmp(target_uuid.c_str(), kv.second.name.c_str()) == 0) match = true;

                    if (match) {
                        bool is_present = kv.second.present && (now_ms - kv.second.last_seen_ms <= 60000);
                        if (check_away) {
                            return !is_present;
                        }
                        if (!is_present) return false;

                        // Target is present; if RSSI evaluation requested, check threshold
                        if (cond.device_property == "rssi" || cond.device_property == "proximity" || cond.target_rssi != 0) {
                            switch (cond.op) {
                                case ConditionOperator::GREATER_THAN:          return kv.second.rssi > cond.target_rssi;
                                case ConditionOperator::GREATER_THAN_OR_EQUAL: return kv.second.rssi >= cond.target_rssi;
                                case ConditionOperator::LESS_THAN:             return kv.second.rssi < cond.target_rssi;
                                case ConditionOperator::LESS_THAN_OR_EQUAL:    return kv.second.rssi <= cond.target_rssi;
                                case ConditionOperator::EQUAL:                 return kv.second.rssi == cond.target_rssi;
                                case ConditionOperator::NOT_EQUAL:             return kv.second.rssi != cond.target_rssi;
                                default: return false;
                            }
                        }
                        return true;
                    }
                }
                return check_away;
            }

            if (cond.type == "ble_device" || cond.type == "ble_presence") {
                std::lock_guard<std::mutex> lock(s_ble_mutex);
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                const std::string& target_dev = !cond.ble_device.empty() ? cond.ble_device : cond.target_string;
                bool check_away = (cond.device_property == "away" || cond.device_property == "disconnected" || (!cond.target_bool && (cond.device_property == "present" || cond.device_property == "connected")));

                if (target_dev.empty()) {
                    bool any_connected = false;
                    for (const auto& kv : s_ble_devices) {
                        if (kv.second.connected && (now_ms - kv.second.last_seen_ms <= 60000)) {
                            any_connected = true;
                            break;
                        }
                    }
                    if (check_away) return !any_connected;
                    return any_connected == cond.target_bool;
                }

                for (const auto& kv : s_ble_devices) {
                    if (mac_matches(target_dev, kv.second.address) || strcasecmp(target_dev.c_str(), kv.second.name.c_str()) == 0) {
                        bool is_conn = kv.second.connected && (now_ms - kv.second.last_seen_ms <= 60000);
                        if (check_away) {
                            return !is_conn;
                        }
                        if (!is_conn) return false;

                        if (cond.device_property == "rssi" || cond.device_property == "proximity" || cond.target_rssi != 0) {
                            switch (cond.op) {
                                case ConditionOperator::GREATER_THAN:          return kv.second.rssi > cond.target_rssi;
                                case ConditionOperator::GREATER_THAN_OR_EQUAL: return kv.second.rssi >= cond.target_rssi;
                                case ConditionOperator::LESS_THAN:             return kv.second.rssi < cond.target_rssi;
                                case ConditionOperator::LESS_THAN_OR_EQUAL:    return kv.second.rssi <= cond.target_rssi;
                                case ConditionOperator::EQUAL:                 return kv.second.rssi == cond.target_rssi;
                                case ConditionOperator::NOT_EQUAL:             return kv.second.rssi != cond.target_rssi;
                                default: return false;
                            }
                        }
                        return true;
                    }
                }
                return check_away;
            }

            if (cond.type == "voltage" || cond.type == "vbat") {
                float vbat = vbat_sensor_get_last();
                switch (cond.op) {
                    case ConditionOperator::GREATER_THAN:          return vbat > cond.target_float;
                    case ConditionOperator::GREATER_THAN_OR_EQUAL: return vbat >= cond.target_float;
                    case ConditionOperator::LESS_THAN:             return vbat < cond.target_float;
                    case ConditionOperator::LESS_THAN_OR_EQUAL:    return vbat <= cond.target_float;
                    case ConditionOperator::EQUAL:                 return std::abs(vbat - cond.target_float) < 0.1f;
                    case ConditionOperator::NOT_EQUAL:             return std::abs(vbat - cond.target_float) >= 0.1f;
                    default: return false;
                }
            }

            uint8_t cached_frame[8] = {0};
            uint8_t cached_dlc = 0;
            if (!get_cached_can_frame(cond.can_id, cached_frame, &cached_dlc)) return false;

            if (cond.byte_index >= 8 || cond.byte_index >= cached_dlc) return false;
            uint8_t actual = cached_frame[cond.byte_index];
            uint8_t mask = cond.byte_mask;

            uint8_t masked_actual = actual & mask;
            uint8_t masked_target = cond.target_value & mask;

            switch (cond.op) {
                case ConditionOperator::EQUAL:                 return masked_actual == masked_target;
                case ConditionOperator::NOT_EQUAL:             return masked_actual != masked_target;
                case ConditionOperator::LESS_THAN:             return masked_actual < masked_target;
                case ConditionOperator::LESS_THAN_OR_EQUAL:    return masked_actual <= masked_target;
                case ConditionOperator::GREATER_THAN:          return masked_actual > masked_target;
                case ConditionOperator::GREATER_THAN_OR_EQUAL: return masked_actual >= masked_target;
                default: return false;
            }
        }
    }
}

static bool evaluate_condition_ctx(const AutomationCondition& cond, const EvalContext& ctx) {
    bool raw = evaluate_condition_raw(cond, ctx);
    if (cond.for_ms == 0 || !cond.sustained) {
        return raw;
    }

    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    std::lock_guard<std::mutex> lk(cond.sustained->mtx);
    if (raw) {
        if (!cond.sustained->active) {
            cond.sustained->active = true;
            cond.sustained->since_ms = now_ms;
            return false;
        }
        return (now_ms - cond.sustained->since_ms) >= cond.for_ms;
    }
    cond.sustained->active = false;
    cond.sustained->since_ms = 0;
    return false;
}

bool evaluate_condition(const AutomationCondition& cond) {
    return evaluate_condition_ctx(cond, EvalContext{});
}

static bool condition_uses_can_id(const AutomationCondition& cond, uint32_t can_id) {
    if (cond.type == "can_state" && cond.can_id == can_id) return true;
    for (const auto& sub : cond.sub_conditions) {
        if (condition_uses_can_id(sub, can_id)) return true;
    }
    return false;
}

static void collect_sustained_condition_can_ids(const AutomationCondition& cond,
                                                PsramUnorderedSet<uint32_t>& out_ids,
                                                bool parent_sustained = false) {
    bool is_sustained = parent_sustained || (cond.for_ms > 0);
    if (is_sustained && cond.type == "can_state" && cond.can_id != 0) {
        out_ids.insert(cond.can_id);
    }
    for (const auto& sub : cond.sub_conditions) {
        collect_sustained_condition_can_ids(sub, out_ids, is_sustained);
    }
}

static void collect_sustained_step_can_ids(const PsramVector<ActionStep>& steps, PsramUnorderedSet<uint32_t>& out_ids) {
    for (const auto& step : steps) {
        if (step.type == ActionType::IF_THEN) {
            for (const auto& c : step.if_conditions) collect_sustained_condition_can_ids(c, out_ids);
            collect_sustained_step_can_ids(step.then_steps, out_ids);
            collect_sustained_step_can_ids(step.else_steps, out_ids);
        } else if (step.type == ActionType::CHOOSE) {
            for (const auto& br : step.choices) {
                for (const auto& c : br.conditions) collect_sustained_condition_can_ids(c, out_ids);
                collect_sustained_step_can_ids(br.sequence, out_ids);
            }
            collect_sustained_step_can_ids(step.default_steps, out_ids);
        } else if (step.type == ActionType::REPEAT_UNTIL || step.type == ActionType::WAIT_FOR) {
            collect_sustained_condition_can_ids(step.condition, out_ids);
            collect_sustained_step_can_ids(step.sequence, out_ids);
        }
    }
}

static void tick_sustained_condition_tree(const AutomationCondition& cond, uint32_t filter_can_id = 0) {
    if (cond.for_ms > 0 && (filter_can_id == 0 || condition_uses_can_id(cond, filter_can_id))) {
        (void)evaluate_condition(cond);
    }
    for (const auto& sub : cond.sub_conditions) {
        tick_sustained_condition_tree(sub, filter_can_id);
    }
}

static void tick_sustained_conditions_in_steps(const PsramVector<ActionStep>& steps, uint32_t filter_can_id = 0) {
    for (const auto& step : steps) {
        if (step.type == ActionType::IF_THEN) {
            for (const auto& c : step.if_conditions) tick_sustained_condition_tree(c, filter_can_id);
            tick_sustained_conditions_in_steps(step.then_steps, filter_can_id);
            tick_sustained_conditions_in_steps(step.else_steps, filter_can_id);
        } else if (step.type == ActionType::CHOOSE) {
            for (const auto& br : step.choices) {
                for (const auto& c : br.conditions) tick_sustained_condition_tree(c, filter_can_id);
                tick_sustained_conditions_in_steps(br.sequence, filter_can_id);
            }
            tick_sustained_conditions_in_steps(step.default_steps, filter_can_id);
        }
    }
}

bool is_match(const uint8_t* incoming_data, const EntityOption& option, uint8_t dlc) {
    if (!incoming_data || option.match_mask == 0) return false;
    for (int i = 0; i < 8; i++) {
        if ((option.match_mask & (1 << i)) != 0) {
            if (i >= dlc) return false;
            bool inverted = (option.invert_mask & (1 << i)) != 0;
            uint8_t mask = option.byte_masks[i];
            uint8_t actual = incoming_data[i] & mask;
            uint8_t target = option.match_payload[i] & mask;
            if (inverted) {
                if (actual == target) return false;
            } else {
                if (actual != target) return false;
            }
        }
    }
    return true;
}

static inline bool evaluate_masked_byte(uint8_t actual_value, uint8_t target_value, uint8_t mask,
                                        ConditionOperator op = ConditionOperator::EQUAL) {
    uint8_t actual_masked = actual_value & mask;
    uint8_t target_masked = target_value & mask;
    switch (op) {
        case ConditionOperator::NOT_EQUAL:             return actual_masked != target_masked;
        case ConditionOperator::LESS_THAN:             return actual_masked < target_masked;
        case ConditionOperator::LESS_THAN_OR_EQUAL:    return actual_masked <= target_masked;
        case ConditionOperator::GREATER_THAN:          return actual_masked > target_masked;
        case ConditionOperator::GREATER_THAN_OR_EQUAL: return actual_masked >= target_masked;
        case ConditionOperator::EQUAL:
        default:                                       return actual_masked == target_masked;
    }
}

static bool is_can_target_match(const uint8_t* incoming_data, uint8_t dlc, const AutomationTrigger& trig) {
    if (!incoming_data) return false;
    if (trig.type == "byte_transition") {
        if (trig.byte_index < 0 || trig.byte_index >= 8 || trig.byte_index >= dlc) return false;
        bool is_to = evaluate_masked_byte(incoming_data[trig.byte_index], trig.to_value, trig.byte_mask, trig.op);
        // Menu Up fallback alias: CAN ID 0x448, byte index 6 (D7)
        if (!is_to && trig.op == ConditionOperator::EQUAL && trig.can_id == 0x448 && trig.byte_index == 6 && (trig.to_value == 0x40 || trig.to_value == 0x02)) {
            uint8_t actual_nibble = incoming_data[6] & 0x0F;
            if (actual_nibble == 0x02 || actual_nibble == 0x04 || (incoming_data[6] & 0xF0) == 0x40) {
                is_to = true;
            }
        }
        return is_to;
    }

    if (trig.match_mask == 0) return true; // match whole ID if no byte mask
    for (int i = 0; i < 8; i++) {
        if ((trig.match_mask & (1 << i)) != 0) {
            if (i >= dlc) return false;
            uint8_t mask = trig.byte_masks[i];
            bool match = ((incoming_data[i] & mask) == (trig.match_payload[i] & mask));
            // Menu Up fallback alias: CAN ID 0x448, byte index 6 (D7)
            if (!match && trig.can_id == 0x448 && i == 6 && (trig.match_payload[6] == 0x40 || trig.match_payload[6] == 0x02)) {
                uint8_t actual_nibble = incoming_data[6] & 0x0F;
                if (actual_nibble == 0x02 || actual_nibble == 0x04 || (incoming_data[6] & 0xF0) == 0x40) {
                    match = true;
                }
            }
            if (!match) return false;
        }
    }
    return true;
}

static bool is_trigger_match(const uint8_t* incoming_data, uint8_t dlc,
                             const uint8_t* previous_data, uint8_t prev_dlc,
                             const AutomationTrigger& trig) {
    if (!incoming_data) return false;
    if (trig.type == "byte_transition") {
        if (trig.byte_index < 0 || trig.byte_index >= 8 || trig.byte_index >= dlc) return false;
        if (!previous_data || trig.byte_index >= prev_dlc) return false;
        bool is_to = is_can_target_match(incoming_data, dlc, trig);
        if (trig.has_from_value) {
            bool was_from = evaluate_masked_byte(previous_data[trig.byte_index], trig.from_value, trig.byte_mask);
            return was_from && is_to && ((previous_data[trig.byte_index] & trig.byte_mask) != (incoming_data[trig.byte_index] & trig.byte_mask));
        } else {
            bool was_to = evaluate_masked_byte(previous_data[trig.byte_index], trig.to_value, trig.byte_mask, trig.op);
            if (!was_to && trig.op == ConditionOperator::EQUAL && trig.can_id == 0x448 && trig.byte_index == 6 && (trig.to_value == 0x40 || trig.to_value == 0x02)) {
                uint8_t prev_nibble = previous_data[6] & 0x0F;
                was_to = (prev_nibble == 0x02 || prev_nibble == 0x04 || (previous_data[6] & 0xF0) == 0x40);
            }
            return !was_to && is_to;
        }
    }

    if (trig.click_count > 1 && previous_data && is_can_target_match(previous_data, prev_dlc, trig)) {
        return false; // Require rising edge for multi-click counting on can_rx triggers
    }

    return is_can_target_match(incoming_data, dlc, trig);
}

static CanBurstCmd* prepare_action_burst(uint32_t can_id, uint32_t delay_ms,
                                         const PsramVector<ActionStep>& steps,
                                         const std::string& trigger_id,
                                         std::shared_ptr<std::atomic<bool>> rule_is_running);
static bool submit_action_burst(CanBurstCmd* cmd, TickType_t wait_ticks);

struct FiredRuleEvent {
    std::string rule_id;
    std::string rule_name;
    std::string trig_id;
    const char* source_label = "";
    CanBurstCmd* pending_cmd = nullptr;

    FiredRuleEvent() = default;
    FiredRuleEvent(std::string rid, std::string rname, std::string tid, const char* src, CanBurstCmd* cmd = nullptr)
        : rule_id(std::move(rid)), rule_name(std::move(rname)), trig_id(std::move(tid)), source_label(src), pending_cmd(cmd) {}
    FiredRuleEvent(const FiredRuleEvent&) = delete;
    FiredRuleEvent& operator=(const FiredRuleEvent&) = delete;
    FiredRuleEvent(FiredRuleEvent&& other) noexcept
        : rule_id(std::move(other.rule_id)),
          rule_name(std::move(other.rule_name)),
          trig_id(std::move(other.trig_id)),
          source_label(other.source_label),
          pending_cmd(other.pending_cmd) {
        other.pending_cmd = nullptr;
    }
    FiredRuleEvent& operator=(FiredRuleEvent&& other) noexcept {
        if (this != &other) {
            release_pending();
            rule_id = std::move(other.rule_id);
            rule_name = std::move(other.rule_name);
            trig_id = std::move(other.trig_id);
            source_label = other.source_label;
            pending_cmd = other.pending_cmd;
            other.pending_cmd = nullptr;
        }
        return *this;
    }
    ~FiredRuleEvent() {
        release_pending();
    }
    void release_pending() {
        if (pending_cmd) {
            if (pending_cmd->rule_is_running) {
                pending_cmd->rule_is_running->store(false, std::memory_order_release);
            }
            delete pending_cmd;
            pending_cmd = nullptr;
        }
    }
};

static void dispatch_fired_rule_events(std::vector<FiredRuleEvent>& events, TickType_t queue_wait = 0) {
    for (auto& ev : events) {
        if (ev.pending_cmd) {
            CanBurstCmd* cmd = ev.pending_cmd;
            ev.pending_cmd = nullptr;
            if (!submit_action_burst(cmd, queue_wait)) {
                ESP_LOGW(TAG, "%s dropped rule '%s': TX command queue full", ev.source_label, ev.rule_name.c_str());
                continue;
            }
        }
        ESP_LOGI(TAG, "%s fired rule: %s (trigger: %s)", ev.source_label, ev.rule_name.c_str(), ev.trig_id.c_str());
        broadcast_ws_automation_event(ev.rule_id, ev.rule_name);
    }
}

static bool evaluate_trigger_state_now(const AutomationTrigger& trig, uint32_t now_ms);

static bool check_trigger_combine_mode(AutomationRule& rule, const AutomationTrigger& trig, uint32_t now_ms) {
    if (rule.triggers.size() <= 1 || rule.trigger_mode.empty() || rule.trigger_mode == "any") {
        return true;
    }

    if (!rule.trigger_state) {
        rule.trigger_state = std::make_shared<TriggerCombineState>();
    }
    auto& st = *rule.trigger_state;
    const size_t n = rule.triggers.size();
    if (st.last_hit_ms.size() != n) {
        st.last_hit_ms.assign(n, 0);
        st.seq_step = 0;
        st.seq_last_hit_ms = 0;
    }

    int trig_idx = -1;
    for (size_t i = 0; i < n; ++i) {
        if (&rule.triggers[i] == &trig || (!trig.id.empty() && rule.triggers[i].id == trig.id)) {
            trig_idx = static_cast<int>(i);
            break;
        }
    }
    if (trig_idx < 0) return false;

    const uint32_t window_ms = (rule.trigger_window_ms >= 500) ? rule.trigger_window_ms : 8000;

    if (rule.trigger_mode == "sequence") {
        if (st.seq_step > 0 && (now_ms - st.seq_last_hit_ms > window_ms)) {
            st.seq_step = 0;
        }
        if (static_cast<size_t>(trig_idx) == st.seq_step) {
            st.seq_step++;
            st.seq_last_hit_ms = now_ms;
            if (st.seq_step >= n) {
                st.seq_step = 0;
                st.seq_last_hit_ms = 0;
                return true;
            }
            return false;
        }
        if (st.seq_step > 0 && static_cast<size_t>(trig_idx) == st.seq_step - 1) {
            // Same previous trigger re-firing (e.g., periodic CAN frame); refresh timestamp
            st.seq_last_hit_ms = now_ms;
            return false;
        }
        if (trig_idx == 0) {
            st.seq_step = 1;
            st.seq_last_hit_ms = now_ms;
        } else {
            st.seq_step = 0;
            st.seq_last_hit_ms = 0;
        }
        return false;
    }

    if (rule.trigger_mode == "all") {
        st.last_hit_ms[trig_idx] = now_ms;
        bool all_satisfied = true;
        for (size_t i = 0; i < n; ++i) {
            if (i == static_cast<size_t>(trig_idx)) continue;
            bool recent = (st.last_hit_ms[i] != 0) && ((now_ms - st.last_hit_ms[i]) <= window_ms);
            if (!recent && !evaluate_trigger_state_now(rule.triggers[i], now_ms)) {
                all_satisfied = false;
                break;
            }
        }
        if (all_satisfied) {
            std::fill(st.last_hit_ms.begin(), st.last_hit_ms.end(), 0);
            return true;
        }
        return false;
    }

    return true;
}

static bool try_fire_rule_trigger(AutomationRule& rule, const AutomationTrigger& trig, uint32_t now_ms,
                                  const char* source_label, std::vector<FiredRuleEvent>* fired_out = nullptr) {
    if (rule.is_running && rule.is_running->load(std::memory_order_acquire)) {
        return false;
    }
    if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
        return false;
    }

    if (!check_trigger_combine_mode(rule, trig, now_ms)) {
        return false;
    }

    EvalContext eval_ctx;
    eval_ctx.firing_trigger_id = trig.id.c_str();
    bool passed = true;
    for (const auto& cond : rule.conditions) {
        if (!evaluate_condition_ctx(cond, eval_ctx)) {
            passed = false;
            break;
        }
    }

    if (!passed) return false;

    CanBurstCmd* cmd = prepare_action_burst(0, 20, rule.actions, trig.id, rule.is_running);
    if (!cmd) {
        return false;
    }
    if (fired_out) {
        rule.last_exec_time_ms = now_ms;
        fired_out->emplace_back(rule.id, rule.name, trig.id, source_label, cmd);
        return true;
    }
    if (!submit_action_burst(cmd, 0)) {
        return false;
    }
    rule.last_exec_time_ms = now_ms;
    return true;
}

static constexpr uint32_t MULTI_CLICK_WINDOW_MS = 450;
static constexpr uint32_t MULTI_CLICK_DEBOUNCE_MS = 45;

static bool triggers_share_button_target(const AutomationTrigger& a, const AutomationTrigger& b) {
    const bool a_is_can = (a.type == "can_rx" || a.type == "byte_transition");
    const bool b_is_can = (b.type == "can_rx" || b.type == "byte_transition");
    if (a_is_can && b_is_can) {
        if (a.can_id != b.can_id || a.bus != b.bus) return false;
        if (a.byte_index >= 0 && b.byte_index >= 0) {
            return a.byte_index == b.byte_index &&
                   a.byte_mask == b.byte_mask &&
                   (a.to_value & a.byte_mask) == (b.to_value & b.byte_mask);
        }
        return a.match_mask == b.match_mask &&
               memcmp(a.match_payload, b.match_payload, 8) == 0;
    }

    const bool a_is_ble = (a.type == "ble_button" || a.type == "ble_key" || a.type == "ble");
    const bool b_is_ble = (b.type == "ble_button" || b.type == "ble_key" || b.type == "ble");
    if (a_is_ble && b_is_ble) {
        if (strcasecmp(a.ble_button.c_str(), b.ble_button.c_str()) != 0 &&
            a.ble_button != "any" && b.ble_button != "any") {
            return false;
        }
        if (!a.ble_device.empty() && !b.ble_device.empty() &&
            strcasecmp(a.ble_device.c_str(), b.ble_device.c_str()) != 0) {
            return false;
        }
        return true;
    }

    return false;
}

// Caller must hold g_automations_mutex
static bool has_higher_click_count_sibling(const AutomationTrigger& trig) {
    const uint8_t my_clicks = trig.click_count >= 1 ? trig.click_count : 1;
    for (const auto& rule : global_automations) {
        if (!rule.enabled) continue;
        for (const auto& other : rule.triggers) {
            const uint8_t other_clicks = other.click_count >= 1 ? other.click_count : 1;
            if (other_clicks > my_clicks && triggers_share_button_target(trig, other)) {
                return true;
            }
        }
    }
    return false;
}

// Caller must hold g_automations_mutex
static bool handle_trigger_press_edge(AutomationRule& rule, const AutomationTrigger& trig, uint32_t now_ms,
                                      const char* source_label, std::vector<FiredRuleEvent>* fired_out) {
    const uint8_t target_clicks = trig.click_count >= 1 ? trig.click_count : 1;
    const bool has_higher = has_higher_click_count_sibling(trig);

    if (target_clicks == 1 && !has_higher) {
        return try_fire_rule_trigger(rule, trig, now_ms, source_label, fired_out);
    }

    if (!trig.multi_click) {
        return (target_clicks == 1) ? try_fire_rule_trigger(rule, trig, now_ms, source_label, fired_out) : false;
    }

    bool fire_immediately = false;
    {
        std::lock_guard<std::mutex> lk(trig.multi_click->mtx);
        if (trig.multi_click->last_press_ms != 0 &&
            (now_ms - trig.multi_click->last_press_ms < MULTI_CLICK_DEBOUNCE_MS)) {
            return false;
        }
        if (trig.multi_click->pending &&
            (now_ms - trig.multi_click->last_press_ms <= MULTI_CLICK_WINDOW_MS)) {
            trig.multi_click->count++;
        } else {
            trig.multi_click->count = 1;
        }
        trig.multi_click->last_press_ms = now_ms;
        trig.multi_click->pending = true;

        if (!has_higher && trig.multi_click->count == target_clicks) {
            trig.multi_click->pending = false;
            trig.multi_click->count = 0;
            fire_immediately = true;
        }
    }

    if (fire_immediately) {
        return try_fire_rule_trigger(rule, trig, now_ms, source_label, fired_out);
    }
    return false;
}

static bool evaluate_trigger_state_now(const AutomationTrigger& trig, uint32_t now_ms) {
    if (trig.type == "can_rx" || trig.type == "byte_transition") {
        uint8_t frame[8] = {0};
        uint8_t frame_dlc = 0;
        if (!get_cached_can_frame(trig.can_id, frame, &frame_dlc)) return false;
        return is_can_target_match(frame, frame_dlc, trig);
    }

    if (trig.type == "ble_beacon" || trig.type == "beacon" ||
        (trig.type == "ble_presence" && (!trig.beacon_uuid.empty() || trig.ble_event == "enter" || trig.ble_event == "exit" || trig.ble_event == "present" || trig.ble_event == "away" || trig.ble_event == "proximity"))) {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        const std::string& target_filter = !trig.beacon_uuid.empty() ? trig.beacon_uuid : (!trig.ble_device.empty() ? trig.ble_device : trig.client_mac);
        bool check_away = (strcasecmp(trig.ble_event.c_str(), "exit") == 0 || strcasecmp(trig.ble_event.c_str(), "away") == 0);

        if (target_filter.empty()) {
            bool any_present = false;
            for (const auto& kv : s_ble_beacons) {
                if (kv.second.present && (now_ms - kv.second.last_seen_ms <= 60000)) {
                    if (check_away || trig.target_rssi == 0 || kv.second.rssi >= trig.target_rssi) {
                        any_present = true;
                        break;
                    }
                }
            }
            return check_away ? !any_present : any_present;
        }

        for (const auto& kv : s_ble_beacons) {
            bool match = false;
            if (!kv.second.uuid.empty() && strcasestr(kv.second.uuid.c_str(), target_filter.c_str()) != nullptr) match = true;
            if (!kv.second.mac.empty() && mac_matches(target_filter, kv.second.mac)) match = true;
            if (!kv.second.name.empty() && strcasecmp(target_filter.c_str(), kv.second.name.c_str()) == 0) match = true;
            if (match) {
                bool is_present = kv.second.present && (now_ms - kv.second.last_seen_ms <= 60000);
                if (check_away) return !is_present;
                if (!is_present) return false;
                return (trig.target_rssi == 0) || (kv.second.rssi >= trig.target_rssi);
            }
        }
        return check_away;
    }

    if (trig.type == "ble_device_event" || trig.type == "ble_device" || trig.type == "ble_presence") {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        bool check_away = (strcasecmp(trig.ble_event.c_str(), "disconnected") == 0 || strcasecmp(trig.ble_event.c_str(), "away") == 0);
        if (trig.ble_device.empty()) {
            bool any_conn = false;
            for (const auto& kv : s_ble_devices) {
                if (kv.second.connected && (now_ms - kv.second.last_seen_ms <= 60000)) {
                    if (check_away || trig.target_rssi == 0 || kv.second.rssi >= trig.target_rssi) {
                        any_conn = true;
                        break;
                    }
                }
            }
            return check_away ? !any_conn : any_conn;
        }
        for (const auto& kv : s_ble_devices) {
            if (mac_matches(trig.ble_device, kv.second.address) || strcasecmp(trig.ble_device.c_str(), kv.second.name.c_str()) == 0) {
                bool is_conn = kv.second.connected && (now_ms - kv.second.last_seen_ms <= 60000);
                if (check_away) return !is_conn;
                if (!is_conn) return false;
                return (trig.target_rssi == 0) || (kv.second.rssi >= trig.target_rssi);
            }
        }
        return check_away;
    }

    if (trig.type == "wifi" || trig.type == "wifi_event" || trig.type == "device_event") {
        NetworkStatusInfo net = network_mgr_get_status();
        if (trig.wifi_event == "wifi_connected" || trig.wifi_event == "connected" || trig.wifi_event == "sta_connected") {
            if (!net.sta_connected) return false;
            if (!trig.ssid.empty() && strcasecmp(trig.ssid.c_str(), net.sta_ssid.c_str()) != 0) return false;
            return (trig.target_rssi == 0) || (net.sta_rssi >= trig.target_rssi);
        }
        if (trig.wifi_event == "wifi_disconnected" || trig.wifi_event == "disconnected" || trig.wifi_event == "sta_disconnected") {
            return !net.sta_connected;
        }
        if (trig.wifi_event == "ap_client_connected") {
            auto stations = network_mgr_get_ap_stations();
            if (trig.client_mac.empty()) {
                if (stations.empty()) return false;
                if (trig.target_rssi == 0) return true;
                for (const auto& sta : stations) {
                    if (sta.rssi >= trig.target_rssi) return true;
                }
                return false;
            }
            for (const auto& sta : stations) {
                if (mac_matches(trig.client_mac, sta.mac)) {
                    return (trig.target_rssi == 0) || (sta.rssi >= trig.target_rssi);
                }
            }
            return false;
        }
        if (trig.wifi_event == "ap_client_disconnected") {
            auto stations = network_mgr_get_ap_stations();
            if (trig.client_mac.empty()) return stations.empty();
            for (const auto& sta : stations) {
                if (mac_matches(trig.client_mac, sta.mac)) return false;
            }
            return true;
        }
    }

    return false;
}

static void update_sustained_trigger_state(const AutomationTrigger& trig, bool now_true, uint32_t now_ms) {
    if (!trig.sustained) return;
    std::lock_guard<std::mutex> lk(trig.sustained->mtx);
    if (!now_true) {
        trig.sustained->active = false;
        trig.sustained->since_ms = 0;
        trig.sustained->fired = false;
    } else if (!trig.sustained->active) {
        trig.sustained->active = true;
        trig.sustained->since_ms = now_ms;
        trig.sustained->fired = false;
    }
}

static bool is_ambient_entity_id(const std::string& id) {
    return strcasecmp(id.c_str(), "ambient_light_colors") == 0 ||
           strcasecmp(id.c_str(), "ambient_mood_lighting") == 0 ||
           strcasecmp(id.c_str(), "ambient_mood_lamp_color") == 0 ||
           strcasecmp(id.c_str(), "mood_lighting") == 0 ||
           strcasecmp(id.c_str(), "ambient_light") == 0;
}

static constexpr int MAX_BURST_RECURSION_DEPTH = 8;

static void execute_can_burst_ctx(uint32_t can_id, const PsramVector<ActionStep>& steps,
                                  uint32_t delay_ms, const EvalContext& ctx, int depth);

static __attribute__((noinline)) void execute_entity_command_step(const ActionStep& step,
                                                                  const EvalContext& ctx, int depth) {
    if (is_ambient_entity_id(step.entity_id)) {
        if (ambient_anim_start_by_name(step.command)) {
            std::string new_state = ambient_anim_get_effect_name();
            mitm_arm_entity("ambient_light_colors");
            {
                std::lock_guard<std::mutex> lock(g_catalog_mutex);
                for (auto& cat_ent : global_catalog) {
                    if (strcasecmp(cat_ent.id.c_str(), step.entity_id.c_str()) == 0 ||
                        cat_ent.id == "ambient_light_colors") {
                        cat_ent.current_state = new_state;
                    }
                }
            }
            mqtt_mgr_publish_entity_state("ambient_light_colors", new_state);
            broadcast_ws_state("ambient_light_colors", new_state);
            return;
        }
        if (strcasecmp(step.command.c_str(), "stop") == 0) {
            ambient_anim_stop();
            return;
        }
    }

    bool executed_inline = false;
    uint32_t tx_can_id = 0;
    uint32_t tx_delay_ms = 0;
    PsramVector<ActionStep> tx_steps;
    {
        std::lock_guard<std::mutex> lock(g_catalog_mutex);
        for (const auto& entity : global_catalog) {
            if (strcasecmp(entity.id.c_str(), step.entity_id.c_str()) == 0) {
                for (const auto& option : entity.options) {
                    if (strcasecmp(option.label.c_str(), step.command.c_str()) == 0 || (entity.options.size() == 1 && step.command.empty())) {
                        tx_can_id = entity.action_can_id;
                        tx_delay_ms = entity.delay_ms;
                        tx_steps = catalog_steps_to_action_steps(option.steps);
                        executed_inline = true;
                        break;
                    }
                }
                break;
            }
        }
    }
    if (executed_inline) {
        if (is_ambient_entity_id(step.entity_id)) {
            ambient_anim_stop();
        }
        mitm_arm_entity(step.entity_id);
        execute_can_burst_ctx(tx_can_id, tx_steps, tx_delay_ms, ctx, depth + 1);
    } else if (!queue_entity_command(step.entity_id, step.command)) {
        ESP_LOGW(TAG, "Entity '%s' command '%s' not found for inline execution",
                 step.entity_id.c_str(), step.command.c_str());
    }
}

static __attribute__((noinline)) void execute_cycle_entity_step(const ActionStep& step,
                                                                const EvalContext& ctx, int depth) {
    CanEntity entity;
    if (!find_entity_in_catalog(step.entity_id, entity)) {
        ESP_LOGW(TAG, "CYCLE_ENTITY: Entity '%s' not found in catalog", step.entity_id.c_str());
        return;
    }

    PsramVector<std::string> states = step.cycle_states;
    if (states.empty()) {
        for (const auto& opt : entity.options) {
            if (!opt.label.empty()) states.push_back(opt.label);
        }
    }
    if (states.empty()) {
        ESP_LOGW(TAG, "CYCLE_ENTITY: Entity '%s' has no states to cycle", step.entity_id.c_str());
        return;
    }

    auto find_option_by_label = [&](const std::string& lbl) -> const EntityOption* {
        for (const auto& opt : entity.options) {
            if (strcasecmp(opt.label.c_str(), lbl.c_str()) == 0) {
                return &opt;
            }
        }
        return nullptr;
    };

    int cur_idx = -1;
    if (entity.state_can_id != 0 && !(is_ambient_entity_id(entity.id) && ambient_anim_is_active())) {
        uint8_t frame[8] = {0};
        uint8_t frame_dlc = 0;
        if (get_cached_can_frame(entity.state_can_id, frame, &frame_dlc)) {
            for (int idx = 0; idx < (int)states.size(); ++idx) {
                const EntityOption* opt = find_option_by_label(states[idx]);
                if (opt && opt->match_mask != 0 && is_match(frame, *opt, frame_dlc)) {
                    cur_idx = idx;
                    break;
                }
            }
        }
    }
    if (cur_idx < 0 && !entity.current_state.empty()) {
        for (int idx = 0; idx < (int)states.size(); ++idx) {
            if (strcasecmp(states[idx].c_str(), entity.current_state.c_str()) == 0) {
                cur_idx = idx;
                break;
            }
        }
    }

    std::string target_label;
    const int n = (int)states.size();
    if (cur_idx < 0) {
        if (step.cycle_fallback_state == "__none__") {
            ESP_LOGI(TAG, "CYCLE_ENTITY: '%s' current state unknown/outside sequence and fallback is none", step.entity_id.c_str());
            return;
        }
        if (step.cycle_fallback_state.empty() || step.cycle_fallback_state == "__first__") {
            target_label = states[0];
        } else {
            target_label = step.cycle_fallback_state;
        }
        if (step.ping_pong_dir) {
            step.ping_pong_dir->store(1);
        }
    } else if (n == 1) {
        target_label = states[0];
    } else if (step.cycle_direction == "ping_pong") {
        int dir = step.ping_pong_dir ? step.ping_pong_dir->load() : 1;
        if (cur_idx == 0) dir = 1;
        else if (cur_idx >= n - 1) dir = -1;
        int next_idx = cur_idx + dir;
        if (next_idx < 0) next_idx = 0;
        if (next_idx >= n) next_idx = n - 1;
        if (step.ping_pong_dir) {
            if (dir > 0 && next_idx >= n - 1) step.ping_pong_dir->store(-1);
            else if (dir < 0 && next_idx <= 0) step.ping_pong_dir->store(1);
            else step.ping_pong_dir->store(dir);
        }
        target_label = states[next_idx];
    } else {
        const bool is_rev = (step.cycle_direction == "reverse");
        int next_idx = is_rev ? (cur_idx - 1) : (cur_idx + 1);
        if (next_idx >= n) next_idx = step.cycle_wrap ? 0 : (n - 1);
        if (next_idx < 0) next_idx = step.cycle_wrap ? (n - 1) : 0;
        target_label = states[next_idx];
    }

    const EntityOption* target_opt = find_option_by_label(target_label);
    std::string resolved_label = target_label;
    if (target_opt) {
        if (is_ambient_entity_id(entity.id)) {
            ambient_anim_stop();
        }
        uint32_t tx_can_id = entity.action_can_id ? entity.action_can_id : entity.state_can_id;
        mitm_arm_entity(entity.id);
        execute_can_burst_ctx(tx_can_id, catalog_steps_to_action_steps(target_opt->steps), entity.delay_ms, ctx, depth + 1);
        resolved_label = target_opt->label;
    } else if (is_ambient_entity_id(entity.id) && ambient_anim_start_by_name(target_label)) {
        resolved_label = ambient_anim_get_effect_name();
        mitm_arm_entity(entity.id);
    } else {
        ESP_LOGW(TAG, "CYCLE_ENTITY: Target state '%s' not found in entity '%s'", target_label.c_str(), step.entity_id.c_str());
        return;
    }

    // Sync live entity state cache and broadcast outside g_catalog_mutex
    {
        std::lock_guard<std::mutex> lock(g_catalog_mutex);
        for (auto& cat_ent : global_catalog) {
            if (cat_ent.id == entity.id) {
                cat_ent.current_state = resolved_label;
                break;
            }
        }
    }
    std::string mqtt_payload = resolved_label;
    if (entity.ha_domain == "switch") {
        std::string l_lower = resolved_label;
        std::transform(l_lower.begin(), l_lower.end(), l_lower.begin(), ::tolower);
        if (l_lower.find("off") != std::string::npos || l_lower.find("disable") != std::string::npos || l_lower.find("inactive") != std::string::npos) {
            mqtt_payload = "OFF";
        } else {
            mqtt_payload = "ON";
        }
    }
    mqtt_mgr_publish_entity_state(entity.id, mqtt_payload);
    broadcast_ws_state(entity.id, resolved_label);

    if (step.cycle_show_popup) {
        std::string ent_name = !entity.ha_name.empty() ? entity.ha_name : step.entity_id;
        std::string popup_txt;
        if (!step.cycle_popup_prefix.empty()) {
            const std::string& tmpl = step.cycle_popup_prefix;
            if (tmpl.find("{state}") != std::string::npos || tmpl.find("{entity}") != std::string::npos) {
                popup_txt = tmpl;
                size_t pos = 0;
                while ((pos = popup_txt.find("{state}", pos)) != std::string::npos) {
                    popup_txt.replace(pos, 7, resolved_label);
                    pos += resolved_label.length();
                }
                pos = 0;
                while ((pos = popup_txt.find("{entity}", pos)) != std::string::npos) {
                    popup_txt.replace(pos, 8, ent_name);
                    pos += ent_name.length();
                }
            } else {
                popup_txt = tmpl + resolved_label;
            }
        } else {
            popup_txt = ent_name + ": " + resolved_label;
        }

        if (step.popup_level == "warning") {
            track_popup_show_warning(popup_txt.c_str());
        } else if (step.popup_level == "error") {
            track_popup_show_error(popup_txt.c_str());
        } else {
            track_popup_show_info(popup_txt.c_str());
        }
    }
}

static void execute_can_burst_ctx(uint32_t can_id, const PsramVector<ActionStep>& steps,
                                  uint32_t delay_ms, const EvalContext& ctx, int depth) {
    if (depth > MAX_BURST_RECURSION_DEPTH) {
        ESP_LOGW(TAG, "execute_can_burst: max recursion depth (%d) exceeded, aborting nested steps",
                 MAX_BURST_RECURSION_DEPTH);
        return;
    }

    twai_message_t tx_msg = {};
    tx_msg.extd = 0;
    tx_msg.data_length_code = 8;

    for (const auto& step : steps) {
        if (step.type == ActionType::DELAY) {
            vTaskDelay(pdMS_TO_TICKS(step.delay_ms));
            continue;
        }

        if (step.type == ActionType::ENTITY_COMMAND) {
            execute_entity_command_step(step, ctx, depth);
            continue;
        }

        if (step.type == ActionType::TRACK_POPUP) {
            mitm_arm_entity("cluster_track_popup_message");
            const std::string& txt = !step.popup_text.empty() ? step.popup_text : step.popup_message;
            if (!txt.empty()) {
                if (step.popup_level == "warning") {
                    track_popup_show_warning(txt.c_str());
                } else if (step.popup_level == "error" || step.popup_level == "critical") {
                    track_popup_show_error(txt.c_str());
                } else {
                    track_popup_show_info(txt.c_str());
                }
            }
            continue;
        }


        if (step.type == ActionType::PRECONDITION) {
            mitm_arm_entity("battery_preconditioning");
            precondition_execute_action(step.precon_mode.c_str(), step.precon_action.c_str());
            continue;
        }

        if (step.type == ActionType::CLIMATE_TARGET) {
            float temp_c = step.target_temp_c > 0 ? step.target_temp_c : 22.0f;
            uint32_t dur_sec = step.duration_minutes > 0 ? step.duration_minutes * 60 : 900;
            remote_climate_start(temp_c, step.defrost, dur_sec);
            continue;
        }

        if (step.type == ActionType::HUD_NAV) {
            if (step.nav_action == "clear") {
                hud_nav_clear();
            } else {
                mitm_arm_entity("hud_turn_by_turn_maneuver");
                hud_nav_instruction_t instr = {};
                instr.icon = (hud_maneuver_icon_t)step.nav_icon;
                instr.direction_deg = step.nav_direction_deg;
                instr.distance_meters = step.nav_distance_meters;
                instr.bar_graph = step.nav_bars;
                instr.speed_limit_kph = step.nav_speed_limit;
                instr.speed_camera_alert = step.nav_camera_alert;
                if (!step.nav_street.empty()) {
                    instr.street_name = step.nav_street.c_str();
                }
                instr.has_lane_guidance = step.nav_has_lane_guidance;
                instr.num_lanes = step.nav_num_lanes;
                memcpy(instr.lane_directions, step.nav_lane_directions, 8);
                memcpy(instr.lane_recommended, step.nav_lane_recommended, 8);
                hud_nav_update(&instr);
            }
            continue;
        }

        if (step.type == ActionType::IF_THEN) {
            bool passed = true;
            for (const auto& c : step.if_conditions) {
                if (!evaluate_condition_ctx(c, ctx)) {
                    passed = false;
                    break;
                }
            }
            if (passed) {
                execute_can_burst_ctx(can_id, step.then_steps, delay_ms, ctx, depth + 1);
            } else {
                execute_can_burst_ctx(can_id, step.else_steps, delay_ms, ctx, depth + 1);
            }
            continue;
        }

        if (step.type == ActionType::CHOOSE) {
            bool matched = false;
            const size_t total_choices = step.choices.size();
            const size_t state_count = (step.cycle_ping_pong && total_choices >= 2) ? (total_choices / 2) : total_choices;

            for (size_t idx = 0; idx < state_count; ++idx) {
                const auto& choice = step.choices[idx];
                bool branch_passed = true;
                for (const auto& c : choice.conditions) {
                    if (!evaluate_condition_ctx(c, ctx)) {
                        branch_passed = false;
                        break;
                    }
                }
                if (branch_passed) {
                    if (step.cycle_ping_pong && step.ping_pong_dir && state_count >= 2 && (idx + state_count) < total_choices) {
                        int dir = step.ping_pong_dir->load();
                        if (idx == 0) {
                            dir = 1;
                        } else if (idx == state_count - 1) {
                            dir = -1;
                        }
                        const size_t exec_idx = (dir < 0) ? (idx + state_count) : idx;
                        // Pre-flip if this step lands on an endpoint so the next press bounces immediately
                        if (dir > 0 && (idx + 1) >= state_count - 1) {
                            step.ping_pong_dir->store(-1);
                        } else if (dir < 0 && idx <= 1) {
                            step.ping_pong_dir->store(1);
                        } else {
                            step.ping_pong_dir->store(dir);
                        }
                        execute_can_burst_ctx(can_id, step.choices[exec_idx].sequence, delay_ms, ctx, depth + 1);
                    } else {
                        execute_can_burst_ctx(can_id, choice.sequence, delay_ms, ctx, depth + 1);
                    }
                    matched = true;
                    break;
                }
            }
            if (!matched && !step.default_steps.empty()) {
                if (step.cycle_ping_pong && step.ping_pong_dir) {
                    step.ping_pong_dir->store(1);
                }
                execute_can_burst_ctx(can_id, step.default_steps, delay_ms, ctx, depth + 1);
            }
            continue;
        }

        if (step.type == ActionType::CYCLE_ENTITY) {
            execute_cycle_entity_step(step, ctx, depth);
            continue;
        }

        if (step.type == ActionType::REPEAT_UNTIL || step.type == ActionType::WAIT_FOR) {
            uint32_t start_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
            EvalContext wait_ctx = ctx;
            wait_ctx.wait_for_start_ms = start_ms;
            uint32_t effective_timeout_ms = step.timeout_ms > 0 ? step.timeout_ms : 60000;
            uint32_t interval = step.interval_ms > 0 ? step.interval_ms : 50;
            bool condition_met = false;
            while (!condition_met) {
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                if ((now_ms - start_ms) >= effective_timeout_ms) {
                    ESP_LOGW(TAG, "Timeout waiting for condition in %s (%lu ms elapsed)", 
                             step.type == ActionType::WAIT_FOR ? "WAIT_FOR" : "REPEAT_UNTIL",
                             (unsigned long)(now_ms - start_ms));
                    break;
                }
                if (step.type == ActionType::REPEAT_UNTIL && !step.sequence.empty()) {
                    execute_can_burst_ctx(can_id, step.sequence, delay_ms, ctx, depth + 1);
                }
                if (evaluate_condition_ctx(step.condition, wait_ctx)) {
                    condition_met = true;
                    break;
                }
                vTaskDelay(pdMS_TO_TICKS(interval));
            }
            if (step.type == ActionType::WAIT_FOR && !condition_met) {
                ESP_LOGW(TAG, "WAIT_FOR condition not met before timeout; aborting remainder of action sequence");
                break;
            }
            continue;
        }

        tx_msg.identifier = step.can_id ? step.can_id : can_id;
        if (tx_msg.identifier == 0 && step.mask == 0) {
            ESP_LOGW(TAG, "Refusing to transmit empty CAN frame (ID 0x000, mask 0x00)");
            continue;
        }
        memset(tx_msg.data, 0, 8);

        for (int i = 0; i < 8; i++) {
            if (step.mask & (1 << i)) {
                tx_msg.data[i] = step.payload[i];
            }
        }

        if (tx_msg.identifier == AMBIENT_CAN_ID_DASH && ambient_anim_is_active()) {
            const bool is_brightness_ctrl = (tx_msg.data[0] == 0x00 && tx_msg.data[1] == 0x02 && tx_msg.data[2] == 0x08);
            const bool is_brightness_off = is_brightness_ctrl && (tx_msg.data[3] == 0xA0 && tx_msg.data[4] == 0x00);
            if (!is_brightness_ctrl || is_brightness_off) {
                ambient_anim_stop();
            }
        }

        can_bus_t target_bus = (step.bus == 1) ? CAN_BUS_1 : CAN_BUS_0;
        uint32_t frame_delay_ms = (step.delay_ms > 0) ? step.delay_ms : delay_ms;
        mitm_arm_can_id(tx_msg.identifier);
        for (int r = 0; r < step.repeat; r++) {
            twai_message_t msg_to_send = tx_msg;
            fwd_result_t fwd_res = precondition_fwd_hook(&msg_to_send, target_bus);
            if (fwd_res == FWD_BLOCK) {
                continue;
            }

            fwd_res = hud_nav_fwd(&msg_to_send, target_bus);
            if (fwd_res == FWD_BLOCK) {
                continue;
            }
            esp_err_t tx_err = can_send(target_bus, &msg_to_send, pdMS_TO_TICKS(10));
            if (tx_err == ESP_OK) {
                board_led_can_activity();
                if (frame_delay_ms > 0) {
                    vTaskDelay(pdMS_TO_TICKS(frame_delay_ms));
                }
            } else if (tx_err == ESP_ERR_INVALID_STATE) {
                ESP_LOGW(TAG, "CAN TX suppressed/unavailable for ID 0x%03lX (bus %d); aborting remaining %d repeats",
                         (unsigned long)msg_to_send.identifier, (int)target_bus, step.repeat - r - 1);
                break;
            } else {
                ESP_LOGW(TAG, "CAN TX failed or queue full for ID 0x%03lX (%s)",
                         (unsigned long)msg_to_send.identifier, esp_err_to_name(tx_err));
                vTaskDelay(pdMS_TO_TICKS(frame_delay_ms > 0 ? frame_delay_ms : 2));
            }
        }
    }
}

void execute_can_burst(uint32_t can_id, const PsramVector<ActionStep>& steps, uint32_t delay_ms) {
    execute_can_burst_ctx(can_id, steps, delay_ms, EvalContext{}, 0);
}

static bool has_word_ci(const std::string& haystack_lower, const char* needle_lower) {
    if (!needle_lower || !*needle_lower) return false;
    const size_t nlen = strlen(needle_lower);
    size_t pos = 0;
    while ((pos = haystack_lower.find(needle_lower, pos)) != std::string::npos) {
        bool left_ok = (pos == 0) || !std::isalnum((unsigned char)haystack_lower[pos - 1]);
        bool right_ok = (pos + nlen >= haystack_lower.length()) ||
                        !std::isalnum((unsigned char)haystack_lower[pos + nlen]);
        if (left_ok && right_ok) {
            return true;
        }
        pos += 1;
    }
    return false;
}

static bool is_off_label_ci(const std::string& lower) {
    return has_word_ci(lower, "off") ||
           has_word_ci(lower, "inactive") ||
           has_word_ci(lower, "disable") ||
           has_word_ci(lower, "disabled") ||
           has_word_ci(lower, "shut") ||
           has_word_ci(lower, "stop") ||
           has_word_ci(lower, "cancel");
}

static bool is_on_label_ci(const std::string& lower) {
    if (is_off_label_ci(lower)) return false;
    return has_word_ci(lower, "on") ||
           has_word_ci(lower, "active") ||
           has_word_ci(lower, "enable") ||
           has_word_ci(lower, "enabled") ||
           has_word_ci(lower, "start");
}

bool queue_entity_command(const std::string& entity_id, const std::string& command_label) {
    // Check if entity_id matches an active automation rule (release g_automations_mutex before MQTT/WS calls)
    {
        std::string matched_rule_id, matched_rule_name, matched_state;
        bool matched_rule = false;
        bool trigger_manual = false;
        CanBurstCmd* pending_manual_cmd = nullptr;
        {
            std::lock_guard<std::mutex> lock(g_automations_mutex);
            for (auto& rule : global_automations) {
                if (rule.id == entity_id) {
                    matched_rule = true;
                    matched_rule_id = rule.id;
                    matched_rule_name = rule.name;
                    std::string cmd_lower = command_label;
                    std::transform(cmd_lower.begin(), cmd_lower.end(), cmd_lower.begin(), ::tolower);
                    if (cmd_lower == "off" || cmd_lower == "0" || cmd_lower == "false" || cmd_lower == "disable") {
                        rule.enabled = false;
                        matched_state = "OFF";
                    } else if (cmd_lower == "on" || cmd_lower == "1" || cmd_lower == "true" || cmd_lower == "enable") {
                        rule.enabled = true;
                        matched_state = "ON";
                    } else {
                        trigger_manual = true;
                        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                        rule.last_exec_time_ms = now_ms;
                        if (rule.is_running && rule.is_running->load()) {
                            ESP_LOGW(TAG, "Rule '%s' is already executing; skipping manual trigger", rule.name.c_str());
                        } else {
                            pending_manual_cmd = prepare_action_burst(0, 20, rule.actions, "manual_ha", rule.is_running);
                        }
                    }
                    break;
                }
            }
        }
        if (matched_rule) {
            if (trigger_manual) {
                bool manual_ok = pending_manual_cmd ? submit_action_burst(pending_manual_cmd, pdMS_TO_TICKS(10)) : false;
                ESP_LOGI(TAG, "Triggering automation rule '%s' manually via command '%s'", matched_rule_id.c_str(), command_label.c_str());
                broadcast_ws_automation_event(matched_rule_id, matched_rule_name);
                return manual_ok;
            }
            mqtt_mgr_publish_entity_state(matched_rule_id, matched_state);
            broadcast_ws_state(matched_rule_id, matched_state);
            ESP_LOGI(TAG, "Automation rule '%s' %s via entity command", matched_rule_id.c_str(), matched_state == "ON" ? "enabled" : "disabled");
            return true;
        }
    }

    if (entity_id == "battery_preconditioning" || entity_id == "precondition") {
        std::string mode = "persistent";
        std::string act = "start";
        if (!command_label.empty() && command_label[0] == '{') {
            cJSON* root = cJSON_Parse(command_label.c_str());
            if (root) {
                cJSON* m = cJSON_GetObjectItem(root, "mode");
                if (m && cJSON_IsString(m)) mode = m->valuestring;
                cJSON* a = cJSON_GetObjectItem(root, "action");
                if (a && cJSON_IsString(a)) act = a->valuestring;
                cJSON_Delete(root);
            }
        } else if (!command_label.empty()) {
            std::string c_lower = command_label;
            std::transform(c_lower.begin(), c_lower.end(), c_lower.begin(), ::tolower);
            if (c_lower.find("stop") != std::string::npos || c_lower.find("cancel") != std::string::npos || c_lower.find("off") != std::string::npos) {
                act = "stop";
                mode = "cancel";
            } else if (c_lower.find("continuous") != std::string::npos) {
                mode = "continuous";
            } else if (c_lower.find("once") != std::string::npos || c_lower.find("single") != std::string::npos) {
                mode = "once";
            } else {
                mode = "persistent";
            }
        }
        mitm_arm_entity("battery_preconditioning");
        precondition_execute_action(mode.c_str(), act.c_str());
        return true;
    }

    if (entity_id == "remote_climate" || entity_id == "remote_climate_tmu" || entity_id == "remote_climate_start_smart") {
        float temp_c = 22.0f;
        bool defrost = false;
        uint32_t duration_sec = 900;
        bool is_start = true;

        if (!command_label.empty() && command_label[0] == '{') {
            cJSON* root = cJSON_Parse(command_label.c_str());
            if (root) {
                cJSON* act = cJSON_GetObjectItem(root, "action");
                if (act && cJSON_IsString(act)) {
                    std::string a = act->valuestring;
                    std::transform(a.begin(), a.end(), a.begin(), ::tolower);
                    if (a == "stop" || a == "off") is_start = false;
                }
                cJSON* t = cJSON_GetObjectItem(root, "temp");
                if (!t) t = cJSON_GetObjectItem(root, "temperature");
                if (t && cJSON_IsNumber(t)) temp_c = (float)t->valuedouble;

                cJSON* d = cJSON_GetObjectItem(root, "defrost");
                if (d && cJSON_IsBool(d)) defrost = cJSON_IsTrue(d);

                cJSON* dur = cJSON_GetObjectItem(root, "duration");
                if (dur && cJSON_IsNumber(dur)) duration_sec = (uint32_t)dur->valueint;

                cJSON_Delete(root);
            }
        } else {
            std::string c_lower = command_label;
            std::transform(c_lower.begin(), c_lower.end(), c_lower.begin(), ::tolower);
            if (c_lower == "off" || c_lower == "0" || c_lower == "stop" || c_lower == "inactive" || c_lower == "disable" || c_lower.find("off") != std::string::npos) {
                is_start = false;
            } else if (c_lower == "toggle") {
                is_start = !remote_climate_is_active();
            }
        }

        if (is_start) {
            remote_climate_start(temp_c, defrost, duration_sec);
        } else {
            remote_climate_stop();
        }
        return true;
    }

    const bool is_ambient_color_cmd = is_ambient_entity_id(entity_id);
    if (is_ambient_color_cmd) {
        std::string cmd_lower = command_label;
        std::transform(cmd_lower.begin(), cmd_lower.end(), cmd_lower.begin(), ::tolower);

        // 1. Check if an animated effect is requested
        if (ambient_anim_start_by_name(cmd_lower)) {
            std::string new_state = ambient_anim_get_effect_name();
            {
                std::lock_guard<std::mutex> lock(g_catalog_mutex);
                for (auto& cat_ent : global_catalog) {
                    if (cat_ent.id == entity_id || cat_ent.id == "ambient_light_colors") {
                        cat_ent.current_state = new_state;
                    }
                }
            }
            mqtt_mgr_publish_entity_state(entity_id, new_state);
            broadcast_ws_state(entity_id, new_state);
            if (entity_id != "ambient_light_colors") {
                mqtt_mgr_publish_entity_state("ambient_light_colors", new_state);
                broadcast_ws_state("ambient_light_colors", new_state);
            }
            return true;
        }

        const bool is_off_req = (cmd_lower == "off" || cmd_lower == "mood light off" ||
                                 cmd_lower == "0" || cmd_lower == "false" || cmd_lower == "disable");
        const bool is_json_req = (!command_label.empty() && command_label[0] == '{');

        // 2. Explicit Off or raw RGB / palette-index JSON payloads (static catalog labels fall through below)
        if (is_off_req || is_json_req) {
            std::string new_state = command_label;
            uint8_t payload_4ad[4] = {0};
            bool has_4ad = false;

            auto resolve_catalog_color_label = [&](uint8_t b0, uint8_t b1, uint8_t b2, uint8_t b3) -> std::string {
                std::lock_guard<std::mutex> lock(g_catalog_mutex);
                for (const auto& cat_ent : global_catalog) {
                    if (cat_ent.id == "ambient_light_colors") {
                        for (const auto& opt : cat_ent.options) {
                            if (!opt.steps.empty()) {
                                const uint8_t* p = opt.steps[0].payload;
                                if (p[0] == b0 && p[1] == b1 && p[2] == b2 && (p[3] & 0xBF) == (b3 & 0xBF)) {
                                    return opt.label;
                                }
                            }
                        }
                        break;
                    }
                }
                return "";
            };

            if (is_off_req) {
                new_state = "Mood Light Off";
                has_4ad = true;
            } else {
                cJSON* root = cJSON_Parse(command_label.c_str());
                if (root) {
                    cJSON* idx_it = cJSON_GetObjectItem(root, "color_index");
                    if (!idx_it) idx_it = cJSON_GetObjectItem(root, "index");
                    if (idx_it && cJSON_IsNumber(idx_it) && idx_it->valueint >= 1 && idx_it->valueint <= 64) {
                        ambient_anim_get_palette_color((uint8_t)idx_it->valueint, payload_4ad);
                        std::string resolved = resolve_catalog_color_label(payload_4ad[0], payload_4ad[1], payload_4ad[2], payload_4ad[3]);
                        if (!resolved.empty()) new_state = resolved;
                        has_4ad = true;
                    } else {
                        cJSON* r_it = cJSON_GetObjectItem(root, "r");
                        if (!r_it) r_it = cJSON_GetObjectItem(root, "red");
                        cJSON* g_it = cJSON_GetObjectItem(root, "green");
                        if (!g_it) g_it = cJSON_GetObjectItem(root, "g");
                        cJSON* b_it = cJSON_GetObjectItem(root, "blue");
                        if (!b_it) b_it = cJSON_GetObjectItem(root, "b");

                        if (cJSON_IsNumber(r_it) && cJSON_IsNumber(g_it) && cJSON_IsNumber(b_it)) {
                            uint8_t r = (uint8_t)std::max(0, std::min(255, r_it->valueint));
                            uint8_t g = (uint8_t)std::max(0, std::min(255, g_it->valueint));
                            uint8_t b = (uint8_t)std::max(0, std::min(255, b_it->valueint));
                            uint8_t pal_idx = ambient_anim_find_closest_palette_index(r, g, b);
                            ambient_anim_get_palette_color(pal_idx, payload_4ad);
                            std::string resolved = resolve_catalog_color_label(payload_4ad[0], payload_4ad[1], payload_4ad[2], payload_4ad[3]);
                            if (!resolved.empty()) new_state = resolved;
                            has_4ad = true;
                        }
                    }
                    cJSON_Delete(root);
                }
            }

            if (!has_4ad) {
                return false;
            }

            ambient_anim_stop();
            PsramVector<ActionStep> amb_steps;
            ActionStep s1 = {};
            s1.type = ActionType::TRANSMIT_FRAME;
            s1.can_id = AMBIENT_CAN_ID_DASH;
            s1.bus = 0;
            s1.mask = 0xFF;
            s1.repeat = 3;
            s1.delay_ms = 25;
            if (!is_off_req) {
                s1.payload[0] = payload_4ad[0];
                s1.payload[1] = payload_4ad[1];
                s1.payload[2] = payload_4ad[2];
                s1.payload[3] = payload_4ad[3];
            }
            amb_steps.push_back(s1);

            ActionStep s2 = {};
            s2.type = ActionType::TRANSMIT_FRAME;
            s2.can_id = AMBIENT_CAN_ID_DASH;
            s2.bus = 0;
            s2.mask = 0xFF;
            s2.repeat = 3;
            s2.delay_ms = 25;
            s2.payload[0] = 0x00;
            s2.payload[1] = 0x02;
            s2.payload[2] = 0x08;
            s2.payload[3] = 0x20;
            amb_steps.push_back(s2);

            bool ok = queue_action_steps(AMBIENT_CAN_ID_DASH, 25, amb_steps, "ambient_light");
            if (ok) {
                {
                    std::lock_guard<std::mutex> lock(g_catalog_mutex);
                    for (auto& cat_ent : global_catalog) {
                        if (cat_ent.id == entity_id || cat_ent.id == "ambient_light_colors") {
                            cat_ent.current_state = new_state;
                        }
                    }
                }
                mqtt_mgr_publish_entity_state(entity_id, new_state);
                broadcast_ws_state(entity_id, new_state);
                if (entity_id != "ambient_light_colors") {
                    mqtt_mgr_publish_entity_state("ambient_light_colors", new_state);
                    broadcast_ws_state("ambient_light_colors", new_state);
                }
            }
            return ok;
        }
    }

    const std::string lookup_entity_id = is_ambient_color_cmd ? "ambient_light_colors" : entity_id;
    CanEntity entity;
    if (!find_entity_in_catalog(lookup_entity_id, entity)) {
        ESP_LOGW(TAG, "Entity '%s' not found in catalog or automations", entity_id.c_str());
        return false;
    }

    std::string cmd_lower = command_label;
    std::transform(cmd_lower.begin(), cmd_lower.end(), cmd_lower.begin(), ::tolower);

    bool is_on_cmd = (cmd_lower == "on" || cmd_lower == "1" || cmd_lower == "true" || cmd_lower == "enable");
    bool is_off_cmd = (cmd_lower == "off" || cmd_lower == "0" || cmd_lower == "false" || cmd_lower == "disable");
    bool is_lock_cmd = (cmd_lower == "lock" || cmd_lower == "locked" || cmd_lower == "secure");
    bool is_unlock_cmd = (cmd_lower == "unlock" || cmd_lower == "unlocked");
    bool is_open_cmd = (cmd_lower == "open" || cmd_lower == "opened" || cmd_lower == "roll down" || cmd_lower == "down");
    bool is_close_cmd = (cmd_lower == "close" || cmd_lower == "closed" || cmd_lower == "roll up" || cmd_lower == "up");
    bool is_vent_cmd = (cmd_lower == "vent" || cmd_lower == "tilt" || cmd_lower == "crack");
    bool is_toggle = (cmd_lower == "toggle");

    const EntityOption* matched_opt = nullptr;

    if (is_toggle) {
        std::string cur_lower = entity.current_state;
        std::transform(cur_lower.begin(), cur_lower.end(), cur_lower.begin(), ::tolower);
        if (entity.ha_domain == "lock" || entity.id.find("lock") != std::string::npos) {
            bool currently_locked = (cur_lower.find("lock") != std::string::npos && cur_lower.find("unlock") == std::string::npos);
            if (currently_locked) is_unlock_cmd = true;
            else is_lock_cmd = true;
        } else if (entity.ha_domain == "cover" || entity.id.find("window") != std::string::npos || entity.id.find("tailgate") != std::string::npos) {
            bool currently_closed = (cur_lower.find("close") != std::string::npos);
            if (currently_closed) is_open_cmd = true;
            else is_close_cmd = true;
        } else {
            bool currently_on = is_on_label_ci(cur_lower);
            if (currently_on) is_off_cmd = true;
            else is_on_cmd = true;
        }
    }

    if (is_lock_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("unlock") == std::string::npos && opt_l.find("lock") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_unlock_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("unlock") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_open_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("close") == std::string::npos && (opt_l.find("open") != std::string::npos || opt_l.find("down") != std::string::npos)) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_close_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("close") != std::string::npos || opt_l.find("up") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_vent_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("vent") != std::string::npos || opt_l.find("tilt") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_on_cmd || is_off_cmd) {
        auto match_opt = [&](auto pred) -> const EntityOption* {
            for (const auto& opt : entity.options) {
                std::string opt_l = opt.label;
                std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
                if (pred(opt_l)) return &opt;
            }
            return nullptr;
        };
        if (is_on_cmd) {
            matched_opt = match_opt([](const std::string& l) { return is_on_label_ci(l); });
            if (!matched_opt) {
                matched_opt = match_opt([](const std::string& l) { return !is_off_label_ci(l); });
            }
            if (!matched_opt && !entity.options.empty()) {
                matched_opt = &entity.options[0];
            }
        } else {
            matched_opt = match_opt([](const std::string& l) { return is_off_label_ci(l); });
            if (!matched_opt) {
                matched_opt = match_opt([](const std::string& l) { return !is_on_label_ci(l); });
            }
            if (!matched_opt && entity.options.size() > 1) {
                matched_opt = &entity.options[1];
            }
        }
    } else {
        // Pass 1: Exact case-insensitive label match (or implicit single-option / HA 'press' activation)
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l == cmd_lower || ((command_label.empty() || cmd_lower == "press") && entity.options.size() == 1)) {
                matched_opt = &opt;
                break;
            }
        }
        // Pass 2: Option label contains requested command, or command starts with option label (longest opt_l wins to avoid 'level 1' shadowing 'level 10')
        if (!matched_opt && !cmd_lower.empty()) {
            size_t best_len = 0;
            for (const auto& opt : entity.options) {
                std::string opt_l = opt.label;
                std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
                if (opt_l.empty()) continue;
                bool opt_contains_cmd = (opt_l.find(cmd_lower) != std::string::npos);
                bool cmd_contains_opt = (cmd_lower.find(opt_l) != std::string::npos);
                if (opt_contains_cmd || cmd_contains_opt) {
                    if (!matched_opt || opt_l.length() > best_len) {
                        matched_opt = &opt;
                        best_len = opt_l.length();
                    }
                }
            }
        }
    }

    if (!matched_opt && (command_label.empty() || cmd_lower == "press") && !entity.options.empty()) {
        matched_opt = &entity.options[0];
    }

    if (!matched_opt) {
        ESP_LOGW(TAG, "Option '%s' not found for entity '%s'", command_label.c_str(), entity_id.c_str());
        return false;
    }

    if (is_ambient_color_cmd) {
        ambient_anim_stop();
    }

    uint32_t cid = entity.action_can_id ? entity.action_can_id : entity.state_can_id;
    mitm_arm_entity(entity.id);
    bool ok = queue_action_steps(cid, entity.delay_ms, catalog_steps_to_action_steps(matched_opt->steps), entity.id);
    if (ok) {
        {
            std::lock_guard<std::mutex> lock(g_catalog_mutex);
            for (auto& cat_ent : global_catalog) {
                if (cat_ent.id == entity.id) {
                    cat_ent.current_state = matched_opt->label;
                    break;
                }
            }
        }
        std::string payload = matched_opt->label;
        if (entity.ha_domain == "switch") {
            std::string l_lower = matched_opt->label;
            std::transform(l_lower.begin(), l_lower.end(), l_lower.begin(), ::tolower);
            if (is_off_label_ci(l_lower)) {
                payload = "OFF";
            } else {
                payload = "ON";
            }
        }
        mqtt_mgr_publish_entity_state(entity.id, payload);
        broadcast_ws_state(entity.id, matched_opt->label);
    }
    return ok;
}

static constexpr uint32_t ASYNC_DURATION_THRESHOLD_MS = 500;

static uint32_t estimate_steps_duration_ms(const PsramVector<ActionStep>& steps,
                                           uint32_t default_delay_ms,
                                           bool* force_async,
                                           int depth = 0) {
    if (depth > MAX_BURST_RECURSION_DEPTH) {
        if (force_async) *force_async = true;
        return ASYNC_DURATION_THRESHOLD_MS;
    }
    uint64_t total_ms = 0;
    for (const auto& step : steps) {
        if (step.type == ActionType::REPEAT_UNTIL || step.type == ActionType::WAIT_FOR) {
            if (force_async) *force_async = true;
            return ASYNC_DURATION_THRESHOLD_MS;
        }
        if (step.type == ActionType::DELAY) {
            total_ms += step.delay_ms;
        } else if (step.type == ActionType::TRANSMIT_FRAME) {
            uint32_t frame_delay_ms = (step.delay_ms > 0) ? step.delay_ms : default_delay_ms;
            total_ms += static_cast<uint64_t>(step.repeat) * static_cast<uint64_t>(frame_delay_ms);
        } else if (step.type == ActionType::IF_THEN) {
            bool branch_async = false;
            uint32_t then_ms = estimate_steps_duration_ms(step.then_steps, default_delay_ms, &branch_async, depth + 1);
            if (branch_async) {
                if (force_async) *force_async = true;
                return ASYNC_DURATION_THRESHOLD_MS;
            }
            uint32_t else_ms = estimate_steps_duration_ms(step.else_steps, default_delay_ms, &branch_async, depth + 1);
            if (branch_async) {
                if (force_async) *force_async = true;
                return ASYNC_DURATION_THRESHOLD_MS;
            }
            total_ms += (then_ms > else_ms) ? then_ms : else_ms;
        } else if (step.type == ActionType::CHOOSE) {
            uint32_t max_branch_ms = 0;
            bool branch_async = false;
            for (const auto& choice : step.choices) {
                uint32_t br_ms = estimate_steps_duration_ms(choice.sequence, default_delay_ms, &branch_async, depth + 1);
                if (branch_async) {
                    if (force_async) *force_async = true;
                    return ASYNC_DURATION_THRESHOLD_MS;
                }
                if (br_ms > max_branch_ms) max_branch_ms = br_ms;
            }
            uint32_t def_ms = estimate_steps_duration_ms(step.default_steps, default_delay_ms, &branch_async, depth + 1);
            if (branch_async) {
                if (force_async) *force_async = true;
                return ASYNC_DURATION_THRESHOLD_MS;
            }
            if (def_ms > max_branch_ms) max_branch_ms = def_ms;
            total_ms += max_branch_ms;
        }
        if (total_ms >= ASYNC_DURATION_THRESHOLD_MS) {
            return ASYNC_DURATION_THRESHOLD_MS;
        }
    }
    return static_cast<uint32_t>(total_ms);
}

static bool steps_contain_async(const PsramVector<ActionStep>& steps, uint32_t default_delay_ms = 20) {
    bool force_async = false;
    uint32_t est_ms = estimate_steps_duration_ms(steps, default_delay_ms, &force_async, 0);
    return force_async || (est_ms >= ASYNC_DURATION_THRESHOLD_MS);
}

static std::atomic<int> s_active_async_tasks{0};
static const int MAX_CONCURRENT_ASYNC_TASKS = 2;

static void execute_can_burst_async_task(void* arg) {
    CanBurstCmd* cmd = (CanBurstCmd*)arg;
    if (cmd) {
        struct AsyncCleanup {
            CanBurstCmd* c;
            AsyncCleanup(CanBurstCmd* cmd_ptr) : c(cmd_ptr) {}
            ~AsyncCleanup() {
                if (c) {
                    if (c->rule_is_running) {
                        c->rule_is_running->store(false, std::memory_order_release);
                    }
                    delete c;
                }
                s_active_async_tasks.fetch_sub(1);
            }
        } cleanup(cmd);

        EvalContext ctx;
        ctx.firing_trigger_id = cmd->trigger_id.c_str();
        if (!cmd->inline_steps.empty()) {
            execute_can_burst_ctx(cmd->can_id, cmd->inline_steps, cmd->delay_ms, ctx, 0);
        }
    }
    vTaskDelete(NULL);
}

static CanBurstCmd* prepare_action_burst(uint32_t can_id, uint32_t delay_ms,
                                         const PsramVector<ActionStep>& steps,
                                         const std::string& trigger_id,
                                         std::shared_ptr<std::atomic<bool>> rule_is_running) {
    if (!tx_command_queue) {
        if (rule_is_running) rule_is_running->store(false, std::memory_order_release);
        return nullptr;
    }
    CanBurstCmd* cmd = new (std::nothrow) CanBurstCmd();
    if (!cmd) {
        return nullptr;
    }
    if (rule_is_running && rule_is_running->exchange(true, std::memory_order_acq_rel)) {
        delete cmd;
        return nullptr;
    }
    cmd->can_id = can_id;
    cmd->delay_ms = delay_ms;
    cmd->trigger_id = trigger_id;
    cmd->inline_steps = steps;
    cmd->async = steps_contain_async(steps, delay_ms);
    cmd->rule_is_running = rule_is_running;
    return cmd;
}

static bool submit_action_burst(CanBurstCmd* cmd, TickType_t wait_ticks) {
    if (!cmd) return false;
    if (!tx_command_queue || xQueueSend(tx_command_queue, &cmd, wait_ticks) != pdTRUE) {
        if (cmd->rule_is_running) cmd->rule_is_running->store(false, std::memory_order_release);
        delete cmd;
        return false;
    }
    return true;
}

bool queue_action_steps(uint32_t can_id, uint32_t delay_ms, const PsramVector<ActionStep>& steps, const std::string& trigger_id, std::shared_ptr<std::atomic<bool>> rule_is_running) {
    CanBurstCmd* cmd = prepare_action_burst(can_id, delay_ms, steps, trigger_id, rule_is_running);
    if (!cmd) {
        return false;
    }
    return submit_action_burst(cmd, pdMS_TO_TICKS(10));
}

static void emit_live_entity_state_split(const char* entity_id, const char* mqtt_state, const char* ws_state) {
    if (!entity_id || !mqtt_state || !ws_state) return;
    {
        std::lock_guard<std::mutex> lock(g_catalog_mutex);
        for (auto& entity : global_catalog) {
            if (entity.id == entity_id) {
                entity.current_state = ws_state;
                break;
            }
        }
    }
    mqtt_mgr_publish_entity_state(entity_id, mqtt_state);
    broadcast_ws_state(entity_id, ws_state);
}

static void emit_live_entity_state(const char* entity_id, const char* state) {
    emit_live_entity_state_split(entity_id, state, state);
}

void decode_can_frame_entities(uint32_t identifier, const uint8_t* data, uint8_t data_length_code) {
    if (!data || data_length_code == 0) return;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    // 3. Match against catalog entities for state updates (O(1) indexed lookup)
    // Never call MQTT enqueue or WebSocket broadcast while holding g_catalog_mutex (avoids AB-BA lock inversion).
    struct PendingEntityUpdate {
        std::string id;
        std::string mqtt_payload;
        std::string ws_label;
    };
    std::vector<PendingEntityUpdate> pending_updates;
    {
        std::lock_guard<std::mutex> lock(g_catalog_mutex);
        auto cat_it = catalog_by_can_id.find(identifier);
        if (cat_it != catalog_by_can_id.end()) {
            for (auto* entity_ptr : cat_it->second) {
                if (!entity_ptr) continue;
                auto& entity = *entity_ptr;
                if (is_ambient_entity_id(entity.id) && ambient_anim_is_active()) {
                    continue;
                }

                for (const auto& opt : entity.options) {
                    if (is_match(data, opt, data_length_code)) {
                        if (entity.current_state != opt.label) {
                            entity.current_state = opt.label;
                            std::string payload = opt.label;
                            if (entity.ha_domain == "switch") {
                                std::string l_lower = opt.label;
                                std::transform(l_lower.begin(), l_lower.end(), l_lower.begin(), ::tolower);
                                if (l_lower.find("off") != std::string::npos || l_lower.find("disable") != std::string::npos || l_lower.find("inactive") != std::string::npos) {
                                    payload = "OFF";
                                } else {
                                    payload = "ON";
                                }
                            }
                            pending_updates.push_back({entity.id, std::move(payload), opt.label});
                        }
                        break;
                    }
                }
            }
        }
    }
    for (const auto& u : pending_updates) {
        ESP_LOGD(TAG, "State change: %s -> %s", u.id.c_str(), u.ws_label.c_str());
        mqtt_mgr_publish_entity_state(u.id, u.mqtt_payload);
        broadcast_ws_state(u.id, u.ws_label);
    }

    // 4. Real-time Live Cockpit Telemetry Decoders (continuous numeric formulas & non-catalog bitfields)

    // Road Speed (0x1AC Byte 0 = kph, or 0x0A2 Wheel Speed 16-bit LE * 0.03125, or 0x1A0 ESC Speed)
    if (identifier == 0x1AC && data_length_code >= 1) {
        uint8_t kph = data[0];
        static uint8_t s_last_kph = 255;
        static uint32_t s_last_spd_ms = 0;
        if (kph != s_last_kph && (now_ms - s_last_spd_ms >= 100)) {
            s_last_kph = kph;
            s_last_spd_ms = now_ms;
            char spd_buf[16];
            snprintf(spd_buf, sizeof(spd_buf), "%u km/h", kph);
            emit_live_entity_state("cluster_vehicle_speed", spd_buf);
        }
    } else if (identifier == 0x0A2 && data_length_code >= 2) {
        uint16_t rawW1 = data[0] | (data[1] << 8);
        uint8_t kph = (uint8_t)(rawW1 * 0.03125f);
        static uint8_t s_last_wheel_kph = 255;
        static uint32_t s_last_wheel_spd_ms = 0;
        if (kph != s_last_wheel_kph && (now_ms - s_last_wheel_spd_ms >= 100)) {
            s_last_wheel_kph = kph;
            s_last_wheel_spd_ms = now_ms;
            char spd_buf[16];
            snprintf(spd_buf, sizeof(spd_buf), "%u km/h", kph);
            emit_live_entity_state("cluster_vehicle_speed", spd_buf);
        }
    } else if (identifier == 0x1A0 && data_length_code >= 2) {
        uint16_t raw_esc = data[0] | (data[1] << 8);
        uint8_t kph = (uint8_t)(raw_esc * 0.03125f);
        static uint8_t s_last_esc_kph = 255;
        static uint32_t s_last_esc_spd_ms = 0;
        if (kph != s_last_esc_kph && (now_ms - s_last_esc_spd_ms >= 100)) {
            s_last_esc_kph = kph;
            s_last_esc_spd_ms = now_ms;
            char spd_buf[16];
            snprintf(spd_buf, sizeof(spd_buf), "%u km/h", kph);
            emit_live_entity_state("cluster_vehicle_speed", spd_buf);
        }
    }

    // Outdoor Temperature (Primary: 0x31C D1 = raw*0.5 - 41 C; Fallbacks: 0x227 CLU_OutTempF, 0x226 D4 CLU_OutTempC)
    if (identifier == 0x31C || identifier == 0x227 || identifier == 0x226) {
        static int s_last_temp_tenths = 9999;
        static uint32_t s_last_amb_ms = 0;
        static uint32_t s_last_31c_temp_ms = 0;
        float temp_c = 0.0f;
        bool valid = false;

        if (identifier == 0x31C && data_length_code >= 1) {
            uint8_t raw = data[0];
            if (raw >= 2 && raw <= 202) {
                temp_c = (raw * 0.5f) - 41.0f;
                s_last_31c_temp_ms = now_ms;
                valid = true;
            }
        } else if (s_last_31c_temp_ms == 0 || (now_ms - s_last_31c_temp_ms > 5000)) {
            if (identifier == 0x227 && data_length_code >= 8) {
                uint8_t raw_f = ((data[7] & 0x07) << 5) | ((data[6] >> 3) & 0x1F);
                if (raw_f > 0 && raw_f <= 180) {
                    temp_c = ((float)((int)raw_f - 40) - 32.0f) * (5.0f / 9.0f);
                    valid = true;
                }
            } else if (identifier == 0x226 && data_length_code >= 4) {
                uint8_t raw_c = data[3];
                if (raw_c > 0 && raw_c <= 100) {
                    temp_c = (float)((int)raw_c - 40);
                    valid = true;
                }
            }
        }

        if (valid) {
            int tenths = (int)std::lroundf(temp_c * 10.0f);
            if (tenths != s_last_temp_tenths && (now_ms - s_last_amb_ms >= 100)) {
                s_last_temp_tenths = tenths;
                s_last_amb_ms = now_ms;
                char temp_str[16];
                snprintf(temp_str, sizeof(temp_str), "%.1f °C", tenths / 10.0f);
                emit_live_entity_state("outdoor_temperature", temp_str);
            }
        }
    }

    // HV Traction Battery SOC (0x2FC Byte 7 = raw * 0.5 %)
    if (identifier == 0x2FC && data_length_code >= 8) {
        uint8_t raw = data[7];
        int soc = (int)(raw * 0.5f);
        static int s_last_soc = -1;
        static uint32_t s_last_soc_ms = 0;
        if (soc >= 0 && soc <= 100 && soc != s_last_soc && (now_ms - s_last_soc_ms >= 100)) {
            s_last_soc = soc;
            s_last_soc_ms = now_ms;
            char soc_str[16];
            snprintf(soc_str, sizeof(soc_str), "%d%%", soc);
            emit_live_entity_state("cond_hv_battery_soc", soc_str);
        }
    }

    // 12V Aux Battery Voltage (0x1CF Byte 5 = factor 0.1V)
    if (identifier == 0x1CF && data_length_code >= 6) {
        uint8_t vByte = data[5];
        float v = (float)(vByte * 0.1f);
        if (v >= 8.0f && v <= 16.5f) {
            static float s_last_aux_v = 0.0f;
            if (fabs(v - s_last_aux_v) >= 0.1f) {
                s_last_aux_v = v;
                vbat_sensor_set_from_can(v);
                char vbuf[16];
                snprintf(vbuf, sizeof(vbuf), "%.1f V", v);
                emit_live_entity_state("cond_aux_12v_battery", vbuf);
            }
        }
    }

    // Live EV Charging Power (0x30E: Byte 6 [D7] = unsigned integer in kW, 0-255 kW)
    if (identifier == 0x30E && data_length_code >= 7) {
        uint8_t kw = data[6];
        static int s_last_kw = -1;
        static uint32_t s_last_kw_ms = 0;
        if ((int)kw != s_last_kw && (now_ms - s_last_kw_ms >= 100)) {
            s_last_kw = (int)kw;
            s_last_kw_ms = now_ms;
            char kw_buf[16];
            snprintf(kw_buf, sizeof(kw_buf), "%u", kw);
            emit_live_entity_state("ev_charging_power", kw_buf);
        }
    }

    // AC Level 2 Remaining Charge Time (0x327: Bytes 0-1 LE minutes, 0xFFFF = inactive)
    if (identifier == 0x327 && data_length_code >= 2) {
        uint16_t rem = data[0] | (data[1] << 8);
        static int s_last_ac_rem = -1;
        static uint32_t s_last_ac_rem_ms = 0;
        int val = (rem == 0xFFFF) ? 0 : (int)rem;
        if (val != s_last_ac_rem && (now_ms - s_last_ac_rem_ms >= 100)) {
            s_last_ac_rem = val;
            s_last_ac_rem_ms = now_ms;
            char rem_buf[16];
            snprintf(rem_buf, sizeof(rem_buf), "%d", val);
            emit_live_entity_state("remaining_charge_time_ac", rem_buf);
        }
    }

    // DC Fast Charge Remaining Time (0x25C: Bytes 2-3 LE minutes, 0xFFFF = inactive)
    if (identifier == 0x25C && data_length_code >= 4) {
        uint16_t rem = data[2] | (data[3] << 8);
        static int s_last_dc_rem = -1;
        static uint32_t s_last_dc_rem_ms = 0;
        int val = (rem == 0xFFFF) ? 0 : (int)rem;
        if (val != s_last_dc_rem && (now_ms - s_last_dc_rem_ms >= 100)) {
            s_last_dc_rem = val;
            s_last_dc_rem_ms = now_ms;
            char rem_buf[16];
            snprintf(rem_buf, sizeof(rem_buf), "%d", val);
            emit_live_entity_state("remaining_charge_time_dc", rem_buf);
        }
    }

    // Level 1 120V Trickle Charge Remaining Time (0x328: Bytes 0-1 LE minutes, 0xFFFF = inactive)
    if (identifier == 0x328 && data_length_code >= 2) {
        uint16_t rem = data[0] | (data[1] << 8);
        static int s_last_120v_rem = -1;
        static uint32_t s_last_120v_rem_ms = 0;
        int val = (rem == 0xFFFF) ? 0 : (int)rem;
        if (val != s_last_120v_rem && (now_ms - s_last_120v_rem_ms >= 100)) {
            s_last_120v_rem = val;
            s_last_120v_rem_ms = now_ms;
            char rem_buf[16];
            snprintf(rem_buf, sizeof(rem_buf), "%d", val);
            emit_live_entity_state("remaining_charge_time_120v", rem_buf);
        }
    }

    // V2L Discharge Remaining Time (0x324: Bytes 6-7 LE minutes, 0xFFFF = inactive)
    if (identifier == 0x324 && data_length_code >= 8) {
        uint16_t rem = data[6] | (data[7] << 8);
        static int s_last_v2l_rem = -1;
        static uint32_t s_last_v2l_rem_ms = 0;
        int val = (rem == 0xFFFF) ? 0 : (int)rem;
        if (val != s_last_v2l_rem && (now_ms - s_last_v2l_rem_ms >= 100)) {
            s_last_v2l_rem = val;
            s_last_v2l_rem_ms = now_ms;
            char rem_buf[16];
            snprintf(rem_buf, sizeof(rem_buf), "%d", val);
            emit_live_entity_state("v2l_discharge_remaining_time", rem_buf);
        }
    }

    // Vehicle Odometer (0x227 Bytes 1-3 LE in 0.1 km units)
    if (identifier == 0x227 && data_length_code >= 4) {
        uint32_t raw_odo = data[1] | (data[2] << 8) | (data[3] << 16);
        if (raw_odo > 0) {
            uint32_t km = (uint32_t)(raw_odo * 0.1f);
            static uint32_t s_last_km = 0;
            static uint32_t s_last_odo_ms = 0;
            if (km != s_last_km && (now_ms - s_last_odo_ms >= 100)) {
                s_last_km = km;
                s_last_odo_ms = now_ms;
                char odo_buf[16];
                snprintf(odo_buf, sizeof(odo_buf), "%lu", (unsigned long)km);
                emit_live_entity_state("vehicle_odometer", odo_buf);
            }
        }
    }

    // Cabin Target Temperatures (0x380: D2/D3 catalog primary, D5/D6 display fallback)
    if (identifier == 0x380 && data_length_code >= 4) {
        int rawD = -1, rawP = -1;
        for (int idx : {1, 4, 3}) {
            if (data_length_code > idx && data[idx] >= 0x06 && data[idx] <= 0x1A) {
                rawD = data[idx];
                break;
            }
        }
        for (int idx : {2, 5, 6}) {
            if (data_length_code > idx && data[idx] >= 0x06 && data[idx] <= 0x1A) {
                rawP = data[idx];
                break;
            }
        }
        if (rawD >= 0) {
            int dF = 62 + (rawD - 0x06);
            int pF = (rawP >= 0) ? (62 + (rawP - 0x06)) : dF;
            static int s_last_dF = -1, s_last_pF = -1;
            static uint32_t s_last_cabin_temp_ms = 0;
            if ((dF != s_last_dF || pF != s_last_pF) && (now_ms - s_last_cabin_temp_ms >= 100)) {
                bool driver_changed = (dF != s_last_dF);
                bool passenger_changed = (pF != s_last_pF);
                s_last_dF = dF;
                s_last_pF = pF;
                s_last_cabin_temp_ms = now_ms;
                char temp_buf[16];
                if (driver_changed) {
                    snprintf(temp_buf, sizeof(temp_buf), "%d°F", dF);
                    emit_live_entity_state("climate_driver_temp", temp_buf);
                }
                if (passenger_changed) {
                    snprintf(temp_buf, sizeof(temp_buf), "%d°F", pF);
                    emit_live_entity_state("climate_passenger_temp", temp_buf);
                }
            }
        }
    }

    // HVAC Air Recirculation (0x31B Byte 4 [D5] Bit 6: mask 0x40)
    if (identifier == 0x31B && data_length_code >= 5) {
        int recirc_int = (data[4] & 0x40) ? 1 : 0;
        static int s_last_recirc = -1;
        if (recirc_int != s_last_recirc) {
            s_last_recirc = recirc_int;
            emit_live_entity_state("climate_recirc_on", recirc_int ? "ON" : "OFF");
        }
    }
}

void can_rx_task(void* arg) {
    twai_message_t rx_msg = {};
    ESP_LOGI(TAG, "CAN RX task running");

    esp_task_wdt_config_t twdt_cfg = {
        .timeout_ms = 5000,
        .idle_core_mask = (1 << 0),
        .trigger_panic = true
    };
    if (esp_task_wdt_reconfigure(&twdt_cfg) != ESP_OK) {
        esp_task_wdt_init(&twdt_cfg);
    }
    esp_task_wdt_add(NULL);

    int consecutive_rx_frames = 0;
    static uint32_t s_bus_off_or_recovering_start_ms = 0;
    static uint32_t s_last_can_frame_ms = 0;
    static bool s_can_led_idle_cleared = true;

    const bool use_dual_can = dual_can_is_available(CAN_BUS_0) || dual_can_is_available(CAN_BUS_1);
    bool prefer_bus1 = false;
    uint32_t last_dual_can_health_ms = 0;
    uint32_t last_twai_status_poll_ms = 0;
    uint32_t last_diag_snapshot_ms = 0;
    int64_t burst_start_us = esp_timer_get_time();

    // Index automation CAN IDs and rebuild cleanly whenever automations hot-reload
    uint32_t auto_gen = 0;
    PsramUnorderedSet<uint32_t> watched_auto_ids;
    auto refresh_watched_auto_ids = [&]() {
        std::lock_guard<std::mutex> lock(g_automations_mutex);
        watched_auto_ids.clear();
        for (const auto& rule : global_automations) {
            for (const auto& trig : rule.triggers) {
                if (trig.type == "can_rx" || trig.type == "byte_transition") {
                    watched_auto_ids.insert(trig.can_id);
                }
            }
            for (const auto& cond : rule.conditions) {
                collect_sustained_condition_can_ids(cond, watched_auto_ids);
            }
            collect_sustained_step_can_ids(rule.actions, watched_auto_ids);
        }
        auto_gen = g_automations_gen.load(std::memory_order_acquire);
    };
    refresh_watched_auto_ids();

    while (true) {
        esp_task_wdt_reset();
        if (power_mgr_is_restarting()) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
        if ((now_ms - last_diag_snapshot_ms) >= 1000) {
            last_diag_snapshot_ms = now_ms;
            rtc_crash_snapshot_stats();
        }

        if (use_dual_can) {
            if (g_twai_reconfig_pending.load()) {
                static uint32_t s_last_dual_reconfig_ms = 0;
                if (s_last_dual_reconfig_ms == 0 || (now_ms - s_last_dual_reconfig_ms) >= 100) {
                    s_last_dual_reconfig_ms = now_ms;
                    bool listen_only = (g_twai_requested_mode.load() == TWAI_MODE_LISTEN_ONLY);
                    if (dual_can_set_listen_only(listen_only) == ESP_OK) {
                        g_twai_reconfig_pending.store(false);
                        s_last_dual_reconfig_ms = 0;
                    }
                }
            }
            if ((now_ms - last_dual_can_health_ms) >= 1000) {
                last_dual_can_health_ms = now_ms;
                for (int b = 0; b < CAN_BUS_COUNT; b++) {
                    can_bus_t bus = static_cast<can_bus_t>(b);
                    if (!dual_can_is_available(bus)) continue;
                    uint8_t tec = 0, rec = 0;
                    bool bus_off = false;
                    mcp2518fd_t* dev = dual_can_get_device(bus);
                    if (dev && mcp2518fd_get_error_counts(dev, &tec, &rec, &bus_off) == ESP_OK && bus_off) {
                        ESP_LOGW(TAG, "Dual-CAN bus %d in BUS_OFF (TEC=%u, REC=%u), recovering...", b, tec, rec);
                        mcp2518fd_recover(dev);
                    }
                }
            }
        } else {
            if (g_twai_reconfig_pending.load()) {
                twai_mode_t new_mode = g_twai_requested_mode.load();
                ESP_LOGI(TAG, "Reconfiguring TWAI peripheral to mode %d...", (int)new_mode);

                SemaphoreHandle_t mtx = get_or_create_twai_mutex();
                if (!mtx || xSemaphoreTake(mtx, pdMS_TO_TICKS(500)) == pdTRUE) {
                    // Flush TX queue first to prevent uninstaller hanging on pending semaphores
                    twai_clear_transmit_queue();
                    twai_stop();
                    twai_driver_uninstall();

                    twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, new_mode);
                    g_config.rx_queue_len = 128;
                    g_config.tx_queue_len = 32;
                    g_config.alerts_enabled = TWAI_ALERT_BUS_OFF | TWAI_ALERT_BUS_RECOVERED | TWAI_ALERT_RX_QUEUE_FULL;
                    twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
                    twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

                    esp_err_t ret = twai_driver_install(&g_config, &t_config, &f_config);
                    if (ret == ESP_OK) {
                        twai_start();
                        ESP_LOGI(TAG, "TWAI reconfigured to %s",
                                 new_mode == TWAI_MODE_LISTEN_ONLY ? "LISTEN_ONLY" : "NORMAL");
                    } else {
                        ESP_LOGE(TAG, "Failed reinstalling TWAI driver (%s)", esp_err_to_name(ret));
                    }

                    if (mtx) xSemaphoreGive(mtx);
                    g_twai_reconfig_pending.store(false);
                } else {
                    ESP_LOGW(TAG, "Timed out waiting for TWAI mutex during mode reconfig; will retry");
                }
            }

            // Drain alerts so alert buffer never fills up
            uint32_t alerts = 0;
            if (twai_read_alerts(&alerts, 0) == ESP_OK && alerts != 0) {
                if (alerts & TWAI_ALERT_BUS_OFF) {
                    ESP_LOGW(TAG, "TWAI alert: BUS_OFF");
                }
                if (alerts & TWAI_ALERT_RX_QUEUE_FULL) {
                    static uint32_t s_last_rx_full_log_ms = 0;
                    static uint32_t s_rx_full_suppressed = 0;
                    if (s_last_rx_full_log_ms == 0 || (now_ms - s_last_rx_full_log_ms) >= 3000) {
                        ESP_LOGW(TAG, "TWAI alert: RX queue full, dropping frame (suppressed=%lu)",
                                 (unsigned long)s_rx_full_suppressed);
                        s_last_rx_full_log_ms = now_ms;
                        s_rx_full_suppressed = 0;
                    } else {
                        s_rx_full_suppressed++;
                    }
                }
            }

            // Auto-recover supervisor for TWAI peripheral (throttled to 50 ms unless alerts fired)
            if (alerts != 0 || last_twai_status_poll_ms == 0 || (now_ms - last_twai_status_poll_ms) >= 50) {
            last_twai_status_poll_ms = now_ms;
            twai_status_info_t twai_status;
            if (twai_get_status_info(&twai_status) == ESP_OK) {
            if (twai_status.state == TWAI_STATE_BUS_OFF) {
                ESP_LOGW(TAG, "TWAI controller in BUS_OFF! Initiating hardware recovery...");
                SemaphoreHandle_t mtx = get_or_create_twai_mutex();
                if (!mtx || xSemaphoreTake(mtx, pdMS_TO_TICKS(500)) == pdTRUE) {
                    twai_clear_transmit_queue();
                    if (twai_initiate_recovery() != ESP_OK) {
                        twai_driver_uninstall();
                        twai_mode_t cur_mode = g_twai_requested_mode.load();
                        twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, cur_mode);
                        g_config.rx_queue_len = 128;
                        g_config.tx_queue_len = 32;
                        g_config.alerts_enabled = TWAI_ALERT_BUS_OFF | TWAI_ALERT_BUS_RECOVERED | TWAI_ALERT_RX_QUEUE_FULL;
                        twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
                        twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();
                        if (twai_driver_install(&g_config, &t_config, &f_config) == ESP_OK) {
                            twai_start();
                        }
                    }

                    if (mtx) xSemaphoreGive(mtx);
                    s_bus_off_or_recovering_start_ms = now_ms;
                } else {
                    ESP_LOGW(TAG, "Timed out waiting for TWAI mutex during BUS_OFF recovery");
                }
            } else if (twai_status.state == TWAI_STATE_STOPPED) {
                ESP_LOGI(TAG, "TWAI controller STOPPED. Starting controller...");
                SemaphoreHandle_t mtx = get_or_create_twai_mutex();
                if (!mtx || xSemaphoreTake(mtx, pdMS_TO_TICKS(500)) == pdTRUE) {
                    twai_clear_transmit_queue();
                    twai_start();
                    if (mtx) xSemaphoreGive(mtx);
                    s_bus_off_or_recovering_start_ms = 0;
                } else {
                    ESP_LOGW(TAG, "Timed out waiting for TWAI mutex during STOPPED recovery");
                }
            } else if (twai_status.state == TWAI_STATE_RECOVERING) {
                if (s_bus_off_or_recovering_start_ms == 0) {
                    s_bus_off_or_recovering_start_ms = now_ms;
                }
                // If hardware is stuck in RECOVERING for > 3000ms (e.g. bench test, dominant fault),
                // reinstall hardware driver cleanly without MCU reset.
                if (now_ms - s_bus_off_or_recovering_start_ms > 3000) {
                    ESP_LOGW(TAG, "TWAI stuck in RECOVERING state (>3000ms). Reinstalling driver without MCU reset...");
                    SemaphoreHandle_t mtx = get_or_create_twai_mutex();
                    if (!mtx || xSemaphoreTake(mtx, pdMS_TO_TICKS(500)) == pdTRUE) {
                        twai_clear_transmit_queue();
                        twai_stop();
                        twai_driver_uninstall();

                        twai_mode_t cur_mode = g_twai_requested_mode.load();
                        twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, cur_mode);
                        g_config.rx_queue_len = 128;
                        g_config.tx_queue_len = 32;
                        g_config.alerts_enabled = TWAI_ALERT_BUS_OFF | TWAI_ALERT_BUS_RECOVERED | TWAI_ALERT_RX_QUEUE_FULL;
                        twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
                        twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

                        esp_err_t err = twai_driver_install(&g_config, &t_config, &f_config);
                        if (err == ESP_OK) {
                            twai_start();
                            ESP_LOGI(TAG, "TWAI driver re-installed and running after recovery timeout");
                        } else {
                            ESP_LOGE(TAG, "TWAI driver reinstall failed (%s)", esp_err_to_name(err));
                        }

                        if (mtx) xSemaphoreGive(mtx);
                        s_bus_off_or_recovering_start_ms = 0;
                    } else {
                        ESP_LOGW(TAG, "Timed out waiting for TWAI mutex during RECOVERING reinstall");
                    }
                }
            } else if (twai_status.state == TWAI_STATE_RUNNING) {
                s_bus_off_or_recovering_start_ms = 0;
            }
        } else {
            // Driver not running or in uninstalled/invalid state
            static uint32_t s_last_reinstall_attempt_ms = 0;
            if (now_ms - s_last_reinstall_attempt_ms > 1000) {
                s_last_reinstall_attempt_ms = now_ms;
                ESP_LOGW(TAG, "TWAI driver not running or not installed! Attempting reinstall...");
                SemaphoreHandle_t mtx = get_or_create_twai_mutex();
                if (!mtx || xSemaphoreTake(mtx, pdMS_TO_TICKS(500)) == pdTRUE) {
                    twai_clear_transmit_queue();
                    twai_stop();
                    twai_driver_uninstall();

                    twai_mode_t cur_mode = g_twai_requested_mode.load();
                    twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, cur_mode);
                    g_config.rx_queue_len = 128;
                    g_config.tx_queue_len = 32;
                    g_config.alerts_enabled = TWAI_ALERT_BUS_OFF | TWAI_ALERT_BUS_RECOVERED | TWAI_ALERT_RX_QUEUE_FULL;
                    twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
                    twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

                    esp_err_t err = twai_driver_install(&g_config, &t_config, &f_config);
                    if (err == ESP_OK) {
                        twai_start();
                        ESP_LOGI(TAG, "TWAI driver re-installed and running after invalid state recovery");
                    } else {
                        ESP_LOGE(TAG, "TWAI driver reinstall failed (%s)", esp_err_to_name(err));
                    }

                    if (mtx) xSemaphoreGive(mtx);
                } else {
                    ESP_LOGW(TAG, "Timed out waiting for TWAI mutex during invalid-state reinstall");
                }
            }
        }
            } // end throttled TWAI status poll
        } // end !use_dual_can

        bool has_frame = false;
        bool from_physical_bus = false;
        can_bus_t frame_bus = CAN_BUS_0;
        can_fd_frame_t rx_fd_msg = {};

        // Check Dual-CAN MCP2518FD hardware fairly (round-robin start bus so neither starves the other)
        if (use_dual_can) {
            can_bus_t order[2] = { prefer_bus1 ? CAN_BUS_1 : CAN_BUS_0, prefer_bus1 ? CAN_BUS_0 : CAN_BUS_1 };
            prefer_bus1 = !prefer_bus1;
            for (int i = 0; i < 2; i++) {
                can_bus_t b = order[i];
                if (dual_can_is_available(b) && dual_can_poll_receive(b, &rx_fd_msg) == ESP_OK) {
                    has_frame = true;
                    from_physical_bus = true;
                    frame_bus = b;
                    can_fd_to_twai(&rx_fd_msg, &rx_msg);
                    break;
                }
            }
            if (!has_frame && s_can_inject_queue && xQueueReceive(s_can_inject_queue, &rx_msg, 0) == pdTRUE) {
                if (rx_msg.data_length_code > 8) rx_msg.data_length_code = 8;
                if (rx_msg.data_length_code < 8) {
                    memset(&rx_msg.data[rx_msg.data_length_code], 0, 8 - rx_msg.data_length_code);
                }
                has_frame = true;
                from_physical_bus = false;
                frame_bus = CAN_BUS_0;
                can_twai_to_fd(&rx_msg, CAN_BUS_0, &rx_fd_msg);
            }
            if (!has_frame) {
                vTaskDelay(pdMS_TO_TICKS(1));
            }
        } else {
            // On-chip TWAI or inject queue
            if (twai_receive(&rx_msg, pdMS_TO_TICKS(2)) == ESP_OK) {
                if (rx_msg.data_length_code > 8) rx_msg.data_length_code = 8;
                if (rx_msg.data_length_code < 8) {
                    memset(&rx_msg.data[rx_msg.data_length_code], 0, 8 - rx_msg.data_length_code);
                }
                has_frame = true;
                from_physical_bus = true;
                frame_bus = CAN_BUS_0;
                can_twai_to_fd(&rx_msg, CAN_BUS_0, &rx_fd_msg);
            } else if (s_can_inject_queue && xQueueReceive(s_can_inject_queue, &rx_msg, 0) == pdTRUE) {
                if (rx_msg.data_length_code > 8) rx_msg.data_length_code = 8;
                if (rx_msg.data_length_code < 8) {
                    memset(&rx_msg.data[rx_msg.data_length_code], 0, 8 - rx_msg.data_length_code);
                }
                has_frame = true;
                from_physical_bus = false;
                frame_bus = CAN_BUS_0;
                can_twai_to_fd(&rx_msg, CAN_BUS_0, &rx_fd_msg);
            }
        }

        if (has_frame) {
            consecutive_rx_frames++;
            if (consecutive_rx_frames >= 64 || (esp_timer_get_time() - burst_start_us) >= 20000) {
                vTaskDelay(1);
                consecutive_rx_frames = 0;
                burst_start_us = esp_timer_get_time();
            }
            s_last_can_frame_ms = now_ms;
            if (from_physical_bus) {
                s_last_can_rx_ms.store(now_ms, std::memory_order_relaxed);
                if (frame_bus < CAN_BUS_COUNT) {
                    s_last_bus_rx_ms[frame_bus].store(now_ms, std::memory_order_relaxed);
                }
            }
            s_can_led_idle_cleared = false;
            board_led_can_activity();
            can_engine_record_active_id(rx_msg.identifier);

            rtc_crash_record(rx_msg.identifier, rx_msg.data_length_code, rx_msg.data, 1, "rx_decode");
            precondition_can_rx_hook(&rx_msg, frame_bus);

            s_rtc_crash.step_marker = 3;
            hud_nav_rx(&rx_msg, frame_bus);

            // Dual-CAN MITM bridge: forward physical bus frames across CAN_BUS_0 <-> CAN_BUS_1
            // unless blocked or modified by subsystem hooks or catalog network.mitm rules.
            if (from_physical_bus && use_dual_can &&
                g_mitm_bridge_enabled.load(std::memory_order_relaxed) &&
                !g_sniffer_mode.load(std::memory_order_relaxed) &&
                g_twai_requested_mode.load(std::memory_order_relaxed) != TWAI_MODE_LISTEN_ONLY &&
                dual_can_is_available(CAN_BUS_0) &&
                dual_can_is_available(CAN_BUS_1)) {
                can_bus_t dst_bus = (frame_bus == CAN_BUS_0) ? CAN_BUS_1 : CAN_BUS_0;
                twai_message_t fwd_msg = rx_msg;
                fwd_result_t pre_res = precondition_fwd_hook(&fwd_msg, dst_bus);
                fwd_result_t hud_res = (pre_res != FWD_BLOCK) ? hud_nav_fwd(&fwd_msg, dst_bus) : FWD_BLOCK;
                bool blocked_by_hsm = (pre_res == FWD_BLOCK || hud_res == FWD_BLOCK);
                bool blocked_by_catalog = !blocked_by_hsm &&
                    g_has_mitm_rules.load(std::memory_order_acquire) &&
                    mitm_should_block_bridged_frame(rx_msg.identifier, static_cast<uint8_t>(frame_bus),
                                                    static_cast<uint8_t>(dst_bus), fwd_msg.data,
                                                    fwd_msg.data_length_code);
                if (!blocked_by_hsm && !blocked_by_catalog) {
                    can_fd_frame_t fwd_fd = rx_fd_msg;
                    fwd_fd.bus = static_cast<uint8_t>(dst_bus);
                    if (pre_res == FWD_MODIFIED || hud_res == FWD_MODIFIED) {
                        uint8_t copy_len = fwd_msg.data_length_code > 8 ? 8 : fwd_msg.data_length_code;
                        if (copy_len > 0) {
                            memcpy(fwd_fd.data, fwd_msg.data, copy_len);
                        }
                    }
                    esp_err_t fwd_tx_err = can_send_fd(dst_bus, &fwd_fd, pdMS_TO_TICKS(1));
                    if (fwd_tx_err != ESP_OK) {
                        static uint32_t s_mitm_tx_drop_count = 0;
                        static uint32_t s_mitm_tx_drop_log_ms = 0;
                        s_mitm_tx_drop_count++;
                        if (s_mitm_tx_drop_log_ms == 0 || (now_ms - s_mitm_tx_drop_log_ms) >= 2000) {
                            s_mitm_tx_drop_log_ms = now_ms;
                            ESP_LOGW(TAG, "MITM bridge TX drop on CAN%d (ID 0x%03lX, err=%s, total_drops=%lu)",
                                     (int)dst_bus, (unsigned long)fwd_fd.identifier,
                                     esp_err_to_name(fwd_tx_err), (unsigned long)s_mitm_tx_drop_count);
                        }
                    }
                }
            }

            s_rtc_crash.step_marker = 4;
            uds_engine_on_can_rx(&rx_msg);

            // Stream raw frame to connected SavvyCAN/GVRET client with bus metadata
            s_rtc_crash.step_marker = 6;
            gvret_enqueue_fd_frame(&rx_fd_msg);

            if (rx_msg.rtr) {
                rtc_crash_step_label(999, "rtr_done");
                continue;
            }

            // 1. Exchange previous & current state cache in a single lock/lookup
            s_rtc_crash.step_marker = 7;
            uint8_t prev_data[8] = {0};
            uint8_t prev_dlc = 0;
            bool has_prev = exchange_cached_can_frame(rx_msg.identifier, rx_msg.data, rx_msg.data_length_code, prev_data, &prev_dlc);

            // Helper: Mask out rolling counter and checksum bytes during MQTT change detection
            auto get_can_comparison_mask = [](uint32_t can_id, uint8_t mask_out[8]) {
                memset(mask_out, 0xFF, 8);
                switch (can_id) {
                    // Hyundai/Kia/Genesis E-GMP & Gen5W frames with alive counter and/or CRC in Byte 7:
                    case 0x0A2: // Wheel speeds
                    case 0x130: // Steering angle
                    case 0x152: // BMS Battery telemetry
                    case 0x1AC: // Cluster speed and info
                    case 0x226: // Shifter / Gear status
                    case 0x2AD: // Throttle & brake pedal
                    case 0x30E: // VCMS Live EV Charging Power (Byte 7 is rolling counter)
                    case 0x380: // Climate cabin temperatures
                    case 0x31B: // Climate blower fan & airflow
                    case 0x476: // Center console & camera switch panel
                    case 0x448: // Steering wheel media & cruise controls
                    case 0x4CE: // Head unit media & cluster popup
                        mask_out[7] = 0x00;
                        break;
                    default:
                        break;
                }
            };

            auto has_masked_can_data_changed = [&](uint32_t can_id, const uint8_t* prev, const uint8_t* curr, size_t len) -> bool {
                if (!prev) return true;
                uint8_t mask[8];
                get_can_comparison_mask(can_id, mask);
                for (size_t i = 0; i < len && i < 8; i++) {
                    if ((prev[i] & mask[i]) != (curr[i] & mask[i])) {
                        return true;
                    }
                }
                return false;
            };

            // Publish state change to MQTT if this CAN ID is monitored and actual payload data changed
            if (mqtt_mgr_is_monitored_id(rx_msg.identifier)) {
                if (!has_prev || has_masked_can_data_changed(rx_msg.identifier, prev_data, rx_msg.data, rx_msg.data_length_code)) {
                    static PsramUnorderedMap<uint32_t, uint32_t> s_last_mqtt_pub_ms;
                    auto pit = s_last_mqtt_pub_ms.find(rx_msg.identifier);
                    bool throttle = false;
                    // For continuous high-frequency telemetry, throttle to max 10Hz (100ms) to protect MQTT outbox
                    if (rx_msg.identifier == 0x1AC || rx_msg.identifier == 0x0A2 ||
                        rx_msg.identifier == 0x130 || rx_msg.identifier == 0x2AD ||
                        rx_msg.identifier == 0x227 || rx_msg.identifier == 0x29C ||
                        rx_msg.identifier == 0x151 || rx_msg.identifier == 0x152 ||
                        rx_msg.identifier == 0x30E || rx_msg.identifier == 0x25C ||
                        rx_msg.identifier == 0x327 || rx_msg.identifier == 0x328 ||
                        rx_msg.identifier == 0x324 || rx_msg.identifier == 0x597 ||
                        rx_msg.identifier == 0x4E2) {
                        if (pit != s_last_mqtt_pub_ms.end() && (now_ms - pit->second < 100)) {
                            throttle = true;
                        }
                    }
                    if (!throttle) {
                        s_last_mqtt_pub_ms[rx_msg.identifier] = now_ms;
                        mqtt_mgr_publish_can_state(rx_msg.identifier, rx_msg.data, rx_msg.data_length_code);
                    }
                }
            }

            // 2. Evaluate automations if globally enabled and CAN ID is referenced by a trigger
            if (are_automations_active()) {
                if (g_automations_gen.load(std::memory_order_acquire) != auto_gen) {
                    refresh_watched_auto_ids();
                }
                if (watched_auto_ids.find(rx_msg.identifier) != watched_auto_ids.end()) {
                    std::vector<FiredRuleEvent> fired_events;
                    {
                        std::lock_guard<std::mutex> lock(g_automations_mutex);
                        for (auto& rule : global_automations) {
                            if (!rule.enabled) continue;

                            for (const auto& cond : rule.conditions) {
                                tick_sustained_condition_tree(cond, rx_msg.identifier);
                            }
                            tick_sustained_conditions_in_steps(rule.actions, rx_msg.identifier);

                            const bool rule_running = (rule.is_running && rule.is_running->load());

                            for (const auto& trig : rule.triggers) {
                                if ((trig.type == "can_rx" || trig.type == "byte_transition") && trig.can_id == rx_msg.identifier) {
                                    if (use_dual_can && trig.bus != static_cast<uint8_t>(frame_bus)) {
                                        continue;
                                    }
                                    if (trig.for_ms > 0 && trig.click_count <= 1) {
                                        update_sustained_trigger_state(trig, is_can_target_match(rx_msg.data, rx_msg.data_length_code, trig), now_ms);
                                        continue;
                                    }
                                    if (rule_running) continue;
                                    if (is_trigger_match(rx_msg.data, rx_msg.data_length_code, has_prev ? prev_data : nullptr, prev_dlc, trig)) {
                                        handle_trigger_press_edge(rule, trig, now_ms, "CAN automation", &fired_events);
                                    }
                                }
                            }
                        }
                    }
                    dispatch_fired_rule_events(fired_events);
                }
            }

            decode_can_frame_entities(rx_msg.identifier, rx_msg.data, rx_msg.data_length_code);
            rtc_crash_step_label(900, "frame_done");
        } else {
            consecutive_rx_frames = 0;
            burst_start_us = esp_timer_get_time();
            // Cleanly extinguish yellow CAN activity LED once when bus becomes idle (>200ms)
            if (!s_can_led_idle_cleared && s_last_can_frame_ms > 0 && (now_ms - s_last_can_frame_ms > 200)) {
                s_can_led_idle_cleared = true;
                board_led_can_set(false);
            }
        }
        static uint32_t s_last_rtc_periodic_sync_ms = 0;
        if (now_ms - s_last_rtc_periodic_sync_ms >= 5000) {
            s_last_rtc_periodic_sync_ms = now_ms;
            rtc_can_state_save();
        }
        static uint32_t s_last_precon_tick_ms = 0;
        if (now_ms - s_last_precon_tick_ms >= 40) {
            s_last_precon_tick_ms = now_ms;
            precondition_tick();
        }

        static uint32_t s_last_hud_tick_ms = 0;
        uint32_t now_hud_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
        if (now_hud_ms - s_last_hud_tick_ms >= 100) {
            s_last_hud_tick_ms = now_hud_ms;
            hud_nav_tick_100ms();
        }
    }
}

void can_tx_task(void* arg) {
    CanBurstCmd* cmd = nullptr;
    ESP_LOGI(TAG, "CAN TX task running");

    while (true) {
        if (power_mgr_is_restarting()) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        if (!tx_command_queue) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        if (xQueueReceive(tx_command_queue, &cmd, pdMS_TO_TICKS(200)) == pdTRUE && cmd) {
            if (cmd->async) {
                if (s_active_async_tasks.load() >= MAX_CONCURRENT_ASYNC_TASKS) {
                    ESP_LOGW(TAG, "Dropping async action burst: max concurrent tasks (%d) reached", MAX_CONCURRENT_ASYNC_TASKS);
                    if (cmd->rule_is_running) {
                        cmd->rule_is_running->store(false, std::memory_order_release);
                    }
                    delete cmd;
                    continue;
                }
                s_active_async_tasks.fetch_add(1);
                BaseType_t res = xTaskCreate(execute_can_burst_async_task, "can_tx_async", 6144, cmd, 3, NULL);
                if (res != pdPASS) {
                    ESP_LOGE(TAG, "Failed to create can_tx_async task (out of memory?)");
                    s_active_async_tasks.fetch_sub(1);
                    if (cmd->rule_is_running) {
                        cmd->rule_is_running->store(false, std::memory_order_release);
                    }
                    delete cmd;
                }
            } else {
                EvalContext ctx;
                ctx.firing_trigger_id = cmd->trigger_id.c_str();
                if (!cmd->inline_steps.empty()) {
                    execute_can_burst_ctx(cmd->can_id, cmd->inline_steps, cmd->delay_ms, ctx, 0);
                }
                if (cmd->rule_is_running) {
                    cmd->rule_is_running->store(false, std::memory_order_release);
                }
                delete cmd;
            }
        }
    }
}

void time_scheduler_task(void* arg) {
    ESP_LOGI(TAG, "Time scheduler task running");
    int last_checked_min = -1;

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(50));

        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

        // 1. Evaluate multi-press click windows and sustained-duration conditions/triggers (works 100% offline before NTP sync)
        if (are_automations_active()) {
            std::vector<FiredRuleEvent> fired_events;
            {
                std::lock_guard<std::mutex> lock(g_automations_mutex);
                for (auto& rule : global_automations) {
                    if (!rule.enabled) continue;

                    for (const auto& cond : rule.conditions) {
                        tick_sustained_condition_tree(cond);
                    }
                    tick_sustained_conditions_in_steps(rule.actions);

                    if (rule.is_running && rule.is_running->load()) continue;

                    for (const auto& trig : rule.triggers) {
                        if (trig.multi_click) {
                            bool ready_multi = false;
                            {
                                std::lock_guard<std::mutex> lk(trig.multi_click->mtx);
                                if (trig.multi_click->pending &&
                                    (now_ms - trig.multi_click->last_press_ms >= MULTI_CLICK_WINDOW_MS)) {
                                    const uint8_t target_clicks = trig.click_count >= 1 ? trig.click_count : 1;
                                    ready_multi = (trig.multi_click->count == target_clicks);
                                    trig.multi_click->pending = false;
                                    trig.multi_click->count = 0;
                                }
                            }
                            if (ready_multi) {
                                try_fire_rule_trigger(rule, trig, now_ms, "Multi-press trigger", &fired_events);
                            }
                        }

                        if (trig.for_ms == 0 || !trig.sustained || trig.click_count > 1) continue;
                        if (trig.type == "ble_button" || trig.type == "time_schedule") continue;

                        bool now_true = evaluate_trigger_state_now(trig, now_ms);
                        bool ready = false;
                        {
                            std::lock_guard<std::mutex> lk(trig.sustained->mtx);
                            if (!now_true) {
                                trig.sustained->active = false;
                                trig.sustained->since_ms = 0;
                                trig.sustained->fired = false;
                            } else {
                                if (!trig.sustained->active) {
                                    trig.sustained->active = true;
                                    trig.sustained->since_ms = now_ms;
                                    trig.sustained->fired = false;
                                }
                                ready = (!trig.sustained->fired && (now_ms - trig.sustained->since_ms >= trig.for_ms));
                            }
                        }
                        if (ready && try_fire_rule_trigger(rule, trig, now_ms, "Sustained trigger", &fired_events)) {
                            std::lock_guard<std::mutex> lk(trig.sustained->mtx);
                            if (trig.sustained->active) {
                                trig.sustained->fired = true;
                            }
                        }
                    }
                }
            }
            dispatch_fired_rule_events(fired_events);
        }

        // 2. Time-of-day schedules (requires synchronized clock)
        time_t now;
        time(&now);
        struct tm timeinfo;
        localtime_r(&now, &timeinfo);

        if (timeinfo.tm_year < (2024 - 1900)) {
            continue;
        }

        int cur_min = timeinfo.tm_hour * 60 + timeinfo.tm_min;
        if (cur_min == last_checked_min) {
            continue;
        }
        last_checked_min = cur_min;

        int cur_wday = timeinfo.tm_wday; // 0=Sun .. 6=Sat

        if (!are_automations_active()) {
            continue;
        }

        std::vector<FiredRuleEvent> sched_fired;
        {
            std::lock_guard<std::mutex> lock(g_automations_mutex);
            for (auto& rule : global_automations) {
                if (!rule.enabled) continue;
                if (rule.is_running && rule.is_running->load()) continue;

                for (const auto& trig : rule.triggers) {
                    if (trig.type == "time_schedule") {
                        if (trig.schedule_time_min == cur_min && (trig.weekdays_mask & (1 << cur_wday))) {
                            try_fire_rule_trigger(rule, trig, now_ms, "Time schedule", &sched_fired);
                        }
                    }
                }
            }
        }
        dispatch_fired_rule_events(sched_fired);
    }
}

void can_engine_on_device_event(const std::string& event_type, const std::string& detail_str, int8_t rssi) {
    if (!are_automations_active()) return;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    std::vector<FiredRuleEvent> fired_events;
    {
        std::lock_guard<std::mutex> lock(g_automations_mutex);
        for (auto& rule : global_automations) {
            if (!rule.enabled) continue;
            if (rule.is_running && rule.is_running->load()) continue;

            for (const auto& trig : rule.triggers) {
                if (trig.type == "wifi" || trig.type == "wifi_event" || trig.type == "device_event") {
                    if (trig.for_ms > 0) continue; // Handled by sustained scheduler

                    bool event_match = false;
                    if (trig.wifi_event == event_type) {
                        event_match = true;
                    } else if (event_type == "wifi_connected" && (trig.wifi_event == "connected" || trig.wifi_event == "sta_connected")) {
                        event_match = true;
                    } else if (event_type == "wifi_disconnected" && (trig.wifi_event == "disconnected" || trig.wifi_event == "sta_disconnected")) {
                        event_match = true;
                    }

                    if (!event_match) continue;

                    // Match SSID if specified
                    if (!trig.ssid.empty() && (event_type == "wifi_connected" || event_type == "wifi_disconnected")) {
                        if (strcasecmp(trig.ssid.c_str(), detail_str.c_str()) != 0) {
                            continue;
                        }
                    }

                    // Match client MAC if specified
                    if (!trig.client_mac.empty() && (event_type == "ap_client_connected" || event_type == "ap_client_disconnected")) {
                        if (!mac_matches(trig.client_mac, detail_str)) {
                            continue;
                        }
                    }

                    // Match target RSSI if specified
                    if (trig.target_rssi != 0 && (event_type == "ap_client_connected" || event_type == "wifi_connected")) {
                        if (rssi < trig.target_rssi) {
                            continue;
                        }
                    }

                    try_fire_rule_trigger(rule, trig, now_ms, "Device/Wi-Fi event", &fired_events);
                }
            }
        }
    }
    dispatch_fired_rule_events(fired_events);
}

void can_engine_set_ble_learn_mode(bool active, uint32_t duration_ms) {
    if (!active) {
        s_ble_learn_until_ms.store(0);
        ESP_LOGI(TAG, "BLE button learn mode disabled");
        return;
    }
    uint32_t dur = (duration_ms > 0 && duration_ms <= 60000) ? duration_ms : 30000;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    uint32_t until = now_ms + dur;
    if (until == 0) until = 1; // avoid 0 sentinel
    s_ble_learn_until_ms.store(until);
    ESP_LOGI(TAG, "BLE button learn mode enabled for %lu ms", (unsigned long)dur);
}

void can_engine_on_ble_event(const std::string& address, const std::string& button, const std::string& action, const std::string& combo, uint32_t hold_seconds) {
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        s_last_ble_event.address = address;
        s_last_ble_event.button = button;
        s_last_ble_event.combo = combo;
        s_last_ble_event.action = action;
        s_last_ble_event.hold_seconds = hold_seconds;
        s_last_ble_event.timestamp_ms = now_ms;
    }

    mqtt_mgr_publish_ble_button(address, button, action, combo, hold_seconds);

    if (!are_automations_active()) return;

    uint32_t learn_until = s_ble_learn_until_ms.load();
    if (learn_until != 0) {
        if ((int32_t)(learn_until - now_ms) > 0) {
            return;
        }
        s_ble_learn_until_ms.store(0);
    }

    const bool is_hold_tick = (action == "hold" || action.rfind("hold_", 0) == 0);
    bool should_beep = false;
    std::vector<FiredRuleEvent> fired_events;

    {
        std::lock_guard<std::mutex> lock(g_automations_mutex);
        for (auto& rule : global_automations) {
            if (!rule.enabled) continue;

            if (is_hold_tick && rule.hold_beep && !should_beep) {
                for (const auto& trig : rule.triggers) {
                    if ((trig.type == "ble_button" || trig.type == "ble_key" || trig.type == "ble") &&
                        strcasecmp(trig.ble_action.c_str(), "tap") != 0 &&
                        strcasecmp(trig.ble_action.c_str(), "release") != 0 &&
                        ble_button_matches(trig.ble_button, button, combo) &&
                        (trig.ble_device.empty() || mac_matches(trig.ble_device, address))) {
                        should_beep = true;
                        break;
                    }
                }
            }

            if (rule.is_running && rule.is_running->load()) continue;

            for (const auto& trig : rule.triggers) {
                if (trig.type == "ble_button" || trig.type == "ble_key" || trig.type == "ble") {
                    if (!ble_button_matches(trig.ble_button, button, combo)) {
                        continue;
                    }

                    const std::string& effective_ble_action =
                        (trig.click_count > 1 && (trig.ble_action.empty() || trig.ble_action == "any"))
                            ? std::string("press")
                            : trig.ble_action;

                    if (!ble_action_matches(effective_ble_action, action, hold_seconds)) {
                        continue;
                    }

                    // Match device address / MAC if specified
                    if (!trig.ble_device.empty()) {
                        if (!mac_matches(trig.ble_device, address)) {
                            continue;
                        }
                    }

                    handle_trigger_press_edge(rule, trig, now_ms, "BLE button event", &fired_events);
                }
            }
        }
    }

    dispatch_fired_rule_events(fired_events);
    if (should_beep) {
        beep_play(1);
    }
}

void can_engine_on_ble_device_event(const std::string& address, const std::string& event, int8_t rssi, const std::string& name) {
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        auto& info = s_ble_devices[address];
        info.address = address;
        if (!name.empty()) info.name = name;
        if (event == "connected") info.connected = true;
        else if (event == "disconnected") info.connected = false;
        if (rssi != 0) info.rssi = rssi;
        info.last_seen_ms = now_ms;
    }

    mqtt_mgr_publish_ble_device(address, event, rssi, name);

    if (!are_automations_active()) return;

    std::vector<FiredRuleEvent> fired_events;
    {
        std::lock_guard<std::mutex> lock(g_automations_mutex);
        for (auto& rule : global_automations) {
            if (!rule.enabled) continue;
            if (rule.is_running && rule.is_running->load()) continue;

            for (const auto& trig : rule.triggers) {
                if (trig.type == "ble_device_event" || trig.type == "ble_device" || trig.type == "ble_presence") {
                    if (trig.for_ms > 0) continue; // Handled by sustained scheduler
                    // Match event: "connected", "disconnected", "proximity", "present", "away", "any"
                    if (!trig.ble_event.empty() && trig.ble_event != "any") {
                        bool event_matched = false;
                        if (strcasecmp(trig.ble_event.c_str(), event.c_str()) == 0) {
                            event_matched = true;
                        } else if (strcasecmp(trig.ble_event.c_str(), "present") == 0) {
                            if (event == "connected" || event == "proximity" || event == "present" || event == "enter") event_matched = true;
                        } else if (strcasecmp(trig.ble_event.c_str(), "away") == 0) {
                            if (event == "disconnected" || event == "away" || event == "exit") event_matched = true;
                        } else if (strcasecmp(trig.ble_event.c_str(), "connected") == 0) {
                            if (event == "present") event_matched = true;
                        } else if (strcasecmp(trig.ble_event.c_str(), "disconnected") == 0) {
                            if (event == "away") event_matched = true;
                        }
                        if (!event_matched) {
                            continue;
                        }
                    }

                    // Match device MAC if specified
                    if (!trig.ble_device.empty()) {
                        if (!mac_matches(trig.ble_device, address) && strcasecmp(trig.ble_device.c_str(), name.c_str()) != 0) {
                            continue;
                        }
                    }

                    // Match target RSSI if specified (only for present/connected/proximity, NOT for away/disconnected)
                    bool is_away = (event == "disconnected" || event == "away" ||
                                   strcasecmp(trig.ble_event.c_str(), "disconnected") == 0 ||
                                   strcasecmp(trig.ble_event.c_str(), "away") == 0);
                    if (!is_away && trig.target_rssi != 0) {
                        if (rssi < trig.target_rssi) {
                            continue;
                        }
                    }

                    try_fire_rule_trigger(rule, trig, now_ms, "BLE device event", &fired_events);
                }
            }
        }
    }
    dispatch_fired_rule_events(fired_events);
}

void can_engine_on_ble_beacon_event(const std::string& uuid, const std::string& event, int8_t rssi, uint16_t major, uint16_t minor, const std::string& mac, const std::string& name) {
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    std::string key = !uuid.empty() ? uuid : mac;
    if (key.empty()) return;

    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        auto& info = s_ble_beacons[key];
        info.uuid = uuid;
        if (!mac.empty()) info.mac = mac;
        if (!name.empty()) info.name = name;
        if (major != 0) info.major = major;
        if (minor != 0) info.minor = minor;
        if (rssi != 0) info.rssi = rssi;
        info.last_seen_ms = now_ms;
        if (event == "enter" || event == "present") info.present = true;
        else if (event == "exit" || event == "away") info.present = false;
        else if (event == "proximity") info.present = true;

        if (!mac.empty() && mac != key) {
            s_ble_beacons[mac] = info;
        }
    }

    mqtt_mgr_publish_ble_beacon(uuid, event, rssi, major, minor, mac, name);

    if (!are_automations_active()) return;

    std::vector<FiredRuleEvent> fired_events;
    {
        std::lock_guard<std::mutex> lock(g_automations_mutex);
        for (auto& rule : global_automations) {
            if (!rule.enabled) continue;
            if (rule.is_running && rule.is_running->load()) continue;

            for (const auto& trig : rule.triggers) {
                if (trig.type == "ble_beacon" || trig.type == "beacon" || trig.type == "ble_presence") {
                    if (trig.for_ms > 0) continue; // Handled by sustained scheduler
                    // Match event: "enter", "exit", "proximity", "present", "away", "any"
                    if (!trig.ble_event.empty() && trig.ble_event != "any") {
                        bool event_matched = false;
                        if (strcasecmp(trig.ble_event.c_str(), event.c_str()) == 0) {
                            event_matched = true;
                        } else if (strcasecmp(trig.ble_event.c_str(), "present") == 0) {
                            if (event == "enter" || event == "proximity" || event == "present") event_matched = true;
                        } else if (strcasecmp(trig.ble_event.c_str(), "away") == 0) {
                            if (event == "exit" || event == "away") event_matched = true;
                        } else if (strcasecmp(trig.ble_event.c_str(), "enter") == 0) {
                            if (event == "present") event_matched = true;
                        } else if (strcasecmp(trig.ble_event.c_str(), "exit") == 0) {
                            if (event == "away") event_matched = true;
                        }
                        if (!event_matched) {
                            continue;
                        }
                    }

                    // Match UUID / MAC / Name if specified
                    const std::string& target_filter = !trig.beacon_uuid.empty() ? trig.beacon_uuid : (!trig.ble_device.empty() ? trig.ble_device : trig.client_mac);
                    if (!target_filter.empty()) {
                        bool match = false;
                        if (!uuid.empty() && strcasestr(uuid.c_str(), target_filter.c_str()) != nullptr) match = true;
                        if (!mac.empty() && mac_matches(target_filter, mac)) match = true;
                        if (!name.empty() && strcasecmp(target_filter.c_str(), name.c_str()) == 0) match = true;
                        if (!match) continue;
                    }

                    // Match target RSSI if specified (only for enter/present/proximity, NOT for exit/away!)
                    bool is_away = (event == "exit" || event == "away" ||
                                   strcasecmp(trig.ble_event.c_str(), "exit") == 0 ||
                                   strcasecmp(trig.ble_event.c_str(), "away") == 0);
                    if (!is_away && trig.target_rssi != 0) {
                        if (rssi < trig.target_rssi) {
                            continue;
                        }
                    }

                    try_fire_rule_trigger(rule, trig, now_ms, "BLE beacon event", &fired_events);
                }
            }
        }
    }
    dispatch_fired_rule_events(fired_events);
}



