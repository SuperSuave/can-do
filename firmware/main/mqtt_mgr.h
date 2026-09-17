#pragma once

#include <string>
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
