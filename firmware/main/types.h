#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <array>

enum class ConditionLogic {
    LEAF,
    AND_GROUP,
    OR_GROUP,
    NOT_GROUP
};

enum class ConditionOperator {
    EQUAL,
    NOT_EQUAL,
    LESS_THAN,
    GREATER_THAN
};

struct AutomationCondition;
struct ActionStep;

struct AutomationCondition {
    ConditionLogic logic = ConditionLogic::LEAF;
    std::string type = "can_state"; // "can_state", "time_condition", or "triggered_by"

    // Trigger ID evaluation field (for type == "triggered_by")
    std::string trigger_id;

    // Leaf CAN evaluation fields
    uint32_t can_id = 0;
    uint8_t bus = 0;
    uint8_t byte_index = 0; // 0..7 (from D1..D8)
    uint8_t byte_mask = 0xFF; // Bitmask (e.g. 0xF0, 0xFF)
    ConditionOperator op = ConditionOperator::EQUAL;
    uint8_t target_value = 0;

    // Time window evaluation fields (minutes from midnight 0..1439, bitmask 1 << tm_wday)
    uint16_t start_time_min = 0;
    uint16_t end_time_min = 1439;
    uint8_t weekdays_mask = 0x7F; // Default all 7 days (bits 0..6: Sun..Sat)

    // ESP32 Device / Wi-Fi evaluation fields
    std::string device_property; // "wifi_ssid", "wifi_connected", "wifi_mode", "wifi_rssi", "ap_client_connected", "ap_client_rssi"
    std::string target_string;   // SSID, mode ("ap", "sta", "both", "disabled"), or client MAC ("AA:BB:CC:DD:EE:FF")
    int8_t target_rssi = 0;      // Target RSSI in dBm
    bool target_bool = true;     // Boolean expectation

    // Nested sub-conditions for AND, OR, NOT groups
    std::vector<AutomationCondition> sub_conditions;
};

enum class ActionType {
    TRANSMIT_FRAME,
    ENTITY_COMMAND,
    DELAY,
    IF_THEN,
    CHOOSE,
    TRACK_POPUP,
    CALL_POPUP,
    CLIMATE_TARGET,
    PRECONDITION,
    HUD_NAV
};

struct ChoiceBranch {
    std::vector<AutomationCondition> conditions;
    std::vector<ActionStep> sequence;
};

struct ActionStep {
    ActionType type = ActionType::TRANSMIT_FRAME;
    uint32_t can_id = 0;
    uint8_t bus = 0;
    uint8_t payload[8] = {0};
    uint8_t mask = 0;
    uint8_t repeat = 1;
    uint32_t delay_ms = 0;
    std::string entity_id;
    std::string command;
    std::string popup_message;
    std::string popup_level = "info"; // "info", "warning", "error"
    std::string popup_text;
    std::string caller = "Home Assistant";
    uint32_t hold_ms = 5000;

    // For CLIMATE_TARGET
    float target_temp_c = 21.0f;
    uint32_t duration_minutes = 10;
    std::string zone = "driver";
    bool sync_on = false;
    bool driver_only = false;

    // For PRECONDITION
    std::string precon_mode = "persistent";
    std::string precon_action = "start";

    // For HUD_NAV
    uint8_t nav_icon = 0;
    uint16_t nav_distance_meters = 0;
    uint8_t nav_bars = 0;
    uint8_t nav_speed_limit = 0;
    bool nav_camera_alert = false;
    std::string nav_street;
    std::string nav_action;

    // For IF_THEN
    std::vector<AutomationCondition> if_conditions;
    std::vector<ActionStep> then_steps;
    std::vector<ActionStep> else_steps;

    // For CHOOSE
    std::vector<ChoiceBranch> choices;
    std::vector<ActionStep> default_steps;
};

struct EntityOption {
    std::string label;
    std::string requires_feature;
    bool is_default = false;
    uint8_t match_payload[8] = {0};
    uint8_t match_mask = 0;
    uint8_t invert_mask = 0; // Bit set if comparison is inverted ('!0x..')
    uint8_t byte_masks[8] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
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

struct AutomationTrigger {
    std::string id;
    std::string type = "can_rx"; // "can_rx", "byte_transition", "mqtt", or "time_schedule"
    uint32_t can_id = 0;
    uint8_t bus = 0;
    int byte_index = -1;
    uint8_t byte_mask = 0xFF; // Bitmask for specific byte/nibble (e.g. 0xF0)
    bool has_from_value = false;
    uint8_t from_value = 0;
    uint8_t to_value = 0;
    uint8_t match_payload[8] = {0};
    uint8_t match_mask = 0;
    uint8_t byte_masks[8] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

    // For time_schedule
    uint16_t schedule_time_min = 0; // minutes from midnight (0..1439)
    uint8_t weekdays_mask = 0x7F;   // bitmask (bits 0..6: Sun..Sat)

    // For ESP32 Device / Wi-Fi events
    std::string wifi_event;         // "wifi_connected", "wifi_disconnected", "ap_client_connected", "ap_client_disconnected", "ap_client_rssi"
    std::string ssid;               // Optional SSID filter
    std::string client_mac;         // Optional client MAC filter
    int8_t target_rssi = 0;         // Optional RSSI threshold
};

struct AutomationRule {
    std::string id;
    std::string name;
    bool enabled = true;
    bool ha_expose = true;
    std::string ha_icon = "mdi:car-cog";
    uint32_t cooldown_ms = 0;
    std::string exec_mode = "one_shot"; // "one_shot", "toggle", "continuous_hold", etc.
    std::string trigger_mode = "any";   // "any", "all", "sequence"
    uint32_t last_exec_time_ms = 0;
    std::vector<AutomationTrigger> triggers;
    std::vector<AutomationCondition> conditions;
    std::vector<ActionStep> actions;
};

struct CanBurstCmd {
    uint32_t can_id = 0;
    uint32_t delay_ms = 20;
    std::string trigger_id;
    const std::vector<ActionStep>* steps = nullptr;
    std::vector<ActionStep> inline_steps;
};
