#ifndef __MOOD_LIGHT_H__
#define __MOOD_LIGHT_H__

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include "can.h"
#include "driver/twai.h"

#ifdef __cplusplus
extern "C" {
#endif

// Target Diagnostic CAN IDs on M-CAN / BCM Gateway
#define MOOD_LIGHT_ISOTP_TX_ID   0x7A0U  // BCM / ICU Gateway Physical Request
#define MOOD_LIGHT_ISOTP_FC_ID   0x7A8U  // BCM / ICU Flow Control Response

/**
 * Initialize ISO-TP transmitter worker for Ambient Mood Lighting.
 */
void mood_light_init(void);

/**
 * Frame RX hook to feed Flow Control frames back into isotp_tx.
 */
void mood_light_rx(const twai_message_t *msg, can_bus_t rx_bus);

/**
 * Set 9-byte DualLight RGB Color & Animation mode.
 * @param red   16-bit Red level (0-255 or 0-65535)
 * @param green 16-bit Green level (0-255 or 0-65535)
 * @param blue  16-bit Blue level (0-255 or 0-65535)
 * @param mode  Animation mode (0=Off, 1=Normal, 2=Welcome, 3=DriveMode Sync)
 */
bool mood_light_set_rgb(uint16_t red, uint16_t green, uint16_t blue, uint8_t mode);

/**
 * Set 10-byte Ambient Light parameters.
 * @param red, green, blue 16-bit RGB levels
 * @param brightness       1-100% or 1-10 level
 * @param dimmed_driving   dim while driving (0 or 1)
 * @param drive_mode_sync  depends on drive mode (0 or 1)
 * @param fade_in_out      fade in/out transition (0 or 1)
 */
bool mood_light_set_ambient(uint16_t red, uint16_t green, uint16_t blue,
                           uint8_t brightness, uint8_t dimmed_driving,
                           uint8_t drive_mode_sync, uint8_t fade_in_out);

/**
 * Send raw ISO-TP mood lamp payload.
 */
bool mood_light_send_raw(const uint8_t *payload, size_t size);

#ifdef __cplusplus
}
#endif

#endif // __MOOD_LIGHT_H__
