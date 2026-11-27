#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <array>
#include <memory>
#include <atomic>
#include <mutex>
#include "psram_alloc.h"

constexpr inline uint32_t make_bus_can_key(uint8_t bus, uint32_t can_id) {
    return (static_cast<uint32_t>(bus & 0x07U) << 29) | (can_id & 0x1FFFFFFFU);
}
constexpr inline uint8_t bus_from_can_key(uint32_t key) {
    return static_cast<uint8_t>((key >> 29) & 0x07U);
}
constexpr inline uint32_t can_id_from_key(uint32_t key) {
    return key & 0x1FFFFFFFU;
}

struct SustainedState {
    std::mutex mtx;
    bool active = false;
    uint32_t since_ms = 0;
    bool fired = false;
};

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
    LESS_THAN_OR_EQUAL,
    GREATER_THAN,
    GREATER_THAN_OR_EQUAL
};

struct AutomationCondition;
struct ActionStep;

struct AutomationCondition {
    ConditionLogic logic = ConditionLogic::LEAF;
    std::string type = "can_state"; // "can_state", "time_condition", or "triggered_by"
    std::string source;             // Optional source category ("can", "wifi", "ble", "device", etc.)

    // Trigger ID evaluation field (for type == "triggered_by")
    std::string trigger_id;

    // Leaf CAN evaluation fields
    uint32_t can_id = 0;
    uint8_t bus = 0;
    uint8_t byte_index = 0; // 0..7 (from D1..D8)
    uint8_t byte_mask = 0xFF; // Bitmask (e.g. 0xF0, 0xFF)
    bool has_bus = false;
    ConditionOperator op = ConditionOperator::EQUAL;
    uint8_t target_value = 0;
    float target_float = 0.0f;

    // Time window evaluation fields (minutes from midnight 0..1439, bitmask 1 << tm_wday)
    uint16_t start_time_min = 0;
    uint16_t end_time_min = 1439;
    uint8_t weekdays_mask = 0x7F; // Default all 7 days (bits 0..6: Sun..Sat)

    // ESP32 Device / Wi-Fi evaluation fields
    std::string device_property; // "wifi_ssid", "wifi_connected", "wifi_mode", "wifi_rssi", "ap_client_connected", "ap_client_rssi", "ble_connected", "ble_rssi"
    std::string target_string;   // SSID, mode ("ap", "sta", "both", "disabled"), client MAC ("AA:BB:CC:DD:EE:FF"), or button name
    int8_t target_rssi = 0;      // Target RSSI in dBm
    bool target_bool = true;     // Boolean expectation

    // Bluetooth BLE evaluation fields
    std::string ble_button;      // e.g. "volume_up", "mute+volume_down"
    std::string ble_action;      // "press", "tap", "release", "hold", "hold_1s".."hold_Ns", "any"
    std::string ble_device;      // Optional device address or name filter
    std::string beacon_uuid;     // Optional iBeacon UUID or beacon MAC filter
    uint16_t beacon_major = 0;
    uint16_t beacon_minor = 0;

    // Sustained state duration requirement (0 = immediate)
    uint32_t for_ms = 0;
    std::shared_ptr<SustainedState> sustained;

    // Nested sub-conditions for AND, OR, NOT groups
    PsramVector<AutomationCondition> sub_conditions;
};

enum class ActionType {
    TRANSMIT_FRAME,
    ENTITY_COMMAND,
    DELAY,
    IF_THEN,
    CHOOSE,
    CYCLE_ENTITY,
    TRACK_POPUP,
    CLIMATE_TARGET,
    PRECONDITION,
    HUD_NAV,
    REPEAT_UNTIL,
    WAIT_FOR
};

struct ChoiceBranch {
    PsramVector<AutomationCondition> conditions;
    PsramVector<ActionStep> sequence;
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
    uint32_t hold_ms = 5000;

    // For CLIMATE_TARGET
    float target_temp_c = 21.0f;
    uint32_t duration_minutes = 10;
    bool defrost = false;
    std::string zone = "driver";
    bool sync_on = false;
    bool driver_only = false;
    bool monitor_0x38 = true;

    // For PRECONDITION
    std::string precon_mode = "persistent";
    std::string precon_action = "start";

    // For HUD_NAV
    uint8_t nav_icon = 0;
    uint16_t nav_direction_deg = 0;
    uint16_t nav_distance_meters = 0xFFFF;
    uint8_t nav_bars = 0;
    uint8_t nav_speed_limit = 0;
    bool nav_camera_alert = false;
    std::string nav_street;
    std::string nav_action;
    bool nav_has_lane_guidance = false;
    uint8_t nav_num_lanes = 0;
    uint8_t nav_lane_directions[8] = {0};
    uint8_t nav_lane_recommended[8] = {0};

    // For IF_THEN
    PsramVector<AutomationCondition> if_conditions;
    PsramVector<ActionStep> then_steps;
    PsramVector<ActionStep> else_steps;

    // For CHOOSE / CYCLE_ENTITY
    PsramVector<ChoiceBranch> choices;
    PsramVector<ActionStep> default_steps;
    PsramVector<std::string> cycle_states;
    std::string cycle_direction = "forward"; // "forward", "reverse", "ping_pong"
    bool cycle_wrap = true;
    std::string cycle_fallback_state = "__first__";
    bool cycle_show_popup = true;
    std::string cycle_popup_prefix;
    bool cycle_ping_pong = false;
    std::shared_ptr<std::atomic<int>> ping_pong_dir; // +1 forward, -1 reverse

    // For REPEAT_UNTIL / WAIT_FOR
    uint32_t interval_ms = 1000;
    uint32_t timeout_ms = 30000;
    AutomationCondition condition;
    PsramVector<ActionStep> sequence;
};

struct CatalogStep {
    ActionType type = ActionType::TRANSMIT_FRAME; // TRANSMIT_FRAME, DELAY, or HUD_NAV
    uint32_t can_id = 0;
    uint32_t delay_ms = 0;
    uint8_t bus = 0;
    uint8_t payload[8] = {0};
    uint8_t mask = 0;
    uint8_t repeat = 1;
    uint8_t nav_icon = 0;
};

inline PsramVector<ActionStep> catalog_steps_to_action_steps(const PsramVector<CatalogStep>& src) {
    PsramVector<ActionStep> out;
    out.reserve(src.size());
    for (const auto& cs : src) {
        ActionStep a;
        a.type = cs.type;
        a.can_id = cs.can_id;
        a.delay_ms = cs.delay_ms;
        a.bus = cs.bus;
        std::memcpy(a.payload, cs.payload, sizeof(a.payload));
        a.mask = cs.mask;
        a.repeat = cs.repeat;
        a.nav_icon = cs.nav_icon;
        out.push_back(std::move(a));
    }
    return out;
}

struct EntityOption {
    std::string label;
    bool is_default = false;
    uint8_t match_payload[8] = {0};
    uint8_t match_mask = 0;
    uint8_t invert_mask = 0; // Bit set if comparison is inverted ('!0x..')
    uint8_t byte_masks[8] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
    PsramVector<CatalogStep> steps;
};

enum class MitmMode {
    NONE = 0,
    ALWAYS = 1,
    ON_DEMAND = 2
};

struct EntityMitmConfig {
    MitmMode mode = MitmMode::NONE;
    uint8_t source_bus = 1;
    uint8_t target_bus = 0;
    PsramVector<uint32_t> block_can_ids;
    PsramVector<uint32_t> reverse_block_can_ids;
    bool has_match = false;
    uint8_t match_payload[8] = {0};
    uint8_t match_mask = 0;
    uint8_t invert_mask = 0;
    uint8_t byte_masks[8] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
    uint32_t hold_ms = 5000;
};

struct CanEntity {
    std::string id;
    std::string ha_name;
    std::string ha_domain;
    std::string ha_icon;

    uint32_t state_can_id = 0;
    uint32_t action_can_id = 0;
    uint32_t delay_ms = 20;
    uint8_t bus = 0;
    uint8_t action_bus = 0;
    int8_t state_byte = -1;        // 0..7 (from D1..D8), -1 if unset or invalid
    uint8_t state_byte_length = 1; // 1 (default) or 2 (16-bit unsigned)
    bool state_big_endian = false; // false = "little" (default), true = "big"
    EntityMitmConfig mitm;

    PsramVector<EntityOption> options;
    std::string current_state = "";
};

struct AutomationTrigger {
    std::string id;
    std::string type = "can_rx"; // "can_rx", "byte_transition", "mqtt", or "time_schedule"
    std::string source;          // Optional source category ("can", "wifi", "ble", "device", etc.)
    uint32_t can_id = 0;
    uint8_t bus = 0;
    int byte_index = -1;
    uint8_t byte_mask = 0xFF; // Bitmask for specific byte/nibble (e.g. 0xF0)
    bool has_from_value = false;
    uint8_t from_value = 0;
    uint8_t to_value = 0;
    ConditionOperator op = ConditionOperator::EQUAL;
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

    // For Bluetooth BLE events
    std::string ble_event;          // "button", "connected", "disconnected", "proximity", "enter", "exit"
    std::string ble_button;         // "volume_up", "mute+volume_down", etc.
    std::string ble_action = "press"; // "press", "tap", "release", "hold", "hold_1s".."hold_Ns", "any"
    std::string ble_device;         // Optional device address or name filter
    std::string beacon_uuid;        // Optional iBeacon UUID or beacon MAC filter
    uint16_t beacon_major = 0;
    uint16_t beacon_minor = 0;

    // Sustained state duration requirement (0 = immediate/edge)
    uint32_t for_ms = 0;
    std::shared_ptr<SustainedState> sustained;

    // Multi-press click count requirement (1 = single, 2 = double, 3 = triple)
    uint8_t click_count = 1;
    std::shared_ptr<struct MultiClickState> multi_click;
};

struct MultiClickState {
    std::mutex mtx;
    uint8_t count = 0;
    uint32_t last_press_ms = 0;
    bool pending = false;
};

struct TriggerCombineState {
    std::vector<uint32_t> last_hit_ms;
    size_t seq_step = 0;
    uint32_t seq_last_hit_ms = 0;
};

struct AutomationRule {
    std::string id;
    std::string name;
    bool enabled = true;
    bool ha_expose = true;
    bool hold_beep = false;
    std::string ha_icon = "mdi:car-cog";
    uint32_t cooldown_ms = 0;
    std::string exec_mode = "one_shot"; // Retained for schema compatibility
    std::string trigger_mode = "any";   // "any", "all", "sequence"
    uint32_t trigger_window_ms = 8000;  // Window for "all" and "sequence" trigger modes (ms)
    uint32_t last_exec_time_ms = 0;
    std::shared_ptr<std::atomic<bool>> is_running = std::make_shared<std::atomic<bool>>(false);
    std::shared_ptr<TriggerCombineState> trigger_state = std::make_shared<TriggerCombineState>();
    PsramVector<AutomationTrigger> triggers;
    PsramVector<AutomationCondition> conditions;
    PsramVector<ActionStep> actions;
};

struct CanBurstCmd {
    uint32_t can_id = 0;
    uint32_t delay_ms = 20;
    std::string trigger_id;
    PsramVector<ActionStep> inline_steps;
    bool async = false;
    std::shared_ptr<std::atomic<bool>> rule_is_running = nullptr;
};
