/*
 * Adapted from L1Z3/wicant-i-precondition:
 * https://github.com/L1Z3/wicant-i-precondition
 *
 * Original authors: L1Z3, Tyler Harvey (@tylerharvey), and contributors
 * Upstream base: meatpiHQ/wican-fw (https://github.com/meatpiHQ/wican-fw)
 * License: GPL-3.0
 *
 * Modified and maintained in sync for CAN Do (https://github.com/SuperSuave/can-do).
 */

#include "config_server.h"

static int8_t s_button = BUTTON_DISABLED;
static int8_t s_press = PRESS_SHORT;
static int8_t s_mode = PERSISTENT;
static bool s_temp_fahrenheit = false;

int8_t config_server_precon_button(void) {
    return s_button;
}

int8_t config_server_precon_press(void) {
    return s_press;
}

int8_t config_server_precon_mode(void) {
    return s_mode;
}

bool config_server_temperature_fahrenheit(void) {
    return s_temp_fahrenheit;
}
