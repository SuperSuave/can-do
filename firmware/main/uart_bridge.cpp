#include "uart_bridge.h"
#include "esp_log.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "parser.h"
#include "can_engine.h"
#include "vbat_sensor.h"
#include "precondition.h"
#include "network_mgr.h"
#include "track_popup.h"
#include "call_popup.h"
#include "api.h"
#include <cstring>
#include <vector>
#include <cctype>
#include <unordered_set>

static const char* TAG = "UART_BRIDGE";
static const int RX_BUF_SIZE = 2048;

void uart_bridge_send_raw(const std::string& line) {
    if (line.empty()) return;
    std::string out = line;
    if (out.back() != '\n') {
        out += '\n';
    }
    uart_write_bytes(UART_BRIDGE_PORT, out.data(), out.length());
}

void uart_bridge_send_state(const std::string& entity_id, const std::string& state) {
    std::string json = "{\"type\":\"state\",\"entity\":\"" + entity_id + "\",\"state\":\"" + state + "\"}";
    uart_bridge_send_raw(json);
}

void uart_bridge_send_can_frame(const twai_message_t* msg) {
    if (!msg) return;
    char hex_data[17] = {0};
    uint8_t dlc = msg->data_length_code > 8 ? 8 : msg->data_length_code;
    for (int i = 0; i < dlc; i++) {
        snprintf(&hex_data[i * 2], 3, "%02X", msg->data[i]);
    }
    char buf[128];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"can_frame\",\"id\":\"0x%lX\",\"dlc\":%d,\"data\":\"%s\"}",
             (unsigned long)msg->identifier, msg->data_length_code, hex_data);
    uart_bridge_send_raw(buf);
}

void uart_bridge_send_all_states(void) {
    cJSON *root = cJSON_CreateArray();
    std::unordered_set<std::string> included;
    for (const auto& entity : global_catalog) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "entity", entity.id.c_str());
        std::string st = entity.current_state;
        const auto& cache = get_live_state_cache();
        auto it = cache.find(entity.id);
        if (it != cache.end()) {
            st = it->second;
        }
        cJSON_AddStringToObject(item, "state", st.empty() ? "Unknown" : st.c_str());
        cJSON_AddItemToArray(root, item);
        included.insert(entity.id);
    }

    const auto& cache = get_live_state_cache();
    for (const auto& pair : cache) {
        if (included.find(pair.first) == included.end()) {
            cJSON *item = cJSON_CreateObject();
            cJSON_AddStringToObject(item, "entity", pair.first.c_str());
            cJSON_AddStringToObject(item, "state", pair.second.c_str());
            cJSON_AddItemToArray(root, item);
            included.insert(pair.first);
        }
    }

    if (included.find("cond_aux_12v_battery") == included.end()) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "entity", "cond_aux_12v_battery");
        cJSON_AddStringToObject(item, "state", vbat_sensor_get_last_str());
        cJSON_AddItemToArray(root, item);
    }

    char *json_str = cJSON_PrintUnformatted(root);
    if (json_str) {
        std::string payload = "{\"type\":\"states_dump\",\"data\":";
        payload += json_str;
        payload += "}";
        uart_bridge_send_raw(payload);
        free(json_str);
    }
    cJSON_Delete(root);
}

static void handle_incoming_command(const char* json_str) {
    cJSON *root = cJSON_Parse(json_str);
    if (!root) {
        ESP_LOGW(TAG, "Malformed JSON from UART: %s", json_str);
        return;
    }

    cJSON *type_item = cJSON_GetObjectItem(root, "type");
    const char* type = cJSON_IsString(type_item) ? type_item->valuestring : "";

    cJSON *msg_item = cJSON_GetObjectItem(root, "message");
    if (!msg_item) msg_item = cJSON_GetObjectItem(root, "text");

    cJSON *entity_item = cJSON_GetObjectItem(root, "entity");
    cJSON *cmd_item = cJSON_GetObjectItem(root, "command");
    cJSON *can_id_item = cJSON_GetObjectItem(root, "can_id");

    if (strcmp(type, "get_states") == 0) {
        uart_bridge_send_all_states();
    } else if (strcmp(type, "ping") == 0) {
        uart_bridge_send_raw("{\"type\":\"pong\"}");
    } else if (strcmp(type, "lock") == 0 || strcmp(type, "unlock") == 0) {
        bool is_lock = (strcmp(type, "lock") == 0);
        bool ok = queue_entity_command("door_locks", is_lock ? "lock" : "unlock");
        if (!ok) ok = queue_entity_command("doors_lock_state", is_lock ? "lock" : "unlock");
        if (!ok) ok = queue_entity_command("bridge_door_lock_ctrl", is_lock ? "lock" : "unlock");
        uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"status\":\"queued\"}" : "{\"type\":\"nack\",\"error\":\"lock_failed\"}");
        cJSON_Delete(root);
        return;
    } else if (strcmp(type, "notify") == 0 || (msg_item && cJSON_IsString(msg_item) && strlen(type) == 0)) {
        std::string msg = (msg_item && cJSON_IsString(msg_item)) ? msg_item->valuestring : "";
        cJSON *lvl_item = cJSON_GetObjectItem(root, "level");
        std::string lvl = (lvl_item && cJSON_IsString(lvl_item)) ? lvl_item->valuestring : "info";

        cJSON *caller_item = cJSON_GetObjectItem(root, "caller");
        if (!caller_item) caller_item = cJSON_GetObjectItem(root, "title");
        std::string caller = (caller_item && cJSON_IsString(caller_item)) ? caller_item->valuestring : "";

        cJSON *hold_item = cJSON_GetObjectItem(root, "hold_ms");
        uint32_t hold_ms = (hold_item && cJSON_IsNumber(hold_item)) ? (uint32_t)hold_item->valueint : 5000;

        bool is_call = (!caller.empty()) || (strcmp(type, "call") == 0 || strcmp(type, "call_popup") == 0 || strcmp(type, "call_alert") == 0);
        bool sent = false;

        if (is_call) {
            if (caller.empty()) caller = "Home Assistant";
            call_popup_severity_t sev = CALL_POPUP_SEV_INFO;
            if (lvl == "warning") sev = CALL_POPUP_SEV_WARNING;
            else if (lvl == "error" || lvl == "critical") sev = CALL_POPUP_SEV_CRITICAL;
            sent = call_popup_show(caller.c_str(), msg.c_str(), sev, hold_ms);
        } else {
            if (lvl == "warning") {
                sent = track_popup_show_warning(msg.c_str());
            } else if (lvl == "error") {
                sent = track_popup_show_error(msg.c_str());
            } else {
                sent = track_popup_show_info(msg.c_str());
            }
        }
        uart_bridge_send_raw(sent ? "{\"type\":\"ack\",\"status\":\"notified\"}" : "{\"type\":\"nack\",\"error\":\"notify_failed\"}");
        cJSON_Delete(root);
        return;
    } else if (strcmp(type, "cmd") == 0 || entity_item != nullptr || can_id_item != nullptr) {
        if (cJSON_IsString(entity_item)) {
            const char* entity = entity_item->valuestring;
            const char* cmd = cJSON_IsString(cmd_item) ? cmd_item->valuestring : "";
            if (strcmp(entity, "hvac_direct_climate_cmd") == 0) {
                bool ok = queue_entity_command("hvac_direct_climate_cmd", cmd);
                uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"status\":\"queued\"}" : "{\"type\":\"nack\",\"error\":\"entity_failed\"}");
                return;
            }
            bool ok = queue_entity_command(entity, cmd);
            ESP_LOGI(TAG, "Entity command '%s' -> '%s' (queued: %d)", entity, cmd, ok);
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"status\":\"queued\"}" : "{\"type\":\"nack\",\"error\":\"entity_failed\"}");
        } else if (can_id_item) {
            uint32_t cid = 0;
            if (cJSON_IsString(can_id_item)) {
                cid = strtoul(can_id_item->valuestring, nullptr, 0);
            } else if (cJSON_IsNumber(can_id_item)) {
                cid = (uint32_t)can_id_item->valuedouble;
            }

            cJSON *payload_item = cJSON_GetObjectItem(root, "payload");
            cJSON *repeat_item = cJSON_GetObjectItem(root, "repeat");
            cJSON *delay_item = cJSON_GetObjectItem(root, "delay_ms");

            ActionStep step = {};
            step.type = ActionType::TRANSMIT_FRAME;
            step.can_id = cid;
            step.repeat = cJSON_IsNumber(repeat_item) ? (int)repeat_item->valuedouble : 1;
            step.delay_ms = cJSON_IsNumber(delay_item) ? (uint32_t)delay_item->valuedouble : 0;
            step.mask = 0xFF;

            if (cJSON_IsString(payload_item)) {
                const char* pstr = payload_item->valuestring;
                std::string clean = "";
                for (size_t i = 0; pstr[i]; i++) {
                    if (isxdigit((unsigned char)pstr[i])) clean += pstr[i];
                }
                for (size_t i = 0; i < 8 && (i * 2 + 1) < clean.length(); i++) {
                    std::string bhex = clean.substr(i * 2, 2);
                    step.payload[i] = (uint8_t)strtoul(bhex.c_str(), nullptr, 16);
                }
            } else if (cJSON_IsObject(payload_item)) {
                cJSON* p_sub = nullptr;
                cJSON_ArrayForEach(p_sub, payload_item) {
                    int idx = get_d_index(p_sub->string);
                    if (idx >= 0) {
                        if (cJSON_IsString(p_sub)) {
                            step.payload[idx] = parse_hex_string(p_sub->valuestring);
                        } else if (cJSON_IsNumber(p_sub)) {
                            step.payload[idx] = static_cast<uint8_t>(p_sub->valueint);
                        }
                    }
                }
            } else if (cJSON_IsArray(payload_item)) {
                int arr_sz = cJSON_GetArraySize(payload_item);
                for (int i = 0; i < arr_sz && i < 8; i++) {
                    cJSON* itm = cJSON_GetArrayItem(payload_item, i);
                    if (itm) {
                        if (cJSON_IsNumber(itm)) step.payload[i] = static_cast<uint8_t>(itm->valueint);
                        else if (cJSON_IsString(itm)) step.payload[i] = parse_hex_string(itm->valuestring);
                    }
                }
            }

            std::vector<ActionStep> steps = { step };
            bool ok = queue_action_steps(cid, step.delay_ms, steps);
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"status\":\"queued\"}" : "{\"type\":\"nack\",\"error\":\"queue_failed\"}");
        }
    } else if (strcmp(type, "trigger") == 0) {
        cJSON *action_item = cJSON_GetObjectItem(root, "action");
        const char* action = cJSON_IsString(action_item) ? action_item->valuestring : "";
        if (strcmp(action, "preheat") == 0 || strcmp(action, "precon_toggle") == 0) {
            precondition_toggle_request();
            uart_bridge_send_raw("{\"type\":\"ack\",\"action\":\"precon_toggled\"}");
        } else if (strcmp(action, "climate_toggle") == 0) {
            bool ok = queue_entity_command("remote_climate_start_smart", "toggle");
            if (!ok) ok = queue_entity_command("remote_climate_start", "toggle");
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"action\":\"climate_toggled\"}" : "{\"type\":\"nack\",\"error\":\"climate_failed\"}");
        } else if (strcmp(action, "climate_start") == 0) {
            bool ok = queue_entity_command("remote_climate_start_smart", "Start");
            if (!ok) ok = queue_entity_command("remote_climate_start", "Start");
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"action\":\"climate_started\"}" : "{\"type\":\"nack\",\"error\":\"climate_failed\"}");
        } else if (strcmp(action, "climate_stop") == 0) {
            bool ok = queue_entity_command("remote_climate_start_smart", "off");
            if (!ok) ok = queue_entity_command("remote_climate_start", "off");
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"action\":\"climate_stopped\"}" : "{\"type\":\"nack\",\"error\":\"climate_failed\"}");
        } else if (strcmp(action, "lock") == 0) {
            bool ok = queue_entity_command("door_locks", "lock");
            if (!ok) ok = queue_entity_command("doors_lock_state", "lock");
            if (!ok) ok = queue_entity_command("bridge_door_lock_ctrl", "lock");
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"action\":\"locked\"}" : "{\"type\":\"nack\",\"error\":\"lock_failed\"}");
        } else if (strcmp(action, "unlock") == 0) {
            bool ok = queue_entity_command("door_locks", "unlock");
            if (!ok) ok = queue_entity_command("doors_lock_state", "unlock");
            if (!ok) ok = queue_entity_command("bridge_door_lock_ctrl", "unlock");
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"action\":\"unlocked\"}" : "{\"type\":\"nack\",\"error\":\"unlock_failed\"}");
        } else if (strcmp(action, "lock_toggle") == 0) {
            bool ok = queue_entity_command("door_locks", "toggle");
            if (!ok) ok = queue_entity_command("doors_lock_state", "toggle");
            if (!ok) ok = queue_entity_command("bridge_door_lock_ctrl", "toggle");
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"action\":\"lock_toggled\"}" : "{\"type\":\"nack\",\"error\":\"toggle_failed\"}");
        } else {
            ESP_LOGW(TAG, "Unknown trigger action: %s", action);
        }
    } else if (strcmp(type, "wifi_save") == 0) {
        cJSON *ssid_item = cJSON_GetObjectItem(root, "ssid");
        cJSON *pass_item = cJSON_GetObjectItem(root, "password");
        cJSON *prio_item = cJSON_GetObjectItem(root, "priority");
        if (cJSON_IsString(ssid_item) && strlen(ssid_item->valuestring) > 0) {
            const char* ssid = ssid_item->valuestring;
            const char* pass = cJSON_IsString(pass_item) ? pass_item->valuestring : "";
            int prio = cJSON_IsNumber(prio_item) ? prio_item->valueint : 50;
            network_mgr_add_known_network(ssid, pass, prio);
            ESP_LOGI(TAG, "Saved Wi-Fi network '%s' from bridge", ssid);
        }
    } else if (strcmp(type, "wifi_delete") == 0) {
        cJSON *ssid_item = cJSON_GetObjectItem(root, "ssid");
        if (cJSON_IsString(ssid_item) && strlen(ssid_item->valuestring) > 0) {
            network_mgr_remove_known_network(ssid_item->valuestring);
            ESP_LOGI(TAG, "Removed Wi-Fi network '%s' from bridge", ssid_item->valuestring);
        }
    }

    cJSON_Delete(root);
}

static void uart_bridge_rx_task(void* pvParameters) {
    uint8_t* dtmp = (uint8_t*)malloc(RX_BUF_SIZE);
    if (!dtmp) {
        ESP_LOGE(TAG, "Failed to allocate UART RX buffer");
        vTaskDelete(NULL);
        return;
    }

    std::string line_buffer = "";
    ESP_LOGI(TAG, "UART Bridge RX task active (Corner TX=GPIO%d, RX=GPIO%d, %d baud)", 
             UART_BRIDGE_TX_PIN, UART_BRIDGE_RX_PIN, UART_BRIDGE_BAUD_RATE);

    while (true) {
        int len = uart_read_bytes(UART_BRIDGE_PORT, dtmp, RX_BUF_SIZE - 1, pdMS_TO_TICKS(50));
        if (len > 0) {
            for (int i = 0; i < len; i++) {
                char c = (char)dtmp[i];
                if (c == '\n' || c == '\r') {
                    if (!line_buffer.empty()) {
                        handle_incoming_command(line_buffer.c_str());
                        line_buffer.clear();
                    }
                } else {
                    if (line_buffer.length() < 1024) {
                        line_buffer += c;
                    } else {
                        // Overflow guard
                        line_buffer.clear();
                    }
                }
            }
        }
    }

    free(dtmp);
    vTaskDelete(NULL);
}

void uart_bridge_init(void) {
    uart_config_t uart_config = {};
    uart_config.baud_rate = UART_BRIDGE_BAUD_RATE;
    uart_config.data_bits = UART_DATA_8_BITS;
    uart_config.parity    = UART_PARITY_DISABLE;
    uart_config.stop_bits = UART_STOP_BITS_1;
    uart_config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    uart_config.rx_flow_ctrl_thresh = 0;
    uart_config.source_clk = UART_SCLK_DEFAULT;

    ESP_ERROR_CHECK(uart_param_config(UART_BRIDGE_PORT, &uart_config));
    ESP_ERROR_CHECK(uart_set_pin(UART_BRIDGE_PORT, UART_BRIDGE_TX_PIN, UART_BRIDGE_RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    ESP_ERROR_CHECK(uart_driver_install(UART_BRIDGE_PORT, RX_BUF_SIZE * 2, RX_BUF_SIZE * 2, 0, NULL, 0));

    xTaskCreate(uart_bridge_rx_task, "UART_BRIDGE_RX", 4096, NULL, 5, NULL);
    ESP_LOGI(TAG, "UART Bridge initialized on port %d (TX: GPIO%d, RX: GPIO%d)", 
             UART_BRIDGE_PORT, UART_BRIDGE_TX_PIN, UART_BRIDGE_RX_PIN);
}
