#ifndef __CAN_H__
#define __CAN_H__

#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include "esp_err.h"
#include "driver/twai.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    CAN_BUS_0 = 0,   /* Bus 0: Standard CAN 2.0B / 500kbps (E-GMP B-CAN / C-CAN) */
    CAN_BUS_1 = 1,   /* Bus 1: CAN FD / 500k+2M (E-GMP E-CAN / C-CAN FD) */
} can_bus_t;

#define CAN_BUS_COUNT 2

// Extended CAN FD message representation supporting up to 64-byte payloads
typedef struct {
    uint32_t identifier;
    uint8_t  bus;              /* CAN_BUS_0 or CAN_BUS_1 */
    uint8_t  len;              /* 0..64 data payload bytes */
    struct {
        uint8_t extd: 1;       /* 1 = 29-bit extended ID, 0 = 11-bit standard */
        uint8_t rtr: 1;        /* 1 = Remote Transmission Request */
        uint8_t fdf: 1;        /* 1 = CAN FD Frame Format, 0 = Classic CAN 2.0B */
        uint8_t brs: 1;        /* 1 = Bit Rate Switch (high-speed data phase enabled) */
        uint8_t esi: 1;        /* 1 = Error State Indicator */
        uint8_t ss: 1;         /* 1 = Single-Shot mode (no retransmission on NACK) */
        uint8_t reserved: 2;
    } flags;
    uint8_t  data[64];
} can_fd_frame_t;

// Convert classic TWAI message to can_fd_frame_t
static inline void can_twai_to_fd(const twai_message_t* twai_msg, can_bus_t bus, can_fd_frame_t* fd_frame) {
    if (!twai_msg || !fd_frame) return;
    memset(fd_frame, 0, sizeof(can_fd_frame_t));
    fd_frame->identifier = twai_msg->identifier;
    fd_frame->bus = (uint8_t)bus;
    uint8_t len = twai_msg->data_length_code > 8 ? 8 : twai_msg->data_length_code;
    fd_frame->len = len;
    fd_frame->flags.extd = twai_msg->extd;
    fd_frame->flags.rtr = twai_msg->rtr;
    fd_frame->flags.ss = twai_msg->ss;
    fd_frame->flags.fdf = 0;
    fd_frame->flags.brs = 0;
    if (len > 0) {
        memcpy(fd_frame->data, twai_msg->data, len);
    }
}

// Convert can_fd_frame_t to classic TWAI message (truncates payload to 8 bytes if CAN FD)
static inline void can_fd_to_twai(const can_fd_frame_t* fd_frame, twai_message_t* twai_msg) {
    if (!fd_frame || !twai_msg) return;
    memset(twai_msg, 0, sizeof(twai_message_t));
    twai_msg->identifier = fd_frame->identifier;
    twai_msg->extd = fd_frame->flags.extd;
    twai_msg->rtr = fd_frame->flags.rtr;
    twai_msg->ss = fd_frame->flags.ss;
    uint8_t len = fd_frame->len > 8 ? 8 : fd_frame->len;
    twai_msg->data_length_code = len;
    if (len > 0) {
        memcpy(twai_msg->data, fd_frame->data, len);
    }
}

esp_err_t can_send(can_bus_t bus, twai_message_t *message, TickType_t ticks_to_wait);
esp_err_t can_send_fd(can_bus_t bus, const can_fd_frame_t *frame, TickType_t ticks_to_wait);
esp_err_t can_engine_transmit_safe(twai_message_t *message, TickType_t ticks_to_wait);
bool can_bus_is_available(can_bus_t bus);

#ifdef __cplusplus
}
#endif

#endif // __CAN_H__
