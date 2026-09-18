#pragma once

#include "types.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/twai.h"
#include <unordered_map>
#include <array>
#include <atomic>

extern std::unordered_map<uint32_t, std::array<uint8_t, 8>> can_state_cache;
extern QueueHandle_t tx_command_queue;

// Global Control Flags
extern std::atomic<bool> g_automations_enabled;
extern std::atomic<bool> g_sniffer_mode;
extern std::atomic<bool> g_hardware_listen_only;
extern std::atomic<bool> g_twai_reconfig_pending;
extern std::atomic<twai_mode_t> g_twai_requested_mode;

void set_automations_enabled(bool enabled);
void set_sniffer_mode(bool enabled, bool hardware_listen_only);

void init_can_engine(void);
void update_state_cache(uint32_t can_id, const uint8_t* data);
bool evaluate_condition(const AutomationCondition& cond);
bool is_match(const uint8_t* incoming_data, const EntityOption& option);

void execute_can_burst(uint32_t can_id, const std::vector<ActionStep>& steps, uint32_t delay_ms);
bool queue_entity_command(const std::string& entity_id, const std::string& command_label);
bool queue_action_steps(uint32_t can_id, uint32_t delay_ms, const std::vector<ActionStep>& steps);
bool can_state_cache_get(uint32_t can_id, uint8_t byte_index, uint32_t* out_val);
bool get_cached_can_frame(uint32_t can_id, uint8_t out_data[8]);
void cando_execute_climate_target(float target_c, const char *zone, bool sync_on, bool driver_only);

void can_rx_task(void* arg);
void can_tx_task(void* arg);
void time_scheduler_task(void* arg);
