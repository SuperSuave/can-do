#include "mqtt_mgr.h"
#include "parser.h"
#include "can_engine.h"
#include "track_popup.h"
#include "hud_nav.h"
#include "cJSON.h"
#include "esp_log.h"
#include <cstdio>
#include <cstring>
#include <mutex>
#include <unordered_set>
#include "esp_system.h"
#include "esp_timer.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <sys/unistd.h>
#include <sys/stat.h>

static const char* TAG = "MQTT_MGR";
static const char* MQTT_CONFIG_FILE = "/spiffs/mqtt.json";

extern std::string g_device_id;
#define DEVICE_ID g_device_id

const std::string MQTT_BASE_TOPIC = "cando";
esp_mqtt_client_handle_t global_mqtt_client = nullptr;

static std::mutex s_mqtt_mutex;
static MqttConfig s_mqtt_cfg;
static std::atomic<bool> s_mqtt_connected{false};
static std::atomic<bool> s_sync_task_running{false};
static std::string s_lwt_topic;

static FILE* s_automations_tmp_file = nullptr;
static bool s_receiving_automations = false;

static void mqtt_delayed_restart_task(void *arg) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
    vTaskDelete(NULL);
}

// Non-blocking MQTT enqueue helper: never blocks can_rx_task or UART worker on TCP socket stalls
static inline void mqtt_enqueue_nonblocking(const char* topic, const char* data, int len, int qos, int retain) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    int actual_len = (len > 0) ? len : (int)strlen(data);
    esp_mqtt_client_enqueue(global_mqtt_client, topic, data, actual_len, qos, retain, true);
}

// Default monitored CAN IDs (Gen5W / E-GMP vehicle telemetry)
static std::unordered_set<uint32_t> s_monitored_ids = {
    0x038, 0x045, 0x070, 0x0A2, 0x130, 0x151, 0x152, 0x1AC, 0x1CF, 0x1F9,
    0x200, 0x226, 0x227, 0x29C, 0x2AD, 0x2AF, 0x2C0, 0x2FC,
    0x30E, 0x31B, 0x380, 0x384, 0x3AA, 0x3C1, 0x410, 0x411, 0x412, 0x414,
    0x418, 0x420, 0x435, 0x438, 0x442, 0x448, 0x453, 0x465, 0x474,
    0x475, 0x476, 0x478, 0x47F, 0x496, 0x49C, 0x4A2, 0x4C5, 0x4CE, 0x4ED,
    0x540, 0x541, 0x559, 0x578, 0x584, 0x594, 0x595, 0x597, 0x5CC,
    0x5D0, 0x5F5, 0x60C, 0x60E, 0x651, 0x652, 0x7EC
};
static std::mutex s_monitored_mutex;

void mqtt_mgr_publish_can_state(uint32_t can_id, const uint8_t* data, size_t len) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    char topic[64];
    snprintf(topic, sizeof(topic), "%s/%s/state/0x%03lX", MQTT_BASE_TOPIC.c_str(), DEVICE_ID.c_str(), (unsigned long)can_id);
    char hex_payload[17] = {0};
    for (size_t i = 0; i < len && i < 8; i++) {
        snprintf(&hex_payload[i * 2], 3, "%02X", data[i]);
    }
    // QoS 0 + non-blocking enqueue prevents outbox bloat and TCP stalls in can_rx_task
    mqtt_enqueue_nonblocking(topic, hex_payload, (int)(len > 8 ? 16 : len * 2), 0, 1);
}

void mqtt_mgr_publish_entity_state(const std::string& entity_id, const std::string& state) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    std::string topic = MQTT_BASE_TOPIC + "/state/" + entity_id;
    mqtt_enqueue_nonblocking(topic.c_str(), state.c_str(), (int)state.length(), 0, 1);
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

    std::string cmd_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/set/" + entity.id;
    std::string state_topic = MQTT_BASE_TOPIC + "/state/" + entity.id;
    cJSON_AddStringToObject(root, "command_topic", cmd_topic.c_str());
    cJSON_AddStringToObject(root, "state_topic", state_topic.c_str());

    if (entity.ha_domain == "switch") {
        cJSON_AddStringToObject(root, "payload_on", "ON");
        cJSON_AddStringToObject(root, "payload_off", "OFF");
        cJSON_AddStringToObject(root, "state_on", "ON");
        cJSON_AddStringToObject(root, "state_off", "OFF");
    }

    cJSON *device = cJSON_AddObjectToObject(root, "device");
    cJSON_AddStringToObject(device, "identifiers", DEVICE_ID.c_str());
    cJSON_AddStringToObject(device, "name", ("CAN Do (" + DEVICE_ID + ")").c_str());
    cJSON_AddStringToObject(device, "model", "Edge Engine");
    cJSON_AddStringToObject(device, "manufacturer", "CAN Do");

    char *payload = cJSON_PrintUnformatted(root);
    if (payload) {
        std::string topic = "homeassistant/" + entity.ha_domain + "/" + DEVICE_ID + "/" + entity.id + "/config";
        mqtt_enqueue_nonblocking(topic.c_str(), payload, (int)strlen(payload), 0, 1);
        free(payload);
    }
    cJSON_Delete(root);
}

static void clear_ha_discovery(esp_mqtt_client_handle_t client, const CanEntity& entity) {
    if (!client || entity.ha_domain.empty()) return;
    std::string topic = "homeassistant/" + entity.ha_domain + "/" + DEVICE_ID + "/" + entity.id + "/config";
    mqtt_enqueue_nonblocking(topic.c_str(), "", 0, 0, 1);
}

static void publish_ha_automation_discovery(esp_mqtt_client_handle_t client, const AutomationRule& rule) {
    if (!client || !rule.ha_expose || rule.id.empty()) return;

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "name", rule.name.c_str());

    std::string unique_id = DEVICE_ID + "_auto_" + rule.id;
    cJSON_AddStringToObject(root, "unique_id", unique_id.c_str());
    cJSON_AddStringToObject(root, "object_id", ("auto_" + rule.id).c_str());

    if (!rule.ha_icon.empty()) {
        cJSON_AddStringToObject(root, "icon", rule.ha_icon.c_str());
    }

    std::string cmd_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/set/" + rule.id;
    std::string state_topic = MQTT_BASE_TOPIC + "/state/" + rule.id;
    cJSON_AddStringToObject(root, "command_topic", cmd_topic.c_str());
    cJSON_AddStringToObject(root, "state_topic", state_topic.c_str());

    cJSON_AddStringToObject(root, "payload_on", "ON");
    cJSON_AddStringToObject(root, "payload_off", "OFF");
    cJSON_AddStringToObject(root, "state_on", "ON");
    cJSON_AddStringToObject(root, "state_off", "OFF");

    cJSON *device = cJSON_AddObjectToObject(root, "device");
    cJSON_AddStringToObject(device, "identifiers", DEVICE_ID.c_str());
    cJSON_AddStringToObject(device, "name", ("CAN Do (" + DEVICE_ID + ")").c_str());
    cJSON_AddStringToObject(device, "model", "Edge Engine");
    cJSON_AddStringToObject(device, "manufacturer", "CAN Do");

    char *payload = cJSON_PrintUnformatted(root);
    if (payload) {
        std::string topic = "homeassistant/switch/" + DEVICE_ID + "/" + rule.id + "/config";
        mqtt_enqueue_nonblocking(topic.c_str(), payload, (int)strlen(payload), 0, 1);
        free(payload);
    }
    mqtt_enqueue_nonblocking(state_topic.c_str(), rule.enabled ? "ON" : "OFF", rule.enabled ? 2 : 3, 0, 1);
    cJSON_Delete(root);
}

static void clear_ha_automation_discovery(esp_mqtt_client_handle_t client, const AutomationRule& rule) {
    if (!client || rule.id.empty()) return;
    std::string topic = "homeassistant/switch/" + DEVICE_ID + "/" + rule.id + "/config";
    mqtt_enqueue_nonblocking(topic.c_str(), "", 0, 0, 1);
}

static void publish_automations_json_state(void) {
    if (!global_mqtt_client || !s_mqtt_connected.load()) return;
    std::string state_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/state";
    FILE* state_f = fopen("/spiffs/automations.json", "r");
    if (state_f) {
        fseek(state_f, 0, SEEK_END);
        long slen = ftell(state_f);
        fseek(state_f, 0, SEEK_SET);
        if (slen <= 0 || slen > 32768) {
            mqtt_enqueue_nonblocking(state_topic.c_str(), "[]", 2, 0, 1);
        } else {
            char* sbuf = (char*)malloc(slen + 1);
            if (sbuf) {
                fread(sbuf, 1, slen, state_f);
                sbuf[slen] = '\0';
                mqtt_enqueue_nonblocking(state_topic.c_str(), sbuf, (int)slen, 0, 1);
                free(sbuf);
            }
        }
        fclose(state_f);
    } else {
        mqtt_enqueue_nonblocking(state_topic.c_str(), "[]", 2, 0, 1);
    }
}

static void mqtt_post_connect_sync_task(void* arg) {
    vTaskDelay(pdMS_TO_TICKS(500));

    // 1. Stream cached CAN frames with yields so outbox and IDLE0 never starve
    std::vector<uint32_t> mon_snapshot;
    {
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        mon_snapshot.assign(s_monitored_ids.begin(), s_monitored_ids.end());
    }
    int count = 0;
    for (uint32_t can_id : mon_snapshot) {
        if (!s_mqtt_connected.load()) break;
        uint8_t data[8] = {0};
        if (get_cached_can_frame(can_id, data)) {
            mqtt_mgr_publish_can_state(can_id, data, 8);
            if (++count % 8 == 0) {
                vTaskDelay(pdMS_TO_TICKS(10));
            }
        }
    }

    // 2. Publish automations state
    if (s_mqtt_connected.load()) {
        publish_automations_json_state();
        vTaskDelay(pdMS_TO_TICKS(500));
    }

    // 3. Publish or clear HA discovery
    if (s_mqtt_connected.load()) {
        bool disco_en = false;
        {
            std::lock_guard<std::mutex> lock(s_mqtt_mutex);
            disco_en = s_mqtt_cfg.ha_discovery_enabled;
        }
        if (disco_en) {
            mqtt_mgr_publish_discovery();
        } else {
            mqtt_mgr_clear_discovery();
        }
    }

    s_sync_task_running.store(false);
    vTaskDelete(NULL);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    auto event = static_cast<esp_mqtt_event_handle_t>(event_data);
    switch (event->event_id) {
        case MQTT_EVENT_CONNECTED: {
            s_mqtt_connected = true;
            ESP_LOGI(TAG, "MQTT connected to broker (%s)", s_mqtt_cfg.broker_url.c_str());

            // 1. Publish LWT online status
            std::string status_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/status";
            mqtt_enqueue_nonblocking(status_topic.c_str(), "online", 6, 1, 1);

            // 2. Subscribe ONLY to device-specific and direct fallback topics (NO + wildcard overlap!)
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/tx").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/tx").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/notify").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/notify").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/nav/set").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/nav/set").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/subscribe_ids").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/subscribe_ids").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/set").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/config/automations/set").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/get").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/config/automations/get").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/set/#").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/set/#").c_str(), 1);

            // 3. Defer state dump & HA discovery to single background worker task
            if (!s_sync_task_running.exchange(true)) {
                if (xTaskCreate(mqtt_post_connect_sync_task, "mqtt_sync", 4096, nullptr, 2, nullptr) != pdPASS) {
                    s_sync_task_running.store(false);
                }
            }
            break;
        }

        case MQTT_EVENT_DISCONNECTED:
            s_mqtt_connected = false;
            ESP_LOGW(TAG, "MQTT disconnected from broker");
            break;

        case MQTT_EVENT_DATA: {
            std::string config_set_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/set";
            std::string config_get_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/get";
            std::string status_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/status";

            if (event->current_data_offset == 0 && event->topic_len == config_set_topic.length() && 
                strncmp(event->topic, config_set_topic.c_str(), event->topic_len) == 0) {
                s_receiving_automations = true;
                s_automations_tmp_file = fopen("/spiffs/automations.json.tmp", "w");
                if (!s_automations_tmp_file) {
                    ESP_LOGE(TAG, "Failed to open automations.json.tmp for writing");
                    s_receiving_automations = false;
                }
            }

            if (s_receiving_automations) {
                if (s_automations_tmp_file && event->data_len > 0) {
                    fwrite(event->data, 1, event->data_len, s_automations_tmp_file);
                }

                bool is_final_chunk = (event->current_data_offset + event->data_len >= event->total_data_len);
                if (is_final_chunk) {
                    if (s_automations_tmp_file) {
                        fclose(s_automations_tmp_file);
                        s_automations_tmp_file = nullptr;
                    }
                    s_receiving_automations = false;

                    bool valid = true;
                    cJSON* root = nullptr;
                    FILE* f = fopen("/spiffs/automations.json.tmp", "r");
                    if (f) {
                        fseek(f, 0, SEEK_END);
                        long len = ftell(f);
                        fseek(f, 0, SEEK_SET);
                        if (len > 0 && len <= 32768) {
                            char* buf = (char*)malloc(len + 1);
                            if (buf) {
                                fread(buf, 1, len, f);
                                buf[len] = '\0';
                                root = cJSON_Parse(buf);
                                if (!root) valid = false;
                                else cJSON_Delete(root);
                                free(buf);
                            }
                        } else if (len > 32768) {
                            valid = false;
                        }
                        fclose(f);
                    }

                    if (valid) {
                        rename("/spiffs/automations.json.tmp", "/spiffs/automations.json");
                        mqtt_enqueue_nonblocking(status_topic.c_str(), "{\"status\":\"ok\"}", 15, 0, 0);
                        xTaskCreate(mqtt_delayed_restart_task, "mqtt_restart", 2048, nullptr, 5, nullptr);
                    } else {
                        unlink("/spiffs/automations.json.tmp");
                        mqtt_enqueue_nonblocking(status_topic.c_str(), "{\"status\":\"error\",\"message\":\"Invalid JSON syntax\"}", 50, 0, 0);
                    }
                }
                return;
            }

            if (event->topic_len == 0) return;
            std::string topic(event->topic, event->topic_len);
            std::string payload(event->data, event->data_len);

            if (topic == config_get_topic || topic == (MQTT_BASE_TOPIC + "/config/automations/get")) {
                publish_automations_json_state();
                return;
            }

            auto topic_ends_with = [](const std::string& str, const std::string& suffix) {
                return str.length() >= suffix.length() && 
                       str.compare(str.length() - suffix.length(), suffix.length(), suffix) == 0;
            };

            bool is_notify = (topic_ends_with(topic, "/notify") || topic == (MQTT_BASE_TOPIC + "/notify"));
            bool is_nav_set = (topic_ends_with(topic, "/nav/set") || topic == (MQTT_BASE_TOPIC + "/nav/set"));
            bool is_tx = (topic_ends_with(topic, "/tx") || topic == (MQTT_BASE_TOPIC + "/tx"));
            bool is_sub_ids = (topic_ends_with(topic, "/subscribe_ids") || topic == (MQTT_BASE_TOPIC + "/subscribe_ids"));
            bool is_set_cmd = (topic.find("/set/") != std::string::npos);

            if (is_notify) {
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
                } else if (level == "error" || level == "critical") {
                    track_popup_show_error(msg.c_str());
                } else {
                    track_popup_show_info(msg.c_str());
                }
            } else if (is_nav_set) {
                cJSON* root = cJSON_Parse(payload.c_str());
                if (root) {
                    cJSON* act = cJSON_GetObjectItem(root, "action");
                    if (act && cJSON_IsString(act) && strcmp(act->valuestring, "clear") == 0) {
                        hud_nav_clear();
                    } else {
                        hud_nav_instruction_t instr{};
                        cJSON* icon_item = cJSON_GetObjectItem(root, "icon");
                        if (icon_item && cJSON_IsNumber(icon_item)) instr.icon = (hud_maneuver_icon_t)icon_item->valueint;

                        cJSON* dist_item = cJSON_GetObjectItem(root, "distance");
                        if (dist_item && cJSON_IsNumber(dist_item)) instr.distance_meters = (uint16_t)dist_item->valueint;

                        cJSON* bars_item = cJSON_GetObjectItem(root, "bars");
                        if (bars_item && cJSON_IsNumber(bars_item)) instr.bar_graph = (uint8_t)bars_item->valueint;

                        cJSON* spd_item = cJSON_GetObjectItem(root, "speed_limit");
                        if (spd_item && cJSON_IsNumber(spd_item)) instr.speed_limit_kph = (uint8_t)spd_item->valueint;

                        cJSON* cam_item = cJSON_GetObjectItem(root, "camera_alert");
                        if (cam_item && cJSON_IsBool(cam_item)) instr.speed_camera_alert = cJSON_IsTrue(cam_item);

                        cJSON* street_item = cJSON_GetObjectItem(root, "street");
                        if (street_item && cJSON_IsString(street_item)) instr.street_name = street_item->valuestring;

                        hud_nav_update(&instr);
                    }
                    cJSON_Delete(root);
                }
            } else if (is_tx) {
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
            } else if (is_sub_ids) {
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
            } else if (is_set_cmd) {
                size_t set_pos = topic.find("/set/");
                std::string entity_id = topic.substr(set_pos + 5);
                queue_entity_command(entity_id, payload);
            }
            break;
        }
        case MQTT_EVENT_ERROR:
            s_mqtt_connected = false;
            break;
        default:
            break;
    }
}

static bool s_mqtt_initialized = false;

static void load_settings_from_fs(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);

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
        s_mqtt_initialized = true;
        return;
    }

    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (len <= 0) {
        fclose(f);
        s_mqtt_initialized = true;
        return;
    }

    std::string content(len, '\0');
    fread(&content[0], 1, len, f);
    fclose(f);

    cJSON* root = cJSON_Parse(content.c_str());
    if (!root) {
        s_mqtt_initialized = true;
        return;
    }

    cJSON* enabled_item = cJSON_GetObjectItem(root, "enabled");
    if (cJSON_IsBool(enabled_item)) s_mqtt_cfg.enabled = cJSON_IsTrue(enabled_item);

    cJSON* disco_item = cJSON_GetObjectItem(root, "ha_discovery");
    s_mqtt_cfg.ha_discovery_enabled = cJSON_IsBool(disco_item) ? cJSON_IsTrue(disco_item) : false;

    cJSON* url_item = cJSON_GetObjectItem(root, "broker_url");
    if (cJSON_IsString(url_item) && strlen(url_item->valuestring) > 0) s_mqtt_cfg.broker_url = url_item->valuestring;

    cJSON* user_item = cJSON_GetObjectItem(root, "username");
    if (cJSON_IsString(user_item)) s_mqtt_cfg.username = user_item->valuestring;

    cJSON* pass_item = cJSON_GetObjectItem(root, "password");
    if (cJSON_IsString(pass_item)) s_mqtt_cfg.password = pass_item->valuestring;

    cJSON_Delete(root);
    s_mqtt_initialized = true;
}

void mqtt_mgr_init(void) {
    load_settings_from_fs();
}

void mqtt_mgr_start(void) {
    if (!s_mqtt_initialized) {
        load_settings_from_fs();
    }
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);
    if (!s_mqtt_cfg.enabled || s_mqtt_cfg.broker_url.empty()) return;

    if (global_mqtt_client) {
        s_mqtt_connected = false;
        esp_err_t err = esp_mqtt_client_reconnect(global_mqtt_client);
        if (err != ESP_OK) {
            esp_mqtt_client_disconnect(global_mqtt_client);
        }
        return;
    }

    esp_mqtt_client_config_t mqtt_cfg = {};
    mqtt_cfg.broker.address.uri = s_mqtt_cfg.broker_url.c_str();
    mqtt_cfg.credentials.client_id = DEVICE_ID.c_str();
    if (!s_mqtt_cfg.username.empty()) {
        mqtt_cfg.credentials.username = s_mqtt_cfg.username.c_str();
    }
    if (!s_mqtt_cfg.password.empty()) {
        mqtt_cfg.credentials.authentication.password = s_mqtt_cfg.password.c_str();
    }

    s_lwt_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/status";
    mqtt_cfg.session.last_will.topic = s_lwt_topic.c_str();
    mqtt_cfg.session.last_will.msg = "offline";
    mqtt_cfg.session.last_will.msg_len = 7;
    mqtt_cfg.session.last_will.qos = 1;
    mqtt_cfg.session.last_will.retain = 1;

    // Hardened timeouts & bounded outbox so degraded Wi-Fi never exhausts ESP32-C3 heap
    mqtt_cfg.session.keepalive = 20;
    mqtt_cfg.network.reconnect_timeout_ms = 10000;
    mqtt_cfg.network.timeout_ms = 3000;
    mqtt_cfg.buffer.size = 2048;
    mqtt_cfg.outbox.limit = 16384;

    global_mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    if (global_mqtt_client) {
        if (esp_mqtt_client_register_event(global_mqtt_client, MQTT_EVENT_ANY, mqtt_event_handler, nullptr) != ESP_OK ||
            esp_mqtt_client_start(global_mqtt_client) != ESP_OK) {
            esp_mqtt_client_destroy(global_mqtt_client);
            global_mqtt_client = nullptr;
        }
    }
}

void mqtt_mgr_stop(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);
    if (global_mqtt_client) {
        s_mqtt_connected = false;
        esp_mqtt_client_stop(global_mqtt_client);
        esp_mqtt_client_destroy(global_mqtt_client);
        global_mqtt_client = nullptr;
    }
}

void mqtt_mgr_on_wifi_disconnect(void) {
    s_mqtt_connected = false;
    if (global_mqtt_client) {
        esp_mqtt_client_disconnect(global_mqtt_client);
    }
}

void mqtt_mgr_on_wifi_connect(void) {
    mqtt_mgr_start();
}

void mqtt_mgr_watchdog(void) {
    if (!s_mqtt_connected.load()) {
        if (!global_mqtt_client) {
            mqtt_mgr_start();
        } else {
            esp_err_t err = esp_mqtt_client_reconnect(global_mqtt_client);
            if (err != ESP_OK) {
                esp_mqtt_client_disconnect(global_mqtt_client);
            }
        }
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
        cJSON_AddBoolToObject(root, "ha_discovery", s_mqtt_cfg.ha_discovery_enabled);
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
            }
            free(rendered);
        }
    }

    mqtt_mgr_stop();
    if (cfg.enabled) {
        mqtt_mgr_start();
    }
    return true;
}

void mqtt_mgr_publish_discovery(void) {
    if (global_mqtt_client && s_mqtt_connected.load()) {
        stream_catalog_entities([](const CanEntity& entity) -> bool {
            if (!global_mqtt_client || !s_mqtt_connected.load()) return false;
            publish_ha_discovery(global_mqtt_client, entity);
            vTaskDelay(pdMS_TO_TICKS(25));
            return true;
        });

        for (const auto& rule : global_automations) {
            if (!global_mqtt_client || !s_mqtt_connected.load()) break;
            publish_ha_automation_discovery(global_mqtt_client, rule);
            vTaskDelay(pdMS_TO_TICKS(25));
        }
    }
}

void mqtt_mgr_clear_discovery(void) {
    if (global_mqtt_client && s_mqtt_connected.load()) {
        stream_catalog_entities([](const CanEntity& entity) -> bool {
            if (!global_mqtt_client || !s_mqtt_connected.load()) return false;
            clear_ha_discovery(global_mqtt_client, entity);
            vTaskDelay(pdMS_TO_TICKS(15));
            return true;
        });

        for (const auto& rule : global_automations) {
            if (!global_mqtt_client || !s_mqtt_connected.load()) break;
            clear_ha_automation_discovery(global_mqtt_client, rule);
            vTaskDelay(pdMS_TO_TICKS(15));
        }
    }
}

void mqtt_mgr_publish_vbat(float vbat) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;

    char val_str[16];
    int len = snprintf(val_str, sizeof(val_str), "%.1f", vbat);
    if (len <= 0) return;

    // Publish to vbat and cond_aux_12v_battery topics (do NOT overwrite raw 8-byte hex 0x1CF topic!)
    std::string vbat_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/vbat";
    mqtt_enqueue_nonblocking(vbat_topic.c_str(), val_str, len, 0, 1);

    std::string entity_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/cond_aux_12v_battery";
    mqtt_enqueue_nonblocking(entity_topic.c_str(), val_str, len, 0, 1);

    std::string ha_state_topic = MQTT_BASE_TOPIC + "/state/cond_aux_12v_battery";
    mqtt_enqueue_nonblocking(ha_state_topic.c_str(), val_str, len, 0, 1);
}

void mqtt_mgr_publish_bms(float kw, float soc, float v, float a, float delta_mv, int min_t, int max_t) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    (void)min_t;
    (void)max_t;

    char val_str[32];
    int len;

    len = snprintf(val_str, sizeof(val_str), "%.2f", kw);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_kw").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_hv_power_kw").c_str(), val_str, len, 0, 1);

    len = snprintf(val_str, sizeof(val_str), "%.1f", soc);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_soc").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_display_soc").c_str(), val_str, len, 0, 1);

    len = snprintf(val_str, sizeof(val_str), "%.1f", v);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_v").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_hv_voltage").c_str(), val_str, len, 0, 1);

    len = snprintf(val_str, sizeof(val_str), "%.1f", a);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_a").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_hv_current").c_str(), val_str, len, 0, 1);

    len = snprintf(val_str, sizeof(val_str), "%.0f", delta_mv);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_cell_delta_mv").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_cell_delta_mv").c_str(), val_str, len, 0, 1);
}

void mqtt_mgr_publish_ble_button(const std::string& address, const std::string& button, const std::string& action, const std::string& combo) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;

    cJSON* root = cJSON_CreateObject();
    if (!root) return;

    cJSON_AddStringToObject(root, "device_id", DEVICE_ID.c_str());
    cJSON_AddStringToObject(root, "address", address.c_str());
    cJSON_AddStringToObject(root, "button", button.c_str());
    cJSON_AddStringToObject(root, "action", action.c_str());
    if (!combo.empty()) {
        cJSON_AddStringToObject(root, "combo", combo.c_str());
    }

    char* payload = cJSON_PrintUnformatted(root);
    if (payload) {
        // Publish ONLY to device-scoped topic so Home Assistant wildcard doesn't fire twice
        std::string topic_dev = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/ble_button";
        mqtt_enqueue_nonblocking(topic_dev.c_str(), payload, (int)strlen(payload), 0, 0);
        free(payload);
    }
    cJSON_Delete(root);
}

void mqtt_mgr_publish_ble_device(const std::string& address, const std::string& event, int8_t rssi, const std::string& name) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;

    cJSON* root = cJSON_CreateObject();
    if (!root) return;

    cJSON_AddStringToObject(root, "device_id", DEVICE_ID.c_str());
    cJSON_AddStringToObject(root, "address", address.c_str());
    cJSON_AddStringToObject(root, "event", event.c_str());
    cJSON_AddNumberToObject(root, "rssi", rssi);
    cJSON_AddBoolToObject(root, "connected", (event == "connected"));
    if (!name.empty()) {
        cJSON_AddStringToObject(root, "name", name.c_str());
    }

    char* payload = cJSON_PrintUnformatted(root);
    if (payload) {
        std::string topic_dev = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/ble_device";
        mqtt_enqueue_nonblocking(topic_dev.c_str(), payload, (int)strlen(payload), 0, 0);
        free(payload);
    }
    cJSON_Delete(root);
}

void mqtt_mgr_publish_ble_beacon(const std::string& uuid, const std::string& event, int8_t rssi, uint16_t major, uint16_t minor, const std::string& mac, const std::string& name) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;

    cJSON* root = cJSON_CreateObject();
    if (!root) return;

    cJSON_AddStringToObject(root, "device_id", DEVICE_ID.c_str());
    cJSON_AddStringToObject(root, "uuid", uuid.c_str());
    cJSON_AddStringToObject(root, "event", event.c_str());
    cJSON_AddNumberToObject(root, "rssi", rssi);
    cJSON_AddNumberToObject(root, "major", major);
    cJSON_AddNumberToObject(root, "minor", minor);
    cJSON_AddBoolToObject(root, "present", (event != "exit"));
    if (!mac.empty()) {
        cJSON_AddStringToObject(root, "mac", mac.c_str());
    }
    if (!name.empty()) {
        cJSON_AddStringToObject(root, "name", name.c_str());
    }

    char* payload = cJSON_PrintUnformatted(root);
    if (payload) {
        std::string topic_dev = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/ble_beacon";
        mqtt_enqueue_nonblocking(topic_dev.c_str(), payload, (int)strlen(payload), 0, 0);
        free(payload);
    }
    cJSON_Delete(root);
}
