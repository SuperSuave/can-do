#pragma once

#include "driver/gpio.h"
#include "esp_log.h"

// =========================================================================
// MeatPi WiCAN-OBD (ESP32-C3) Pin Definitions
// =========================================================================

#define CAN_TX_PIN         GPIO_NUM_0
#define CAN_RX_PIN         GPIO_NUM_3
#define CAN_STB_PIN        GPIO_NUM_6   // Active LOW: 0 = Transceiver ENABLED, 1 = Standby

#define LED_BLUE_PIN       GPIO_NUM_7   // Wi-Fi / AP status
#define LED_GREEN_PIN      GPIO_NUM_8   // CAN bus activity
#define LED_YELLOW_PIN     GPIO_NUM_9   // System ready / Power indicator

#define VBAT_ADC_PIN       GPIO_NUM_4   // OBD Battery voltage ADC

static inline void board_hardware_init(void) {
    // Configure CAN Standby and LED pins as outputs
    gpio_config_t io_conf = {};
    io_conf.intr_type = GPIO_INTR_DISABLE;
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pin_bit_mask = (1ULL << CAN_STB_PIN) |
                           (1ULL << LED_BLUE_PIN) |
                           (1ULL << LED_GREEN_PIN) |
                           (1ULL << LED_YELLOW_PIN);
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    gpio_config(&io_conf);

    // CRITICAL: Pull Standby pin LOW to enable the CAN transceiver
    gpio_set_level(CAN_STB_PIN, 0);

    // Turn on Yellow LED to indicate firmware is running
    gpio_set_level(LED_YELLOW_PIN, 1);
    gpio_set_level(LED_GREEN_PIN, 0);
    gpio_set_level(LED_BLUE_PIN, 0);

    ESP_LOGI("BOARD", "WiCAN-OBD hardware initialized: CAN TX=0, RX=3, STB=6 (Active LOW enabled)");
}

static inline void board_led_can_activity(void) {
    static bool toggle = false;
    toggle = !toggle;
    gpio_set_level(LED_GREEN_PIN, toggle ? 1 : 0);
}

static inline void board_led_wifi(bool active) {
    gpio_set_level(LED_BLUE_PIN, active ? 1 : 0);
}
