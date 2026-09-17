#include "mqtt_mgr.h"
#include "parser.h"
#include "can_engine.h"
#include "cJSON.h"
#include "esp_log.h"
#include <cstdio>
#include <cstring>
#include <mutex>

static const char* TAG = "MQTT_MGR";
static const char* MQTT_CONFIG_FILE = "/spiffs/mqtt.json";

extern std::string g_device_id;
#define DEVICE_ID g_device_id

const std::string MQTT_BASE_TOPIC = "cando";
esp_mqtt_client_handle_t global_mqtt_client = nullptr;

static std::mutex s_mqtt_mutex;
static MqttConfig s_mqtt_cfg;
static std::atomic<bool> s_mqtt_connected{false};

static void publish_ha_discovery(esp_mqtt_client_handle_t client, const CanEntity& entity) {
    if (!client || entity.ha_domain.empty()) return;

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "name", entity.ha_name.c_str());

    std::string unique_id = DEVICE_ID + "_" + entity.id;
    cJSON_AddStringToObject(root, "unique_id", unique_id.c_str());
    cJSON_AddStringToObject(root, "object_id", entity.id.c_str());

    if (!entity.ha_icon.empty()) {
        cJSON_AddStringToObject(root, "icon", entity.ha_icon.c_str());
    }

    if (!entity.options.empty()) {
        cJSON *options_array = cJSON_AddArrayToObject(root, "options");
        for (const auto& opt : entity.options) {
            cJSON_AddItemToArray(options_array, cJSON_CreateString(opt.label.c_str()));
        }
    }

    std::string cmd_topic = MQTT_BASE_TOPIC + "/set/" + entity.id;
    std::string state_topic = MQTT_BASE_TOPIC + "/state/" + entity.id;
    cJSON_AddStringToObject(root, "command_topic", cmd_topic.c_str());
    cJSON_AddStringToObject(root, "state_topic", state_topic.c_str());

    // Device grouping block for Home Assistant integration
    cJSON *device = cJSON_AddObjectToObject(root, "device");
    cJSON_AddStringToObject(device, "identifiers", DEVICE_ID.c_str());
    cJSON_AddStringToObject(device, "name", ("CAN Do (" + DEVICE_ID + ")").c_str());
    cJSON_AddStringToObject(device, "model", "Edge Engine");
    cJSON_AddStringToObject(device, "manufacturer", "CAN Do");

    char *payload = cJSON_PrintUnformatted(root);
    std::string topic = "homeassistant/" + entity.ha_domain + "/" + DEVICE_ID + "/" + entity.id + "/config";
    esp_mqtt_client_publish(client, topic.c_str(), payload, 0, 1, 1);

    free(payload);
    cJSON_Delete(root);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    auto event = static_cast<esp_mqtt_event_handle_t>(event_data);
    switch (event->event_id) {
        case MQTT_EVENT_CONNECTED:
            s_mqtt_connected = true;
            ESP_LOGI(TAG, "MQTT connected to broker. Publishing Home Assistant discovery & subscribing...");
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/set/#").c_str(), 1);
            for (const auto& entity : global_catalog) {
                publish_ha_discovery(global_mqtt_client, entity);
            }
            break;

        case MQTT_EVENT_DISCONNECTED:
            s_mqtt_connected = false;
            ESP_LOGW(TAG, "MQTT disconnected from broker");
            break;

        case MQTT_EVENT_DATA: {
            std::string topic(event->topic, event->topic_len);
            std::string payload(event->data, event->data_len);
            std::string base_path = MQTT_BASE_TOPIC + "/set/";
            if (topic.rfind(base_path, 0) == 0) {
                std::string entity_id = topic.substr(base_path.length());
                queue_entity_command(entity_id, payload);
            }
            break;
        }
        default:
            break;
    }
}

static void load_settings_from_fs(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);

    // Set defaults from Kconfig if defined
#if defined(CONFIG_CAN_DO_MQTT_BROKER_URL)
    s_mqtt_cfg.broker_url = CONFIG_CAN_DO_MQTT_BROKER_URL;
#else
    s_mqtt_cfg.broker_url = "mqtt://homeassistant.local:1883";
#endif
#if defined(CONFIG_CAN_DO_MQTT_USERNAME)
    s_mqtt_cfg.username = CONFIG_CAN_DO_MQTT_USERNAME;
#endif
#if defined(CONFIG_CAN_DO_MQTT_PASSWORD)
    s_mqtt_cfg.password = CONFIG_CAN_DO_MQTT_PASSWORD;
#endif
    s_mqtt_cfg.enabled = true;

    FILE* f = fopen(MQTT_CONFIG_FILE, "r");
    if (!f) {
        ESP_LOGI(TAG, "No %s found, using defaults: %s", MQTT_CONFIG_FILE, s_mqtt_cfg.broker_url.c_str());
        return;
    }

    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (len <= 0) {
        fclose(f);
        return;
    }

    std::string content(len, '\0');
    fread(&content[0], 1, len, f);
    fclose(f);

    cJSON* root = cJSON_Parse(content.c_str());
    if (!root) return;

    cJSON* enabled_item = cJSON_GetObjectItem(root, "enabled");
    if (cJSON_IsBool(enabled_item)) {
        s_mqtt_cfg.enabled = cJSON_IsTrue(enabled_item);
    }

    cJSON* url_item = cJSON_GetObjectItem(root, "broker_url");
    if (cJSON_IsString(url_item) && strlen(url_item->valuestring) > 0) {
        s_mqtt_cfg.broker_url = url_item->valuestring;
    }

    cJSON* user_item = cJSON_GetObjectItem(root, "username");
    if (cJSON_IsString(user_item)) {
        s_mqtt_cfg.username = user_item->valuestring;
    }

    cJSON* pass_item = cJSON_GetObjectItem(root, "password");
    if (cJSON_IsString(pass_item)) {
        s_mqtt_cfg.password = pass_item->valuestring;
    }

    cJSON_Delete(root);
    ESP_LOGI(TAG, "Loaded MQTT settings from %s (enabled=%d, broker=%s)",
             MQTT_CONFIG_FILE, s_mqtt_cfg.enabled, s_mqtt_cfg.broker_url.c_str());
}

void mqtt_mgr_init(void) {
    load_settings_from_fs();
}

void mqtt_mgr_start(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);
    if (!s_mqtt_cfg.enabled || s_mqtt_cfg.broker_url.empty()) {
        ESP_LOGI(TAG, "MQTT is disabled or broker URL is empty");
        return;
    }

    if (global_mqtt_client) {
        esp_mqtt_client_stop(global_mqtt_client);
        esp_mqtt_client_destroy(global_mqtt_client);
        global_mqtt_client = nullptr;
        s_mqtt_connected = false;
    }

    esp_mqtt_client_config_t mqtt_cfg = {};
    mqtt_cfg.broker.address.uri = s_mqtt_cfg.broker_url.c_str();
    if (!s_mqtt_cfg.username.empty()) {
        mqtt_cfg.credentials.username = s_mqtt_cfg.username.c_str();
    }
    if (!s_mqtt_cfg.password.empty()) {
        mqtt_cfg.credentials.authentication.password = s_mqtt_cfg.password.c_str();
    }

    global_mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    if (global_mqtt_client) {
        esp_mqtt_client_register_event(global_mqtt_client, MQTT_EVENT_ANY, mqtt_event_handler, nullptr);
        esp_mqtt_client_start(global_mqtt_client);
        ESP_LOGI(TAG, "MQTT client started for broker: %s", s_mqtt_cfg.broker_url.c_str());
    } else {
        ESP_LOGE(TAG, "Failed initializing esp_mqtt_client");
    }
}

void mqtt_mgr_stop(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);
    if (global_mqtt_client) {
        esp_mqtt_client_stop(global_mqtt_client);
        esp_mqtt_client_destroy(global_mqtt_client);
        global_mqtt_client = nullptr;
        s_mqtt_connected = false;
        ESP_LOGI(TAG, "MQTT client stopped");
    }
}

bool mqtt_mgr_is_connected(void) {
    return s_mqtt_connected.load();
}

MqttConfig mqtt_mgr_get_config(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);
    return s_mqtt_cfg;
}

bool mqtt_mgr_save_config(const MqttConfig& cfg) {
    {
        std::lock_guard<std::mutex> lock(s_mqtt_mutex);
        s_mqtt_cfg = cfg;

        cJSON* root = cJSON_CreateObject();
        cJSON_AddBoolToObject(root, "enabled", s_mqtt_cfg.enabled);
        cJSON_AddStringToObject(root, "broker_url", s_mqtt_cfg.broker_url.c_str());
        cJSON_AddStringToObject(root, "username", s_mqtt_cfg.username.c_str());
        cJSON_AddStringToObject(root, "password", s_mqtt_cfg.password.c_str());

        char* rendered = cJSON_Print(root);
        cJSON_Delete(root);

        if (rendered) {
            FILE* f = fopen(MQTT_CONFIG_FILE, "w");
            if (f) {
                fputs(rendered, f);
                fclose(f);
                ESP_LOGI(TAG, "Saved MQTT settings to %s", MQTT_CONFIG_FILE);
            } else {
                ESP_LOGE(TAG, "Failed to open %s for write", MQTT_CONFIG_FILE);
            }
            free(rendered);
        }
    }

    // Restart client with new configuration
    if (cfg.enabled) {
        mqtt_mgr_start();
    } else {
        mqtt_mgr_stop();
    }
    return true;
}

void mqtt_mgr_publish_discovery(void) {
    if (global_mqtt_client && s_mqtt_connected.load()) {
        for (const auto& entity : global_catalog) {
            publish_ha_discovery(global_mqtt_client, entity);
        }
    }
}
