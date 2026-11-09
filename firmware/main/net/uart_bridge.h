#pragma once

#include <string>
#include "driver/twai.h"
#include "driver/uart.h"
#include "board_pins.h"

void uart_bridge_init(void);
void uart_bridge_send_raw(const std::string& line);
void uart_bridge_send_state(const std::string& entity_id, const std::string& state);
void uart_bridge_send_can_frame(const twai_message_t* msg);
void uart_bridge_send_all_states(void);
void uart_bridge_request_all_states(void);
std::string uart_bridge_get_ble_status(void);
bool uart_bridge_is_online(void);
