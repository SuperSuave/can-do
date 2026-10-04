#pragma once

#include <string>
#include "driver/twai.h"
#include "driver/uart.h"

// MeatPi WiCAN Header Pins for UART1
// IO1 = GPIO_NUM_1 (TX)
// IO5 = GPIO_NUM_5 (RX)
#define UART_BRIDGE_PORT        UART_NUM_1
#define UART_BRIDGE_TX_PIN      GPIO_NUM_1
#define UART_BRIDGE_RX_PIN      GPIO_NUM_5
#define UART_BRIDGE_BAUD_RATE   921600

void uart_bridge_init(void);
void uart_bridge_send_raw(const std::string& line);
void uart_bridge_send_state(const std::string& entity_id, const std::string& state);
void uart_bridge_send_can_frame(const twai_message_t* msg);
void uart_bridge_send_all_states(void);
