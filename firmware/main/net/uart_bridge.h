#pragma once

#include <string>
#include "driver/twai.h"
#include "driver/uart.h"

// MeatPi WiCAN Corner 2.54mm Header Pins:
// TX pad = GPIO_NUM_21 (Connect to Atom Lite RX / G21)
// RX pad = GPIO_NUM_20 (Connect to Atom Lite TX / G25)
#define UART_BRIDGE_PORT        UART_NUM_1
#define UART_BRIDGE_TX_PIN      GPIO_NUM_21
#define UART_BRIDGE_RX_PIN      GPIO_NUM_20
#define UART_BRIDGE_BAUD_RATE   460800

void uart_bridge_init(void);
void uart_bridge_send_raw(const std::string& line);
void uart_bridge_send_state(const std::string& entity_id, const std::string& state);
void uart_bridge_send_can_frame(const twai_message_t* msg);
void uart_bridge_send_all_states(void);
void uart_bridge_request_all_states(void);
std::string uart_bridge_get_ble_status(void);
bool uart_bridge_is_online(void);
