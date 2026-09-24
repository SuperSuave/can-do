#include "parser.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "esp_log.h"

static const char* TAG = "CATALOG_PARSER";

std::vector<CanEntity> global_catalog;
std::unordered_map<uint32_t, std::vector<CanEntity*>> catalog_by_can_id;
std::vector<AutomationRule> global_automations;

void rebuild_catalog_can_id_index(void) {
    catalog_by_can_id.clear();
    for (auto& entity : global_catalog) {
        if (entity.state_can_id != 0) {
            catalog_by_can_id[entity.state_can_id].push_back(&entity);
        }
    }
}

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

uint16_t parse_time_to_minutes(const char* time_str) {
    if (!time_str) return 0;
    int h = 0, m = 0;
    if (sscanf(time_str, "%d:%d", &h, &m) >= 2) {
        if (h < 0) h = 0;
        if (h > 23) h = 23;
        if (m < 0) m = 0;
        if (m > 59) m = 59;
        return static_cast<uint16_t>(h * 60 + m);
    }
    return 0;
}

uint8_t parse_weekdays_mask(cJSON* days_arr) {
    if (!days_arr || !cJSON_IsArray(days_arr) || cJSON_GetArraySize(days_arr) == 0) {
        return 0x7F; // All 7 days by default (bits 0..6: Sun..Sat)
    }

    uint8_t mask = 0;
    cJSON* d = nullptr;
    cJSON_ArrayForEach(d, days_arr) {
        if (cJSON_IsString(d)) {
            const char* s = d->valuestring;
            if (strcasecmp(s, "sun") == 0 || strcasecmp(s, "sunday") == 0) mask |= (1 << 0);
            else if (strcasecmp(s, "mon") == 0 || strcasecmp(s, "monday") == 0) mask |= (1 << 1);
            else if (strcasecmp(s, "tue") == 0 || strcasecmp(s, "tuesday") == 0) mask |= (1 << 2);
            else if (strcasecmp(s, "wed") == 0 || strcasecmp(s, "wednesday") == 0) mask |= (1 << 3);
            else if (strcasecmp(s, "thu") == 0 || strcasecmp(s, "thursday") == 0) mask |= (1 << 4);
            else if (strcasecmp(s, "fri") == 0 || strcasecmp(s, "friday") == 0) mask |= (1 << 5);
            else if (strcasecmp(s, "sat") == 0 || strcasecmp(s, "saturday") == 0) mask |= (1 << 6);
            else if (strcasecmp(s, "all") == 0 || strcasecmp(s, "everyday") == 0) mask = 0x7F;
            else if (strcasecmp(s, "weekdays") == 0) mask |= 0x3E; // Mon-Fri
            else if (strcasecmp(s, "weekends") == 0) mask |= 0x41; // Sun+Sat
        } else if (cJSON_IsNumber(d)) {
            int val = d->valueint;
            if (val >= 0 && val <= 6) mask |= (1 << val);
            else if (val == 7) mask |= (1 << 0);
        }
    }
    return mask == 0 ? 0x7F : mask;
}

static void parse_byte_match(cJSON* match_obj, uint8_t match_payload[8], uint8_t& match_mask, uint8_t& invert_mask, uint8_t* byte_masks = nullptr, cJSON* mask_obj = nullptr) {
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
    if (byte_masks && mask_obj) {
        if (cJSON_IsString(mask_obj)) {
            uint8_t m = parse_hex_string(mask_obj->valuestring);
            for (int i = 0; i < 8; i++) {
                if (match_mask & (1 << i)) {
                    byte_masks[i] = m;
                }
            }
        } else if (cJSON_IsObject(mask_obj)) {
            cJSON* m_item = nullptr;
            cJSON_ArrayForEach(m_item, mask_obj) {
                int idx = get_d_index(m_item->string);
                if (idx >= 0 && cJSON_IsString(m_item)) {
                    byte_masks[idx] = parse_hex_string(m_item->valuestring);
                }
            }
        }
    }
}

bool parse_single_condition(cJSON* c_item, AutomationCondition& cond) {
    if (!c_item) return false;

    // Check for explicit "logic": "and" | "or" | "not" or "type": "and" | "or" | "not"
    cJSON* logic_item = cJSON_GetObjectItem(c_item, "logic");
    if (!logic_item) logic_item = cJSON_GetObjectItem(c_item, "type");
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

    // Check if this condition is a time_condition
    cJSON* type_prop = cJSON_GetObjectItem(c_item, "type");
    if (cJSON_IsString(type_prop) && (strcmp(type_prop->valuestring, "time_condition") == 0 || strcmp(type_prop->valuestring, "time") == 0)) {
        cond.type = "time_condition";
        cJSON* s_time = cJSON_GetObjectItem(c_item, "start_time");
        if (cJSON_IsString(s_time)) cond.start_time_min = parse_time_to_minutes(s_time->valuestring);
        cJSON* e_time = cJSON_GetObjectItem(c_item, "end_time");
        if (cJSON_IsString(e_time)) cond.end_time_min = parse_time_to_minutes(e_time->valuestring);
        cond.weekdays_mask = parse_weekdays_mask(cJSON_GetObjectItem(c_item, "days"));
        return true;
    }

    cond.type = "can_state";
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
    } else if (strcmp(type_str, "track_popup") == 0 || strcmp(type_str, "popup") == 0) {
        step.type = ActionType::TRACK_POPUP;
        cJSON* txt = cJSON_GetObjectItem(a_item, "text");
        if (!txt) txt = cJSON_GetObjectItem(a_item, "message");
        if (cJSON_IsString(txt)) step.popup_text = txt->valuestring;

        cJSON* lvl = cJSON_GetObjectItem(a_item, "level");
        if (cJSON_IsString(lvl)) step.popup_level = lvl->valuestring;
        else step.popup_level = "info";
        return true;
    } else if (strcmp(type_str, "climate_target") == 0) {
        step.type = ActionType::CLIMATE_TARGET;
        cJSON* tc = cJSON_GetObjectItem(a_item, "target_c");
        if (!tc) tc = cJSON_GetObjectItem(a_item, "target_temp_c");
        if (!tc) tc = cJSON_GetObjectItem(a_item, "target_temp");
        if (!tc) tc = cJSON_GetObjectItem(a_item, "temp");
        if (cJSON_IsNumber(tc)) {
            step.target_temp_c = static_cast<float>(tc->valuedouble);
        } else {
            step.target_temp_c = 21.0f;
        }

        cJSON* zn = cJSON_GetObjectItem(a_item, "zone");
        if (!zn) zn = cJSON_GetObjectItem(a_item, "climate_zone");
        if (cJSON_IsString(zn)) step.zone = zn->valuestring;
        else step.zone = "driver";

        cJSON* sync = cJSON_GetObjectItem(a_item, "sync_on");
        if (!sync) sync = cJSON_GetObjectItem(a_item, "climate_sync_on");
        if (cJSON_IsBool(sync)) step.sync_on = cJSON_IsTrue(sync);

        cJSON* d_only = cJSON_GetObjectItem(a_item, "driver_only");
        if (!d_only) d_only = cJSON_GetObjectItem(a_item, "climate_driver_only");
        if (cJSON_IsBool(d_only)) step.driver_only = cJSON_IsTrue(d_only);

        return true;
    } else if (strcmp(type_str, "precondition") == 0 || strcmp(type_str, "battery_preconditioning") == 0) {
        step.type = ActionType::PRECONDITION;
        cJSON* mode = cJSON_GetObjectItem(a_item, "precon_mode");
        if (!mode) mode = cJSON_GetObjectItem(a_item, "mode");
        if (cJSON_IsString(mode)) step.precon_mode = mode->valuestring;
        else step.precon_mode = "persistent";

        cJSON* act = cJSON_GetObjectItem(a_item, "action");
        if (!act) act = cJSON_GetObjectItem(a_item, "command");
        if (cJSON_IsString(act)) step.precon_action = act->valuestring;
        else step.precon_action = (step.precon_mode == "cancel" || step.precon_mode == "off") ? "stop" : "start";

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

            parse_byte_match(cJSON_GetObjectItem(opt_json, "match"), opt.match_payload, opt.match_mask, opt.invert_mask, opt.byte_masks, cJSON_GetObjectItem(opt_json, "mask"));
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
            parse_byte_match(root_match, opt.match_payload, opt.match_mask, opt.invert_mask, opt.byte_masks, cJSON_GetObjectItem(entity_json, "mask"));
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

    cJSON* cd = cJSON_GetObjectItem(auto_json, "cooldown_ms");
    if (cJSON_IsNumber(cd)) out_rule.cooldown_ms = static_cast<uint32_t>(cd->valueint);

    cJSON* mode = cJSON_GetObjectItem(auto_json, "exec_mode");
    if (cJSON_IsString(mode)) out_rule.exec_mode = mode->valuestring;

    // Triggers
    cJSON* trigs = cJSON_GetObjectItem(auto_json, "triggers");
    if (cJSON_IsArray(trigs)) {
        cJSON* t_item = nullptr;
        cJSON_ArrayForEach(t_item, trigs) {
            AutomationTrigger tr;
            cJSON* type = cJSON_GetObjectItem(t_item, "type");
            if (cJSON_IsString(type)) tr.type = type->valuestring;

            if (tr.type == "time_schedule" || tr.type == "time") {
                tr.type = "time_schedule";
                cJSON* time_val = cJSON_GetObjectItem(t_item, "time");
                if (cJSON_IsString(time_val)) tr.schedule_time_min = parse_time_to_minutes(time_val->valuestring);
                tr.weekdays_mask = parse_weekdays_mask(cJSON_GetObjectItem(t_item, "days"));
            } else {
                cJSON* cid = cJSON_GetObjectItem(t_item, "can_id");
                if (cJSON_IsString(cid)) tr.can_id = strtol(cid->valuestring, nullptr, 16);
                else if (cJSON_IsNumber(cid)) tr.can_id = static_cast<uint32_t>(cid->valueint);
                cJSON* bus = cJSON_GetObjectItem(t_item, "bus");
                if (cJSON_IsNumber(bus)) tr.bus = bus->valueint;

                uint8_t dummy_invert = 0;
                parse_byte_match(cJSON_GetObjectItem(t_item, "match"), tr.match_payload, tr.match_mask, dummy_invert, tr.byte_masks, cJSON_GetObjectItem(t_item, "mask"));

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
                        if (cJSON_IsString(from_item)) {
                            tr.from_value = parse_hex_string(from_item->valuestring);
                            tr.has_from_value = true;
                        }
                        if (cJSON_IsString(to_item)) {
                            tr.to_value = parse_hex_string(to_item->valuestring);
                            tr.match_payload[b_idx] = tr.to_value;
                            tr.match_mask |= (1 << b_idx);
                        }
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

template<typename Handler>
static bool stream_parse_array_from_file(FILE* f, const char* target_key, Handler handler) {
    if (!f || !target_key) return false;

    // 1. Scan for target key in quotes
    int c;
    bool in_quote = false;
    bool escape = false;
    std::string key_buf;
    bool found_key = false;

    while ((c = fgetc(f)) != EOF) {
        if (escape) {
            escape = false;
            continue;
        }
        if (c == '\\' && in_quote) {
            escape = true;
            continue;
        }
        if (c == '"') {
            if (!in_quote) {
                in_quote = true;
                key_buf.clear();
            } else {
                in_quote = false;
                if (key_buf == target_key) {
                    found_key = true;
                    break;
                }
            }
        } else if (in_quote) {
            key_buf += static_cast<char>(c);
        }
    }

    if (!found_key) return false;

    // 2. Find '['
    bool found_bracket = false;
    while ((c = fgetc(f)) != EOF) {
        if (c == '[') {
            found_bracket = true;
            break;
        } else if (c == ']' || c == '}') {
            return false;
        }
    }
    if (!found_bracket) return false;

    // 3. Extract each '{ ... }' object
    std::string obj_buf;
    obj_buf.reserve(2048);
    int parsed_count = 0;

    while ((c = fgetc(f)) != EOF) {
        // Skip whitespace, commas, newlines until '{' or ']'
        while (c != EOF && c != '{' && c != ']') {
            c = fgetc(f);
        }
        if (c == EOF || c == ']') {
            break; // End of array
        }

        // c is '{'
        obj_buf.clear();
        obj_buf += '{';
        int depth = 1;
        bool in_str = false;
        escape = false;

        while ((c = fgetc(f)) != EOF) {
            obj_buf += static_cast<char>(c);
            if (escape) {
                escape = false;
            } else if (c == '\\' && in_str) {
                escape = true;
            } else if (c == '"') {
                in_str = !in_str;
            } else if (!in_str) {
                if (c == '{') {
                    depth++;
                } else if (c == '}') {
                    depth--;
                    if (depth == 0) {
                        break;
                    }
                }
            }
        }

        if (depth == 0) {
            cJSON* item_json = cJSON_Parse(obj_buf.c_str());
            if (item_json) {
                handler(item_json);
                cJSON_Delete(item_json);
                parsed_count++;
            }
            obj_buf.clear();
        }
    }

    return parsed_count > 0;
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

    global_catalog.clear();
    global_automations.clear();
    catalog_by_can_id.clear();

    // For large catalog files (> 16KB), use low-RAM streaming parser
    if (size > 16384) {
        ESP_LOGI(TAG, "Using low-memory streaming parser for large catalog (%ld bytes)", size);

        // 1. Parse "commands" (fallback to "entities")
        rewind(f);
        bool ok = stream_parse_array_from_file(f, "commands", [](cJSON* cmd_json) {
            CanEntity entity;
            if (parse_entity(cmd_json, entity)) {
                global_catalog.push_back(entity);
            }
        });
        if (!ok) {
            rewind(f);
            stream_parse_array_from_file(f, "entities", [](cJSON* cmd_json) {
                CanEntity entity;
                if (parse_entity(cmd_json, entity)) {
                    global_catalog.push_back(entity);
                }
            });
        }

        // 2. Parse "automations" if present
        rewind(f);
        stream_parse_array_from_file(f, "automations", [](cJSON* auto_json) {
            AutomationRule rule;
            if (parse_automation(auto_json, rule)) {
                global_automations.push_back(rule);
            }
        });

        fclose(f);
        rebuild_catalog_can_id_index();
        ESP_LOGI(TAG, "Catalog loaded: %zu entities, %zu automations, %zu indexed CAN IDs", 
                 global_catalog.size(), global_automations.size(), catalog_by_can_id.size());
        return !global_catalog.empty();
    }

    // Standard fallback parser for smaller files
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
    rebuild_catalog_can_id_index();
    ESP_LOGI(TAG, "Catalog loaded: %zu entities, %zu automations, %zu indexed CAN IDs", 
             global_catalog.size(), global_automations.size(), catalog_by_can_id.size());
    return true;
}

bool load_automations_from_fs(const char* filepath) {
    ESP_LOGI(TAG, "Loading automations from %s", filepath);
    FILE* f = fopen(filepath, "r");
    if (!f) {
        ESP_LOGW(TAG, "Automations file not found: %s", filepath);
        return false;
    }

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (size <= 0) {
        fclose(f);
        ESP_LOGW(TAG, "Automations file %s is empty", filepath);
        return false;
    }

    char* buffer = static_cast<char*>(malloc(size + 1));
    if (!buffer) {
        fclose(f);
        ESP_LOGE(TAG, "Out of memory allocating %ld bytes for automations", size);
        return false;
    }

    fread(buffer, 1, size, f);
    buffer[size] = '\0';
    fclose(f);

    cJSON* root = cJSON_Parse(buffer);
    free(buffer);

    if (!root) {
        ESP_LOGE(TAG, "Failed to parse automations JSON");
        return false;
    }

    global_automations.clear();

    cJSON* rules_array = nullptr;
    if (cJSON_IsArray(root)) {
        rules_array = root;
    } else if (cJSON_IsObject(root)) {
        rules_array = cJSON_GetObjectItem(root, "rules");
        if (!rules_array) rules_array = cJSON_GetObjectItem(root, "automations");
    }

    if (cJSON_IsArray(rules_array)) {
        cJSON* auto_json = nullptr;
        cJSON_ArrayForEach(auto_json, rules_array) {
            AutomationRule rule;
            if (parse_automation(auto_json, rule)) {
                global_automations.push_back(rule);
            }
        }
    }

    cJSON_Delete(root);
    ESP_LOGI(TAG, "Automations loaded: %zu active rules from %s", global_automations.size(), filepath);
    return true;
}

