#pragma once

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"

#if CONFIG_IDF_TARGET_ESP32S3

// =========================================================================
// ESP32-S3 DevKitC-1-N8R2 + Waveshare 2-CH Isolated CAN FD HAT
// 10-Pin Header Alignment (Scooted down 2 pins: GPIO 6 through GPIO 9)
// =========================================================================

// Channel 1 (CAN FD / 500kbps nominal + 2Mbps data phase) - Top 5 pins of header
#define CAN1_SPI_HOST       SPI3_HOST
#define CAN1_INT_PIN        GPIO_NUM_6    // HAT Pin 1: INT_1
#define CAN1_CS_PIN         GPIO_NUM_7    // HAT Pin 2: CE_1
#define CAN1_SPI_SCK_PIN    GPIO_NUM_15   // HAT Pin 3: SCLK_1
#define CAN1_SPI_MOSI_PIN   GPIO_NUM_16   // HAT Pin 4: MOSI_1
#define CAN1_SPI_MISO_PIN   GPIO_NUM_17   // HAT Pin 5: MISO_1

// Channel 0 (Standard CAN 2.0B / 500kbps) - Bottom 5 pins of header
#define CAN0_SPI_HOST       SPI2_HOST
#define CAN0_INT_PIN        GPIO_NUM_18   // HAT Pin 6: INT_0
#define CAN0_CS_PIN         GPIO_NUM_8    // HAT Pin 7: CE_0
#define CAN0_SPI_SCK_PIN    GPIO_NUM_3    // HAT Pin 8: SCLK_0
#define CAN0_SPI_MOSI_PIN   GPIO_NUM_46   // HAT Pin 9: MOSI_0
#define CAN0_SPI_MISO_PIN   GPIO_NUM_9    // HAT Pin 10: MISO_0

// Fallback internal TWAI pins (if external MCP2518FD not detected)
#define CAN_TX_PIN          GPIO_NUM_13
#define CAN_RX_PIN          GPIO_NUM_14
#define CAN_STB_PIN         GPIO_NUM_NC

// DevKitC-1 Onboard RGB Status LED
#define LED_POWER_PIN       GPIO_NUM_48
#define LED_WIFI_PIN        GPIO_NUM_NC
#define LED_MSG_PIN         GPIO_NUM_NC

#define VBAT_ADC_PIN        GPIO_NUM_1

// DevKitC-1 UART bridge (disabled / NC when bench testing standalone)
#define UART_BRIDGE_PORT        UART_NUM_1
#define UART_BRIDGE_TX_PIN      GPIO_NUM_NC
#define UART_BRIDGE_RX_PIN      GPIO_NUM_NC
#define UART_BRIDGE_BAUD_RATE   460800

static inline void board_hardware_init(void) {
    // Configure DevKitC-1 Status LED
    if (LED_POWER_PIN >= 0) {
        gpio_config_t io_conf = {};
        io_conf.intr_type = GPIO_INTR_DISABLE;
        io_conf.mode = GPIO_MODE_OUTPUT;
        io_conf.pin_bit_mask = (1ULL << LED_POWER_PIN);
        io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
        io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
        gpio_config(&io_conf);
        gpio_set_level(LED_POWER_PIN, 1);
    }

    ESP_LOGI("BOARD", "ESP32-S3 Dual-CAN hardware initialized (Waveshare 2-CH CAN FD)");
}

static inline void board_led_wifi(bool active) {
    if (LED_WIFI_PIN >= 0) {
        gpio_set_level(LED_WIFI_PIN, active ? 0 : 1);
    }
}

static inline void board_led_can_set(bool on) {
    if (LED_MSG_PIN >= 0) {
        gpio_set_level(LED_MSG_PIN, on ? 0 : 1);
    }
}

static inline void board_led_can_activity(void) {
    static int64_t s_last_toggle_us = 0;
    static bool s_state = false;
    int64_t now_us = esp_timer_get_time();
    if (now_us - s_last_toggle_us >= 50000) {
        s_last_toggle_us = now_us;
        s_state = !s_state;
        if (LED_MSG_PIN >= 0) {
            gpio_set_level(LED_MSG_PIN, s_state ? 0 : 1);
        } else if (LED_POWER_PIN >= 0) {
            gpio_set_level(LED_POWER_PIN, s_state ? 1 : 0);
        }
    }
}

#else

// =========================================================================
// MeatPi WiCAN-OBD (ESP32-C3) Pin Definitions
// =========================================================================
#define CAN_TX_PIN         GPIO_NUM_0
#define CAN_RX_PIN         GPIO_NUM_3
#define CAN_STB_PIN        GPIO_NUM_6   // Active LOW: 0 = Transceiver ENABLED, 1 = Standby

#define LED_POWER_PIN      GPIO_NUM_7   // Left: Power icon (Blue LED, Active HIGH)
#define LED_WIFI_PIN       GPIO_NUM_8   // Middle: Wi-Fi icon (Green LED, Active LOW)
#define LED_MSG_PIN        GPIO_NUM_9   // Right: Envelope icon (Yellow LED, Active LOW)

#define VBAT_ADC_PIN       GPIO_NUM_4   // OBD Battery voltage ADC

// MeatPi WiCAN Corner 2.54mm Header Pins:
// TX pad = GPIO_NUM_21 (Connect to Atom Lite RX / G21)
// RX pad = GPIO_NUM_20 (Connect to Atom Lite TX / G25)
#define UART_BRIDGE_PORT        UART_NUM_1
#define UART_BRIDGE_TX_PIN      GPIO_NUM_21
#define UART_BRIDGE_RX_PIN      GPIO_NUM_20
#define UART_BRIDGE_BAUD_RATE   460800

static inline void board_hardware_init(void) {
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

    gpio_set_level(CAN_STB_PIN, 0); // Active LOW: enable transceiver
    gpio_set_level(LED_POWER_PIN, 1);
    gpio_set_level(LED_WIFI_PIN, 1);
    gpio_set_level(LED_MSG_PIN, 1);

    ESP_LOGI("BOARD", "WiCAN-OBD hardware initialized: Power LED ON, CAN STB=0 enabled");
}

static inline void board_led_wifi(bool active) {
    gpio_set_level(LED_WIFI_PIN, active ? 0 : 1);
}

static inline void board_led_can_set(bool on) {
    gpio_set_level(LED_MSG_PIN, on ? 0 : 1);
}

static inline void board_led_can_activity(void) {
    static int64_t s_last_toggle_us = 0;
    static bool s_state = false;
    int64_t now_us = esp_timer_get_time();
    if (now_us - s_last_toggle_us >= 50000) {
        s_last_toggle_us = now_us;
        s_state = !s_state;
        gpio_set_level(LED_MSG_PIN, s_state ? 0 : 1);
    }
}

#endif
