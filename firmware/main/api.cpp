#include "api.h"
#include "parser.h"
#include "can_engine.h"
#include "network_mgr.h"
#include "gvret_server.h"
#include "mqtt_mgr.h"
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

void broadcast_ws_can_frame(const twai_message_t* msg) {
    if (!msg || !global_web_server) return;
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
    char filepath[600];
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
    for (const auto& entity : global_catalog) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "entity", entity.id.c_str());
        cJSON_AddStringToObject(item, "state", entity.current_state.empty() ? "Unknown" : entity.current_state.c_str());
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

static esp_err_t api_get_automations_handler(httpd_req_t *req) {
    set_cors_headers(req);
    const char *filepath = "/spiffs/automations.json";
    FILE *fd = fopen(filepath, "r");
    if (!fd) {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"settings\":{\"vehicle_model\":\"all_egmp\",\"unit_system\":\"imperial\",\"firmware_version\":\"2.0.0\"},\"rules\":[]}");
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

static esp_err_t api_system_status_handler(httpd_req_t *req) {
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "automations_enabled", g_automations_enabled.load());
    cJSON_AddBoolToObject(root, "sniffer_mode", g_sniffer_mode.load());
    cJSON_AddBoolToObject(root, "hardware_listen_only", g_hardware_listen_only.load());
    cJSON_AddNumberToObject(root, "gvret_clients", gvret_get_client_count());

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

static esp_err_t ws_handler(httpd_req_t *req) {
    return ESP_OK;
}

httpd_handle_t start_webserver(void) {
    httpd_handle_t server = nullptr;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.uri_match_fn = httpd_uri_match_wildcard;
    config.max_uri_handlers = 32;
    config.lru_purge_enable = true;
    config.keep_alive_enable = true;
    config.keep_alive_idle = 5;

    if (httpd_start(&server, &config) == ESP_OK) {
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
        reg_uri("/api/test_automation", HTTP_POST, api_test_automation_handler);
        reg_uri("/api/automations", HTTP_GET, api_get_automations_handler);
        reg_uri("/api/automations", HTTP_POST, api_post_automations_handler);
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
        reg_uri("/ws", HTTP_GET, ws_handler, true);
        reg_uri("/*", HTTP_OPTIONS, options_handler);
        reg_uri("/*", HTTP_GET, static_file_handler);

        global_web_server = server;
        original_log_vprintf = esp_log_set_vprintf(custom_websocket_logger);
    }
    return server;
}

