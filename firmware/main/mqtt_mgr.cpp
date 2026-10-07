#include "mqtt_mgr.h"
#include "parser.h"
#include "can_engine.h"
#include "track_popup.h"
#include "call_popup.h"
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
#include "remote_climate.h"
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
static std::string s_lwt_topic;

static FILE* s_automations_tmp_file = nullptr;
static bool s_receiving_automations = false;

static void mqtt_delayed_restart_task(void *arg) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
    vTaskDelete(NULL);
}

// Default monitored CAN IDs (Gen5W / E-GMP vehicle telemetry)
static std::unordered_set<uint32_t> s_monitored_ids = {
    0x038, 0x0A2, 0x130, 0x151, 0x152, 0x1AC, 0x1CF, 0x1F9,
    0x200, 0x226, 0x227, 0x29C, 0x2AD, 0x2AF, 0x2C0, 0x2FC,
    0x31B, 0x380, 0x384, 0x3AA, 0x3C1, 0x411, 0x412, 0x414,
    0x418, 0x420, 0x435, 0x438, 0x442, 0x448, 0x453, 0x474,
    0x475, 0x476, 0x478, 0x47F, 0x496, 0x49C, 0x4A2, 0x4C5, 0x4CE, 0x4ED,
    0x540, 0x541, 0x578, 0x584, 0x594, 0x595, 0x597, 0x5CC,
    0x5D0, 0x5F5, 0x60E, 0x651, 0x652, 0x7EC
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

    if (entity.ha_domain == "switch") {
        cJSON_AddStringToObject(root, "payload_on", "ON");
        cJSON_AddStringToObject(root, "payload_off", "OFF");
        cJSON_AddStringToObject(root, "state_on", "ON");
        cJSON_AddStringToObject(root, "state_off", "OFF");
    }

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

static void clear_ha_discovery(esp_mqtt_client_handle_t client, const CanEntity& entity) {
    if (!client || entity.ha_domain.empty()) return;
    std::string topic = "homeassistant/" + entity.ha_domain + "/" + DEVICE_ID + "/" + entity.id + "/config";
    esp_mqtt_client_publish(client, topic.c_str(), "", 0, 1, 1);
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

            // 2. Subscribe to control topics (specific, wildcard, and direct base topics)
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/tx").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/+/tx").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/tx").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/notify").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/+/notify").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/notify").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/nav/set").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/+/nav/set").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/nav/set").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/subscribe_ids").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/+/subscribe_ids").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/subscribe_ids").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/set").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/config/automations/set").c_str(), 1);
            
            std::string config_get_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/get";
            esp_mqtt_client_subscribe(global_mqtt_client, config_get_topic.c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/config/automations/get").c_str(), 1);

            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/set/#").c_str(), 1);
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/+/set/#").c_str(), 1);

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

            // 4. Publish or clear HA discovery in a throttled background task
            xTaskCreate([](void* arg) {
                vTaskDelay(pdMS_TO_TICKS(1500));
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
                vTaskDelete(NULL);
            }, "ha_disco", 3072, nullptr, 1, nullptr);

            // 5. Publish automations state
            {
                std::string state_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/state";
                FILE* state_f = fopen("/spiffs/automations.json", "r");
                if (state_f) {
                    fseek(state_f, 0, SEEK_END);
                    long slen = ftell(state_f);
                    fseek(state_f, 0, SEEK_SET);
                    if (slen == 0) {
                        esp_mqtt_client_publish(global_mqtt_client, state_topic.c_str(), "[]", 2, 1, 1);
                    } else {
                        char* sbuf = (char*)malloc(slen + 1);
                        if (sbuf) {
                            fread(sbuf, 1, slen, state_f);
                            sbuf[slen] = '\0';
                            esp_mqtt_client_publish(global_mqtt_client, state_topic.c_str(), sbuf, slen, 1, 1);
                            free(sbuf);
                        }
                    }
                    fclose(state_f);
                } else {
                    esp_mqtt_client_publish(global_mqtt_client, state_topic.c_str(), "[]", 2, 1, 1);
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
            std::string state_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/state";

            // Handle chunked incoming data for config/automations/set
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
                    
                    // Validate JSON
                    bool valid = true;
                    cJSON* root = nullptr;
                    FILE* f = fopen("/spiffs/automations.json.tmp", "r");
                    if (f) {
                        fseek(f, 0, SEEK_END);
                        long len = ftell(f);
                        fseek(f, 0, SEEK_SET);
                        if (len > 0) {
                            char* buf = (char*)malloc(len + 1);
                            if (buf) {
                                fread(buf, 1, len, f);
                                buf[len] = '\0';
                                root = cJSON_Parse(buf);
                                if (!root) valid = false;
                                else cJSON_Delete(root);
                                free(buf);
                            }
                        }
                        fclose(f);
                    }
                    
                    if (valid) {
                        rename("/spiffs/automations.json.tmp", "/spiffs/automations.json");
                        esp_mqtt_client_publish(global_mqtt_client, status_topic.c_str(), "{\"status\":\"ok\"}", 0, 1, 0);
                        
                        // Soft reset to apply
                        xTaskCreate(mqtt_delayed_restart_task, "mqtt_restart", 2048, nullptr, 5, nullptr);
                    } else {
                        unlink("/spiffs/automations.json.tmp");
                        esp_mqtt_client_publish(global_mqtt_client, status_topic.c_str(), "{\"status\":\"error\",\"message\":\"Invalid JSON syntax\"}", 0, 1, 0);
                    }
                }
                return; // Do not process this chunked payload in standard string matcher
            }

            // Normal topics (require topic to be present)
            if (event->topic_len == 0) return;
            std::string topic(event->topic, event->topic_len);
            std::string payload(event->data, event->data_len);

            if (topic == config_get_topic) {
                FILE* state_f = fopen("/spiffs/automations.json", "r");
                if (state_f) {
                    fseek(state_f, 0, SEEK_END);
                    long slen = ftell(state_f);
                    fseek(state_f, 0, SEEK_SET);
                    if (slen == 0) {
                        esp_mqtt_client_publish(global_mqtt_client, state_topic.c_str(), "[]", 2, 1, 1);
                    } else {
                        char* sbuf = (char*)malloc(slen + 1);
                        if (sbuf) {
                            fread(sbuf, 1, slen, state_f);
                            sbuf[slen] = '\0';
                            esp_mqtt_client_publish(global_mqtt_client, state_topic.c_str(), sbuf, slen, 1, 1);
                            free(sbuf);
                        } else {
                            ESP_LOGE(TAG, "OOM reading automations.json for mqtt publish");
                        }
                    }
                    fclose(state_f);
                } else {
                    esp_mqtt_client_publish(global_mqtt_client, state_topic.c_str(), "[]", 2, 1, 1);
                }
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
                ESP_LOGI(TAG, "Received cluster notify request: %s", payload.c_str());
                std::string msg = payload;
                std::string level = "info";
                std::string caller = "Home Assistant";
                bool is_call = false;
                uint32_t hold_ms = 5000;

                cJSON* root = cJSON_Parse(payload.c_str());
                if (root) {
                    cJSON* m = cJSON_GetObjectItem(root, "message");
                    if (!m) m = cJSON_GetObjectItem(root, "text");
                    if (!m) m = cJSON_GetObjectItem(root, "popup_message");
                    if (m && cJSON_IsString(m)) msg = m->valuestring;

                    cJSON* l = cJSON_GetObjectItem(root, "level");
                    if (l && cJSON_IsString(l)) level = l->valuestring;

                    cJSON* t = cJSON_GetObjectItem(root, "type");
                    if (t && cJSON_IsString(t) && (strcmp(t->valuestring, "call_alert") == 0 || strcmp(t->valuestring, "call") == 0 || strcmp(t->valuestring, "call_popup") == 0)) {
                        is_call = true;
                    }
                    cJSON* c = cJSON_GetObjectItem(root, "caller");
                    if (!c && is_call) c = cJSON_GetObjectItem(root, "title");
                    if (c && cJSON_IsString(c)) {
                        caller = c->valuestring;
                        is_call = true;
                    }
                    cJSON* h = cJSON_GetObjectItem(root, "hold_ms");
                    if (h && cJSON_IsNumber(h)) hold_ms = (uint32_t)h->valueint;

                    cJSON_Delete(root);
                }

                if (is_call) {
                    call_popup_severity_t sev = CALL_POPUP_SEV_INFO;
                    if (level == "warning") sev = CALL_POPUP_SEV_WARNING;
                    else if (level == "error" || level == "critical") sev = CALL_POPUP_SEV_CRITICAL;
                    call_popup_show(caller.c_str(), msg.c_str(), sev, hold_ms);
                } else {
                    if (level == "warning") {
                        track_popup_show_warning(msg.c_str());
                    } else if (level == "error") {
                        track_popup_show_error(msg.c_str());
                    } else {
                        track_popup_show_info(msg.c_str());
                    }
                }
            } else if (is_nav_set) {
                ESP_LOGI(TAG, "Received HUD nav update: %s", payload.c_str());
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
                        if (can_id == 0x520) {
                            if (steps[0].payload[0] == 0x01) {
                                float temp_c = steps[0].payload[1] > 0 ? (steps[0].payload[1] / 2.0f) : 22.0f;
                                remote_climate_start(temp_c, 10);
                            } else {
                                remote_climate_stop();
                            }
                        } else {
                            queue_action_steps(can_id, delay_ms, steps);
                        }
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
            if (event->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT) {
                ESP_LOGW(TAG, "MQTT client error: TCP Transport Error (TLS error code: %d, ESP-TLS error code: %d)",
                         event->error_handle->esp_tls_last_esp_err,
                         event->error_handle->esp_transport_sock_errno);
            } else if (event->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
                ESP_LOGW(TAG, "MQTT client error: Connection Refused");
            } else {
                ESP_LOGW(TAG, "MQTT client error event: type %d", event->error_handle->error_type);
            }
            break;
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

    cJSON* disco_item = cJSON_GetObjectItem(root, "ha_discovery");
    if (cJSON_IsBool(disco_item)) {
        s_mqtt_cfg.ha_discovery_enabled = cJSON_IsTrue(disco_item);
    } else {
        s_mqtt_cfg.ha_discovery_enabled = false;
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
        ESP_LOGI(TAG, "MQTT client already initialized; nudging reconnection");
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

    // Set LWT (Last Will and Testament)
    s_lwt_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/status";
    mqtt_cfg.session.last_will.topic = s_lwt_topic.c_str();
    mqtt_cfg.session.last_will.msg = "offline";
    mqtt_cfg.session.last_will.msg_len = 7;
    mqtt_cfg.session.last_will.qos = 1;
    mqtt_cfg.session.last_will.retain = 1;

    // Fast keepalive and short timeouts so network drop is detected quickly
    mqtt_cfg.session.keepalive = 30;
    mqtt_cfg.network.reconnect_timeout_ms = 10000;
    mqtt_cfg.network.timeout_ms = 12500;
    mqtt_cfg.buffer.size = 2048;

    global_mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    if (global_mqtt_client) {
        esp_err_t reg_err = esp_mqtt_client_register_event(global_mqtt_client, MQTT_EVENT_ANY, mqtt_event_handler, nullptr);
        if (reg_err != ESP_OK) {
            ESP_LOGE(TAG, "Failed registering MQTT event handler: %s", esp_err_to_name(reg_err));
            esp_mqtt_client_destroy(global_mqtt_client);
            global_mqtt_client = nullptr;
            return;
        }
        esp_err_t start_err = esp_mqtt_client_start(global_mqtt_client);
        if (start_err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to start MQTT client: %s", esp_err_to_name(start_err));
            esp_mqtt_client_destroy(global_mqtt_client);
            global_mqtt_client = nullptr;
            return;
        }
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

void mqtt_mgr_on_wifi_disconnect(void) {
    s_mqtt_connected = false;
    ESP_LOGI(TAG, "Wi-Fi disconnected: aborting socket/disconnecting MQTT client");
    if (global_mqtt_client) {
        esp_mqtt_client_disconnect(global_mqtt_client);
    }
}

void mqtt_mgr_on_wifi_connect(void) {
    ESP_LOGI(TAG, "Wi-Fi connected/IP acquired: ensuring MQTT connection");
    mqtt_mgr_start();
}

void mqtt_mgr_watchdog(void) {
    if (!s_mqtt_connected.load()) {
        if (!global_mqtt_client) {
            ESP_LOGI(TAG, "MQTT watchdog: starting uninitialized client");
            mqtt_mgr_start();
        } else {
            ESP_LOGD(TAG, "MQTT watchdog: client disconnected, nudging reconnect");
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
                ESP_LOGI(TAG, "Saved MQTT settings to %s", MQTT_CONFIG_FILE);
            } else {
                ESP_LOGE(TAG, "Failed to open %s for write", MQTT_CONFIG_FILE);
            }
            free(rendered);
        }
    }

    // Restart client with new configuration
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
    }
}

void mqtt_mgr_publish_vbat(float vbat) {
    if (!global_mqtt_client || !s_mqtt_connected.load()) return;

    char val_str[16];
    snprintf(val_str, sizeof(val_str), "%.1f", vbat);

    // 1. Publish to dedicated hardware vbat topic (e.g. cando/{device_id}/state/vbat)
    std::string vbat_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/vbat";
    esp_mqtt_client_publish(global_mqtt_client, vbat_topic.c_str(), val_str, 0, 1, 1);

    // 2. Also publish to entity id state topic (e.g. cando/{device_id}/state/cond_aux_12v_battery)
    std::string entity_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/cond_aux_12v_battery";
    esp_mqtt_client_publish(global_mqtt_client, entity_topic.c_str(), val_str, 0, 1, 1);

    // 3. Publish to CAN ID state topic (e.g. cando/{device_id}/state/0x1CF)
    std::string can_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/0x1CF";
    esp_mqtt_client_publish(global_mqtt_client, can_topic.c_str(), val_str, 0, 1, 1);

    // 4. Publish to global state topic for standard HA MQTT auto-discovery
    std::string ha_state_topic = MQTT_BASE_TOPIC + "/state/cond_aux_12v_battery";
    esp_mqtt_client_publish(global_mqtt_client, ha_state_topic.c_str(), val_str, 0, 1, 1);
}

void mqtt_mgr_publish_bms(float kw, float soc, float v, float a, float delta_mv, int min_t, int max_t) {
    if (!global_mqtt_client || !s_mqtt_connected.load()) return;

    char val_str[32];

    snprintf(val_str, sizeof(val_str), "%.2f", kw);
    std::string kw_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_kw";
    esp_mqtt_client_publish(global_mqtt_client, kw_topic.c_str(), val_str, 0, 1, 1);
    std::string kw_full = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_power_kw";
    esp_mqtt_client_publish(global_mqtt_client, kw_full.c_str(), val_str, 0, 1, 1);
    esp_mqtt_client_publish(global_mqtt_client, (MQTT_BASE_TOPIC + "/state/bms_hv_power_kw").c_str(), val_str, 0, 1, 1);

    snprintf(val_str, sizeof(val_str), "%.1f", soc);
    std::string soc_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_soc";
    esp_mqtt_client_publish(global_mqtt_client, soc_topic.c_str(), val_str, 0, 1, 1);
    std::string soc_full = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_display_soc";
    esp_mqtt_client_publish(global_mqtt_client, soc_full.c_str(), val_str, 0, 1, 1);
    esp_mqtt_client_publish(global_mqtt_client, (MQTT_BASE_TOPIC + "/state/bms_display_soc").c_str(), val_str, 0, 1, 1);

    snprintf(val_str, sizeof(val_str), "%.1f", v);
    std::string v_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_v";
    esp_mqtt_client_publish(global_mqtt_client, v_topic.c_str(), val_str, 0, 1, 1);
    std::string v_full = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_voltage";
    esp_mqtt_client_publish(global_mqtt_client, v_full.c_str(), val_str, 0, 1, 1);
    esp_mqtt_client_publish(global_mqtt_client, (MQTT_BASE_TOPIC + "/state/bms_hv_voltage").c_str(), val_str, 0, 1, 1);

    snprintf(val_str, sizeof(val_str), "%.1f", a);
    std::string a_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_a";
    esp_mqtt_client_publish(global_mqtt_client, a_topic.c_str(), val_str, 0, 1, 1);
    std::string a_full = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_current";
    esp_mqtt_client_publish(global_mqtt_client, a_full.c_str(), val_str, 0, 1, 1);
    esp_mqtt_client_publish(global_mqtt_client, (MQTT_BASE_TOPIC + "/state/bms_hv_current").c_str(), val_str, 0, 1, 1);

    snprintf(val_str, sizeof(val_str), "%.0f", delta_mv);
    std::string delta_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_cell_delta_mv";
    esp_mqtt_client_publish(global_mqtt_client, delta_topic.c_str(), val_str, 0, 1, 1);
    esp_mqtt_client_publish(global_mqtt_client, (MQTT_BASE_TOPIC + "/state/bms_cell_delta_mv").c_str(), val_str, 0, 1, 1);
}
