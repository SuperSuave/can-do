#ifndef __CONFIG_SERVER_H__
#define __CONFIG_SERVER_H__

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    BUTTON_DISABLED = -1,
    SW_STAR = 0,
    AVN_STAR,
    AVN_TUNER_IN,
    AVN_VOL_IN,
    SW_MODE,
    SW_SPEAK,
    SW_CALL,
    SW_VOL_IN,
    SW_VOL_UP,
    SW_VOL_DOWN,
    SW_SKIP_UP,
    SW_SKIP_DOWN,
    SW_OK,
    AVN_MAP,
    AVN_NAV,
    AVN_MEDIA,
    AVN_TUNER_UP,
    AVN_TUNER_DOWN,
    EV6_AVN_SETUP,
    NUM_PRECON_BUTTONS,
} precon_button_t;

typedef enum {
    PRESS_SHORT = 0,
    PRESS_LONG = 1,
} precon_press_t;

typedef enum {
    ONCE = 0,
    CONTINUOUS = 1,
    PERSISTENT = 2,
} precon_mode_t;

int8_t config_server_precon_button(void);
int8_t config_server_precon_press(void);
int8_t config_server_precon_mode(void);
bool config_server_temperature_fahrenheit(void);

#ifdef __cplusplus
}
#endif

#endif // __CONFIG_SERVER_H__
