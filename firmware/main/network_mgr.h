#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include "esp_err.h"
#include "esp_wifi_types.h"

enum ApFallbackMode {
    AP_MODE_AUTO = 0,    // Auto teardown when STA gets IP, auto bring up when lost
    AP_MODE_ALWAYS_ON,   // AP remains running alongside STA
    AP_MODE_DISABLED     // AP never turns on
};

struct KnownNetwork {
    std::string ssid;
    std::string password;
    int priority; // 1 - 100 (higher = preferred)
};

struct WifiScanResult {
    std::string ssid;
    int8_t rssi;
    uint8_t authmode;
    bool in_known_list;
};

struct NetworkStatusInfo {
    bool sta_connected;
    std::string sta_ssid;
    std::string sta_ip;
    std::string sta_gw;
    std::string sta_mask;
    int8_t sta_rssi;
    bool ap_active;
    std::string ap_ssid;
    std::string ap_ip;
    int ap_clients;
    ApFallbackMode ap_mode;
};

// Lifecycle & Control
esp_err_t network_mgr_init(void);
NetworkStatusInfo network_mgr_get_status(void);

// Known Networks Management
std::vector<KnownNetwork> network_mgr_get_known_networks(void);
bool network_mgr_add_known_network(const std::string& ssid, const std::string& password, int priority);
bool network_mgr_remove_known_network(const std::string& ssid);

// AP Settings
void network_mgr_set_ap_mode(ApFallbackMode mode);
ApFallbackMode network_mgr_get_ap_mode(void);
void network_mgr_set_ap_credentials(const std::string& ssid, const std::string& password);

// Asynchronous Wi-Fi Scanning
bool network_mgr_start_scan(void);
bool network_mgr_is_scanning(void);
std::vector<WifiScanResult> network_mgr_get_scan_results(void);
