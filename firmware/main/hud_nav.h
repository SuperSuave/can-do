#ifndef __HUD_NAV_H__
#define __HUD_NAV_H__

#include <stdbool.h>
#include <stdint.h>
#include "can.h"
#include "hsm.h"

#ifdef __cplusplus
extern "C" {
#endif

// Common maneuver graphic icons supported by HKMC HUD / Cluster
typedef enum {
    HUD_MANEUVER_NONE               = 0x00, // Idle / No guidance
    HUD_MANEUVER_STRAIGHT           = 0x01, // Straight arrow
    HUD_MANEUVER_SLIGHT_RIGHT       = 0x02, // Slight right arrow
    HUD_MANEUVER_TURN_RIGHT         = 0x03, // Standard 90-degree right turn
    HUD_MANEUVER_SHARP_RIGHT        = 0x04, // Hard right arrow
    HUD_MANEUVER_UTURN_LEFT         = 0x05, // U-turn left
    HUD_MANEUVER_UTURN_RIGHT        = 0x06, // U-turn right
    HUD_MANEUVER_SLIGHT_LEFT        = 0x07, // Slight left arrow
    HUD_MANEUVER_TURN_LEFT          = 0x08, // Standard 90-degree left turn
    HUD_MANEUVER_SHARP_LEFT         = 0x09, // Hard left arrow
    HUD_MANEUVER_ROUNDABOUT_EXIT_1  = 0x0A, // Roundabout 1st exit
    HUD_MANEUVER_ROUNDABOUT_EXIT_2  = 0x0B, // Roundabout 2nd exit
    HUD_MANEUVER_ROUNDABOUT_EXIT_3  = 0x0C, // Roundabout 3rd exit
    HUD_MANEUVER_ROUNDABOUT_EXIT_4  = 0x0D, // Roundabout 4th exit
    HUD_MANEUVER_FORK_LEFT          = 0x0E, // Highway split left
    HUD_MANEUVER_FORK_RIGHT         = 0x0F, // Highway split right
    HUD_MANEUVER_OFFRAMP_LEFT       = 0x10, // Highway exit left
    HUD_MANEUVER_OFFRAMP_RIGHT      = 0x11, // Highway exit right
    HUD_MANEUVER_DESTINATION        = 0x1F, // Checkered flag
} hud_maneuver_icon_t;

typedef enum {
    HUD_PLATFORM_GEN2_CCAN = 0, // Kona EV, Niro EV, Ioniq EV (0x562)
    HUD_PLATFORM_EGMP_CANFD = 1, // Ioniq 5, EV6, GV60 (0x29B)
} hud_platform_type_t;

typedef struct {
    hud_maneuver_icon_t icon;
    uint16_t distance_meters;
    uint8_t bar_graph;        // 0 to 8 countdown blocks (0 = off)
    uint8_t speed_limit_kph;  // 0 = off, otherwise speed limit sign
    bool speed_camera_alert;  // true = show speed camera warning
    const char *street_name;  // UTF-8 road name (e.g. "Main St")
} hud_nav_instruction_t;

/**
 * Initialize the HUD navigation controller.
 * @param platform Target vehicle bus architecture (Gen 2 vs E-GMP)
 */
void hud_nav_init(hud_platform_type_t platform);

/**
 * Periodic 100ms tick to transmit CAN frames to the HUD / Cluster.
 */
void hud_nav_tick_100ms(void);

/**
 * CAN forward filter hook for dual-bus bridge to suppress factory nav frames.
 */
fwd_result_t hud_nav_fwd(twai_message_t *msg, can_bus_t fwd_bus);

/**
 * Deliver received CAN frame for ISO-TP flow control handling.
 */
void hud_nav_rx(const twai_message_t *msg, can_bus_t rx_bus);

/**
 * Update the active turn-by-turn instruction projected on the HUD.
 */
bool hud_nav_update(const hud_nav_instruction_t *instr);

/**
 * Clear the HUD navigation display and release the bus to factory head unit.
 */
void hud_nav_clear(void);

#ifdef __cplusplus
}
#endif

#endif // __HUD_NAV_H__
