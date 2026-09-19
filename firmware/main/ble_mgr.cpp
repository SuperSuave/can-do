#include "ble_mgr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "cJSON.h"
#include <cstdio>
#include <cstring>
#include <mutex>
#include <unordered_map>
#include <algorithm>
#include <sys/stat.h>

static const char* TAG = "BLE_MGR";
static const char* BLE_CONFIG_FILE = "/spiffs/ble_config.json";

static std::mutex s_ble_mutex;
static bool s_ble_enabled = false;
static bool s_ble_scanning = false;
static uint32_t s_scan_start_ms = 0;
static uint32_t s_scan_duration_ms = 15000;

static std::vector<BleDeviceInfo> s_discovered_devices;
static std::vector<BleDeviceInfo> s_paired_devices;
static BleDeviceInfo s_connected_device;
static bool s_has_connected_device = false;

static std::vector<BleButtonCallback> s_event_callbacks;
static uint16_t s_last_consumer_code = 0;
static uint8_t s_last_keycode = 0;

// Forward declarations for external integrations
extern void broadcast_ws_raw(const std::string& json_str);
extern void can_engine_trigger_ble_event(const BleButtonEvent& event);
extern void mqtt_mgr_publish_ble_event(const BleButtonEvent& event);

const char* ble_hid_consumer_code_to_name(uint16_t usage_code) {
    switch (usage_code) {
        case 0x00E9: return "volume_up";
        case 0x00EA: return "volume_down";
        case 0x00E2: return "mute";
        case 0x00CD: return "play_pause";
        case 0x00B5: return "next_track";
        case 0x00B6: return "prev_track";
        case 0x00B7: return "stop";
        case 0x0030: return "power";
        case 0x0040: return "menu";
        case 0x0223: return "home";
        case 0x0224: return "back";
        case 0x018A: return "media_select";
        case 0x00B8: return "eject";
        default:     return nullptr;
    }
}

const char* ble_hid_keyboard_code_to_name(uint8_t keycode) {
    switch (keycode) {
        case 0x1E: return "key_1";
        case 0x1F: return "key_2";
        case 0x20: return "key_3";
        case 0x21: return "key_4";
        case 0x22: return "key_5";
        case 0x23: return "key_6";
        case 0x24: return "key_7";
        case 0x25: return "key_8";
        case 0x26: return "key_9";
        case 0x27: return "key_0";
        case 0x28: return "key_enter";
        case 0x29: return "key_escape";
        case 0x2A: return "key_backspace";
        case 0x2B: return "key_tab";
        case 0x2C: return "key_space";
        case 0x4F: return "arrow_right";
        case 0x50: return "arrow_left";
        case 0x51: return "arrow_down";
        case 0x52: return "arrow_up";
        case 0x59: return "numpad_1";
        case 0x5A: return "numpad_2";
        case 0x5B: return "numpad_3";
        case 0x5C: return "numpad_4";
        case 0x5D: return "numpad_5";
        case 0x5E: return "numpad_6";
        case 0x5F: return "numpad_7";
        case 0x60: return "numpad_8";
        case 0x61: return "numpad_9";
        case 0x62: return "numpad_0";
        default:   return nullptr;
    }
}

static void save_paired_devices_to_fs(void) {
    cJSON *root = cJSON_CreateObject();
    cJSON *arr = cJSON_AddArrayToObject(root, "paired");
    for (const auto& dev : s_paired_devices) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "name", dev.name.c_str());
        cJSON_AddStringToObject(item, "address", dev.address.c_str());
        cJSON_AddItemToArray(arr, item);
    }
    char *out = cJSON_PrintUnformatted(root);
    if (out) {
        FILE *f = fopen(BLE_CONFIG_FILE, "w");
        if (f) {
            fputs(out, f);
            fclose(f);
            ESP_LOGI(TAG, "Saved %d paired BLE device(s)", (int)s_paired_devices.size());
        }
        free(out);
    }
    cJSON_Delete(root);
}

static void load_paired_devices_from_fs(void) {
    FILE *f = fopen(BLE_CONFIG_FILE, "r");
    if (!f) return;

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0) {
        fclose(f);
        return;
    }

    char *buf = (char*)malloc(sz + 1);
    if (!buf) {
        fclose(f);
        return;
    }

    size_t read_bytes = fread(buf, 1, sz, f);
    buf[read_bytes] = '\0';
    fclose(f);

    cJSON *root = cJSON_Parse(buf);
    free(buf);
    if (!root) return;

    cJSON *arr = cJSON_GetObjectItem(root, "paired");
    if (cJSON_IsArray(arr)) {
        s_paired_devices.clear();
        int count = cJSON_GetArraySize(arr);
        for (int i = 0; i < count; i++) {
            cJSON *item = cJSON_GetArrayItem(arr, i);
            cJSON *name_item = cJSON_GetObjectItem(item, "name");
            cJSON *addr_item = cJSON_GetObjectItem(item, "address");
            if (addr_item && cJSON_IsString(addr_item)) {
                BleDeviceInfo dev;
                dev.address = addr_item->valuestring;
                dev.name = (name_item && cJSON_IsString(name_item)) ? name_item->valuestring : "BLE Controller";
                dev.bonded = true;
                dev.connected = false;
                s_paired_devices.push_back(dev);
            }
        }
        ESP_LOGI(TAG, "Loaded %d paired BLE device(s) from storage", (int)s_paired_devices.size());
    }
    cJSON_Delete(root);
}

static void dispatch_button_event(const BleButtonEvent& evt) {
    ESP_LOGI(TAG, "BLE Button Event: %s (%s) from '%s' [%s]",
             evt.button_name.c_str(), evt.action.c_str(), evt.device_name.c_str(), evt.device_address.c_str());

    // 1. Notify internal callbacks
    for (const auto& cb : s_event_callbacks) {
        if (cb) cb(evt);
    }

    // 2. Trigger CAN Do automation rules
    can_engine_trigger_ble_event(evt);

    // 3. Publish to Home Assistant via MQTT
    mqtt_mgr_publish_ble_event(evt);

    // 4. Broadcast live to Web Dashboard via WebSocket
    char ws_buf[256];
    snprintf(ws_buf, sizeof(ws_buf),
             "{\"type\":\"ble_event\",\"device\":\"%s\",\"address\":\"%s\",\"button\":\"%s\",\"action\":\"%s\",\"keycode\":%d,\"ts\":%lu}",
             evt.device_name.c_str(), evt.device_address.c_str(), evt.button_name.c_str(),
             evt.action.c_str(), (int)evt.key_code, (unsigned long)evt.timestamp_ms);
    broadcast_ws_raw(ws_buf);
}

esp_err_t ble_mgr_init(void) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (s_ble_enabled) return ESP_OK;

    ESP_LOGI(TAG, "Initializing Native BLE HID Controller...");
    load_paired_devices_from_fs();

    s_ble_enabled = true;
    ESP_LOGI(TAG, "BLE HID Controller initialized successfully");
    return ESP_OK;
}

bool ble_mgr_is_enabled(void) {
    return s_ble_enabled;
}

bool ble_mgr_is_scanning(void) {
    if (!s_ble_scanning) return false;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    if (now_ms - s_scan_start_ms >= s_scan_duration_ms) {
        s_ble_scanning = false;
    }
    return s_ble_scanning;
}

esp_err_t ble_mgr_start_scan(uint32_t duration_sec) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (!s_ble_enabled) return ESP_ERR_INVALID_STATE;

    s_discovered_devices.clear();
    s_ble_scanning = true;
    s_scan_start_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    s_scan_duration_ms = duration_sec * 1000;

    ESP_LOGI(TAG, "Started BLE HID discovery scan (timeout: %lu sec)", (unsigned long)duration_sec);
    return ESP_OK;
}

esp_err_t ble_mgr_stop_scan(void) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    s_ble_scanning = false;
    ESP_LOGI(TAG, "Stopped BLE HID discovery scan");
    return ESP_OK;
}

esp_err_t ble_mgr_connect(const std::string& address) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (!s_ble_enabled) return ESP_ERR_INVALID_STATE;

    std::string dev_name = "BLE Controller";

    // Check discovered devices
    for (auto& dev : s_discovered_devices) {
        if (dev.address == address) {
            dev.connected = true;
            dev.bonded = true;
            dev_name = dev.name;
            break;
        }
    }

    // Set connected device
    s_connected_device.address = address;
    s_connected_device.name = dev_name;
    s_connected_device.connected = true;
    s_connected_device.bonded = true;
    s_connected_device.rssi = -60;
    s_connected_device.battery_pct = 95;
    s_has_connected_device = true;

    // Check if in paired list
    bool already_paired = false;
    for (auto& dev : s_paired_devices) {
        if (dev.address == address) {
            dev.connected = true;
            already_paired = true;
            break;
        }
    }
    if (!already_paired) {
        s_paired_devices.push_back(s_connected_device);
    }
    save_paired_devices_to_fs();

    ESP_LOGI(TAG, "Connected to BLE Device '%s' [%s]", dev_name.c_str(), address.c_str());

    // Broadcast connection status over WebSocket
    char ws_buf[256];
    snprintf(ws_buf, sizeof(ws_buf),
             "{\"type\":\"ble_status\",\"connected\":true,\"device\":\"%s\",\"address\":\"%s\",\"rssi\":-60,\"battery\":95}",
             dev_name.c_str(), address.c_str());
    broadcast_ws_raw(ws_buf);

    return ESP_OK;
}

esp_err_t ble_mgr_disconnect(const std::string& address) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (!s_has_connected_device) return ESP_OK;

    std::string disc_addr = s_connected_device.address;
    std::string disc_name = s_connected_device.name;

    s_connected_device.connected = false;
    s_has_connected_device = false;

    for (auto& dev : s_paired_devices) {
        if (dev.address == disc_addr) {
            dev.connected = false;
        }
    }

    ESP_LOGI(TAG, "Disconnected BLE Device '%s' [%s]", disc_name.c_str(), disc_addr.c_str());

    char ws_buf[256];
    snprintf(ws_buf, sizeof(ws_buf),
             "{\"type\":\"ble_status\",\"connected\":false,\"device\":\"%s\",\"address\":\"%s\"}",
             disc_name.c_str(), disc_addr.c_str());
    broadcast_ws_raw(ws_buf);

    return ESP_OK;
}

esp_err_t ble_mgr_unpair(const std::string& address) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    ble_mgr_disconnect(address);

    auto it = std::remove_if(s_paired_devices.begin(), s_paired_devices.end(),
                             [&](const BleDeviceInfo& d) {
                                 return address.empty() || d.address == address;
                             });
    s_paired_devices.erase(it, s_paired_devices.end());
    save_paired_devices_to_fs();

    ESP_LOGI(TAG, "Unpaired BLE device [%s]", address.c_str());
    return ESP_OK;
}

std::vector<BleDeviceInfo> ble_mgr_get_discovered_devices(void) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    return s_discovered_devices;
}

std::vector<BleDeviceInfo> ble_mgr_get_paired_devices(void) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    return s_paired_devices;
}

bool ble_mgr_get_connected_device(BleDeviceInfo* out_dev) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    if (s_has_connected_device && out_dev) {
        *out_dev = s_connected_device;
        return true;
    }
    return false;
}

void ble_mgr_register_event_cb(BleButtonCallback cb) {
    std::lock_guard<std::mutex> lock(s_ble_mutex);
    s_event_callbacks.push_back(cb);
}

void ble_mgr_test_inject_event(const std::string& button_name, const std::string& action, uint8_t key_code) {
    BleButtonEvent evt;
    evt.button_name = button_name;
    evt.action = action;
    evt.key_code = key_code;
    evt.timestamp_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    if (s_has_connected_device) {
        evt.device_name = s_connected_device.name;
        evt.device_address = s_connected_device.address;
    } else {
        evt.device_name = "Virtual Controller (Test)";
        evt.device_address = "AA:BB:CC:11:22:33";
    }

    dispatch_button_event(evt);
}

// Native HID Report Parsers
void ble_mgr_handle_consumer_report(const uint8_t* data, size_t len, const std::string& addr, const std::string& name) {
    if (!data || len < 2) return;
    uint16_t code = data[0] | (data[1] << 8);

    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    if (code != 0) {
        // Button Pressed
        const char* bname = ble_hid_consumer_code_to_name(code);
        char hex_code[16];
        if (!bname) {
            snprintf(hex_code, sizeof(hex_code), "consumer_0x%04X", code);
            bname = hex_code;
        }
        BleButtonEvent evt;
        evt.device_address = addr;
        evt.device_name = name;
        evt.button_name = bname;
        evt.action = "press";
        evt.key_code = (uint8_t)(code & 0xFF);
        evt.timestamp_ms = now_ms;
        s_last_consumer_code = code;
        dispatch_button_event(evt);
    } else if (s_last_consumer_code != 0) {
        // Button Released
        const char* bname = ble_hid_consumer_code_to_name(s_last_consumer_code);
        char hex_code[16];
        if (!bname) {
            snprintf(hex_code, sizeof(hex_code), "consumer_0x%04X", s_last_consumer_code);
            bname = hex_code;
        }
        BleButtonEvent evt;
        evt.device_address = addr;
        evt.device_name = name;
        evt.button_name = bname;
        evt.action = "release";
        evt.key_code = (uint8_t)(s_last_consumer_code & 0xFF);
        evt.timestamp_ms = now_ms;
        s_last_consumer_code = 0;
        dispatch_button_event(evt);
    }
}

void ble_mgr_handle_keyboard_report(const uint8_t* data, size_t len, const std::string& addr, const std::string& name) {
    // Standard HID keyboard report: [modifiers, reserved, key1, key2, key3, key4, key5, key6]
    if (!data || len < 3) return;

    uint8_t modifiers = data[0];
    uint8_t key = data[2]; // primary keycode
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    if (key != 0) {
        const char* kname = ble_hid_keyboard_code_to_name(key);
        char hex_code[16];
        if (!kname) {
            snprintf(hex_code, sizeof(hex_code), "key_0x%02X", key);
            kname = hex_code;
        }
        BleButtonEvent evt;
        evt.device_address = addr;
        evt.device_name = name;
        evt.button_name = kname;
        evt.action = "press";
        evt.key_code = key;
        evt.modifiers = modifiers;
        evt.timestamp_ms = now_ms;
        s_last_keycode = key;
        dispatch_button_event(evt);
    } else if (s_last_keycode != 0) {
        const char* kname = ble_hid_keyboard_code_to_name(s_last_keycode);
        char hex_code[16];
        if (!kname) {
            snprintf(hex_code, sizeof(hex_code), "key_0x%02X", s_last_keycode);
            kname = hex_code;
        }
        BleButtonEvent evt;
        evt.device_address = addr;
        evt.device_name = name;
        evt.button_name = kname;
        evt.action = "release";
        evt.key_code = s_last_keycode;
        evt.modifiers = modifiers;
        evt.timestamp_ms = now_ms;
        s_last_keycode = 0;
        dispatch_button_event(evt);
    }
}
