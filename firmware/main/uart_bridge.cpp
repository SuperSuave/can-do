#include "uart_bridge.h"
#include "esp_log.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "parser.h"
#include "can_engine.h"
#include "vbat_sensor.h"
#include "precondition.h"
#include <cstring>
#include <vector>
#include <cctype>

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
    if (!had_vbat) {
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

    if (strcmp(type, "get_states") == 0) {
        uart_bridge_send_all_states();
    } else if (strcmp(type, "ping") == 0) {
        uart_bridge_send_raw("{\"type\":\"pong\"}");
    } else if (strcmp(type, "cmd") == 0) {
        cJSON *entity_item = cJSON_GetObjectItem(root, "entity");
        cJSON *cmd_item = cJSON_GetObjectItem(root, "command");
        cJSON *can_id_item = cJSON_GetObjectItem(root, "can_id");

        if (cJSON_IsString(entity_item)) {
            const char* entity = entity_item->valuestring;
            const char* cmd = cJSON_IsString(cmd_item) ? cmd_item->valuestring : "";
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
            }

            std::vector<ActionStep> steps = { step };
            bool ok = queue_action_steps(cid, step.delay_ms, steps);
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"status\":\"queued\"}" : "{\"type\":\"nack\",\"error\":\"queue_failed\"}");
        }
    } else if (strcmp(type, "trigger") == 0) {
        cJSON *action_item = cJSON_GetObjectItem(root, "action");
        const char* action = cJSON_IsString(action_item) ? action_item->valuestring : "";
        if (strcmp(action, "preheat") == 0 || strcmp(action, "precon_toggle") == 0) {
            bool running = precon_is_running();
            precon_start(!running);
            uart_bridge_send_raw("{\"type\":\"ack\",\"action\":\"precon_toggled\"}");
        } else {
            ESP_LOGW(TAG, "Unknown trigger action: %s", action);
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
    ESP_LOGI(TAG, "UART Bridge RX task active (IO1=TX, IO5=RX, %d baud)", UART_BRIDGE_BAUD_RATE);

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
    uart_config_t uart_config = {
        .baud_rate = UART_BRIDGE_BAUD_RATE,
        .data_bits = UART_DATA_8_BITS,
        .parity    = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };

    ESP_ERROR_CHECK(uart_param_config(UART_BRIDGE_PORT, &uart_config));
    ESP_ERROR_CHECK(uart_set_pin(UART_BRIDGE_PORT, UART_BRIDGE_TX_PIN, UART_BRIDGE_RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    ESP_ERROR_CHECK(uart_driver_install(UART_BRIDGE_PORT, RX_BUF_SIZE * 2, RX_BUF_SIZE * 2, 0, NULL, 0));

    xTaskCreate(uart_bridge_rx_task, "UART_BRIDGE_RX", 4096, NULL, 5, NULL);
    ESP_LOGI(TAG, "UART Bridge initialized on port %d (TX: GPIO%d, RX: GPIO%d)", 
             UART_BRIDGE_PORT, UART_BRIDGE_TX_PIN, UART_BRIDGE_RX_PIN);
}
