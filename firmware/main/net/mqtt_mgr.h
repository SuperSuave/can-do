#pragma once

#include <string>
#include <vector>
#include <unordered_set>
#include <atomic>
#include "esp_err.h"
#include "mqtt_client.h"

struct MqttConfig {
    bool enabled = true;
    std::string broker_url = "mqtt://homeassistant.local:1883";
    std::string username = "";
    std::string password = "";
    bool ha_discovery_enabled = false;
};

extern esp_mqtt_client_handle_t global_mqtt_client;
extern const std::string MQTT_BASE_TOPIC;

void mqtt_mgr_init(void);
void mqtt_mgr_start(void);
void mqtt_mgr_stop(void);
void mqtt_mgr_on_wifi_disconnect(void);
void mqtt_mgr_on_wifi_connect(void);
void mqtt_mgr_watchdog(void);
bool mqtt_mgr_is_connected(void);
MqttConfig mqtt_mgr_get_config(void);
bool mqtt_mgr_save_config(const MqttConfig& cfg);
void mqtt_mgr_publish_discovery(void);
void mqtt_mgr_clear_discovery(void);

void mqtt_mgr_publish_can_state(uint32_t can_id, const uint8_t* data, size_t len);
void mqtt_mgr_publish_entity_state(const std::string& entity_id, const std::string& state);
void mqtt_mgr_set_monitored_ids(const std::vector<uint32_t>& ids);
bool mqtt_mgr_is_monitored_id(uint32_t can_id);

struct BleButtonEvent;
void mqtt_mgr_publish_vbat(float vbat);
void mqtt_mgr_publish_bms(float kw, float soc, float v, float a, float delta_mv, int min_t, int max_t);
void mqtt_mgr_publish_ble_button(const std::string& address, const std::string& button, const std::string& action, const std::string& combo = "");
void mqtt_mgr_publish_ble_device(const std::string& address, const std::string& event, int8_t rssi, const std::string& name = "");
void mqtt_mgr_publish_ble_beacon(const std::string& uuid, const std::string& event, int8_t rssi, uint16_t major = 0, uint16_t minor = 0, const std::string& mac = "", const std::string& name = "");

