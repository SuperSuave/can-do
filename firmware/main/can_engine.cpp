#include "can_engine.h"
#include "parser.h"
#include "api.h"
#include "gvret_server.h"
#include <cstring>
#include <ctime>
#include <cmath>
#include <algorithm>
#include <cctype>
#include <sys/time.h>
#include "esp_log.h"
#include "mqtt_client.h"
#include "esp_timer.h"
#include "track_popup.h"
#include "hud_nav.h"
#include "precondition.h"
#include "board_pins.h"
#include "can.h"
#include "mqtt_mgr.h"
#include "uds_engine.h"
#include "network_mgr.h"
#include "remote_climate.h"

static bool mac_matches(const std::string& a, const std::string& b) {
    std::string clean_a, clean_b;
    for (char c : a) { if (isxdigit((unsigned char)c)) clean_a += (char)tolower((unsigned char)c); }
    for (char c : b) { if (isxdigit((unsigned char)c)) clean_b += (char)tolower((unsigned char)c); }
    return !clean_a.empty() && clean_a == clean_b;
}


#if defined(_WIN32) && !defined(__GNUC__)
#define strcasecmp _stricmp
#endif

extern "C" esp_err_t can_send(can_bus_t bus, twai_message_t *message, TickType_t ticks_to_wait) {
    (void)bus;
    if (!message) return ESP_ERR_INVALID_ARG;
    twai_status_info_t info;
    if (twai_get_status_info(&info) != ESP_OK || info.state != TWAI_STATE_RUNNING) {
        return ESP_ERR_INVALID_STATE;
    }
    // Suppress TX when bus error counter is elevated (Error Passive) to prevent triggering BUS_OFF on silent/disconnected bus
    if (info.tx_error_counter >= 128) {
        ESP_LOGW("CAN_ENGINE", "CAN TX suppressed: TEC=%lu (Error Passive: disconnected or silent bus)", (unsigned long)info.tx_error_counter);
        return ESP_ERR_INVALID_STATE;
    }
    // Single-Shot mode: never loop in hardware retries on unacknowledged frames, eliminating BUS_OFF
    message->ss = 1;
    return twai_transmit(message, ticks_to_wait);
}

static const char* TAG = "CAN_ENGINE";

#include "esp_attr.h"

static RTC_NOINIT_ATTR RtcCrashInfo s_rtc_crash;

const RtcCrashInfo* get_rtc_crash_info(void) {
    if (s_rtc_crash.magic == 0xDEADBEEF) {
        return &s_rtc_crash;
    }
    return nullptr;
}

void rtc_crash_record(uint32_t can_id, uint8_t dlc, const uint8_t* data, uint32_t step, const char* decoder) {
    s_rtc_crash.magic = 0xDEADBEEF;
    s_rtc_crash.can_id = can_id;
    s_rtc_crash.dlc = dlc;
    if (data && dlc > 0) {
        memcpy(s_rtc_crash.data, data, dlc > 8 ? 8 : dlc);
    }
    s_rtc_crash.step_marker = step;
    if (decoder) {
        strncpy(s_rtc_crash.last_decoder, decoder, sizeof(s_rtc_crash.last_decoder) - 1);
        s_rtc_crash.last_decoder[sizeof(s_rtc_crash.last_decoder) - 1] = '\0';
    }
}

static std::string s_current_firing_trigger_id = "";

struct LastBleEvent {
    std::string address;
    std::string button;
    std::string combo;
    std::string action;
    uint32_t timestamp_ms = 0;
};
static LastBleEvent s_last_ble_event;

struct BleDeviceInfo {
    std::string address;
    std::string name;
    bool connected = false;
    int8_t rssi = -100;
    uint32_t last_seen_ms = 0;
};
static std::unordered_map<std::string, BleDeviceInfo> s_ble_devices;
static uint32_t s_wait_for_start_ms = 0;

struct BleBeaconState {
    std::string uuid;
    std::string mac;
    std::string name;
    int8_t rssi = -100;
    uint16_t major = 0;
    uint16_t minor = 0;
    bool present = false;
    uint32_t last_seen_ms = 0;
};
static std::unordered_map<std::string, BleBeaconState> s_ble_beacons;

std::unordered_map<uint32_t, std::array<uint8_t, 8>> can_state_cache;
QueueHandle_t tx_command_queue = nullptr;
extern esp_mqtt_client_handle_t global_mqtt_client;

std::atomic<bool> g_automations_enabled{true};
std::atomic<bool> g_sniffer_mode{false};
std::atomic<bool> g_hardware_listen_only{false};
std::atomic<bool> g_twai_reconfig_pending{false};
std::atomic<twai_mode_t> g_twai_requested_mode{TWAI_MODE_NORMAL};

void set_automations_enabled(bool enabled) {
    g_automations_enabled.store(enabled);
    ESP_LOGI(TAG, "Automations execution: %s", enabled ? "ENABLED" : "DISABLED");
}

void set_sniffer_mode(bool enabled, bool hardware_listen_only) {
    g_sniffer_mode.store(enabled);
    g_hardware_listen_only.store(hardware_listen_only);

    twai_mode_t target_mode = (enabled && hardware_listen_only) ? TWAI_MODE_LISTEN_ONLY : TWAI_MODE_NORMAL;
    if (target_mode != g_twai_requested_mode.load()) {
        g_twai_requested_mode.store(target_mode);
        g_twai_reconfig_pending.store(true);
        ESP_LOGI(TAG, "Requesting TWAI mode switch to: %s",
                 target_mode == TWAI_MODE_LISTEN_ONLY ? "LISTEN_ONLY (No PHY ACK)" : "NORMAL (PHY ACK)");
    }
    ESP_LOGI(TAG, "Sniffer mode: %s (HW listen-only=%d)", enabled ? "ACTIVE" : "OFF", hardware_listen_only ? 1 : 0);
}

static std::mutex s_cache_mutex;

bool get_cached_can_frame(uint32_t can_id, uint8_t out_data[8]) {
    std::lock_guard<std::mutex> lock(s_cache_mutex);
    auto it = can_state_cache.find(can_id);
    bool found = (it != can_state_cache.end());
    if (found && out_data) {
        memcpy(out_data, it->second.data(), 8);
    }
    return found;
}

bool can_state_cache_get(uint32_t can_id, uint8_t byte_index, uint32_t* out_val) {
    uint8_t data[8];
    if (get_cached_can_frame(can_id, data) && byte_index < 8) {
        if (out_val) *out_val = data[byte_index];
        return true;
    }
    return false;
}

void init_can_engine(void) {
    if (!tx_command_queue) {
        tx_command_queue = xQueueCreate(16, sizeof(CanBurstCmd*));
    }
    hud_nav_init(HUD_PLATFORM_EGMP_CANFD);
}

void update_state_cache(uint32_t can_id, const uint8_t* data) {
    std::array<uint8_t, 8> payload;
    memcpy(payload.data(), data, 8);
    std::lock_guard<std::mutex> lock(s_cache_mutex);
    can_state_cache[can_id] = payload;
}

bool evaluate_condition(const AutomationCondition& cond) {
    switch (cond.logic) {
        case ConditionLogic::AND_GROUP: {
            for (const auto& sub : cond.sub_conditions) {
                if (!evaluate_condition(sub)) return false;
            }
            return true;
        }
        case ConditionLogic::OR_GROUP: {
            if (cond.sub_conditions.empty()) return false;
            for (const auto& sub : cond.sub_conditions) {
                if (evaluate_condition(sub)) return true;
            }
            return false;
        }
        case ConditionLogic::NOT_GROUP: {
            if (cond.sub_conditions.empty()) return true;
            for (const auto& sub : cond.sub_conditions) {
                if (evaluate_condition(sub)) return false;
            }
            return true;
        }
        case ConditionLogic::LEAF:
        default: {
            if (cond.type == "triggered_by") {
                if (cond.trigger_id.empty()) return true;
                return cond.trigger_id == s_current_firing_trigger_id;
            }

            if (cond.type == "time_condition") {
                time_t now;
                time(&now);
                struct tm timeinfo;
                localtime_r(&now, &timeinfo);

                // Check day of week (bit 0=Sun .. bit 6=Sat)
                if ((cond.weekdays_mask & (1 << timeinfo.tm_wday)) == 0) {
                    return false;
                }

                uint16_t cur_min = static_cast<uint16_t>(timeinfo.tm_hour * 60 + timeinfo.tm_min);

                // Normal daytime window (e.g. 08:00 to 18:00)
                if (cond.start_time_min <= cond.end_time_min) {
                    return cur_min >= cond.start_time_min && cur_min <= cond.end_time_min;
                } else {
                    // Overnight window spanning midnight (e.g. 22:00 to 06:00)
                    return cur_min >= cond.start_time_min || cur_min <= cond.end_time_min;
                }
            }

            if (cond.type == "device_state" || cond.type == "wifi_condition" || cond.type == "wifi") {
                NetworkStatusInfo net_status = network_mgr_get_status();
                if (cond.device_property == "wifi_ssid" || cond.device_property == "ssid") {
                    if (cond.op == ConditionOperator::NOT_EQUAL) {
                        return strcasecmp(net_status.sta_ssid.c_str(), cond.target_string.c_str()) != 0;
                    }
                    return strcasecmp(net_status.sta_ssid.c_str(), cond.target_string.c_str()) == 0;
                } else if (cond.device_property == "wifi_connected" || cond.device_property == "connected") {
                    return net_status.sta_connected == cond.target_bool;
                } else if (cond.device_property == "wifi_mode" || cond.device_property == "ap_mode") {
                    if (cond.target_string == "ap") return net_status.ap_active && !net_status.sta_connected;
                    if (cond.target_string == "sta") return net_status.sta_connected && !net_status.ap_active;
                    if (cond.target_string == "both" || cond.target_string == "ap_sta") return net_status.ap_active && net_status.sta_connected;
                    return net_status.ap_active == cond.target_bool;
                } else if (cond.device_property == "ap_client_connected") {
                    auto stations = network_mgr_get_ap_stations();
                    if (cond.target_string.empty()) {
                        return cond.target_bool ? !stations.empty() : stations.empty();
                    }
                    bool found = false;
                    for (const auto& sta : stations) {
                        if (mac_matches(sta.mac, cond.target_string)) {
                            found = true;
                            break;
                        }
                    }
                    return found == cond.target_bool;
                } else if (cond.device_property == "ap_client_rssi") {
                    auto stations = network_mgr_get_ap_stations();
                    for (const auto& sta : stations) {
                        if (cond.target_string.empty() || mac_matches(sta.mac, cond.target_string)) {
                            switch (cond.op) {
                                case ConditionOperator::GREATER_THAN: return sta.rssi > cond.target_rssi;
                                case ConditionOperator::LESS_THAN:    return sta.rssi < cond.target_rssi;
                                case ConditionOperator::EQUAL:        return sta.rssi == cond.target_rssi;
                                case ConditionOperator::NOT_EQUAL:    return sta.rssi != cond.target_rssi;
                                default: return sta.rssi >= cond.target_rssi;
                            }
                        }
                    }
                    return false;
                }
                return false;
            }

            if (cond.type == "ble_button" || cond.type == "ble" || cond.type == "bluetooth") {
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                uint32_t threshold_ms = (s_wait_for_start_ms > 0) ? s_wait_for_start_ms : (now_ms > 2500 ? now_ms - 2500 : 0);
                if (s_last_ble_event.timestamp_ms < threshold_ms) {
                    return false;
                }

                const std::string& target_btn = !cond.ble_button.empty() ? cond.ble_button : cond.target_string;
                if (!target_btn.empty() && target_btn != "any") {
                    bool btn_match = (strcasecmp(target_btn.c_str(), s_last_ble_event.button.c_str()) == 0);
                    if (!btn_match && !s_last_ble_event.combo.empty()) {
                        btn_match = (strcasecmp(target_btn.c_str(), s_last_ble_event.combo.c_str()) == 0);
                    }
                    if (!btn_match) {
                        return false;
                    }
                }

                if (!cond.ble_action.empty() && cond.ble_action != "any") {
                    bool act_match = (strcasecmp(cond.ble_action.c_str(), s_last_ble_event.action.c_str()) == 0);
                    if (!act_match && cond.ble_action == "press" && s_last_ble_event.action.rfind("combo_", 0) == 0) {
                        act_match = true;
                    }
                    if (!act_match) return false;
                }

                const std::string& target_dev = !cond.ble_device.empty() ? cond.ble_device : cond.target_string;
                if (!target_dev.empty()) {
                    if (!mac_matches(target_dev, s_last_ble_event.address)) {
                        return false;
                    }
                }

                return true;
            }

            if (cond.type == "ble_device" || cond.type == "ble_presence") {
                const std::string& target_dev = !cond.ble_device.empty() ? cond.ble_device : cond.target_string;
                if (target_dev.empty()) {
                    if (cond.device_property == "connected") {
                        for (const auto& kv : s_ble_devices) {
                            if (kv.second.connected) return cond.target_bool;
                        }
                        return !cond.target_bool;
                    }
                    return false;
                }

                for (const auto& kv : s_ble_devices) {
                    if (mac_matches(target_dev, kv.second.address) || strcasecmp(target_dev.c_str(), kv.second.name.c_str()) == 0) {
                        if (cond.device_property == "connected") {
                            return kv.second.connected == cond.target_bool;
                        } else if (cond.device_property == "rssi" || cond.device_property == "proximity") {
                            switch (cond.op) {
                                case ConditionOperator::GREATER_THAN: return kv.second.rssi > cond.target_rssi;
                                case ConditionOperator::LESS_THAN:    return kv.second.rssi < cond.target_rssi;
                                case ConditionOperator::EQUAL:        return kv.second.rssi == cond.target_rssi;
                                case ConditionOperator::NOT_EQUAL:    return kv.second.rssi != cond.target_rssi;
                                default: return kv.second.rssi >= cond.target_rssi;
                            }
                        }
                    }
                }
                return (cond.device_property == "connected") ? (!cond.target_bool) : false;
            }

            if (cond.type == "ble_beacon" || cond.type == "beacon") {
                const std::string& target_uuid = !cond.beacon_uuid.empty() ? cond.beacon_uuid : (!cond.ble_device.empty() ? cond.ble_device : cond.target_string);
                if (target_uuid.empty()) {
                    for (const auto& kv : s_ble_beacons) {
                        if (kv.second.present) return cond.target_bool;
                    }
                    return !cond.target_bool;
                }

                for (const auto& kv : s_ble_beacons) {
                    bool match = false;
                    if (!kv.second.uuid.empty() && strcasestr(kv.second.uuid.c_str(), target_uuid.c_str()) != nullptr) match = true;
                    if (!kv.second.mac.empty() && mac_matches(target_uuid, kv.second.mac)) match = true;
                    if (!kv.second.name.empty() && strcasecmp(target_uuid.c_str(), kv.second.name.c_str()) == 0) match = true;

                    if (match) {
                        if (cond.device_property == "rssi" || cond.device_property == "proximity" || cond.target_rssi != 0) {
                            if (!kv.second.present) return false;
                            switch (cond.op) {
                                case ConditionOperator::GREATER_THAN: return kv.second.rssi > cond.target_rssi;
                                case ConditionOperator::LESS_THAN:    return kv.second.rssi < cond.target_rssi;
                                case ConditionOperator::EQUAL:        return kv.second.rssi == cond.target_rssi;
                                case ConditionOperator::NOT_EQUAL:    return kv.second.rssi != cond.target_rssi;
                                default: return kv.second.rssi >= cond.target_rssi;
                            }
                        }
                        return kv.second.present == cond.target_bool;
                    }
                }
                return !cond.target_bool;
            }

            uint8_t cached_frame[8];
            if (!get_cached_can_frame(cond.can_id, cached_frame)) return false;

            if (cond.byte_index >= 8) return false;
            uint8_t actual = cached_frame[cond.byte_index];
            uint8_t mask = cond.byte_mask;

            uint8_t masked_actual = actual & mask;
            uint8_t masked_target = cond.target_value & mask;

            switch (cond.op) {
                case ConditionOperator::EQUAL:        return masked_actual == masked_target;
                case ConditionOperator::NOT_EQUAL:    return masked_actual != masked_target;
                case ConditionOperator::LESS_THAN:    return masked_actual < masked_target;
                case ConditionOperator::GREATER_THAN: return masked_actual > masked_target;
                default: return false;
            }
        }
    }
}

bool is_match(const uint8_t* incoming_data, const EntityOption& option) {
    if (option.match_mask == 0) return false;
    for (int i = 0; i < 8; i++) {
        if ((option.match_mask & (1 << i)) != 0) {
            bool inverted = (option.invert_mask & (1 << i)) != 0;
            uint8_t mask = option.byte_masks[i];
            uint8_t actual = incoming_data[i] & mask;
            uint8_t target = option.match_payload[i] & mask;
            if (inverted) {
                if (actual == target) return false;
            } else {
                if (actual != target) return false;
            }
        }
    }
    return true;
}

static inline bool evaluate_masked_byte(uint8_t actual_value, uint8_t target_value, uint8_t mask) {
    // If mask is 0xF0:
    // actual: 0x13 (0001 0011) & mask: 0xF0 (1111 0000) = 0x10 (0001 0000)
    // target: 0x10 (0001 0000) & mask: 0xF0 (1111 0000) = 0x10 (0001 0000)
    // They match, ignoring the changing lower nibble!
    return (actual_value & mask) == (target_value & mask);
}

static bool is_trigger_match(const uint8_t* incoming_data, const uint8_t* previous_data, const AutomationTrigger& trig) {
    if (trig.type == "byte_transition" && trig.byte_index >= 0 && trig.byte_index < 8) {
        if (!previous_data) return false;
        bool is_to = evaluate_masked_byte(incoming_data[trig.byte_index], trig.to_value, trig.byte_mask);
        // Menu Up fallback alias: CAN ID 0x448, byte index 6 (D7)
        if (!is_to && trig.can_id == 0x448 && trig.byte_index == 6 && (trig.to_value == 0x40 || trig.to_value == 0x02)) {
            uint8_t actual_nibble = incoming_data[6] & 0x0F;
            if (actual_nibble == 0x02 || actual_nibble == 0x04 || (incoming_data[6] & 0xF0) == 0x40) {
                is_to = true;
            }
        }
        if (trig.has_from_value) {
            bool was_from = evaluate_masked_byte(previous_data[trig.byte_index], trig.from_value, trig.byte_mask);
            return was_from && is_to && ((previous_data[trig.byte_index] & trig.byte_mask) != (incoming_data[trig.byte_index] & trig.byte_mask));
        } else {
            bool was_to = evaluate_masked_byte(previous_data[trig.byte_index], trig.to_value, trig.byte_mask);
            if (was_to && trig.can_id == 0x448 && trig.byte_index == 6 && (trig.to_value == 0x40 || trig.to_value == 0x02)) {
                uint8_t prev_nibble = previous_data[6] & 0x0F;
                was_to = (prev_nibble == 0x02 || prev_nibble == 0x04 || (previous_data[6] & 0xF0) == 0x40);
            }
            return !was_to && is_to;
        }
    }

    if (trig.match_mask == 0) return true; // match whole ID if no byte mask
    for (int i = 0; i < 8; i++) {
        if ((trig.match_mask & (1 << i)) != 0) {
            uint8_t mask = trig.byte_masks[i];
            bool match = ((incoming_data[i] & mask) == (trig.match_payload[i] & mask));
            // Menu Up fallback alias: CAN ID 0x448, byte index 6 (D7)
            if (!match && trig.can_id == 0x448 && i == 6 && (trig.match_payload[6] == 0x40 || trig.match_payload[6] == 0x02)) {
                uint8_t actual_nibble = incoming_data[6] & 0x0F;
                if (actual_nibble == 0x02 || actual_nibble == 0x04 || (incoming_data[6] & 0xF0) == 0x40) {
                    match = true;
                }
            }
            if (!match) return false;
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
            bool executed_inline = false;
            for (const auto& entity : global_catalog) {
                if (strcasecmp(entity.id.c_str(), step.entity_id.c_str()) == 0) {
                    for (const auto& option : entity.options) {
                        if (strcasecmp(option.label.c_str(), step.command.c_str()) == 0 || (entity.options.size() == 1 && step.command.empty())) {
                            execute_can_burst(entity.action_can_id, option.steps, entity.delay_ms);
                            executed_inline = true;
                            break;
                        }
                    }
                    break;
                }
            }
            if (!executed_inline) {
                ESP_LOGW(TAG, "Entity '%s' command '%s' not found for inline execution",
                         step.entity_id.c_str(), step.command.c_str());
            }
            continue;
        }

        if (step.type == ActionType::TRACK_POPUP) {
            const std::string& txt = !step.popup_text.empty() ? step.popup_text : step.popup_message;
            if (!txt.empty()) {
                if (step.popup_level == "warning") {
                    track_popup_show_warning(txt.c_str());
                } else if (step.popup_level == "error") {
                    track_popup_show_error(txt.c_str());
                } else {
                    track_popup_show_info(txt.c_str());
                }
            }
            continue;
        }


        if (step.type == ActionType::PRECONDITION) {
            precondition_execute_action(step.precon_mode.c_str(), step.precon_action.c_str());
            continue;
        }

        if (step.type == ActionType::CLIMATE_TARGET) {
            remote_climate_start(22.0f, false, 900);
            continue;
        }

        if (step.type == ActionType::HUD_NAV) {
            if (step.nav_action == "clear") {
                hud_nav_clear();
            } else {
                hud_nav_instruction_t instr = {};
                instr.icon = (hud_maneuver_icon_t)step.nav_icon;
                instr.distance_meters = step.nav_distance_meters;
                instr.bar_graph = step.nav_bars;
                instr.speed_limit_kph = step.nav_speed_limit;
                instr.speed_camera_alert = step.nav_camera_alert;
                if (!step.nav_street.empty()) {
                    instr.street_name = step.nav_street.c_str();
                }
                hud_nav_update(&instr);
            }
            continue;
        }

        if (step.type == ActionType::IF_THEN) {
            bool passed = true;
            for (const auto& c : step.if_conditions) {
                if (!evaluate_condition(c)) {
                    passed = false;
                    break;
                }
            }
            if (passed) {
                execute_can_burst(can_id, step.then_steps, delay_ms);
            } else {
                execute_can_burst(can_id, step.else_steps, delay_ms);
            }
            continue;
        }

        if (step.type == ActionType::CHOOSE) {
            bool matched = false;
            for (const auto& choice : step.choices) {
                bool branch_passed = true;
                for (const auto& c : choice.conditions) {
                    if (!evaluate_condition(c)) {
                        branch_passed = false;
                        break;
                    }
                }
                if (branch_passed) {
                    execute_can_burst(can_id, choice.sequence, delay_ms);
                    matched = true;
                    break;
                }
            }
            if (!matched && !step.default_steps.empty()) {
                execute_can_burst(can_id, step.default_steps, delay_ms);
            }
            continue;
        }

        if (step.type == ActionType::REPEAT_UNTIL || step.type == ActionType::WAIT_FOR) {
            uint32_t start_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
            s_wait_for_start_ms = start_ms;
            bool condition_met = false;
            while (!condition_met) {
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                if (step.timeout_ms > 0 && (now_ms - start_ms) >= step.timeout_ms) {
                    ESP_LOGW(TAG, "Timeout waiting for condition in %s", 
                             step.type == ActionType::WAIT_FOR ? "WAIT_FOR" : "REPEAT_UNTIL");
                    break;
                }
                if (step.type == ActionType::REPEAT_UNTIL && !step.sequence.empty()) {
                    execute_can_burst(can_id, step.sequence, delay_ms);
                }
                if (evaluate_condition(step.condition)) {
                    condition_met = true;
                    break;
                }
                vTaskDelay(pdMS_TO_TICKS(step.interval_ms > 0 ? step.interval_ms : 50));
            }
            s_wait_for_start_ms = 0;
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
            twai_message_t msg_to_send = tx_msg;
            fwd_result_t fwd_res = precondition_fwd_hook(&msg_to_send, CAN_BUS_0);
            if (fwd_res == FWD_BLOCK) {
                continue;
            }
            fwd_res = track_popup_fwd(&msg_to_send, CAN_BUS_0);
            if (fwd_res == FWD_BLOCK) {
                continue;
            }

            fwd_res = hud_nav_fwd(&msg_to_send, CAN_BUS_0);
            if (fwd_res == FWD_BLOCK) {
                continue;
            }
            if (g_sniffer_mode.load()) {
                ESP_LOGD(TAG, "Sniffer mode active: suppressed TX ID 0x%03lX", (unsigned long)msg_to_send.identifier);
                continue;
            }
            twai_status_info_t info;
            if (twai_get_status_info(&info) != ESP_OK || info.state != TWAI_STATE_RUNNING) {
                ESP_LOGW(TAG, "TWAI controller not in RUNNING state (%d), skipping burst TX", info.state);
                break;
            }
            if (info.tx_error_counter >= 128) {
                ESP_LOGW(TAG, "CAN burst TX suppressed: TEC=%lu (Error Passive: disconnected or silent bus)", (unsigned long)info.tx_error_counter);
                break;
            }
            msg_to_send.ss = 1; // Single-Shot mode: prevent infinite hardware retry loop on bus error
            if (twai_transmit(&msg_to_send, pdMS_TO_TICKS(10)) == ESP_OK) {
                board_led_can_activity();
                if (delay_ms > 0) {
                    vTaskDelay(pdMS_TO_TICKS(delay_ms));
                }
            } else {
                ESP_LOGW(TAG, "TWAI TX failed or queue full for ID 0x%03lX", (unsigned long)msg_to_send.identifier);
            }
        }

        if (step.delay_ms > 0) {
            vTaskDelay(pdMS_TO_TICKS(step.delay_ms));
        }
    }
}

bool queue_entity_command(const std::string& entity_id, const std::string& command_label) {
    // Check if entity_id matches an active automation rule
    for (auto& rule : global_automations) {
        if (rule.id == entity_id) {
            std::string cmd_lower = command_label;
            std::transform(cmd_lower.begin(), cmd_lower.end(), cmd_lower.begin(), ::tolower);
            if (cmd_lower == "off" || cmd_lower == "0" || cmd_lower == "false" || cmd_lower == "disable") {
                rule.enabled = false;
                mqtt_mgr_publish_entity_state(rule.id, "OFF");
                broadcast_ws_state(rule.id, "OFF");
                ESP_LOGI(TAG, "Automation rule '%s' disabled via entity command", rule.id.c_str());
                return true;
            } else if (cmd_lower == "on" || cmd_lower == "1" || cmd_lower == "true" || cmd_lower == "enable") {
                rule.enabled = true;
                mqtt_mgr_publish_entity_state(rule.id, "ON");
                broadcast_ws_state(rule.id, "ON");
                ESP_LOGI(TAG, "Automation rule '%s' enabled via entity command", rule.id.c_str());
                return true;
            } else {
                // Trigger/run the automation sequence directly
                ESP_LOGI(TAG, "Triggering automation rule '%s' manually via command '%s'", rule.id.c_str(), command_label.c_str());
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                rule.last_exec_time_ms = now_ms;
                broadcast_ws_automation_event(rule.id, rule.name);
                bool ok = queue_action_steps_ptr(0, 20, &rule.actions, "manual_ha");
                return ok;
            }
        }
    }

    if (entity_id == "battery_preconditioning" || entity_id == "precondition") {
        std::string mode = "persistent";
        std::string act = "start";
        if (!command_label.empty() && command_label[0] == '{') {
            cJSON* root = cJSON_Parse(command_label.c_str());
            if (root) {
                cJSON* m = cJSON_GetObjectItem(root, "mode");
                if (m && cJSON_IsString(m)) mode = m->valuestring;
                cJSON* a = cJSON_GetObjectItem(root, "action");
                if (a && cJSON_IsString(a)) act = a->valuestring;
                cJSON_Delete(root);
            }
        } else if (!command_label.empty()) {
            std::string c_lower = command_label;
            std::transform(c_lower.begin(), c_lower.end(), c_lower.begin(), ::tolower);
            if (c_lower.find("stop") != std::string::npos || c_lower.find("cancel") != std::string::npos || c_lower.find("off") != std::string::npos) {
                act = "stop";
                mode = "cancel";
            } else if (c_lower.find("continuous") != std::string::npos) {
                mode = "continuous";
            } else if (c_lower.find("once") != std::string::npos || c_lower.find("single") != std::string::npos) {
                mode = "once";
            } else {
                mode = "persistent";
            }
        }
        precondition_execute_action(mode.c_str(), act.c_str());
        return true;
    }

    if (entity_id == "remote_climate" || entity_id == "remote_climate_tmu" || entity_id == "remote_climate_start_smart") {
        float temp_c = 22.0f;
        bool defrost = false;
        uint32_t duration_sec = 900;
        bool is_start = true;

        if (!command_label.empty() && command_label[0] == '{') {
            cJSON* root = cJSON_Parse(command_label.c_str());
            if (root) {
                cJSON* act = cJSON_GetObjectItem(root, "action");
                if (act && cJSON_IsString(act)) {
                    std::string a = act->valuestring;
                    std::transform(a.begin(), a.end(), a.begin(), ::tolower);
                    if (a == "stop" || a == "off") is_start = false;
                }
                cJSON* t = cJSON_GetObjectItem(root, "temp");
                if (!t) t = cJSON_GetObjectItem(root, "temperature");
                if (t && cJSON_IsNumber(t)) temp_c = (float)t->valuedouble;

                cJSON* d = cJSON_GetObjectItem(root, "defrost");
                if (d && cJSON_IsBool(d)) defrost = cJSON_IsTrue(d);

                cJSON* dur = cJSON_GetObjectItem(root, "duration");
                if (dur && cJSON_IsNumber(dur)) duration_sec = (uint32_t)dur->valueint;

                cJSON_Delete(root);
            }
        } else {
            std::string c_lower = command_label;
            std::transform(c_lower.begin(), c_lower.end(), c_lower.begin(), ::tolower);
            if (c_lower == "off" || c_lower == "0" || c_lower == "stop" || c_lower == "inactive" || c_lower == "disable" || c_lower.find("off") != std::string::npos) {
                is_start = false;
            } else if (c_lower == "toggle") {
                is_start = !remote_climate_is_active();
            }
        }

        if (is_start) {
            remote_climate_start(temp_c, defrost, duration_sec);
        } else {
            remote_climate_stop();
        }
        return true;
    }

    if (entity_id == "ambient_mood_lamp_color" || entity_id == "ambient_mood_lighting" || entity_id == "mood_lighting" || entity_id == "ambient_light") {
        std::string cmd_lower = command_label;
        std::transform(cmd_lower.begin(), cmd_lower.end(), cmd_lower.begin(), ::tolower);
        bool ok = false;
        std::string new_state = command_label;
        uint8_t payload_4ad[8] = {0};
        bool has_4ad = false;

        // Factory Dual-Color Themes (EV6 GT-Line)
        if (cmd_lower.find("golden") != std::string::npos || cmd_lower.find("orange delight") != std::string::npos) {
            payload_4ad[0] = 0xD0; payload_4ad[1] = 0xC1; payload_4ad[2] = 0x75; payload_4ad[3] = 0x15;
            new_state = "Golden Insight / Orange Delight";
            has_4ad = true;
        } else if (cmd_lower.find("blue flight") != std::string::npos) {
            payload_4ad[0] = 0x4F; payload_4ad[1] = 0x29; payload_4ad[2] = 0x36; payload_4ad[3] = 0x1C;
            new_state = "Blue Flight";
            has_4ad = true;
        } else if (cmd_lower.find("peaceful forest") != std::string::npos) {
            payload_4ad[0] = 0x7F; payload_4ad[1] = 0x69; payload_4ad[2] = 0xA6; payload_4ad[3] = 0x17;
            new_state = "Peaceful Forest";
            has_4ad = true;
        } else if (cmd_lower.find("dreamy purple") != std::string::npos) {
            payload_4ad[0] = 0x6B; payload_4ad[1] = 0x69; payload_4ad[2] = 0x55; payload_4ad[3] = 0x19;
            new_state = "Dreamy Purple";
            has_4ad = true;
        } else if (cmd_lower.find("violet cloud") != std::string::npos) {
            payload_4ad[0] = 0xA7; payload_4ad[1] = 0x89; payload_4ad[2] = 0xF5; payload_4ad[3] = 0x17;
            new_state = "Violet Cloud";
            has_4ad = true;
        } else if (cmd_lower.find("refreshing sea") != std::string::npos) {
            payload_4ad[0] = 0x32; payload_4ad[1] = 0x69; payload_4ad[2] = 0xE6; payload_4ad[3] = 0x19;
            new_state = "Refreshing Sea";
            has_4ad = true;
        }
        // Standard Color Wheel Presets
        else if (cmd_lower.find("off") != std::string::npos || cmd_lower == "0" || cmd_lower == "false" || cmd_lower == "disable") {
            new_state = "Mood Light Off";
            has_4ad = true; // All zeros
        } else if (cmd_lower.find("cyan") != std::string::npos || cmd_lower.find("aqua") != std::string::npos) {
            payload_4ad[1] = 0x64; payload_4ad[2] = 0x53; payload_4ad[3] = 0x0F;
            new_state = "Pure Cyan / Aqua Wave";
            has_4ad = true;
        } else if (cmd_lower.find("amber") != std::string::npos || cmd_lower.find("orange") != std::string::npos || cmd_lower.find("sunset") != std::string::npos) {
            payload_4ad[0] = 0xFF; payload_4ad[1] = 0x50; payload_4ad[2] = 0x72; payload_4ad[3] = 0x07;
            new_state = "Warm Sunset / Amber";
            has_4ad = true;
        } else if (cmd_lower.find("violet") != std::string::npos || cmd_lower.find("purple") != std::string::npos) {
            payload_4ad[0] = 0x80; payload_4ad[2] = 0xF0; payload_4ad[3] = 0x0F;
            new_state = "Deep Purple / Violet";
            has_4ad = true;
        } else if (cmd_lower.find("white") != std::string::npos || cmd_lower.find("champagne") != std::string::npos) {
            payload_4ad[0] = 0xFE; payload_4ad[1] = 0xB4; payload_4ad[2] = 0x53; payload_4ad[3] = 0x0A;
            new_state = "Warm White / Champagne";
            has_4ad = true;
        } else if (cmd_lower.find("red") != std::string::npos || cmd_lower.find("crimson") != std::string::npos) {
            payload_4ad[0] = 0xFE; payload_4ad[1] = 0x88;
            new_state = "Crimson Red";
            has_4ad = true;
        } else if (cmd_lower.find("green") != std::string::npos || cmd_lower.find("mint") != std::string::npos || cmd_lower.find("lime") != std::string::npos) {
            payload_4ad[0] = 0xF7; payload_4ad[1] = 0xFC; payload_4ad[2] = 0x63; payload_4ad[3] = 0x0B;
            new_state = "Lime / Mint Glow";
            has_4ad = true;
        } else if (cmd_lower.find("blue") != std::string::npos) {
            payload_4ad[1] = 0x54; payload_4ad[2] = 0xF1; payload_4ad[3] = 0x0F;
            new_state = "Electric Blue";
            has_4ad = true;
        } else if (cmd_lower.find("pink") != std::string::npos || cmd_lower.find("magenta") != std::string::npos) {
            payload_4ad[0] = 0xFF; payload_4ad[2] = 0x10; payload_4ad[3] = 0x0F;
            new_state = "Magenta / Neon Pink";
            has_4ad = true;
        } else if (!command_label.empty() && command_label[0] == '{') {
            cJSON* root = cJSON_Parse(command_label.c_str());
            if (root) {
                cJSON* hex_it = cJSON_GetObjectItem(root, "hex");
                if (!hex_it) hex_it = cJSON_GetObjectItem(root, "payload");
                if (hex_it && cJSON_IsString(hex_it) && hex_it->valuestring) {
                    std::string hx = hex_it->valuestring;
                    std::string clean;
                    for (char c : hx) { if (isxdigit((unsigned char)c)) clean += c; }
                    size_t bytes = clean.length() / 2;
                    if (bytes > 8) bytes = 8;
                    for (size_t b = 0; b < bytes; b++) {
                        payload_4ad[b] = (uint8_t)strtoul(clean.substr(b * 2, 2).c_str(), nullptr, 16);
                    }
                    has_4ad = true;
                } else {
                    uint16_t r = 0, g = 0, b = 0;
                    cJSON* r_it = cJSON_GetObjectItem(root, "r");
                    if (!r_it) r_it = cJSON_GetObjectItem(root, "red");
                    if (r_it && cJSON_IsNumber(r_it)) r = (uint16_t)r_it->valueint;

                    cJSON* g_it = cJSON_GetObjectItem(root, "g");
                    if (!g_it) g_it = cJSON_GetObjectItem(root, "green");
                    if (g_it && cJSON_IsNumber(g_it)) g = (uint16_t)g_it->valueint;

                    cJSON* b_it = cJSON_GetObjectItem(root, "b");
                    if (!b_it) b_it = cJSON_GetObjectItem(root, "blue");
                    if (b_it && cJSON_IsNumber(b_it)) b = (uint16_t)b_it->valueint;

                    // Map closest RGB to 0x4AD payload
                    if (r < 20 && g < 20 && b < 20) {
                        new_state = "Mood Light Off";
                    } else if (r > 200 && g < 80 && b < 80) { // Red
                        payload_4ad[0] = 0xFE; payload_4ad[1] = 0x88;
                        new_state = "Crimson Red";
                    } else if (r > 200 && g > 80 && b < 80) { // Amber
                        payload_4ad[0] = 0xFF; payload_4ad[1] = 0x50; payload_4ad[2] = 0x72; payload_4ad[3] = 0x07;
                        new_state = "Warm Sunset / Amber";
                    } else if (r > 150 && b > 200) { // Violet / Pink
                        payload_4ad[0] = 0x80; payload_4ad[2] = 0xF0; payload_4ad[3] = 0x0F;
                        new_state = "Deep Purple / Violet";
                    } else if (g > 200 && b > 200) { // Cyan
                        payload_4ad[1] = 0x64; payload_4ad[2] = 0x53; payload_4ad[3] = 0x0F;
                        new_state = "Pure Cyan / Aqua Wave";
                    } else if (b > 200) { // Blue
                        payload_4ad[1] = 0x54; payload_4ad[2] = 0xF1; payload_4ad[3] = 0x0F;
                        new_state = "Electric Blue";
                    } else if (g > 180) { // Green
                        payload_4ad[0] = 0xF7; payload_4ad[1] = 0xFC; payload_4ad[2] = 0x63; payload_4ad[3] = 0x0B;
                        new_state = "Lime / Mint Glow";
                    } else { // Champagne White
                        payload_4ad[0] = 0xFE; payload_4ad[1] = 0xB4; payload_4ad[2] = 0x53; payload_4ad[3] = 0x0A;
                        new_state = "Warm White / Champagne";
                    }
                    has_4ad = true;
                }
                cJSON_Delete(root);
            }
        } else {
            std::string clean_hex;
            for (char c : command_label) {
                if (isxdigit((unsigned char)c)) clean_hex += c;
            }
            if (clean_hex.length() >= 8) {
                size_t byte_cnt = clean_hex.length() / 2;
                if (byte_cnt > sizeof(payload_4ad)) byte_cnt = sizeof(payload_4ad);
                for (size_t i = 0; i < byte_cnt; i++) {
                    payload_4ad[i] = (uint8_t)strtoul(clean_hex.substr(i * 2, 2).c_str(), nullptr, 16);
                }
                has_4ad = true;
            } else {
                // Default fallback: Pure Cyan
                payload_4ad[1] = 0x64; payload_4ad[2] = 0x53; payload_4ad[3] = 0x0F;
                new_state = "Pure Cyan / Aqua Wave";
                has_4ad = true;
            }
        }

        // Two-stage transmission on 0x4AD:
        // Stage 1: Active color burst (3 frames @ 25ms)
        // Stage 2: Latch commit frame (3 frames @ 25ms, payload 00 02 08 20 00 00 00 00)
        if (has_4ad) {
            ActionStep step_color = {};
            step_color.type = ActionType::TRANSMIT_FRAME;
            step_color.can_id = 0x4AD;
            step_color.repeat = 3;
            step_color.delay_ms = 25;
            step_color.mask = 0xFF;
            memcpy(step_color.payload, payload_4ad, 8);

            ActionStep step_latch = {};
            step_latch.type = ActionType::TRANSMIT_FRAME;
            step_latch.can_id = 0x4AD;
            step_latch.repeat = 3;
            step_latch.delay_ms = 25;
            step_latch.mask = 0xFF;
            const uint8_t latch_data[8] = {0x00, 0x02, 0x08, 0x20, 0x00, 0x00, 0x00, 0x00};
            memcpy(step_latch.payload, latch_data, 8);

            std::vector<ActionStep> steps = { step_color, step_latch };
            queue_action_steps(0x4AD, 25, steps);
            ok = true;
        }

        if (ok) {
            broadcast_ws_state(entity_id, new_state);
            mqtt_mgr_publish_entity_state(entity_id, new_state);
        }
        return ok;
    }

    CanEntity entity;
    if (!find_entity_in_catalog(entity_id, entity)) {
        ESP_LOGW(TAG, "Entity '%s' not found in catalog or automations", entity_id.c_str());
        return false;
    }

    std::string cmd_lower = command_label;
    std::transform(cmd_lower.begin(), cmd_lower.end(), cmd_lower.begin(), ::tolower);

    bool is_on_cmd = (cmd_lower == "on" || cmd_lower == "1" || cmd_lower == "true" || cmd_lower == "enable");
    bool is_off_cmd = (cmd_lower == "off" || cmd_lower == "0" || cmd_lower == "false" || cmd_lower == "disable");
    bool is_lock_cmd = (cmd_lower == "lock" || cmd_lower == "locked" || cmd_lower == "secure");
    bool is_unlock_cmd = (cmd_lower == "unlock" || cmd_lower == "unlocked");
    bool is_open_cmd = (cmd_lower == "open" || cmd_lower == "opened" || cmd_lower == "roll down" || cmd_lower == "down");
    bool is_close_cmd = (cmd_lower == "close" || cmd_lower == "closed" || cmd_lower == "roll up" || cmd_lower == "up");
    bool is_vent_cmd = (cmd_lower == "vent" || cmd_lower == "tilt" || cmd_lower == "crack");
    bool is_toggle = (cmd_lower == "toggle");

    const EntityOption* matched_opt = nullptr;

    if (is_toggle) {
        std::string cur_lower = entity.current_state;
        std::transform(cur_lower.begin(), cur_lower.end(), cur_lower.begin(), ::tolower);
        if (entity.ha_domain == "lock" || entity.id.find("lock") != std::string::npos) {
            bool currently_locked = (cur_lower.find("lock") != std::string::npos && cur_lower.find("unlock") == std::string::npos);
            if (currently_locked) is_unlock_cmd = true;
            else is_lock_cmd = true;
        } else if (entity.ha_domain == "cover" || entity.id.find("window") != std::string::npos || entity.id.find("tailgate") != std::string::npos) {
            bool currently_closed = (cur_lower.find("close") != std::string::npos);
            if (currently_closed) is_open_cmd = true;
            else is_close_cmd = true;
        } else {
            bool currently_on = (cur_lower.find("on") != std::string::npos || cur_lower.find("active") != std::string::npos || cur_lower.find("enable") != std::string::npos);
            if (currently_on) is_off_cmd = true;
            else is_on_cmd = true;
        }
    }

    if (is_lock_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("unlock") == std::string::npos && opt_l.find("lock") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_unlock_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("unlock") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_open_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("close") == std::string::npos && (opt_l.find("open") != std::string::npos || opt_l.find("down") != std::string::npos)) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_close_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("close") != std::string::npos || opt_l.find("up") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_vent_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("vent") != std::string::npos || opt_l.find("tilt") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
    } else if (is_on_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("on") != std::string::npos || opt_l.find("active") != std::string::npos || opt_l.find("enable") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
        if (!matched_opt && !entity.options.empty()) {
            matched_opt = &entity.options[0];
        }
    } else if (is_off_cmd) {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l.find("off") != std::string::npos || opt_l.find("inactive") != std::string::npos || opt_l.find("disable") != std::string::npos) {
                matched_opt = &opt;
                break;
            }
        }
        if (!matched_opt && entity.options.size() > 1) {
            matched_opt = &entity.options[1];
        }
    } else {
        for (const auto& opt : entity.options) {
            std::string opt_l = opt.label;
            std::transform(opt_l.begin(), opt_l.end(), opt_l.begin(), ::tolower);
            if (opt_l == cmd_lower || opt_l.find(cmd_lower) != std::string::npos || cmd_lower.find(opt_l) != std::string::npos || (entity.options.size() == 1 && command_label.empty())) {
                matched_opt = &opt;
                break;
            }
        }
    }

    if (!matched_opt && !entity.options.empty()) {
        matched_opt = &entity.options[0];
    }

    if (!matched_opt) {
        ESP_LOGW(TAG, "Option '%s' not found for entity '%s'", command_label.c_str(), entity_id.c_str());
        return false;
    }

    uint32_t cid = entity.action_can_id ? entity.action_can_id : entity.state_can_id;
    bool ok = queue_action_steps(cid, entity.delay_ms, matched_opt->steps, entity.id);
    if (ok) {
        entity.current_state = matched_opt->label;
        std::string payload = matched_opt->label;
        if (entity.ha_domain == "switch") {
            std::string l_lower = matched_opt->label;
            std::transform(l_lower.begin(), l_lower.end(), l_lower.begin(), ::tolower);
            if (l_lower.find("off") != std::string::npos || l_lower.find("disable") != std::string::npos || l_lower.find("inactive") != std::string::npos) {
                payload = "OFF";
            } else {
                payload = "ON";
            }
        }
        mqtt_mgr_publish_entity_state(entity.id, payload);
        broadcast_ws_state(entity.id, matched_opt->label);
    }
    return ok;
}

bool steps_contain_async(const std::vector<ActionStep>& steps) {
    for (const auto& step : steps) {
        if (step.type == ActionType::REPEAT_UNTIL || step.type == ActionType::WAIT_FOR) {
            return true;
        }
        if (step.type == ActionType::DELAY && step.delay_ms >= 500) {
            return true;
        }
        if (step.type == ActionType::IF_THEN) {
            if (steps_contain_async(step.then_steps) || steps_contain_async(step.else_steps)) return true;
        }
        if (step.type == ActionType::CHOOSE) {
            for (const auto& choice : step.choices) {
                if (steps_contain_async(choice.sequence)) return true;
            }
            if (steps_contain_async(step.default_steps)) return true;
        }
    }
    return false;
}

static void execute_can_burst_async_task(void* arg) {
    CanBurstCmd* cmd = (CanBurstCmd*)arg;
    if (cmd) {
        if (cmd->steps && !cmd->steps->empty()) {
            execute_can_burst(cmd->can_id, *cmd->steps, cmd->delay_ms);
        } else if (!cmd->inline_steps.empty()) {
            execute_can_burst(cmd->can_id, cmd->inline_steps, cmd->delay_ms);
        }
        delete cmd;
    }
    vTaskDelete(NULL);
}

bool queue_action_steps(uint32_t can_id, uint32_t delay_ms, const std::vector<ActionStep>& steps, const std::string& trigger_id) {
    CanBurstCmd* cmd = new (std::nothrow) CanBurstCmd();
    if (!cmd) return false;
    cmd->can_id = can_id;
    cmd->delay_ms = delay_ms;
    cmd->trigger_id = trigger_id;
    cmd->inline_steps = steps;
    cmd->async = steps_contain_async(steps);
    if (xQueueSend(tx_command_queue, &cmd, pdMS_TO_TICKS(10)) != pdTRUE) {
        delete cmd;
        return false;
    }
    return true;
}

bool queue_action_steps_ptr(uint32_t can_id, uint32_t delay_ms, const std::vector<ActionStep>* steps, const std::string& trigger_id) {
    CanBurstCmd* cmd = new (std::nothrow) CanBurstCmd();
    if (!cmd) return false;
    cmd->can_id = can_id;
    cmd->delay_ms = delay_ms;
    cmd->trigger_id = trigger_id;
    cmd->steps = steps;
    cmd->async = steps ? steps_contain_async(*steps) : false;
    if (xQueueSend(tx_command_queue, &cmd, pdMS_TO_TICKS(10)) != pdTRUE) {
        delete cmd;
        return false;
    }
    return true;
}

static void emit_live_entity_state(const std::string& entity_id, const std::string& state) {
    for (auto& entity : global_catalog) {
        if (entity.id == entity_id) {
            entity.current_state = state;
            break;
        }
    }
    mqtt_mgr_publish_entity_state(entity_id, state);
    broadcast_ws_state(entity_id, state);
}

void can_rx_task(void* arg) {
    twai_message_t rx_msg;
    ESP_LOGI(TAG, "CAN RX task running");

    int rx_processed = 0;
    static uint32_t s_bus_off_or_recovering_start_ms = 0;
    static uint32_t s_last_can_frame_ms = 0;

    while (true) {
        if (g_twai_reconfig_pending.load()) {
            twai_mode_t new_mode = g_twai_requested_mode.load();
            ESP_LOGI(TAG, "Reconfiguring TWAI peripheral to mode %d...", (int)new_mode);

            // Flush TX queue first to prevent uninstaller hanging on pending semaphores
            twai_clear_transmit_queue();
            twai_stop();
            twai_driver_uninstall();

            twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, new_mode);
            g_config.rx_queue_len = 128;
            g_config.tx_queue_len = 32;
            g_config.alerts_enabled = TWAI_ALERT_BUS_OFF | TWAI_ALERT_BUS_RECOVERED | TWAI_ALERT_ERR_PASS | TWAI_ALERT_BUS_ERROR | TWAI_ALERT_RX_QUEUE_FULL;
            twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
            twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

            esp_err_t ret = twai_driver_install(&g_config, &t_config, &f_config);
            if (ret == ESP_OK) {
                twai_start();
                ESP_LOGI(TAG, "TWAI reconfigured to %s",
                         new_mode == TWAI_MODE_LISTEN_ONLY ? "LISTEN_ONLY" : "NORMAL");
            } else {
                ESP_LOGE(TAG, "Failed reinstalling TWAI driver (%s)", esp_err_to_name(ret));
            }
            g_twai_reconfig_pending.store(false);
        }

        // Drain alerts so alert buffer never fills up
        uint32_t alerts = 0;
        if (twai_read_alerts(&alerts, 0) == ESP_OK && alerts != 0) {
            if (alerts & TWAI_ALERT_BUS_OFF) {
                ESP_LOGW(TAG, "TWAI alert: BUS_OFF");
            }
            if (alerts & TWAI_ALERT_RX_QUEUE_FULL) {
                ESP_LOGW(TAG, "TWAI alert: RX queue full, dropping frame");
            }
        }

        // Auto-recover supervisor for TWAI peripheral
        twai_status_info_t twai_status;
        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

        if (twai_get_status_info(&twai_status) == ESP_OK) {
            if (twai_status.state == TWAI_STATE_BUS_OFF) {
                ESP_LOGW(TAG, "TWAI controller in BUS_OFF! Reinstalling hardware driver immediately...");
                twai_clear_transmit_queue();
                // In ESP-IDF, twai_driver_uninstall() is valid directly from TWAI_STATE_BUS_OFF (twai_stop must NOT be called in BUS_OFF)
                twai_driver_uninstall();
                vTaskDelay(pdMS_TO_TICKS(10));

                twai_mode_t cur_mode = g_hardware_listen_only.load() ? TWAI_MODE_LISTEN_ONLY : TWAI_MODE_NORMAL;
                twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, cur_mode);
                g_config.rx_queue_len = 128;
                g_config.tx_queue_len = 32;
                g_config.alerts_enabled = TWAI_ALERT_BUS_OFF | TWAI_ALERT_BUS_RECOVERED | TWAI_ALERT_ERR_PASS | TWAI_ALERT_BUS_ERROR | TWAI_ALERT_RX_QUEUE_FULL;
                twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
                twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

                esp_err_t err = twai_driver_install(&g_config, &t_config, &f_config);
                if (err == ESP_OK) {
                    twai_start();
                    ESP_LOGI(TAG, "TWAI driver re-installed and running after BUS_OFF reset");
                } else {
                    ESP_LOGE(TAG, "TWAI driver reinstall failed (%s)", esp_err_to_name(err));
                }
                s_bus_off_or_recovering_start_ms = 0;
            } else if (twai_status.state == TWAI_STATE_STOPPED) {
                ESP_LOGI(TAG, "TWAI controller STOPPED. Starting controller...");
                twai_clear_transmit_queue();
                twai_start();
                s_bus_off_or_recovering_start_ms = 0;
            } else if (twai_status.state == TWAI_STATE_RECOVERING) {
                if (s_bus_off_or_recovering_start_ms == 0) {
                    s_bus_off_or_recovering_start_ms = now_ms;
                }
                // If hardware is stuck in RECOVERING for > 3000ms (e.g. bench test, silent bus, transceiver standby),
                // do NOT restart MCU (which kills Wi-Fi and Web server). Reinstall hardware driver cleanly!
                if (now_ms - s_bus_off_or_recovering_start_ms > 3000) {
                    ESP_LOGW(TAG, "TWAI stuck in RECOVERING state (>3000ms). Reinstalling driver without MCU reset...");
                    twai_clear_transmit_queue();
                    twai_driver_uninstall();
                    vTaskDelay(pdMS_TO_TICKS(10));

                    twai_mode_t cur_mode = g_hardware_listen_only.load() ? TWAI_MODE_LISTEN_ONLY : TWAI_MODE_NORMAL;
                    twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, cur_mode);
                    g_config.rx_queue_len = 128;
                    g_config.tx_queue_len = 32;
                    g_config.alerts_enabled = TWAI_ALERT_BUS_OFF | TWAI_ALERT_BUS_RECOVERED | TWAI_ALERT_ERR_PASS | TWAI_ALERT_BUS_ERROR | TWAI_ALERT_RX_QUEUE_FULL;
                    twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
                    twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

                    esp_err_t err = twai_driver_install(&g_config, &t_config, &f_config);
                    if (err == ESP_OK) {
                        twai_start();
                        ESP_LOGI(TAG, "TWAI driver re-installed and running after recovery timeout");
                    } else {
                        ESP_LOGE(TAG, "TWAI driver reinstall failed (%s)", esp_err_to_name(err));
                    }
                    s_bus_off_or_recovering_start_ms = 0;
                }
            } else if (twai_status.state == TWAI_STATE_RUNNING) {
                s_bus_off_or_recovering_start_ms = 0;
            }
        }

        if (twai_receive(&rx_msg, pdMS_TO_TICKS(10)) == ESP_OK) {
            rx_processed++;
            s_last_can_frame_ms = now_ms;
            board_led_can_activity();

            rtc_crash_record(rx_msg.identifier, rx_msg.data_length_code, rx_msg.data, 1, "precondition_rx");
            precondition_can_rx_hook(&rx_msg, CAN_BUS_0);

            rtc_crash_record(rx_msg.identifier, rx_msg.data_length_code, rx_msg.data, 2, "track_popup_rx");
            track_popup_rx(&rx_msg, CAN_BUS_0);

            rtc_crash_record(rx_msg.identifier, rx_msg.data_length_code, rx_msg.data, 3, "hud_nav_rx");
            hud_nav_rx(&rx_msg, CAN_BUS_0);

            rtc_crash_record(rx_msg.identifier, rx_msg.data_length_code, rx_msg.data, 4, "uds_engine_rx");
            uds_engine_on_can_rx(&rx_msg);

            // Stream raw frame to connected SavvyCAN/GVRET client
            rtc_crash_record(rx_msg.identifier, rx_msg.data_length_code, rx_msg.data, 6, "gvret_enqueue");
            gvret_enqueue_frame(&rx_msg);

            if (rx_msg.rtr) {
                rtc_crash_record(rx_msg.identifier, rx_msg.data_length_code, rx_msg.data, 999, "rtr_done");
                continue;
            }

            uint8_t prev_data[8] = {0};
            bool has_prev = get_cached_can_frame(rx_msg.identifier, prev_data);

            // 1. Always update state cache
            rtc_crash_record(rx_msg.identifier, rx_msg.data_length_code, rx_msg.data, 7, "update_state_cache");
            update_state_cache(rx_msg.identifier, rx_msg.data);

            // Helper: Mask out rolling counter and checksum bytes during MQTT change detection
            auto get_can_comparison_mask = [](uint32_t can_id, uint8_t mask_out[8]) {
                memset(mask_out, 0xFF, 8);
                switch (can_id) {
                    // Hyundai/Kia/Genesis E-GMP & Gen5W frames with alive counter and/or CRC in Byte 7:
                    case 0x0A2: // Wheel speeds
                    case 0x130: // Steering angle
                    case 0x152: // BMS Battery telemetry
                    case 0x1AC: // Cluster speed and info
                    case 0x226: // Shifter / Gear status
                    case 0x2AD: // Throttle & brake pedal
                    case 0x380: // Climate cabin temperatures
                    case 0x31B: // Climate blower fan & airflow
                    case 0x476: // Center console & camera switch panel
                    case 0x448: // Steering wheel media & cruise controls
                    case 0x4CE: // Head unit media & cluster popup
                        mask_out[7] = 0x00;
                        break;
                    default:
                        break;
                }
            };

            auto has_masked_can_data_changed = [&](uint32_t can_id, const uint8_t* prev, const uint8_t* curr, size_t len) -> bool {
                if (!prev) return true;
                uint8_t mask[8];
                get_can_comparison_mask(can_id, mask);
                for (size_t i = 0; i < len && i < 8; i++) {
                    if ((prev[i] & mask[i]) != (curr[i] & mask[i])) {
                        return true;
                    }
                }
                return false;
            };

            // Publish state change to MQTT if this CAN ID is monitored and actual payload data changed
            if (mqtt_mgr_is_monitored_id(rx_msg.identifier)) {
                if (!has_prev || has_masked_can_data_changed(rx_msg.identifier, prev_data, rx_msg.data, rx_msg.data_length_code)) {
                    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                    static std::unordered_map<uint32_t, uint32_t> s_last_mqtt_pub_ms;
                    auto pit = s_last_mqtt_pub_ms.find(rx_msg.identifier);
                    bool throttle = false;
                    // For continuous high-frequency telemetry, throttle to max 10Hz (100ms) to protect MQTT outbox
                    if (rx_msg.identifier == 0x1AC || rx_msg.identifier == 0x0A2 ||
                        rx_msg.identifier == 0x130 || rx_msg.identifier == 0x2AD ||
                        rx_msg.identifier == 0x227 || rx_msg.identifier == 0x29C ||
                        rx_msg.identifier == 0x151 || rx_msg.identifier == 0x152) {
                        if (pit != s_last_mqtt_pub_ms.end() && (now_ms - pit->second < 100)) {
                            throttle = true;
                        }
                    }
                    if (!throttle) {
                        s_last_mqtt_pub_ms[rx_msg.identifier] = now_ms;
                        mqtt_mgr_publish_can_state(rx_msg.identifier, rx_msg.data, rx_msg.data_length_code);
                    }
                }
            }

            // 2. Evaluate automations if globally enabled
            if (g_automations_enabled.load()) {
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                for (auto& rule : global_automations) {
                    if (!rule.enabled) continue;

                    for (const auto& trig : rule.triggers) {
                        if ((trig.type == "can_rx" || trig.type == "byte_transition") && trig.can_id == rx_msg.identifier) {
                            if (is_trigger_match(rx_msg.data, has_prev ? prev_data : nullptr, trig)) {
                                // Check cooldown
                                if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
                                    continue;
                                }

                                // Check conditions
                                bool passed = true;
                                for (const auto& cond : rule.conditions) {
                                    if (!evaluate_condition(cond)) {
                                        passed = false;
                                        break;
                                    }
                                }

                                if (passed) {
                                    ESP_LOGI(TAG, "Automation fired: %s (trigger: %s)", rule.name.c_str(), trig.id.c_str());
                                    rule.last_exec_time_ms = now_ms;
                                    broadcast_ws_automation_event(rule.id, rule.name);
                                    queue_action_steps_ptr(0, 20, &rule.actions, trig.id);
                                }
                            }
                        }
                    }
                }
            }

            // 3. Match against catalog entities for state updates (O(1) indexed lookup)
            auto cat_it = catalog_by_can_id.find(rx_msg.identifier);
            if (cat_it != catalog_by_can_id.end()) {
                for (auto* entity_ptr : cat_it->second) {
                    if (!entity_ptr) continue;
                    auto& entity = *entity_ptr;

                    for (const auto& opt : entity.options) {
                        if (is_match(rx_msg.data, opt)) {
                            if (entity.current_state != opt.label) {
                                entity.current_state = opt.label;
                                ESP_LOGI(TAG, "State change: %s -> %s", entity.id.c_str(), opt.label.c_str());

                                // MQTT Publish
                                std::string payload = opt.label;
                                if (entity.ha_domain == "switch") {
                                    std::string l_lower = opt.label;
                                    std::transform(l_lower.begin(), l_lower.end(), l_lower.begin(), ::tolower);
                                    if (l_lower.find("off") != std::string::npos || l_lower.find("disable") != std::string::npos || l_lower.find("inactive") != std::string::npos) {
                                        payload = "OFF";
                                    } else {
                                        payload = "ON";
                                    }
                                }
                                mqtt_mgr_publish_entity_state(entity.id, payload);

                                // WebSocket Broadcast
                                broadcast_ws_state(entity.id, opt.label);
                            }
                            break;
                        }
                    }
                }
            }

            // 4. Real-time Live Cockpit Telemetry Decoders
            // Stream continuous sensor values and discrete vehicle cockpit states directly to the front end

            // Road Speed (0x1AC Byte 0 = kph, or 0x0A2 Wheel Speed 16-bit LE * 0.03125, or 0x1A0 ESC Speed)
            if (rx_msg.identifier == 0x1AC && rx_msg.data_length_code >= 1) {
                uint8_t kph = rx_msg.data[0];
                static uint8_t s_last_kph = 255;
                static uint32_t s_last_spd_ms = 0;
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                if (kph != s_last_kph && (now_ms - s_last_spd_ms >= 100)) {
                    s_last_kph = kph;
                    s_last_spd_ms = now_ms;
                    std::string spd_str = std::to_string(kph) + " km/h";
                    emit_live_entity_state("cluster_vehicle_speed", spd_str);
                }
            } else if ((rx_msg.identifier == 0x0A2 || rx_msg.identifier == 0xA2) && rx_msg.data_length_code >= 2) {
                uint16_t rawW1 = rx_msg.data[0] | (rx_msg.data[1] << 8);
                uint8_t kph = (uint8_t)(rawW1 * 0.03125f);
                static uint8_t s_last_wheel_kph = 255;
                static uint32_t s_last_wheel_spd_ms = 0;
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                if (kph != s_last_wheel_kph && (now_ms - s_last_wheel_spd_ms >= 100)) {
                    s_last_wheel_kph = kph;
                    s_last_wheel_spd_ms = now_ms;
                    std::string spd_str = std::to_string(kph) + " km/h";
                    emit_live_entity_state("cluster_vehicle_speed", spd_str);
                }
            } else if (rx_msg.identifier == 0x1A0 && rx_msg.data_length_code >= 2) {
                uint16_t raw_esc = rx_msg.data[0] | (rx_msg.data[1] << 8);
                uint8_t kph = (uint8_t)(raw_esc * 0.03125f);
                static uint8_t s_last_esc_kph = 255;
                static uint32_t s_last_esc_spd_ms = 0;
                uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                if (kph != s_last_esc_kph && (now_ms - s_last_esc_spd_ms >= 100)) {
                    s_last_esc_kph = kph;
                    s_last_esc_spd_ms = now_ms;
                    std::string spd_str = std::to_string(kph) + " km/h";
                    emit_live_entity_state("cluster_vehicle_speed", spd_str);
                }
            }

            // Outdoor Ambient Temperature (0x226 Byte 3 = raw - 40 C)
            if (rx_msg.identifier == 0x226 && rx_msg.data_length_code >= 4) {
                uint8_t raw = rx_msg.data[3];
                if (raw > 0 && raw < 255) {
                    int c = (int)raw - 40;
                    static int s_last_temp = 999;
                    if (c != s_last_temp) {
                        s_last_temp = c;
                        std::string temp_str = std::to_string(c) + " °C";
                        emit_live_entity_state("cond_ambient_temperature", temp_str);
                    }
                }
            }

            // HV Traction Battery SOC (0x2FC Byte 7 = raw * 0.5 %)
            if (rx_msg.identifier == 0x2FC && rx_msg.data_length_code >= 8) {
                uint8_t raw = rx_msg.data[7];
                int soc = (int)(raw * 0.5f);
                static int s_last_soc = -1;
                if (soc >= 0 && soc <= 100 && soc != s_last_soc) {
                    s_last_soc = soc;
                    std::string soc_str = std::to_string(soc) + "%";
                    emit_live_entity_state("cond_hv_battery_soc", soc_str);
                }
            }

            // 12V Aux Battery Voltage (0x1CF Byte 5 or 0x594 Byte 4 = factor 0.1V)
            if ((rx_msg.identifier == 0x1CF || rx_msg.identifier == 0x594) && rx_msg.data_length_code >= 5) {
                uint8_t vByte = rx_msg.data_length_code >= 6 ? rx_msg.data[5] : rx_msg.data[4];
                float v = (float)(vByte * 0.1f);
                if (v >= 8.0f && v <= 16.5f) {
                    static float s_last_aux_v = 0.0f;
                    if (fabs(v - s_last_aux_v) >= 0.1f) {
                        s_last_aux_v = v;
                        char vbuf[16];
                        snprintf(vbuf, sizeof(vbuf), "%.1f V", v);
                        emit_live_entity_state("cond_aux_12v_battery", vbuf);
                    }
                }
            }

            // BMS Module Min/Max Temperatures (0x152 Byte 0, Byte 1)
            if (rx_msg.identifier == 0x152 && rx_msg.data_length_code >= 2) {
                int minT = (int8_t)rx_msg.data[0];
                int maxT = (int8_t)rx_msg.data[1];
                static int s_last_minT = 999, s_last_maxT = 999;
                if (minT != s_last_minT || maxT != s_last_maxT) {
                    s_last_minT = minT;
                    s_last_maxT = maxT;
                    char tbuf[64];
                    snprintf(tbuf, sizeof(tbuf), "Min: %d°C / Max: %d°C", minT, maxT);
                    emit_live_entity_state("hv_battery_temperatures", tbuf);
                }
            }

            // Transmission Gear Selection (0x045, 0x070, 0x130, 0x035)
            if ((rx_msg.identifier == 0x045 || rx_msg.identifier == 0x070 || rx_msg.identifier == 0x130 || rx_msg.identifier == 0x035) && rx_msg.data_length_code >= 6) {
                std::string detected_gear;
                if (rx_msg.identifier == 0x130) {
                    if ((rx_msg.data[4] & 0xF0) == 0x10) detected_gear = "P";
                    else if ((rx_msg.data[5] & 0xF0) == 0x50) detected_gear = "D";
                    else if ((rx_msg.data[5] & 0xF0) == 0x10) detected_gear = "R";
                } else if (rx_msg.identifier == 0x045) {
                    uint8_t d6 = rx_msg.data[5] & 0x70;
                    if (d6 == 0x00) detected_gear = "P";
                    else if (d6 == 0x50) detected_gear = "D";
                    else if (d6 == 0x60) detected_gear = "N";
                    else if (d6 == 0x70) detected_gear = "R";
                } else if (rx_msg.identifier == 0x070 && rx_msg.data_length_code >= 8) {
                    uint8_t d8 = rx_msg.data[7] & 0x70;
                    if (d8 == 0x00) detected_gear = "P";
                    else if (d8 == 0x50) detected_gear = "D";
                    else if (d8 == 0x60) detected_gear = "N";
                    else if (d8 == 0x70) detected_gear = "R";
                } else if (rx_msg.identifier == 0x035) {
                    for (int idx : {5, 6, 7, 2}) {
                        if (rx_msg.data_length_code > idx) {
                            uint8_t val = rx_msg.data[idx] & 0x70;
                            if (val == 0x00) { detected_gear = "P"; break; }
                            if (val == 0x50) { detected_gear = "D"; break; }
                            if (val == 0x60) { detected_gear = "N"; break; }
                            if (val == 0x70) { detected_gear = "R"; break; }
                        }
                    }
                }
                if (!detected_gear.empty()) {
                    static std::string s_last_gear = "";
                    if (detected_gear != s_last_gear) {
                        s_last_gear = detected_gear;
                        emit_live_entity_state("vehicle_gear_state", detected_gear);
                    }
                }
            }

            // Body Closures, Locks & Hood/Frunk (0x411)
            if (rx_msg.identifier == 0x411 && rx_msg.data_length_code >= 8) {
                bool fl = (rx_msg.data[3] & 0x01); // Driver Door
                bool fr = (rx_msg.data[4] & 0x04); // Passenger Door
                bool hood = (rx_msg.data[5] & 0x10); // Hood / Frunk
                bool rl = (rx_msg.data[6] & 0x10); // Rear Left Door
                bool rr = (rx_msg.data[7] & 0x01); // Rear Right Door
                bool is_locked = (rx_msg.data_length_code >= 3) ? (rx_msg.data[2] == 0x00 || (rx_msg.data[2] & 0x40) == 0) : true;

                std::string new_door_state;
                if (!fl && !fr && !rl && !rr) {
                    new_door_state = "All Doors Closed";
                } else if (fl && fr && rl && rr) {
                    new_door_state = "All Doors Opened";
                } else {
                    std::string s;
                    s += (fl ? "Driver Door Opened" : "Driver Door Closed");
                    s += ", ";
                    s += (fr ? "Passenger Door Opened" : "Passenger Door Closed");
                    s += ", ";
                    s += (rl ? "Rear Left Door Opened" : "Rear Left Door Closed");
                    s += ", ";
                    s += (rr ? "Rear Right Door Opened" : "Rear Right Door Closed");
                    new_door_state = s;
                }

                static std::string s_last_doors = "";
                if (new_door_state != s_last_doors) {
                    s_last_doors = new_door_state;
                    emit_live_entity_state("doors_status", new_door_state);
                }

                static int s_last_locked = -1;
                int locked_int = is_locked ? 1 : 0;
                if (locked_int != s_last_locked) {
                    s_last_locked = locked_int;
                    emit_live_entity_state("door_locks", is_locked ? "Locked" : "Unlocked");
                }

                static int s_last_hood = -1;
                int hood_int = hood ? 1 : 0;
                if (hood_int != s_last_hood) {
                    s_last_hood = hood_int;
                    emit_live_entity_state("hood", hood ? "Open" : "Closed");
                }
            }

            // Power Tailgate / Trunk (0x414)
            if (rx_msg.identifier == 0x414 && rx_msg.data_length_code >= 4) {
                bool tr = (rx_msg.data[3] & 0x01);
                static int s_last_trunk = -1;
                int tr_int = tr ? 1 : 0;
                if (tr_int != s_last_trunk) {
                    s_last_trunk = tr_int;
                    emit_live_entity_state("trunk", tr ? "Open" : "Closed");
                }
            }

            // Charge Port Door (0x3AA)
            if (rx_msg.identifier == 0x3AA && rx_msg.data_length_code >= 5) {
                bool cp = (rx_msg.data[4] & 0x02);
                static int s_last_cp = -1;
                int cp_int = cp ? 1 : 0;
                if (cp_int != s_last_cp) {
                    s_last_cp = cp_int;
                    emit_live_entity_state("charge_port", cp ? "Open" : "Closed");
                }
            }

            // EV Charging Status (0x594 Byte 2)
            if (rx_msg.identifier == 0x594 && rx_msg.data_length_code >= 3) {
                bool chg = (rx_msg.data[2] & 0x01);
                static int s_last_chg = -1;
                int chg_int = chg ? 1 : 0;
                if (chg_int != s_last_chg) {
                    s_last_chg = chg_int;
                    emit_live_entity_state("cond_charging", chg ? "Charging" : "Inactive");
                }
            }

            // Vehicle Odometer (0x227 Bytes 1-3 LE in 0.1 km units)
            if (rx_msg.identifier == 0x227 && rx_msg.data_length_code >= 4) {
                uint32_t raw_odo = rx_msg.data[1] | (rx_msg.data[2] << 8) | (rx_msg.data[3] << 16);
                if (raw_odo > 0) {
                    uint32_t km = (uint32_t)(raw_odo * 0.1f);
                    static uint32_t s_last_km = 0;
                    if (km != s_last_km) {
                        s_last_km = km;
                        emit_live_entity_state("vehicle_odometer", std::to_string(km));
                    }
                }
            }

            // Cabin Target Temperatures (0x380)
            if (rx_msg.identifier == 0x380 && rx_msg.data_length_code >= 4) {
                int rawD = -1, rawP = -1;
                for (int idx : {3, 4, 1}) {
                    if (rx_msg.data_length_code > idx && rx_msg.data[idx] >= 0x06 && rx_msg.data[idx] <= 0x1A) {
                        rawD = rx_msg.data[idx];
                        break;
                    }
                }
                for (int idx : {5, 6, 2}) {
                    if (rx_msg.data_length_code > idx && rx_msg.data[idx] >= 0x06 && rx_msg.data[idx] <= 0x1A) {
                        rawP = rx_msg.data[idx];
                        break;
                    }
                }
                if (rawD >= 0) {
                    int dF = 62 + (rawD - 0x06);
                    int pF = (rawP >= 0) ? (62 + (rawP - 0x06)) : dF;
                    static int s_last_dF = -1, s_last_pF = -1;
                    if (dF != s_last_dF || pF != s_last_pF) {
                        s_last_dF = dF;
                        s_last_pF = pF;
                        emit_live_entity_state("climate_dual_cabin_temp", std::to_string(dF) + " / " + std::to_string(pF));
                    }
                }
            }

            // HVAC Blower Fan Speed (0x31B Byte 3)
            if (rx_msg.identifier == 0x31B && rx_msg.data_length_code >= 4) {
                uint8_t fan_raw = rx_msg.data[3] & 0x0F;
                int speed = (fan_raw >= 2 && fan_raw <= 9) ? (fan_raw - 1) : 0;
                static int s_last_fan = -1;
                if (speed != s_last_fan) {
                    s_last_fan = speed;
                    emit_live_entity_state("climate_fan_speed_level", "Fan " + std::to_string(speed));
                }
            }

            // Rear Defroster (0x541 Byte 4 mask 0xF0 == 0x10)
            if (rx_msg.identifier == 0x541 && rx_msg.data_length_code >= 5) {
                bool def = ((rx_msg.data[4] & 0xF0) == 0x10);
                static int s_last_def = -1;
                int def_int = def ? 1 : 0;
                if (def_int != s_last_def) {
                    s_last_def = def_int;
                    emit_live_entity_state("climate_rear_defog", def ? "ON" : "OFF");
                }
            }

            // Heated Steering Wheel (0x418 Byte 0 & 0x03)
            if (rx_msg.identifier == 0x418 && rx_msg.data_length_code >= 1) {
                bool st_heat = ((rx_msg.data[0] & 0x03) > 0);
                static int s_last_st_heat = -1;
                int heat_int = st_heat ? 1 : 0;
                if (heat_int != s_last_st_heat) {
                    s_last_st_heat = heat_int;
                    emit_live_entity_state("heated_steering_wheel_toggle", st_heat ? "ON" : "OFF");
                }
            }

            // Driver & Passenger Seat Heating / Ventilation (0x496 / 0x475 Byte 0)
            auto decode_seat_comfort = [](uint8_t b) -> const char* {
                if (b == 0x46 || b == 0x02) return "High Heat";
                if (b == 0x4E || b == 0x0A) return "Medium Heat";
                if (b == 0x36 || b == 0x0E) return "Low Heat";
                if (b == 0x2E || b == 0x10) return "High Cool";
                if (b == 0x26 || b == 0x12) return "Medium Cool";
                if (b == 0x1E || b == 0x14) return "Low Cool";
                return "Off";
            };
            if (rx_msg.identifier == 0x496 && rx_msg.data_length_code >= 1) {
                const char* lvl = decode_seat_comfort(rx_msg.data[0]);
                static const char* s_last_drv = nullptr;
                if (lvl != s_last_drv) {
                    s_last_drv = lvl;
                    emit_live_entity_state("drivers_seat_comfort", lvl);
                }
            }
            if (rx_msg.identifier == 0x475 && rx_msg.data_length_code >= 1) {
                const char* lvl = decode_seat_comfort(rx_msg.data[0]);
                static const char* s_last_pass = nullptr;
                if (lvl != s_last_pass) {
                    s_last_pass = lvl;
                    emit_live_entity_state("passengers_seat_comfort", lvl);
                }
            }

            // Rear Heated Seats (0x438 Left, 0x453 Right)
            if (rx_msg.identifier == 0x438 && rx_msg.data_length_code >= 1) {
                uint8_t b = rx_msg.data[0];
                const char* lvl = (b == 0x41) ? "Rear Left High Heat" : (b == 0x31) ? "Rear Left Low Heat" : "Rear Left Off";
                static const char* s_last_rl = nullptr;
                if (lvl != s_last_rl) {
                    s_last_rl = lvl;
                    emit_live_entity_state("rear_seats_comfort", lvl);
                }
            }
            if (rx_msg.identifier == 0x453 && rx_msg.data_length_code >= 1) {
                uint8_t b = rx_msg.data[0];
                const char* lvl = (b == 0x41) ? "Rear Right High Heat" : (b == 0x31) ? "Rear Right Low Heat" : "Rear Right Off";
                static const char* s_last_rr = nullptr;
                if (lvl != s_last_rr) {
                    s_last_rr = lvl;
                    emit_live_entity_state("rear_seats_comfort", lvl);
                }
            }

            // Hazard Lights & Turn Signals (0x413)
            if (rx_msg.identifier == 0x413 && rx_msg.data_length_code >= 4) {
                bool is_haz = ((rx_msg.data[3] & 0x04) != 0);
                static int s_last_haz = -1;
                int haz_int = is_haz ? 1 : 0;
                if (haz_int != s_last_haz) {
                    s_last_haz = haz_int;
                    emit_live_entity_state("hazard_lights", is_haz ? "Active" : "Off");
                }

                uint8_t d3 = rx_msg.data[2];
                const char* dir = (d3 & 0x10) ? "left" : (d3 & 0x40) ? "right" : "off";
                static const char* s_last_dir = nullptr;
                if (dir != s_last_dir) {
                    s_last_dir = dir;
                    emit_live_entity_state("turn_signal", dir);
                }
            }

            // AC / DC Charging Limits (0x1F9: AC limit Byte 2 [D3], DC limit Byte 3 [D4])
            if (rx_msg.identifier == 0x1F9 && rx_msg.data_length_code >= 4) {
                int ac = -1;
                for (int idx : {2, 6, 7}) {
                    if (rx_msg.data_length_code > idx) {
                        uint8_t b = rx_msg.data[idx];
                        if (b == 0x64) { ac = 50; break; }
                        else if (b == 0x78) { ac = 60; break; }
                        else if (b == 0x8C) { ac = 70; break; }
                        else if (b == 0xA0) { ac = 80; break; }
                        else if (b == 0xB4) { ac = 90; break; }
                        else if (b == 0xC8 || b == 0x4A) { ac = 100; break; }
                    }
                }
                if (ac > 0) {
                    static int s_last_ac = -1;
                    if (ac != s_last_ac) {
                        s_last_ac = ac;
                        emit_live_entity_state("ac_charging_limit", std::to_string(ac) + "%");
                    }
                }

                int dc = -1;
                for (int idx : {3, 4}) {
                    if (rx_msg.data_length_code > idx) {
                        uint8_t b = rx_msg.data[idx];
                        if (b == 0x64) { dc = 50; break; }
                        else if (b == 0x78) { dc = 60; break; }
                        else if (b == 0x8C) { dc = 70; break; }
                        else if (b == 0xA0) { dc = 80; break; }
                        else if (b == 0xB4) { dc = 90; break; }
                        else if (b == 0xC8) { dc = 100; break; }
                    }
                }
                if (dc > 0) {
                    static int s_last_dc = -1;
                    if (dc != s_last_dc) {
                        s_last_dc = dc;
                        emit_live_entity_state("dc_charging_limit", std::to_string(dc) + "%");
                    }
                }
            }

            // TPMS Tire Pressures (0x593 or 0x368)
            if ((rx_msg.identifier == 0x593 || rx_msg.identifier == 0x368) && rx_msg.data_length_code >= 4) {
                int fl = (int)(rx_msg.data[0] * 0.2f * 14.5038f + 0.5f);
                int fr = (int)(rx_msg.data[1] * 0.2f * 14.5038f + 0.5f);
                int rl = (int)(rx_msg.data[2] * 0.2f * 14.5038f + 0.5f);
                int rr = (int)(rx_msg.data[3] * 0.2f * 14.5038f + 0.5f);
                if (fl > 20 && fl < 55) {
                    static int s_last_fl = 0, s_last_fr = 0, s_last_rl = 0, s_last_rr = 0;
                    if (fl != s_last_fl || fr != s_last_fr || rl != s_last_rl || rr != s_last_rr) {
                        s_last_fl = fl; s_last_fr = fr; s_last_rl = rl; s_last_rr = rr;
                        char tpms_buf[64];
                        snprintf(tpms_buf, sizeof(tpms_buf), "FL: %d FR: %d RL: %d RR: %d PSI", fl, fr, rl, rr);
                        emit_live_entity_state("wheel_speeds", tpms_buf);
                    }
                }
            }

            // Sunroof Glass (0x442 Byte 6)
            if (rx_msg.identifier == 0x442 && rx_msg.data_length_code >= 7) {
                uint8_t d7 = rx_msg.data[6];
                const char* s_state = (d7 == 0x60 || d7 == 0x20) ? "open" : (d7 == 0x00) ? "vent" : "closed";
                static const char* s_last_roof = nullptr;
                if (s_state != s_last_roof) {
                    s_last_roof = s_state;
                    emit_live_entity_state("sunroof_extended", s_state);
                }
            }
            rtc_crash_record(rx_msg.identifier, rx_msg.data_length_code, rx_msg.data, 900, "frame_done");
        } else {
            rx_processed = 0;
            // Cleanly extinguish yellow CAN activity LED when bus is idle (>200ms)
            if (s_last_can_frame_ms > 0 && (now_ms - s_last_can_frame_ms > 200)) {
                board_led_can_set(false);
            }
        }
        static uint32_t s_last_precon_tick_ms = 0;
        if (now_ms - s_last_precon_tick_ms >= 40) {
            s_last_precon_tick_ms = now_ms;
            precondition_tick();
            track_popup_tick();
        }

        static uint32_t s_last_hud_tick_ms = 0;
        uint32_t now_hud_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
        if (now_hud_ms - s_last_hud_tick_ms >= 100) {
            s_last_hud_tick_ms = now_hud_ms;
            hud_nav_tick_100ms();
        }

        if (rx_processed >= 20) {
            vTaskDelay(pdMS_TO_TICKS(1));
            rx_processed = 0;
        }
    }
}

void can_tx_task(void* arg) {
    CanBurstCmd* cmd = nullptr;
    ESP_LOGI(TAG, "CAN TX task running");

    while (true) {
        if (xQueueReceive(tx_command_queue, &cmd, portMAX_DELAY) == pdTRUE && cmd) {
            if (cmd->async) {
                xTaskCreate(execute_can_burst_async_task, "can_tx_async", 4096, cmd, 5, NULL);
            } else {
                s_current_firing_trigger_id = cmd->trigger_id;
                if (cmd->steps && !cmd->steps->empty()) {
                    execute_can_burst(cmd->can_id, *cmd->steps, cmd->delay_ms);
                } else if (!cmd->inline_steps.empty()) {
                    execute_can_burst(cmd->can_id, cmd->inline_steps, cmd->delay_ms);
                }
                s_current_firing_trigger_id = "";
                delete cmd;
            }
        }
    }
}

void time_scheduler_task(void* arg) {
    ESP_LOGI(TAG, "Time scheduler task running");
    int last_checked_min = -1;

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));

        time_t now;
        time(&now);
        struct tm timeinfo;
        localtime_r(&now, &timeinfo);

        // Wait until clock has synchronized (year 2024 or later)
        if (timeinfo.tm_year < (2024 - 1900)) {
            continue;
        }

        int cur_min = timeinfo.tm_hour * 60 + timeinfo.tm_min;
        if (cur_min == last_checked_min) {
            continue;
        }
        last_checked_min = cur_min;

        int cur_wday = timeinfo.tm_wday; // 0=Sun .. 6=Sat

        if (!g_automations_enabled.load()) {
            continue;
        }

        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
        for (auto& rule : global_automations) {
            if (!rule.enabled) continue;

            for (const auto& trig : rule.triggers) {
                if (trig.type == "time_schedule") {
                    if (trig.schedule_time_min == cur_min && (trig.weekdays_mask & (1 << cur_wday))) {
                        if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
                            continue;
                        }

                        bool passed = true;
                        for (const auto& cond : rule.conditions) {
                            if (!evaluate_condition(cond)) {
                                passed = false;
                                break;
                            }
                        }

                        if (passed) {
                            ESP_LOGI(TAG, "Time schedule fired rule: %s (%02d:%02d)", rule.name.c_str(), timeinfo.tm_hour, timeinfo.tm_min);
                            rule.last_exec_time_ms = now_ms;
                            broadcast_ws_automation_event(rule.id, rule.name);
                            queue_action_steps_ptr(0, 20, &rule.actions, trig.id);
                        }
                    }
                }
            }
        }
    }
}

void can_engine_on_device_event(const std::string& event_type, const std::string& detail_str, int8_t rssi) {
    if (!g_automations_enabled.load()) return;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

    for (auto& rule : global_automations) {
        if (!rule.enabled) continue;

        for (const auto& trig : rule.triggers) {
            if (trig.type == "wifi" || trig.type == "wifi_event" || trig.type == "device_event") {
                bool event_match = false;
                if (trig.wifi_event == event_type) {
                    event_match = true;
                } else if (event_type == "wifi_connected" && (trig.wifi_event == "connected" || trig.wifi_event == "sta_connected")) {
                    event_match = true;
                } else if (event_type == "wifi_disconnected" && (trig.wifi_event == "disconnected" || trig.wifi_event == "sta_disconnected")) {
                    event_match = true;
                }

                if (!event_match) continue;

                // Match SSID if specified
                if (!trig.ssid.empty() && (event_type == "wifi_connected" || event_type == "wifi_disconnected")) {
                    if (strcasecmp(trig.ssid.c_str(), detail_str.c_str()) != 0) {
                        continue;
                    }
                }

                // Match client MAC if specified
                if (!trig.client_mac.empty() && (event_type == "ap_client_connected" || event_type == "ap_client_disconnected")) {
                    if (!mac_matches(trig.client_mac, detail_str)) {
                        continue;
                    }
                }

                // Match target RSSI if specified
                if (trig.target_rssi != 0 && event_type == "ap_client_connected") {
                    if (rssi < trig.target_rssi) {
                        continue;
                    }
                }

                // Check rule cooldown
                if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
                    continue;
                }

                // Evaluate conditions
                s_current_firing_trigger_id = trig.id;
                bool passed = true;
                for (const auto& cond : rule.conditions) {
                    if (!evaluate_condition(cond)) {
                        passed = false;
                        break;
                    }
                }

                if (passed) {
                    ESP_LOGI(TAG, "Device/Wi-Fi event triggered automation: %s (trigger: %s, event: %s)",
                             rule.name.c_str(), trig.id.c_str(), event_type.c_str());
                    rule.last_exec_time_ms = now_ms;
                    broadcast_ws_automation_event(rule.id, rule.name);
                    queue_action_steps_ptr(0, 20, &rule.actions, trig.id);
                }
            }
        }
    }
}

void can_engine_on_ble_event(const std::string& address, const std::string& button, const std::string& action, const std::string& combo) {
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    s_last_ble_event.address = address;
    s_last_ble_event.button = button;
    s_last_ble_event.combo = combo;
    s_last_ble_event.action = action;
    s_last_ble_event.timestamp_ms = now_ms;

    mqtt_mgr_publish_ble_button(address, button, action, combo);

    if (!g_automations_enabled.load()) return;

    for (auto& rule : global_automations) {
        if (!rule.enabled) continue;

        for (const auto& trig : rule.triggers) {
            if (trig.type == "ble_button" || trig.type == "ble_key" || trig.type == "ble") {
                // Match button (or combo chord string, e.g. "mute+volume_down" or "key_1+key_2")
                if (!trig.ble_button.empty() && trig.ble_button != "any") {
                    bool btn_match = (strcasecmp(trig.ble_button.c_str(), button.c_str()) == 0);
                    if (!btn_match && !combo.empty()) {
                        btn_match = (strcasecmp(trig.ble_button.c_str(), combo.c_str()) == 0);
                    }
                    if (!btn_match) {
                        continue;
                    }
                }

                // Match action (press, release, hold, combo_*)
                if (!trig.ble_action.empty() && trig.ble_action != "any") {
                    bool action_match = (strcasecmp(trig.ble_action.c_str(), action.c_str()) == 0);
                    if (!action_match && trig.ble_action == "press" && action.rfind("combo_", 0) == 0) {
                        action_match = true;
                    }
                    if (!action_match) continue;
                }

                // Match device address / MAC if specified
                if (!trig.ble_device.empty()) {
                    if (!mac_matches(trig.ble_device, address)) {
                        continue;
                    }
                }

                // Check rule cooldown
                if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
                    continue;
                }

                // Evaluate conditions
                s_current_firing_trigger_id = trig.id;
                bool passed = true;
                for (const auto& cond : rule.conditions) {
                    if (!evaluate_condition(cond)) {
                        passed = false;
                        break;
                    }
                }

                if (passed) {
                    ESP_LOGI(TAG, "BLE event triggered automation: %s (trigger: %s, button: %s, action: %s)",
                             rule.name.c_str(), trig.id.c_str(), button.c_str(), action.c_str());
                    rule.last_exec_time_ms = now_ms;
                    broadcast_ws_automation_event(rule.id, rule.name);
                    queue_action_steps_ptr(0, 20, &rule.actions, trig.id);
                }
            }
        }
    }
}

void can_engine_on_ble_device_event(const std::string& address, const std::string& event, int8_t rssi, const std::string& name) {
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    auto& info = s_ble_devices[address];
    info.address = address;
    if (!name.empty()) info.name = name;
    if (event == "connected") info.connected = true;
    else if (event == "disconnected") info.connected = false;
    if (rssi != 0) info.rssi = rssi;
    info.last_seen_ms = now_ms;

    mqtt_mgr_publish_ble_device(address, event, rssi, name);

    if (!g_automations_enabled.load()) return;

    for (auto& rule : global_automations) {
        if (!rule.enabled) continue;

        for (const auto& trig : rule.triggers) {
            if (trig.type == "ble_device_event" || trig.type == "ble_device" || trig.type == "ble_presence") {
                // Match event: "connected", "disconnected", "proximity"
                if (!trig.ble_event.empty() && trig.ble_event != "any") {
                    if (strcasecmp(trig.ble_event.c_str(), event.c_str()) != 0) {
                        continue;
                    }
                }

                // Match device MAC if specified
                if (!trig.ble_device.empty()) {
                    if (!mac_matches(trig.ble_device, address) && strcasecmp(trig.ble_device.c_str(), name.c_str()) != 0) {
                        continue;
                    }
                }

                // Match target RSSI if specified
                if (trig.target_rssi != 0 && (event == "connected" || event == "proximity")) {
                    if (rssi < trig.target_rssi) {
                        continue;
                    }
                }

                // Check rule cooldown
                if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
                    continue;
                }

                // Evaluate conditions
                s_current_firing_trigger_id = trig.id;
                bool passed = true;
                for (const auto& cond : rule.conditions) {
                    if (!evaluate_condition(cond)) {
                        passed = false;
                        break;
                    }
                }

                if (passed) {
                    ESP_LOGI(TAG, "BLE device event triggered automation: %s (trigger: %s, event: %s, mac: %s)",
                             rule.name.c_str(), trig.id.c_str(), event.c_str(), address.c_str());
                    rule.last_exec_time_ms = now_ms;
                    broadcast_ws_automation_event(rule.id, rule.name);
                    queue_action_steps_ptr(0, 20, &rule.actions, trig.id);
                }
            }
        }
    }
}

void can_engine_on_ble_beacon_event(const std::string& uuid, const std::string& event, int8_t rssi, uint16_t major, uint16_t minor, const std::string& mac, const std::string& name) {
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    std::string key = !uuid.empty() ? uuid : mac;
    if (key.empty()) return;

    auto& info = s_ble_beacons[key];
    info.uuid = uuid;
    if (!mac.empty()) info.mac = mac;
    if (!name.empty()) info.name = name;
    if (major != 0) info.major = major;
    if (minor != 0) info.minor = minor;
    if (rssi != 0) info.rssi = rssi;
    info.last_seen_ms = now_ms;
    if (event == "enter") info.present = true;
    else if (event == "exit") info.present = false;
    else if (event == "proximity") info.present = true;

    if (!mac.empty() && mac != key) {
        s_ble_beacons[mac] = info;
    }

    mqtt_mgr_publish_ble_beacon(uuid, event, rssi, major, minor, mac, name);

    if (!g_automations_enabled.load()) return;

    for (auto& rule : global_automations) {
        if (!rule.enabled) continue;

        for (const auto& trig : rule.triggers) {
            if (trig.type == "ble_beacon" || trig.type == "beacon" || trig.type == "ble_presence") {
                // Match event: "enter", "exit", "proximity", "any"
                if (!trig.ble_event.empty() && trig.ble_event != "any") {
                    if (strcasecmp(trig.ble_event.c_str(), event.c_str()) != 0) {
                        continue;
                    }
                }

                // Match UUID / MAC / Name if specified
                const std::string& target_filter = !trig.beacon_uuid.empty() ? trig.beacon_uuid : (!trig.ble_device.empty() ? trig.ble_device : trig.client_mac);
                if (!target_filter.empty()) {
                    bool match = false;
                    if (!uuid.empty() && strcasestr(uuid.c_str(), target_filter.c_str()) != nullptr) match = true;
                    if (!mac.empty() && mac_matches(target_filter, mac)) match = true;
                    if (!name.empty() && strcasecmp(target_filter.c_str(), name.c_str()) == 0) match = true;
                    if (!match) continue;
                }

                // Match target RSSI if specified
                if (trig.target_rssi != 0 && (event == "enter" || event == "proximity")) {
                    if (rssi < trig.target_rssi) {
                        continue;
                    }
                }

                // Check rule cooldown
                if (rule.last_exec_time_ms != 0 && (now_ms - rule.last_exec_time_ms < rule.cooldown_ms)) {
                    continue;
                }

                // Evaluate conditions
                s_current_firing_trigger_id = trig.id;
                bool passed = true;
                for (const auto& cond : rule.conditions) {
                    if (!evaluate_condition(cond)) {
                        passed = false;
                        break;
                    }
                }

                if (passed) {
                    ESP_LOGI(TAG, "BLE beacon event triggered automation: %s (trigger: %s, event: %s, uuid: %s, rssi: %d)",
                             rule.name.c_str(), trig.id.c_str(), event.c_str(), uuid.c_str(), rssi);
                    rule.last_exec_time_ms = now_ms;
                    broadcast_ws_automation_event(rule.id, rule.name);
                    queue_action_steps_ptr(0, 20, &rule.actions, trig.id);
                }
            }
        }
    }
}



