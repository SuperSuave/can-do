#pragma once

#include "types.h"
#include "cJSON.h"
#include <vector>

extern std::vector<CanEntity> global_catalog;
extern std::vector<AutomationRule> global_automations;

int get_d_index(const char* key);
uint8_t parse_hex_string(const char* hex_str, bool* is_inverted = nullptr);
ConditionOperator parse_operator(const char* op_str);

bool parse_entity(cJSON* entity_json, CanEntity& out_entity);
bool parse_automation(cJSON* auto_json, AutomationRule& out_rule);
bool load_catalog_from_fs(const char* filepath);
