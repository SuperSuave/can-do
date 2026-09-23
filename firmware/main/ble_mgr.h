#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include <functional>
#include "esp_err.h"

struct BleDeviceInfo {
    std::string name;
    std::string address;     // e.g. "AA:BB:CC:DD:EE:FF"
    uint8_t addr_type = 0;
    int rssi = 0;
    bool connected = false;
    bool bonded = false;
    int battery_pct = -1;    // -1 if unknown, 0..100
    uint32_t last_seen_ms = 0;
};

struct BleButtonEvent {
    std::string device_address;
    std::string device_name;
    std::string button_name; // "volume_up", "volume_down", "play_pause", "next_track", "prev_track", "mute", "key_1".."key_9", "key_enter", etc.
    std::string action;      // "press", "release", "hold"
    uint8_t key_code = 0;
    uint8_t modifiers = 0;
    uint32_t timestamp_ms = 0;
};

using BleButtonCallback = std::function<void(const BleButtonEvent&)>;

// Initialization and state
esp_err_t ble_mgr_init(void);
bool ble_mgr_is_enabled(void);
bool ble_mgr_is_scanning(void);

// Scanning and discovery
esp_err_t ble_mgr_start_scan(uint32_t duration_sec = 15);
esp_err_t ble_mgr_stop_scan(void);

// Connection and pairing
esp_err_t ble_mgr_connect(const std::string& address);
esp_err_t ble_mgr_disconnect(const std::string& address = "");
esp_err_t ble_mgr_unpair(const std::string& address = "");

// Device info queries
std::vector<BleDeviceInfo> ble_mgr_get_discovered_devices(void);
std::vector<BleDeviceInfo> ble_mgr_get_paired_devices(void);
bool ble_mgr_get_connected_device(BleDeviceInfo* out_dev);

// Event callbacks & test injection
void ble_mgr_register_event_cb(BleButtonCallback cb);
void ble_mgr_test_inject_event(const std::string& button_name, const std::string& action, uint8_t key_code = 0);

// Helper: Convert standard HID Consumer Usage code to button name
const char* ble_hid_consumer_code_to_name(uint16_t usage_code);

// Helper: Convert standard HID Keyboard Usage code to button name
const char* ble_hid_keyboard_code_to_name(uint8_t keycode);
