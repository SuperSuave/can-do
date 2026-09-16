#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <array>

enum class ActionType {
    TRANSMIT_FRAME,
    ENTITY_COMMAND,
    DELAY
};

struct ActionStep {
    ActionType type = ActionType::TRANSMIT_FRAME;
    uint32_t can_id = 0;
    uint8_t payload[8] = {0};
    uint8_t mask = 0;
    uint8_t repeat = 1;
    uint32_t delay_ms = 0;
    std::string entity_id;
    std::string command;
};

struct EntityOption {
    std::string label;
    std::string requires_feature;
    bool is_default = false;
    uint8_t match_payload[8] = {0};
    uint8_t match_mask = 0;
    uint8_t invert_mask = 0; // Bit set if comparison is inverted ('!0x..')
    std::vector<ActionStep> steps;
};

struct CanEntity {
    std::string id;
    std::string ha_name;
    std::string ha_domain;
    std::string ha_icon;

    uint32_t state_can_id = 0;
    uint32_t action_can_id = 0;
    uint32_t delay_ms = 20;

    std::vector<EntityOption> options;
    std::string current_state = "";
};

enum class ConditionOperator {
    EQUAL,
    NOT_EQUAL,
    LESS_THAN,
    GREATER_THAN
};

struct AutomationCondition {
    uint32_t can_id = 0;
    uint8_t byte_index = 0; // 0..7 (from D1..D8)
    ConditionOperator op = ConditionOperator::EQUAL;
    uint8_t target_value = 0;
};

struct AutomationTrigger {
    std::string type = "can_rx"; // "can_rx" or "mqtt"
    uint32_t can_id = 0;
    uint8_t match_payload[8] = {0};
    uint8_t match_mask = 0;
};

struct AutomationRule {
    std::string id;
    std::string name;
    bool enabled = true;
    std::vector<AutomationTrigger> triggers;
    std::vector<AutomationCondition> conditions;
    std::vector<ActionStep> actions;
};

struct CanBurstCmd {
    uint32_t can_id = 0;
    uint32_t delay_ms = 20;
    const std::vector<ActionStep>* steps = nullptr;
    std::vector<ActionStep> inline_steps;
};
