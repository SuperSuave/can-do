#include "uart_bridge.h"
#include "esp_log.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "parser.h"
#include "can_engine.h"
#include "vbat_sensor.h"
#include "precondition.h"
#include "network_mgr.h"
#include "track_popup.h"
#include "api.h"
#include "esp_timer.h"
#include "driver/gpio.h"
#include <cstring>
#include <vector>
#include <cctype>
#include <unordered_set>
#include <atomic>
#include <mutex>

static const char* TAG = "UART_BRIDGE";
static const int RX_BUF_SIZE = 4096;
static const int TX_BUF_SIZE = 4096;
static const size_t MAX_TX_MSG_LEN = 384;
static const size_t TX_QUEUE_DEPTH = 32;

struct UartTxMsg {
    uint16_t len;
    char data[MAX_TX_MSG_LEN];
};

static QueueHandle_t s_uart_tx_queue = nullptr;
static std::atomic<int64_t> s_last_bridge_rx_us{0};
static std::atomic<bool> s_dump_states_requested{false};
static std::atomic<int64_t> s_last_states_dump_us{0};
static std::atomic<uint32_t> s_tx_dropped_count{0};

static std::mutex s_ble_status_mutex;
static std::string s_cached_ble_status = "{\"enabled\":true,\"scanning\":false,\"connected_device\":null,\"paired_devices\":[],\"discovered_devices\":[]}";
static FILE* s_auto_tmp_file = nullptr;

bool uart_bridge_is_online(void) {
    int64_t last = s_last_bridge_rx_us.load(std::memory_order_relaxed);
    if (last == 0) return false;
    return (esp_timer_get_time() - last) < 8000000; // 8 seconds timeout
}

// Non-blocking enqueue: NEVER stalls CAN RX, HTTP, or timer tasks
void uart_bridge_send_raw(const std::string& line) {
    if (line.empty()) return;

    // Fast-path for oversized payloads (e.g., states_dump batch): use non-blocking uart_tx_chars
    if (line.length() + 2 > MAX_TX_MSG_LEN) {
        uart_tx_chars(UART_BRIDGE_PORT, line.data(), line.length());
        if (line.back() != '\n') {
            uart_tx_chars(UART_BRIDGE_PORT, "\n", 1);
        }
        return;
    }

    if (!s_uart_tx_queue) return;

    UartTxMsg msg;
    size_t copy_len = line.length();
    memcpy(msg.data, line.data(), copy_len);
    if (msg.data[copy_len - 1] != '\n') {
        msg.data[copy_len++] = '\n';
    }
    msg.len = static_cast<uint16_t>(copy_len);

    // 0-tick non-blocking send: drop if queue is full rather than stalling caller
    if (xQueueSend(s_uart_tx_queue, &msg, 0) != pdTRUE) {
        s_tx_dropped_count.fetch_add(1, std::memory_order_relaxed);
    }
}

void uart_bridge_send_state(const std::string& entity_id, const std::string& state) {
    // Do not flood UART TX if Atom Lite is powered off or offline
    if (!uart_bridge_is_online()) return;

    char buf[256];
    int n = snprintf(buf, sizeof(buf), "{\"type\":\"state\",\"entity\":\"%s\",\"state\":\"%s\"}\n",
                     entity_id.c_str(), state.c_str());
    if (n > 0 && n < (int)sizeof(buf)) {
        uart_bridge_send_raw(std::string(buf, n));
    }
}

void uart_bridge_send_can_frame(const twai_message_t* msg) {
    // Raw CAN frame streaming over UART disabled during normal operation to protect bandwidth
    (void)msg;
}

void uart_bridge_request_all_states(void) {
    s_dump_states_requested.store(true, std::memory_order_relaxed);
}

void uart_bridge_send_all_states(void) {
    int64_t now_us = esp_timer_get_time();
    int64_t last_dump = s_last_states_dump_us.load(std::memory_order_relaxed);
    // Rate-limit full state dumps to at most once every 2 seconds
    if (last_dump != 0 && (now_us - last_dump) < 2000000) {
        return;
    }
    s_last_states_dump_us.store(now_us, std::memory_order_relaxed);

    std::unordered_set<std::string> included;
    const auto cache = get_live_state_cache(); // Single mutex snapshot, instead of locking inside loop

    std::string batch_payload;
    batch_payload.reserve(1024);
    int batch_count = 0;

    auto start_batch = [&]() {
        batch_payload = "{\"type\":\"states_dump\",\"data\":[";
        batch_count = 0;
    };

    auto flush_batch = [&]() {
        if (batch_count == 0) return;
        batch_payload += "]}\n";
        uart_tx_chars(UART_BRIDGE_PORT, batch_payload.data(), batch_payload.length());
        // Yield to feed IDLE0 watchdog and allow UART hardware FIFO to drain
        vTaskDelay(pdMS_TO_TICKS(5));
        start_batch();
    };

    auto append_escaped = [&](const std::string& eid, const std::string& st) {
        if (batch_count > 0) batch_payload += ",";
        batch_payload += "{\"entity\":\"";
        batch_payload += eid;
        batch_payload += "\",\"state\":\"";
        for (char c : st) {
            if (c == '"' || c == '\\') batch_payload += '\\';
            batch_payload += c;
        }
        batch_payload += "\"}";
        batch_count++;
        if (batch_count >= 12) {
            flush_batch();
        }
    };

    start_batch();

    for (const auto& entity : global_catalog) {
        std::string st = entity.current_state;
        auto it = cache.find(entity.id);
        if (it != cache.end()) {
            st = it->second;
        }
        append_escaped(entity.id, st.empty() ? "Unknown" : st);
        included.insert(entity.id);
    }

    for (const auto& pair : cache) {
        if (included.find(pair.first) == included.end()) {
            append_escaped(pair.first, pair.second);
            included.insert(pair.first);
        }
    }

    if (included.find("cond_aux_12v_battery") == included.end()) {
        append_escaped("cond_aux_12v_battery", vbat_sensor_get_last_str());
    }

    flush_batch();
}

static void handle_incoming_command(const char* json_str, size_t len) {
    if (!json_str || len < 2) return;

    // 1. Zero-allocation fast paths for high-frequency control messages
    if (strstr(json_str, "\"type\":\"ping\"") != nullptr) {
        uart_bridge_send_raw("{\"type\":\"pong\"}");
        return;
    }
    if (strstr(json_str, "\"type\":\"pong\"") != nullptr) {
        return;
    }
    if (strstr(json_str, "\"type\":\"get_states\"") != nullptr) {
        uart_bridge_request_all_states();
        return;
    }

    // 2. Fast-path extraction for large ble_status payloads without full cJSON re-serialization
    if (strstr(json_str, "\"type\":\"ble_status\"") != nullptr) {
        const char* data_pos = strstr(json_str, "\"data\":");
        if (data_pos) {
            data_pos += 7; // skip `"data":`
            while (*data_pos == ' ') data_pos++;
            size_t rem_len = len - (data_pos - json_str);
            if (rem_len > 1 && data_pos[rem_len - 1] == '}') {
                std::lock_guard<std::mutex> lock(s_ble_status_mutex);
                s_cached_ble_status.assign(data_pos, rem_len - 1);
            }
        }
        return;
    }

    cJSON *root = cJSON_Parse(json_str);
    if (!root) {
        return;
    }

    cJSON *type_item = cJSON_GetObjectItem(root, "type");
    const char* type = cJSON_IsString(type_item) ? type_item->valuestring : "";

    cJSON *msg_item = cJSON_GetObjectItem(root, "message");
    if (!msg_item) msg_item = cJSON_GetObjectItem(root, "text");

    cJSON *entity_item = cJSON_GetObjectItem(root, "entity");
    cJSON *cmd_item = cJSON_GetObjectItem(root, "command");
    cJSON *can_id_item = cJSON_GetObjectItem(root, "can_id");

    if (strcmp(type, "lock") == 0 || strcmp(type, "unlock") == 0) {
        bool is_lock = (strcmp(type, "lock") == 0);
        bool ok = queue_entity_command("door_locks", is_lock ? "lock" : "unlock");
        if (!ok) ok = queue_entity_command("doors_lock_state", is_lock ? "lock" : "unlock");
        if (!ok) ok = queue_entity_command("bridge_door_lock_ctrl", is_lock ? "lock" : "unlock");
        uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"status\":\"queued\"}" : "{\"type\":\"nack\",\"error\":\"lock_failed\"}");
    } else if (strcmp(type, "notify") == 0 || (msg_item && cJSON_IsString(msg_item) && strlen(type) == 0)) {
        std::string msg = (msg_item && cJSON_IsString(msg_item)) ? msg_item->valuestring : "";
        cJSON *lvl_item = cJSON_GetObjectItem(root, "level");
        std::string lvl = (lvl_item && cJSON_IsString(lvl_item)) ? lvl_item->valuestring : "info";

        bool sent = false;
        if (lvl == "warning") {
            sent = track_popup_show_warning(msg.c_str());
        } else if (lvl == "error" || lvl == "critical") {
            sent = track_popup_show_error(msg.c_str());
        } else {
            sent = track_popup_show_info(msg.c_str());
        }
        uart_bridge_send_raw(sent ? "{\"type\":\"ack\",\"status\":\"notified\"}" : "{\"type\":\"nack\",\"error\":\"notify_failed\"}");
    } else if (strcmp(type, "cmd") == 0 || entity_item != nullptr || can_id_item != nullptr) {
        if (cJSON_IsString(entity_item)) {
            const char* entity = entity_item->valuestring;
            const char* cmd = cJSON_IsString(cmd_item) ? cmd_item->valuestring : "";
            bool ok = queue_entity_command(entity, cmd);
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
            bool ok = queue_entity_command("remote_climate", "toggle");
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"action\":\"climate_toggled\"}" : "{\"type\":\"nack\",\"error\":\"climate_failed\"}");
        } else if (strcmp(action, "climate_start") == 0) {
            bool ok = queue_entity_command("remote_climate", "Start");
            uart_bridge_send_raw(ok ? "{\"type\":\"ack\",\"action\":\"climate_started\"}" : "{\"type\":\"nack\",\"error\":\"climate_failed\"}");
        } else if (strcmp(action, "climate_stop") == 0) {
            bool ok = queue_entity_command("remote_climate", "off");
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
        }
    } else if (strcmp(type, "wifi_delete") == 0) {
        cJSON *ssid_item = cJSON_GetObjectItem(root, "ssid");
        if (cJSON_IsString(ssid_item) && strlen(ssid_item->valuestring) > 0) {
            network_mgr_remove_known_network(ssid_item->valuestring);
        }
    } else if (strcmp(type, "ble_event") == 0) {
        broadcast_ws_raw(json_str);
        cJSON* addr = cJSON_GetObjectItem(root, "address");
        if (!addr) addr = cJSON_GetObjectItem(root, "mac");
        cJSON* btn = cJSON_GetObjectItem(root, "button");
        cJSON* act = cJSON_GetObjectItem(root, "action");
        cJSON* combo = cJSON_GetObjectItem(root, "combo");
        std::string addr_str = (addr && cJSON_IsString(addr)) ? addr->valuestring : "";
        std::string btn_str = (btn && cJSON_IsString(btn)) ? btn->valuestring : "";
        std::string act_str = (act && cJSON_IsString(act)) ? act->valuestring : "press";
        std::string combo_str = (combo && cJSON_IsString(combo)) ? combo->valuestring : "";
        can_engine_on_ble_event(addr_str, btn_str, act_str, combo_str);
    } else if (strcmp(type, "ble_device_event") == 0) {
        broadcast_ws_raw(json_str);
        cJSON* addr = cJSON_GetObjectItem(root, "address");
        if (!addr) addr = cJSON_GetObjectItem(root, "mac");
        cJSON* evt = cJSON_GetObjectItem(root, "event");
        cJSON* rssi = cJSON_GetObjectItem(root, "rssi");
        cJSON* name = cJSON_GetObjectItem(root, "name");
        std::string addr_str = (addr && cJSON_IsString(addr)) ? addr->valuestring : "";
        std::string evt_str = (evt && cJSON_IsString(evt)) ? evt->valuestring : "connected";
        std::string name_str = (name && cJSON_IsString(name)) ? name->valuestring : "";
        int8_t rssi_val = (rssi && cJSON_IsNumber(rssi)) ? static_cast<int8_t>(rssi->valueint) : 0;
        can_engine_on_ble_device_event(addr_str, evt_str, rssi_val, name_str);
    } else if (strcmp(type, "ble_beacon") == 0) {
        broadcast_ws_raw(json_str);
        cJSON* uuid = cJSON_GetObjectItem(root, "uuid");
        cJSON* mac = cJSON_GetObjectItem(root, "mac");
        if (!mac) mac = cJSON_GetObjectItem(root, "address");
        cJSON* evt = cJSON_GetObjectItem(root, "event");
        cJSON* rssi = cJSON_GetObjectItem(root, "rssi");
        cJSON* major = cJSON_GetObjectItem(root, "major");
        cJSON* minor = cJSON_GetObjectItem(root, "minor");
        cJSON* name = cJSON_GetObjectItem(root, "name");
        std::string uuid_str = (uuid && cJSON_IsString(uuid)) ? uuid->valuestring : "";
        std::string mac_str = (mac && cJSON_IsString(mac)) ? mac->valuestring : "";
        std::string evt_str = (evt && cJSON_IsString(evt)) ? evt->valuestring : "enter";
        std::string name_str = (name && cJSON_IsString(name)) ? name->valuestring : "";
        int8_t rssi_val = (rssi && cJSON_IsNumber(rssi)) ? static_cast<int8_t>(rssi->valueint) : 0;
        uint16_t major_val = (major && cJSON_IsNumber(major)) ? static_cast<uint16_t>(major->valueint) : 0;
        uint16_t minor_val = (minor && cJSON_IsNumber(minor)) ? static_cast<uint16_t>(minor->valueint) : 0;
        can_engine_on_ble_beacon_event(uuid_str, evt_str, rssi_val, major_val, minor_val, mac_str, name_str);
    } else if (strcmp(type, "auto_begin") == 0) {
        if (s_auto_tmp_file) {
            fclose(s_auto_tmp_file);
            s_auto_tmp_file = nullptr;
        }
        s_auto_tmp_file = fopen("/spiffs/automations.json.tmp", "w");
        uart_bridge_send_raw(s_auto_tmp_file ? "{\"type\":\"ack\",\"status\":\"auto_ready\"}" : "{\"type\":\"nack\",\"error\":\"open_failed\"}");
    } else if (strcmp(type, "auto_chunk") == 0) {
        cJSON* hex_item = cJSON_GetObjectItem(root, "hex");
        if (s_auto_tmp_file && cJSON_IsString(hex_item)) {
            const char* hex = hex_item->valuestring;
            size_t hlen = strlen(hex);
            for (size_t i = 0; i + 1 < hlen; i += 2) {
                char byte_str[3] = { hex[i], hex[i+1], '\0' };
                uint8_t b = (uint8_t)strtoul(byte_str, nullptr, 16);
                fputc(b, s_auto_tmp_file);
            }
        }
    } else if (strcmp(type, "auto_end") == 0) {
        if (s_auto_tmp_file) {
            fclose(s_auto_tmp_file);
            s_auto_tmp_file = nullptr;
            remove("/spiffs/automations.json");
            if (rename("/spiffs/automations.json.tmp", "/spiffs/automations.json") == 0) {
                ESP_LOGI(TAG, "Automations synchronized from Atom Lite. Reloading rules...");
                load_automations_from_fs("/spiffs/automations.json");
                uart_bridge_send_raw("{\"type\":\"ack\",\"status\":\"auto_synced\"}");
            } else {
                uart_bridge_send_raw("{\"type\":\"nack\",\"error\":\"rename_failed\"}");
            }
        }
    }

    cJSON_Delete(root);
}

std::string uart_bridge_get_ble_status(void) {
    if (uart_bridge_is_online()) {
        uart_bridge_send_raw("{\"type\":\"ble_get_status\"}");
    }
    std::lock_guard<std::mutex> lock(s_ble_status_mutex);
    return s_cached_ble_status;
}

static void uart_bridge_worker_task(void* pvParameters) {
    uint8_t* dtmp = (uint8_t*)malloc(1024);
    if (!dtmp) {
        ESP_LOGE(TAG, "Failed to allocate UART RX buffer");
        vTaskDelete(NULL);
        return;
    }

    std::string line_buffer;
    line_buffer.reserve(2048);

    UartTxMsg tx_msg;
    int64_t last_heartbeat_us = esp_timer_get_time();

    while (true) {
        // 1. Drain outbound UART TX queue using non-blocking uart_tx_chars
        int tx_drained = 0;
        while (tx_drained < 16 && xQueueReceive(s_uart_tx_queue, &tx_msg, 0) == pdTRUE) {
            uart_tx_chars(UART_BRIDGE_PORT, tx_msg.data, tx_msg.len);
            tx_drained++;
        }

        // 2. Service deferred state dump requests with watchdog-friendly yields
        if (s_dump_states_requested.exchange(false)) {
            uart_bridge_send_all_states();
        }

        // 3. Read incoming UART bytes with short 20ms timeout so IDLE0 and lower tasks run freely
        int len = uart_read_bytes(UART_BRIDGE_PORT, dtmp, 1024 - 1, pdMS_TO_TICKS(20));
        if (len > 0) {
            s_last_bridge_rx_us.store(esp_timer_get_time(), std::memory_order_relaxed);
            int lines_processed = 0;

            for (int i = 0; i < len; i++) {
                char c = (char)dtmp[i];
                if (c == '\n' || c == '\r') {
                    if (!line_buffer.empty()) {
                        handle_incoming_command(line_buffer.c_str(), line_buffer.length());
                        line_buffer.clear();
                        lines_processed++;
                        // Yield every 4 commands during bursts to prevent starving IDLE0 / CAN RX
                        if (lines_processed % 4 == 0) {
                            vTaskDelay(pdMS_TO_TICKS(1));
                        }
                    }
                } else if ((uint8_t)c >= 0x20 && (uint8_t)c <= 0x7E) {
                    // Filter out boot ROM / electrical glitch garbage bytes
                    if (line_buffer.length() < 4096) {
                        line_buffer += c;
                    } else {
                        line_buffer.clear();
                    }
                } else {
                    // Non-printable noise byte: reset partial corrupt line
                    line_buffer.clear();
                }
            }
        }

        // 4. Periodic heartbeat (every 4 seconds)
        int64_t now_us = esp_timer_get_time();
        if (now_us - last_heartbeat_us >= 4000000) {
            last_heartbeat_us = now_us;
            uart_bridge_send_raw("{\"type\":\"ping\"}");
        }
    }

    free(dtmp);
    vTaskDelete(NULL);
}

void uart_bridge_init(void) {
    s_uart_tx_queue = xQueueCreate(TX_QUEUE_DEPTH, sizeof(UartTxMsg));

    // Detach GPIO 20/21 from any default UART0 console routing before binding UART1
    gpio_reset_pin(UART_BRIDGE_TX_PIN);
    gpio_reset_pin(UART_BRIDGE_RX_PIN);
    gpio_set_pull_mode(UART_BRIDGE_RX_PIN, GPIO_PULLUP_ONLY);

    uart_config_t uart_config = {};
    uart_config.baud_rate = UART_BRIDGE_BAUD_RATE;
    uart_config.data_bits = UART_DATA_8_BITS;
    uart_config.parity    = UART_PARITY_DISABLE;
    uart_config.stop_bits = UART_STOP_BITS_1;
    uart_config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    uart_config.rx_flow_ctrl_thresh = 0;
    uart_config.source_clk = UART_SCLK_DEFAULT;

    // Place UART1 ISR in IRAM if supported
    int intr_alloc_flags = 0;
#if defined(CONFIG_UART_ISR_IN_IRAM)
    intr_alloc_flags = ESP_INTR_FLAG_IRAM;
#endif

    ESP_ERROR_CHECK(uart_driver_install(UART_BRIDGE_PORT, RX_BUF_SIZE, TX_BUF_SIZE, 0, NULL, intr_alloc_flags));
    ESP_ERROR_CHECK(uart_param_config(UART_BRIDGE_PORT, &uart_config));
    ESP_ERROR_CHECK(uart_set_pin(UART_BRIDGE_PORT, UART_BRIDGE_TX_PIN, UART_BRIDGE_RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

    // Priority 3 (below CAN RX/TX at Priority 5) so UART parsing never preempts CAN frame processing
    xTaskCreate(uart_bridge_worker_task, "UART_BRIDGE_WK", 6144, NULL, 3, NULL);
    ESP_LOGI(TAG, "UART Bridge initialized on port %d (TX: GPIO%d, RX: GPIO%d @ %d baud)", 
             UART_BRIDGE_PORT, UART_BRIDGE_TX_PIN, UART_BRIDGE_RX_PIN, UART_BRIDGE_BAUD_RATE);
}
