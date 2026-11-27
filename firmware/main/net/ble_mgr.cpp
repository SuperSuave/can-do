#include "ble_mgr.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "cJSON.h"
#include "can_engine.h"
#include "api.h"
#include "psram_alloc.h"
#include "esp_heap_caps.h"

#include <vector>
#include <string>
#include <mutex>
#include <algorithm>
#include <cmath>
#include <cctype>
#include <cstring>
#include <atomic>

static const char* TAG = "BLE_MGR";

#if CONFIG_BT_ENABLED

#include <NimBLEDevice.h>

extern std::string g_device_id;

#define BLE_MIN_RSSI_DISCOVERY -70
#define BLE_COMBO_SETTLE_MS 85U
#define BLE_HOLD_TICK_MS 1000U
static constexpr uint32_t BLE_RECONNECT_BACKOFF_MIN_MS = 15000U;
static constexpr uint32_t BLE_RECONNECT_BACKOFF_MAX_MS = 120000U;

struct BleButtonEvent {
    std::string device_address;
    std::string device_name;
    std::string button_name;
    std::string action; // "press", "release", "hold_1s".."hold_Ns"
    uint32_t timestamp_ms;
    std::string combo;
    uint32_t hold_seconds = 0;
};

enum class ChordPhase { IDLE, SETTLING, PRESSED };

struct BleChordState {
    ChordPhase phase = ChordPhase::IDLE;
    std::string addr;
    std::string name;
    std::vector<std::string> current_keys;
    std::vector<std::string> peak_keys;
    uint32_t first_down_ms = 0;
    uint32_t settle_deadline_ms = 0;
    uint32_t next_hold_tick_ms = 0;
    uint32_t hold_seconds = 0;
};

struct PairedDevice {
    std::string address;
    std::string name;
    int8_t rssi = -60;
    bool connected = false;
    bool bonded = true;
    int battery_pct = 100;
    uint8_t addr_type = 0; // BLE_ADDR_PUBLIC (0) or BLE_ADDR_RANDOM (1)
    uint32_t last_prox_send_ms = 0;
    uint32_t last_connect_attempt_ms = 0;
    uint32_t reconnect_backoff_ms = 0;
};

struct DiscoveredDevice {
    std::string address;
    std::string name;
    int8_t rssi;
    bool is_connectable;
    uint8_t addr_type = 0;
};

struct BeaconTarget {
    std::string uuid;
    std::string mac;
    std::string name = "Phone Beacon";
    int enter_rssi = -75;
    int exit_timeout_s = 20;
    bool is_present = false;
    uint32_t last_seen_ms = 0;
    float smoothed_rssi = -100.0f;
    int last_rssi = -100;
    uint16_t major = 0;
    uint16_t minor = 0;
    uint32_t last_prox_send_ms = 0;
};

struct DiscoveredBeacon {
    std::string uuid;
    std::string mac;
    int8_t rssi = -100;
    uint16_t major = 0;
    uint16_t minor = 0;
    uint32_t last_seen_ms = 0;
};

struct PendingButtonDispatch {
    std::string addr;
    std::string name;
    std::string btn;
    std::string act;
    std::string combo;
    uint32_t hold_seconds = 0;
};

struct PendingDeviceDispatch {
    std::string event; // "connected", "disconnected", "proximity"
    std::string addr;
    std::string name;
    int rssi = 0;
};

struct PendingBeaconDispatch {
    const char* evt;
    std::string uuid;
    std::string mac;
    std::string name;
    int last_rssi = -100;
    uint16_t major = 0;
    uint16_t minor = 0;
};

static constexpr size_t BLE_MAX_PENDING_EVENTS = 16;
static constexpr size_t MAX_PAIRED_DEVICES = 5;
static constexpr size_t MAX_BEACON_TARGETS = 8;
static constexpr size_t MAX_DISCOVERED_DEVICES = 32;
static constexpr size_t MAX_DISCOVERED_BEACONS = 10;
static constexpr size_t MAX_RECENT_BLE_EVENTS = 30;
static constexpr size_t MAX_BLE_NVS_JSON_LEN = 4096;

static std::mutex s_ble_mutex;
static PsramVector<DiscoveredDevice> s_discovered_devices;
static PsramVector<PairedDevice> s_paired_devices;
static PsramVector<BeaconTarget> s_beacon_targets;
static PsramVector<DiscoveredBeacon> s_discovered_beacons;
static PsramVector<BleButtonEvent> s_recent_ble_events;
static PsramVector<PendingButtonDispatch> s_pending_button_events;
static PsramVector<PendingDeviceDispatch> s_pending_device_events;
static PsramVector<PendingBeaconDispatch> s_pending_beacon_events;
static BleButtonEvent s_last_ble_event = {};
static bool s_has_last_event = false;
static BleChordState s_chord;
static TaskHandle_t s_ble_worker_task = nullptr;

static inline void wake_ble_worker(void) {
    TaskHandle_t task = s_ble_worker_task;
    if (task) {
        xTaskNotifyGive(task);
    }
}

static std::atomic<bool> s_ble_scanning{false};
static std::atomic<bool> s_ble_shutting_down{false};
static std::atomic<bool> s_bg_scan_has_targets{false};
static std::atomic<bool> s_ble_standby{false};
static std::atomic<bool> s_pending_bg_scan_update{false};
static std::atomic<bool> s_ble_client_connected{false};
static std::atomic<bool> s_ble_connecting{false};
static uint32_t s_scan_pause_start_ms = 0; // Protected by s_ble_mutex
static std::string s_connected_device_addr = "";

// Deferred connection/disconnection request structure
static std::mutex s_connect_mutex;
static bool s_pending_connect_req = false;
static bool s_pending_disconnect_req = false;
static std::string s_pending_connect_addr = "";
static uint8_t s_pending_connect_type = 0;

static NimBLEClient* s_ble_client = nullptr;

static inline uint32_t get_time_ms() {
    return (uint32_t)(esp_timer_get_time() / 1000ULL);
}

static bool iequals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (tolower((unsigned char)a[i]) != tolower((unsigned char)b[i])) return false;
    }
    return true;
}

static bool is_hex_char(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static bool normalize_ble_mac(const std::string& raw, std::string& out_mac) {
    size_t start = 0;
    size_t end = raw.size();
    while (start < end && std::isspace((unsigned char)raw[start])) ++start;
    while (end > start && std::isspace((unsigned char)raw[end - 1])) --end;
    const size_t len = end - start;

    char hex[12];
    if (len == 17) {
        char sep = raw[start + 2];
        if (sep != ':' && sep != '-') return false;
        size_t h = 0;
        for (size_t i = 0; i < 17; ++i) {
            char c = raw[start + i];
            if (i == 2 || i == 5 || i == 8 || i == 11 || i == 14) {
                if (c != sep) return false;
            } else {
                if (!is_hex_char(c)) return false;
                hex[h++] = (char)std::toupper((unsigned char)c);
            }
        }
    } else if (len == 12) {
        for (size_t i = 0; i < 12; ++i) {
            char c = raw[start + i];
            if (!is_hex_char(c)) return false;
            hex[i] = (char)std::toupper((unsigned char)c);
        }
    } else {
        return false;
    }

    char formatted[18];
    snprintf(formatted, sizeof(formatted), "%c%c:%c%c:%c%c:%c%c:%c%c:%c%c",
             hex[0], hex[1], hex[2], hex[3], hex[4], hex[5],
             hex[6], hex[7], hex[8], hex[9], hex[10], hex[11]);
    out_mac = formatted;
    return true;
}

static bool normalize_ibeacon_uuid(const std::string& raw, std::string& out_uuid) {
    size_t start = 0;
    size_t end = raw.size();
    while (start < end && std::isspace((unsigned char)raw[start])) ++start;
    while (end > start && std::isspace((unsigned char)raw[end - 1])) --end;
    const size_t len = end - start;

    char hex[32];
    if (len == 36) {
        size_t h = 0;
        for (size_t i = 0; i < 36; ++i) {
            char c = raw[start + i];
            if (i == 8 || i == 13 || i == 18 || i == 23) {
                if (c != '-') return false;
            } else {
                if (!is_hex_char(c)) return false;
                hex[h++] = (char)std::toupper((unsigned char)c);
            }
        }
    } else if (len == 32) {
        for (size_t i = 0; i < 32; ++i) {
            char c = raw[start + i];
            if (!is_hex_char(c)) return false;
            hex[i] = (char)std::toupper((unsigned char)c);
        }
    } else {
        return false;
    }

    char formatted[37];
    snprintf(formatted, sizeof(formatted),
             "%.8s-%.4s-%.4s-%.4s-%.12s",
             &hex[0], &hex[8], &hex[12], &hex[16], &hex[20]);
    out_uuid = formatted;
    return true;
}

static void note_ble_scan_paused_locked(uint32_t now_ms) {
    if (s_scan_pause_start_ms == 0) {
        s_scan_pause_start_ms = (now_ms != 0) ? now_ms : 1U;
    }
}

static void compensate_beacon_scan_pause_locked(uint32_t now_ms, bool clear_pause) {
    if (s_scan_pause_start_ms != 0) {
        int32_t paused_ms = (int32_t)(now_ms - s_scan_pause_start_ms);
        if (paused_ms > 0) {
            for (auto& target : s_beacon_targets) {
                if (target.is_present) {
                    target.last_seen_ms += (uint32_t)paused_ms;
                    if ((int32_t)(now_ms - target.last_seen_ms) < 0) {
                        target.last_seen_ms = now_ms;
                    }
                }
            }
        }
        s_scan_pause_start_ms = clear_pause ? 0U : ((now_ms != 0) ? now_ms : 1U);
    }
}

static void start_background_ble_scan(bool force_restart = false) {
    bool has_paired = false;
    bool has_beacons = false;
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        has_paired = !s_paired_devices.empty();
        has_beacons = !s_beacon_targets.empty();
    }
    const bool is_connected = s_ble_client_connected.load(std::memory_order_relaxed);
    const bool has_targets = has_beacons || (!is_connected && has_paired);
    s_bg_scan_has_targets.store(has_targets, std::memory_order_relaxed);

    if (s_ble_shutting_down.load(std::memory_order_relaxed) ||
        s_ble_connecting.load(std::memory_order_relaxed) ||
        s_ble_scanning.load(std::memory_order_relaxed)) {
        return;
    }
    if (!NimBLEDevice::isInitialized()) return;

    NimBLEScan* pScan = NimBLEDevice::getScan();
    if (!pScan) return;

    if (is_connected && !has_beacons) {
        if (pScan->isScanning()) {
            pScan->stop();
        }
        return;
    }

    if (force_restart && pScan->isScanning()) {
        pScan->stop();
    }

    const bool standby = s_ble_standby.load(std::memory_order_relaxed);
    pScan->clearResults();
    pScan->setMaxResults(0);
    pScan->setActiveScan(false); // Passive scan
    pScan->setDuplicateFilter(false);
    if (has_targets) {
        // Track paired buttons and beacon RSSI while leaving >=80% RF airtime (96% in standby) for Wi-Fi coexistence
        pScan->setInterval(standby ? 500 : 100);
        pScan->setWindow(20);
    } else {
        // Low-overhead passive iBeacon discovery (~8% active / ~2% standby) when no targets are configured
        pScan->setInterval(standby ? 1000 : 250);
        pScan->setWindow(20);
    }
    if (pScan->start(0, false, true)) {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        compensate_beacon_scan_pause_locked(get_time_ms(), true);
    }
}

// ============================================================================
// NVS Persistence
// ============================================================================
static void load_paired_ble_devices(void) {
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        s_paired_devices.clear();
    }
    nvs_handle_t handle;
    esp_err_t err = nvs_open("ble_cfg", NVS_READONLY, &handle);
    if (err == ESP_OK) {
        size_t required_size = 0;
        err = nvs_get_str(handle, "paired", nullptr, &required_size);
        if (err == ESP_OK && required_size > 0) {
            if (required_size > MAX_BLE_NVS_JSON_LEN) {
                ESP_LOGW(TAG, "Paired BLE NVS blob too large (%zu > %zu bytes), ignoring",
                         required_size, MAX_BLE_NVS_JSON_LEN);
            } else {
                char* buf = (char*)malloc(required_size);
                if (!buf) {
                    ESP_LOGE(TAG, "Failed to allocate %zu bytes for paired BLE NVS load", required_size);
                } else {
                    err = nvs_get_str(handle, "paired", buf, &required_size);
                    if (err != ESP_OK) {
                        ESP_LOGW(TAG, "Failed to read paired BLE devices from NVS: %s", esp_err_to_name(err));
                    } else {
                        cJSON* root = cJSON_Parse(buf);
                        if (!root || !cJSON_IsArray(root)) {
                            ESP_LOGW(TAG, "Invalid paired BLE devices JSON in NVS");
                        } else {
                            std::lock_guard<std::mutex> lock(s_ble_mutex);
                            int sz = cJSON_GetArraySize(root);
                            for (int i = 0; i < sz; i++) {
                                if (s_paired_devices.size() >= MAX_PAIRED_DEVICES) {
                                    ESP_LOGW(TAG, "Paired BLE devices in NVS exceeded cap (%zu), truncating",
                                             MAX_PAIRED_DEVICES);
                                    break;
                                }
                                cJSON* itm = cJSON_GetArrayItem(root, i);
                                if (!itm) continue;
                                cJSON* addr = cJSON_GetObjectItem(itm, "address");
                                if (!addr) addr = cJSON_GetObjectItem(itm, "mac");
                                cJSON* name = cJSON_GetObjectItem(itm, "name");
                                cJSON* rssi = cJSON_GetObjectItem(itm, "rssi");
                                cJSON* bonded = cJSON_GetObjectItem(itm, "bonded");
                                cJSON* batt = cJSON_GetObjectItem(itm, "battery_pct");
                                cJSON* atype = cJSON_GetObjectItem(itm, "addr_type");

                                PairedDevice dev;
                                dev.address = (addr && cJSON_IsString(addr)) ? addr->valuestring : "";
                                dev.name = (name && cJSON_IsString(name)) ? name->valuestring : "Paired Controller";
                                dev.rssi = (rssi && cJSON_IsNumber(rssi)) ? (int8_t)rssi->valueint : -60;
                                dev.connected = false;
                                dev.bonded = (!bonded || cJSON_IsTrue(bonded));
                                dev.battery_pct = (batt && cJSON_IsNumber(batt)) ? batt->valueint : 100;
                                dev.addr_type = (atype && cJSON_IsNumber(atype)) ? (uint8_t)atype->valueint : 0;

                                if (!dev.address.empty()) {
                                    s_paired_devices.push_back(dev);
                                }
                            }
                        }
                        if (root) cJSON_Delete(root);
                    }
                    free(buf);
                }
            }
        } else if (err != ESP_ERR_NVS_NOT_FOUND && err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to query paired BLE NVS size: %s", esp_err_to_name(err));
        }
        nvs_close(handle);
    } else if (err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGW(TAG, "Failed to open NVS 'ble_cfg' for reading paired devices: %s", esp_err_to_name(err));
    }
    size_t loaded_count = 0;
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        loaded_count = s_paired_devices.size();
    }
    ESP_LOGI(TAG, "Loaded %u paired BLE devices from NVS", (unsigned)loaded_count);
}

static void persist_paired_ble_devices(void) {
    cJSON* arr = cJSON_CreateArray();
    if (!arr) {
        ESP_LOGE(TAG, "Failed to allocate cJSON array for paired BLE devices");
        return;
    }
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        for (const auto& dev : s_paired_devices) {
            cJSON* itm = cJSON_CreateObject();
            if (!itm) continue;
            cJSON_AddStringToObject(itm, "address", dev.address.c_str());
            cJSON_AddStringToObject(itm, "name", dev.name.c_str());
            cJSON_AddNumberToObject(itm, "rssi", dev.rssi);
            cJSON_AddBoolToObject(itm, "bonded", dev.bonded);
            cJSON_AddNumberToObject(itm, "battery_pct", dev.battery_pct);
            cJSON_AddNumberToObject(itm, "addr_type", dev.addr_type);
            cJSON_AddItemToArray(arr, itm);
        }
    }
    char* json_str = cJSON_PrintUnformatted(arr);
    cJSON_Delete(arr);

    if (!json_str) {
        ESP_LOGE(TAG, "Failed to serialize paired BLE devices JSON");
        return;
    }

    if (strlen(json_str) >= MAX_BLE_NVS_JSON_LEN) {
        ESP_LOGE(TAG, "Paired BLE devices JSON exceeds NVS cap (%zu >= %zu bytes), refusing to persist",
                 strlen(json_str), MAX_BLE_NVS_JSON_LEN);
        free(json_str);
        return;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open("ble_cfg", NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open NVS 'ble_cfg' for paired devices: %s", esp_err_to_name(err));
        free(json_str);
        return;
    }
    err = nvs_set_str(handle, "paired", json_str);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to write paired BLE devices to NVS: %s", esp_err_to_name(err));
    } else {
        err = nvs_commit(handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to commit paired BLE devices to NVS: %s", esp_err_to_name(err));
        }
    }
    nvs_close(handle);
    free(json_str);
}

static void load_beacon_targets(void) {
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        s_beacon_targets.clear();
    }
    nvs_handle_t handle;
    esp_err_t err = nvs_open("ble_cfg", NVS_READONLY, &handle);
    if (err == ESP_OK) {
        size_t required_size = 0;
        err = nvs_get_str(handle, "targets", nullptr, &required_size);
        if (err == ESP_OK && required_size > 0) {
            if (required_size > MAX_BLE_NVS_JSON_LEN) {
                ESP_LOGW(TAG, "Beacon targets NVS blob too large (%zu > %zu bytes), ignoring",
                         required_size, MAX_BLE_NVS_JSON_LEN);
            } else {
                char* buf = (char*)malloc(required_size);
                if (!buf) {
                    ESP_LOGE(TAG, "Failed to allocate %zu bytes for beacon targets NVS load", required_size);
                } else {
                    err = nvs_get_str(handle, "targets", buf, &required_size);
                    if (err != ESP_OK) {
                        ESP_LOGW(TAG, "Failed to read beacon targets from NVS: %s", esp_err_to_name(err));
                    } else {
                        cJSON* root = cJSON_Parse(buf);
                        if (!root || !cJSON_IsArray(root)) {
                            ESP_LOGW(TAG, "Invalid beacon targets JSON in NVS");
                        } else {
                            std::lock_guard<std::mutex> lock(s_ble_mutex);
                            int sz = cJSON_GetArraySize(root);
                            for (int i = 0; i < sz; i++) {
                                if (s_beacon_targets.size() >= MAX_BEACON_TARGETS) {
                                    ESP_LOGW(TAG, "Beacon targets in NVS exceeded cap (%zu), truncating",
                                             MAX_BEACON_TARGETS);
                                    break;
                                }
                                cJSON* itm = cJSON_GetArrayItem(root, i);
                                if (!itm) continue;
                                cJSON* uuid = cJSON_GetObjectItem(itm, "uuid");
                                cJSON* mac = cJSON_GetObjectItem(itm, "mac");
                                if (!mac) mac = cJSON_GetObjectItem(itm, "address");
                                cJSON* name = cJSON_GetObjectItem(itm, "name");
                                cJSON* enter_rssi = cJSON_GetObjectItem(itm, "enter_rssi");
                                cJSON* exit_timeout = cJSON_GetObjectItem(itm, "exit_timeout_s");
                                if (!exit_timeout) exit_timeout = cJSON_GetObjectItem(itm, "exit_timeout");

                                BeaconTarget b;
                                b.uuid = (uuid && cJSON_IsString(uuid)) ? uuid->valuestring : "";
                                b.mac = (mac && cJSON_IsString(mac)) ? mac->valuestring : "";
                                b.name = (name && cJSON_IsString(name)) ? name->valuestring : "Phone Beacon";
                                b.enter_rssi = (enter_rssi && cJSON_IsNumber(enter_rssi)) ? enter_rssi->valueint : -75;
                                b.exit_timeout_s = (exit_timeout && cJSON_IsNumber(exit_timeout)) ? exit_timeout->valueint : 20;

                                if (!b.uuid.empty() || !b.mac.empty()) {
                                    s_beacon_targets.push_back(b);
                                }
                            }
                        }
                        if (root) cJSON_Delete(root);
                    }
                    free(buf);
                }
            }
        } else if (err != ESP_ERR_NVS_NOT_FOUND && err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to query beacon targets NVS size: %s", esp_err_to_name(err));
        }
        nvs_close(handle);
    } else if (err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGW(TAG, "Failed to open NVS 'ble_cfg' for reading beacon targets: %s", esp_err_to_name(err));
    }
    size_t loaded_count = 0;
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        loaded_count = s_beacon_targets.size();
    }
    ESP_LOGI(TAG, "Loaded %u beacon targets from NVS", (unsigned)loaded_count);
}

static void persist_beacon_targets(void) {
    cJSON* arr = cJSON_CreateArray();
    if (!arr) {
        ESP_LOGE(TAG, "Failed to allocate cJSON array for beacon targets");
        return;
    }
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        for (const auto& b : s_beacon_targets) {
            cJSON* itm = cJSON_CreateObject();
            if (!itm) continue;
            cJSON_AddStringToObject(itm, "uuid", b.uuid.c_str());
            cJSON_AddStringToObject(itm, "mac", b.mac.c_str());
            cJSON_AddStringToObject(itm, "name", b.name.c_str());
            cJSON_AddNumberToObject(itm, "enter_rssi", b.enter_rssi);
            cJSON_AddNumberToObject(itm, "exit_timeout_s", b.exit_timeout_s);
            cJSON_AddItemToArray(arr, itm);
        }
    }
    char* json_str = cJSON_PrintUnformatted(arr);
    cJSON_Delete(arr);

    if (!json_str) {
        ESP_LOGE(TAG, "Failed to serialize beacon targets JSON");
        return;
    }

    if (strlen(json_str) >= MAX_BLE_NVS_JSON_LEN) {
        ESP_LOGE(TAG, "Beacon targets JSON exceeds NVS cap (%zu >= %zu bytes), refusing to persist",
                 strlen(json_str), MAX_BLE_NVS_JSON_LEN);
        free(json_str);
        return;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open("ble_cfg", NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open NVS 'ble_cfg' for beacon targets: %s", esp_err_to_name(err));
        free(json_str);
        return;
    }
    err = nvs_set_str(handle, "targets", json_str);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to write beacon targets to NVS: %s", esp_err_to_name(err));
    } else {
        err = nvs_commit(handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to commit beacon targets to NVS: %s", esp_err_to_name(err));
        }
    }
    nvs_close(handle);
    free(json_str);
}

// ============================================================================
// Event Dispatching
// ============================================================================
static std::string format_chord(const std::vector<std::string>& keys) {
    std::string out;
    for (size_t i = 0; i < keys.size(); i++) {
        if (i > 0) out += "+";
        out += keys[i];
    }
    return out;
}

static void append_ble_event_json(cJSON* obj, const BleButtonEvent& ev) {
    cJSON_AddStringToObject(obj, "address", ev.device_address.c_str());
    cJSON_AddStringToObject(obj, "device_address", ev.device_address.c_str());
    cJSON_AddStringToObject(obj, "device_name", ev.device_name.c_str());
    cJSON_AddStringToObject(obj, "button", ev.button_name.c_str());
    cJSON_AddStringToObject(obj, "button_name", ev.button_name.c_str());
    cJSON_AddStringToObject(obj, "action", ev.action.c_str());
    cJSON_AddNumberToObject(obj, "timestamp_ms", ev.timestamp_ms);
    if (!ev.combo.empty()) {
        cJSON_AddStringToObject(obj, "combo", ev.combo.c_str());
    }
    if (ev.hold_seconds > 0) {
        cJSON_AddNumberToObject(obj, "hold_seconds", ev.hold_seconds);
    }
}

static void fire_ble_button_event(const std::string& addr, const std::string& name,
                                  const std::string& btn, const std::string& act,
                                  const std::string& combo = "", uint32_t hold_seconds = 0) {
    uint32_t now_ms = get_time_ms();
    BleButtonEvent ev = { addr, name, btn, act, now_ms, combo, hold_seconds };
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        s_last_ble_event = ev;
        s_has_last_event = true;
        if (s_recent_ble_events.size() >= MAX_RECENT_BLE_EVENTS) {
            s_recent_ble_events.erase(s_recent_ble_events.begin());
        }
        s_recent_ble_events.push_back(ev);
    }

    cJSON* root = cJSON_CreateObject();
    if (root) {
        cJSON_AddStringToObject(root, "type", "ble_event");
        append_ble_event_json(root, ev);
        char* json_str = cJSON_PrintUnformatted(root);
        if (json_str) {
            broadcast_ws_raw(json_str);
            free(json_str);
        }
        cJSON_Delete(root);
    }

    ESP_LOGI(TAG, "[BLE BTN] %s '%s' from %s (%s) combo=%s hold_s=%lu",
             act.c_str(), btn.c_str(), name.c_str(), addr.c_str(), combo.c_str(), (unsigned long)hold_seconds);
    can_engine_on_ble_event(addr, btn, act, combo, hold_seconds);
}

static void append_ble_device_json(cJSON* obj, const std::string& address, const std::string& name,
                                   int rssi, bool connected, bool bonded, int battery_pct = -1) {
    cJSON_AddStringToObject(obj, "address", address.c_str());
    cJSON_AddStringToObject(obj, "name", name.c_str());
    cJSON_AddNumberToObject(obj, "rssi", rssi);
    cJSON_AddBoolToObject(obj, "connected", connected);
    cJSON_AddBoolToObject(obj, "bonded", bonded);
    if (battery_pct >= 0) {
        cJSON_AddNumberToObject(obj, "battery_pct", battery_pct);
    }
}

static void emit_ws_ble_beacon(const char* evt, const std::string& uuid, const std::string& mac,
                               const std::string& name, int rssi, uint16_t major, uint16_t minor,
                               bool is_present) {
    cJSON* b_evt = cJSON_CreateObject();
    if (!b_evt) return;
    cJSON_AddStringToObject(b_evt, "type", "ble_beacon");
    cJSON_AddStringToObject(b_evt, "event", evt);
    cJSON_AddStringToObject(b_evt, "uuid", uuid.c_str());
    cJSON_AddStringToObject(b_evt, "mac", mac.c_str());
    cJSON_AddStringToObject(b_evt, "name", name.c_str());
    cJSON_AddBoolToObject(b_evt, "is_present", is_present);
    cJSON_AddNumberToObject(b_evt, "rssi", rssi);
    cJSON_AddNumberToObject(b_evt, "major", major);
    cJSON_AddNumberToObject(b_evt, "minor", minor);
    char* b_out = cJSON_PrintUnformatted(b_evt);
    if (b_out) {
        broadcast_ws_raw(b_out);
        free(b_out);
    }
    cJSON_Delete(b_evt);
}

static void enqueue_button_dispatch_locked(const std::string& addr, const std::string& name,
                                           const std::string& btn, const std::string& act,
                                           const std::string& combo, uint32_t hold_s) {
    if (s_pending_button_events.size() >= BLE_MAX_PENDING_EVENTS) {
        s_pending_button_events.erase(s_pending_button_events.begin());
    }
    s_pending_button_events.push_back({addr, name, btn, act, combo, hold_s});
}

static void enqueue_device_dispatch_locked(const std::string& event, const std::string& addr,
                                           const std::string& name, int rssi) {
    if (s_pending_device_events.size() >= BLE_MAX_PENDING_EVENTS) {
        s_pending_device_events.erase(s_pending_device_events.begin());
    }
    s_pending_device_events.push_back({event, addr, name, rssi});
}

static void enqueue_beacon_dispatch_locked(const PendingBeaconDispatch& pe) {
    if (s_pending_beacon_events.size() >= BLE_MAX_PENDING_EVENTS) {
        s_pending_beacon_events.erase(s_pending_beacon_events.begin());
    }
    s_pending_beacon_events.push_back(pe);
}

static void flush_chord_release_locked(bool* out_was_settling, bool* out_had_chord,
                                       std::string* out_addr, std::string* out_name,
                                       std::string* out_chord, bool* out_is_combo,
                                       uint32_t* out_hold_s) {
    *out_had_chord = (s_chord.phase != ChordPhase::IDLE && !s_chord.peak_keys.empty());
    *out_was_settling = (s_chord.phase == ChordPhase::SETTLING);
    if (*out_had_chord) {
        *out_addr = s_chord.addr;
        *out_name = s_chord.name;
        *out_chord = format_chord(s_chord.peak_keys);
        *out_is_combo = (s_chord.peak_keys.size() > 1);
        *out_hold_s = s_chord.hold_seconds;
    }
    s_chord = {};
}

static bool enqueue_chord_release_locked(void) {
    bool was_settling = false;
    bool had_chord = false;
    bool is_combo = false;
    uint32_t hold_s = 0;
    std::string addr, name, chord;
    flush_chord_release_locked(&was_settling, &had_chord, &addr, &name, &chord, &is_combo, &hold_s);
    if (!had_chord) return false;
    const std::string combo_str = is_combo ? chord : "";
    if (was_settling) {
        enqueue_button_dispatch_locked(addr, name, chord, "press", combo_str, 0);
    }
    enqueue_button_dispatch_locked(addr, name, chord, "release", combo_str, hold_s);
    return true;
}

static std::vector<std::string> parse_hid_report_keys(const uint8_t* pData, size_t length) {
    std::vector<std::string> keys;
    if (!pData || length == 0) return keys;

    bool all_zero = true;
    for (size_t i = 0; i < length; i++) {
        if (pData[i] != 0) {
            all_zero = false;
            break;
        }
    }
    if (all_zero) return keys;

    bool has_kbd_keys = false;
    if (length >= 8) {
        for (size_t k = 2; k < 8; k++) {
            if (pData[k] != 0) {
                has_kbd_keys = true;
                break;
            }
        }
        if (!has_kbd_keys && length == 8) {
            return keys;
        }
    }

    if (has_kbd_keys) {
        // Standard HID Keyboard report: 8 bytes [modifier, reserved, keycode1..6]
        for (size_t k = 2; k < length && k < 8; k++) {
            uint8_t kc = pData[k];
            if (kc == 0) continue;
            std::string k_str;
            switch (kc) {
                case 0x1E: k_str = "key_1"; break;
                case 0x1F: k_str = "key_2"; break;
                case 0x20: k_str = "key_3"; break;
                case 0x21: k_str = "key_4"; break;
                case 0x22: k_str = "key_5"; break;
                case 0x23: k_str = "key_6"; break;
                case 0x24: k_str = "key_7"; break;
                case 0x25: k_str = "key_8"; break;
                case 0x26: k_str = "key_9"; break;
                case 0x27: k_str = "key_0"; break;
                case 0x28: k_str = "enter"; break;
                case 0x29: k_str = "escape"; break;
                case 0x2A: k_str = "backspace"; break;
                case 0x2B: k_str = "tab"; break;
                case 0x2C: k_str = "space"; break;
                case 0x4F: k_str = "arrow_right"; break;
                case 0x50: k_str = "arrow_left"; break;
                case 0x51: k_str = "arrow_down"; break;
                case 0x52: k_str = "arrow_up"; break;
                case 0x80: k_str = "volume_up"; break;
                case 0x81: k_str = "volume_down"; break;
                default:
                    if (kc >= 0x04 && kc <= 0x1D) {
                        k_str = std::string("key_") + static_cast<char>('a' + (kc - 0x04));
                    } else {
                        char hbuf[16];
                        snprintf(hbuf, sizeof(hbuf), "hid_%02X", kc);
                        k_str = hbuf;
                    }
                    break;
            }
            if (!k_str.empty()) keys.push_back(k_str);
        }
    } else {
        // Consumer Control / Media / Macro Keypad reports
        uint16_t usage = 0;
        if (length >= 3 && pData[0] == 0x00 && (pData[1] != 0 || pData[2] != 0)) {
            usage = pData[1] | ((uint16_t)pData[2] << 8);
        } else if (length >= 2 && (pData[0] != 0 || pData[1] != 0)) {
            usage = pData[0] | ((uint16_t)pData[1] << 8);
        } else {
            usage = pData[0];
        }

        // Exact HID Consumer Page usages first; only apply 6-bit bitfield fallback when no upper bits are set.
        if (usage == 0xE9) keys.push_back("volume_up");
        else if (usage == 0xEA) keys.push_back("volume_down");
        else if (usage == 0xE2) keys.push_back("mute");
        else if (usage == 0xCD) keys.push_back("play_pause");
        else if (usage == 0xB5) keys.push_back("next_track");
        else if (usage == 0xB6) keys.push_back("prev_track");
        else if (usage == 0x28) keys.push_back("shutter");
        else if ((usage & ~0x3FU) == 0) {
            if (usage & 0x01) keys.push_back("volume_up");
            if (usage & 0x02) keys.push_back("volume_down");
            if (usage & 0x04) keys.push_back("play_pause");
            if (usage & 0x08) keys.push_back("next_track");
            if (usage & 0x10) keys.push_back("prev_track");
            if (usage & 0x20) keys.push_back("mute");
        } else {
            char hbuf[16];
            snprintf(hbuf, sizeof(hbuf), "hid_%02X", (uint8_t)(usage & 0xFF));
            keys.push_back(hbuf);
        }
    }

    std::sort(keys.begin(), keys.end());
    keys.erase(std::unique(keys.begin(), keys.end()), keys.end());
    return keys;
}

// ============================================================================
// HID Report Notification Parser
// ============================================================================
static void on_hid_report_notify(NimBLERemoteCharacteristic* pChar, uint8_t* pData, size_t length, bool isNotify) {
    (void)pChar;
    (void)isNotify;
    if (length == 0 || !pData) return;

    std::vector<std::string> keys = parse_hid_report_keys(pData, length);
    uint32_t now_ms = get_time_ms();

    if (!keys.empty()) {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        std::string addr = s_connected_device_addr.empty() ? "BLE Device" : s_connected_device_addr;
        std::string name = "BLE Controller";
        for (const auto& dev : s_paired_devices) {
            if (iequals(dev.address, addr)) {
                name = dev.name;
                break;
            }
        }

        if (s_chord.phase == ChordPhase::IDLE) {
            s_chord.phase = ChordPhase::SETTLING;
            s_chord.addr = addr;
            s_chord.name = name;
            s_chord.current_keys = keys;
            s_chord.peak_keys = keys;
            s_chord.first_down_ms = now_ms;
            s_chord.settle_deadline_ms = now_ms + BLE_COMBO_SETTLE_MS;
            s_chord.next_hold_tick_ms = 0;
            s_chord.hold_seconds = 0;
        } else if (s_chord.phase == ChordPhase::SETTLING) {
            s_chord.current_keys = keys;
            bool grew = false;
            for (const auto& k : keys) {
                if (std::find(s_chord.peak_keys.begin(), s_chord.peak_keys.end(), k) == s_chord.peak_keys.end()) {
                    s_chord.peak_keys.push_back(k);
                    grew = true;
                }
            }
            if (grew) {
                std::sort(s_chord.peak_keys.begin(), s_chord.peak_keys.end());
                s_chord.settle_deadline_ms = now_ms + BLE_COMBO_SETTLE_MS;
            }
        } else {
            // PRESSED: track active keys accurately so partial releases do not emit spurious presses.
            s_chord.current_keys = keys;
        }
        wake_ble_worker();
    } else {
        bool queued = false;
        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            queued = enqueue_chord_release_locked();
        }
        if (queued) {
            wake_ble_worker();
        }
    }
}

// ============================================================================
// Client Callbacks
// ============================================================================
class ClientCallbacks : public NimBLEClientCallbacks {
    void onConnect(NimBLEClient* pClient) override {
        std::string addr = pClient->getPeerAddress().toString();
        ESP_LOGI(TAG, "Connected to %s", addr.c_str());
        if (NimBLEScan* pScan = NimBLEDevice::getScan()) {
            pScan->stop();
        }
        s_ble_scanning.store(false, std::memory_order_relaxed);

        std::string dev_name = "";
        int cur_rssi = 0;
        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            note_ble_scan_paused_locked(get_time_ms());
            s_ble_client_connected.store(true, std::memory_order_relaxed);
            s_connected_device_addr = addr;
            for (auto& dev : s_paired_devices) {
                if (iequals(dev.address, addr)) {
                    dev.connected = true;
                    dev.reconnect_backoff_ms = 0;
                    dev.last_connect_attempt_ms = 0;
                    dev_name = dev.name;
                    cur_rssi = dev.rssi;
                    break;
                }
            }
            enqueue_device_dispatch_locked("connected", addr, dev_name, cur_rssi);
        }
        wake_ble_worker();
    }

    void onDisconnect(NimBLEClient* pClient, int reason) override {
        (void)pClient;
        std::string disc_addr;
        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            disc_addr = s_connected_device_addr;
            s_ble_client_connected.store(false, std::memory_order_relaxed);
            s_connected_device_addr = "";
            enqueue_chord_release_locked();
            for (auto& dev : s_paired_devices) {
                if (iequals(dev.address, disc_addr)) {
                    dev.connected = false;
                    break;
                }
            }
            enqueue_device_dispatch_locked("disconnected", disc_addr, "", 0);
        }

        ESP_LOGI(TAG, "Disconnected from %s (reason: %d)", disc_addr.c_str(), reason);

        // Resume continuous background scan
        start_background_ble_scan();
        wake_ble_worker();
    }
} s_client_callbacks;

static void connect_ble_device(const std::string& address, uint8_t addr_type = 0xFF, const NimBLEAdvertisedDevice* pAdvDev = nullptr) {
    if (address.empty() && !pAdvDev) return;

    s_ble_connecting.store(true, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        note_ble_scan_paused_locked(get_time_ms());
    }
    if (NimBLEScan* pScan = NimBLEDevice::getScan()) {
        pScan->stop();
    }
    s_ble_scanning.store(false, std::memory_order_relaxed);

    if (!s_ble_client) {
        s_ble_client = NimBLEDevice::createClient();
        s_ble_client->setClientCallbacks(&s_client_callbacks, false);
    }

    if (s_ble_client->isConnected()) {
        s_ble_client->disconnect();
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    s_ble_client->setConnectTimeout(3 * 1000);
    // Use 15-30ms interval, slave latency 4, 4.0s timeout so HID remotes don't default to 7.5ms and starve Wi-Fi
    s_ble_client->setConnectionParams(12, 24, 4, 400);
    bool connected = false;
    uint8_t target_type = addr_type;

    if (pAdvDev) {
        ESP_LOGI(TAG, "Direct connecting to advertised device %s (type=%d)...",
                 pAdvDev->getAddress().toString().c_str(), pAdvDev->getAddress().getType());
        connected = s_ble_client->connect(pAdvDev, false);
        if (connected) {
            target_type = pAdvDev->getAddress().getType();
        }
    }

    if (!connected && !address.empty()) {
        if (target_type == 0xFF) {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            for (const auto& dev : s_paired_devices) {
                if (iequals(dev.address, address)) {
                    target_type = dev.addr_type;
                    break;
                }
            }
            if (target_type == 0xFF) {
                for (const auto& dev : s_discovered_devices) {
                    if (iequals(dev.address, address)) {
                        target_type = dev.addr_type;
                        break;
                    }
                }
            }
        }
        if (target_type == 0xFF) {
            uint8_t first_byte = (uint8_t)strtoul(address.substr(0, 2).c_str(), nullptr, 16);
            target_type = ((first_byte & 0xC0) == 0xC0) ? BLE_ADDR_RANDOM : BLE_ADDR_PUBLIC;
        }

        NimBLEAddress bleAddr(address, target_type);
        ESP_LOGD(TAG, "Attempting connection to %s (type=%d)...", address.c_str(), target_type);

        connected = s_ble_client->connect(bleAddr, false);
        if (!connected) {
            uint8_t alt_type = (target_type == BLE_ADDR_RANDOM) ? BLE_ADDR_PUBLIC : BLE_ADDR_RANDOM;
            ESP_LOGD(TAG, "Retrying connection to %s with alternate type (%d)...", address.c_str(), alt_type);
            NimBLEAddress altAddr(address, alt_type);
            connected = s_ble_client->connect(altAddr, false);
            if (connected) {
                target_type = alt_type;
            }
        }
    }

    if (connected) {
        ESP_LOGI(TAG, "Connected to %s! Performing security handshake...", address.c_str());
        s_ble_client->secureConnection();

        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            for (auto& dev : s_paired_devices) {
                if (iequals(dev.address, address)) {
                    dev.addr_type = target_type;
                    dev.connected = true;
                    dev.reconnect_backoff_ms = 0;
                    dev.last_connect_attempt_ms = 0;
                    break;
                }
            }
        }
        persist_paired_ble_devices();

        ESP_LOGI(TAG, "Discovering remote services & subscribing to HID reports...");
        const auto& services = s_ble_client->getServices(true);
        for (NimBLERemoteService* pService : services) {
            if (!pService) continue;
            NimBLEUUID svcUuid = pService->getUUID();
            bool skip_hid_sub = (svcUuid == NimBLEUUID((uint16_t)0x1800) ||
                                 svcUuid == NimBLEUUID((uint16_t)0x1801) ||
                                 svcUuid == NimBLEUUID((uint16_t)0x180A) ||
                                 svcUuid == NimBLEUUID((uint16_t)0x180F));
            ESP_LOGD(TAG, "Service: %s", svcUuid.toString().c_str());
            const auto& chars = pService->getCharacteristics(true);
            for (NimBLERemoteCharacteristic* pChar : chars) {
                if (!pChar) continue;
                NimBLEUUID charUuid = pChar->getUUID();

                // Battery level characteristic (0x2A19)
                if (charUuid == NimBLEUUID((uint16_t)0x2A19) && pChar->canRead()) {
                    uint8_t batt = pChar->readValue<uint8_t>();
                    ESP_LOGI(TAG, "Battery level: %d%%", (int)batt);
                    std::lock_guard<std::mutex> lock(s_ble_mutex);
                    for (auto& dev : s_paired_devices) {
                        if (iequals(dev.address, address)) {
                            dev.battery_pct = batt;
                            break;
                        }
                    }
                    continue;
                }

                if (skip_hid_sub || charUuid == NimBLEUUID((uint16_t)0x2A05)) {
                    continue;
                }

                if (pChar->canNotify()) {
                    if (pChar->subscribe(true, on_hid_report_notify)) {
                        ESP_LOGI(TAG, "  [+] Subscribed (notify) to svc=%s char=%s",
                                 svcUuid.toString().c_str(), charUuid.toString().c_str());
                    }
                } else if (pChar->canIndicate()) {
                    if (pChar->subscribe(false, on_hid_report_notify)) {
                        ESP_LOGI(TAG, "  [+] Subscribed (indicate) to svc=%s char=%s",
                                 svcUuid.toString().c_str(), charUuid.toString().c_str());
                    }
                }
            }
        }
        if (s_ble_client->isConnected()) {
            s_ble_client->updateConnParams(12, 24, 4, 400);
        }
    } else {
        uint32_t next_backoff_ms = BLE_RECONNECT_BACKOFF_MIN_MS;
        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            uint32_t now_ms = get_time_ms();
            for (auto& dev : s_paired_devices) {
                if (iequals(dev.address, address)) {
                    dev.reconnect_backoff_ms = (dev.reconnect_backoff_ms == 0)
                        ? BLE_RECONNECT_BACKOFF_MIN_MS
                        : std::min<uint32_t>(dev.reconnect_backoff_ms * 2U, BLE_RECONNECT_BACKOFF_MAX_MS);
                    dev.last_connect_attempt_ms = now_ms;
                    next_backoff_ms = dev.reconnect_backoff_ms;
                    break;
                }
            }
        }
        ESP_LOGW(TAG, "Connection to %s failed (next retry in %lus). Resuming continuous scan.",
                 address.c_str(), (unsigned long)(next_backoff_ms / 1000U));
    }

    s_ble_connecting.store(false, std::memory_order_relaxed);
    start_background_ble_scan();
}

// ============================================================================
// Scan Callbacks
// ============================================================================
class ScanCallbacks : public NimBLEScanCallbacks {
    void onDiscovered(const NimBLEAdvertisedDevice* advertisedDevice) override {
        bool has_mfg = advertisedDevice->getManufacturerDataCount() > 0;
        bool has_targets = s_bg_scan_has_targets.load(std::memory_order_relaxed);
        bool is_scanning = s_ble_scanning.load(std::memory_order_relaxed);
        if (!is_scanning && !has_targets && !has_mfg) {
            return;
        }

        std::string addr = advertisedDevice->getAddress().toString();
        int8_t rssi = advertisedDevice->getRSSI();
        uint8_t a_type = advertisedDevice->getAddressType();
        std::string name;
        if (is_scanning || has_targets) {
            name = advertisedDevice->getName();
            if (name.empty() || name == "Unknown Device") {
                char short_buf[32];
                std::string end_addr = addr.length() > 8 ? addr.substr(addr.length() - 8) : addr;
                snprintf(short_buf, sizeof(short_buf), "BLE Device [%s]", end_addr.c_str());
                name = short_buf;
            }
        }

        // 1. Discovery filtering: active user-initiated scan within vehicle range
        if (is_scanning && rssi >= BLE_MIN_RSSI_DISCOVERY) {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            bool exists = false;
            for (auto& dev : s_discovered_devices) {
                if (iequals(dev.address, addr)) {
                    dev.rssi = rssi;
                    dev.addr_type = a_type;
                    if (!name.empty() && name.find("BLE Device") == std::string::npos) {
                        dev.name = name;
                    }
                    exists = true;
                    break;
                }
            }
            if (!exists) {
                DiscoveredDevice nd;
                nd.address = addr;
                nd.name = name;
                nd.rssi = rssi;
                nd.is_connectable = advertisedDevice->isConnectable();
                nd.addr_type = a_type;
                if (s_discovered_devices.size() < MAX_DISCOVERED_DEVICES) {
                    s_discovered_devices.push_back(nd);
                } else {
                    auto weakest_it = std::min_element(
                        s_discovered_devices.begin(), s_discovered_devices.end(),
                        [](const DiscoveredDevice& a, const DiscoveredDevice& b) {
                            return a.rssi < b.rssi;
                        });
                    if (weakest_it != s_discovered_devices.end() && rssi > weakest_it->rssi) {
                        *weakest_it = nd;
                    }
                }
            }
        }

        // 2. Check if device is paired and needs reconnection
        bool send_prox = false;
        bool try_connect = false;
        if (has_targets) {
            uint32_t now = get_time_ms();
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            for (auto& paired : s_paired_devices) {
                if (iequals(paired.address, addr)) {
                    paired.rssi = rssi;
                    paired.addr_type = a_type;
                    if (!name.empty() && name.find("BLE Device") == std::string::npos) {
                        paired.name = name;
                    }
                    if (paired.last_prox_send_ms == 0 || (now - paired.last_prox_send_ms > 2000)) {
                        paired.last_prox_send_ms = now;
                        enqueue_device_dispatch_locked("proximity", addr, paired.name, rssi);
                        send_prox = true;
                    }
                    uint32_t wait_ms = paired.reconnect_backoff_ms ? paired.reconnect_backoff_ms : BLE_RECONNECT_BACKOFF_MIN_MS;
                    if (!s_ble_client_connected.load(std::memory_order_relaxed) &&
                        !s_ble_connecting.load(std::memory_order_relaxed) &&
                        (paired.last_connect_attempt_ms == 0 || (now - paired.last_connect_attempt_ms >= wait_ms))) {
                        paired.last_connect_attempt_ms = now;
                        try_connect = true;
                    }
                    break;
                }
            }
        }
        if (try_connect) {
            std::lock_guard<std::mutex> clock(s_connect_mutex);
            s_pending_connect_addr = addr;
            s_pending_connect_type = a_type;
            s_pending_connect_req = true;
        }
        if (send_prox || try_connect) {
            wake_ble_worker();
        }

        // 3. iBeacon / Proximity Detection (scan all manufacturer AD records in multi-AD payloads)
        std::string adv_uuid = "";
        uint16_t adv_major = 0;
        uint16_t adv_minor = 0;

        if (has_mfg) {
            uint8_t mfg_count = advertisedDevice->getManufacturerDataCount();
            for (uint8_t mfg_idx = 0; mfg_idx < mfg_count; ++mfg_idx) {
                std::string mfg = advertisedDevice->getManufacturerData(mfg_idx);
                if (mfg.length() >= 25 &&
                    (uint8_t)mfg[0] == 0x4C && (uint8_t)mfg[1] == 0x00 &&
                    (uint8_t)mfg[2] == 0x02 && (uint8_t)mfg[3] == 0x15) {

                    char uuid_buf[37];
                    snprintf(uuid_buf, sizeof(uuid_buf),
                             "%02X%02X%02X%02X-%02X%02X-%02X%02X-%02X%02X-%02X%02X%02X%02X%02X%02X",
                             (uint8_t)mfg[4], (uint8_t)mfg[5], (uint8_t)mfg[6], (uint8_t)mfg[7],
                             (uint8_t)mfg[8], (uint8_t)mfg[9],
                             (uint8_t)mfg[10], (uint8_t)mfg[11],
                             (uint8_t)mfg[12], (uint8_t)mfg[13],
                             (uint8_t)mfg[14], (uint8_t)mfg[15], (uint8_t)mfg[16], (uint8_t)mfg[17], (uint8_t)mfg[18], (uint8_t)mfg[19]);
                    adv_uuid = uuid_buf;
                    adv_major = ((uint8_t)mfg[20] << 8) | (uint8_t)mfg[21];
                    adv_minor = ((uint8_t)mfg[22] << 8) | (uint8_t)mfg[23];

                    uint32_t now_ms = get_time_ms();
                    std::lock_guard<std::mutex> lock(s_ble_mutex);
                    bool b_exists = false;
                    for (auto& b : s_discovered_beacons) {
                        if (iequals(b.uuid, adv_uuid)) {
                            b.rssi = rssi;
                            b.mac = addr;
                            b.major = adv_major;
                            b.minor = adv_minor;
                            b.last_seen_ms = now_ms;
                            b_exists = true;
                            break;
                        }
                    }
                    if (!b_exists) {
                        if (s_discovered_beacons.size() >= MAX_DISCOVERED_BEACONS) {
                            s_discovered_beacons.erase(s_discovered_beacons.begin());
                        }
                        DiscoveredBeacon nb;
                        nb.uuid = adv_uuid;
                        nb.mac = addr;
                        nb.rssi = rssi;
                        nb.major = adv_major;
                        nb.minor = adv_minor;
                        nb.last_seen_ms = now_ms;
                        s_discovered_beacons.push_back(nb);
                    }
                    break;
                }
            }
        }

        // 4. Match against configured beacon targets (never hold s_ble_mutex across WS/CAN/MQTT dispatch)
        if (has_targets) {
            bool queued_beacon = false;
            uint32_t now_ms = get_time_ms();
            {
                std::lock_guard<std::mutex> lock(s_ble_mutex);
                for (auto& target : s_beacon_targets) {
                    bool match = false;
                    if (!adv_uuid.empty() && !target.uuid.empty() && iequals(target.uuid, adv_uuid)) {
                        match = true;
                    }
                    if (!target.mac.empty() && iequals(target.mac, addr)) {
                        match = true;
                    }

                    if (match) {
                        target.last_seen_ms = now_ms;
                        if (target.smoothed_rssi < -99.0f) {
                            target.smoothed_rssi = (float)rssi;
                        } else {
                            target.smoothed_rssi = 0.35f * (float)rssi + 0.65f * target.smoothed_rssi;
                        }
                        target.last_rssi = (int)roundf(target.smoothed_rssi);
                        if (adv_major != 0) target.major = adv_major;
                        if (adv_minor != 0) target.minor = adv_minor;
                        target.mac = addr; // track dynamic MAC

                        if (!target.is_present && target.last_rssi >= target.enter_rssi) {
                            target.is_present = true;
                            target.last_prox_send_ms = now_ms;
                            ESP_LOGI(TAG, "[BEACON] Target '%s' ENTERED (Smoothed RSSI %d dBm >= %d dBm)",
                                     target.name.c_str(), target.last_rssi, target.enter_rssi);
                            enqueue_beacon_dispatch_locked({"enter", target.uuid, addr, target.name, target.last_rssi, target.major, target.minor});
                            queued_beacon = true;
                        } else if (target.is_present && (now_ms - target.last_prox_send_ms > 2500)) {
                            target.last_prox_send_ms = now_ms;
                            enqueue_beacon_dispatch_locked({"proximity", target.uuid, addr, target.name, target.last_rssi, target.major, target.minor});
                            queued_beacon = true;
                        }
                    }
                }
            }

            if (queued_beacon) {
                wake_ble_worker();
            }
        }
    }

    void onScanEnd(const NimBLEScanResults& scanResults, int reason) override {
        s_ble_scanning.store(false, std::memory_order_relaxed);
        ESP_LOGI(TAG, "Active scan ended (reason: %d, count: %d)", reason, scanResults.getCount());

        start_background_ble_scan();
    }
} s_scan_callbacks;

// ============================================================================
// BLE Worker Task (Chord settle/hold timers, deferred connections & beacon watchdog)
// ============================================================================
static void ble_worker_task(void* pvParameters) {
    (void)pvParameters;
    s_ble_worker_task = xTaskGetCurrentTaskHandle();
    uint32_t last_exit_check = get_time_ms();

    while (!s_ble_shutting_down.load(std::memory_order_relaxed)) {
        // 1. Service chord settle (85 ms) and 1-second hold ticks cleanly off the worker task
        while (true) {
            std::string ev_addr, ev_name, ev_btn, ev_act, ev_combo;
            uint32_t ev_hold_s = 0;
            bool has_event = false;
            uint32_t now_ms = get_time_ms();
            {
                std::lock_guard<std::mutex> lock(s_ble_mutex);
                if (s_chord.phase == ChordPhase::SETTLING && (int32_t)(now_ms - s_chord.settle_deadline_ms) >= 0) {
                    s_chord.phase = ChordPhase::PRESSED;
                    s_chord.hold_seconds = 0;
                    s_chord.next_hold_tick_ms = s_chord.first_down_ms + BLE_HOLD_TICK_MS;
                    ev_addr = s_chord.addr;
                    ev_name = s_chord.name;
                    ev_btn = format_chord(s_chord.peak_keys);
                    ev_act = "press";
                    ev_combo = (s_chord.peak_keys.size() > 1) ? ev_btn : "";
                    has_event = true;
                } else if (s_chord.phase == ChordPhase::PRESSED && (int32_t)(now_ms - s_chord.next_hold_tick_ms) >= 0) {
                    s_chord.hold_seconds += 1;
                    if ((int32_t)(now_ms - s_chord.next_hold_tick_ms) >= (int32_t)BLE_HOLD_TICK_MS) {
                        s_chord.next_hold_tick_ms = now_ms + BLE_HOLD_TICK_MS;
                    } else {
                        s_chord.next_hold_tick_ms += BLE_HOLD_TICK_MS;
                    }
                    ev_addr = s_chord.addr;
                    ev_name = s_chord.name;
                    ev_btn = format_chord(s_chord.peak_keys);
                    ev_act = "hold_" + std::to_string(s_chord.hold_seconds) + "s";
                    ev_combo = (s_chord.peak_keys.size() > 1) ? ev_btn : "";
                    ev_hold_s = s_chord.hold_seconds;
                    has_event = true;
                }
            }
            if (!has_event) break;
            fire_ble_button_event(ev_addr, ev_name, ev_btn, ev_act, ev_combo, ev_hold_s);
        }

        // 1b. Drain pending events offloaded from nimble_host callbacks
        PsramVector<PendingButtonDispatch> pending_btns;
        PsramVector<PendingDeviceDispatch> pending_devs;
        PsramVector<PendingBeaconDispatch> pending_beacons;
        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            if (!s_pending_button_events.empty()) pending_btns.swap(s_pending_button_events);
            if (!s_pending_device_events.empty()) pending_devs.swap(s_pending_device_events);
            if (!s_pending_beacon_events.empty()) pending_beacons.swap(s_pending_beacon_events);
        }

        for (const auto& ev : pending_btns) {
            fire_ble_button_event(ev.addr, ev.name, ev.btn, ev.act, ev.combo, ev.hold_seconds);
        }

        for (const auto& ev : pending_devs) {
            can_engine_on_ble_device_event(ev.addr, ev.event, (int8_t)ev.rssi, ev.name);
        }

        for (const auto& pe : pending_beacons) {
            bool is_present = (strcmp(pe.evt, "exit") != 0);
            emit_ws_ble_beacon(pe.evt, pe.uuid, pe.mac, pe.name, pe.last_rssi, pe.major, pe.minor, is_present);
            can_engine_on_ble_beacon_event(pe.uuid, pe.evt, (int8_t)pe.last_rssi, pe.major, pe.minor, pe.mac, pe.name);
        }

        // 2. Process deferred disconnect / connect request
        std::string connect_addr = "";
        uint8_t connect_type = 0;
        bool do_connect = false;
        bool do_disconnect = false;
        {
            std::lock_guard<std::mutex> clock(s_connect_mutex);
            if (s_pending_disconnect_req) {
                s_pending_disconnect_req = false;
                do_disconnect = true;
            }
            if (s_pending_connect_req) {
                connect_addr = s_pending_connect_addr;
                connect_type = s_pending_connect_type;
                s_pending_connect_req = false;
                do_connect = true;
            }
        }
        if (do_disconnect) {
            if (s_ble_client && s_ble_client->isConnected()) {
                s_ble_client->disconnect();
            }
            start_background_ble_scan();
        }
        if (do_connect && !connect_addr.empty() && !s_ble_shutting_down.load(std::memory_order_relaxed)) {
            connect_ble_device(connect_addr, connect_type);
        }

        if (s_pending_bg_scan_update.exchange(false, std::memory_order_relaxed) &&
            !s_ble_shutting_down.load(std::memory_order_relaxed)) {
            start_background_ble_scan(true);
        }

        // 3. Beacon Exit Watchdog (runs once per second)
        uint32_t now = get_time_ms();
        if (now - last_exit_check >= 1000) {
            last_exit_check = now;
            PsramVector<BeaconTarget> exited;
            {
                std::lock_guard<std::mutex> lock(s_ble_mutex);
                const bool connecting = s_ble_connecting.load(std::memory_order_relaxed);
                if (connecting || s_scan_pause_start_ms != 0) {
                    compensate_beacon_scan_pause_locked(now, !connecting);
                }
                for (auto& target : s_beacon_targets) {
                    if (target.is_present &&
                        (int32_t)(now - target.last_seen_ms) > 0 &&
                        (now - target.last_seen_ms) > (uint32_t)target.exit_timeout_s * 1000) {
                        target.is_present = false;
                        target.smoothed_rssi = -100.0f;
                        target.last_rssi = -100;
                        exited.push_back(target);
                    }
                }
            }

            for (const auto& target : exited) {
                ESP_LOGI(TAG, "[BEACON] Target '%s' EXITED / AWAY (timeout %ds)", target.name.c_str(), target.exit_timeout_s);
                emit_ws_ble_beacon("exit", target.uuid, target.mac, target.name, -100, target.major, target.minor, false);
                can_engine_on_ble_beacon_event(target.uuid, "exit", -100, target.major, target.minor, target.mac, target.name);
            }
        }

        uint32_t wait_ms = 150;
        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            if (!s_pending_button_events.empty() || !s_pending_device_events.empty() || !s_pending_beacon_events.empty()) {
                wait_ms = 0;
            } else {
                uint32_t wake_now = get_time_ms();
                if (s_chord.phase == ChordPhase::SETTLING) {
                    int32_t rem = (int32_t)(s_chord.settle_deadline_ms - wake_now);
                    wait_ms = (rem <= 0) ? 1U : std::min<uint32_t>(wait_ms, (uint32_t)rem);
                } else if (s_chord.phase == ChordPhase::PRESSED) {
                    int32_t rem = (int32_t)(s_chord.next_hold_tick_ms - wake_now);
                    wait_ms = (rem <= 0) ? 1U : std::min<uint32_t>(wait_ms, (uint32_t)rem);
                }
            }
        }
        if (s_ble_shutting_down.load(std::memory_order_relaxed)) break;
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait_ms));
    }
    s_ble_worker_task = nullptr;
    vTaskDelete(nullptr);
}

// ============================================================================
// Public API Implementations
// ============================================================================
void ble_mgr_init(void) {
    ESP_LOGI(TAG, "Initializing Native BLE Subsystem (Device ID: %s)...", g_device_id.c_str());
    NimBLEDevice::init(g_device_id);
    NimBLEDevice::setSecurityAuth(true, true, true);
    NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);

    load_paired_ble_devices();
    load_beacon_targets();

    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->setScanCallbacks(&s_scan_callbacks, false);
    start_background_ble_scan();

    BaseType_t task_ok = xTaskCreate(ble_worker_task, "ble_worker", 6144, nullptr, 3, &s_ble_worker_task);
    if (task_ok != pdPASS || s_ble_worker_task == nullptr) {
        s_ble_worker_task = nullptr;
        ESP_LOGE(TAG, "Failed to create ble_worker task (internal_free_heap=%u bytes)",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        return;
    }
    ESP_LOGI(TAG, "Native BLE Central & Observer Subsystem initialized successfully.");
}

void ble_mgr_set_standby(bool standby) {
    if (s_ble_standby.exchange(standby, std::memory_order_relaxed) != standby) {
        s_pending_bg_scan_update.store(true, std::memory_order_relaxed);
        wake_ble_worker();
    }
}

void ble_mgr_shutdown(void) {
    if (s_ble_shutting_down.exchange(true)) return;
    wake_ble_worker();
    if (NimBLEDevice::isInitialized()) {
        NimBLEScan* pScan = NimBLEDevice::getScan();
        if (pScan) {
            pScan->stop();
        }
        for (int i = 0; i < 25 && s_ble_worker_task != nullptr; ++i) {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        NimBLEDevice::deinit(false);
    }
}

std::string ble_mgr_get_status_json(void) {
    cJSON* root = cJSON_CreateObject();
    if (!root) {
        return "{}";
    }
    cJSON_AddBoolToObject(root, "enabled", true);
    cJSON_AddBoolToObject(root, "scanning", s_ble_scanning.load(std::memory_order_relaxed));

    std::lock_guard<std::mutex> lock(s_ble_mutex);

    // Connected device
    bool has_conn = false;
    for (const auto& dev : s_paired_devices) {
        if (dev.connected || iequals(dev.address, s_connected_device_addr)) {
            cJSON* conn = cJSON_CreateObject();
            if (conn) {
                append_ble_device_json(conn, dev.address, dev.name, dev.rssi, true, dev.bonded, dev.battery_pct);
                cJSON_AddItemToObject(root, "connected_device", conn);
                has_conn = true;
            }
            break;
        }
    }
    if (!has_conn) {
        cJSON_AddNullToObject(root, "connected_device");
    }
    cJSON_AddBoolToObject(root, "connected", has_conn);

    // Paired devices
    cJSON* paired = cJSON_CreateArray();
    if (paired) {
        for (const auto& dev : s_paired_devices) {
            cJSON* itm = cJSON_CreateObject();
            if (!itm) continue;
            append_ble_device_json(itm, dev.address, dev.name, dev.rssi,
                                   dev.connected || iequals(dev.address, s_connected_device_addr),
                                   dev.bonded, dev.battery_pct);
            cJSON_AddItemToArray(paired, itm);
        }
        cJSON_AddItemToObject(root, "paired_devices", paired);
    }

    // Discovered devices
    cJSON* disc = cJSON_CreateArray();
    if (disc) {
        for (const auto& dev : s_discovered_devices) {
            cJSON* itm = cJSON_CreateObject();
            if (!itm) continue;
            append_ble_device_json(itm, dev.address, dev.name, dev.rssi, false, false);
            cJSON_AddItemToArray(disc, itm);
        }
        cJSON_AddItemToObject(root, "discovered_devices", disc);
    }

    // Last event
    if (s_has_last_event) {
        cJSON* ev = cJSON_CreateObject();
        if (ev) {
            append_ble_event_json(ev, s_last_ble_event);
            cJSON_AddItemToObject(root, "last_event", ev);
        } else {
            cJSON_AddNullToObject(root, "last_event");
        }
    } else {
        cJSON_AddNullToObject(root, "last_event");
    }

    // Recent events (newest first)
    cJSON* recent = cJSON_CreateArray();
    if (recent) {
        for (auto it = s_recent_ble_events.rbegin(); it != s_recent_ble_events.rend(); ++it) {
            cJSON* itm = cJSON_CreateObject();
            if (!itm) continue;
            append_ble_event_json(itm, *it);
            cJSON_AddItemToArray(recent, itm);
        }
        cJSON_AddItemToObject(root, "recent_events", recent);
    }

    // Beacon targets
    cJSON* btargets = cJSON_CreateArray();
    if (btargets) {
        for (const auto& b : s_beacon_targets) {
            cJSON* itm = cJSON_CreateObject();
            if (!itm) continue;
            cJSON_AddStringToObject(itm, "uuid", b.uuid.c_str());
            cJSON_AddStringToObject(itm, "mac", b.mac.c_str());
            cJSON_AddStringToObject(itm, "name", b.name.c_str());
            cJSON_AddNumberToObject(itm, "enter_rssi", b.enter_rssi);
            cJSON_AddNumberToObject(itm, "exit_timeout_s", b.exit_timeout_s);
            cJSON_AddBoolToObject(itm, "is_present", b.is_present);
            cJSON_AddNumberToObject(itm, "rssi", b.last_rssi);
            cJSON_AddNumberToObject(itm, "major", b.major);
            cJSON_AddNumberToObject(itm, "minor", b.minor);
            cJSON_AddNumberToObject(itm, "last_seen_ms", b.last_seen_ms);
            cJSON_AddItemToArray(btargets, itm);
        }
        cJSON_AddItemToObject(root, "beacon_targets", btargets);
    }

    // Discovered beacons (last 60s)
    uint32_t now_ms = get_time_ms();
    cJSON* dbeacons = cJSON_CreateArray();
    if (dbeacons) {
        for (const auto& b : s_discovered_beacons) {
            if (now_ms - b.last_seen_ms < 60000) {
                cJSON* itm = cJSON_CreateObject();
                if (!itm) continue;
                cJSON_AddStringToObject(itm, "uuid", b.uuid.c_str());
                cJSON_AddStringToObject(itm, "mac", b.mac.c_str());
                cJSON_AddNumberToObject(itm, "rssi", b.rssi);
                cJSON_AddNumberToObject(itm, "major", b.major);
                cJSON_AddNumberToObject(itm, "minor", b.minor);
                cJSON_AddNumberToObject(itm, "last_seen_ms", b.last_seen_ms);
                cJSON_AddItemToArray(dbeacons, itm);
            }
        }
        cJSON_AddItemToObject(root, "discovered_beacons", dbeacons);
    }

    char* out = cJSON_PrintUnformatted(root);
    std::string res = out ? out : "{}";
    if (out) free(out);
    cJSON_Delete(root);
    return res;
}

void ble_mgr_start_scan(uint32_t duration_sec) {
    if (duration_sec == 0 || duration_sec > 60) duration_sec = 10;
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        s_discovered_devices.clear();
        s_ble_scanning.store(true, std::memory_order_relaxed);
    }

    NimBLEScan* pScan = NimBLEDevice::getScan();
    if (!pScan) {
        s_ble_scanning.store(false, std::memory_order_relaxed);
        return;
    }
    pScan->stop();
    pScan->clearResults();
    pScan->setMaxResults(0);
    pScan->setInterval(160);
    pScan->setWindow(36);
    pScan->setDuplicateFilter(true);
    pScan->setActiveScan(true);
    if (!pScan->start(duration_sec * 1000, false, true)) {
        s_ble_scanning.store(false, std::memory_order_relaxed);
        ESP_LOGW(TAG, "Failed to start %u-second in-car active scan", (unsigned)duration_sec);
        return;
    }
    ESP_LOGI(TAG, "Started %u-second in-car active scan", (unsigned)duration_sec);
}

bool ble_mgr_pair_device(const std::string& raw_address, const std::string& in_name) {
    std::string address;
    if (!normalize_ble_mac(raw_address, address)) {
        ESP_LOGW(TAG, "Rejecting ble_mgr_pair_device: invalid MAC '%s'", raw_address.c_str());
        return false;
    }
    std::string name = in_name;
    uint8_t addr_type = BLE_ADDR_PUBLIC;

    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        for (const auto& d : s_discovered_devices) {
            if (iequals(d.address, address)) {
                if (name.empty() || name == "Unknown Device") {
                    name = d.name;
                }
                addr_type = d.addr_type;
                break;
            }
        }
        if (name.empty() || name == "Unknown Device") name = "Bluetooth Button";

        bool found = false;
        for (auto& p : s_paired_devices) {
            if (iequals(p.address, address)) {
                p.address = address;
                p.name = name;
                p.addr_type = addr_type;
                p.reconnect_backoff_ms = 0;
                p.last_connect_attempt_ms = 0;
                found = true;
                break;
            }
        }
        if (!found) {
            if (s_paired_devices.size() >= MAX_PAIRED_DEVICES) {
                ESP_LOGW(TAG, "Cannot pair %s: max paired devices (%zu) reached",
                         address.c_str(), MAX_PAIRED_DEVICES);
                return false;
            }
            PairedDevice dev;
            dev.address = address;
            dev.name = name;
            dev.rssi = -50;
            dev.connected = false;
            dev.bonded = true;
            dev.battery_pct = 100;
            dev.addr_type = addr_type;
            s_paired_devices.push_back(dev);
        }
    }

    persist_paired_ble_devices();
    s_bg_scan_has_targets.store(true, std::memory_order_relaxed);
    ESP_LOGI(TAG, "Paired device: %s (%s, type=%d)", address.c_str(), name.c_str(), addr_type);

    // Queue connection via worker
    {
        std::lock_guard<std::mutex> clock(s_connect_mutex);
        s_pending_connect_addr = address;
        s_pending_connect_type = addr_type;
        s_pending_connect_req = true;
    }
    wake_ble_worker();
    return true;
}

bool ble_mgr_unpair_device(const std::string& raw_address) {
    std::string address;
    if (!raw_address.empty() && !normalize_ble_mac(raw_address, address)) {
        ESP_LOGW(TAG, "Rejecting ble_mgr_unpair_device: invalid MAC '%s'", raw_address.c_str());
        return false;
    }

    bool should_disconnect = false;
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        if (address.empty()) {
            should_disconnect = s_ble_client_connected.load(std::memory_order_relaxed) || !s_connected_device_addr.empty();
            s_paired_devices.clear();
            s_chord = {};
        } else {
            should_disconnect = !s_connected_device_addr.empty() && iequals(s_connected_device_addr, address);
            for (auto it = s_paired_devices.begin(); it != s_paired_devices.end(); ++it) {
                if (iequals(it->address, address)) {
                    s_paired_devices.erase(it);
                    break;
                }
            }
            if (!s_chord.addr.empty() && iequals(s_chord.addr, address)) {
                s_chord = {};
            }
        }
    }
    {
        std::lock_guard<std::mutex> clock(s_connect_mutex);
        if (address.empty() || (s_pending_connect_req && iequals(s_pending_connect_addr, address))) {
            s_pending_connect_req = false;
            s_pending_connect_addr.clear();
        }
        if (should_disconnect) {
            s_pending_disconnect_req = true;
        }
    }
    persist_paired_ble_devices();
    ESP_LOGI(TAG, "Unpaired device(s): %s", address.empty() ? "all" : address.c_str());
    start_background_ble_scan();
    if (should_disconnect) {
        wake_ble_worker();
    }
    return true;
}

void ble_mgr_inject_test_event(const std::string& button, const std::string& action) {
    std::string btn = button.empty() ? "volume_up" : button;
    std::string act = action.empty() ? "press" : action;
    std::string combo = (btn.find('+') != std::string::npos) ? btn : "";
    uint32_t hold_s = 0;
    if (act.rfind("hold_", 0) == 0 && act.size() > 6 && act.back() == 's') {
        hold_s = (uint32_t)atoi(act.substr(5, act.size() - 6).c_str());
    }
    fire_ble_button_event("00:00:00:00:00:00", "Simulated Controller", btn, act, combo, hold_s);
}

bool ble_mgr_set_beacon(const std::string& raw_uuid, const std::string& raw_mac, const std::string& name, int enter_rssi, int exit_timeout_s) {
    if (raw_uuid.empty() && raw_mac.empty()) return false;

    std::string uuid;
    if (!raw_uuid.empty() && !normalize_ibeacon_uuid(raw_uuid, uuid)) {
        ESP_LOGW(TAG, "Rejecting ble_mgr_set_beacon: invalid UUID '%s'", raw_uuid.c_str());
        return false;
    }
    std::string mac;
    if (!raw_mac.empty() && !normalize_ble_mac(raw_mac, mac)) {
        ESP_LOGW(TAG, "Rejecting ble_mgr_set_beacon: invalid MAC '%s'", raw_mac.c_str());
        return false;
    }

    enter_rssi = std::clamp(enter_rssi, -100, -25);
    exit_timeout_s = std::clamp(exit_timeout_s, 5, 600);

    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        bool updated = false;
        for (auto& b : s_beacon_targets) {
            if ((!uuid.empty() && iequals(b.uuid, uuid)) || (!mac.empty() && iequals(b.mac, mac))) {
                b.uuid = uuid;
                b.mac = mac;
                b.name = name.empty() ? "Phone Beacon" : name;
                b.enter_rssi = enter_rssi;
                b.exit_timeout_s = exit_timeout_s;
                updated = true;
                break;
            }
        }
        if (!updated) {
            if (s_beacon_targets.size() >= MAX_BEACON_TARGETS) {
                ESP_LOGW(TAG, "Cannot add beacon target: max beacon targets (%zu) reached",
                         MAX_BEACON_TARGETS);
                return false;
            }
            BeaconTarget bt;
            bt.uuid = uuid;
            bt.mac = mac;
            bt.name = name.empty() ? "Phone Beacon" : name;
            bt.enter_rssi = enter_rssi;
            bt.exit_timeout_s = exit_timeout_s;
            s_beacon_targets.push_back(bt);
        }
    }

    persist_beacon_targets();
    start_background_ble_scan();
    return true;
}

bool ble_mgr_delete_beacon(const std::string& raw_uuid, const std::string& raw_mac) {
    if (raw_uuid.empty() && raw_mac.empty()) return false;

    std::string uuid;
    if (!raw_uuid.empty() && !normalize_ibeacon_uuid(raw_uuid, uuid)) {
        ESP_LOGW(TAG, "Rejecting ble_mgr_delete_beacon: invalid UUID '%s'", raw_uuid.c_str());
        return false;
    }
    std::string mac;
    if (!raw_mac.empty() && !normalize_ble_mac(raw_mac, mac)) {
        ESP_LOGW(TAG, "Rejecting ble_mgr_delete_beacon: invalid MAC '%s'", raw_mac.c_str());
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        for (auto it = s_beacon_targets.begin(); it != s_beacon_targets.end(); ++it) {
            if ((!uuid.empty() && iequals(it->uuid, uuid)) || (!mac.empty() && iequals(it->mac, mac))) {
                s_beacon_targets.erase(it);
                break;
            }
        }
    }

    persist_beacon_targets();
    start_background_ble_scan();
    return true;
}

bool ble_mgr_is_enabled(void) {
    return true;
}

void ble_mgr_clear_events(void) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    s_recent_ble_events.clear();
    s_has_last_event = false;
    s_last_ble_event = {};
}

#else // !CONFIG_BT_ENABLED

void ble_mgr_init(void) {
    ESP_LOGI(TAG, "Bluetooth is disabled in sdkconfig. ble_mgr inactive.");
}

void ble_mgr_set_standby(bool standby) { (void)standby; }
void ble_mgr_shutdown(void) {}

std::string ble_mgr_get_status_json(void) {
    return "{\"enabled\":false,\"scanning\":false,\"connected\":false,\"connected_device\":null,\"paired_devices\":[],\"discovered_devices\":[],\"last_event\":null,\"recent_events\":[],\"beacon_targets\":[],\"discovered_beacons\":[]}";
}

void ble_mgr_start_scan(uint32_t duration_sec) { (void)duration_sec; }
bool ble_mgr_pair_device(const std::string& address, const std::string& name) { (void)address; (void)name; return false; }
bool ble_mgr_unpair_device(const std::string& address) { (void)address; return false; }
void ble_mgr_inject_test_event(const std::string& button, const std::string& action) { (void)button; (void)action; }
void ble_mgr_clear_events(void) {}
bool ble_mgr_set_beacon(const std::string& uuid, const std::string& mac, const std::string& name, int enter_rssi, int exit_timeout_s) {
    (void)uuid; (void)mac; (void)name; (void)enter_rssi; (void)exit_timeout_s; return false;
}
bool ble_mgr_delete_beacon(const std::string& uuid, const std::string& mac) { (void)uuid; (void)mac; return false; }
bool ble_mgr_is_enabled(void) { return false; }

#endif // CONFIG_BT_ENABLED

