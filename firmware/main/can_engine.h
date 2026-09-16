#pragma once

#include "types.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/twai.h"
#include <unordered_map>
#include <array>

extern std::unordered_map<uint32_t, std::array<uint8_t, 8>> can_state_cache;
extern QueueHandle_t tx_command_queue;

void init_can_engine(void);
void update_state_cache(uint32_t can_id, const uint8_t* data);
bool evaluate_condition(const AutomationCondition& cond);
bool is_match(const uint8_t* incoming_data, const EntityOption& option);

void execute_can_burst(uint32_t can_id, const std::vector<ActionStep>& steps, uint32_t delay_ms);
bool queue_entity_command(const std::string& entity_id, const std::string& command_label);
bool queue_action_steps(uint32_t can_id, uint32_t delay_ms, const std::vector<ActionStep>& steps);

void can_rx_task(void* arg);
void can_tx_task(void* arg);
