#include "api.h"
#include "parser.h"
#include "can_engine.h"
#include "cJSON.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include <cstdio>
#include <cstring>
#include <algorithm>

static const char* TAG = "WEB_API";
httpd_handle_t global_web_server = nullptr;
static vprintf_like_t original_log_vprintf = nullptr;

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
    std::string json = "{\"type\":\"state\",\"entity\":\"" + entity_id + "\",\"state\":\"" + state + "\"}";
    broadcast_ws_raw(json);
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
    if (strstr(filepath, ".js")) return httpd_resp_set_type(req, "application/javascript");
    if (strstr(filepath, ".css")) return httpd_resp_set_type(req, "text/css");
    if (strstr(filepath, ".json")) return httpd_resp_set_type(req, "application/json");
    if (strstr(filepath, ".svg")) return httpd_resp_set_type(req, "image/svg+xml");
    return httpd_resp_set_type(req, "text/plain");
}

static esp_err_t static_file_handler(httpd_req_t *req) {
    char filepath[128];
    if (strcmp(req->uri, "/") == 0) {
        snprintf(filepath, sizeof(filepath), "/spiffs/www/index.html");
    } else {
        snprintf(filepath, sizeof(filepath), "/spiffs/www%s", req->uri);
    }

    FILE *fd = fopen(filepath, "r");
    if (!fd) {
        httpd_resp_send_404(req);
        return ESP_FAIL;
    }

    set_content_type_from_file(req, filepath);

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

static esp_err_t api_states_handler(httpd_req_t *req) {
    cJSON *root = cJSON_CreateArray();
    for (const auto& entity : global_catalog) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "entity", entity.id.c_str());
        cJSON_AddStringToObject(item, "state", entity.current_state.empty() ? "Unknown" : entity.current_state.c_str());
        cJSON_AddItemToArray(root, item);
    }

    char *json_string = cJSON_PrintUnformatted(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json_string);

    cJSON_Free(json_string);
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

static esp_err_t api_file_upload_handler(httpd_req_t *req) {
    char filepath[128];
    if (httpd_req_get_hdr_value_str(req, "X-File-Path", filepath, sizeof(filepath)) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing X-File-Path header");
        return ESP_FAIL;
    }

    if (strncmp(filepath, "/spiffs/", 8) != 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid path: must start with /spiffs/");
        return ESP_FAIL;
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

    if (strstr(filepath, ".json")) {
        httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"Catalog saved. Rebooting...\"}");
        xTaskCreate(restart_task, "restart_task", 2048, nullptr, 5, nullptr);
    } else {
        httpd_resp_sendstr(req, "{\"status\":\"success\",\"message\":\"File saved successfully.\"}");
    }
    return ESP_OK;
}

static esp_err_t api_ota_handler(httpd_req_t *req) {
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

static esp_err_t ws_handler(httpd_req_t *req) {
    return ESP_OK;
}

httpd_handle_t start_webserver(void) {
    httpd_handle_t server = nullptr;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.uri_match_fn = httpd_uri_match_wildcard;
    config.max_uri_handlers = 12;

    if (httpd_start(&server, &config) == ESP_OK) {
        httpd_uri_t api_states = { "/api/states", HTTP_GET, api_states_handler, nullptr };
        httpd_register_uri_handler(server, &api_states);

        httpd_uri_t api_cmd = { "/api/command", HTTP_POST, api_command_handler, nullptr };
        httpd_register_uri_handler(server, &api_cmd);

        httpd_uri_t api_test = { "/api/test_automation", HTTP_POST, api_test_automation_handler, nullptr };
        httpd_register_uri_handler(server, &api_test);

        httpd_uri_t api_up = { "/api/upload", HTTP_POST, api_file_upload_handler, nullptr };
        httpd_register_uri_handler(server, &api_up);

        httpd_uri_t api_ota = { "/api/ota", HTTP_POST, api_ota_handler, nullptr };
        httpd_register_uri_handler(server, &api_ota);

        httpd_uri_t ws_uri = { "/ws", HTTP_GET, ws_handler, nullptr, true };
        httpd_register_uri_handler(server, &ws_uri);

        // Static files fallback
        httpd_uri_t static_file_uri = { "/*", HTTP_GET, static_file_handler, nullptr };
        httpd_register_uri_handler(server, &static_file_uri);

        global_web_server = server;
        original_log_vprintf = esp_log_set_vprintf(custom_websocket_logger);
    }
    return server;
}
