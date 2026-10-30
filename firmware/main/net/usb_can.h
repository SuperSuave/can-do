#pragma once
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Starts the background USB Serial (COM5) CAN injection task (SLCAN & GVRET)
esp_err_t usb_can_init(void);

#ifdef __cplusplus
}
#endif
