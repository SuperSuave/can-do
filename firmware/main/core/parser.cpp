#include "parser.h"
#include <sys/stat.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <cctype>
#include <list>
#include <unordered_set>
#include <algorithm>
#include <type_traits>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "sdkconfig.h"
#include "timezone_mgr.h"

static const char* TAG = "CATALOG_PARSER";

PsramVector<CanEntity> global_catalog;
static PsramList<CanEntity> s_dynamic_entities;
PsramUnorderedMap<uint32_t, PsramVector<CanEntity*>> catalog_by_can_id;
std::vector<AutomationRule> global_automations;
std::mutex g_catalog_mutex;
std::mutex g_automations_mutex;
std::atomic<uint32_t> g_automations_gen{1};
std::atomic<bool> g_has_mitm_rules{false};

struct CompiledMitmRule {
    std::string entity_id;
    EntityMitmConfig cfg;
    int64_t active_until_ms = 0;
};

static PsramVector<CompiledMitmRule> s_mitm_rules;
static PsramUnorderedMap<uint32_t, PsramVector<size_t>> s_mitm_rules_by_can_id;
static std::mutex s_mitm_mutex;

static void rebuild_mitm_rules_locked(void) {
    int64_t now_ms = esp_timer_get_time() / 1000LL;
    std::unordered_map<std::string, int64_t> prev_armed;
    {
        std::lock_guard<std::mutex> mlock(s_mitm_mutex);
        for (const auto& rule : s_mitm_rules) {
            if (rule.active_until_ms > now_ms) {
                prev_armed[rule.entity_id] = rule.active_until_ms;
            }
        }
    }

    PsramVector<CompiledMitmRule> new_rules;
    PsramUnorderedMap<uint32_t, PsramVector<size_t>> new_by_can_id;

    auto collect_entity = [&](const CanEntity& entity) {
        if (entity.mitm.mode == MitmMode::NONE) return;
        if (entity.mitm.block_can_ids.empty() && entity.mitm.reverse_block_can_ids.empty()) return;

        CompiledMitmRule rule;
        rule.entity_id = entity.id;
        rule.cfg = entity.mitm;
        auto armed_it = prev_armed.find(entity.id);
        if (armed_it != prev_armed.end()) {
            rule.active_until_ms = armed_it->second;
        }
        size_t idx = new_rules.size();
        new_rules.push_back(std::move(rule));

        for (uint32_t cid : entity.mitm.block_can_ids) {
            auto& vec = new_by_can_id[cid];
            if (std::find(vec.begin(), vec.end(), idx) == vec.end()) {
                vec.push_back(idx);
            }
        }
        for (uint32_t cid : entity.mitm.reverse_block_can_ids) {
            auto& vec = new_by_can_id[cid];
            if (std::find(vec.begin(), vec.end(), idx) == vec.end()) {
                vec.push_back(idx);
            }
        }
    };

    for (const auto& entity : global_catalog) {
        collect_entity(entity);
    }
    for (const auto& entity : s_dynamic_entities) {
        collect_entity(entity);
    }

    {
        std::lock_guard<std::mutex> mlock(s_mitm_mutex);
        s_mitm_rules.swap(new_rules);
        s_mitm_rules_by_can_id.swap(new_by_can_id);
        g_has_mitm_rules.store(!s_mitm_rules.empty(), std::memory_order_release);
    }
}

static void rebuild_catalog_can_id_index_locked(void) {
    catalog_by_can_id.clear();
    for (auto& entity : global_catalog) {
        if (entity.state_can_id != 0) {
            catalog_by_can_id[entity.state_can_id].push_back(&entity);
        }
    }
    for (auto& entity : s_dynamic_entities) {
        if (entity.state_can_id != 0) {
            catalog_by_can_id[entity.state_can_id].push_back(&entity);
        }
    }
    rebuild_mitm_rules_locked();
}

void rebuild_catalog_can_id_index(void) {
    std::lock_guard<std::mutex> lock(g_catalog_mutex);
    rebuild_catalog_can_id_index_locked();
}

void mitm_arm_entity(const std::string& entity_id, uint32_t hold_ms_override) {
    if (entity_id.empty() || !g_has_mitm_rules.load(std::memory_order_acquire)) return;
    int64_t now_ms = esp_timer_get_time() / 1000LL;
    std::lock_guard<std::mutex> mlock(s_mitm_mutex);
    for (auto& rule : s_mitm_rules) {
        if (rule.entity_id == entity_id && rule.cfg.mode == MitmMode::ON_DEMAND) {
            uint32_t hold = hold_ms_override > 0 ? hold_ms_override : (rule.cfg.hold_ms > 0 ? rule.cfg.hold_ms : 5000);
            int64_t until = now_ms + static_cast<int64_t>(hold);
            if (until > rule.active_until_ms) {
                rule.active_until_ms = until;
            }
        }
    }
}

void mitm_arm_can_id(uint32_t can_id, uint32_t hold_ms_override) {
    if (can_id == 0 || !g_has_mitm_rules.load(std::memory_order_acquire)) return;
    int64_t now_ms = esp_timer_get_time() / 1000LL;
    std::lock_guard<std::mutex> mlock(s_mitm_mutex);
    auto it = s_mitm_rules_by_can_id.find(can_id);
    if (it == s_mitm_rules_by_can_id.end()) return;
    for (size_t idx : it->second) {
        if (idx >= s_mitm_rules.size()) continue;
        auto& rule = s_mitm_rules[idx];
        if (rule.cfg.mode != MitmMode::ON_DEMAND) continue;
        if (std::find(rule.cfg.block_can_ids.begin(), rule.cfg.block_can_ids.end(), can_id) != rule.cfg.block_can_ids.end()) {
            uint32_t hold = hold_ms_override > 0 ? hold_ms_override : (rule.cfg.hold_ms > 0 ? rule.cfg.hold_ms : 5000);
            int64_t until = now_ms + static_cast<int64_t>(hold);
            if (until > rule.active_until_ms) {
                rule.active_until_ms = until;
            }
        }
    }
}

bool mitm_should_block_bridged_frame(uint32_t can_id, uint8_t rx_bus, uint8_t dst_bus, const uint8_t* data, uint8_t dlc) {
    if (!g_has_mitm_rules.load(std::memory_order_acquire)) return false;
    std::lock_guard<std::mutex> mlock(s_mitm_mutex);
    auto it = s_mitm_rules_by_can_id.find(can_id);
    if (it == s_mitm_rules_by_can_id.end()) return false;

    int64_t now_ms = esp_timer_get_time() / 1000LL;
    for (size_t idx : it->second) {
        if (idx >= s_mitm_rules.size()) continue;
        const auto& rule = s_mitm_rules[idx];
        if (rule.cfg.mode == MitmMode::NONE) continue;
        if (rule.cfg.mode == MitmMode::ON_DEMAND && rule.active_until_ms <= now_ms) continue;

        bool dir_match = false;
        if (rx_bus == rule.cfg.source_bus && dst_bus == rule.cfg.target_bus) {
            dir_match = std::find(rule.cfg.block_can_ids.begin(), rule.cfg.block_can_ids.end(), can_id) != rule.cfg.block_can_ids.end();
        } else if (rx_bus == rule.cfg.target_bus && dst_bus == rule.cfg.source_bus) {
            dir_match = std::find(rule.cfg.reverse_block_can_ids.begin(), rule.cfg.reverse_block_can_ids.end(), can_id) != rule.cfg.reverse_block_can_ids.end();
        }
        if (!dir_match) continue;

        if (rule.cfg.has_match && rule.cfg.match_mask != 0) {
            bool payload_ok = true;
            for (int b = 0; b < 8; ++b) {
                if (rule.cfg.match_mask & (1 << b)) {
                    if (!data || b >= dlc) {
                        payload_ok = false;
                        break;
                    }
                    bool eq = ((data[b] & rule.cfg.byte_masks[b]) == (rule.cfg.match_payload[b] & rule.cfg.byte_masks[b]));
                    if (rule.cfg.invert_mask & (1 << b)) {
                        eq = !eq;
                    }
                    if (!eq) {
                        payload_ok = false;
                        break;
                    }
                }
            }
            if (!payload_ok) continue;
        }
        return true;
    }
    return false;
}


int get_d_index(const char* key) {
    if (key == nullptr) return -1;
    while (*key == ' ' || *key == '\t') key++;
    if ((key[0] == 'D' || key[0] == 'd') && key[1] >= '1' && key[1] <= '8') {
        const char* tail = key + 2;
        while (*tail == ' ' || *tail == '\t') tail++;
        if (*tail == '\0') {
            return (key[1] - '0') - 1;
        }
    }
    return -1;
}

bool decode_can_uint(const uint8_t* data, size_t payload_len, int start_idx, uint8_t byte_length, bool big_endian, uint16_t* out_value) {
    if (!data || !out_value) return false;
    if (start_idx < 0) return false;
    if (byte_length != 1 && byte_length != 2) return false;
    if (static_cast<size_t>(start_idx) + static_cast<size_t>(byte_length) > payload_len) return false;

    if (byte_length == 1) {
        *out_value = data[start_idx];
        return true;
    }

    uint8_t b0 = data[start_idx];
    uint8_t b1 = data[start_idx + 1];
    *out_value = big_endian
                     ? static_cast<uint16_t>((static_cast<uint16_t>(b0) << 8) | b1)
                     : static_cast<uint16_t>(b0 | (static_cast<uint16_t>(b1) << 8));
    return true;
}

bool decode_entity_state_uint(const CanEntity& entity, const uint8_t* data, size_t payload_len, uint16_t* out_value) {
    return decode_can_uint(data, payload_len, entity.state_byte, entity.state_byte_length, entity.state_big_endian, out_value);
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
    if (strcmp(op_str, "not_equal") == 0 || strcmp(op_str, "!=") == 0 || strcmp(op_str, "not_equals") == 0) return ConditionOperator::NOT_EQUAL;
    if (strcmp(op_str, "less_than") == 0 || strcmp(op_str, "<") == 0 || strcmp(op_str, "less") == 0) return ConditionOperator::LESS_THAN;
    if (strcmp(op_str, "less_than_or_equal") == 0 || strcmp(op_str, "<=") == 0) return ConditionOperator::LESS_THAN_OR_EQUAL;
    if (strcmp(op_str, "greater_than") == 0 || strcmp(op_str, ">") == 0 || strcmp(op_str, "greater") == 0) return ConditionOperator::GREATER_THAN;
    if (strcmp(op_str, "greater_than_or_equal") == 0 || strcmp(op_str, ">=") == 0) return ConditionOperator::GREATER_THAN_OR_EQUAL;
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

static bool is_valid_mask_json(cJSON* obj) {
    if (!obj || cJSON_IsNull(obj)) return false;
    if (cJSON_IsString(obj)) return obj->valuestring != nullptr && obj->valuestring[0] != '\0';
    if (cJSON_IsNumber(obj)) return true;
    if (cJSON_IsObject(obj)) return obj->child != nullptr;
    return false;
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
        } else if (cJSON_IsNumber(mask_obj)) {
            uint8_t m = static_cast<uint8_t>(mask_obj->valueint & 0xFF);
            for (int i = 0; i < 8; i++) {
                if (match_mask & (1 << i)) {
                    byte_masks[i] = m;
                }
            }
        } else if (cJSON_IsObject(mask_obj)) {
            cJSON* m_item = nullptr;
            cJSON_ArrayForEach(m_item, mask_obj) {
                int idx = get_d_index(m_item->string);
                if (idx >= 0) {
                    if (cJSON_IsString(m_item)) {
                        byte_masks[idx] = parse_hex_string(m_item->valuestring);
                    } else if (cJSON_IsNumber(m_item)) {
                        byte_masks[idx] = static_cast<uint8_t>(m_item->valueint & 0xFF);
                    }
                }
            }
        }
    }
}

constexpr int MAX_PARSE_DEPTH = 8;
constexpr uint32_t MAX_STEP_REPEAT = 50U;
constexpr uint32_t MAX_DELAY_MS = 3600000U;      // 1 hour
constexpr uint32_t MAX_COOLDOWN_MS = 86400000U;  // 24 hours
constexpr uint32_t MAX_SUSTAINED_MS = 86400000U; // 24 hours

static uint32_t clamp_u32(cJSON* item, uint32_t min_val, uint32_t max_val, uint32_t fallback) {
    if (!item || !cJSON_IsNumber(item)) return fallback;
    double v = item->valuedouble;
    if (!std::isfinite(v)) return fallback;
    if (v < 0.0 || v < static_cast<double>(min_val)) return min_val;
    if (v > static_cast<double>(max_val)) return max_val;
    return static_cast<uint32_t>(v);
}

static void parse_hex_payload_string(const char* hex_str, uint8_t payload[8], uint8_t& mask) {
    if (!hex_str) return;
    char clean_hex[17] = {0};
    size_t clean_len = 0;
    size_t total_nibbles = 0;
    const char* ch = hex_str;
    while (*ch) {
        if (ch[0] == '0' && (ch[1] == 'x' || ch[1] == 'X')) {
            ch += 2;
            continue;
        }
        if (isxdigit(static_cast<unsigned char>(*ch))) {
            if (clean_len < 16) {
                clean_hex[clean_len++] = *ch;
            }
            total_nibbles++;
        }
        ++ch;
    }
    if ((total_nibbles & 1U) != 0U) {
        ESP_LOGW(TAG, "Odd-length hex payload '%s' (%zu nibbles); trailing nibble ignored", hex_str, total_nibbles);
    }
    for (size_t i = 0; i + 1 < clean_len && (i / 2) < 8; i += 2) {
        uint8_t byte_idx = static_cast<uint8_t>(i / 2);
        char hex_byte[3] = { clean_hex[i], clean_hex[i + 1], '\0' };
        payload[byte_idx] = static_cast<uint8_t>(strtoul(hex_byte, nullptr, 16));
        mask |= (1 << byte_idx);
    }
}

static uint32_t parse_sustained_for_ms(cJSON* item) {
    if (!item) return 0;
    uint64_t total_ms = 0;
    cJSON* f_sec = cJSON_GetObjectItem(item, "for_sec");
    if (!f_sec) f_sec = cJSON_GetObjectItem(item, "for_s");
    if (cJSON_IsNumber(f_sec)) {
        double sec = f_sec->valuedouble;
        if (std::isfinite(sec) && sec > 0.0) {
            double ms = sec * 1000.0;
            total_ms += (ms >= static_cast<double>(MAX_SUSTAINED_MS))
                            ? MAX_SUSTAINED_MS
                            : static_cast<uint32_t>(ms);
        }
    }
    cJSON* f_ms = cJSON_GetObjectItem(item, "for_ms");
    total_ms += clamp_u32(f_ms, 0, MAX_SUSTAINED_MS, 0);
    return total_ms > MAX_SUSTAINED_MS ? MAX_SUSTAINED_MS : static_cast<uint32_t>(total_ms);
}

bool parse_single_condition(cJSON* c_item, AutomationCondition& cond, int depth) {
    if (!c_item) return false;
    if (depth > MAX_PARSE_DEPTH) {
        ESP_LOGW(TAG, "Max condition nesting depth (%d) exceeded; skipping subtree", MAX_PARSE_DEPTH);
        return false;
    }

    cond.for_ms = parse_sustained_for_ms(c_item);
    if (cond.for_ms > 0) {
        cond.sustained = std::make_shared<SustainedState>();
    }

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
                cond.sub_conditions.emplace_back();
                if (!parse_single_condition(sub, cond.sub_conditions.back(), depth + 1)) {
                    cond.sub_conditions.pop_back();
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
                cond.sub_conditions.emplace_back();
                if (!parse_single_condition(sub, cond.sub_conditions.back(), depth + 1)) {
                    cond.sub_conditions.pop_back();
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
                cond.sub_conditions.emplace_back();
                if (!parse_single_condition(not_item, cond.sub_conditions.back(), depth + 1)) {
                    cond.sub_conditions.pop_back();
                }
                return true;
            }
        }
        if (cJSON_IsArray(sub_array)) {
            cJSON* sub = nullptr;
            cJSON_ArrayForEach(sub, sub_array) {
                cond.sub_conditions.emplace_back();
                if (!parse_single_condition(sub, cond.sub_conditions.back(), depth + 1)) {
                    cond.sub_conditions.pop_back();
                }
            }
        }
        return true;
    }

    // Leaf condition
    cond.logic = ConditionLogic::LEAF;
    cJSON* src_prop = cJSON_GetObjectItem(c_item, "source");
    if (cJSON_IsString(src_prop)) cond.source = src_prop->valuestring;

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

    // Check if this condition is a triggered_by condition
    cJSON* trig_id_prop = cJSON_GetObjectItem(c_item, "trigger_id");
    if ((cJSON_IsString(type_prop) && (strcmp(type_prop->valuestring, "triggered_by") == 0 || strcmp(type_prop->valuestring, "trigger") == 0)) ||
        cJSON_IsString(trig_id_prop)) {
        cond.type = "triggered_by";
        if (cJSON_IsString(trig_id_prop)) {
            cond.trigger_id = trig_id_prop->valuestring;
        }
        return true;
    }

    // Check if this condition is a device / Wi-Fi condition
    if (cJSON_IsString(type_prop) && (strcmp(type_prop->valuestring, "device_state") == 0 ||
                                      strcmp(type_prop->valuestring, "device") == 0 ||
                                      strcmp(type_prop->valuestring, "wifi_condition") == 0 ||
                                      strcmp(type_prop->valuestring, "wifi") == 0)) {
        cond.type = "device_state";
        cJSON* prop = cJSON_GetObjectItem(c_item, "device_property");
        if (!prop) prop = cJSON_GetObjectItem(c_item, "property");
        if (cJSON_IsString(prop)) cond.device_property = prop->valuestring;

        cJSON* target_str = cJSON_GetObjectItem(c_item, "target_string");
        if (!target_str) target_str = cJSON_GetObjectItem(c_item, "value");
        if (!target_str) target_str = cJSON_GetObjectItem(c_item, "ssid");
        if (!target_str) target_str = cJSON_GetObjectItem(c_item, "client_mac");
        if (!target_str) target_str = cJSON_GetObjectItem(c_item, "mac");
        if (cJSON_IsString(target_str)) cond.target_string = target_str->valuestring;

        cJSON* target_b = cJSON_GetObjectItem(c_item, "target_bool");
        if (cJSON_IsBool(target_b)) cond.target_bool = cJSON_IsTrue(target_b);

        cJSON* op = cJSON_GetObjectItem(c_item, "operator");
        if (cJSON_IsString(op)) cond.op = parse_operator(op->valuestring);

        cJSON* rssi = cJSON_GetObjectItem(c_item, "target_rssi");
        if (!rssi) rssi = cJSON_GetObjectItem(c_item, "rssi");
        if (cJSON_IsNumber(rssi)) cond.target_rssi = static_cast<int8_t>(rssi->valueint);

        return true;
    }

    // Check if this condition is a BLE button condition
    if (cJSON_IsString(type_prop) && (strcmp(type_prop->valuestring, "ble_button") == 0 ||
                                      strcmp(type_prop->valuestring, "ble_key") == 0 ||
                                      strcmp(type_prop->valuestring, "ble") == 0)) {
        cond.type = "ble_button";
        cJSON* btn = cJSON_GetObjectItem(c_item, "ble_button");
        if (!btn) btn = cJSON_GetObjectItem(c_item, "button");
        if (cJSON_IsString(btn)) cond.ble_button = btn->valuestring;

        cJSON* act = cJSON_GetObjectItem(c_item, "ble_action");
        if (!act) act = cJSON_GetObjectItem(c_item, "action");
        if (cJSON_IsString(act)) cond.ble_action = act->valuestring;
        else cond.ble_action = "press";

        cJSON* dev = cJSON_GetObjectItem(c_item, "ble_device");
        if (!dev) dev = cJSON_GetObjectItem(c_item, "device");
        if (!dev) dev = cJSON_GetObjectItem(c_item, "mac");
        if (cJSON_IsString(dev)) cond.ble_device = dev->valuestring;
        return true;
    }

    // Check if this condition is a BLE beacon presence condition
    cJSON* dp = cJSON_GetObjectItem(c_item, "device_property");
    if (cJSON_IsString(type_prop) && (strcmp(type_prop->valuestring, "ble_beacon") == 0 ||
                                      strcmp(type_prop->valuestring, "beacon") == 0 ||
                                      (strcmp(type_prop->valuestring, "ble_presence") == 0 &&
                                       (cJSON_GetObjectItem(c_item, "beacon_uuid") != nullptr ||
                                        cJSON_GetObjectItem(c_item, "uuid") != nullptr ||
                                        (cJSON_IsString(dp) && dp->valuestring &&
                                         strcmp(dp->valuestring, "beacon_present") == 0))))) {
        cond.type = "ble_beacon";
        cJSON* prop = dp;
        if (!prop) prop = cJSON_GetObjectItem(c_item, "property");
        if (cJSON_IsString(prop)) cond.device_property = prop->valuestring;
        else cond.device_property = "beacon_present";

        cJSON* uuid = cJSON_GetObjectItem(c_item, "beacon_uuid");
        if (!uuid) uuid = cJSON_GetObjectItem(c_item, "uuid");
        if (cJSON_IsString(uuid)) cond.beacon_uuid = uuid->valuestring;

        cJSON* dev = cJSON_GetObjectItem(c_item, "ble_device");
        if (!dev) dev = cJSON_GetObjectItem(c_item, "device");
        if (!dev) dev = cJSON_GetObjectItem(c_item, "mac");
        if (!dev) dev = cJSON_GetObjectItem(c_item, "client_mac");
        if (cJSON_IsString(dev)) cond.ble_device = dev->valuestring;

        cJSON* target_b = cJSON_GetObjectItem(c_item, "target_bool");
        if (cJSON_IsBool(target_b)) cond.target_bool = cJSON_IsTrue(target_b);

        cJSON* rssi = cJSON_GetObjectItem(c_item, "target_rssi");
        if (!rssi) rssi = cJSON_GetObjectItem(c_item, "rssi");
        if (cJSON_IsNumber(rssi)) cond.target_rssi = static_cast<int8_t>(rssi->valueint);

        cJSON* op = cJSON_GetObjectItem(c_item, "operator");
        if (cJSON_IsString(op)) cond.op = parse_operator(op->valuestring);

        return true;
    }

    // Check if this condition is a BLE device presence / proximity condition
    if (cJSON_IsString(type_prop) && (strcmp(type_prop->valuestring, "ble_device") == 0 ||
                                      strcmp(type_prop->valuestring, "ble_presence") == 0)) {
        cond.type = "ble_device";
        cJSON* prop = cJSON_GetObjectItem(c_item, "device_property");
        if (!prop) prop = cJSON_GetObjectItem(c_item, "property");
        if (cJSON_IsString(prop)) cond.device_property = prop->valuestring;
        else cond.device_property = "connected";

        cJSON* dev = cJSON_GetObjectItem(c_item, "ble_device");
        if (!dev) dev = cJSON_GetObjectItem(c_item, "device");
        if (!dev) dev = cJSON_GetObjectItem(c_item, "mac");
        if (!dev) dev = cJSON_GetObjectItem(c_item, "client_mac");
        if (cJSON_IsString(dev)) cond.ble_device = dev->valuestring;

        cJSON* target_b = cJSON_GetObjectItem(c_item, "target_bool");
        if (cJSON_IsBool(target_b)) cond.target_bool = cJSON_IsTrue(target_b);

        cJSON* rssi = cJSON_GetObjectItem(c_item, "target_rssi");
        if (!rssi) rssi = cJSON_GetObjectItem(c_item, "rssi");
        if (cJSON_IsNumber(rssi)) cond.target_rssi = static_cast<int8_t>(rssi->valueint);

        cJSON* op = cJSON_GetObjectItem(c_item, "operator");
        if (cJSON_IsString(op)) cond.op = parse_operator(op->valuestring);

        return true;
    }

    // Check if this condition is a voltage condition (12V auxiliary battery ADC)
    if (cJSON_IsString(type_prop) && (strcmp(type_prop->valuestring, "voltage") == 0 ||
                                      strcmp(type_prop->valuestring, "vbat") == 0)) {
        cond.type = "voltage";
        cJSON* op = cJSON_GetObjectItem(c_item, "operator");
        if (cJSON_IsString(op)) cond.op = parse_operator(op->valuestring);
        else cond.op = ConditionOperator::GREATER_THAN;

        cJSON* val = cJSON_GetObjectItem(c_item, "value");
        if (!val) val = cJSON_GetObjectItem(c_item, "voltage_val");
        if (cJSON_IsNumber(val)) cond.target_float = (float)val->valuedouble;
        else if (cJSON_IsString(val)) cond.target_float = (float)atof(val->valuestring);
        else cond.target_float = 12.0f;
        return true;
    }

    cond.type = "can_state";
    cJSON* cid = cJSON_GetObjectItem(c_item, "can_id");
    if (cJSON_IsString(cid)) cond.can_id = strtol(cid->valuestring, nullptr, 16);
    else if (cJSON_IsNumber(cid)) cond.can_id = static_cast<uint32_t>(cid->valueint);

    cJSON* bus = cJSON_GetObjectItem(c_item, "bus");
    if (cJSON_IsNumber(bus)) cond.bus = static_cast<uint8_t>(bus->valueint);

    cJSON* match_obj = cJSON_GetObjectItem(c_item, "match");
    if (!match_obj) match_obj = cJSON_GetObjectItem(c_item, "match_payload");
    cJSON* eval = cJSON_GetObjectItem(c_item, "evaluate");
    cJSON* mask_obj = eval ? cJSON_GetObjectItem(eval, "mask") : cJSON_GetObjectItem(c_item, "mask");

    // If multi-byte match map is provided (e.g. All Doors Closed or multi-selected state options), synthesize an AND_GROUP
    if (cJSON_IsObject(match_obj) && cJSON_GetArraySize(match_obj) > 1) {
        cond.logic = ConditionLogic::AND_GROUP;
        cond.type = "and_group";
        cJSON* m_item = nullptr;
        cJSON_ArrayForEach(m_item, match_obj) {
            int idx = get_d_index(m_item->string);
            if (idx >= 0) {
                AutomationCondition sub;
                sub.logic = ConditionLogic::LEAF;
                sub.type = "can_state";
                sub.can_id = cond.can_id;
                sub.bus = cond.bus;
                sub.byte_index = static_cast<uint8_t>(idx);
                sub.op = ConditionOperator::EQUAL;
                if (cJSON_IsString(m_item)) {
                    sub.target_value = parse_hex_string(m_item->valuestring);
                } else if (cJSON_IsNumber(m_item)) {
                    sub.target_value = static_cast<uint8_t>(m_item->valueint);
                }
                sub.byte_mask = 0xFF;
                if (mask_obj) {
                    if (cJSON_IsString(mask_obj)) {
                        sub.byte_mask = parse_hex_string(mask_obj->valuestring);
                    } else if (cJSON_IsObject(mask_obj)) {
                        cJSON* mask_val = cJSON_GetObjectItem(mask_obj, m_item->string);
                        if (cJSON_IsString(mask_val)) sub.byte_mask = parse_hex_string(mask_val->valuestring);
                        else if (cJSON_IsNumber(mask_val)) sub.byte_mask = static_cast<uint8_t>(mask_val->valueint);
                    }
                }
                cond.sub_conditions.push_back(sub);
            }
        }
        return true;
    }

    cJSON* b = eval ? cJSON_GetObjectItem(eval, "byte") : cJSON_GetObjectItem(c_item, "byte");
    if (cJSON_IsString(b)) {
        int idx = get_d_index(b->valuestring);
        if (idx >= 0) cond.byte_index = static_cast<uint8_t>(idx);
    } else if (cJSON_IsNumber(b)) {
        cond.byte_index = static_cast<uint8_t>(b->valueint);
    } else if (cJSON_IsObject(match_obj) && cJSON_GetArraySize(match_obj) == 1) {
        cJSON* first_item = match_obj->child;
        if (first_item) {
            int idx = get_d_index(first_item->string);
            if (idx >= 0) cond.byte_index = static_cast<uint8_t>(idx);
            if (cJSON_IsString(first_item)) cond.target_value = parse_hex_string(first_item->valuestring);
            else if (cJSON_IsNumber(first_item)) cond.target_value = static_cast<uint8_t>(first_item->valueint);
        }
    }

    cJSON* mask = mask_obj;
    if (cJSON_IsString(mask)) {
        cond.byte_mask = parse_hex_string(mask->valuestring);
    } else if (cJSON_IsNumber(mask)) {
        cond.byte_mask = static_cast<uint8_t>(mask->valueint);
    } else if (cJSON_IsObject(mask)) {
        std::string d_str = "D" + std::to_string(cond.byte_index + 1);
        cJSON* mask_val = cJSON_GetObjectItem(mask, d_str.c_str());
        if (cJSON_IsString(mask_val)) cond.byte_mask = parse_hex_string(mask_val->valuestring);
        else if (cJSON_IsNumber(mask_val)) cond.byte_mask = static_cast<uint8_t>(mask_val->valueint);
        else cond.byte_mask = 0xFF;
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

bool parse_action_step(cJSON* a_item, ActionStep& step, int depth) {
    if (!a_item) return false;
    if (depth > MAX_PARSE_DEPTH) {
        ESP_LOGW(TAG, "Max action nesting depth (%d) exceeded; skipping subtree", MAX_PARSE_DEPTH);
        return false;
    }
    cJSON* type = cJSON_GetObjectItem(a_item, "type");
    const char* type_str = cJSON_IsString(type) ? type->valuestring : "";

    if (strcmp(type_str, "entity_command") == 0) {
        step.type = ActionType::ENTITY_COMMAND;
        cJSON* eid = cJSON_GetObjectItem(a_item, "entity_id");
        if (!eid) eid = cJSON_GetObjectItem(a_item, "entity");
        cJSON* cmd = cJSON_GetObjectItem(a_item, "command");
        if (!cmd) cmd = cJSON_GetObjectItem(a_item, "option_label");
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
    } else if (strcmp(type_str, "climate_target") == 0 || strcmp(type_str, "climate") == 0 || strcmp(type_str, "remote_climate") == 0) {
        step.type = ActionType::CLIMATE_TARGET;
        cJSON* tc = cJSON_GetObjectItem(a_item, "target_c");
        if (!tc) tc = cJSON_GetObjectItem(a_item, "target_temp_c");
        if (!tc) tc = cJSON_GetObjectItem(a_item, "target_temp");
        if (!tc) tc = cJSON_GetObjectItem(a_item, "temp");
        if (cJSON_IsNumber(tc)) {
            step.target_temp_c = static_cast<float>(tc->valuedouble);
        } else {
            cJSON* tf = cJSON_GetObjectItem(a_item, "target_temp_f");
            if (!tf) tf = cJSON_GetObjectItem(a_item, "target_f");
            if (!tf) tf = cJSON_GetObjectItem(a_item, "temp_f");
            if (cJSON_IsNumber(tf)) {
                step.target_temp_c = static_cast<float>((tf->valuedouble - 32.0) * 5.0 / 9.0);
            } else {
                step.target_temp_c = 22.0f; // 72°F default
            }
        }

        cJSON* dur = cJSON_GetObjectItem(a_item, "duration_minutes");
        if (!dur) dur = cJSON_GetObjectItem(a_item, "duration_min");
        if (!dur) dur = cJSON_GetObjectItem(a_item, "duration");
        step.duration_minutes = clamp_u32(dur, 0, 1440U, 10U);

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

        cJSON* def = cJSON_GetObjectItem(a_item, "defrost");
        if (cJSON_IsBool(def)) step.defrost = cJSON_IsTrue(def);

        cJSON* mon = cJSON_GetObjectItem(a_item, "monitor_0x38");
        if (!mon) mon = cJSON_GetObjectItem(a_item, "smart");
        if (cJSON_IsBool(mon)) step.monitor_0x38 = cJSON_IsTrue(mon);
        else step.monitor_0x38 = true;

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
    } else if (strcmp(type_str, "hud_nav") == 0 || strcmp(type_str, "nav") == 0) {
        step.type = ActionType::HUD_NAV;
        cJSON* act = cJSON_GetObjectItem(a_item, "action");
        if (act && cJSON_IsString(act)) step.nav_action = act->valuestring;

        cJSON* ic = cJSON_GetObjectItem(a_item, "icon");
        if (ic && cJSON_IsNumber(ic)) step.nav_icon = static_cast<uint8_t>(ic->valueint);
        else step.nav_icon = 1;

        cJSON* dir = cJSON_GetObjectItem(a_item, "direction");
        if (!dir) dir = cJSON_GetObjectItem(a_item, "direction_deg");
        if (!dir) dir = cJSON_GetObjectItem(a_item, "heading");
        if (dir && cJSON_IsNumber(dir)) step.nav_direction_deg = static_cast<uint16_t>(dir->valueint);

        cJSON* dist = cJSON_GetObjectItem(a_item, "distance");
        if (!dist) dist = cJSON_GetObjectItem(a_item, "distance_meters");
        if (dist && cJSON_IsNumber(dist)) step.nav_distance_meters = static_cast<uint16_t>(dist->valueint);

        cJSON* bars = cJSON_GetObjectItem(a_item, "bars");
        if (bars && cJSON_IsNumber(bars)) step.nav_bars = static_cast<uint8_t>(bars->valueint);

        cJSON* spd = cJSON_GetObjectItem(a_item, "speed_limit");
        if (spd && cJSON_IsNumber(spd)) step.nav_speed_limit = static_cast<uint8_t>(spd->valueint);

        cJSON* cam = cJSON_GetObjectItem(a_item, "camera_alert");
        if (cam && cJSON_IsBool(cam)) step.nav_camera_alert = cJSON_IsTrue(cam);

        cJSON* st = cJSON_GetObjectItem(a_item, "street");
        if (st && cJSON_IsString(st)) step.nav_street = st->valuestring;

        cJSON* lanes = cJSON_GetObjectItem(a_item, "lanes");
        if (!lanes) lanes = cJSON_GetObjectItem(a_item, "num_lanes");
        if (lanes && cJSON_IsNumber(lanes)) {
            step.nav_num_lanes = static_cast<uint8_t>(lanes->valueint);
            if (step.nav_num_lanes > 8) step.nav_num_lanes = 8;
            step.nav_has_lane_guidance = true;
        }

        cJSON* lane_dirs = cJSON_GetObjectItem(a_item, "lane_directions");
        if (lane_dirs && cJSON_IsArray(lane_dirs)) {
            step.nav_has_lane_guidance = true;
            int n = cJSON_GetArraySize(lane_dirs);
            if (step.nav_num_lanes == 0 && n > 0) {
                step.nav_num_lanes = (n > 8) ? 8 : static_cast<uint8_t>(n);
            }
            for (int i = 0; i < n && i < 8; i++) {
                cJSON* elem = cJSON_GetArrayItem(lane_dirs, i);
                if (elem && cJSON_IsNumber(elem)) {
                    step.nav_lane_directions[i] = static_cast<uint8_t>(elem->valueint);
                }
            }
        }

        cJSON* lane_recs = cJSON_GetObjectItem(a_item, "lane_recommended");
        if (!lane_recs) lane_recs = cJSON_GetObjectItem(a_item, "lane_highlights");
        if (lane_recs && cJSON_IsArray(lane_recs)) {
            step.nav_has_lane_guidance = true;
            int n = cJSON_GetArraySize(lane_recs);
            for (int i = 0; i < n && i < 8; i++) {
                cJSON* elem = cJSON_GetArrayItem(lane_recs, i);
                if (elem) {
                    if (cJSON_IsBool(elem)) {
                        step.nav_lane_recommended[i] = cJSON_IsTrue(elem) ? 1 : 0;
                    } else if (cJSON_IsNumber(elem)) {
                        step.nav_lane_recommended[i] = static_cast<uint8_t>(elem->valueint);
                    }
                }
            }
        }
        return true;
    } else if (strcmp(type_str, "delay") == 0) {
        step.type = ActionType::DELAY;
        cJSON* ms = cJSON_GetObjectItem(a_item, "ms");
        if (!ms) ms = cJSON_GetObjectItem(a_item, "delay_ms");
        if (!ms) ms = cJSON_GetObjectItem(a_item, "delay");
        if (!ms) ms = cJSON_GetObjectItem(a_item, "dwell_ms");
        step.delay_ms = clamp_u32(ms, 0, MAX_DELAY_MS, 0U);
        return true;
    } else if (strcmp(type_str, "if_then") == 0 || strcmp(type_str, "if") == 0) {
        step.type = ActionType::IF_THEN;
        cJSON* conds = cJSON_GetObjectItem(a_item, "conditions");
        if (cJSON_IsArray(conds)) {
            cJSON* c_sub = nullptr;
            cJSON_ArrayForEach(c_sub, conds) {
                step.if_conditions.emplace_back();
                if (!parse_single_condition(c_sub, step.if_conditions.back(), depth + 1)) {
                    step.if_conditions.pop_back();
                }
            }
        }
        cJSON* then_arr = cJSON_GetObjectItem(a_item, "then");
        if (cJSON_IsArray(then_arr)) {
            cJSON* s_sub = nullptr;
            cJSON_ArrayForEach(s_sub, then_arr) {
                step.then_steps.emplace_back();
                if (!parse_action_step(s_sub, step.then_steps.back(), depth + 1)) {
                    step.then_steps.pop_back();
                }
            }
        }
        cJSON* else_arr = cJSON_GetObjectItem(a_item, "else");
        if (cJSON_IsArray(else_arr)) {
            cJSON* s_sub = nullptr;
            cJSON_ArrayForEach(s_sub, else_arr) {
                step.else_steps.emplace_back();
                if (!parse_action_step(s_sub, step.else_steps.back(), depth + 1)) {
                    step.else_steps.pop_back();
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
                step.choices.emplace_back();
                ChoiceBranch& branch = step.choices.back();
                cJSON* c_conds = cJSON_GetObjectItem(choice_elem, "conditions");
                if (cJSON_IsArray(c_conds)) {
                    cJSON* c_sub = nullptr;
                    cJSON_ArrayForEach(c_sub, c_conds) {
                        branch.conditions.emplace_back();
                        if (!parse_single_condition(c_sub, branch.conditions.back(), depth + 1)) {
                            branch.conditions.pop_back();
                        }
                    }
                }
                cJSON* seq_arr = cJSON_GetObjectItem(choice_elem, "sequence");
                if (cJSON_IsArray(seq_arr)) {
                    cJSON* s_sub = nullptr;
                    cJSON_ArrayForEach(s_sub, seq_arr) {
                        branch.sequence.emplace_back();
                        if (!parse_action_step(s_sub, branch.sequence.back(), depth + 1)) {
                            branch.sequence.pop_back();
                        }
                    }
                }
            }
        }
        cJSON* def_arr = cJSON_GetObjectItem(a_item, "default");
        if (cJSON_IsArray(def_arr)) {
            cJSON* s_sub = nullptr;
            cJSON_ArrayForEach(s_sub, def_arr) {
                step.default_steps.emplace_back();
                if (!parse_action_step(s_sub, step.default_steps.back(), depth + 1)) {
                    step.default_steps.pop_back();
                }
            }
        }
        cJSON* ce_meta = cJSON_GetObjectItem(a_item, "_cycle_entity");
        if (ce_meta && cJSON_IsObject(ce_meta)) {
            cJSON* dir_item = cJSON_GetObjectItem(ce_meta, "direction");
            if (dir_item && cJSON_IsString(dir_item) && strcmp(dir_item->valuestring, "ping_pong") == 0) {
                step.cycle_ping_pong = true;
                step.ping_pong_dir = std::make_shared<std::atomic<int>>(1);
            }
        }
        return true;
    } else if (strcmp(type_str, "cycle_entity") == 0) {
        step.type = ActionType::CYCLE_ENTITY;
        cJSON* eid = cJSON_GetObjectItem(a_item, "entity_id");
        if (!eid) eid = cJSON_GetObjectItem(a_item, "target_command_id");
        if (cJSON_IsString(eid) && eid->valuestring) step.entity_id = eid->valuestring;

        cJSON* states_arr = cJSON_GetObjectItem(a_item, "states");
        if (cJSON_IsArray(states_arr)) {
            cJSON* st = nullptr;
            cJSON_ArrayForEach(st, states_arr) {
                if (cJSON_IsString(st) && st->valuestring && st->valuestring[0] != '\0') {
                    step.cycle_states.emplace_back(st->valuestring);
                }
            }
        }

        cJSON* dir = cJSON_GetObjectItem(a_item, "direction");
        if (cJSON_IsString(dir) && dir->valuestring) {
            step.cycle_direction = dir->valuestring;
        } else {
            step.cycle_direction = "forward";
        }
        if (step.cycle_direction == "ping_pong") {
            step.cycle_ping_pong = true;
            step.ping_pong_dir = std::make_shared<std::atomic<int>>(1);
        }

        cJSON* wrap = cJSON_GetObjectItem(a_item, "wrap");
        if (cJSON_IsBool(wrap)) step.cycle_wrap = cJSON_IsTrue(wrap);
        else step.cycle_wrap = true;

        cJSON* fb = cJSON_GetObjectItem(a_item, "fallback_state");
        if (cJSON_IsString(fb) && fb->valuestring) step.cycle_fallback_state = fb->valuestring;
        else step.cycle_fallback_state = "__first__";

        cJSON* show_pop = cJSON_GetObjectItem(a_item, "show_popup");
        if (cJSON_IsBool(show_pop)) step.cycle_show_popup = cJSON_IsTrue(show_pop);
        else step.cycle_show_popup = true;

        cJSON* pref = cJSON_GetObjectItem(a_item, "popup_prefix");
        if (cJSON_IsString(pref) && pref->valuestring) step.cycle_popup_prefix = pref->valuestring;

        cJSON* lvl = cJSON_GetObjectItem(a_item, "level");
        if (cJSON_IsString(lvl) && lvl->valuestring) step.popup_level = lvl->valuestring;
        else step.popup_level = "info";

        return true;
    } else if (strcmp(type_str, "repeat_until") == 0 || strcmp(type_str, "wait_for") == 0) {
        step.type = (strcmp(type_str, "wait_for") == 0) ? ActionType::WAIT_FOR : ActionType::REPEAT_UNTIL;

        cJSON* interval = cJSON_GetObjectItem(a_item, "interval_ms");
        step.interval_ms = clamp_u32(interval, 0, MAX_DELAY_MS, step.interval_ms);

        cJSON* timeout = cJSON_GetObjectItem(a_item, "timeout_ms");
        if (!timeout) timeout = cJSON_GetObjectItem(a_item, "timeout");
        if (cJSON_IsNumber(timeout)) {
            uint32_t raw_t = clamp_u32(timeout, 0, MAX_DELAY_MS, step.timeout_ms);
            // If > 0 and <= 300, it's likely specified in seconds, so convert to ms; if > 300, already in ms
            step.timeout_ms = (raw_t > 0 && raw_t <= 300) ? (raw_t * 1000U) : raw_t;
        }
        cJSON* timeout_s = cJSON_GetObjectItem(a_item, "timeout_s");
        if (cJSON_IsNumber(timeout_s)) {
            uint32_t raw_s = clamp_u32(timeout_s, 0, MAX_DELAY_MS / 1000U, step.timeout_ms / 1000U);
            step.timeout_ms = raw_s * 1000U;
        }

        cJSON* cond_obj = cJSON_GetObjectItem(a_item, "condition");
        cJSON* conds_arr = cJSON_GetObjectItem(a_item, "conditions");
        if (cond_obj && cJSON_IsObject(cond_obj)) {
            parse_single_condition(cond_obj, step.condition, depth + 1);
            // If condition was a leaf but conditions array contains multiple items, treat as OR group
            if (step.condition.logic == ConditionLogic::LEAF && cJSON_IsArray(conds_arr) && cJSON_GetArraySize(conds_arr) > 1) {
                step.condition.logic = ConditionLogic::OR_GROUP;
                step.condition.type = "or_group";
                step.condition.sub_conditions.clear();
                cJSON* sub = nullptr;
                cJSON_ArrayForEach(sub, conds_arr) {
                    step.condition.sub_conditions.emplace_back();
                    if (!parse_single_condition(sub, step.condition.sub_conditions.back(), depth + 1)) {
                        step.condition.sub_conditions.pop_back();
                    }
                }
            }
        } else if (cJSON_IsArray(conds_arr)) {
            if (cJSON_GetArraySize(conds_arr) == 1) {
                parse_single_condition(cJSON_GetArrayItem(conds_arr, 0), step.condition, depth + 1);
            } else if (cJSON_GetArraySize(conds_arr) > 1) {
                step.condition.logic = ConditionLogic::OR_GROUP;
                step.condition.type = "or_group";
                cJSON* sub = nullptr;
                cJSON_ArrayForEach(sub, conds_arr) {
                    step.condition.sub_conditions.emplace_back();
                    if (!parse_single_condition(sub, step.condition.sub_conditions.back(), depth + 1)) {
                        step.condition.sub_conditions.pop_back();
                    }
                }
            }
        }

        cJSON* seq_arr = cJSON_GetObjectItem(a_item, "sequence");
        if (cJSON_IsArray(seq_arr)) {
            cJSON* s_sub = nullptr;
            cJSON_ArrayForEach(s_sub, seq_arr) {
                step.sequence.emplace_back();
                if (!parse_action_step(s_sub, step.sequence.back(), depth + 1)) {
                    step.sequence.pop_back();
                }
            }
        }
        return true;
    } else if (type_str[0] == '\0' ||
               strcmp(type_str, "transmit") == 0 ||
               strcmp(type_str, "transmit_frame") == 0 ||
               strcmp(type_str, "can_tx") == 0) {
        step.type = ActionType::TRANSMIT_FRAME;
        cJSON* cid = cJSON_GetObjectItem(a_item, "can_id");
        if (!cid) cid = cJSON_GetObjectItem(a_item, "action_can_id");
        if (cJSON_IsString(cid)) step.can_id = strtol(cid->valuestring, nullptr, 16);
        else if (cJSON_IsNumber(cid)) step.can_id = static_cast<uint32_t>(cid->valueint);

        cJSON* bus = cJSON_GetObjectItem(a_item, "bus");
        if (cJSON_IsNumber(bus)) step.bus = static_cast<uint8_t>(bus->valueint);

        cJSON* rep = cJSON_GetObjectItem(a_item, "repeat");
        if (cJSON_IsNumber(rep)) {
            uint32_t clamped = clamp_u32(rep, 1, MAX_STEP_REPEAT, 1);
            if (!std::isfinite(rep->valuedouble) || rep->valuedouble < 1.0 || rep->valuedouble > static_cast<double>(MAX_STEP_REPEAT)) {
                ESP_LOGW(TAG, "Clamped out-of-range action repeat %.0f to %lu", rep->valuedouble, (unsigned long)clamped);
            }
            step.repeat = static_cast<uint8_t>(clamped);
        }

        cJSON* del = cJSON_GetObjectItem(a_item, "delay_ms");
        if (!del) del = cJSON_GetObjectItem(a_item, "dwell_ms");
        if (!del) del = cJSON_GetObjectItem(a_item, "delay");
        if (!del) del = cJSON_GetObjectItem(a_item, "dwell");
        step.delay_ms = clamp_u32(del, 0, MAX_DELAY_MS, step.delay_ms);

        cJSON* p = cJSON_GetObjectItem(a_item, "payload");
        if (p) {
            if (cJSON_IsString(p) && p->valuestring) {
                parse_hex_payload_string(p->valuestring, step.payload, step.mask);
            } else {
                cJSON* p_item = nullptr;
                cJSON_ArrayForEach(p_item, p) {
                    int idx = get_d_index(p_item->string);
                    if (idx >= 0 && cJSON_IsString(p_item)) {
                        step.payload[idx] = parse_hex_string(p_item->valuestring);
                        step.mask |= (1 << idx);
                    }
                }
            }
        }
        return true;
    } else {
        ESP_LOGW(TAG, "Ignoring unsupported action step type '%s'", type_str);
    }
    return false;
}

static void parse_catalog_payload(cJSON* payload_json, CatalogStep& step) {
    if (!payload_json) return;
    if (cJSON_IsString(payload_json) && payload_json->valuestring) {
        parse_hex_payload_string(payload_json->valuestring, step.payload, step.mask);
    } else {
        cJSON* p_item = nullptr;
        cJSON_ArrayForEach(p_item, payload_json) {
            int idx = get_d_index(p_item->string);
            if (idx >= 0) {
                if (cJSON_IsString(p_item)) {
                    step.payload[idx] = parse_hex_string(p_item->valuestring);
                    step.mask |= (1 << idx);
                } else if (cJSON_IsNumber(p_item)) {
                    step.payload[idx] = static_cast<uint8_t>(p_item->valueint);
                    step.mask |= (1 << idx);
                }
            }
        }
    }
}

static bool parse_catalog_step(cJSON* a_item, CatalogStep& step) {
    if (!a_item) return false;
    cJSON* type = cJSON_GetObjectItem(a_item, "type");
    const char* type_str = cJSON_IsString(type) ? type->valuestring : "";

    if (strcmp(type_str, "delay") == 0) {
        step.type = ActionType::DELAY;
        cJSON* ms = cJSON_GetObjectItem(a_item, "ms");
        if (!ms) ms = cJSON_GetObjectItem(a_item, "delay_ms");
        if (!ms) ms = cJSON_GetObjectItem(a_item, "delay");
        if (!ms) ms = cJSON_GetObjectItem(a_item, "dwell_ms");
        step.delay_ms = clamp_u32(ms, 0, MAX_DELAY_MS, 0U);
        return true;
    }
    if (strcmp(type_str, "hud_nav") == 0 || strcmp(type_str, "nav") == 0) {
        step.type = ActionType::HUD_NAV;
        cJSON* ic = cJSON_GetObjectItem(a_item, "icon");
        if (ic && cJSON_IsNumber(ic)) step.nav_icon = static_cast<uint8_t>(ic->valueint);
        else step.nav_icon = 1;
        return true;
    }

    step.type = ActionType::TRANSMIT_FRAME;
    cJSON* cid = cJSON_GetObjectItem(a_item, "can_id");
    if (!cid) cid = cJSON_GetObjectItem(a_item, "action_can_id");
    if (cJSON_IsString(cid)) step.can_id = strtol(cid->valuestring, nullptr, 16);
    else if (cJSON_IsNumber(cid)) step.can_id = static_cast<uint32_t>(cid->valueint);

    cJSON* bus = cJSON_GetObjectItem(a_item, "bus");
    if (cJSON_IsNumber(bus)) step.bus = static_cast<uint8_t>(bus->valueint);

    cJSON* rep = cJSON_GetObjectItem(a_item, "repeat");
    if (cJSON_IsNumber(rep)) {
        uint32_t clamped = clamp_u32(rep, 1, MAX_STEP_REPEAT, 1);
        if (!std::isfinite(rep->valuedouble) || rep->valuedouble < 1.0 || rep->valuedouble > static_cast<double>(MAX_STEP_REPEAT)) {
            ESP_LOGW(TAG, "Clamped out-of-range catalog repeat %.0f to %lu", rep->valuedouble, (unsigned long)clamped);
        }
        step.repeat = static_cast<uint8_t>(clamped);
    }

    cJSON* del = cJSON_GetObjectItem(a_item, "delay_ms");
    if (!del) del = cJSON_GetObjectItem(a_item, "dwell_ms");
    if (!del) del = cJSON_GetObjectItem(a_item, "delay");
    if (!del) del = cJSON_GetObjectItem(a_item, "dwell");
    step.delay_ms = clamp_u32(del, 0, MAX_DELAY_MS, step.delay_ms);

    parse_catalog_payload(cJSON_GetObjectItem(a_item, "payload"), step);
    return true;
}

static void parse_steps(cJSON* steps_array, PsramVector<CatalogStep>& out_steps) {
    if (!steps_array || !cJSON_IsArray(steps_array)) return;
    int count = cJSON_GetArraySize(steps_array);
    if (count > 0) {
        out_steps.reserve(count);
    }
    cJSON* step_json = nullptr;
    cJSON_ArrayForEach(step_json, steps_array) {
        CatalogStep step;
        if (parse_catalog_step(step_json, step)) {
            out_steps.push_back(step);
        }
    }
}

static void synthesize_step_from_payload(cJSON* payload_json, const CanEntity& entity, CatalogStep& step) {
    step.type = ActionType::TRANSMIT_FRAME;
    step.can_id = entity.action_can_id ? entity.action_can_id : entity.state_can_id;
    step.bus = entity.action_bus;
    step.delay_ms = entity.delay_ms;
    parse_catalog_payload(payload_json, step);
}

bool parse_entity(cJSON* entity_json, CanEntity& out_entity, bool include_discovery_meta) {
    cJSON* id = cJSON_GetObjectItem(entity_json, "id");
    if (cJSON_IsString(id)) out_entity.id = id->valuestring;
    else return false;

    // HA Metadata
    cJSON* ha_meta = cJSON_GetObjectItem(entity_json, "ha_metadata");
    if (ha_meta) {
        cJSON* name = cJSON_GetObjectItem(ha_meta, "name");
        cJSON* domain = cJSON_GetObjectItem(ha_meta, "domain");
        cJSON* icon = include_discovery_meta ? cJSON_GetObjectItem(ha_meta, "icon") : nullptr;
        if (cJSON_IsString(name)) out_entity.ha_name = name->valuestring;
        if (cJSON_IsString(domain)) out_entity.ha_domain = domain->valuestring;
        if (icon && cJSON_IsString(icon)) out_entity.ha_icon = icon->valuestring;
    }

    // Network configuration
    cJSON* network = cJSON_GetObjectItem(entity_json, "network");
    if (network) {
        cJSON* bus_item = cJSON_GetObjectItem(network, "bus");
        if (cJSON_IsNumber(bus_item) && bus_item->valueint >= 0 && bus_item->valueint <= 4) {
            out_entity.bus = static_cast<uint8_t>(bus_item->valueint);
        }
        out_entity.action_bus = out_entity.bus;
        cJSON* action_bus_item = cJSON_GetObjectItem(network, "action_bus");
        if (cJSON_IsNumber(action_bus_item) && action_bus_item->valueint >= 0 && action_bus_item->valueint <= 4) {
            out_entity.action_bus = static_cast<uint8_t>(action_bus_item->valueint);
        }
        cJSON* state_can_id = cJSON_GetObjectItem(network, "state_can_id");
        cJSON* action_can_id = cJSON_GetObjectItem(network, "action_can_id");
        cJSON* delay = cJSON_GetObjectItem(network, "delay_ms");
        if (cJSON_IsString(state_can_id)) out_entity.state_can_id = strtol(state_can_id->valuestring, nullptr, 16);
        if (cJSON_IsString(action_can_id)) out_entity.action_can_id = strtol(action_can_id->valuestring, nullptr, 16);
        out_entity.delay_ms = clamp_u32(delay, 0, MAX_DELAY_MS, out_entity.delay_ms);

        cJSON* state_byte_item = cJSON_GetObjectItem(network, "state_byte");
        if (cJSON_IsString(state_byte_item)) {
            int sb_idx = get_d_index(state_byte_item->valuestring);
            if (sb_idx >= 0) {
                out_entity.state_byte = static_cast<int8_t>(sb_idx);
            }
        }

        cJSON* byte_len_item = cJSON_GetObjectItem(network, "byte_length");
        if (cJSON_IsNumber(byte_len_item)) {
            int bl = byte_len_item->valueint;
            if (bl == 1 || bl == 2) {
                out_entity.state_byte_length = static_cast<uint8_t>(bl);
            } else {
                ESP_LOGW(TAG, "Entity '%s': unsupported byte_length=%d (supported: 1 or 2)", out_entity.id.c_str(), bl);
                out_entity.state_byte = -1;
                out_entity.state_byte_length = 0;
            }
        }

        cJSON* endian_item = cJSON_GetObjectItem(network, "endianness");
        if (cJSON_IsString(endian_item) && endian_item->valuestring) {
            const char* e = endian_item->valuestring;
            if (strcasecmp(e, "big") == 0 || strcasecmp(e, "be") == 0 || strcasecmp(e, "motorola") == 0) {
                out_entity.state_big_endian = true;
            } else {
                out_entity.state_big_endian = false;
            }
        }

        if (out_entity.state_byte >= 0 && out_entity.state_byte_length > 0 &&
            (out_entity.state_byte + out_entity.state_byte_length) > 8) {
            ESP_LOGW(TAG, "Entity '%s': state_byte D%d with byte_length=%u exceeds 8-byte payload",
                     out_entity.id.c_str(), out_entity.state_byte + 1, out_entity.state_byte_length);
            out_entity.state_byte = -1;
        }

        cJSON* mitm_obj = cJSON_GetObjectItem(network, "mitm");
        if (cJSON_IsObject(mitm_obj)) {
            cJSON* mode_item = cJSON_GetObjectItem(mitm_obj, "mode");
            if (cJSON_IsString(mode_item) && mode_item->valuestring) {
                if (strcasecmp(mode_item->valuestring, "always") == 0) {
                    out_entity.mitm.mode = MitmMode::ALWAYS;
                } else if (strcasecmp(mode_item->valuestring, "on_demand") == 0) {
                    out_entity.mitm.mode = MitmMode::ON_DEMAND;
                } else {
                    out_entity.mitm.mode = MitmMode::NONE;
                }
            }
            cJSON* src_bus = cJSON_GetObjectItem(mitm_obj, "source_bus");
            if (cJSON_IsNumber(src_bus) && src_bus->valueint >= 0 && src_bus->valueint <= 4) {
                out_entity.mitm.source_bus = static_cast<uint8_t>(src_bus->valueint);
            }
            cJSON* dst_bus = cJSON_GetObjectItem(mitm_obj, "target_bus");
            if (cJSON_IsNumber(dst_bus) && dst_bus->valueint >= 0 && dst_bus->valueint <= 4) {
                out_entity.mitm.target_bus = static_cast<uint8_t>(dst_bus->valueint);
            }
            auto parse_id_array = [](cJSON* arr, PsramVector<uint32_t>& out_ids) {
                if (!cJSON_IsArray(arr)) return;
                cJSON* item = nullptr;
                cJSON_ArrayForEach(item, arr) {
                    if (cJSON_IsString(item) && item->valuestring && item->valuestring[0] != '\0') {
                        uint32_t cid = static_cast<uint32_t>(strtoul(item->valuestring, nullptr, 16));
                        if (cid != 0 && std::find(out_ids.begin(), out_ids.end(), cid) == out_ids.end()) {
                            out_ids.push_back(cid);
                        }
                    }
                }
            };
            parse_id_array(cJSON_GetObjectItem(mitm_obj, "block_can_ids"), out_entity.mitm.block_can_ids);
            parse_id_array(cJSON_GetObjectItem(mitm_obj, "reverse_block_can_ids"), out_entity.mitm.reverse_block_can_ids);
            cJSON* mitm_match = cJSON_GetObjectItem(mitm_obj, "match");
            if (cJSON_IsObject(mitm_match)) {
                parse_byte_match(mitm_match, out_entity.mitm.match_payload, out_entity.mitm.match_mask,
                                 out_entity.mitm.invert_mask, out_entity.mitm.byte_masks,
                                 cJSON_GetObjectItem(mitm_obj, "mask"));
                out_entity.mitm.has_match = (out_entity.mitm.match_mask != 0);
            }
            cJSON* hold_item = cJSON_GetObjectItem(mitm_obj, "hold_ms");
            if (cJSON_IsNumber(hold_item) && hold_item->valueint >= 0) {
                out_entity.mitm.hold_ms = static_cast<uint32_t>(hold_item->valueint);
            }
        }
    }

    cJSON* entity_type_item = cJSON_GetObjectItem(entity_json, "type");
    const char* ent_type = cJSON_IsString(entity_type_item) ? entity_type_item->valuestring : "";
    cJSON* net_type_item = network ? cJSON_GetObjectItem(network, "type") : nullptr;
    const char* net_type = cJSON_IsString(net_type_item) ? net_type_item->valuestring : "";
    bool is_hud_nav = (strcmp(ent_type, "hud_nav") == 0 || strcmp(net_type, "hud_nav") == 0 || out_entity.id == "hud_turn_by_turn_maneuver");

    cJSON* root_mask = cJSON_GetObjectItem(entity_json, "mask");
    cJSON* net_state_mask = network ? cJSON_GetObjectItem(network, "state_mask") : nullptr;
    cJSON* entity_fallback_mask = is_valid_mask_json(root_mask)
                                      ? root_mask
                                      : (is_valid_mask_json(net_state_mask) ? net_state_mask : nullptr);

    // Options array
    cJSON* options_array = cJSON_GetObjectItem(entity_json, "options");
    if (cJSON_IsArray(options_array) && cJSON_GetArraySize(options_array) > 0) {
        int opt_count = cJSON_GetArraySize(options_array);
        out_entity.options.reserve(opt_count);
        cJSON* opt_json = nullptr;
        cJSON_ArrayForEach(opt_json, options_array) {
            EntityOption opt;
            cJSON* label = cJSON_GetObjectItem(opt_json, "label");
            if (cJSON_IsString(label)) opt.label = label->valuestring;

            cJSON* def = cJSON_GetObjectItem(opt_json, "default");
            if (cJSON_IsBool(def)) opt.is_default = cJSON_IsTrue(def);

            cJSON* opt_mask = cJSON_GetObjectItem(opt_json, "mask");
            cJSON* effective_mask = is_valid_mask_json(opt_mask) ? opt_mask : entity_fallback_mask;
            parse_byte_match(cJSON_GetObjectItem(opt_json, "match"), opt.match_payload, opt.match_mask, opt.invert_mask, opt.byte_masks, effective_mask);
            parse_steps(cJSON_GetObjectItem(opt_json, "steps"), opt.steps);

            // If no explicit steps array but option provides CAN payload (e.g. Kids Mode / Quiet Mode), synthesize a CatalogStep
            cJSON* opt_payload = cJSON_GetObjectItem(opt_json, "payload");
            if (opt.steps.empty() && opt_payload) {
                CatalogStep step;
                synthesize_step_from_payload(opt_payload, out_entity, step);
                opt.steps.push_back(step);
            }

            // If no explicit steps array in a hud_nav entity, extract icon code from match (e.g. hud_turn_by_turn_maneuver)
            if (opt.steps.empty() && is_hud_nav) {
                CatalogStep step;
                step.type = ActionType::HUD_NAV;
                cJSON* m = cJSON_GetObjectItem(opt_json, "match");
                if (m) {
                    cJSON* d1 = cJSON_GetObjectItem(m, "D1");
                    if (d1 && cJSON_IsString(d1)) {
                        step.nav_icon = static_cast<uint8_t>(parse_hex_string(d1->valuestring));
                    }
                }
                opt.steps.push_back(step);
            }

            out_entity.options.push_back(std::move(opt));
        }
    } else {
        // Flat command: treat root match/steps/payload as a default option
        cJSON* root_match = cJSON_GetObjectItem(entity_json, "match");
        cJSON* root_steps = cJSON_GetObjectItem(entity_json, "steps");
        cJSON* root_payload = cJSON_GetObjectItem(entity_json, "payload");
        if (root_match || root_steps || root_payload) {
            EntityOption opt;
            opt.label = "Active";
            opt.is_default = true;
            parse_byte_match(root_match, opt.match_payload, opt.match_mask, opt.invert_mask, opt.byte_masks, entity_fallback_mask);
            parse_steps(root_steps, opt.steps);
            if (opt.steps.empty() && root_payload) {
                CatalogStep step;
                synthesize_step_from_payload(root_payload, out_entity, step);
                opt.steps.push_back(step);
            }
            out_entity.options.push_back(std::move(opt));
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
    out_rule.cooldown_ms = clamp_u32(cd, 0, MAX_COOLDOWN_MS, out_rule.cooldown_ms);

    cJSON* mode = cJSON_GetObjectItem(auto_json, "exec_mode");
    if (cJSON_IsString(mode)) out_rule.exec_mode = mode->valuestring;

    cJSON* ha_exp = cJSON_GetObjectItem(auto_json, "ha_expose");
    if (cJSON_IsBool(ha_exp)) out_rule.ha_expose = cJSON_IsTrue(ha_exp);

    cJSON* h_beep = cJSON_GetObjectItem(auto_json, "hold_beep");
    if (cJSON_IsBool(h_beep)) out_rule.hold_beep = cJSON_IsTrue(h_beep);

    cJSON* ha_ic = cJSON_GetObjectItem(auto_json, "ha_icon");
    if (cJSON_IsString(ha_ic)) out_rule.ha_icon = ha_ic->valuestring;

    cJSON* trig_m = cJSON_GetObjectItem(auto_json, "trigger_mode");
    if (cJSON_IsString(trig_m)) out_rule.trigger_mode = trig_m->valuestring;

    cJSON* trig_win = cJSON_GetObjectItem(auto_json, "trigger_window_ms");
    if (!trig_win) trig_win = cJSON_GetObjectItem(auto_json, "timeout_reset_ms");
    if (trig_win && cJSON_IsNumber(trig_win) && trig_win->valueint >= 500) {
        uint32_t win = static_cast<uint32_t>(trig_win->valueint);
        out_rule.trigger_window_ms = (win > 60000) ? 60000 : win;
    }

    // Triggers
    cJSON* trigs = cJSON_GetObjectItem(auto_json, "triggers");
    if (cJSON_IsArray(trigs)) {
        cJSON* t_item = nullptr;
        cJSON_ArrayForEach(t_item, trigs) {
            AutomationTrigger tr;
            cJSON* cc_item = cJSON_GetObjectItem(t_item, "click_count");
            if (cJSON_IsNumber(cc_item) && cc_item->valueint >= 1 && cc_item->valueint <= 5) {
                tr.click_count = static_cast<uint8_t>(cc_item->valueint);
            }
            tr.multi_click = std::make_shared<MultiClickState>();
            tr.for_ms = (tr.click_count > 1) ? 0 : parse_sustained_for_ms(t_item);
            if (tr.for_ms > 0) {
                tr.sustained = std::make_shared<SustainedState>();
            }
            cJSON* tid = cJSON_GetObjectItem(t_item, "id");
            if (cJSON_IsString(tid)) tr.id = tid->valuestring;

            cJSON* type = cJSON_GetObjectItem(t_item, "type");
            if (cJSON_IsString(type)) tr.type = type->valuestring;

            cJSON* src_item = cJSON_GetObjectItem(t_item, "source");
            if (cJSON_IsString(src_item)) tr.source = src_item->valuestring;

            cJSON* be = cJSON_GetObjectItem(t_item, "ble_event");
            const bool is_beacon_ble_event =
                cJSON_IsString(be) && be->valuestring &&
                (strcmp(be->valuestring, "enter") == 0 ||
                 strcmp(be->valuestring, "exit") == 0 ||
                 strcmp(be->valuestring, "present") == 0 ||
                 strcmp(be->valuestring, "away") == 0);

            if (tr.type == "time_schedule" || tr.type == "time") {
                tr.type = "time_schedule";
                cJSON* time_val = cJSON_GetObjectItem(t_item, "time");
                if (cJSON_IsString(time_val)) tr.schedule_time_min = parse_time_to_minutes(time_val->valuestring);
                tr.weekdays_mask = parse_weekdays_mask(cJSON_GetObjectItem(t_item, "days"));
            } else if (tr.type == "wifi" || tr.type == "wifi_event" || tr.type == "device_event") {
                cJSON* evt = cJSON_GetObjectItem(t_item, "wifi_event");
                if (!evt) evt = cJSON_GetObjectItem(t_item, "event");
                if (cJSON_IsString(evt)) tr.wifi_event = evt->valuestring;

                cJSON* ssid_item = cJSON_GetObjectItem(t_item, "ssid");
                if (cJSON_IsString(ssid_item)) tr.ssid = ssid_item->valuestring;

                cJSON* mac_item = cJSON_GetObjectItem(t_item, "client_mac");
                if (!mac_item) mac_item = cJSON_GetObjectItem(t_item, "mac");
                if (cJSON_IsString(mac_item)) tr.client_mac = mac_item->valuestring;

                cJSON* rssi_item = cJSON_GetObjectItem(t_item, "target_rssi");
                if (!rssi_item) rssi_item = cJSON_GetObjectItem(t_item, "rssi");
                if (cJSON_IsNumber(rssi_item)) tr.target_rssi = static_cast<int8_t>(rssi_item->valueint);
            } else if (tr.type == "ble_button" || tr.type == "ble_key" || tr.type == "ble") {
                tr.type = "ble_button";
                cJSON* btn = cJSON_GetObjectItem(t_item, "ble_button");
                if (!btn) btn = cJSON_GetObjectItem(t_item, "button");
                if (cJSON_IsString(btn)) tr.ble_button = btn->valuestring;

                cJSON* act = cJSON_GetObjectItem(t_item, "ble_action");
                if (!act) act = cJSON_GetObjectItem(t_item, "action");
                if (cJSON_IsString(act)) tr.ble_action = act->valuestring;
                else tr.ble_action = "press";

                if (strcasecmp(tr.ble_action.c_str(), "double_press") == 0) {
                    tr.ble_action = "press";
                    if (tr.click_count <= 1) tr.click_count = 2;
                } else if (strcasecmp(tr.ble_action.c_str(), "triple_press") == 0) {
                    tr.ble_action = "press";
                    if (tr.click_count <= 1) tr.click_count = 3;
                }

                cJSON* dev = cJSON_GetObjectItem(t_item, "ble_device");
                if (!dev) dev = cJSON_GetObjectItem(t_item, "device");
                if (!dev) dev = cJSON_GetObjectItem(t_item, "mac");
                if (cJSON_IsString(dev)) tr.ble_device = dev->valuestring;
            } else if (tr.type == "ble_beacon" || tr.type == "beacon" ||
                       ((tr.type == "ble_presence" || tr.source == "ble") &&
                        (cJSON_GetObjectItem(t_item, "beacon_uuid") != nullptr ||
                         cJSON_GetObjectItem(t_item, "uuid") != nullptr ||
                         is_beacon_ble_event))) {
                tr.type = "ble_beacon";
                cJSON* evt = be;
                if (!evt) evt = cJSON_GetObjectItem(t_item, "event");
                if (cJSON_IsString(evt)) tr.ble_event = evt->valuestring;
                else tr.ble_event = "present";

                cJSON* uuid = cJSON_GetObjectItem(t_item, "beacon_uuid");
                if (!uuid) uuid = cJSON_GetObjectItem(t_item, "uuid");
                if (cJSON_IsString(uuid)) tr.beacon_uuid = uuid->valuestring;

                cJSON* dev = cJSON_GetObjectItem(t_item, "ble_device");
                if (!dev) dev = cJSON_GetObjectItem(t_item, "device");
                if (!dev) dev = cJSON_GetObjectItem(t_item, "mac");
                if (!dev) dev = cJSON_GetObjectItem(t_item, "client_mac");
                if (cJSON_IsString(dev)) tr.ble_device = dev->valuestring;

                cJSON* maj = cJSON_GetObjectItem(t_item, "beacon_major");
                if (!maj) maj = cJSON_GetObjectItem(t_item, "major");
                if (cJSON_IsNumber(maj)) tr.beacon_major = static_cast<uint16_t>(maj->valueint);

                cJSON* min = cJSON_GetObjectItem(t_item, "beacon_minor");
                if (!min) min = cJSON_GetObjectItem(t_item, "minor");
                if (cJSON_IsNumber(min)) tr.beacon_minor = static_cast<uint16_t>(min->valueint);

                cJSON* rssi_item = cJSON_GetObjectItem(t_item, "target_rssi");
                if (!rssi_item) rssi_item = cJSON_GetObjectItem(t_item, "rssi");
                if (cJSON_IsNumber(rssi_item)) tr.target_rssi = static_cast<int8_t>(rssi_item->valueint);
            } else if (tr.type == "ble_device_event" || tr.type == "ble_device" || tr.type == "ble_presence" || tr.source == "ble") {
                tr.type = "ble_device_event";
                cJSON* evt = cJSON_GetObjectItem(t_item, "ble_event");
                if (!evt) evt = cJSON_GetObjectItem(t_item, "event");
                if (cJSON_IsString(evt)) tr.ble_event = evt->valuestring;
                else tr.ble_event = "connected";

                cJSON* dev = cJSON_GetObjectItem(t_item, "ble_device");
                if (!dev) dev = cJSON_GetObjectItem(t_item, "device");
                if (!dev) dev = cJSON_GetObjectItem(t_item, "mac");
                if (!dev) dev = cJSON_GetObjectItem(t_item, "client_mac");
                if (cJSON_IsString(dev)) tr.ble_device = dev->valuestring;

                cJSON* rssi_item = cJSON_GetObjectItem(t_item, "target_rssi");
                if (!rssi_item) rssi_item = cJSON_GetObjectItem(t_item, "rssi");
                if (cJSON_IsNumber(rssi_item)) tr.target_rssi = static_cast<int8_t>(rssi_item->valueint);
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

                        cJSON* op_item = cJSON_GetObjectItem(t_item, "operator");
                        if (cJSON_IsString(op_item)) {
                            tr.op = parse_operator(op_item->valuestring);
                        }

                        cJSON* from_item = cJSON_GetObjectItem(t_item, "from");
                        cJSON* to_item = cJSON_GetObjectItem(t_item, "to");
                        if (!to_item) to_item = cJSON_GetObjectItem(t_item, "value");
                        if (cJSON_IsString(from_item)) {
                            tr.from_value = parse_hex_string(from_item->valuestring);
                            tr.has_from_value = true;
                        }
                        if (cJSON_IsString(to_item)) {
                            tr.to_value = parse_hex_string(to_item->valuestring);
                            tr.match_payload[b_idx] = tr.to_value;
                            tr.match_mask |= (1 << b_idx);
                        } else if (cJSON_IsNumber(to_item)) {
                            tr.to_value = static_cast<uint8_t>(to_item->valueint);
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
            out_rule.conditions.emplace_back();
            if (!parse_single_condition(c_item, out_rule.conditions.back(), 0)) {
                out_rule.conditions.pop_back();
            }
        }
    }

    // Actions
    cJSON* acts = cJSON_GetObjectItem(auto_json, "actions");
    if (cJSON_IsArray(acts)) {
        cJSON* a_item = nullptr;
        cJSON_ArrayForEach(a_item, acts) {
            out_rule.actions.emplace_back();
            if (!parse_action_step(a_item, out_rule.actions.back(), 0)) {
                out_rule.actions.pop_back();
            }
        }
    }

    return true;
}

template<typename Handler>
static bool stream_parse_array_from_file(FILE* f, const char* target_key, Handler handler) {
    if (!f || !target_key) return false;

    // Note: I/O buffering is handled via heap in load_catalog_from_fs

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

    if (!found_key) {
        ESP_LOGW(TAG, "stream_parse: key '%s' not found in file", target_key);
        return false;
    }

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
            if (!in_str && (c == ' ' || c == '\n' || c == '\r' || c == '\t')) {
                continue;
            }
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
            if (obj_buf.capacity() > 4096) {
                std::string().swap(obj_buf);
                obj_buf.reserve(2048);
            } else {
                obj_buf.clear();
            }
            if (item_json) {
                bool keep_going = true;
                if constexpr (std::is_same_v<std::invoke_result_t<Handler, cJSON*>, bool>) {
                    keep_going = handler(item_json);
                } else {
                    handler(item_json);
                }
                cJSON_Delete(item_json);
                parsed_count++;
                if (!keep_going) {
                    break;
                }
                if (parsed_count % 5 == 0) {
                    vTaskDelay(pdMS_TO_TICKS(1)); // Feed FreeRTOS watchdog & allow network stack to breathe
                }
            }
        }
    }

    ESP_LOGI(TAG, "stream_parse: key '%s' finished with %d items", target_key, parsed_count);
    return parsed_count > 0;
}

bool load_catalog_from_fs(const char* filepath) {
    size_t total_before = esp_get_free_heap_size();
    size_t internal_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    ESP_LOGI(TAG, "Loading catalog from %s (free heap: %lu, internal free: %lu)",
             filepath, (unsigned long)total_before, (unsigned long)internal_before);
    // On ESP32-C3 CAN coprocessor mode, catalog and UI are hosted and executed on the UI bridge.
    // Full catalog parsing into C3 RAM requires >150KB heap; skip if heap is low to prevent bad_alloc abort.
    if (total_before < 120000) {
        ESP_LOGI(TAG, "Skipping catalog RAM caching to preserve memory for CAN coprocessor.");
        return true;
    }
#if CONFIG_SPIRAM
    if (internal_before < 40960 && global_catalog.empty()) {
        ESP_LOGW(TAG, "Skipping catalog RAM caching to preserve internal DRAM (%lu B free)",
                 (unsigned long)internal_before);
        return true;
    }
#endif
    struct stat st;
    if (stat(filepath, &st) != 0) {
        ESP_LOGE(TAG, "Failed to stat catalog file: %s", filepath);
        return false;
    }
    long size = st.st_size;

    FILE* f = fopen(filepath, "r");
    if (!f) {
        ESP_LOGE(TAG, "Failed to open catalog file: %s", filepath);
        return false;
    }
    // Heap-backed 4KB I/O buffer (automatically freed on fclose by libc)
    setvbuf(f, nullptr, _IOFBF, 4096);

    PsramVector<CanEntity> new_catalog;
    std::vector<AutomationRule> new_autos;

    auto commit_catalog = [&]() {
        size_t cat_count = 0;
        size_t auto_count = 0;
        size_t id_count = 0;
        {
            std::lock_guard<std::mutex> cat_lock(g_catalog_mutex);
            std::lock_guard<std::mutex> auto_lock(g_automations_mutex);
            global_catalog.swap(new_catalog);
            s_dynamic_entities.clear();
            rebuild_catalog_can_id_index_locked();
            if (!new_autos.empty()) {
                global_automations.swap(new_autos);
                g_automations_gen.fetch_add(1, std::memory_order_release);
            }
            cat_count = global_catalog.size();
            auto_count = global_automations.size();
            id_count = catalog_by_can_id.size();
        }
        size_t internal_after = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        ESP_LOGI(TAG, "Catalog loaded: %zu entities, %zu automations, %zu indexed CAN IDs (internal free: %lu B)",
                 cat_count, auto_count, id_count, (unsigned long)internal_after);
        if (internal_after < 49152) {
            ESP_LOGW(TAG, "Low internal DRAM after catalog load (%lu B < 48 KB); MQTT/Wi-Fi/OTA allocations at risk",
                     (unsigned long)internal_after);
        }
    };

    // For large catalog files (> 16KB), use low-RAM streaming parser
    if (size > 16384) {
        ESP_LOGI(TAG, "Using low-memory streaming parser for large catalog (%ld bytes)", size);

        // 1. Parse "commands" (fallback to "entities")
        fseek(f, 0, SEEK_SET);
        clearerr(f);
        bool ok = stream_parse_array_from_file(f, "commands", [&](cJSON* cmd_json) {
            CanEntity entity;
            if (parse_entity(cmd_json, entity, false)) {
                new_catalog.push_back(std::move(entity));
            }
        });
        if (!ok) {
            fseek(f, 0, SEEK_SET);
            clearerr(f);
            stream_parse_array_from_file(f, "entities", [&](cJSON* cmd_json) {
                CanEntity entity;
                if (parse_entity(cmd_json, entity, false)) {
                    new_catalog.push_back(std::move(entity));
                }
            });
        }

        // 2. Parse "automations" if present
        fseek(f, 0, SEEK_SET);
        clearerr(f);
        stream_parse_array_from_file(f, "automations", [&](cJSON* auto_json) {
            AutomationRule rule;
            if (parse_automation(auto_json, rule)) {
                new_autos.push_back(rule);
            }
        });

        fclose(f);
        if (new_catalog.empty()) {
            return false;
        }
        commit_catalog();
        return true;
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
            if (parse_entity(cmd_json, entity, false)) {
                new_catalog.push_back(std::move(entity));
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
                new_autos.push_back(rule);
            }
        }
    }

    cJSON_Delete(root);
    commit_catalog();
    return true;
}

bool stream_catalog_entities(std::function<bool(const CanEntity&)> callback) {
    const char* paths[] = {"/spiffs/catalog.json", "/spiffs/can_do_catalog.json"};
    FILE* f = nullptr;
    for (const char* p : paths) {
        f = fopen(p, "r");
        if (f) break;
    }
    if (!f) {
        ESP_LOGW(TAG, "No catalog file found for streaming");
        return false;
    }

    setvbuf(f, nullptr, _IOFBF, 2048);

    bool user_stopped = false;
    bool ok = stream_parse_array_from_file(f, "commands", [&](cJSON* cmd_json) -> bool {
        CanEntity entity;
        if (parse_entity(cmd_json, entity)) {
            if (!callback(entity)) {
                user_stopped = true;
                return false;
            }
        }
        return true;
    });

    if (!ok && !user_stopped) {
        fseek(f, 0, SEEK_SET);
        clearerr(f);
        stream_parse_array_from_file(f, "entities", [&](cJSON* cmd_json) -> bool {
            CanEntity entity;
            if (parse_entity(cmd_json, entity)) {
                if (!callback(entity)) {
                    user_stopped = true;
                    return false;
                }
            }
            return true;
        });
    }

    fclose(f);
    return true;
}

bool find_entity_in_catalog(const std::string& entity_id, CanEntity& out_entity) {
    if (entity_id.empty()) return false;

    {
        std::lock_guard<std::mutex> lock(g_catalog_mutex);
        // 1. Check global_catalog
        for (const auto& ent : global_catalog) {
            if (ent.id == entity_id) {
                out_entity = ent;
                return true;
            }
        }

        // 2. Check dynamic loaded entities
        for (const auto& ent : s_dynamic_entities) {
            if (ent.id == entity_id) {
                out_entity = ent;
                return true;
            }
        }
    }

    // 3. Search catalog file on LittleFS without constructing CanEntity for non-matching items
    const char* paths[] = {"/spiffs/catalog.json", "/spiffs/can_do_catalog.json"};
    FILE* f = nullptr;
    for (const char* p : paths) {
        f = fopen(p, "r");
        if (f) break;
    }
    if (!f) {
        return false;
    }

    setvbuf(f, nullptr, _IOFBF, 2048);

    bool found = false;
    auto match_handler = [&](cJSON* cmd_json) -> bool {
        cJSON* id_item = cJSON_GetObjectItem(cmd_json, "id");
        if (cJSON_IsString(id_item) && id_item->valuestring && entity_id == id_item->valuestring) {
            if (parse_entity(cmd_json, out_entity)) {
                found = true;
                return false; // Stop streaming
            }
        }
        return true; // Continue
    };

    bool ok = stream_parse_array_from_file(f, "commands", match_handler);
    if (!ok && !found) {
        fseek(f, 0, SEEK_SET);
        clearerr(f);
        stream_parse_array_from_file(f, "entities", match_handler);
    }
    fclose(f);

    if (found) {
        std::lock_guard<std::mutex> lock(g_catalog_mutex);
        bool exists = false;
        for (const auto& ent : s_dynamic_entities) {
            if (ent.id == out_entity.id) {
                exists = true;
                break;
            }
        }
        if (!exists) {
            bool evicted = false;
            if (s_dynamic_entities.size() >= 32) {
                s_dynamic_entities.pop_front();
                evicted = true;
            }
            s_dynamic_entities.push_back(out_entity);
            if (evicted) {
                rebuild_catalog_can_id_index_locked();
            } else {
                CanEntity* ptr = &s_dynamic_entities.back();
                if (ptr->state_can_id > 0) {
                    catalog_by_can_id[ptr->state_can_id].push_back(ptr);
                }
                if (ptr->mitm.mode != MitmMode::NONE) {
                    rebuild_mitm_rules_locked();
                }
            }
        }
        return true;
    }

    return false;
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

    std::vector<AutomationRule> new_rules;

    cJSON* rules_array = nullptr;
    if (cJSON_IsArray(root)) {
        rules_array = root;
    } else if (cJSON_IsObject(root)) {
        cJSON* settings_obj = cJSON_GetObjectItem(root, "settings");
        if (cJSON_IsObject(settings_obj)) {
            cJSON* tz = cJSON_GetObjectItem(settings_obj, "timezone");
            if (cJSON_IsString(tz) && tz->valuestring && strlen(tz->valuestring) > 0) {
                timezone_mgr_set_ext(tz->valuestring, false);
            }
        }
        rules_array = cJSON_GetObjectItem(root, "rules");
        if (!rules_array) rules_array = cJSON_GetObjectItem(root, "automations");
    }

    if (cJSON_IsArray(rules_array)) {
        cJSON* auto_json = nullptr;
        cJSON_ArrayForEach(auto_json, rules_array) {
            AutomationRule rule;
            if (parse_automation(auto_json, rule)) {
                new_rules.push_back(rule);
            }
        }
    }

    cJSON_Delete(root);

    // Preload entities referenced in automations (triggers, actions) before acquiring g_automations_mutex
    std::unordered_set<std::string> referenced_entities;
    std::function<void(const std::vector<ActionStep>&, int)> collect_from_steps;
    collect_from_steps = [&](const std::vector<ActionStep>& steps, int depth) {
        if (depth > MAX_PARSE_DEPTH) {
            ESP_LOGW(TAG, "Max action nesting depth (%d) exceeded while collecting entities; skipping subtree", MAX_PARSE_DEPTH);
            return;
        }
        for (const auto& s : steps) {
            if (!s.entity_id.empty()) referenced_entities.insert(s.entity_id);
            collect_from_steps(s.then_steps, depth + 1);
            collect_from_steps(s.else_steps, depth + 1);
            for (const auto& ch : s.choices) {
                collect_from_steps(ch.sequence, depth + 1);
            }
            collect_from_steps(s.default_steps, depth + 1);
            collect_from_steps(s.sequence, depth + 1);
        }
    };

    for (const auto& rule : new_rules) {
        collect_from_steps(rule.actions, 0);
    }

    if (!referenced_entities.empty()) {
        ESP_LOGI(TAG, "Pre-loading %zu entities referenced in automations...", referenced_entities.size());
        CanEntity ent;
        for (const auto& eid : referenced_entities) {
            ent = CanEntity{};
            find_entity_in_catalog(eid, ent);
        }
    }

    size_t active_count = 0;
    {
        std::lock_guard<std::mutex> lock(g_automations_mutex);
        global_automations.swap(new_rules);
        active_count = global_automations.size();
        g_automations_gen.fetch_add(1, std::memory_order_release);
    }

    ESP_LOGI(TAG, "Automations loaded: %zu active rules from %s", active_count, filepath);
    return true;
}


