#pragma once

#include "types.h"
#include "cJSON.h"
#include <vector>
#include <unordered_map>
#include <functional>
#include <mutex>
#include <atomic>

extern PsramVector<CanEntity> global_catalog;
extern PsramUnorderedMap<uint32_t, PsramVector<CanEntity*>> catalog_by_can_id;
extern PsramVector<AutomationRule> global_automations;
extern std::mutex g_catalog_mutex;
extern std::mutex g_automations_mutex;
extern std::atomic<uint32_t> g_automations_gen;
extern std::atomic<bool> g_has_mitm_rules;

void mitm_arm_entity(const std::string& entity_id, uint32_t hold_ms_override = 0);
void mitm_arm_can_id(uint32_t can_id, uint32_t hold_ms_override = 0);
bool mitm_should_block_bridged_frame(uint32_t can_id, uint8_t rx_bus, uint8_t dst_bus, const uint8_t* data, uint8_t dlc);

int get_d_index(const char* key);
uint8_t parse_hex_string(const char* hex_str, bool* is_inverted = nullptr);
uint8_t parse_weekdays_mask(cJSON* days_arr);
uint16_t parse_time_to_minutes(const char* time_str);
ConditionOperator parse_operator(const char* op_str);
bool parse_single_condition(cJSON* c_item, AutomationCondition& cond, int depth = 0);
bool parse_action_step(cJSON* a_item, ActionStep& step, int depth = 0);

bool parse_entity(cJSON* entity_json, CanEntity& out_entity, bool include_discovery_meta = true);
bool parse_automation(cJSON* auto_json, AutomationRule& out_rule);
bool load_catalog_from_fs(const char* filepath);
bool load_automations_from_fs(const char* filepath = "/spiffs/automations.json");
bool stream_catalog_entities(std::function<bool(const CanEntity&)> callback);
bool find_entity_in_catalog(const std::string& entity_id, CanEntity& out_entity);

