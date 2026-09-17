#pragma once

#include "driver/gpio.h"
#include "esp_log.h"

// =========================================================================
// MeatPi WiCAN-OBD (ESP32-C3) Pin Definitions
//
// Case Icons (Left to Right):
// 1. Power Icon (Left)    : GPIO 7 (Blue LED, Active HIGH: 1 = ON, 0 = OFF)
// 2. Wi-Fi Icon (Middle)  : GPIO 8 (Green LED, Active LOW:  0 = ON, 1 = OFF)
// 3. Envelope Icon (Right): GPIO 9 (Yellow LED, Active LOW: 0 = ON, 1 = OFF)
// =========================================================================

#define CAN_TX_PIN         GPIO_NUM_0
#define CAN_RX_PIN         GPIO_NUM_3
#define CAN_STB_PIN        GPIO_NUM_6   // Active LOW: 0 = Transceiver ENABLED, 1 = Standby

#define LED_POWER_PIN      GPIO_NUM_7   // Left: Power icon (Blue LED, Active HIGH)
#define LED_WIFI_PIN       GPIO_NUM_8   // Middle: Wi-Fi icon (Green LED, Active LOW)
#define LED_MSG_PIN        GPIO_NUM_9   // Right: Envelope icon (Yellow LED, Active LOW)

#define VBAT_ADC_PIN       GPIO_NUM_4   // OBD Battery voltage ADC

static inline void board_hardware_init(void) {
    // Configure CAN Standby and LED pins as outputs
    gpio_config_t io_conf = {};
    io_conf.intr_type = GPIO_INTR_DISABLE;
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pin_bit_mask = (1ULL << CAN_STB_PIN) |
                           (1ULL << LED_POWER_PIN) |
                           (1ULL << LED_WIFI_PIN) |
                           (1ULL << LED_MSG_PIN);
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    gpio_config(&io_conf);

    // CRITICAL: Pull Standby pin LOW to enable the CAN transceiver
    gpio_set_level(CAN_STB_PIN, 0);

    // Turn ON Power LED (Blue, Active HIGH: 1 = ON)
    gpio_set_level(LED_POWER_PIN, 1);

    // Initialize Wi-Fi LED to OFF until Wi-Fi starts (Active LOW: 1 = OFF)
    gpio_set_level(LED_WIFI_PIN, 1);

    // Initialize Message/Envelope LED to OFF (Active LOW: 1 = OFF)
    gpio_set_level(LED_MSG_PIN, 1);

    ESP_LOGI("BOARD", "WiCAN-OBD hardware initialized: Power LED ON, CAN STB=0 enabled");
}

// Wi-Fi LED (Middle icon / Green): Active LOW -> 0 = ON, 1 = OFF
static inline void board_led_wifi(bool active) {
    gpio_set_level(LED_WIFI_PIN, active ? 0 : 1);
}

// Message/Envelope LED (Right icon / Yellow): Active LOW -> toggles on CAN traffic
static inline void board_led_can_activity(void) {
    static bool state = false;
    state = !state;
    gpio_set_level(LED_MSG_PIN, state ? 0 : 1);
}
