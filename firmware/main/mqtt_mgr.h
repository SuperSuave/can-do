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
};

extern esp_mqtt_client_handle_t global_mqtt_client;
extern const std::string MQTT_BASE_TOPIC;

void mqtt_mgr_init(void);
void mqtt_mgr_start(void);
void mqtt_mgr_stop(void);
bool mqtt_mgr_is_connected(void);
MqttConfig mqtt_mgr_get_config(void);
bool mqtt_mgr_save_config(const MqttConfig& cfg);
void mqtt_mgr_publish_discovery(void);

void mqtt_mgr_publish_can_state(uint32_t can_id, const uint8_t* data, size_t len);
void mqtt_mgr_set_monitored_ids(const std::vector<uint32_t>& ids);
bool mqtt_mgr_is_monitored_id(uint32_t can_id);

struct BleButtonEvent;
void mqtt_mgr_publish_ble_event(const BleButtonEvent& event);
void mqtt_mgr_publish_ble_status(void);

