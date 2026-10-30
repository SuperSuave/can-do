#ifndef __CAN_H__
#define __CAN_H__

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "driver/twai.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    CAN_BUS_0 = 0,   /* on-chip TWAI controller */
    CAN_BUS_1 = 1,   /* secondary bus (if present) */
} can_bus_t;

#define CAN_BUS_COUNT 2

esp_err_t can_send(can_bus_t bus, twai_message_t *message, TickType_t ticks_to_wait);

#ifdef __cplusplus
}
#endif

#endif // __CAN_H__
