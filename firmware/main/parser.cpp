#include "parser.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "esp_log.h"

static const char* TAG = "CATALOG_PARSER";

std::vector<CanEntity> global_catalog;
std::vector<AutomationRule> global_automations;

int get_d_index(const char* key) {
    if (key != nullptr && key[0] == 'D' && strlen(key) >= 2) {
        int val = key[1] - '0';
        if (val >= 1 && val <= 8) {
            return val - 1;
        }
    }
    return -1;
}

uint8_t parse_hex_string(const char* hex_str, bool* is_inverted) {
    if (hex_str == nullptr) return 0;
    if (is_inverted) *is_inverted = false;
    const char* p = hex_str;
    if (*p == '!') {
        if (is_inverted) *is_inverted = true;
        p++;
    }
    return static_cast<uint8_t>(strtol(p, nullptr, 16));
}

ConditionOperator parse_operator(const char* op_str) {
    if (!op_str) return ConditionOperator::EQUAL;
    if (strcmp(op_str, "not_equal") == 0 || strcmp(op_str, "!=") == 0) return ConditionOperator::NOT_EQUAL;
    if (strcmp(op_str, "less_than") == 0 || strcmp(op_str, "<") == 0) return ConditionOperator::LESS_THAN;
    if (strcmp(op_str, "greater_than") == 0 || strcmp(op_str, ">") == 0) return ConditionOperator::GREATER_THAN;
    return ConditionOperator::EQUAL;
}

static void parse_byte_match(cJSON* match_obj, uint8_t match_payload[8], uint8_t& match_mask, uint8_t& invert_mask) {
    if (!match_obj) return;
    cJSON* item = nullptr;
    cJSON_ArrayForEach(item, match_obj) {
        int idx = get_d_index(item->string);
        if (idx >= 0 && cJSON_IsString(item)) {
            bool inverted = false;
            match_payload[idx] = parse_hex_string(item->valuestring, &inverted);
            match_mask |= (1 << idx);
            if (inverted) {
                invert_mask |= (1 << idx);
            }
        }
    }
}

bool parse_single_condition(cJSON* c_item, AutomationCondition& cond) {
    if (!c_item) return false;

    // Check for explicit "logic": "and" | "or" | "not"
    cJSON* logic_item = cJSON_GetObjectItem(c_item, "logic");
    const char* logic_str = cJSON_IsString(logic_item) ? logic_item->valuestring : nullptr;

    // Check shorthand keys { "and": [...] }, { "or": [...] }, { "not": [...] }
    cJSON* and_array = cJSON_GetObjectItem(c_item, "and");
    cJSON* or_array = cJSON_GetObjectItem(c_item, "or");
    cJSON* not_item = cJSON_GetObjectItem(c_item, "not");

    if ((logic_str && (strcmp(logic_str, "and") == 0 || strcmp(logic_str, "AND") == 0)) || cJSON_IsArray(and_array)) {
        cond.logic = ConditionLogic::AND_GROUP;
        cJSON* sub_array = cJSON_IsArray(and_array) ? and_array : cJSON_GetObjectItem(c_item, "conditions");
        if (cJSON_IsArray(sub_array)) {
            cJSON* sub = nullptr;
            cJSON_ArrayForEach(sub, sub_array) {
                AutomationCondition sub_cond;
                if (parse_single_condition(sub, sub_cond)) {
                    cond.sub_conditions.push_back(sub_cond);
                }
            }
        }
        return true;
    } else if ((logic_str && (strcmp(logic_str, "or") == 0 || strcmp(logic_str, "OR") == 0)) || cJSON_IsArray(or_array)) {
        cond.logic = ConditionLogic::OR_GROUP;
        cJSON* sub_array = cJSON_IsArray(or_array) ? or_array : cJSON_GetObjectItem(c_item, "conditions");
        if (cJSON_IsArray(sub_array)) {
            cJSON* sub = nullptr;
            cJSON_ArrayForEach(sub, sub_array) {
                AutomationCondition sub_cond;
                if (parse_single_condition(sub, sub_cond)) {
                    cond.sub_conditions.push_back(sub_cond);
                }
            }
        }
        return true;
    } else if ((logic_str && (strcmp(logic_str, "not") == 0 || strcmp(logic_str, "NOT") == 0)) || not_item != nullptr) {
        cond.logic = ConditionLogic::NOT_GROUP;
        cJSON* sub_array = cJSON_GetObjectItem(c_item, "conditions");
        if (not_item) {
            if (cJSON_IsArray(not_item)) {
                sub_array = not_item;
            } else if (cJSON_IsObject(not_item)) {
                AutomationCondition sub_cond;
                if (parse_single_condition(not_item, sub_cond)) {
                    cond.sub_conditions.push_back(sub_cond);
                }
                return true;
            }
        }
        if (cJSON_IsArray(sub_array)) {
            cJSON* sub = nullptr;
            cJSON_ArrayForEach(sub, sub_array) {
                AutomationCondition sub_cond;
                if (parse_single_condition(sub, sub_cond)) {
                    cond.sub_conditions.push_back(sub_cond);
                }
            }
        }
        return true;
    }

    // Leaf condition
    cond.logic = ConditionLogic::LEAF;
    cJSON* cid = cJSON_GetObjectItem(c_item, "can_id");
    if (cJSON_IsString(cid)) cond.can_id = strtol(cid->valuestring, nullptr, 16);
    else if (cJSON_IsNumber(cid)) cond.can_id = static_cast<uint32_t>(cid->valueint);

    cJSON* bus = cJSON_GetObjectItem(c_item, "bus");
    if (cJSON_IsNumber(bus)) cond.bus = static_cast<uint8_t>(bus->valueint);

    cJSON* eval = cJSON_GetObjectItem(c_item, "evaluate");
    cJSON* b = eval ? cJSON_GetObjectItem(eval, "byte") : cJSON_GetObjectItem(c_item, "byte");
    if (cJSON_IsString(b)) {
        int idx = get_d_index(b->valuestring);
        if (idx >= 0) cond.byte_index = static_cast<uint8_t>(idx);
    } else if (cJSON_IsNumber(b)) {
        cond.byte_index = static_cast<uint8_t>(b->valueint);
    }

    cJSON* mask = eval ? cJSON_GetObjectItem(eval, "mask") : cJSON_GetObjectItem(c_item, "mask");
    if (cJSON_IsString(mask)) {
        cond.byte_mask = parse_hex_string(mask->valuestring);
    } else if (cJSON_IsNumber(mask)) {
        cond.byte_mask = static_cast<uint8_t>(mask->valueint);
    } else {
        cond.byte_mask = 0xFF;
    }

    cJSON* op = eval ? cJSON_GetObjectItem(eval, "operator") : cJSON_GetObjectItem(c_item, "operator");
    if (cJSON_IsString(op)) cond.op = parse_operator(op->valuestring);

    cJSON* val = eval ? cJSON_GetObjectItem(eval, "value") : cJSON_GetObjectItem(c_item, "value");
    if (cJSON_IsString(val)) {
        cond.target_value = parse_hex_string(val->valuestring);
    } else if (cJSON_IsNumber(val)) {
        cond.target_value = static_cast<uint8_t>(val->valueint);
    }

    return true;
}

bool parse_action_step(cJSON* a_item, ActionStep& step) {
    if (!a_item) return false;
    cJSON* type = cJSON_GetObjectItem(a_item, "type");
    const char* type_str = cJSON_IsString(type) ? type->valuestring : "";

    if (strcmp(type_str, "entity_command") == 0) {
        step.type = ActionType::ENTITY_COMMAND;
        cJSON* eid = cJSON_GetObjectItem(a_item, "entity_id");
        cJSON* cmd = cJSON_GetObjectItem(a_item, "command");
        if (cJSON_IsString(eid)) step.entity_id = eid->valuestring;
        if (cJSON_IsString(cmd)) step.command = cmd->valuestring;
        return true;
    } else if (strcmp(type_str, "delay") == 0) {
        step.type = ActionType::DELAY;
        cJSON* ms = cJSON_GetObjectItem(a_item, "ms");
        if (cJSON_IsNumber(ms)) step.delay_ms = ms->valueint;
        return true;
    } else if (strcmp(type_str, "if_then") == 0 || strcmp(type_str, "if") == 0) {
        step.type = ActionType::IF_THEN;
        cJSON* conds = cJSON_GetObjectItem(a_item, "conditions");
        if (cJSON_IsArray(conds)) {
            cJSON* c_sub = nullptr;
            cJSON_ArrayForEach(c_sub, conds) {
                AutomationCondition cond;
                if (parse_single_condition(c_sub, cond)) {
                    step.if_conditions.push_back(cond);
                }
            }
        }
        cJSON* then_arr = cJSON_GetObjectItem(a_item, "then");
        if (cJSON_IsArray(then_arr)) {
            cJSON* s_sub = nullptr;
            cJSON_ArrayForEach(s_sub, then_arr) {
                ActionStep s;
                if (parse_action_step(s_sub, s)) {
                    step.then_steps.push_back(s);
                }
            }
        }
        cJSON* else_arr = cJSON_GetObjectItem(a_item, "else");
        if (cJSON_IsArray(else_arr)) {
            cJSON* s_sub = nullptr;
            cJSON_ArrayForEach(s_sub, else_arr) {
                ActionStep s;
                if (parse_action_step(s_sub, s)) {
                    step.else_steps.push_back(s);
                }
            }
        }
        return true;
    } else if (strcmp(type_str, "choose") == 0) {
        step.type = ActionType::CHOOSE;
        cJSON* choices_arr = cJSON_GetObjectItem(a_item, "choices");
        if (cJSON_IsArray(choices_arr)) {
            cJSON* choice_elem = nullptr;
            cJSON_ArrayForEach(choice_elem, choices_arr) {
                ChoiceBranch branch;
                cJSON* c_conds = cJSON_GetObjectItem(choice_elem, "conditions");
                if (cJSON_IsArray(c_conds)) {
                    cJSON* c_sub = nullptr;
                    cJSON_ArrayForEach(c_sub, c_conds) {
                        AutomationCondition cond;
                        if (parse_single_condition(c_sub, cond)) {
                            branch.conditions.push_back(cond);
                        }
                    }
                }
                cJSON* seq_arr = cJSON_GetObjectItem(choice_elem, "sequence");
                if (cJSON_IsArray(seq_arr)) {
                    cJSON* s_sub = nullptr;
                    cJSON_ArrayForEach(s_sub, seq_arr) {
                        ActionStep s;
                        if (parse_action_step(s_sub, s)) {
                            branch.sequence.push_back(s);
                        }
                    }
                }
                step.choices.push_back(branch);
            }
        }
        cJSON* def_arr = cJSON_GetObjectItem(a_item, "default");
        if (cJSON_IsArray(def_arr)) {
            cJSON* s_sub = nullptr;
            cJSON_ArrayForEach(s_sub, def_arr) {
                ActionStep s;
                if (parse_action_step(s_sub, s)) {
                    step.default_steps.push_back(s);
                }
            }
        }
        return true;
    } else {
        step.type = ActionType::TRANSMIT_FRAME;
        cJSON* cid = cJSON_GetObjectItem(a_item, "can_id");
        if (cJSON_IsString(cid)) step.can_id = strtol(cid->valuestring, nullptr, 16);
        else if (cJSON_IsNumber(cid)) step.can_id = static_cast<uint32_t>(cid->valueint);

        cJSON* bus = cJSON_GetObjectItem(a_item, "bus");
        if (cJSON_IsNumber(bus)) step.bus = static_cast<uint8_t>(bus->valueint);

        cJSON* rep = cJSON_GetObjectItem(a_item, "repeat");
        if (cJSON_IsNumber(rep)) step.repeat = static_cast<uint8_t>(rep->valueint);

        cJSON* p = cJSON_GetObjectItem(a_item, "payload");
        if (p) {
            cJSON* p_item = nullptr;
            cJSON_ArrayForEach(p_item, p) {
                int idx = get_d_index(p_item->string);
                if (idx >= 0 && cJSON_IsString(p_item)) {
                    step.payload[idx] = parse_hex_string(p_item->valuestring);
                    step.mask |= (1 << idx);
                }
            }
        }
        return true;
    }
}

static void parse_steps(cJSON* steps_array, std::vector<ActionStep>& out_steps) {
    if (!steps_array) return;
    cJSON* step_json = nullptr;
    cJSON_ArrayForEach(step_json, steps_array) {
        ActionStep step;
        if (parse_action_step(step_json, step)) {
            out_steps.push_back(step);
        }
    }
}

bool parse_entity(cJSON* entity_json, CanEntity& out_entity) {
    cJSON* id = cJSON_GetObjectItem(entity_json, "id");
    if (cJSON_IsString(id)) out_entity.id = id->valuestring;
    else return false;

    // HA Metadata
    cJSON* ha_meta = cJSON_GetObjectItem(entity_json, "ha_metadata");
    if (ha_meta) {
        cJSON* name = cJSON_GetObjectItem(ha_meta, "name");
        cJSON* domain = cJSON_GetObjectItem(ha_meta, "domain");
        cJSON* icon = cJSON_GetObjectItem(ha_meta, "icon");
        if (cJSON_IsString(name)) out_entity.ha_name = name->valuestring;
        if (cJSON_IsString(domain)) out_entity.ha_domain = domain->valuestring;
        if (cJSON_IsString(icon)) out_entity.ha_icon = icon->valuestring;
    }

    // Network configuration
    cJSON* network = cJSON_GetObjectItem(entity_json, "network");
    if (network) {
        cJSON* state_can_id = cJSON_GetObjectItem(network, "state_can_id");
        cJSON* action_can_id = cJSON_GetObjectItem(network, "action_can_id");
        cJSON* delay = cJSON_GetObjectItem(network, "delay_ms");
        if (cJSON_IsString(state_can_id)) out_entity.state_can_id = strtol(state_can_id->valuestring, nullptr, 16);
        if (cJSON_IsString(action_can_id)) out_entity.action_can_id = strtol(action_can_id->valuestring, nullptr, 16);
        if (cJSON_IsNumber(delay)) out_entity.delay_ms = delay->valueint;
    }

    // Options array
    cJSON* options_array = cJSON_GetObjectItem(entity_json, "options");
    if (cJSON_IsArray(options_array)) {
        cJSON* opt_json = nullptr;
        cJSON_ArrayForEach(opt_json, options_array) {
            EntityOption opt;
            cJSON* label = cJSON_GetObjectItem(opt_json, "label");
            if (cJSON_IsString(label)) opt.label = label->valuestring;

            cJSON* req_feat = cJSON_GetObjectItem(opt_json, "requires_feature");
            if (cJSON_IsString(req_feat)) opt.requires_feature = req_feat->valuestring;

            cJSON* def = cJSON_GetObjectItem(opt_json, "default");
            if (cJSON_IsBool(def)) opt.is_default = cJSON_IsTrue(def);

            parse_byte_match(cJSON_GetObjectItem(opt_json, "match"), opt.match_payload, opt.match_mask, opt.invert_mask);
            parse_steps(cJSON_GetObjectItem(opt_json, "steps"), opt.steps);

            out_entity.options.push_back(opt);
        }
    } else {
        // Flat command: treat root match/steps as a default option
        cJSON* root_match = cJSON_GetObjectItem(entity_json, "match");
        cJSON* root_steps = cJSON_GetObjectItem(entity_json, "steps");
        if (root_match || root_steps) {
            EntityOption opt;
            opt.label = "Active";
            opt.is_default = true;
            parse_byte_match(root_match, opt.match_payload, opt.match_mask, opt.invert_mask);
            parse_steps(root_steps, opt.steps);
            out_entity.options.push_back(opt);
        }
    }

    return true;
}

bool parse_automation(cJSON* auto_json, AutomationRule& out_rule) {
    cJSON* id = cJSON_GetObjectItem(auto_json, "id");
    if (cJSON_IsString(id)) out_rule.id = id->valuestring;
    else return false;

    cJSON* name = cJSON_GetObjectItem(auto_json, "name");
    if (cJSON_IsString(name)) out_rule.name = name->valuestring;

    cJSON* en = cJSON_GetObjectItem(auto_json, "enabled");
    if (cJSON_IsBool(en)) out_rule.enabled = cJSON_IsTrue(en);

    // Triggers
    cJSON* trigs = cJSON_GetObjectItem(auto_json, "triggers");
    if (cJSON_IsArray(trigs)) {
        cJSON* t_item = nullptr;
        cJSON_ArrayForEach(t_item, trigs) {
            AutomationTrigger tr;
            cJSON* type = cJSON_GetObjectItem(t_item, "type");
            if (cJSON_IsString(type)) tr.type = type->valuestring;
            cJSON* cid = cJSON_GetObjectItem(t_item, "can_id");
            if (cJSON_IsString(cid)) tr.can_id = strtol(cid->valuestring, nullptr, 16);
            cJSON* bus = cJSON_GetObjectItem(t_item, "bus");
            if (cJSON_IsNumber(bus)) tr.bus = bus->valueint;

            uint8_t dummy_invert = 0;
            parse_byte_match(cJSON_GetObjectItem(t_item, "match"), tr.match_payload, tr.match_mask, dummy_invert);

            // Handle byte_transition schema: "byte": "D7", "mask": "0xF0", "from": "0x00", "to": "0x10"
            cJSON* byte_item = cJSON_GetObjectItem(t_item, "byte");
            if (cJSON_IsString(byte_item)) {
                int b_idx = get_d_index(byte_item->valuestring);
                if (b_idx >= 0) {
                    tr.byte_index = b_idx;
                    cJSON* mask_item = cJSON_GetObjectItem(t_item, "mask");
                    if (cJSON_IsString(mask_item)) {
                        tr.byte_mask = parse_hex_string(mask_item->valuestring);
                    } else {
                        tr.byte_mask = 0xFF;
                    }

                    cJSON* from_item = cJSON_GetObjectItem(t_item, "from");
                    cJSON* to_item = cJSON_GetObjectItem(t_item, "to");
                    if (cJSON_IsString(from_item)) tr.from_value = parse_hex_string(from_item->valuestring);
                    if (cJSON_IsString(to_item)) {
                        tr.to_value = parse_hex_string(to_item->valuestring);
                        tr.match_payload[b_idx] = tr.to_value;
                        tr.match_mask |= (1 << b_idx);
                    }
                }
            }

            out_rule.triggers.push_back(tr);
        }
    }

    // Conditions
    cJSON* conds = cJSON_GetObjectItem(auto_json, "conditions");
    if (cJSON_IsArray(conds)) {
        cJSON* c_item = nullptr;
        cJSON_ArrayForEach(c_item, conds) {
            AutomationCondition cond;
            if (parse_single_condition(c_item, cond)) {
                out_rule.conditions.push_back(cond);
            }
        }
    }

    // Actions
    cJSON* acts = cJSON_GetObjectItem(auto_json, "actions");
    if (cJSON_IsArray(acts)) {
        cJSON* a_item = nullptr;
        cJSON_ArrayForEach(a_item, acts) {
            ActionStep step;
            if (parse_action_step(a_item, step)) {
                out_rule.actions.push_back(step);
            }
        }
    }

    return true;
}

bool load_catalog_from_fs(const char* filepath) {
    ESP_LOGI(TAG, "Loading catalog from %s", filepath);
    FILE* f = fopen(filepath, "r");
    if (!f) {
        ESP_LOGE(TAG, "Failed to open catalog file: %s", filepath);
        return false;
    }

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);

    char* buffer = static_cast<char*>(malloc(size + 1));
    if (!buffer) {
        fclose(f);
        ESP_LOGE(TAG, "Out of memory allocating %ld bytes for catalog", size);
        return false;
    }

    fread(buffer, 1, size, f);
    buffer[size] = '\0';
    fclose(f);

    cJSON* root = cJSON_Parse(buffer);
    free(buffer);

    if (!root) {
        ESP_LOGE(TAG, "Failed to parse catalog JSON");
        return false;
    }

    global_catalog.clear();
    global_automations.clear();

    // Check "commands" first, fall back to "entities"
    cJSON* cmds_array = cJSON_GetObjectItem(root, "commands");
    if (!cmds_array) cmds_array = cJSON_GetObjectItem(root, "entities");

    if (cJSON_IsArray(cmds_array)) {
        cJSON* cmd_json = nullptr;
        cJSON_ArrayForEach(cmd_json, cmds_array) {
            CanEntity entity;
            if (parse_entity(cmd_json, entity)) {
                global_catalog.push_back(entity);
            }
        }
    }

    // Automations (if present)
    cJSON* autos_array = cJSON_GetObjectItem(root, "automations");
    if (cJSON_IsArray(autos_array)) {
        cJSON* auto_json = nullptr;
        cJSON_ArrayForEach(auto_json, autos_array) {
            AutomationRule rule;
            if (parse_automation(auto_json, rule)) {
                global_automations.push_back(rule);
            }
        }
    }

    cJSON_Delete(root);
    ESP_LOGI(TAG, "Catalog loaded: %zu entities, %zu automations", 
             global_catalog.size(), global_automations.size());
    return true;
}
