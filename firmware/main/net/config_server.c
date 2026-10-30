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
