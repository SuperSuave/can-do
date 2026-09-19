#include "mqtt_mgr.h"
#include "parser.h"
#include "can_engine.h"
#include "track_popup.h"
#include "ble_mgr.h"
#include "cJSON.h"
#include "esp_log.h"
#include <cstdio>
#include <cstring>
#include <mutex>
#include <unordered_set>

static const char* TAG = "MQTT_MGR";
static const char* MQTT_CONFIG_FILE = "/spiffs/mqtt.json";

extern std::string g_device_id;
#define DEVICE_ID g_device_id

const std::string MQTT_BASE_TOPIC = "cando";
esp_mqtt_client_handle_t global_mqtt_client = nullptr;

static std::mutex s_mqtt_mutex;
static MqttConfig s_mqtt_cfg;
static std::atomic<bool> s_mqtt_connected{false};
static std::string s_lwt_topic;

// Default monitored CAN IDs (Gen5W / E-GMP vehicle telemetry)
static std::unordered_set<uint32_t> s_monitored_ids = {
    0x038, 0x0A2, 0x130, 0x152, 0x1AC, 0x1CF, 0x226, 0x227,
    0x2AD, 0x2AF, 0x2C0, 0x2FC, 0x31B, 0x380, 0x384, 0x3AA,
    0x3C1, 0x411, 0x412, 0x414, 0x418, 0x435, 0x438, 0x442,
    0x448, 0x474, 0x475, 0x476, 0x478, 0x47F, 0x496, 0x4CE,
    0x540, 0x541, 0x594, 0x60E, 0x651, 0x652
};
static std::mutex s_monitored_mutex;

void mqtt_mgr_publish_can_state(uint32_t can_id, const uint8_t* data, size_t len) {
    if (!global_mqtt_client || !s_mqtt_connected.load()) return;
    char topic[64];
    snprintf(topic, sizeof(topic), "%s/%s/state/0x%03lX", MQTT_BASE_TOPIC.c_str(), DEVICE_ID.c_str(), (unsigned long)can_id);
    char hex_payload[17] = {0};
    for (size_t i = 0; i < len && i < 8; i++) {
        snprintf(&hex_payload[i * 2], 3, "%02X", data[i]);
    }
    esp_mqtt_client_publish(global_mqtt_client, topic, hex_payload, 0, 1, 1);
}

void mqtt_mgr_set_monitored_ids(const std::vector<uint32_t>& ids) {
    std::lock_guard<std::mutex> lock(s_monitored_mutex);
    s_monitored_ids.clear();
    for (uint32_t id : ids) {
        s_monitored_ids.insert(id);
    }
}

bool mqtt_mgr_is_monitored_id(uint32_t can_id) {
    std::lock_guard<std::mutex> lock(s_monitored_mutex);
    return s_monitored_ids.find(can_id) != s_monitored_ids.end();
}

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
        case MQTT_EVENT_CONNECTED: {
            s_mqtt_connected = true;
            ESP_LOGI(TAG, "MQTT connected to broker (%s)", s_mqtt_cfg.broker_url.c_str());

            // 1. Publish LWT online status
            std::string status_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/status";
            esp_mqtt_client_publish(global_mqtt_client, status_topic.c_str(), "online", 6, 1, 1);

            // 2. Subscribe to control topics
            std::string tx_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/tx";
            esp_mqtt_client_subscribe(global_mqtt_client, tx_topic.c_str(), 1);

            std::string notify_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/notify";
            esp_mqtt_client_subscribe(global_mqtt_client, notify_topic.c_str(), 1);

            std::string sub_ids_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/subscribe_ids";
            esp_mqtt_client_subscribe(global_mqtt_client, sub_ids_topic.c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/set/#").c_str(), 1);

            // 3. Publish initial state of all currently cached monitored IDs
            {
                std::lock_guard<std::mutex> lock(s_monitored_mutex);
                for (uint32_t can_id : s_monitored_ids) {
                    uint8_t data[8] = {0};
                    if (get_cached_can_frame(can_id, data)) {
                        mqtt_mgr_publish_can_state(can_id, data, 8);
                    }
                }
            }

            // 4. Publish HA discovery if any global catalog entities exist
            for (const auto& entity : global_catalog) {
                publish_ha_discovery(global_mqtt_client, entity);
            }
            break;
        }

        case MQTT_EVENT_DISCONNECTED:
            s_mqtt_connected = false;
            ESP_LOGW(TAG, "MQTT disconnected from broker");
            break;

        case MQTT_EVENT_DATA: {
            std::string topic(event->topic, event->topic_len);
            std::string payload(event->data, event->data_len);

            std::string tx_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/tx";
            std::string notify_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/notify";
            std::string sub_ids_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/subscribe_ids";
            std::string set_prefix = MQTT_BASE_TOPIC + "/set/";

            if (topic == notify_topic) {
                ESP_LOGI(TAG, "Received cluster notify request: %s", payload.c_str());
                std::string msg = payload;
                std::string level = "info";
                cJSON* root = cJSON_Parse(payload.c_str());
                if (root) {
                    cJSON* m = cJSON_GetObjectItem(root, "message");
                    if (!m) m = cJSON_GetObjectItem(root, "text");
                    if (!m) m = cJSON_GetObjectItem(root, "popup_message");
                    if (m && cJSON_IsString(m)) msg = m->valuestring;

                    cJSON* l = cJSON_GetObjectItem(root, "level");
                    if (l && cJSON_IsString(l)) level = l->valuestring;
                    cJSON_Delete(root);
                }
                if (level == "warning") {
                    track_popup_show_warning(msg.c_str());
                } else if (level == "error") {
                    track_popup_show_error(msg.c_str());
                } else {
                    track_popup_show_info(msg.c_str());
                }
            } else if (topic == tx_topic) {
                ESP_LOGI(TAG, "Received raw action burst: %s", payload.c_str());
                cJSON* root = cJSON_Parse(payload.c_str());
                if (root) {
                    uint32_t can_id = 0;
                    cJSON* id_item = cJSON_GetObjectItem(root, "can_id");
                    if (id_item && cJSON_IsString(id_item)) {
                        can_id = strtoul(id_item->valuestring, nullptr, 0);
                    } else if (id_item && cJSON_IsNumber(id_item)) {
                        can_id = (uint32_t)id_item->valueint;
                    }

                    uint32_t delay_ms = 20;
                    cJSON* del_item = cJSON_GetObjectItem(root, "delay_ms");
                    if (del_item && cJSON_IsNumber(del_item)) {
                        delay_ms = del_item->valueint;
                    }

                    std::vector<ActionStep> steps;
                    cJSON* steps_arr = cJSON_GetObjectItem(root, "steps");
                    if (steps_arr && cJSON_IsArray(steps_arr)) {
                        int count = cJSON_GetArraySize(steps_arr);
                        for (int i = 0; i < count; i++) {
                            cJSON* s = cJSON_GetArrayItem(steps_arr, i);
                            if (!s) continue;
                            ActionStep step;
                            step.type = ActionType::TRANSMIT_FRAME;
                            step.can_id = can_id;
                            step.mask = 0xFF;
                            step.repeat = 1;
                            step.delay_ms = delay_ms;

                            cJSON* rep = cJSON_GetObjectItem(s, "repeat");
                            if (rep && cJSON_IsNumber(rep)) step.repeat = rep->valueint;

                            cJSON* sdel = cJSON_GetObjectItem(s, "delay_ms");
                            if (sdel && cJSON_IsNumber(sdel)) step.delay_ms = sdel->valueint;

                            cJSON* pay = cJSON_GetObjectItem(s, "payload");
                            if (pay && cJSON_IsString(pay)) {
                                const char* hex = pay->valuestring;
                                size_t hlen = strlen(hex);
                                for (size_t b = 0; b < 8 && (b * 2 + 1) < hlen; b++) {
                                    char byte_str[3] = {hex[b * 2], hex[b * 2 + 1], '\0'};
                                    step.payload[b] = (uint8_t)strtoul(byte_str, nullptr, 16);
                                }
                            }
                            steps.push_back(step);
                        }
                    }
                    cJSON_Delete(root);

                    if (!steps.empty()) {
                        queue_action_steps(can_id, delay_ms, steps);
                    }
                }
            } else if (topic == sub_ids_topic) {
                cJSON* root = cJSON_Parse(payload.c_str());
                if (root && cJSON_IsArray(root)) {
                    std::vector<uint32_t> ids;
                    int count = cJSON_GetArraySize(root);
                    for (int i = 0; i < count; i++) {
                        cJSON* itm = cJSON_GetArrayItem(root, i);
                        if (itm && cJSON_IsString(itm)) {
                            ids.push_back(strtoul(itm->valuestring, nullptr, 0));
                        } else if (itm && cJSON_IsNumber(itm)) {
                            ids.push_back((uint32_t)itm->valueint);
                        }
                    }
                    mqtt_mgr_set_monitored_ids(ids);
                    ESP_LOGI(TAG, "Updated monitored CAN IDs (%d IDs)", (int)ids.size());
                }
                if (root) cJSON_Delete(root);
            } else if (topic.rfind(set_prefix, 0) == 0) {
                std::string entity_id = topic.substr(set_prefix.length());
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

    // Set LWT (Last Will and Testament)
    s_lwt_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/status";
    mqtt_cfg.session.last_will.topic = s_lwt_topic.c_str();
    mqtt_cfg.session.last_will.msg = "offline";
    mqtt_cfg.session.last_will.msg_len = 7;
    mqtt_cfg.session.last_will.qos = 1;
    mqtt_cfg.session.last_will.retain = 1;

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

static void publish_ha_ble_discovery(esp_mqtt_client_handle_t client) {
    if (!client) return;

    // 1. Home Assistant Event Entity for BLE Button / Macro Controller
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "name", "Bluetooth Button Controller");
    std::string unique_id = DEVICE_ID + "_ble_button";
    cJSON_AddStringToObject(root, "unique_id", unique_id.c_str());
    cJSON_AddStringToObject(root, "object_id", "ble_button");
    cJSON_AddStringToObject(root, "icon", "mdi:bluetooth-audio");
    cJSON_AddStringToObject(root, "state_topic", (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/event/ble_button").c_str());

    cJSON *event_types = cJSON_AddArrayToObject(root, "event_types");
    const char* types[] = {
        "press", "release", "volume_up", "volume_down", "play_pause",
        "next_track", "prev_track", "mute", "key_1", "key_2", "key_3",
        "key_4", "key_5", "key_6", "key_7", "key_8", "key_9", "key_enter", "key_space"
    };
    for (size_t i = 0; i < sizeof(types)/sizeof(types[0]); i++) {
        cJSON_AddItemToArray(event_types, cJSON_CreateString(types[i]));
    }

    cJSON *device = cJSON_AddObjectToObject(root, "device");
    cJSON_AddStringToObject(device, "identifiers", DEVICE_ID.c_str());
    cJSON_AddStringToObject(device, "name", ("CAN Do (" + DEVICE_ID + ")").c_str());
    cJSON_AddStringToObject(device, "model", "Edge Engine");
    cJSON_AddStringToObject(device, "manufacturer", "CAN Do");

    char *payload = cJSON_PrintUnformatted(root);
    std::string topic = "homeassistant/event/" + DEVICE_ID + "/ble_button/config";
    esp_mqtt_client_publish(client, topic.c_str(), payload, 0, 1, 1);
    free(payload);
    cJSON_Delete(root);

    // 2. Home Assistant Sensor for BLE Connection Status
    cJSON *s_root = cJSON_CreateObject();
    cJSON_AddStringToObject(s_root, "name", "Bluetooth Controller Status");
    std::string s_uid = DEVICE_ID + "_ble_status";
    cJSON_AddStringToObject(s_root, "unique_id", s_uid.c_str());
    cJSON_AddStringToObject(s_root, "object_id", "ble_status");
    cJSON_AddStringToObject(s_root, "icon", "mdi:bluetooth-connect");
    cJSON_AddStringToObject(s_root, "state_topic", (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/ble/status").c_str());
    cJSON *s_dev = cJSON_AddObjectToObject(s_root, "device");
    cJSON_AddStringToObject(s_dev, "identifiers", DEVICE_ID.c_str());
    cJSON_AddStringToObject(s_dev, "name", ("CAN Do (" + DEVICE_ID + ")").c_str());
    cJSON_AddStringToObject(s_dev, "model", "Edge Engine");
    cJSON_AddStringToObject(s_dev, "manufacturer", "CAN Do");

    char *s_payload = cJSON_PrintUnformatted(s_root);
    std::string s_topic = "homeassistant/sensor/" + DEVICE_ID + "/ble_status/config";
    esp_mqtt_client_publish(client, s_topic.c_str(), s_payload, 0, 1, 1);
    free(s_payload);
    cJSON_Delete(s_root);
}

void mqtt_mgr_publish_ble_event(const BleButtonEvent& event) {
    if (!global_mqtt_client || !s_mqtt_connected.load()) return;

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "event_type", event.button_name.c_str());
    cJSON_AddStringToObject(root, "button", event.button_name.c_str());
    cJSON_AddStringToObject(root, "action", event.action.c_str());
    cJSON_AddStringToObject(root, "device", event.device_name.c_str());
    cJSON_AddStringToObject(root, "address", event.device_address.c_str());
    cJSON_AddNumberToObject(root, "keycode", event.key_code);
    cJSON_AddNumberToObject(root, "ts", event.timestamp_ms);

    char *payload = cJSON_PrintUnformatted(root);
    std::string topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/event/ble_button";
    esp_mqtt_client_publish(global_mqtt_client, topic.c_str(), payload, 0, 1, 0);

    free(payload);
    cJSON_Delete(root);
}

void mqtt_mgr_publish_ble_status(void) {
    if (!global_mqtt_client || !s_mqtt_connected.load()) return;

    BleDeviceInfo dev;
    bool connected = ble_mgr_get_connected_device(&dev);
    std::string status_str = connected ? "connected" : "disconnected";
    std::string topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/ble/status";
    esp_mqtt_client_publish(global_mqtt_client, topic.c_str(), status_str.c_str(), 0, 1, 1);
}

void mqtt_mgr_publish_discovery(void) {
    if (global_mqtt_client && s_mqtt_connected.load()) {
        for (const auto& entity : global_catalog) {
            publish_ha_discovery(global_mqtt_client, entity);
        }
        publish_ha_ble_discovery(global_mqtt_client);
    }
}
