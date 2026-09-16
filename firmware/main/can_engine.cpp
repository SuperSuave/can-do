#include "can_engine.h"
#include "parser.h"
#include "api.h"
#include <cstring>
#include "esp_log.h"
#include "mqtt_client.h"

static const char* TAG = "CAN_ENGINE";

std::unordered_map<uint32_t, std::array<uint8_t, 8>> can_state_cache;
QueueHandle_t tx_command_queue = nullptr;
extern esp_mqtt_client_handle_t global_mqtt_client;

void init_can_engine(void) {
    if (!tx_command_queue) {
        tx_command_queue = xQueueCreate(16, sizeof(CanBurstCmd));
    }
}

void update_state_cache(uint32_t can_id, const uint8_t* data) {
    std::array<uint8_t, 8> payload;
    memcpy(payload.data(), data, 8);
    can_state_cache[can_id] = payload;
}

bool evaluate_condition(const AutomationCondition& cond) {
    auto it = can_state_cache.find(cond.can_id);
    if (it == can_state_cache.end()) return false;

    if (cond.byte_index >= 8) return false;
    uint8_t actual = it->second[cond.byte_index];

    switch (cond.op) {
        case ConditionOperator::EQUAL:        return actual == cond.target_value;
        case ConditionOperator::NOT_EQUAL:    return actual != cond.target_value;
        case ConditionOperator::LESS_THAN:    return actual < cond.target_value;
        case ConditionOperator::GREATER_THAN: return actual > cond.target_value;
        default: return false;
    }
}

bool is_match(const uint8_t* incoming_data, const EntityOption& option) {
    if (option.match_mask == 0) return false;
    for (int i = 0; i < 8; i++) {
        if ((option.match_mask & (1 << i)) != 0) {
            bool inverted = (option.invert_mask & (1 << i)) != 0;
            if (inverted) {
                if (incoming_data[i] == option.match_payload[i]) return false;
            } else {
                if (incoming_data[i] != option.match_payload[i]) return false;
            }
        }
    }
    return true;
}

static bool is_trigger_match(const uint8_t* incoming_data, const AutomationTrigger& trig) {
    if (trig.match_mask == 0) return true; // match whole ID if no byte mask
    for (int i = 0; i < 8; i++) {
        if ((trig.match_mask & (1 << i)) != 0) {
            if (incoming_data[i] != trig.match_payload[i]) return false;
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
            queue_entity_command(step.entity_id, step.command);
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
            if (twai_transmit(&tx_msg, pdMS_TO_TICKS(10)) == ESP_OK) {
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
                    CanBurstCmd cmd;
                    cmd.can_id = entity.action_can_id;
                    cmd.delay_ms = entity.delay_ms;
                    cmd.steps = &option.steps;
                    return xQueueSend(tx_command_queue, &cmd, pdMS_TO_TICKS(10)) == pdTRUE;
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
    CanBurstCmd cmd;
    cmd.can_id = can_id;
    cmd.delay_ms = delay_ms;
    cmd.inline_steps = steps;
    return xQueueSend(tx_command_queue, &cmd, pdMS_TO_TICKS(10)) == pdTRUE;
}

void can_rx_task(void* arg) {
    twai_message_t rx_msg;
    ESP_LOGI(TAG, "CAN RX task running");

    while (true) {
        if (twai_receive(&rx_msg, portMAX_DELAY) == ESP_OK) {
            if (rx_msg.rtr) continue;

            // 1. Always update state cache
            update_state_cache(rx_msg.identifier, rx_msg.data);

            // 2. Evaluate automations
            for (const auto& rule : global_automations) {
                if (!rule.enabled) continue;

                for (const auto& trig : rule.triggers) {
                    if ((trig.type == "can_rx" || trig.type == "byte_transition") && trig.can_id == rx_msg.identifier) {
                        if (is_trigger_match(rx_msg.data, trig)) {
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
                                queue_action_steps(0, 20, rule.actions);
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
    }
}

void can_tx_task(void* arg) {
    CanBurstCmd cmd;
    ESP_LOGI(TAG, "CAN TX task running");

    while (true) {
        if (xQueueReceive(tx_command_queue, &cmd, portMAX_DELAY) == pdTRUE) {
            if (cmd.steps && !cmd.steps->empty()) {
                execute_can_burst(cmd.can_id, *cmd.steps, cmd.delay_ms);
            } else if (!cmd.inline_steps.empty()) {
                execute_can_burst(cmd.can_id, cmd.inline_steps, cmd.delay_ms);
            }
        }
    }
}
