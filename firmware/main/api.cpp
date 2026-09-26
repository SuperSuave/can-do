#include "api.h"
#include "parser.h"
#include "can_engine.h"
#include "network_mgr.h"
#include "gvret_server.h"
#include "mqtt_mgr.h"
#include "track_popup.h"
#include "vbat_sensor.h"
#include "uds_engine.h"
#include "cJSON.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_app_desc.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "driver/twai.h"
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

static const char* TAG = "WEB_API";
extern std::string g_device_id;
#define DEVICE_ID g_device_id

httpd_handle_t global_web_server = nullptr;
static vprintf_like_t original_log_vprintf = nullptr;
static std::atomic<int> s_active_static_transfers{0};

bool is_serving_static_page(void) {
    return s_active_static_transfers.load() > 0;
}

struct ws_msg_t {
    int fd;
    std::string payload;
};

static void ws_async_send(void *arg) {
    ws_msg_t *msg = static_cast<ws_msg_t*>(arg);
    if (!msg) return;

    httpd_ws_frame_t ws_pkt;
    memset(&ws_pkt, 0, sizeof(httpd_ws_frame_t));
    ws_pkt.payload = reinterpret_cast<uint8_t*>(const_cast<char*>(msg->payload.c_str()));
    ws_pkt.len = msg->payload.length();
    ws_pkt.type = HTTPD_WS_TYPE_TEXT;

    httpd_ws_send_frame_async(global_web_server, msg->fd, &ws_pkt);
    delete msg;
}

bool has_active_websocket_clients(void) {
    if (!global_web_server) return false;
    size_t max_clients = 8;
    int client_fds[8];
    size_t clients = max_clients;
    if (httpd_get_client_list(global_web_server, &clients, client_fds) == ESP_OK) {
        for (size_t i = 0; i < clients; ++i) {
            if (httpd_ws_get_fd_info(global_web_server, client_fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET) {
                return true;
            }
        }
    }
    return false;
}

void broadcast_ws_raw(const std::string& json_str) {
    if (!global_web_server) return;
    size_t max_clients = 8;
    int client_fds[8];
    size_t clients = max_clients;

    if (httpd_get_client_list(global_web_server, &clients, client_fds) == ESP_OK) {
        for (size_t i = 0; i < clients; ++i) {
            if (httpd_ws_get_fd_info(global_web_server, client_fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET) {
                ws_msg_t *msg = new ws_msg_t{client_fds[i], json_str};
                if (httpd_queue_work(global_web_server, ws_async_send, msg) != ESP_OK) {
                    delete msg;
                }
            }
        }
    }
}

void broadcast_ws_state(const std::string& entity_id, const std::string& state) {
    if (!has_active_websocket_clients()) return;
    std::string json = "{\"type\":\"state\",\"entity\":\"" + entity_id + "\",\"state\":\"" + state + "\"}";
    broadcast_ws_raw(json);
}

void broadcast_ws_can_frame(const twai_message_t* msg) {
    if (!msg || !has_active_websocket_clients()) return;
    char hex_data[17] = {0};
    uint8_t dlc = msg->data_length_code > 8 ? 8 : msg->data_length_code;
    for (int i = 0; i < dlc; i++) {
        snprintf(&hex_data[i * 2], 3, "%02X", msg->data[i]);
    }
    char buf[128];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"can_frame\",\"id\":\"0x%03lX\",\"extd\":%s,\"dlc\":%d,\"data\":\"%s\"}",
             (unsigned long)msg->identifier,
             msg->extd ? "true" : "false",
             (int)dlc,
             hex_data);
    broadcast_ws_raw(buf);
}

void broadcast_ws_automation_event(const std::string& id, const std::string& name) {
    if (!has_active_websocket_clients()) return;
    char buf[256];
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    snprintf(buf, sizeof(buf),
             "{\"type\":\"automation_fired\",\"id\":\"%s\",\"name\":\"%s\",\"ts\":%lu}",
             id.c_str(), name.c_str(), (unsigned long)now_ms);
    broadcast_ws_raw(buf);
}

int custom_websocket_logger(const char *fmt, va_list args) {
    char log_buffer[256];
    va_list args_copy;
    va_copy(args_copy, args);
    int len = vsnprintf(log_buffer, sizeof(log_buffer), fmt, args_copy);
    va_end(args_copy);

    if (len > 0 && global_web_server) {
        std::string json = "{\"type\":\"log\",\"msg\":\"";
        for (int i = 0; i < len; i++) {
            if (log_buffer[i] == '\n' || log_buffer[i] == '\r') continue;
            else if (log_buffer[i] == '"') json += "\\\"";
            else if (log_buffer[i] == '\\') json += "\\\\";
            else json += log_buffer[i];
        }
        json += "\"}";
        broadcast_ws_raw(json);
    }

    if (original_log_vprintf) {
        return original_log_vprintf(fmt, args);
    }
    return len;
}

static void restart_task(void *arg) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
}

static esp_err_t set_content_type_from_file(httpd_req_t *req, const char *filepath) {
    if (strstr(filepath, ".html")) return httpd_resp_set_type(req, "text/html");
    if (strstr(filepath, ".json")) return httpd_resp_set_type(req, "application/json");
    if (strstr(filepath, ".js")) return httpd_resp_set_type(req, "application/javascript");
    if (strstr(filepath, ".css")) return httpd_resp_set_type(req, "text/css");
    if (strstr(filepath, ".svg")) return httpd_resp_set_type(req, "image/svg+xml");
    if (strstr(filepath, ".png")) return httpd_resp_set_type(req, "image/png");
    if (strstr(filepath, ".ico")) return httpd_resp_set_type(req, "image/x-icon");
    if (strstr(filepath, ".woff2")) return httpd_resp_set_type(req, "font/woff2");
    return httpd_resp_set_type(req, "text/plain");
}

static void set_cors_headers(httpd_req_t *req);

static esp_err_t static_file_handler(httpd_req_t *req) {
    static char filepath[600];

    // Determine candidate file path
    if (strcmp(req->uri, "/") == 0) {
        snprintf(filepath, sizeof(filepath), "/spiffs/www/index.html");
    } else if (strncmp(req->uri, "/catalog.json", 13) == 0 || strstr(req->uri, "can_do_catalog.json")) {
        // Look for catalog in root first (/spiffs/catalog.json), then under /spiffs/www/
        struct stat st_test;
        if (stat("/spiffs/catalog.json", &st_test) == 0 || stat("/spiffs/catalog.json.gz", &st_test) == 0) {
            snprintf(filepath, sizeof(filepath), "/spiffs/catalog.json");
        } else if (stat("/spiffs/can_do_catalog.json", &st_test) == 0) {
            snprintf(filepath, sizeof(filepath), "/spiffs/can_do_catalog.json");
        } else {
            snprintf(filepath, sizeof(filepath), "/spiffs/www%s", req->uri);
        }
    } else if (strncmp(req->uri, "/automations.json", 17) == 0) {
        snprintf(filepath, sizeof(filepath), "/spiffs/automations.json");
    } else {
        snprintf(filepath, sizeof(filepath), "/spiffs/www%s", req->uri);
    }

    // Strip any query parameters
    char *query = strchr(filepath, '?');
    if (query) *query = '\0';

    static char gz_filepath[610];
    snprintf(gz_filepath, sizeof(gz_filepath), "%s.gz", filepath);

    struct stat file_stat;
    bool is_gz = false;
    int fd = -1;

    // 1. Check if a pre-gzipped version exists (.gz)
    if (stat(gz_filepath, &file_stat) == 0) {
        fd = open(gz_filepath, O_RDONLY, 0);
        is_gz = true;
    } else if (stat(filepath, &file_stat) == 0) {
        fd = open(filepath, O_RDONLY, 0);
    } else {
        // 2. SPA Fallback: serve index.html or index.html.gz for client-side routing (never for /api/)
        const char *dot = strrchr(req->uri, '.');
        if (strncmp(req->uri, "/api/", 5) != 0 && (!dot || strcmp(dot, ".html") == 0)) {
            snprintf(gz_filepath, sizeof(gz_filepath), "/spiffs/www/index.html.gz");
            if (stat(gz_filepath, &file_stat) == 0) {
                fd = open(gz_filepath, O_RDONLY, 0);
                is_gz = true;
                strcpy(filepath, "/spiffs/www/index.html");
            } else if (stat("/spiffs/www/index.html", &file_stat) == 0) {
                fd = open("/spiffs/www/index.html", O_RDONLY, 0);
                strcpy(filepath, "/spiffs/www/index.html");
            }
        }
    }

    if (fd == -1) {
        set_cors_headers(req);
        httpd_resp_send_404(req);
        return ESP_FAIL;
    }

    // 3. Set headers (CORS, MIME type, Content-Encoding: gzip)
    set_cors_headers(req);
    set_content_type_from_file(req, filepath);
    if (is_gz) {
        httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    }

    // Cache control: immutable for hashed assets, no-cache for index.html
    if (strstr(filepath, ".js") || strstr(filepath, ".css") || strstr(filepath, ".woff2") || strstr(filepath, ".png") || strstr(filepath, ".svg")) {
        httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=31536000, immutable");
    } else {
        httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    }

    // 4. Stream file out in 2KB chunks without dynamic heap allocation
    // Mark transfer as active to prevent WebSocket streaming from overloading Wi-Fi/LwIP during page load
    s_active_static_transfers.fetch_add(1);

    static char s_file_chunk[2048];
    ssize_t read_bytes;
    while ((read_bytes = read(fd, s_file_chunk, sizeof(s_file_chunk))) > 0) {
        if (httpd_resp_send_chunk(req, s_file_chunk, read_bytes) != ESP_OK) {
            ESP_LOGW(TAG, "Chunk send failed for %s", filepath);
            close(fd);
            s_active_static_transfers.fetch_sub(1);
            return ESP_FAIL;
        }
    }

    close(fd);
    httpd_resp_send_chunk(req, nullptr, 0); // Terminate chunked response
    s_active_static_transfers.fetch_sub(1);
    return ESP_OK;
}

static void set_cors_headers(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "*");
    httpd_resp_set_hdr(req, "Access-Control-Max-Age", "86400");
}

static esp_err_t options_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_status(req, "204 No Content");
    httpd_resp_send(req, nullptr, 0);
    return ESP_OK;
}

static esp_err_t api_states_handler(httpd_req_t *req) {
    set_cors_headers(req);
    cJSON *root = cJSON_CreateArray();
    bool had_vbat = false;
    for (const auto& entity : global_catalog) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "entity", entity.id.c_str());
        cJSON_AddStringToObject(item, "state", entity.current_state.empty() ? "Unknown" : entity.current_state.c_str());
        cJSON_AddItemToArray(root, item);
        if (entity.id == "cond_aux_12v_battery") {
            had_vbat = true;
        }
    }

    // Always include live hardware ADC 12V battery reading
    if (!had_vbat) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "entity", "cond_aux_12v_battery");
        cJSON_AddStringToObject(item, "state", vbat_sensor_get_last_str());
        cJSON_AddItemToArray(root, item);
    }

    char *json_string = cJSON_PrintUnformatted(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json_string);

    free(json_string);
    cJSON_Delete(root);
    return ESP_OK;
}

static esp_err_t api_command_handler(httpd_req_t *req) {
    char buf[128];
    int ret = httpd_req_recv(req, buf, std::min(req->content_len, static_cast<size_t>(sizeof(buf) - 1)));
    if (ret <= 0) return ESP_FAIL;
    buf[ret] = '\0';

    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }

    cJSON *target_entity = cJSON_GetObjectItem(root, "entity");
    cJSON *target_cmd = cJSON_GetObjectItem(root, "command");

    if (cJSON_IsString(target_entity)) {
        const char* cmd_str = cJSON_IsString(target_cmd) ? target_cmd->valuestring : "";
        if (queue_entity_command(target_entity->valuestring, cmd_str)) {
            cJSON_Delete(root);
            httpd_resp_sendstr(req, "{\"status\": \"queued\"}");
            return ESP_OK;
        }
    }

    cJSON_Delete(root);
    httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Entity/Command not found");
    return ESP_FAIL;
}

static esp_err_t api_test_automation_handler(httpd_req_t *req) {
    char buf[128];
    int ret = httpd_req_recv(req, buf, std::min(req->content_len, static_cast<size_t>(sizeof(buf) - 1)));
    if (ret <= 0) return ESP_FAIL;
    buf[ret] = '\0';

    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }

    cJSON *id_item = cJSON_GetObjectItem(root, "id");
    cJSON *mode_item = cJSON_GetObjectItem(root, "mode");
    const char* req_id = cJSON_IsString(id_item) ? id_item->valuestring : "";
    const char* mode = cJSON_IsString(mode_item) ? mode_item->valuestring : "dry_run";

    for (const auto& rule : global_automations) {
        if (rule.id == req_id) {
            if (strcmp(mode, "dry_run") == 0) {
                bool passed = true;
                std::string debug_msg = "All conditions passed";
                for (const auto& cond : rule.conditions) {
                    if (!evaluate_condition(cond)) {
                        passed = false;
                        char tmp[64];
                        snprintf(tmp, sizeof(tmp), "Condition failed on CAN ID 0x%03lX", (unsigned long)cond.can_id);
                        debug_msg = tmp;
                        break;
                    }
                }
                cJSON_Delete(root);
                std::string resp = std::string("{\"status\":\"ok\",\"passed\":") + (passed ? "true" : "false") + ",\"message\":\"" + debug_msg + "\"}";
                httpd_resp_sendstr(req, resp.c_str());
                return ESP_OK;
            } else if (strcmp(mode, "live_fire") == 0) {
                queue_action_steps(0, 20, rule.actions);
                cJSON_Delete(root);
                httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"Live fire actions queued\"}");
                return ESP_OK;
            }
        }
    }

    cJSON_Delete(root);
    httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Automation rule not found");
    return ESP_FAIL;
}

static esp_err_t api_automations_diagnostics_handler(httpd_req_t *req) {
    set_cors_headers(req);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "automations_enabled", g_automations_enabled.load());
    cJSON *rules_arr = cJSON_CreateArray();
    cJSON_AddItemToObject(root, "rules", rules_arr);

    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    for (const auto& rule : global_automations) {
        cJSON *rule_obj = cJSON_CreateObject();
        cJSON_AddStringToObject(rule_obj, "id", rule.id.c_str());
        cJSON_AddStringToObject(rule_obj, "name", rule.name.c_str());
        cJSON_AddBoolToObject(rule_obj, "enabled", rule.enabled);
        cJSON_AddBoolToObject(rule_obj, "ha_expose", rule.ha_expose);
        cJSON_AddStringToObject(rule_obj, "ha_icon", rule.ha_icon.c_str());
        cJSON_AddStringToObject(rule_obj, "exec_mode", rule.exec_mode.c_str());
        cJSON_AddStringToObject(rule_obj, "trigger_mode", rule.trigger_mode.c_str());
        cJSON_AddNumberToObject(rule_obj, "cooldown_ms", rule.cooldown_ms);
        cJSON_AddNumberToObject(rule_obj, "last_exec_ms", rule.last_exec_time_ms);
        if (rule.last_exec_time_ms > 0 && now_ms >= rule.last_exec_time_ms) {
            cJSON_AddNumberToObject(rule_obj, "last_exec_sec_ago", (now_ms - rule.last_exec_time_ms) / 1000);
        } else {
            cJSON_AddNumberToObject(rule_obj, "last_exec_sec_ago", -1);
        }

        // Triggers
        cJSON *trigs_arr = cJSON_CreateArray();
        cJSON_AddItemToObject(rule_obj, "triggers", trigs_arr);
        for (const auto& trig : rule.triggers) {
            cJSON *t_obj = cJSON_CreateObject();
            cJSON_AddStringToObject(t_obj, "type", trig.type.c_str());
            if (trig.can_id != 0) {
                char hex_id[16];
                snprintf(hex_id, sizeof(hex_id), "0x%03lX", (unsigned long)trig.can_id);
                cJSON_AddStringToObject(t_obj, "can_id", hex_id);
            }
            cJSON_AddNumberToObject(t_obj, "bus", trig.bus);
            cJSON_AddNumberToObject(t_obj, "byte_index", trig.byte_index);
            if (trig.byte_index >= 0 && trig.byte_index < 8) {
                char bname[8];
                snprintf(bname, sizeof(bname), "D%d", trig.byte_index + 1);
                cJSON_AddStringToObject(t_obj, "byte_name", bname);
            }

            char hex_mask[8];
            snprintf(hex_mask, sizeof(hex_mask), "0x%02X", trig.byte_mask);
            cJSON_AddStringToObject(t_obj, "byte_mask", hex_mask);

            if (trig.has_from_value) {
                char hex_from[8];
                snprintf(hex_from, sizeof(hex_from), "0x%02X", trig.from_value);
                cJSON_AddStringToObject(t_obj, "from_val", hex_from);
            }
            char hex_to[8];
            snprintf(hex_to, sizeof(hex_to), "0x%02X", trig.to_value);
            cJSON_AddStringToObject(t_obj, "to_val", hex_to);

            if (trig.type == "time_schedule") {
                char sched_buf[16];
                snprintf(sched_buf, sizeof(sched_buf), "%02d:%02d", trig.schedule_time_min / 60, trig.schedule_time_min % 60);
                cJSON_AddStringToObject(t_obj, "schedule_time", sched_buf);
                cJSON_AddNumberToObject(t_obj, "weekdays_mask", trig.weekdays_mask);
            }

            // Live state from cache
            uint8_t cached_bytes[8] = {0};
            bool frame_seen = (trig.can_id != 0) && get_cached_can_frame(trig.can_id, cached_bytes);
            cJSON_AddBoolToObject(t_obj, "frame_seen", frame_seen);
            if (frame_seen) {
                char hex_payload[17] = {0};
                for (int i = 0; i < 8; i++) snprintf(&hex_payload[i * 2], 3, "%02X", cached_bytes[i]);
                cJSON_AddStringToObject(t_obj, "current_payload", hex_payload);

                if (trig.byte_index >= 0 && trig.byte_index < 8) {
                    uint8_t cur_val = cached_bytes[trig.byte_index];
                    char hex_byte[8];
                    snprintf(hex_byte, sizeof(hex_byte), "0x%02X", cur_val);
                    cJSON_AddStringToObject(t_obj, "current_byte", hex_byte);

                    uint8_t masked_cur = cur_val & trig.byte_mask;
                    uint8_t masked_target = trig.to_value & trig.byte_mask;
                    cJSON_AddBoolToObject(t_obj, "matches_target", masked_cur == masked_target);
                }
            }
            cJSON_AddItemToArray(trigs_arr, t_obj);
        }

        // Conditions
        cJSON *conds_arr = cJSON_CreateArray();
        cJSON_AddItemToObject(rule_obj, "conditions", conds_arr);
        bool all_conds_pass = true;

        for (const auto& cond : rule.conditions) {
            bool passed = evaluate_condition(cond);
            if (!passed) all_conds_pass = false;

            cJSON *c_obj = cJSON_CreateObject();
            cJSON_AddStringToObject(c_obj, "type", cond.type.c_str());
            cJSON_AddBoolToObject(c_obj, "passed", passed);

            if (cond.type == "time_condition") {
                char t_window[32];
                snprintf(t_window, sizeof(t_window), "%02d:%02d-%02d:%02d",
                         cond.start_time_min / 60, cond.start_time_min % 60,
                         cond.end_time_min / 60, cond.end_time_min % 60);
                cJSON_AddStringToObject(c_obj, "time_window", t_window);
                cJSON_AddNumberToObject(c_obj, "weekdays_mask", cond.weekdays_mask);
            } else {
                char hex_id[16];
                snprintf(hex_id, sizeof(hex_id), "0x%03lX", (unsigned long)cond.can_id);
                cJSON_AddStringToObject(c_obj, "can_id", hex_id);
                cJSON_AddNumberToObject(c_obj, "bus", cond.bus);
                cJSON_AddNumberToObject(c_obj, "byte_index", cond.byte_index);
                if (cond.byte_index < 8) {
                    char bname[8];
                    snprintf(bname, sizeof(bname), "D%d", cond.byte_index + 1);
                    cJSON_AddStringToObject(c_obj, "byte_name", bname);
                }

                char hex_mask[8];
                snprintf(hex_mask, sizeof(hex_mask), "0x%02X", cond.byte_mask);
                cJSON_AddStringToObject(c_obj, "byte_mask", hex_mask);

                const char* op_str = "==";
                if (cond.op == ConditionOperator::NOT_EQUAL) op_str = "!=";
                else if (cond.op == ConditionOperator::LESS_THAN) op_str = "<";
                else if (cond.op == ConditionOperator::GREATER_THAN) op_str = ">";
                cJSON_AddStringToObject(c_obj, "op", op_str);

                char hex_target[8];
                snprintf(hex_target, sizeof(hex_target), "0x%02X", cond.target_value);
                cJSON_AddStringToObject(c_obj, "target_val", hex_target);

                uint8_t cached_bytes[8] = {0};
                bool frame_seen = (cond.can_id != 0) && get_cached_can_frame(cond.can_id, cached_bytes);
                cJSON_AddBoolToObject(c_obj, "frame_seen", frame_seen);

                if (frame_seen && cond.byte_index < 8) {
                    uint8_t cur_val = cached_bytes[cond.byte_index];
                    char hex_byte[8];
                    snprintf(hex_byte, sizeof(hex_byte), "0x%02X", cur_val);
                    cJSON_AddStringToObject(c_obj, "current_byte", hex_byte);

                    char hex_masked[8];
                    snprintf(hex_masked, sizeof(hex_masked), "0x%02X", cur_val & cond.byte_mask);
                    cJSON_AddStringToObject(c_obj, "current_masked", hex_masked);
                }
            }
            cJSON_AddItemToArray(conds_arr, c_obj);
        }
        cJSON_AddBoolToObject(rule_obj, "all_conditions_passed", all_conds_pass);

        // Actions summary
        cJSON *acts_arr = cJSON_CreateArray();
        cJSON_AddItemToObject(rule_obj, "actions", acts_arr);
        for (const auto& act : rule.actions) {
            cJSON *a_obj = cJSON_CreateObject();
            if (act.type == ActionType::TRANSMIT_FRAME) {
                cJSON_AddStringToObject(a_obj, "type", "transmit");
                char hex_id[16];
                snprintf(hex_id, sizeof(hex_id), "0x%03lX", (unsigned long)act.can_id);
                cJSON_AddStringToObject(a_obj, "can_id", hex_id);
                cJSON_AddNumberToObject(a_obj, "repeat", act.repeat);
                cJSON_AddNumberToObject(a_obj, "delay_ms", act.delay_ms);
                char hex_payload[17] = {0};
                for (int i = 0; i < 8; i++) snprintf(&hex_payload[i * 2], 3, "%02X", act.payload[i]);
                cJSON_AddStringToObject(a_obj, "payload", hex_payload);
            } else if (act.type == ActionType::TRACK_POPUP) {
                cJSON_AddStringToObject(a_obj, "type", "track_popup");
                char hex_id[16];
                snprintf(hex_id, sizeof(hex_id), "0x%03lX", (unsigned long)act.can_id);
                cJSON_AddStringToObject(a_obj, "can_id", hex_id);
                cJSON_AddStringToObject(a_obj, "level", act.popup_level.c_str());
                cJSON_AddStringToObject(a_obj, "message", act.popup_message.c_str());
            } else if (act.type == ActionType::CLIMATE_TARGET) {
                cJSON_AddStringToObject(a_obj, "type", "climate_target");
                cJSON_AddNumberToObject(a_obj, "target_temp_c", act.target_temp_c);
                cJSON_AddStringToObject(a_obj, "zone", act.zone.c_str());
            } else if (act.type == ActionType::ENTITY_COMMAND) {
                cJSON_AddStringToObject(a_obj, "type", "entity_command");
                cJSON_AddStringToObject(a_obj, "entity", act.entity_id.c_str());
                cJSON_AddStringToObject(a_obj, "command", act.command.c_str());
            } else if (act.type == ActionType::DELAY) {
                cJSON_AddStringToObject(a_obj, "type", "delay");
                cJSON_AddNumberToObject(a_obj, "delay_ms", act.delay_ms);
            } else if (act.type == ActionType::PRECONDITION) {
                cJSON_AddStringToObject(a_obj, "type", "precondition");
                cJSON_AddStringToObject(a_obj, "mode", act.precon_mode.c_str());
                cJSON_AddStringToObject(a_obj, "action", act.precon_action.c_str());
            } else {
                cJSON_AddStringToObject(a_obj, "type", "other");
            }
            cJSON_AddItemToArray(acts_arr, a_obj);
        }

        cJSON_AddItemToArray(rules_arr, rule_obj);
    }

    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    httpd_resp_set_type(req, "application/json");
    if (json_str) {
        httpd_resp_sendstr(req, json_str);
        free(json_str);
    } else {
        httpd_resp_sendstr(req, "{\"automations_enabled\":true,\"rules\":[]}");
    }
    return ESP_OK;
}

static void ensure_parent_dirs(const char *filepath) {
    char temp[256];
    strncpy(temp, filepath, sizeof(temp) - 1);
    temp[sizeof(temp) - 1] = '\0';
    char *slash = strrchr(temp, '/');
    if (!slash) return;
    *slash = '\0';
    for (char *p = temp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(temp, 0755);
            *p = '/';
        }
    }
    mkdir(temp, 0755);
}

static esp_err_t api_file_upload_handler(httpd_req_t *req) {
    set_cors_headers(req);
    char filepath[128];
    if (httpd_req_get_hdr_value_str(req, "X-File-Path", filepath, sizeof(filepath)) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing X-File-Path header");
        return ESP_FAIL;
    }

    if (strncmp(filepath, "/spiffs/", 8) != 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid path: must start with /spiffs/");
        return ESP_FAIL;
    }

    ensure_parent_dirs(filepath);

    if (req->content_len == 0) {
        unlink(filepath);
        httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"File deleted/truncated.\"}");
        return ESP_OK;
    }

    FILE *fd = fopen(filepath, "w");
    if (!fd) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to open file for write");
        return ESP_FAIL;
    }

    char buf[1024];
    int remaining = req->content_len;
    while (remaining > 0) {
        int recv_len = httpd_req_recv(req, buf, std::min(remaining, static_cast<int>(sizeof(buf))));
        if (recv_len <= 0) {
            fclose(fd);
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "File receive failed");
            return ESP_FAIL;
        }
        fwrite(buf, 1, recv_len, fd);
        remaining -= recv_len;
    }
    fclose(fd);

    char no_reboot_hdr[16] = {0};
    bool skip_reboot = (httpd_req_get_hdr_value_str(req, "X-No-Reboot", no_reboot_hdr, sizeof(no_reboot_hdr)) == ESP_OK && strcmp(no_reboot_hdr, "1") == 0);

    if (strcmp(filepath, "/spiffs/catalog.json") == 0 && !skip_reboot) {
        httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"Catalog saved. Rebooting...\"}");
        xTaskCreate(restart_task, "restart_task", 2048, nullptr, 5, nullptr);
    } else {
        httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"File saved successfully.\"}");
    }
    return ESP_OK;
}

static esp_err_t api_ota_handler(httpd_req_t *req) {
    set_cors_headers(req);
    esp_ota_handle_t update_handle = 0;
    const esp_partition_t *update_partition = esp_ota_get_next_update_partition(nullptr);
    if (!update_partition) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "No OTA partition found");
        return ESP_FAIL;
    }

    esp_err_t err = esp_ota_begin(update_partition, OTA_WITH_SEQUENTIAL_WRITES, &update_handle);
    if (err != ESP_OK) return ESP_FAIL;

    char buf[1024];
    int remaining = req->content_len;
    while (remaining > 0) {
        int recv_len = httpd_req_recv(req, buf, std::min(remaining, static_cast<int>(sizeof(buf))));
        if (recv_len <= 0) {
            esp_ota_abort(update_handle);
            return ESP_FAIL;
        }
        esp_ota_write(update_handle, buf, recv_len);
        remaining -= recv_len;
    }

    if (esp_ota_end(update_handle) == ESP_OK && esp_ota_set_boot_partition(update_partition) == ESP_OK) {
        httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"Firmware flashed. Rebooting...\"}");
        xTaskCreate(restart_task, "restart_task", 2048, nullptr, 5, nullptr);
        return ESP_OK;
    }

    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "OTA flash failed");
    return ESP_FAIL;
}

struct CloudOtaTaskArgs {
    std::string url;
};

static void cloud_ota_task(void *pvParameter) {
    CloudOtaTaskArgs *args = static_cast<CloudOtaTaskArgs*>(pvParameter);
    std::string download_url = args->url;
    delete args;

    ESP_LOGI(TAG, "Starting Direct Cloud OTA Pull from: %s", download_url.c_str());
    broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] Connecting to Cloud Release Asset...\"}");

    esp_http_client_config_t config = {};
    config.url = download_url.c_str();
    config.cert_pem = nullptr; // Skip verification for github redirect assets
    config.skip_cert_common_name_check = true;
    config.crt_bundle_attach = esp_crt_bundle_attach;
    config.timeout_ms = 15000;
    config.buffer_size = 2048;
    config.buffer_size_tx = 1024;

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        ESP_LOGE(TAG, "Failed to initialize HTTP client for Cloud OTA");
        broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] [E] Failed to initialize HTTP client\"}");
        vTaskDelete(nullptr);
        return;
    }

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open HTTP connection: %s", esp_err_to_name(err));
        broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] [E] Connection to download URL failed\"}");
        esp_http_client_cleanup(client);
        vTaskDelete(nullptr);
        return;
    }

    int content_length = esp_http_client_fetch_headers(client);
    int status_code = esp_http_client_get_status_code(client);
    ESP_LOGI(TAG, "Cloud OTA HTTP Status: %d, Content-Length: %d", status_code, content_length);

    // Follow redirect if GitHub redirects to S3/objects
    if (status_code == 301 || status_code == 302 || status_code == 307) {
        esp_http_client_set_redirection(client);
        esp_http_client_close(client);
        err = esp_http_client_open(client, 0);
        if (err == ESP_OK) {
            content_length = esp_http_client_fetch_headers(client);
            status_code = esp_http_client_get_status_code(client);
            ESP_LOGI(TAG, "Followed Redirect -> Status: %d, Content-Length: %d", status_code, content_length);
        }
    }

    if (status_code != 200) {
        ESP_LOGE(TAG, "Unexpected HTTP status: %d", status_code);
        char err_msg[64];
        snprintf(err_msg, sizeof(err_msg), "{\"type\":\"log\",\"msg\":\"[OTA] [E] HTTP Error %d from cloud\"}", status_code);
        broadcast_ws_raw(err_msg);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        vTaskDelete(nullptr);
        return;
    }

    const esp_partition_t *update_partition = esp_ota_get_next_update_partition(nullptr);
    if (!update_partition) {
        ESP_LOGE(TAG, "No OTA partition found");
        broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] [E] No active OTA partition available\"}");
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        vTaskDelete(nullptr);
        return;
    }

    esp_ota_handle_t update_handle = 0;
    err = esp_ota_begin(update_partition, OTA_WITH_SEQUENTIAL_WRITES, &update_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin failed (%s)", esp_err_to_name(err));
        broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] [E] OTA begin failed\"}");
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        vTaskDelete(nullptr);
        return;
    }

    broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] Streaming binary directly into flash partition...\"}");

    char *upgrade_data_buf = (char *)malloc(2048);
    if (!upgrade_data_buf) {
        esp_ota_abort(update_handle);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        vTaskDelete(nullptr);
        return;
    }

    int binary_file_length = 0;
    int data_read = 0;
    int last_reported_pct = -1;

    while (true) {
        data_read = esp_http_client_read(client, upgrade_data_buf, 2048);
        if (data_read < 0) {
            ESP_LOGE(TAG, "Error: SSL/HTTP data read error");
            break;
        } else if (data_read > 0) {
            err = esp_ota_write(update_handle, (const void *)upgrade_data_buf, data_read);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "esp_ota_write failed (%s)", esp_err_to_name(err));
                break;
            }
            binary_file_length += data_read;
            if (content_length > 0) {
                int pct = (binary_file_length * 100) / content_length;
                if (pct != last_reported_pct && pct % 10 == 0) {
                    last_reported_pct = pct;
                    char p_buf[96];
                    snprintf(p_buf, sizeof(p_buf), "{\"type\":\"ota_progress\",\"pct\":%d,\"bytes\":%d}", pct, binary_file_length);
                    broadcast_ws_raw(p_buf);
                }
            }
        } else if (data_read == 0) {
            // End of stream
            break;
        }
    }

    free(upgrade_data_buf);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (err == ESP_OK && binary_file_length > 100000) {
        err = esp_ota_end(update_handle);
        if (err == ESP_OK) {
            err = esp_ota_set_boot_partition(update_partition);
            if (err == ESP_OK) {
                ESP_LOGI(TAG, "Direct Cloud OTA Succeeded! Total bytes: %d. Rebooting...", binary_file_length);
                broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] Cloud flash 100% complete! Rebooting device in 3s...\"}");
                vTaskDelay(pdMS_TO_TICKS(1500));
                esp_restart();
                vTaskDelete(nullptr);
                return;
            }
        }
    }

    esp_ota_abort(update_handle);
    ESP_LOGE(TAG, "Direct Cloud OTA Failed or incomplete");
    broadcast_ws_raw("{\"type\":\"log\",\"msg\":\"[OTA] [E] Cloud OTA update failed to complete\"}");
    vTaskDelete(nullptr);
}

static esp_err_t api_ota_cloud_pull_handler(httpd_req_t *req) {
    set_cors_headers(req);
    char buf[512];
    int ret = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (ret <= 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Empty request body");
        return ESP_FAIL;
    }
    buf[ret] = '\0';

    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }

    cJSON *url_item = cJSON_GetObjectItem(root, "url");
    if (!url_item || !cJSON_IsString(url_item)) {
        cJSON_Delete(root);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing 'url' field");
        return ESP_FAIL;
    }

    std::string ota_url = url_item->valuestring;
    cJSON_Delete(root);

    CloudOtaTaskArgs *args = new CloudOtaTaskArgs{ota_url};
    if (xTaskCreate(cloud_ota_task, "cloud_ota_task", 8192, args, 5, nullptr) != pdPASS) {
        delete args;
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to spawn cloud OTA task");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"started\",\"message\":\"Cloud OTA download initiated on device\"}");
    return ESP_OK;
}

static esp_err_t api_get_automations_handler(httpd_req_t *req) {
    set_cors_headers(req);
    const char *filepath = "/spiffs/automations.json";
    FILE *fd = fopen(filepath, "r");
    if (!fd) {
        httpd_resp_set_type(req, "application/json");
        const esp_app_desc_t *app_desc = esp_app_get_description();
        const char* fw_ver = (app_desc && app_desc->version[0] != '\0') ? app_desc->version : "unknown";
        char def_resp[256];
        snprintf(def_resp, sizeof(def_resp), "{\"settings\":{\"vehicle_model\":\"all_egmp\",\"unit_system\":\"imperial\",\"can_do_version\":\"%s\"},\"rules\":[]}", fw_ver);
        httpd_resp_sendstr(req, def_resp);
        return ESP_OK;
    }

    httpd_resp_set_type(req, "application/json");

    char chunk[1024];
    size_t chunksize;
    do {
        chunksize = fread(chunk, 1, sizeof(chunk), fd);
        if (chunksize > 0) {
            if (httpd_resp_send_chunk(req, chunk, chunksize) != ESP_OK) {
                fclose(fd);
                return ESP_FAIL;
            }
        }
    } while (chunksize != 0);

    fclose(fd);
    httpd_resp_send_chunk(req, nullptr, 0);
    return ESP_OK;
}

static esp_err_t api_post_automations_handler(httpd_req_t *req) {
    set_cors_headers(req);
    if (req->content_len <= 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Empty payload");
        return ESP_FAIL;
    }

    const char *temp_filepath = "/spiffs/automations.json.tmp";
    const char *target_filepath = "/spiffs/automations.json";

    FILE *fd = fopen(temp_filepath, "w");
    if (!fd) {
        fd = fopen(target_filepath, "w");
        if (!fd) {
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to open automations file for write");
            return ESP_FAIL;
        }
        temp_filepath = target_filepath;
    }

    char buf[1024];
    int remaining = req->content_len;
    while (remaining > 0) {
        int recv_len = httpd_req_recv(req, buf, std::min(remaining, static_cast<int>(sizeof(buf))));
        if (recv_len <= 0) {
            fclose(fd);
            if (temp_filepath != target_filepath) remove(temp_filepath);
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed receiving automation payload");
            return ESP_FAIL;
        }
        fwrite(buf, 1, recv_len, fd);
        remaining -= recv_len;
    }
    fclose(fd);

    if (temp_filepath != target_filepath) {
        remove(target_filepath);
        if (rename(temp_filepath, target_filepath) != 0) {
            ESP_LOGE(TAG, "Failed to rename temp automations file");
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed committing automations file");
            return ESP_FAIL;
        }
    }

    ESP_LOGI(TAG, "New automations.json written (%d bytes). Triggering soft-reset...", req->content_len);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"Automations saved successfully. Soft-resetting engine...\"}");

    xTaskCreate(restart_task, "restart_task", 2048, nullptr, 5, nullptr);
    return ESP_OK;
}

static esp_err_t api_get_preferences_handler(httpd_req_t *req) {
    set_cors_headers(req);
    const char *filepath = "/spiffs/preferences.json";
    FILE *fd = fopen(filepath, "r");
    if (!fd) {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{}");
        return ESP_OK;
    }

    httpd_resp_set_type(req, "application/json");
    char chunk[1024];
    size_t chunksize;
    do {
        chunksize = fread(chunk, 1, sizeof(chunk), fd);
        if (chunksize > 0) {
            if (httpd_resp_send_chunk(req, chunk, chunksize) != ESP_OK) {
                fclose(fd);
                return ESP_FAIL;
            }
        }
    } while (chunksize != 0);

    fclose(fd);
    httpd_resp_send_chunk(req, nullptr, 0);
    return ESP_OK;
}

static esp_err_t api_post_preferences_handler(httpd_req_t *req) {
    set_cors_headers(req);
    if (req->content_len <= 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Empty payload");
        return ESP_FAIL;
    }

    const char *temp_filepath = "/spiffs/preferences.json.tmp";
    const char *target_filepath = "/spiffs/preferences.json";

    FILE *fd = fopen(temp_filepath, "w");
    if (!fd) {
        fd = fopen(target_filepath, "w");
        if (!fd) {
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to open preferences file for write");
            return ESP_FAIL;
        }
        temp_filepath = target_filepath;
    }

    char buf[1024];
    int remaining = req->content_len;
    while (remaining > 0) {
        int recv_len = httpd_req_recv(req, buf, std::min(remaining, static_cast<int>(sizeof(buf))));
        if (recv_len <= 0) {
            fclose(fd);
            if (temp_filepath != target_filepath) remove(temp_filepath);
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed receiving preferences payload");
            return ESP_FAIL;
        }
        fwrite(buf, 1, recv_len, fd);
        remaining -= recv_len;
    }
    fclose(fd);

    if (temp_filepath != target_filepath) {
        remove(target_filepath);
        if (rename(temp_filepath, target_filepath) != 0) {
            ESP_LOGE(TAG, "Failed to rename temp preferences file");
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed committing preferences file");
            return ESP_FAIL;
        }
    }

    ESP_LOGI(TAG, "User preferences saved to device (%d bytes)", req->content_len);
    uds_engine_load_preferences();
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"Preferences saved to device.\"}");
    return ESP_OK;
}

static esp_err_t api_system_status_handler(httpd_req_t *req) {
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "device_id", DEVICE_ID.c_str());
    cJSON_AddBoolToObject(root, "automations_enabled", g_automations_enabled.load());
    cJSON_AddBoolToObject(root, "sniffer_mode", g_sniffer_mode.load());
    cJSON_AddBoolToObject(root, "hardware_listen_only", g_hardware_listen_only.load());
    const esp_app_desc_t *app_desc = esp_app_get_description();
    const char* fw_ver = (app_desc && app_desc->version[0] != '\0') ? app_desc->version : "unknown";
    cJSON_AddStringToObject(root, "can_do_version", fw_ver);

    twai_status_info_t twai_st;
    if (twai_get_status_info(&twai_st) == ESP_OK) {
        const char* state_str = "unknown";
        switch (twai_st.state) {
            case TWAI_STATE_STOPPED: state_str = "stopped"; break;
            case TWAI_STATE_RUNNING: state_str = "running"; break;
            case TWAI_STATE_BUS_OFF: state_str = "bus_off"; break;
            case TWAI_STATE_RECOVERING: state_str = "recovering"; break;
        }
        cJSON_AddStringToObject(root, "twai_state", state_str);
        cJSON_AddNumberToObject(root, "tx_error_counter", twai_st.tx_error_counter);
        cJSON_AddNumberToObject(root, "rx_error_counter", twai_st.rx_error_counter);
        cJSON_AddNumberToObject(root, "rx_missed_count", twai_st.rx_missed_count);
        cJSON_AddNumberToObject(root, "rx_overrun_count", twai_st.rx_overrun_count);
        cJSON_AddNumberToObject(root, "bus_error_count", twai_st.bus_error_count);
    }

    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json_str);
    free(json_str);
    return ESP_OK;
}

static esp_err_t api_system_control_handler(httpd_req_t *req) {
    char buf[128];
    int ret = httpd_req_recv(req, buf, std::min(req->content_len, static_cast<size_t>(sizeof(buf) - 1)));
    if (ret <= 0) return ESP_FAIL;
    buf[ret] = '\0';

    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }

    cJSON *action_item = cJSON_GetObjectItem(root, "action");
    if (cJSON_IsString(action_item)) {
        const char *act = action_item->valuestring;
        if (strcmp(act, "toggle_automations") == 0) {
            set_automations_enabled(!g_automations_enabled.load());
        } else if (strcmp(act, "toggle_sniffer") == 0) {
            set_sniffer_mode(!g_sniffer_mode.load(), g_hardware_listen_only.load());
        } else if (strcmp(act, "set_hardware_listen_only") == 0) {
            cJSON *en = cJSON_GetObjectItem(root, "enabled");
            bool val = cJSON_IsBool(en) ? cJSON_IsTrue(en) : !g_hardware_listen_only.load();
            set_sniffer_mode(g_sniffer_mode.load(), val);
        }
    }

    cJSON *auto_item = cJSON_GetObjectItem(root, "automations_enabled");
    if (cJSON_IsBool(auto_item)) {
        set_automations_enabled(cJSON_IsTrue(auto_item));
    }

    cJSON *sniff_item = cJSON_GetObjectItem(root, "sniffer_mode");
    cJSON *hw_item = cJSON_GetObjectItem(root, "hardware_listen_only");
    if (cJSON_IsBool(sniff_item)) {
        bool hw_listen = cJSON_IsBool(hw_item) ? cJSON_IsTrue(hw_item) : g_hardware_listen_only.load();
        set_sniffer_mode(cJSON_IsTrue(sniff_item), hw_listen);
    } else if (cJSON_IsBool(hw_item)) {
        set_sniffer_mode(g_sniffer_mode.load(), cJSON_IsTrue(hw_item));
    }

    cJSON *reboot_item = cJSON_GetObjectItem(root, "reboot");
    if (cJSON_IsTrue(reboot_item)) {
        cJSON_Delete(root);
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"Rebooting...\"}");
        xTaskCreate(restart_task, "restart_task", 2048, nullptr, 5, nullptr);
        return ESP_OK;
    }

    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
    return ESP_OK;
}

static esp_err_t api_wifi_status_handler(httpd_req_t *req) {
    NetworkStatusInfo st = network_mgr_get_status();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "sta_connected", st.sta_connected);
    cJSON_AddStringToObject(root, "sta_ssid", st.sta_ssid.c_str());
    cJSON_AddStringToObject(root, "sta_ip", st.sta_ip.c_str());
    cJSON_AddStringToObject(root, "sta_gw", st.sta_gw.c_str());
    cJSON_AddStringToObject(root, "sta_mask", st.sta_mask.c_str());
    cJSON_AddNumberToObject(root, "sta_rssi", st.sta_rssi);

    cJSON_AddBoolToObject(root, "ap_active", st.ap_active);
    cJSON_AddStringToObject(root, "ap_ssid", st.ap_ssid.c_str());
    cJSON_AddStringToObject(root, "ap_ip", st.ap_ip.c_str());
    cJSON_AddNumberToObject(root, "ap_clients", st.ap_clients);

    const char* ap_mode_str = "auto";
    if (st.ap_mode == AP_MODE_ALWAYS_ON) ap_mode_str = "always_on";
    else if (st.ap_mode == AP_MODE_DISABLED) ap_mode_str = "disabled";
    cJSON_AddStringToObject(root, "ap_mode", ap_mode_str);

    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json_str);
    free(json_str);
    return ESP_OK;
}

static esp_err_t api_wifi_get_networks_handler(httpd_req_t *req) {
    auto list = network_mgr_get_known_networks();
    cJSON *root = cJSON_CreateArray();
    for (const auto& net : list) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "ssid", net.ssid.c_str());
        cJSON_AddNumberToObject(item, "priority", net.priority);
        cJSON_AddItemToArray(root, item);
    }
    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json_str);
    free(json_str);
    return ESP_OK;
}

static esp_err_t api_wifi_post_networks_handler(httpd_req_t *req) {
    char buf[256];
    int ret = httpd_req_recv(req, buf, std::min(req->content_len, static_cast<size_t>(sizeof(buf) - 1)));
    if (ret <= 0) return ESP_FAIL;
    buf[ret] = '\0';

    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }

    cJSON *ssid = cJSON_GetObjectItem(root, "ssid");
    cJSON *pass = cJSON_GetObjectItem(root, "password");
    cJSON *prio = cJSON_GetObjectItem(root, "priority");

    if (cJSON_IsString(ssid) && strlen(ssid->valuestring) > 0) {
        std::string password = cJSON_IsString(pass) ? pass->valuestring : "";
        int priority = cJSON_IsNumber(prio) ? prio->valueint : 50;
        network_mgr_add_known_network(ssid->valuestring, password, priority);
        cJSON_Delete(root);
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"Network saved\"}");
        return ESP_OK;
    }

    cJSON_Delete(root);
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing SSID");
    return ESP_FAIL;
}

static esp_err_t api_wifi_delete_networks_handler(httpd_req_t *req) {
    char buf[128];
    int ret = httpd_req_recv(req, buf, std::min(req->content_len, static_cast<size_t>(sizeof(buf) - 1)));
    if (ret <= 0) return ESP_FAIL;
    buf[ret] = '\0';

    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }

    cJSON *ssid = cJSON_GetObjectItem(root, "ssid");
    if (cJSON_IsString(ssid)) {
        bool removed = network_mgr_remove_known_network(ssid->valuestring);
        cJSON_Delete(root);
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, removed ? "{\"status\":\"ok\"}" : "{\"status\":\"not_found\"}");
        return ESP_OK;
    }

    cJSON_Delete(root);
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing SSID");
    return ESP_FAIL;
}

static esp_err_t api_wifi_scan_handler(httpd_req_t *req) {
    if (!network_mgr_is_scanning()) {
        network_mgr_start_scan();
    }

    auto results = network_mgr_get_scan_results();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "scanning", network_mgr_is_scanning());

    cJSON *arr = cJSON_AddArrayToObject(root, "results");
    for (const auto& res : results) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "ssid", res.ssid.c_str());
        cJSON_AddNumberToObject(item, "rssi", res.rssi);
        cJSON_AddNumberToObject(item, "authmode", res.authmode);
        cJSON_AddBoolToObject(item, "in_known_list", res.in_known_list);
        cJSON_AddItemToArray(arr, item);
    }

    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json_str);
    free(json_str);
    return ESP_OK;
}

static esp_err_t api_wifi_settings_handler(httpd_req_t *req) {
    char buf[256];
    int ret = httpd_req_recv(req, buf, std::min(req->content_len, static_cast<size_t>(sizeof(buf) - 1)));
    if (ret <= 0) return ESP_FAIL;
    buf[ret] = '\0';

    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }

    cJSON *ap_mode_item = cJSON_GetObjectItem(root, "ap_mode");
    if (cJSON_IsString(ap_mode_item)) {
        if (strcmp(ap_mode_item->valuestring, "always_on") == 0) network_mgr_set_ap_mode(AP_MODE_ALWAYS_ON);
        else if (strcmp(ap_mode_item->valuestring, "disabled") == 0) network_mgr_set_ap_mode(AP_MODE_DISABLED);
        else network_mgr_set_ap_mode(AP_MODE_AUTO);
    }

    cJSON *ap_ssid_item = cJSON_GetObjectItem(root, "ap_ssid");
    cJSON *ap_pass_item = cJSON_GetObjectItem(root, "ap_password");
    if (cJSON_IsString(ap_ssid_item)) {
        std::string pass = cJSON_IsString(ap_pass_item) ? ap_pass_item->valuestring : "";
        network_mgr_set_ap_credentials(ap_ssid_item->valuestring, pass);
    }

    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
    return ESP_OK;
}

static esp_err_t api_mqtt_get_handler(httpd_req_t *req) {
    MqttConfig cfg = mqtt_mgr_get_config();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "enabled", cfg.enabled);
    cJSON_AddStringToObject(root, "broker_url", cfg.broker_url.c_str());
    cJSON_AddStringToObject(root, "username", cfg.username.c_str());
    cJSON_AddBoolToObject(root, "has_password", !cfg.password.empty());
    cJSON_AddBoolToObject(root, "connected", mqtt_mgr_is_connected());

    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json_str);
    free(json_str);
    return ESP_OK;
}

static esp_err_t api_mqtt_post_handler(httpd_req_t *req) {
    char buf[512];
    int ret = httpd_req_recv(req, buf, std::min(req->content_len, static_cast<size_t>(sizeof(buf) - 1)));
    if (ret <= 0) return ESP_FAIL;
    buf[ret] = '\0';

    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }

    MqttConfig cfg = mqtt_mgr_get_config();

    cJSON *en_item = cJSON_GetObjectItem(root, "enabled");
    if (cJSON_IsBool(en_item)) {
        cfg.enabled = cJSON_IsTrue(en_item);
    }

    cJSON *url_item = cJSON_GetObjectItem(root, "broker_url");
    if (cJSON_IsString(url_item) && strlen(url_item->valuestring) > 0) {
        cfg.broker_url = url_item->valuestring;
    }

    cJSON *user_item = cJSON_GetObjectItem(root, "username");
    if (cJSON_IsString(user_item)) {
        cfg.username = user_item->valuestring;
    }

    cJSON *pass_item = cJSON_GetObjectItem(root, "password");
    cJSON *keep_item = cJSON_GetObjectItem(root, "keep_password");
    if (cJSON_IsString(pass_item)) {
        if (strlen(pass_item->valuestring) > 0 || (keep_item && !cJSON_IsTrue(keep_item))) {
            cfg.password = pass_item->valuestring;
        }
    }

    cJSON_Delete(root);

    mqtt_mgr_save_config(cfg);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"MQTT settings saved\"}");
    return ESP_OK;
}

static esp_err_t api_notify_handler(httpd_req_t *req) {
    char buf[256];
    int ret = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (ret <= 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Empty request");
        return ESP_FAIL;
    }
    buf[ret] = '\0';
    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }
    cJSON *msg_item = cJSON_GetObjectItem(root, "message");
    if (!msg_item) msg_item = cJSON_GetObjectItem(root, "text");
    std::string msg = (msg_item && cJSON_IsString(msg_item)) ? msg_item->valuestring : "";
    cJSON *lvl_item = cJSON_GetObjectItem(root, "level");
    std::string lvl = (lvl_item && cJSON_IsString(lvl_item)) ? lvl_item->valuestring : "info";
    cJSON_Delete(root);

    if (msg.empty()) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing message");
        return ESP_FAIL;
    }

    bool sent = false;
    if (lvl == "warning") {
        sent = track_popup_show_warning(msg.c_str());
    } else if (lvl == "error") {
        sent = track_popup_show_error(msg.c_str());
    } else {
        sent = track_popup_show_info(msg.c_str());
    }

    httpd_resp_set_type(req, "application/json");
    if (sent) {
        httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"Notification queued for cluster\"}");
        return ESP_OK;
    } else {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to queue notification");
        return ESP_FAIL;
    }
}






static esp_err_t ws_handler(httpd_req_t *req) {
    return ESP_OK;
}

httpd_handle_t start_webserver(void) {
    httpd_handle_t server = nullptr;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 5120;
    config.uri_match_fn = httpd_uri_match_wildcard;
    config.max_uri_handlers = 40;
    config.lru_purge_enable = true;
    config.keep_alive_enable = true;
    config.keep_alive_idle = 10;
    config.send_wait_timeout = 25; // 25s send wait timeout for large asset streaming
    config.recv_wait_timeout = 15;
    config.max_open_sockets = 4; // limit open sockets to conserve lwIP buffers on ESP32-C3

    esp_err_t err = httpd_start(&server, &config);
    if (err == ESP_OK) {
        auto reg_uri = [&](const char* uri, httpd_method_t method, esp_err_t (*handler)(httpd_req_t*), bool is_ws = false) {
            httpd_uri_t u = {};
            u.uri = uri;
            u.method = method;
            u.handler = handler;
            u.user_ctx = nullptr;
#ifdef CONFIG_HTTPD_WS_SUPPORT
            u.is_websocket = is_ws;
#endif
            httpd_register_uri_handler(server, &u);
        };

        reg_uri("/api/states", HTTP_GET, api_states_handler);
        reg_uri("/api/command", HTTP_POST, api_command_handler);
        reg_uri("/api/notify", HTTP_POST, api_notify_handler);
        reg_uri("/api/test_automation", HTTP_POST, api_test_automation_handler);
        reg_uri("/api/automations/diagnostics", HTTP_GET, api_automations_diagnostics_handler);
        reg_uri("/api/automations", HTTP_GET, api_get_automations_handler);
        reg_uri("/api/automations", HTTP_POST, api_post_automations_handler);
        reg_uri("/api/preferences", HTTP_GET, api_get_preferences_handler);
        reg_uri("/api/preferences", HTTP_POST, api_post_preferences_handler);
        reg_uri("/api/system/status", HTTP_GET, api_system_status_handler);
        reg_uri("/api/system/control", HTTP_POST, api_system_control_handler);
        reg_uri("/api/wifi/status", HTTP_GET, api_wifi_status_handler);
        reg_uri("/api/wifi/networks", HTTP_GET, api_wifi_get_networks_handler);
        reg_uri("/api/wifi/networks", HTTP_POST, api_wifi_post_networks_handler);
        reg_uri("/api/wifi/networks", HTTP_DELETE, api_wifi_delete_networks_handler);
        reg_uri("/api/wifi/scan", HTTP_GET, api_wifi_scan_handler);
        reg_uri("/api/wifi/settings", HTTP_POST, api_wifi_settings_handler);
        reg_uri("/api/mqtt", HTTP_GET, api_mqtt_get_handler);
        reg_uri("/api/mqtt", HTTP_POST, api_mqtt_post_handler);
        reg_uri("/api/upload", HTTP_POST, api_file_upload_handler);
        reg_uri("/api/ota", HTTP_POST, api_ota_handler);
        reg_uri("/api/ota/cloud_pull", HTTP_POST, api_ota_cloud_pull_handler);
        reg_uri("/ws", HTTP_GET, ws_handler, true);
        reg_uri("/*", HTTP_OPTIONS, options_handler);
        reg_uri("/*", HTTP_GET, static_file_handler);

        global_web_server = server;
        ESP_LOGI(TAG, "Embedded Web Server started successfully on port %d", config.server_port);
    } else {
        ESP_LOGE(TAG, "Failed starting HTTP web server: %s", esp_err_to_name(err));
    }
    return server;
}

