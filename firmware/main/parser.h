#pragma once

#include "types.h"
#include "cJSON.h"
#include <vector>
#include <unordered_map>

extern std::vector<CanEntity> global_catalog;
extern std::unordered_map<uint32_t, std::vector<CanEntity*>> catalog_by_can_id;
extern std::vector<AutomationRule> global_automations;

void rebuild_catalog_can_id_index(void);

int get_d_index(const char* key);
uint8_t parse_hex_string(const char* hex_str, bool* is_inverted = nullptr);
uint8_t parse_weekdays_mask(cJSON* days_arr);
uint16_t parse_time_to_minutes(const char* time_str);
ConditionOperator parse_operator(const char* op_str);
bool parse_single_condition(cJSON* c_item, AutomationCondition& cond);
bool parse_action_step(cJSON* a_item, ActionStep& step);

bool parse_entity(cJSON* entity_json, CanEntity& out_entity);
bool parse_automation(cJSON* auto_json, AutomationRule& out_rule);
bool load_catalog_from_fs(const char* filepath);
bool load_automations_from_fs(const char* filepath = "/spiffs/automations.json");
