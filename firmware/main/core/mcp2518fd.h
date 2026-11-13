#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "can.h"

#ifdef __cplusplus
extern "C" {
#endif

// =========================================================================
// Microchip MCP2518FD Register Map & Opcodes
// =========================================================================

// SPI Opcodes (upper 4 bits of 16-bit command word)
#define MCP2518FD_CMD_RESET             0x00
#define MCP2518FD_CMD_WRITE             0x02
#define MCP2518FD_CMD_READ              0x03
#define MCP2518FD_CMD_WRITE_CRC         0x0A
#define MCP2518FD_CMD_READ_CRC          0x0B
#define MCP2518FD_CMD_WRITE_SAFE        0x0C

// Configuration & Control Registers
#define MCP2518FD_REG_CiCON             0x000
#define MCP2518FD_REG_CiNBTCFG          0x004
#define MCP2518FD_REG_CiDBTCFG          0x008
#define MCP2518FD_REG_CiTDC             0x00C
#define MCP2518FD_REG_CiTBC             0x010
#define MCP2518FD_REG_CiTSCON           0x014
#define MCP2518FD_REG_CiVEC             0x018
#define MCP2518FD_REG_CiINT             0x01C
#define MCP2518FD_REG_CiRXIF            0x020
#define MCP2518FD_REG_CiTXIF            0x024
#define MCP2518FD_REG_CiRXOVIF          0x028
#define MCP2518FD_REG_CiTXATIF          0x02C
#define MCP2518FD_REG_CiTXREQ           0x030
#define MCP2518FD_REG_CiTREC            0x034
#define MCP2518FD_REG_CiBDIAG0          0x038
#define MCP2518FD_REG_CiBDIAG1          0x03C
#define MCP2518FD_REG_CiTEFCON          0x040
#define MCP2518FD_REG_CiTXQCON          0x050

// FIFO Control Registers (FIFO 1 = TX, FIFO 2 = RX)
#define MCP2518FD_REG_CiFIFOCON(m)      (0x05C + ((m) - 1) * 0x0C)
#define MCP2518FD_REG_CiFIFOSTA(m)      (0x060 + ((m) - 1) * 0x0C)
#define MCP2518FD_REG_CiFIFOUA(m)       (0x064 + ((m) - 1) * 0x0C)

// Filter & Mask Registers
#define MCP2518FD_REG_CiFLTCON(m)       (0x1D0 + (m))
#define MCP2518FD_REG_CiFLTOBJ(m)       (0x1F0 + (m) * 8)
#define MCP2518FD_REG_CiMASK(m)         (0x1F4 + (m) * 8)

// Oscillator & System Registers
#define MCP2518FD_REG_OSC               0xE00
#define MCP2518FD_REG_IOCON             0xE04
#define MCP2518FD_REG_CRC               0xE08
#define MCP2518FD_REG_ECCCON            0xE0C
#define MCP2518FD_REG_ECCSTA            0xE10

// Internal RAM
#define MCP2518FD_RAM_START             0x400
#define MCP2518FD_RAM_SIZE              2048

// Operation Modes (CiCON.REQOP / CiCON.OPMOD)
typedef enum {
    MCP2518FD_MODE_NORMAL        = 0, // CAN FD mode with BRS support
    MCP2518FD_MODE_SLEEP         = 1,
    MCP2518FD_MODE_INT_LOOPBACK  = 2,
    MCP2518FD_MODE_LISTEN_ONLY   = 3, // Listen-only sniffer mode
    MCP2518FD_MODE_CONFIG        = 4,
    MCP2518FD_MODE_EXT_LOOPBACK  = 5,
    MCP2518FD_MODE_CLASSIC       = 6, // Classical CAN 2.0B mode
    MCP2518FD_MODE_RESTRICTED    = 7
} mcp2518fd_mode_t;

typedef enum {
    MCP2518FD_OSC_40MHZ = 40,
    MCP2518FD_OSC_20MHZ = 20
} mcp2518fd_osc_t;

typedef struct {
    spi_host_device_t spi_host;
    gpio_num_t cs_pin;
    gpio_num_t int_pin;
    mcp2518fd_osc_t osc_freq;        // 40MHz for Waveshare CAN FD HAT
    uint32_t nominal_kbps;           // Standard arbitration rate (default 500)
    uint32_t data_kbps;              // CAN FD fast data phase (default 2000 = 2M)
    bool can_fd_enabled;             // true = CAN FD enabled; false = Classic CAN 2.0B
    bool listen_only;                // true = Listen-only mode
} mcp2518fd_config_t;

typedef struct {
    spi_device_handle_t spi;
    mcp2518fd_config_t config;
    SemaphoreHandle_t mutex;
    bool initialized;
    uint32_t tx_fail_count;
    uint32_t rx_overflow_count;
    uint32_t last_rx_poll_ms;
    uint32_t rx_fifocon_cached;
    bool last_rx_empty;
} mcp2518fd_t;

// Controller initialization and control API
esp_err_t mcp2518fd_init(mcp2518fd_t *dev, const mcp2518fd_config_t *config);
esp_err_t mcp2518fd_set_mode(mcp2518fd_t *dev, mcp2518fd_mode_t mode);
esp_err_t mcp2518fd_transmit(mcp2518fd_t *dev, const can_fd_frame_t *frame, TickType_t wait_ticks);
esp_err_t mcp2518fd_receive(mcp2518fd_t *dev, can_fd_frame_t *frame, TickType_t wait_ticks);
bool mcp2518fd_rx_available(mcp2518fd_t *dev);
esp_err_t mcp2518fd_get_error_counts(mcp2518fd_t *dev, uint8_t *tec, uint8_t *rec, bool *bus_off);
esp_err_t mcp2518fd_recover(mcp2518fd_t *dev);

// Dual-CAN Manager: Handles Channel 0 (Standard CAN) and Channel 1 (CAN FD)
esp_err_t dual_can_init(void);
esp_err_t dual_can_send(can_bus_t bus, const can_fd_frame_t *frame, TickType_t wait_ticks);
esp_err_t dual_can_send_twai(can_bus_t bus, const twai_message_t *msg, TickType_t wait_ticks);
esp_err_t dual_can_receive(can_bus_t bus, can_fd_frame_t *frame, TickType_t wait_ticks);
esp_err_t dual_can_poll_receive(can_bus_t bus, can_fd_frame_t *frame);
bool dual_can_is_available(can_bus_t bus);
mcp2518fd_t* dual_can_get_device(can_bus_t bus);
esp_err_t dual_can_set_listen_only(bool listen_only);
void dual_can_clear_boot_overflows(void);
void dual_can_shutdown(void);

#ifdef __cplusplus
}
#endif

