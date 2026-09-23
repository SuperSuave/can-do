#include "can_engine.h"
#include "parser.h"
#include "api.h"
#include "gvret_server.h"
#include <cstring>
#include <ctime>
#include <cmath>
#include <sys/time.h>
#include "esp_log.h"
#include "mqtt_client.h"
#include "esp_timer.h"
#include "track_popup.h"
#include "precondition.h"
#include "board_pins.h"
#include "can.h"
#include "mqtt_mgr.h"
#include "ble_mgr.h"
#include "uds_engine.h"

#if defined(_WIN32) && !defined(__GNUC__)
#define strcasecmp _stricmp
#endif

extern "C" esp_err_t can_send(can_bus_t bus, twai_message_t *message, TickType_t ticks_to_wait) {
    (void)bus;
    return twai_transmit(message, ticks_to_wait);
}

static const char* TAG = "CAN_ENGINE";

std::unordered_map<uint32_t, std::array<uint8_t, 8>> can_state_cache;
QueueHandle_t tx_command_queue = nullptr;
extern esp_mqtt_client_handle_t global_mqtt_client;

std::atomic<bool> g_automations_enabled{true};
std::atomic<bool> g_sniffer_mode{false};
std::atomic<bool> g_hardware_listen_only{false};
std::atomic<bool> g_twai_reconfig_pending{false};
std::atomic<twai_mode_t> g_twai_requested_mode{TWAI_MODE_NORMAL};

void set_automations_enabled(bool enabled) {
    g_automations_enabled.store(enabled);
    ESP_LOGI(TAG, "Automations execution: %s", enabled ? "ENABLED" : "DISABLED");
}

void set_sniffer_mode(bool enabled, bool hardware_listen_only) {
    g_sniffer_mode.store(enabled);
    g_hardware_listen_only.store(hardware_listen_only);

    twai_mode_t target_mode = (enabled && hardware_listen_only) ? TWAI_MODE_LISTEN_ONLY : TWAI_MODE_NORMAL;
    if (target_mode != g_twai_requested_mode.load()) {
        g_twai_requested_mode.store(target_mode);
        g_twai_reconfig_pending.store(true);
        ESP_LOGI(TAG, "Requesting TWAI mode switch to: %s",
                 target_mode == TWAI_MODE_LISTEN_ONLY ? "LISTEN_ONLY (No PHY ACK)" : "NORMAL (PHY ACK)");
    }
    ESP_LOGI(TAG, "Sniffer mode: %s (HW listen-only=%d)", enabled ? "ACTIVE" : "OFF", hardware_listen_only ? 1 : 0);
}

static std::mutex s_cache_mutex;

bool get_cached_can_frame(uint32_t can_id, uint8_t out_data[8]) {
    std::lock_guard<std::mutex> lock(s_cache_mutex);
    auto it = can_state_cache.find(can_id);
    bool found = (it != can_state_cache.end());
    if (found && out_data) {
        memcpy(out_data, it->second.data(), 8);
    }
    return found;
}

bool can_state_cache_get(uint32_t can_id, uint8_t byte_index, uint32_t* out_val) {
    uint8_t data[8];
    if (get_cached_can_frame(can_id, data) && byte_index < 8) {
        if (out_val) *out_val = data[byte_index];
        return true;
    }
    return false;
}

void init_can_engine(void) {
    if (!tx_command_queue) {
        tx_command_queue = xQueueCreate(16, sizeof(CanBurstCmd*));
    }
}

void update_state_cache(uint32_t can_id, const uint8_t* data) {
    std::array<uint8_t, 8> payload;
    memcpy(payload.data(), data, 8);
    std::lock_guard<std::mutex> lock(s_cache_mutex);
    can_state_cache[can_id] = payload;
}

bool evaluate_condition(const AutomationCondition& cond) {
    switch (cond.logic) {
        case ConditionLogic::AND_GROUP: {
            for (const auto& sub : cond.sub_conditions) {
                if (!evaluate_condition(sub)) return false;
            }
            return true;
        }
        case ConditionLogic::OR_GROUP: {
            if (cond.sub_conditions.empty()) return false;
            for (const auto& sub : cond.sub_conditions) {
                if (evaluate_condition(sub)) return true;
            }
            return false;
        }
        case ConditionLogic::NOT_GROUP: {
            if (cond.sub_conditions.empty()) return true;
            for (const auto& sub : cond.sub_conditions) {
                if (evaluate_condition(sub)) return false;
            }
            return true;
        }
        case ConditionLogic::LEAF:
        default: {
            if (cond.type == "time_condition") {
                time_t now;
                time(&now);
                struct tm timeinfo;
                localtime_r(&now, &timeinfo);

                // Check day of week (bit 0=Sun .. bit 6=Sat)
                if ((cond.weekdays_mask & (1 << timeinfo.tm_wday)) == 0) {
                    return false;
                }

                uint16_t cur_min = static_cast<uint16_t>(timeinfo.tm_hour * 60 + timeinfo.tm_min);

                // Normal daytime window (e.g. 08:00 to 18:00)
                if (cond.start_time_min <= cond.end_time_min) {
                    return cur_min >= cond.start_time_min && cur_min <= cond.end_time_min;
                } else {
                    // Overnight window spanning midnight (e.g. 22:00 to 06:00)
                    return cur_min >= cond.start_time_min || cur_min <= cond.end_time_min;
                }
            }

            auto it = can_state_cache.find(cond.can_id);
            if (it == can_state_cache.end()) return false;

            if (cond.byte_index >= 8) return false;
            uint8_t actual = it->second[cond.byte_index];
            uint8_t mask = cond.byte_mask;

            uint8_t masked_actual = actual & mask;
            uint8_t masked_target = cond.target_value & mask;

            switch (cond.op) {
                case ConditionOperator::EQUAL:        return masked_actual == masked_target;
                case ConditionOperator::NOT_EQUAL:    return masked_actual != masked_target;
                case ConditionOperator::LESS_THAN:    return masked_actual < masked_target;
                case ConditionOperator::GREATER_THAN: return masked_actual > masked_target;
                default: return false;
            }
        }
    }
}

bool is_match(const uint8_t* incoming_data, const EntityOption& option) {
    if (option.match_mask == 0) return false;
    for (int i = 0; i < 8; i++) {
        if ((option.match_mask & (1 << i)) != 0) {
            bool inverted = (option.invert_mask & (1 << i)) != 0;
            uint8_t mask = option.byte_masks[i];
            uint8_t actual = incoming_data[i] & mask;
            uint8_t target = option.match_payload[i] & mask;
            if (inverted) {
                if (actual == target) return false;
            } else {
                if (actual != target) return false;
            }
        }
    }
    return true;
}

static inline bool evaluate_masked_byte(uint8_t actual_value, uint8_t target_value, uint8_t mask) {
    // If mask is 0xF0:
    // actual: 0x13 (0001 0011) & mask: 0xF0 (1111 0000) = 0x10 (0001 0000)
    // target: 0x10 (0001 0000) & mask: 0xF0 (1111 0000) = 0x10 (0001 0000)
    // They match, ignoring the changing lower nibble!
    return (actual_value & mask) == (target_value & mask);
}

static bool is_trigger_match(const uint8_t* incoming_data, const uint8_t* previous_data, const AutomationTrigger& trig) {
    if (trig.type == "byte_transition" && trig.byte_index >= 0 && trig.byte_index < 8) {
        if (!previous_data) return false;
        bool is_to = evaluate_masked_byte(incoming_data[trig.byte_index], trig.to_value, trig.byte_mask);
        if (trig.has_from_value) {
            bool was_from = evaluate_masked_byte(previous_data[trig.byte_index], trig.from_value, trig.byte_mask);
            return was_from && is_to && ((previous_data[trig.byte_index] & trig.byte_mask) != (incoming_data[trig.byte_index] & trig.byte_mask));
        } else {
            bool was_to = evaluate_masked_byte(previous_data[trig.byte_index], trig.to_value, trig.byte_mask);
            return !was_to && is_to;
        }
    }

    if (trig.match_mask == 0) return true; // match whole ID if no byte mask
    for (int i = 0; i < 8; i++) {
        if ((trig.match_mask & (1 << i)) != 0) {
            uint8_t mask = trig.byte_masks[i];
            if ((incoming_data[i] & mask) != (trig.match_payload[i] & mask)) return false;
        }
    }
    return true;
}

void execute_can_burst(uint32_t can_id, const std::vector<ActionStep>& steps, uint32_t delay_ms) {
    twai_message_t tx_msg = {};
    tx_msg.extd = 0;
    tx_msg.data_length_code = 8;

    for (const auto& step : steps) {
        if (step.type == ActionType::DELAY) {
            vTaskDelay(pdMS_TO_TICKS(step.delay_ms));
            continue;
        }

        if (step.type == ActionType::ENTITY_COMMAND) {
            bool executed_inline = false;
            for (const auto& entity : global_catalog) {
                if (entity.id == step.entity_id) {
                    for (const auto& option : entity.options) {
                        if (option.label == step.command || (entity.options.size() == 1 && step.command.empty())) {
                            execute_can_burst(entity.action_can_id, option.steps, entity.delay_ms);
                            executed_inline = true;
                            break;
                        }
                    }
                    break;
                }
            }
            if (!executed_inline) {
                ESP_LOGW(TAG, "Entity '%s' command '%s' not found for inline execution",
                         step.entity_id.c_str(), step.command.c_str());
            }
            continue;
        }

        if (step.type == ActionType::TRACK_POPUP) {
            const std::string& txt = !step.popup_text.empty() ? step.popup_text : step.popup_message;
            if (!txt.empty()) {
                if (step.popup_level == "warning") {
                    track_popup_show_warning(txt.c_str());
                } else if (step.popup_level == "error") {
                    track_popup_show_error(txt.c_str());
                } else {
                    track_popup_show_info(txt.c_str());
                }
            }
            continue;
        }

        if (step.type == ActionType::PRECONDITION) {
            precondition_execute_action(step.precon_mode.c_str(), step.precon_action.c_str());
            continue;
        }

        if (step.type == ActionType::IF_THEN) {
            bool passed = true;
            for (const auto& c : step.if_conditions) {
                if (!evaluate_condition(c)) {
                    passed = false;
                    break;
                }
            }
            if (passed) {
                execute_can_burst(can_id, step.then_steps, delay_ms);
            } else {
                execute_can_burst(can_id, step.else_steps, delay_ms);
            }
            continue;
        }

        if (step.type == ActionType::CHOOSE) {
            bool matched = false;
            for (const auto& choice : step.choices) {
                bool branch_passed = true;
                for (const auto& c : choice.conditions) {
                    if (!evaluate_condition(c)) {
                        branch_passed = false;
                        break;
                    }
                }
                if (branch_passed) {
                    execute_can_burst(can_id, choice.sequence, delay_ms);
                    matched = true;
                    break;
                }
            }
            if (!matched && !step.default_steps.empty()) {
                execute_can_burst(can_id, step.default_steps, delay_ms);
            }
            continue;
        }

        tx_msg.identifier = step.can_id ? step.can_id : can_id;
        memset(tx_msg.data, 0, 8);

        for (int i = 0; i < 8; i++) {
            if (step.mask & (1 << i)) {
                tx_msg.data[i] = step.payload[i];
            }
        }

        for (int r = 0; r < step.repeat; r++) {
            twai_message_t msg_to_send = tx_msg;
            fwd_result_t fwd_res = precondition_fwd_hook(&msg_to_send, CAN_BUS_0);
            if (fwd_res == FWD_BLOCK) {
                continue;
            }
            fwd_res = track_popup_fwd(&msg_to_send, CAN_BUS_0);
            if (fwd_res == FWD_BLOCK) {
                continue;
            }
            if (g_sniffer_mode.load()) {
                ESP_LOGD(TAG, "Sniffer mode active: suppressed TX ID 0x%03lX", (unsigned long)msg_to_send.identifier);
                continue;
            }
            if (twai_transmit(&msg_to_send, pdMS_TO_TICKS(10)) == ESP_OK) {
                board_led_can_activity();
                if (delay_ms > 0) {
                    vTaskDelay(pdMS_TO_TICKS(delay_ms));
                }
            } else {
                ESP_LOGW(TAG, "TWAI TX failed or queue full for ID 0x%03lX", (unsigned long)tx_msg.identifier);
            }
        }
    }
}

bool queue_entity_command(const std::string& entity_id, const std::string& command_label) {
    for (const auto& entity : global_catalog) {
        if (entity.id == entity_id) {
            for (const auto& option : entity.options) {
                std::string opt_lower = option.label;
                std::transform(opt_lower.begin(), opt_lower.end(), opt_lower.begin(), ::tolower);
                std::string cmd_lower = command_label;
                std::transform(cmd_lower.begin(), cmd_lower.end(), cmd_lower.begin(), ::tolower);

                if (opt_lower == cmd_lower || opt_lower.find(cmd_lower) != std::string::npos || cmd_lower.find(opt_lower) != std::string::npos || (entity.options.size() == 1 && command_label.empty())) {
                    CanBurstCmd* cmd = new CanBurstCmd();
                    cmd->can_id = entity.action_can_id;
                    cmd->delay_ms = entity.delay_ms;
                    cmd->steps = &option.steps;
                    if (xQueueSend(tx_command_queue, &cmd, pdMS_TO_TICKS(10)) != pdTRUE) {
                        delete cmd;
                        return false;
                    }
                    return true;
                }
            }
            // Fallback: if no exact option matched, try first option
            if (!entity.options.empty()) {
                CanBurstCmd* cmd = new CanBurstCmd();
                cmd->can_id = entity.action_can_id;
                cmd->delay_ms = entity.delay_ms;
                cmd->steps = &entity.options[0].steps;
                if (xQueueSend(tx_command_queue, &cmd, pdMS_TO_TICKS(10)) == pdTRUE) {
                    return true;
                }
                delete cmd;
            }
            ESP_LOGW(TAG, "Option '%s' not found for entity '%s'", command_label.c_str(), entity_id.c_str());
            return false;
        }
    }
    ESP_LOGW(TAG, "Entity '%s' not found in catalog", entity_id.c_str());
    return false;
}

bool queue_action_steps(uint32_t can_id, uint32_t delay_ms, const std::vector<ActionStep>& steps) {
    CanBurstCmd* cmd = new CanBurstCmd();
    cmd->can_id = can_id;
    cmd->delay_ms = delay_ms;
    cmd->inline_steps = steps;
    if (xQueueSend(tx_command_queue, &cmd, pdMS_TO_TICKS(10)) != pdTRUE) {
        delete cmd;
        return false;
    }
    return true;
}

void can_rx_task(void* arg) {
    twai_message_t rx_msg;
    ESP_LOGI(TAG, "CAN RX task running");

    while (true) {
        if (g_twai_reconfig_pending.load()) {
            twai_mode_t new_mode = g_twai_requested_mode.load();
            ESP_LOGI(TAG, "Reconfiguring TWAI peripheral to mode %d...", (int)new_mode);

            // Flush TX queue first to prevent uninstaller hanging on pending semaphores
            twai_clear_transmit_queue();
            twai_stop();
            twai_driver_uninstall();

            twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, new_mode);
            g_config.rx_queue_len = 64;
            g_config.tx_queue_len = 32;
            g_config.alerts_enabled = TWAI_ALERT_BUS_OFF | TWAI_ALERT_BUS_RECOVERED | TWAI_ALERT_ERR_PASS | TWAI_ALERT_BUS_ERROR | TWAI_ALERT_RX_QUEUE_FULL;
            twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
            twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

            esp_err_t ret = twai_driver_install(&g_config, &t_config, &f_config);
            if (ret == ESP_OK) {
                twai_start();
                ESP_LOGI(TAG, "TWAI reconfigured to %s",
                         new_mode == TWAI_MODE_LISTEN_ONLY ? "LISTEN_ONLY" : "NORMAL");
            } else {
                ESP_LOGE(TAG, "Failed reinstalling TWAI driver (%s)", esp_err_to_name(ret));
            }
            g_twai_reconfig_pending.store(false);
        }

        // Auto-recover TWAI peripheral if in BUS_OFF or STOPPED state
        twai_status_info_t twai_status;
        if (twai_get_status_info(&twai_status) == ESP_OK) {
            if (twai_status.state == TWAI_STATE_BUS_OFF) {
                ESP_LOGW(TAG, "TWAI controller in BUS_OFF! Initiating auto-recovery...");
                twai_initiate_recovery();
            } else if (twai_status.state == TWAI_STATE_STOPPED) {
                ESP_LOGI(TAG, "TWAI recovered from bus-off. Restarting controller...");
                twai_start();
            }
        }

        if (twai_receive(&rx_msg, pdMS_TO_TICKS(10)) == ESP_OK) {
            board_led_can_activity();
            precondition_can_rx_hook(&rx_msg, CAN_BUS_0);
            track_popup_rx(&rx_msg, CAN_BUS_0);
            uds_engine_on_can_rx(&rx_msg);

            // Stream raw frame to connected SavvyCAN/GVRET client
            gvret_enqueue_frame(&rx_msg);

            // Stream raw CAN frame to WebSocket dashboard ONLY if sniffer mode is actively enabled
            if (g_sniffer_mode.load()) {
                static uint32_t s_last_ws_sniffer_ms = 0;
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                // Throttle sniffer WebSocket updates to max ~30Hz (33ms) to prevent Wi-Fi buffer exhaustion
                if (now_ms - s_last_ws_sniffer_ms >= 33) {
                    s_last_ws_sniffer_ms = now_ms;
                    broadcast_ws_can_frame(&rx_msg);
                }
            }

            if (rx_msg.rtr) continue;

            uint8_t prev_data[8] = {0};
            bool has_prev = false;
            auto it = can_state_cache.find(rx_msg.identifier);
            if (it != can_state_cache.end()) {
                memcpy(prev_data, it->second.data(), 8);
                has_prev = true;
            }

            // 1. Always update state cache
            update_state_cache(rx_msg.identifier, rx_msg.data);

            // Helper: Mask out rolling counter and checksum bytes during MQTT change detection
            auto get_can_comparison_mask = [](uint32_t can_id, uint8_t mask_out[8]) {
                memset(mask_out, 0xFF, 8);
                switch (can_id) {
                    // Hyundai/Kia/Genesis E-GMP & Gen5W frames with alive counter and/or CRC in Byte 7:
                    case 0x0A2: // Wheel speeds
                    case 0x130: // Steering angle
                    case 0x152: // BMS Battery telemetry
                    case 0x1AC: // Cluster speed and info
                    case 0x226: // Shifter / Gear status
                    case 0x2AD: // Throttle & brake pedal
                    case 0x380: // Climate cabin temperatures
                    case 0x31B: // Climate blower fan & airflow
                    case 0x476: // Center console & camera switch panel
                    case 0x448: // Steering wheel media & cruise controls
                    case 0x4CE: // Head unit media & cluster popup
                        mask_out[7] = 0x00;
                        break;
                    default:
                        break;
                }
            };

            auto has_masked_can_data_changed = [&](uint32_t can_id, const uint8_t* prev, const uint8_t* curr, size_t len) -> bool {
                if (!prev) return true;
                uint8_t mask[8];
                get_can_comparison_mask(can_id, mask);
                for (size_t i = 0; i < len && i < 8; i++) {
                    if ((prev[i] & mask[i]) != (curr[i] & mask[i])) {
                        return true;
                    }
                }
                return false;
            };

            // Publish state change to MQTT if this CAN ID is monitored and actual payload data changed
            if (mqtt_mgr_is_monitored_id(rx_msg.identifier)) {
                if (!has_prev || has_masked_can_data_changed(rx_msg.identifier, prev_data, rx_msg.data, rx_msg.data_length_code)) {
                    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                    static std::unordered_map<uint32_t, uint32_t> s_last_mqtt_pub_ms;
                    auto pit = s_last_mqtt_pub_ms.find(rx_msg.identifier);
                    bool throttle = false;
                    // For continuous high-frequency telemetry (speed 0x1AC, wheels 0x0A2), throttle to max 10Hz (100ms)
                    if (rx_msg.identifier == 0x1AC || rx_msg.identifier == 0x0A2) {
                        if (pit != s_last_mqtt_pub_ms.end() && (now_ms - pit->second < 100)) {
                            throttle = true;
                        }
                    }
                    if (!throttle) {
                        s_last_mqtt_pub_ms[rx_msg.identifier] = now_ms;
                        mqtt_mgr_publish_can_state(rx_msg.identifier, rx_msg.data, rx_msg.data_length_code);
                    }
                }
            }

            // 2. Evaluate automations if globally enabled
            if (g_automations_enabled.load()) {
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                for (auto& rule : global_automations) {
                    if (!rule.enabled) continue;

                    for (const auto& trig : rule.triggers) {
                        if ((trig.type == "can_rx" || trig.type == "byte_transition") && trig.can_id == rx_msg.identifier) {
                            if (is_trigger_match(rx_msg.data, has_prev ? prev_data : nullptr, trig)) {
                                // Check cooldown
                                if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
                                    continue;
                                }

                                // Check conditions
                                bool passed = true;
                                for (const auto& cond : rule.conditions) {
                                    if (!evaluate_condition(cond)) {
                                        passed = false;
                                        break;
                                    }
                                }

                                if (passed) {
                                    ESP_LOGI(TAG, "Automation fired: %s", rule.name.c_str());
                                    rule.last_exec_time_ms = now_ms;
                                    broadcast_ws_automation_event(rule.id, rule.name);
                                    queue_action_steps(0, 20, rule.actions);
                                }
                            }
                        }
                    }
                }
            }

            // 3. Match against catalog entities for state updates (O(1) indexed lookup)
            auto cat_it = catalog_by_can_id.find(rx_msg.identifier);
            if (cat_it != catalog_by_can_id.end()) {
                for (auto* entity_ptr : cat_it->second) {
                    if (!entity_ptr) continue;
                    auto& entity = *entity_ptr;
                    for (const auto& opt : entity.options) {
                        if (is_match(rx_msg.data, opt)) {
                            if (entity.current_state != opt.label) {
                                entity.current_state = opt.label;
                                ESP_LOGI(TAG, "State change: %s -> %s", entity.id.c_str(), opt.label.c_str());

                                // MQTT Publish
                                if (global_mqtt_client) {
                                    std::string topic = "cando/state/" + entity.id;
                                    esp_mqtt_client_publish(global_mqtt_client, topic.c_str(), opt.label.c_str(), 0, 1, 1);
                                }

                                // WebSocket Broadcast
                                broadcast_ws_state(entity.id, opt.label);
                            }
                            break;
                        }
                    }
                }
            }
        }
        precondition_tick();
        track_popup_tick();
    }
}

void can_engine_trigger_ble_event(const BleButtonEvent& event) {
    if (!g_automations_enabled.load()) return;

    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    for (auto& rule : global_automations) {
        if (!rule.enabled) continue;

        for (const auto& trig : rule.triggers) {
            if (trig.type == "ble_button" || trig.type == "ble_key") {
                bool button_match = false;
                if (trig.ble_button.empty() || strcasecmp(trig.ble_button.c_str(), event.button_name.c_str()) == 0) {
                    button_match = true;
                }

                bool action_match = false;
                if (trig.ble_action.empty() || trig.ble_action == "any" || strcasecmp(trig.ble_action.c_str(), event.action.c_str()) == 0) {
                    action_match = true;
                }

                bool device_match = true;
                if (!trig.ble_device.empty()) {
                    if (strcasecmp(trig.ble_device.c_str(), event.device_address.c_str()) != 0 &&
                        strcasecmp(trig.ble_device.c_str(), event.device_name.c_str()) != 0) {
                        device_match = false;
                    }
                }

                if (button_match && action_match && device_match) {
                    // Check cooldown
                    if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
                        continue;
                    }

                    // Check conditions
                    bool passed = true;
                    for (const auto& cond : rule.conditions) {
                        if (!evaluate_condition(cond)) {
                            passed = false;
                            break;
                        }
                    }

                    if (passed) {
                        ESP_LOGI(TAG, "BLE Automation fired: '%s' by button '%s' (%s)",
                                 rule.name.c_str(), event.button_name.c_str(), event.action.c_str());
                        rule.last_exec_time_ms = now_ms;
                        broadcast_ws_automation_event(rule.id, rule.name);
                        queue_action_steps(0, 20, rule.actions);
                    }
                }
            }
        }
    }
}

void can_tx_task(void* arg) {
    CanBurstCmd* cmd = nullptr;
    ESP_LOGI(TAG, "CAN TX task running");

    while (true) {
        if (xQueueReceive(tx_command_queue, &cmd, portMAX_DELAY) == pdTRUE && cmd) {
            if (cmd->steps && !cmd->steps->empty()) {
                execute_can_burst(cmd->can_id, *cmd->steps, cmd->delay_ms);
            } else if (!cmd->inline_steps.empty()) {
                execute_can_burst(cmd->can_id, cmd->inline_steps, cmd->delay_ms);
            }
            delete cmd;
        }
    }
}

void time_scheduler_task(void* arg) {
    ESP_LOGI(TAG, "Time scheduler task running");
    int last_checked_min = -1;

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));

        time_t now;
        time(&now);
        struct tm timeinfo;
        localtime_r(&now, &timeinfo);

        // Wait until clock has synchronized (year 2024 or later)
        if (timeinfo.tm_year < (2024 - 1900)) {
            continue;
        }

        int cur_min = timeinfo.tm_hour * 60 + timeinfo.tm_min;
        if (cur_min == last_checked_min) {
            continue;
        }
        last_checked_min = cur_min;

        int cur_wday = timeinfo.tm_wday; // 0=Sun .. 6=Sat

        if (!g_automations_enabled.load()) {
            continue;
        }

        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
        for (auto& rule : global_automations) {
            if (!rule.enabled) continue;

            for (const auto& trig : rule.triggers) {
                if (trig.type == "time_schedule") {
                    if (trig.schedule_time_min == cur_min && (trig.weekdays_mask & (1 << cur_wday))) {
                        if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
                            continue;
                        }

                        bool passed = true;
                        for (const auto& cond : rule.conditions) {
                            if (!evaluate_condition(cond)) {
                                passed = false;
                                break;
                            }
                        }

                        if (passed) {
                            ESP_LOGI(TAG, "Time schedule fired rule: %s (%02d:%02d)", rule.name.c_str(), timeinfo.tm_hour, timeinfo.tm_min);
                            rule.last_exec_time_ms = now_ms;
                            broadcast_ws_automation_event(rule.id, rule.name);
                            queue_action_steps(0, 20, rule.actions);
                        }
                    }
                }
            }
        }
    }
}

