#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include "sdkconfig.h"

#ifdef __cplusplus
extern "C" {
#endif

void ble_mgr_init(void);
void ble_mgr_shutdown(void);

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
std::string ble_mgr_get_status_json(void);
void ble_mgr_start_scan(uint32_t duration_sec);
bool ble_mgr_pair_device(const std::string& address, const std::string& name);
void ble_mgr_unpair_device(const std::string& address = "");
void ble_mgr_inject_test_event(const std::string& button, const std::string& action);
std::string ble_mgr_get_beacons_json(void);
bool ble_mgr_set_beacon(const std::string& uuid, const std::string& mac, const std::string& name, int enter_rssi, int exit_timeout_s);
bool ble_mgr_delete_beacon(const std::string& uuid, const std::string& mac);
bool ble_mgr_is_enabled(void);
bool ble_mgr_is_scanning(void);
#endif

