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

struct BleButtonEvent {
    std::string device_address;
    std::string device_name;
    std::string button_name;
    std::string action; // "press", "release"
    uint32_t timestamp_ms;
};

struct PairedDevice {
    std::string address;
    std::string name;
    int8_t rssi = -60;
    bool connected = false;
    bool bonded = true;
    int battery_pct = 100;
    uint8_t addr_type = 0; // BLE_ADDR_PUBLIC (0) or BLE_ADDR_RANDOM (1)
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

static std::mutex s_ble_mutex;
static std::vector<DiscoveredDevice> s_discovered_devices;
static std::vector<PairedDevice> s_paired_devices;
static std::vector<BeaconTarget> s_beacon_targets;
static std::vector<DiscoveredBeacon> s_discovered_beacons;
static std::vector<BleButtonEvent> s_recent_ble_events;
static BleButtonEvent s_last_ble_event = {};
static bool s_has_last_event = false;
static std::vector<std::string> s_held_buttons;

static bool s_ble_scanning = false;
static std::atomic<bool> s_ble_shutting_down{false};
static uint32_t s_ble_scan_start_ms = 0;
static uint32_t s_ble_scan_duration_ms = 10000;
static bool s_ble_client_connected = false;
static std::string s_connected_device_addr = "";

// Deferred connection request structure
static std::mutex s_connect_mutex;
static bool s_pending_connect_req = false;
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

// ============================================================================
// NVS Persistence
// ============================================================================
static void load_paired_ble_devices(void) {
    s_paired_devices.clear();
    nvs_handle_t handle;
    if (nvs_open("ble_cfg", NVS_READONLY, &handle) == ESP_OK) {
        size_t required_size = 0;
        if (nvs_get_str(handle, "paired", nullptr, &required_size) == ESP_OK && required_size > 0) {
            char* buf = (char*)malloc(required_size);
            if (buf) {
                if (nvs_get_str(handle, "paired", buf, &required_size) == ESP_OK) {
                    cJSON* root = cJSON_Parse(buf);
                    if (root && cJSON_IsArray(root)) {
                        int sz = cJSON_GetArraySize(root);
                        for (int i = 0; i < sz; i++) {
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
        nvs_close(handle);
    }
    ESP_LOGI(TAG, "Loaded %u paired BLE devices from NVS", (unsigned)s_paired_devices.size());
}

static void persist_paired_ble_devices(void) {
    cJSON* arr = cJSON_CreateArray();
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        for (const auto& dev : s_paired_devices) {
            cJSON* itm = cJSON_CreateObject();
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

    if (json_str) {
        nvs_handle_t handle;
        if (nvs_open("ble_cfg", NVS_READWRITE, &handle) == ESP_OK) {
            nvs_set_str(handle, "paired", json_str);
            nvs_commit(handle);
            nvs_close(handle);
        }
        free(json_str);
    }
}

static void load_beacon_targets(void) {
    s_beacon_targets.clear();
    nvs_handle_t handle;
    if (nvs_open("ble_cfg", NVS_READONLY, &handle) == ESP_OK) {
        size_t required_size = 0;
        if (nvs_get_str(handle, "targets", nullptr, &required_size) == ESP_OK && required_size > 0) {
            char* buf = (char*)malloc(required_size);
            if (buf) {
                if (nvs_get_str(handle, "targets", buf, &required_size) == ESP_OK) {
                    cJSON* root = cJSON_Parse(buf);
                    if (root && cJSON_IsArray(root)) {
                        int sz = cJSON_GetArraySize(root);
                        for (int i = 0; i < sz; i++) {
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
        nvs_close(handle);
    }
    ESP_LOGI(TAG, "Loaded %u beacon targets from NVS", (unsigned)s_beacon_targets.size());
}

static void persist_beacon_targets(void) {
    cJSON* arr = cJSON_CreateArray();
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        for (const auto& b : s_beacon_targets) {
            cJSON* itm = cJSON_CreateObject();
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

    if (json_str) {
        nvs_handle_t handle;
        if (nvs_open("ble_cfg", NVS_READWRITE, &handle) == ESP_OK) {
            nvs_set_str(handle, "targets", json_str);
            nvs_commit(handle);
            nvs_close(handle);
        }
        free(json_str);
    }
}

// ============================================================================
// Event Dispatching
// ============================================================================
static void fire_ble_button_event(const std::string& addr, const std::string& name,
                                  const std::string& btn, const std::string& act,
                                  const std::string& combo = "") {
    uint32_t now_ms = get_time_ms();
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        s_last_ble_event = { addr, name, btn, act, now_ms };
        s_has_last_event = true;
        if (s_recent_ble_events.size() >= 30) {
            s_recent_ble_events.erase(s_recent_ble_events.begin());
        }
        s_recent_ble_events.push_back(s_last_ble_event);
    }

    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "ble_event");
    cJSON_AddStringToObject(root, "address", addr.c_str());
    cJSON_AddStringToObject(root, "device_name", name.c_str());
    cJSON_AddStringToObject(root, "button", btn.c_str());
    cJSON_AddStringToObject(root, "action", act.c_str());
    if (!combo.empty()) {
        cJSON_AddStringToObject(root, "combo", combo.c_str());
    }
    cJSON_AddNumberToObject(root, "timestamp_ms", now_ms);
    char* json_str = cJSON_PrintUnformatted(root);
    if (json_str) {
        broadcast_ws_raw(json_str);
        free(json_str);
    }
    cJSON_Delete(root);

    ESP_LOGI(TAG, "[BLE BTN] %s '%s' from %s (%s) combo=%s", act.c_str(), btn.c_str(), name.c_str(), addr.c_str(), combo.c_str());
    can_engine_on_ble_event(addr, btn, act, combo);
}

// ============================================================================
// HID Report Notification Parser
// ============================================================================
static void on_hid_report_notify(NimBLERemoteCharacteristic* pChar, uint8_t* pData, size_t length, bool isNotify) {
    if (length == 0 || !pData) return;

    std::string addr = s_connected_device_addr.empty() ? "BLE Device" : s_connected_device_addr;
    std::string name = "BLE Controller";
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        for (const auto& dev : s_paired_devices) {
            if (iequals(dev.address, addr)) {
                name = dev.name;
                break;
            }
        }
    }

    std::string btn = "volume_up";
    std::string act = "press";

    // 1. Check for release event (all zeros in report)
    bool all_zero = true;
    for (size_t i = 0; i < length; i++) {
        if (pData[i] != 0) {
            all_zero = false;
            break;
        }
    }

    if (all_zero) {
        act = "release";
        std::string combo_released = "";
        std::vector<std::string> held_copy;
        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            held_copy = s_held_buttons;
            s_held_buttons.clear();
        }

        if (held_copy.size() > 1) {
            std::vector<std::string> sorted_held = held_copy;
            std::sort(sorted_held.begin(), sorted_held.end());
            for (size_t i = 0; i < sorted_held.size(); i++) {
                if (i > 0) combo_released += "+";
                combo_released += sorted_held[i];
            }
        }

        if (!held_copy.empty()) {
            for (const auto& h : held_copy) {
                fire_ble_button_event(addr, name, h, "release", combo_released);
            }
        } else {
            std::string last_btn;
            {
                std::lock_guard<std::mutex> lock(s_ble_mutex);
                last_btn = s_has_last_event ? s_last_ble_event.button_name : "button";
            }
            fire_ble_button_event(addr, name, last_btn, "release");
        }
        return;
    } else if (length >= 8 && (pData[2] != 0 || pData[3] != 0 || pData[4] != 0)) {
        // Standard HID Keyboard report: 8 bytes [modifier, reserved, keycode1..6]
        std::vector<std::string> packet_keys;
        for (size_t k = 2; k < length && k < 8; k++) {
            uint8_t kc = pData[k];
            if (kc == 0) continue;
            std::string k_str = "";
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
                default: {
                    if (kc >= 0x04 && kc <= 0x1D) {
                        char c = 'a' + (kc - 0x04);
                        k_str = std::string("key_") + c;
                    } else {
                        char hbuf[16];
                        snprintf(hbuf, sizeof(hbuf), "hid_%02X", kc);
                        k_str = hbuf;
                    }
                }
            }
            if (!k_str.empty()) {
                packet_keys.push_back(k_str);
            }
        }

        if (!packet_keys.empty()) {
            btn = packet_keys[0];
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            for (const auto& pk : packet_keys) {
                if (std::find(s_held_buttons.begin(), s_held_buttons.end(), pk) == s_held_buttons.end()) {
                    s_held_buttons.push_back(pk);
                }
            }
        }
    } else {
        // Consumer Control / Media / Macro Keypad reports
        uint16_t usage = 0;
        if (length >= 2 && pData[0] == 0x00 && (pData[1] != 0 || (length >= 3 && pData[2] != 0))) {
            usage = pData[1] | ((uint16_t)pData[2] << 8);
        } else if (length >= 2 && (pData[0] != 0 || pData[1] != 0)) {
            usage = pData[0] | ((uint16_t)pData[1] << 8);
        } else {
            usage = pData[0];
        }

        std::vector<std::string> consumer_keys;
        if (usage == 0xE9 || (usage & 0x01 && (usage <= 0xFF))) consumer_keys.push_back("volume_up");
        if (usage == 0xEA || (usage & 0x02 && (usage <= 0xFF))) consumer_keys.push_back("volume_down");
        if (usage == 0xE2 || (usage & 0x20 && (usage <= 0xFF))) consumer_keys.push_back("mute");
        if (usage == 0xCD || (usage & 0x04 && (usage <= 0xFF))) consumer_keys.push_back("play_pause");
        if (usage == 0xB5 || (usage & 0x08 && (usage <= 0xFF))) consumer_keys.push_back("next_track");
        if (usage == 0xB6 || (usage & 0x10 && (usage <= 0xFF))) consumer_keys.push_back("prev_track");
        if (usage == 0x28) consumer_keys.push_back("shutter");

        if (!consumer_keys.empty()) {
            btn = consumer_keys[0];
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            for (const auto& ck : consumer_keys) {
                if (std::find(s_held_buttons.begin(), s_held_buttons.end(), ck) == s_held_buttons.end()) {
                    s_held_buttons.push_back(ck);
                }
            }
        } else {
            char hbuf[16];
            snprintf(hbuf, sizeof(hbuf), "hid_%02X", (uint8_t)(usage & 0xFF));
            btn = hbuf;
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            if (std::find(s_held_buttons.begin(), s_held_buttons.end(), btn) == s_held_buttons.end()) {
                s_held_buttons.push_back(btn);
            }
        }
    }

    std::string combo = "";
    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        if (s_held_buttons.size() > 1) {
            std::vector<std::string> sorted_held = s_held_buttons;
            std::sort(sorted_held.begin(), sorted_held.end());
            for (size_t i = 0; i < sorted_held.size(); i++) {
                if (i > 0) combo += "+";
                combo += sorted_held[i];
            }
        }
    }

    fire_ble_button_event(addr, name, btn, "press", combo);
}

// ============================================================================
// Client Callbacks
// ============================================================================
class ClientCallbacks : public NimBLEClientCallbacks {
    void onConnect(NimBLEClient* pClient) override {
        std::string addr = pClient->getPeerAddress().toString();
        ESP_LOGI(TAG, "Connected to %s", addr.c_str());
        NimBLEDevice::getScan()->stop();

        std::string dev_name = "";
        int cur_rssi = pClient->getRssi();
        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            s_ble_client_connected = true;
            s_connected_device_addr = addr;
            for (auto& dev : s_paired_devices) {
                if (iequals(dev.address, addr)) {
                    dev.connected = true;
                    dev_name = dev.name;
                    break;
                }
            }
        }

        cJSON* root = cJSON_CreateObject();
        cJSON_AddStringToObject(root, "type", "ble_device_event");
        cJSON_AddStringToObject(root, "event", "connected");
        cJSON_AddStringToObject(root, "address", addr.c_str());
        cJSON_AddStringToObject(root, "name", dev_name.c_str());
        cJSON_AddNumberToObject(root, "rssi", cur_rssi);
        char* out = cJSON_PrintUnformatted(root);
        if (out) {
            broadcast_ws_raw(out);
            free(out);
        }
        cJSON_Delete(root);

        can_engine_on_ble_device_event(addr, "connected", cur_rssi, dev_name);
    }

    void onDisconnect(NimBLEClient* pClient, int reason) override {
        std::string disc_addr = s_connected_device_addr;
        ESP_LOGI(TAG, "Disconnected from %s (reason: %d)", disc_addr.c_str(), reason);

        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            s_ble_client_connected = false;
            s_connected_device_addr = "";
            s_held_buttons.clear();
            for (auto& dev : s_paired_devices) {
                if (iequals(dev.address, disc_addr)) {
                    dev.connected = false;
                    break;
                }
            }
        }

        cJSON* root = cJSON_CreateObject();
        cJSON_AddStringToObject(root, "type", "ble_device_event");
        cJSON_AddStringToObject(root, "event", "disconnected");
        cJSON_AddStringToObject(root, "address", disc_addr.c_str());
        char* out = cJSON_PrintUnformatted(root);
        if (out) {
            broadcast_ws_raw(out);
            free(out);
        }
        cJSON_Delete(root);

        can_engine_on_ble_device_event(disc_addr, "disconnected", 0, "");

        // Resume continuous background scan
        NimBLEScan* pScan = NimBLEDevice::getScan();
        pScan->clearResults();
        pScan->setMaxResults(0);
        pScan->setDuplicateFilter(false);
        pScan->setActiveScan(false);
        pScan->start(0, false, true);
    }
} s_client_callbacks;

static void connect_ble_device(const std::string& address, uint8_t addr_type = 0xFF, const NimBLEAdvertisedDevice* pAdvDev = nullptr) {
    if (address.empty() && !pAdvDev) return;

    if (!s_ble_client) {
        s_ble_client = NimBLEDevice::createClient();
        s_ble_client->setClientCallbacks(&s_client_callbacks, false);
    }

    if (s_ble_client->isConnected()) {
        s_ble_client->disconnect();
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    s_ble_client->setConnectTimeout(3 * 1000);
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
        ESP_LOGI(TAG, "Attempting connection to %s (type=%d)...", address.c_str(), target_type);

        connected = s_ble_client->connect(bleAddr, false);
        if (!connected) {
            uint8_t alt_type = (target_type == BLE_ADDR_RANDOM) ? BLE_ADDR_PUBLIC : BLE_ADDR_RANDOM;
            ESP_LOGI(TAG, "Retrying connection to %s with alternate type (%d)...", address.c_str(), alt_type);
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
                    break;
                }
            }
        }
        persist_paired_ble_devices();

        ESP_LOGI(TAG, "Discovering remote services & subscribing to HID reports...");
        const auto& services = s_ble_client->getServices(true);
        for (NimBLERemoteService* pService : services) {
            if (!pService) continue;
            ESP_LOGD(TAG, "Service: %s", pService->getUUID().toString().c_str());
            const auto& chars = pService->getCharacteristics(true);
            for (NimBLERemoteCharacteristic* pChar : chars) {
                if (!pChar) continue;
                if (pChar->canNotify()) {
                    if (pChar->subscribe(true, on_hid_report_notify)) {
                        ESP_LOGI(TAG, "  [+] Subscribed (notify) to %s", pChar->getUUID().toString().c_str());
                    }
                } else if (pChar->canIndicate()) {
                    if (pChar->subscribe(false, on_hid_report_notify)) {
                        ESP_LOGI(TAG, "  [+] Subscribed (indicate) to %s", pChar->getUUID().toString().c_str());
                    }
                }

                // Battery level characteristic (0x2A19)
                if (pChar->getUUID() == NimBLEUUID((uint16_t)0x2A19) && pChar->canRead()) {
                    uint8_t batt = pChar->readValue<uint8_t>();
                    ESP_LOGI(TAG, "Battery level: %d%%", (int)batt);
                    std::lock_guard<std::mutex> lock(s_ble_mutex);
                    for (auto& dev : s_paired_devices) {
                        if (iequals(dev.address, address)) {
                            dev.battery_pct = batt;
                            break;
                        }
                    }
                }
            }
        }
    } else {
        ESP_LOGW(TAG, "Connection to %s failed. Resuming continuous scan.", address.c_str());
        if (!s_ble_scanning) {
            NimBLEScan* pScan = NimBLEDevice::getScan();
            pScan->clearResults();
            pScan->setMaxResults(0);
            pScan->setDuplicateFilter(false);
            pScan->setActiveScan(false);
            pScan->start(0, false, true);
        }
    }
}

// ============================================================================
// Scan Callbacks
// ============================================================================
class ScanCallbacks : public NimBLEScanCallbacks {
    void onDiscovered(const NimBLEAdvertisedDevice* advertisedDevice) override {
        std::string addr = advertisedDevice->getAddress().toString();
        std::string name = advertisedDevice->getName();
        if (name.empty() || name == "Unknown Device") {
            char short_buf[32];
            std::string end_addr = addr.length() > 8 ? addr.substr(addr.length() - 8) : addr;
            snprintf(short_buf, sizeof(short_buf), "BLE Device [%s]", end_addr.c_str());
            name = short_buf;
        }
        int8_t rssi = advertisedDevice->getRSSI();
        uint8_t a_type = advertisedDevice->getAddressType();

        // 1. Discovery filtering: active user-initiated scan within vehicle range
        if (s_ble_scanning && rssi >= BLE_MIN_RSSI_DISCOVERY) {
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
                s_discovered_devices.push_back(nd);
            }
        }

        // 2. Check if device is paired and needs reconnection
        bool is_paired = false;
        std::string paired_name = "";
        {
            std::lock_guard<std::mutex> lock(s_ble_mutex);
            for (auto& paired : s_paired_devices) {
                if (iequals(paired.address, addr)) {
                    paired.rssi = rssi;
                    paired.addr_type = a_type;
                    if (!name.empty() && name.find("BLE Device") == std::string::npos) {
                        paired.name = name;
                    }
                    is_paired = true;
                    paired_name = paired.name;
                    break;
                }
            }
        }

        if (is_paired) {
            static uint32_t s_last_prox_send = 0;
            uint32_t now = get_time_ms();
            if (now - s_last_prox_send > 2000) {
                s_last_prox_send = now;
                can_engine_on_ble_device_event(addr, "proximity", rssi, paired_name);
            }

            // Request deferred connection if disconnected
            static uint32_t s_last_connect_attempt = 0;
            if (!s_ble_client_connected && (now - s_last_connect_attempt > 15000)) {
                s_last_connect_attempt = now;
                std::lock_guard<std::mutex> clock(s_connect_mutex);
                s_pending_connect_addr = addr;
                s_pending_connect_type = a_type;
                s_pending_connect_req = true;
            }
        }

        // 3. iBeacon / Proximity Detection
        std::string adv_uuid = "";
        uint16_t adv_major = 0;
        uint16_t adv_minor = 0;

        if (advertisedDevice->getManufacturerDataCount() > 0) {
            std::string mfg = advertisedDevice->getManufacturerData(0);
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
                    if (s_discovered_beacons.size() >= 10) s_discovered_beacons.erase(s_discovered_beacons.begin());
                    DiscoveredBeacon nb;
                    nb.uuid = adv_uuid;
                    nb.mac = addr;
                    nb.rssi = rssi;
                    nb.major = adv_major;
                    nb.minor = adv_minor;
                    nb.last_seen_ms = now_ms;
                    s_discovered_beacons.push_back(nb);
                }
            }
        }

        // 4. Match against configured beacon targets
        {
            uint32_t now_ms = get_time_ms();
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

                        cJSON* b_evt = cJSON_CreateObject();
                        cJSON_AddStringToObject(b_evt, "type", "ble_beacon");
                        cJSON_AddStringToObject(b_evt, "event", "enter");
                        cJSON_AddStringToObject(b_evt, "uuid", target.uuid.c_str());
                        cJSON_AddStringToObject(b_evt, "mac", addr.c_str());
                        cJSON_AddStringToObject(b_evt, "name", target.name.c_str());
                        cJSON_AddNumberToObject(b_evt, "rssi", target.last_rssi);
                        cJSON_AddNumberToObject(b_evt, "major", target.major);
                        cJSON_AddNumberToObject(b_evt, "minor", target.minor);
                        char* b_out = cJSON_PrintUnformatted(b_evt);
                        if (b_out) {
                            broadcast_ws_raw(b_out);
                            free(b_out);
                        }
                        cJSON_Delete(b_evt);

                        can_engine_on_ble_beacon_event(target.uuid, "enter", target.last_rssi, target.major, target.minor, addr, target.name);
                    } else if (target.is_present && (now_ms - target.last_prox_send_ms > 2500)) {
                        target.last_prox_send_ms = now_ms;

                        cJSON* b_evt = cJSON_CreateObject();
                        cJSON_AddStringToObject(b_evt, "type", "ble_beacon");
                        cJSON_AddStringToObject(b_evt, "event", "proximity");
                        cJSON_AddStringToObject(b_evt, "uuid", target.uuid.c_str());
                        cJSON_AddStringToObject(b_evt, "mac", addr.c_str());
                        cJSON_AddStringToObject(b_evt, "name", target.name.c_str());
                        cJSON_AddNumberToObject(b_evt, "rssi", target.last_rssi);
                        cJSON_AddNumberToObject(b_evt, "major", target.major);
                        cJSON_AddNumberToObject(b_evt, "minor", target.minor);
                        char* b_out = cJSON_PrintUnformatted(b_evt);
                        if (b_out) {
                            broadcast_ws_raw(b_out);
                            free(b_out);
                        }
                        cJSON_Delete(b_evt);

                        can_engine_on_ble_beacon_event(target.uuid, "proximity", target.last_rssi, target.major, target.minor, addr, target.name);
                    }
                }
            }
        }
    }

    void onScanEnd(const NimBLEScanResults& scanResults, int reason) override {
        s_ble_scanning = false;
        ESP_LOGI(TAG, "Active scan ended (reason: %d, count: %d)", reason, scanResults.getCount());

        if (!s_ble_client_connected && !s_ble_shutting_down.load(std::memory_order_relaxed)) {
            NimBLEScan* pScan = NimBLEDevice::getScan();
            pScan->clearResults();
            pScan->setMaxResults(0);
            pScan->setDuplicateFilter(false);
            pScan->setActiveScan(false);
            pScan->start(0, false, true);
        }
    }
} s_scan_callbacks;

// ============================================================================
// BLE Worker Task (Handles deferred connections & 1s beacon exit watchdog)
// ============================================================================
static void ble_worker_task(void* pvParameters) {
    uint32_t last_exit_check = get_time_ms();

    while (!s_ble_shutting_down.load(std::memory_order_relaxed)) {
        vTaskDelay(pdMS_TO_TICKS(150));
        if (s_ble_shutting_down.load(std::memory_order_relaxed)) break;

        // 1. Process deferred connect request
        std::string connect_addr = "";
        uint8_t connect_type = 0;
        bool do_connect = false;
        {
            std::lock_guard<std::mutex> clock(s_connect_mutex);
            if (s_pending_connect_req) {
                connect_addr = s_pending_connect_addr;
                connect_type = s_pending_connect_type;
                s_pending_connect_req = false;
                do_connect = true;
            }
        }
        if (do_connect && !connect_addr.empty()) {
            connect_ble_device(connect_addr, connect_type);
        }

        // 2. Beacon Exit Watchdog (runs once per second)
        uint32_t now = get_time_ms();
        if (now - last_exit_check >= 1000) {
            last_exit_check = now;
            std::vector<BeaconTarget> exited;
            {
                std::lock_guard<std::mutex> lock(s_ble_mutex);
                for (auto& target : s_beacon_targets) {
                    if (target.is_present && (now - target.last_seen_ms > (uint32_t)target.exit_timeout_s * 1000)) {
                        target.is_present = false;
                        target.smoothed_rssi = -100.0f;
                        target.last_rssi = -100;
                        exited.push_back(target);
                    }
                }
            }

            for (const auto& target : exited) {
                ESP_LOGI(TAG, "[BEACON] Target '%s' EXITED / AWAY (timeout %ds)", target.name.c_str(), target.exit_timeout_s);
                cJSON* b_evt = cJSON_CreateObject();
                cJSON_AddStringToObject(b_evt, "type", "ble_beacon");
                cJSON_AddStringToObject(b_evt, "event", "exit");
                cJSON_AddStringToObject(b_evt, "uuid", target.uuid.c_str());
                cJSON_AddStringToObject(b_evt, "mac", target.mac.c_str());
                cJSON_AddStringToObject(b_evt, "name", target.name.c_str());
                cJSON_AddNumberToObject(b_evt, "rssi", -100);
                char* b_out = cJSON_PrintUnformatted(b_evt);
                if (b_out) {
                    broadcast_ws_raw(b_out);
                    free(b_out);
                }
                cJSON_Delete(b_evt);

                can_engine_on_ble_beacon_event(target.uuid, "exit", -100, target.major, target.minor, target.mac, target.name);
            }
        }
    }
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
    pScan->setActiveScan(false); // Passive scan
    pScan->setInterval(160);     // 100ms
    pScan->setWindow(80);        // 50ms (50% coex duty cycle)
    pScan->setMaxResults(0);     // don't buffer in RAM
    pScan->setDuplicateFilter(false);
    pScan->start(0, false, true);

    xTaskCreate(ble_worker_task, "ble_worker", 4096, nullptr, 3, nullptr);
    ESP_LOGI(TAG, "Native BLE Central & Observer Subsystem initialized successfully.");
}

void ble_mgr_shutdown(void) {
    if (s_ble_shutting_down.exchange(true)) return;
    if (NimBLEDevice::isInitialized()) {
        NimBLEScan* pScan = NimBLEDevice::getScan();
        if (pScan) {
            pScan->stop();
        }
        vTaskDelay(pdMS_TO_TICKS(50));
        NimBLEDevice::deinit(false);
    }
}

std::string ble_mgr_get_status_json(void) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "enabled", true);
    cJSON_AddBoolToObject(root, "scanning", s_ble_scanning);

    std::lock_guard<std::mutex> lock(s_ble_mutex);

    // Connected device
    bool has_conn = false;
    for (const auto& dev : s_paired_devices) {
        if (dev.connected || iequals(dev.address, s_connected_device_addr)) {
            cJSON* conn = cJSON_CreateObject();
            cJSON_AddStringToObject(conn, "address", dev.address.c_str());
            cJSON_AddStringToObject(conn, "name", dev.name.c_str());
            cJSON_AddNumberToObject(conn, "rssi", dev.rssi);
            cJSON_AddBoolToObject(conn, "connected", true);
            cJSON_AddBoolToObject(conn, "bonded", dev.bonded);
            cJSON_AddNumberToObject(conn, "battery_pct", dev.battery_pct);
            cJSON_AddItemToObject(root, "connected_device", conn);
            has_conn = true;
            break;
        }
    }
    if (!has_conn) {
        cJSON_AddNullToObject(root, "connected_device");
    }

    // Paired devices
    cJSON* paired = cJSON_CreateArray();
    for (const auto& dev : s_paired_devices) {
        cJSON* itm = cJSON_CreateObject();
        cJSON_AddStringToObject(itm, "address", dev.address.c_str());
        cJSON_AddStringToObject(itm, "name", dev.name.c_str());
        cJSON_AddNumberToObject(itm, "rssi", dev.rssi);
        cJSON_AddBoolToObject(itm, "connected", dev.connected || iequals(dev.address, s_connected_device_addr));
        cJSON_AddBoolToObject(itm, "bonded", dev.bonded);
        cJSON_AddNumberToObject(itm, "battery_pct", dev.battery_pct);
        cJSON_AddItemToArray(paired, itm);
    }
    cJSON_AddItemToObject(root, "paired_devices", paired);

    // Discovered devices
    cJSON* disc = cJSON_CreateArray();
    for (const auto& dev : s_discovered_devices) {
        cJSON* itm = cJSON_CreateObject();
        cJSON_AddStringToObject(itm, "address", dev.address.c_str());
        cJSON_AddStringToObject(itm, "name", dev.name.c_str());
        cJSON_AddNumberToObject(itm, "rssi", dev.rssi);
        cJSON_AddBoolToObject(itm, "connected", false);
        cJSON_AddBoolToObject(itm, "bonded", false);
        cJSON_AddItemToArray(disc, itm);
    }
    cJSON_AddItemToObject(root, "discovered_devices", disc);

    // Last event
    if (s_has_last_event) {
        cJSON* ev = cJSON_CreateObject();
        cJSON_AddStringToObject(ev, "device_address", s_last_ble_event.device_address.c_str());
        cJSON_AddStringToObject(ev, "device_name", s_last_ble_event.device_name.c_str());
        cJSON_AddStringToObject(ev, "button_name", s_last_ble_event.button_name.c_str());
        cJSON_AddStringToObject(ev, "action", s_last_ble_event.action.c_str());
        cJSON_AddNumberToObject(ev, "timestamp_ms", s_last_ble_event.timestamp_ms);
        cJSON_AddItemToObject(root, "last_event", ev);
    } else {
        cJSON_AddNullToObject(root, "last_event");
    }

    // Recent events
    cJSON* recent = cJSON_CreateArray();
    for (const auto& ev : s_recent_ble_events) {
        cJSON* itm = cJSON_CreateObject();
        cJSON_AddStringToObject(itm, "device_address", ev.device_address.c_str());
        cJSON_AddStringToObject(itm, "device_name", ev.device_name.c_str());
        cJSON_AddStringToObject(itm, "button_name", ev.button_name.c_str());
        cJSON_AddStringToObject(itm, "action", ev.action.c_str());
        cJSON_AddNumberToObject(itm, "timestamp_ms", ev.timestamp_ms);
        cJSON_AddItemToArray(recent, itm);
    }
    cJSON_AddItemToObject(root, "recent_events", recent);

    // Beacon targets
    cJSON* btargets = cJSON_CreateArray();
    for (const auto& b : s_beacon_targets) {
        cJSON* itm = cJSON_CreateObject();
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

    // Discovered beacons (last 60s)
    uint32_t now_ms = get_time_ms();
    cJSON* dbeacons = cJSON_CreateArray();
    for (const auto& b : s_discovered_beacons) {
        if (now_ms - b.last_seen_ms < 60000) {
            cJSON* itm = cJSON_CreateObject();
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
        s_ble_scan_duration_ms = duration_sec * 1000;
        s_ble_scan_start_ms = get_time_ms();
        s_ble_scanning = true;
    }

    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->stop();
    pScan->clearResults();
    pScan->setMaxResults(0);
    pScan->setDuplicateFilter(true);
    pScan->setActiveScan(true);
    pScan->start(duration_sec * 1000, false, true);
    ESP_LOGI(TAG, "Started %u-second in-car active scan", (unsigned)duration_sec);
}

bool ble_mgr_pair_device(const std::string& address, const std::string& in_name) {
    if (address.empty()) return false;
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
                p.name = name;
                p.addr_type = addr_type;
                found = true;
                break;
            }
        }
        if (!found) {
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
    ESP_LOGI(TAG, "Paired device: %s (%s, type=%d)", address.c_str(), name.c_str(), addr_type);

    // Queue connection via worker
    {
        std::lock_guard<std::mutex> clock(s_connect_mutex);
        s_pending_connect_addr = address;
        s_pending_connect_type = addr_type;
        s_pending_connect_req = true;
    }
    return true;
}

void ble_mgr_unpair_device(const std::string& address) {
    if (s_ble_client && s_ble_client->isConnected()) {
        s_ble_client->disconnect();
    }

    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        if (address.empty()) {
            s_paired_devices.clear();
            s_held_buttons.clear();
        } else {
            for (auto it = s_paired_devices.begin(); it != s_paired_devices.end(); ++it) {
                if (iequals(it->address, address)) {
                    s_paired_devices.erase(it);
                    break;
                }
            }
        }
    }
    persist_paired_ble_devices();
    ESP_LOGI(TAG, "Unpaired device(s): %s", address.empty() ? "all" : address.c_str());
}

void ble_mgr_inject_test_event(const std::string& button, const std::string& action) {
    std::string btn = button.empty() ? "volume_up" : button;
    std::string act = action.empty() ? "press" : action;
    fire_ble_button_event("00:00:00:00:00:00", "Simulated Controller", btn, act);
}

std::string ble_mgr_get_beacons_json(void) {
    cJSON* resp = cJSON_CreateObject();
    cJSON* targets = cJSON_CreateArray();
    cJSON* disc = cJSON_CreateArray();

    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        for (const auto& b : s_beacon_targets) {
            cJSON* itm = cJSON_CreateObject();
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
            cJSON_AddItemToArray(targets, itm);
        }

        uint32_t now_ms = get_time_ms();
        for (const auto& b : s_discovered_beacons) {
            if (now_ms - b.last_seen_ms < 60000) {
                cJSON* itm = cJSON_CreateObject();
                cJSON_AddStringToObject(itm, "uuid", b.uuid.c_str());
                cJSON_AddStringToObject(itm, "mac", b.mac.c_str());
                cJSON_AddNumberToObject(itm, "rssi", b.rssi);
                cJSON_AddNumberToObject(itm, "major", b.major);
                cJSON_AddNumberToObject(itm, "minor", b.minor);
                cJSON_AddNumberToObject(itm, "last_seen_ms", b.last_seen_ms);
                cJSON_AddItemToArray(disc, itm);
            }
        }
    }

    cJSON_AddItemToObject(resp, "targets", targets);
    cJSON_AddItemToObject(resp, "discovered", disc);
    char* out = cJSON_PrintUnformatted(resp);
    std::string res = out ? out : "{\"targets\":[],\"discovered\":[]}";
    if (out) free(out);
    cJSON_Delete(resp);
    return res;
}

bool ble_mgr_set_beacon(const std::string& uuid, const std::string& mac, const std::string& name, int enter_rssi, int exit_timeout_s) {
    if (uuid.empty() && mac.empty()) return false;

    {
        std::lock_guard<std::mutex> lock(s_ble_mutex);
        bool updated = false;
        for (auto& b : s_beacon_targets) {
            if ((!uuid.empty() && iequals(b.uuid, uuid)) || (!mac.empty() && iequals(b.mac, mac))) {
                b.uuid = uuid;
                b.mac = mac;
                b.name = name.empty() ? "Phone Beacon" : name;
                b.enter_rssi = enter_rssi;
                b.exit_timeout_s = exit_timeout_s > 0 ? exit_timeout_s : 20;
                updated = true;
                break;
            }
        }
        if (!updated) {
            BeaconTarget bt;
            bt.uuid = uuid;
            bt.mac = mac;
            bt.name = name.empty() ? "Phone Beacon" : name;
            bt.enter_rssi = enter_rssi;
            bt.exit_timeout_s = exit_timeout_s > 0 ? exit_timeout_s : 20;
            s_beacon_targets.push_back(bt);
        }
    }

    persist_beacon_targets();
    return true;
}

bool ble_mgr_delete_beacon(const std::string& uuid, const std::string& mac) {
    if (uuid.empty() && mac.empty()) return false;

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
    return true;
}

bool ble_mgr_is_enabled(void) {
    return true;
}

bool ble_mgr_is_scanning(void) {
    return s_ble_scanning;
}

#else // !CONFIG_BT_ENABLED

void ble_mgr_init(void) {
    ESP_LOGI(TAG, "Bluetooth is disabled in sdkconfig. ble_mgr inactive.");
}

void ble_mgr_shutdown(void) {}

std::string ble_mgr_get_status_json(void) {
    return "{\"enabled\":false,\"scanning\":false,\"connected_device\":null,\"paired_devices\":[],\"discovered_devices\":[],\"beacon_targets\":[],\"discovered_beacons\":[]}";
}

void ble_mgr_start_scan(uint32_t duration_sec) { (void)duration_sec; }
bool ble_mgr_pair_device(const std::string& address, const std::string& name) { (void)address; (void)name; return false; }
void ble_mgr_unpair_device(const std::string& address) { (void)address; }
void ble_mgr_inject_test_event(const std::string& button, const std::string& action) { (void)button; (void)action; }
std::string ble_mgr_get_beacons_json(void) { return "{\"targets\":[],\"discovered\":[]}"; }
bool ble_mgr_set_beacon(const std::string& uuid, const std::string& mac, const std::string& name, int enter_rssi, int exit_timeout_s) {
    (void)uuid; (void)mac; (void)name; (void)enter_rssi; (void)exit_timeout_s; return false;
}
bool ble_mgr_delete_beacon(const std::string& uuid, const std::string& mac) { (void)uuid; (void)mac; return false; }
bool ble_mgr_is_enabled(void) { return false; }
bool ble_mgr_is_scanning(void) { return false; }

#endif // CONFIG_BT_ENABLED

