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

bool can_state_cache_get(uint32_t can_id, uint8_t byte_index, uint32_t* out_val) {
    auto it = can_state_cache.find(can_id);
    if (it != can_state_cache.end() && byte_index < 8) {
        if (out_val) *out_val = it->second[byte_index];
        return true;
    }
    return false;
}

#define CLIMATE_CMD_CAN_ID 0x2CF  /* Corrected CAN ID from 0x49F */

void cando_execute_climate_target(float target_c, const char *zone, bool sync_on, bool driver_only)
{
    if (target_c < 14.0f) target_c = 14.0f;
    if (target_c > 32.0f) target_c = 32.0f;

    bool is_passenger = (zone && (strcasecmp(zone, "passenger") == 0 || strcasecmp(zone, "pass") == 0));
    uint8_t target_raw = (uint8_t)((int)roundf((target_c - 14.0f) * 2.0f));

    /* 1. Pull current raw state directly from the RAM state cache (0x380) */
    uint32_t state_val = 0;
    bool has_state = can_state_cache_get(0x380, is_passenger ? 4 : 3, &state_val);
    
    uint8_t cur_raw = 14; /* Default fallback 21.0C */
    if (has_state && state_val > 0 && state_val <= 36) {
        cur_raw = (uint8_t)state_val;
    }

    int delta = (int)target_raw - (int)cur_raw;
    if (delta == 0) {
        ESP_LOGI(TAG, "Cabin temp already at target (raw=%d, target_c=%.1f)", cur_raw, target_c);
        return;
    }

    int steps = (delta > 0) ? delta : -delta;
    if (steps > 28) steps = 28;

    ESP_LOGI(TAG, "Adjusting Temp [%s]: cur=%d -> target=%d, steps=%d",
             is_passenger ? "PASS" : "DRIV", cur_raw, target_raw, steps);

    /* 2. Determine payload structure based on packet capture */
    // Driver Up:   Byte 1 = 0x01, Byte 2 = 0xFF
    // Driver Down: Byte 1 = 0x80, Byte 2 = 0xFF
    // Pass Up:     Byte 1 = 0xFF, Byte 2 = 0x01
    // Pass Down:   Byte 1 = 0xFF, Byte 2 = 0x80
    uint8_t val_b1 = is_passenger ? 0xFF : (delta > 0 ? 0x01 : 0x80);
    uint8_t val_b2 = is_passenger ? (delta > 0 ? 0x01 : 0x80) : 0xFF;

    /* Rolling sequence nibble array: 0x0F -> 0x1F -> 0x2F */
    const uint8_t seq_counters[3] = { 0x0F, 0x1F, 0x2F };

    for (int i = 0; i < steps; i++) {
        /* Cycle through the rolling counter for each step */
        uint8_t counter_val = seq_counters[i % 3];

        /* Send the 3 required repetition frames per step */
        for (int rep = 0; rep < 3; rep++) {
            twai_message_t tx_msg = {};
            tx_msg.identifier = CLIMATE_CMD_CAN_ID;
            tx_msg.extd = 0;
            tx_msg.data_length_code = 8;
            tx_msg.data[0] = counter_val;
            tx_msg.data[1] = val_b1;
            tx_msg.data[2] = val_b2;
            can_send(CAN_BUS_0, &tx_msg, pdMS_TO_TICKS(10));
            vTaskDelay(pdMS_TO_TICKS(20)); // Inter-frame pacing
        }
        
        /* Brief pause between individual steps to let the HVAC ECU process */
        vTaskDelay(pdMS_TO_TICKS(40));
    }

    if (sync_on && !driver_only) {
        twai_message_t sync_msg = {};
        sync_msg.identifier = 0x4A0;
        sync_msg.extd = 0;
        sync_msg.data_length_code = 8;
        sync_msg.data[3] = 0x0B;
        can_send(CAN_BUS_0, &sync_msg, pdMS_TO_TICKS(10));
    }
}

void init_can_engine(void) {
    if (!tx_command_queue) {
        tx_command_queue = xQueueCreate(16, sizeof(CanBurstCmd*));
    }
}

void update_state_cache(uint32_t can_id, const uint8_t* data) {
    std::array<uint8_t, 8> payload;
    memcpy(payload.data(), data, 8);
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

        if (step.type == ActionType::CLIMATE_TARGET) {
            cando_execute_climate_target(step.target_temp_c, step.zone.c_str(), step.sync_on, step.driver_only);
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
                if (option.label == command_label || (entity.options.size() == 1 && command_label.empty())) {
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

        if (twai_receive(&rx_msg, pdMS_TO_TICKS(10)) == ESP_OK) {
            board_led_can_activity();
            precondition_can_rx_hook(&rx_msg, CAN_BUS_0);
            track_popup_rx(&rx_msg, CAN_BUS_0);

            // Stream raw frame to connected SavvyCAN/GVRET client
            gvret_enqueue_frame(&rx_msg);

            // If sniffer mode is enabled, stream live frame to WebSocket dashboard
            if (g_sniffer_mode.load()) {
                broadcast_ws_can_frame(&rx_msg);
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
                                    queue_action_steps(0, 20, rule.actions);
                                }
                            }
                        }
                    }
                }
            }

            // 3. Match against catalog entities for state updates
            for (auto& entity : global_catalog) {
                if (entity.state_can_id == rx_msg.identifier) {
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
                            queue_action_steps(0, 20, rule.actions);
                        }
                    }
                }
            }
        }
    }
}

