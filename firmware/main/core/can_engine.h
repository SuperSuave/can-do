#pragma once

#include "types.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/twai.h"
#include "can.h"
#include <unordered_map>
#include <array>
#include <atomic>

struct CachedCanFrame {
    uint8_t dlc;
    uint8_t data[8];
};

extern QueueHandle_t tx_command_queue;

// Global Control Flags
extern std::atomic<bool> g_automations_enabled;
extern std::atomic<bool> g_sniffer_mode;
extern std::atomic<bool> g_hardware_listen_only;
extern std::atomic<bool> g_mitm_bridge_enabled;
extern std::atomic<bool> g_twai_reconfig_pending;
extern std::atomic<twai_mode_t> g_twai_requested_mode;

void set_automations_enabled(bool enabled);
void set_sniffer_mode(bool enabled, bool hardware_listen_only);
void set_mitm_bridge_enabled(bool enabled);
void can_engine_load_preferences(void);

void init_can_engine(void);
esp_err_t can_engine_get_status_info(twai_status_info_t* status_info);
extern "C" bool can_engine_is_bus_awake(uint32_t max_silence_ms);
bool can_engine_inject_frame(const twai_message_t* msg);
bool evaluate_condition(const AutomationCondition& cond);
bool is_match(const uint8_t* incoming_data, const EntityOption& option, uint8_t dlc = 8);

void execute_can_burst(uint32_t can_id, const std::vector<ActionStep>& steps, uint32_t delay_ms);
bool queue_entity_command(const std::string& entity_id, const std::string& command_label);
bool queue_action_steps(uint32_t can_id, uint32_t delay_ms, const std::vector<ActionStep>& steps, const std::string& trigger_id = "", std::shared_ptr<std::atomic<bool>> rule_is_running = nullptr);
bool get_cached_can_frame(uint32_t can_id, uint8_t out_data[8], uint8_t* out_dlc = nullptr);

struct BleButtonEvent;

void can_rx_task(void* arg);
void can_tx_task(void* arg);
void time_scheduler_task(void* arg);
void can_engine_on_device_event(const std::string& event_type, const std::string& detail_str, int8_t rssi = 0);
void can_engine_on_ble_event(const std::string& address, const std::string& button, const std::string& action, const std::string& combo = "", uint32_t hold_seconds = 0);
void can_engine_set_ble_learn_mode(bool active, uint32_t duration_ms = 30000);
void can_engine_on_ble_device_event(const std::string& address, const std::string& event, int8_t rssi, const std::string& name = "");
void can_engine_on_ble_beacon_event(const std::string& uuid, const std::string& event, int8_t rssi, uint16_t major = 0, uint16_t minor = 0, const std::string& mac = "", const std::string& name = "");

#define RTC_CRASH_MAGIC 0xDEADBEE2
#define RTC_CAN_STATE_MAGIC 0xCA11D002
#define RTC_MAX_SAVED_FRAMES 128

struct RtcCanFrameEntry {
    uint32_t can_id;
    uint8_t  dlc;
    uint8_t  data[8];
};

struct RtcCanStateCache {
    uint32_t magic;
    uint32_t crc32;
    uint32_t count;
    uint32_t timestamp_sec;
    int64_t  esp_timer_us_at_sync;
    uint64_t wall_time_epoch_at_sync;
    uint8_t  time_valid;
    RtcCanFrameEntry frames[RTC_MAX_SAVED_FRAMES];
};

extern std::atomic<bool> g_state_restored_from_rtc;

void rtc_can_state_save(void);
bool rtc_can_state_restore(void);
void rtc_clock_anchor_update(uint64_t epoch_sec);
void can_engine_hydrate_from_mqtt(const std::string& entity_id, const std::string& state);
void decode_can_frame_entities(uint32_t identifier, const uint8_t* data, uint8_t data_length_code);

// Active CAN ID discovery tracking
void can_engine_record_active_id(uint32_t can_id);
std::vector<uint32_t> can_engine_get_active_ids(void);
bool can_engine_has_active_ids_changed(void);
void can_engine_clear_active_ids_changed(void);

struct RtcCrashInfo {
    uint32_t magic;
    uint32_t can_id;
    uint8_t  dlc;
    uint8_t  data[8];
    uint32_t step_marker;
    char     last_decoder[32];
    uint32_t uptime_sec;
    uint32_t free_heap;
    uint32_t min_free_heap;
    uint32_t internal_free_heap;
    uint32_t can0_rx_overflow;
    uint32_t can1_rx_overflow;
    uint8_t  twdt_triggered;
    uint8_t  last_abnormal_reset_reason;
    char     cpu0_task[16];
    char     cpu1_task[16];
    char     last_event[32];
};

const RtcCrashInfo* get_rtc_crash_info(void);
void rtc_crash_record(uint32_t can_id, uint8_t dlc, const uint8_t* data, uint32_t step, const char* decoder);
void rtc_crash_record_event(const char* event_name);
void init_crash_diagnostics(void);
