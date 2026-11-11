#include "mcp2518fd.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "board_pins.h"
#include <cstring>

static const char* TAG = "MCP2518FD";

// Map data length code (DLC) to actual byte count
static inline uint8_t dlc_to_bytes(uint8_t dlc) {
    static const uint8_t dlc_table[16] = {
        0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64
    };
    return dlc_table[dlc & 0x0F];
}

// Map actual byte count to DLC
static inline uint8_t bytes_to_dlc(uint8_t bytes) {
    if (bytes <= 8)  return bytes;
    if (bytes <= 12) return 9;
    if (bytes <= 16) return 10;
    if (bytes <= 20) return 11;
    if (bytes <= 24) return 12;
    if (bytes <= 32) return 13;
    if (bytes <= 48) return 14;
    return 15;
}

static esp_err_t mcp2518fd_cmd_reset(mcp2518fd_t *dev) {
    uint8_t tx[2] = {0x00, 0x00};
    spi_transaction_t t = {};
    t.length = 16;
    t.tx_buffer = tx;
    return spi_device_polling_transmit(dev->spi, &t);
}

static esp_err_t mcp2518fd_read_32(mcp2518fd_t *dev, uint16_t reg, uint32_t *val) {
    uint8_t tx[6] = {0};
    uint8_t rx[6] = {0};
    tx[0] = (MCP2518FD_CMD_READ << 4) | ((reg >> 8) & 0x0F);
    tx[1] = reg & 0xFF;
    spi_transaction_t t = {};
    t.length = 48; // 2 cmd bytes + 4 data bytes
    t.tx_buffer = tx;
    t.rx_buffer = rx;
    esp_err_t ret = spi_device_polling_transmit(dev->spi, &t);
    if (ret == ESP_OK && val) {
        *val = (uint32_t)rx[2] | ((uint32_t)rx[3] << 8) | ((uint32_t)rx[4] << 16) | ((uint32_t)rx[5] << 24);
    }
    return ret;
}

static esp_err_t mcp2518fd_write_32(mcp2518fd_t *dev, uint16_t reg, uint32_t val) {
    uint8_t tx[6] = {0};
    tx[0] = (MCP2518FD_CMD_WRITE << 4) | ((reg >> 8) & 0x0F);
    tx[1] = reg & 0xFF;
    tx[2] = (uint8_t)(val & 0xFF);
    tx[3] = (uint8_t)((val >> 8) & 0xFF);
    tx[4] = (uint8_t)((val >> 16) & 0xFF);
    tx[5] = (uint8_t)((val >> 24) & 0xFF);
    spi_transaction_t t = {};
    t.length = 48;
    t.tx_buffer = tx;
    return spi_device_polling_transmit(dev->spi, &t);
}

static esp_err_t mcp2518fd_read_bytes(mcp2518fd_t *dev, uint16_t reg, uint8_t *data, size_t len) {
    if (len == 0 || !data) return ESP_ERR_INVALID_ARG;
    uint8_t tx[80] = {0};
    uint8_t rx[80] = {0};
    tx[0] = (MCP2518FD_CMD_READ << 4) | ((reg >> 8) & 0x0F);
    tx[1] = reg & 0xFF;
    spi_transaction_t t = {};
    t.length = (2 + len) * 8;
    t.tx_buffer = tx;
    t.rx_buffer = rx;
    esp_err_t ret = spi_device_polling_transmit(dev->spi, &t);
    if (ret == ESP_OK) {
        memcpy(data, &rx[2], len);
    }
    return ret;
}

static esp_err_t mcp2518fd_write_bytes(mcp2518fd_t *dev, uint16_t reg, const uint8_t *data, size_t len) {
    if (len == 0 || !data) return ESP_ERR_INVALID_ARG;
    uint8_t tx[80] = {0};
    tx[0] = (MCP2518FD_CMD_WRITE << 4) | ((reg >> 8) & 0x0F);
    tx[1] = reg & 0xFF;
    memcpy(&tx[2], data, len);
    spi_transaction_t t = {};
    t.length = (2 + len) * 8;
    t.tx_buffer = tx;
    return spi_device_polling_transmit(dev->spi, &t);
}

esp_err_t mcp2518fd_set_mode(mcp2518fd_t *dev, mcp2518fd_mode_t mode) {
    if (!dev || !dev->spi) return ESP_ERR_INVALID_ARG;

    bool locked = false;
    if (dev->initialized && dev->mutex) {
        if (xSemaphoreTake(dev->mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
            return ESP_ERR_TIMEOUT;
        }
        locked = true;
    }

    uint32_t cicon = 0;
    esp_err_t ret = mcp2518fd_read_32(dev, MCP2518FD_REG_CiCON, &cicon);
    if (ret != ESP_OK) {
        if (locked) xSemaphoreGive(dev->mutex);
        return ret;
    }

    // Clear REQOP (bits 26:24) and set requested mode
    cicon &= ~(0x7 << 24);
    cicon |= ((uint32_t)mode & 0x7) << 24;
    // Enable ISO CRC (ISOCRCEN = BIT(5)) and Restricted Retransmission Attempts (RTXAT = BIT(16))
    cicon |= (1 << 5) | (1 << 16);

    ret = mcp2518fd_write_32(dev, MCP2518FD_REG_CiCON, cicon);
    if (ret != ESP_OK) {
        if (locked) xSemaphoreGive(dev->mutex);
        return ret;
    }

    // Wait for OPMOD (bits 23:21) to reflect requested mode
    uint32_t start_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    while ((uint32_t)(esp_timer_get_time() / 1000ULL) - start_ms < 100) {
        ret = mcp2518fd_read_32(dev, MCP2518FD_REG_CiCON, &cicon);
        if (ret == ESP_OK) {
            uint8_t opmod = (cicon >> 21) & 0x7;
            if (opmod == (uint8_t)mode) {
                if (locked) xSemaphoreGive(dev->mutex);
                return ESP_OK;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }

    if (locked) xSemaphoreGive(dev->mutex);
    ESP_LOGW(TAG, "CS=%d: Mode change timeout (requested=%d, opmod=%lu)",
             (int)dev->config.cs_pin, (int)mode, (unsigned long)((cicon >> 21) & 0x7));
    return ESP_ERR_TIMEOUT;
}

esp_err_t mcp2518fd_init(mcp2518fd_t *dev, const mcp2518fd_config_t *config) {
    if (!dev || !config) return ESP_ERR_INVALID_ARG;
    spi_device_handle_t existing_spi = dev->spi;
    SemaphoreHandle_t existing_mutex = dev->mutex;
    memset(dev, 0, sizeof(mcp2518fd_t));
    dev->config = *config;
    dev->spi = existing_spi;
    dev->mutex = existing_mutex ? existing_mutex : xSemaphoreCreateMutex();

    // Configure INT GPIO (Active LOW)
    if (config->int_pin >= 0) {
        gpio_config_t int_cfg = {};
        int_cfg.pin_bit_mask = (1ULL << config->int_pin);
        int_cfg.mode = GPIO_MODE_INPUT;
        int_cfg.pull_up_en = GPIO_PULLUP_ENABLE;
        gpio_config(&int_cfg);
    }

    // Add device to SPI bus (10MHz standard clock for clean signal fidelity)
    if (!dev->spi) {
        spi_device_interface_config_t dev_cfg = {};
        dev_cfg.clock_speed_hz = 10 * 1000 * 1000;
        dev_cfg.mode = 0; // SPI Mode 0,0
        dev_cfg.spics_io_num = config->cs_pin;
        dev_cfg.queue_size = 8;

        esp_err_t ret = spi_bus_add_device(config->spi_host, &dev_cfg, &dev->spi);
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "Failed adding SPI device on CS=%d (%s)", config->cs_pin, esp_err_to_name(ret));
            return ret;
        }
    }

    // 1. Hardware Reset
    esp_err_t ret = mcp2518fd_cmd_reset(dev);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "SPI Reset command failed on CS=%d", config->cs_pin);
        return ret;
    }
    vTaskDelay(pdMS_TO_TICKS(10));

    // Verify communication by reading CiCON (defaults to Configuration mode on power-up)
    uint32_t cicon = 0;
    ret = mcp2518fd_read_32(dev, MCP2518FD_REG_CiCON, &cicon);
    uint8_t opmod = (cicon >> 21) & 0x7;
    uint8_t reqop = (cicon >> 24) & 0x7;
    if (ret != ESP_OK || (opmod != MCP2518FD_MODE_CONFIG && reqop != MCP2518FD_MODE_CONFIG)) {
        ESP_LOGE(TAG, "Device not detected or invalid CiCON on CS=%d: ret=%d, val=0x%08lX (opmod=%u, reqop=%u)",
                 config->cs_pin, ret, (unsigned long)cicon, opmod, reqop);
        return ESP_ERR_NOT_FOUND;
    }

    // 2. Configure Oscillator (40MHz crystal on Waveshare board: PLL disabled, divide-by-1)
    uint32_t osc_val = 0;
    if (config->osc_freq == MCP2518FD_OSC_40MHZ) {
        osc_val = 0x00000000; // SCLKDIV=0, CLKODIV=0, PLLEN=0
    } else {
        osc_val = 0x00000000; // 20MHz crystal
    }
    mcp2518fd_write_32(dev, MCP2518FD_REG_OSC, osc_val);

    // Wait for Oscillator Ready (OSCRDY bit 10)
    uint32_t start_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    bool osc_ready = false;
    while ((uint32_t)(esp_timer_get_time() / 1000ULL) - start_ms < 100) {
        uint32_t osc_status = 0;
        if (mcp2518fd_read_32(dev, MCP2518FD_REG_OSC, &osc_status) == ESP_OK) {
            if (osc_status & (1 << 10)) {
                osc_ready = true;
                break;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }
    if (!osc_ready) {
        ESP_LOGW(TAG, "CS=%d: Oscillator stabilization timeout, continuing...", config->cs_pin);
    }

    // 3. Disable ECC during init to prevent uninitialized RAM trips
    mcp2518fd_write_32(dev, MCP2518FD_REG_ECCCON, 0x00000000);

    // Clear RAM (2048 bytes)
    uint8_t zeros[32] = {0};
    for (uint16_t addr = MCP2518FD_RAM_START; addr < MCP2518FD_RAM_START + MCP2518FD_RAM_SIZE; addr += 32) {
        mcp2518fd_write_bytes(dev, addr, zeros, 32);
    }

    // 4. Configure Nominal Bit Rate (500 kbps for E-GMP vehicle bus)
    // Total bit time = 1 (Sync) + (TSEG1 + 1) + (TSEG2 + 1) TQ
    // 40 MHz oscillator: 80 TQ (80% sample point), BRP=0, TSEG1=62 (63 TQ), TSEG2=15 (16 TQ), SJW=15
    uint32_t nbtcfg = 0;
    if (config->osc_freq == MCP2518FD_OSC_40MHZ) {
        nbtcfg = (0 << 24) | (62 << 16) | (15 << 8) | 15;
    } else {
        // 20 MHz oscillator: 40 TQ (80% sample point), BRP=0, TSEG1=30 (31 TQ), TSEG2=7 (8 TQ), SJW=7
        nbtcfg = (0 << 24) | (30 << 16) | (7 << 8) | 7;
    }
    mcp2518fd_write_32(dev, MCP2518FD_REG_CiNBTCFG, nbtcfg);

    // 5. Configure Data Bit Rate & TDC (if CAN FD enabled: 2 Mbps fast data phase)
    if (config->can_fd_enabled) {
        uint32_t dbtcfg = 0;
        uint32_t tdc = 0;
        if (config->osc_freq == MCP2518FD_OSC_40MHZ) {
            // 2 Mbps data phase: 20 TQ, BRP=0, TSEG1=14 (15 TQ), TSEG2=3 (4 TQ), SJW=3
            dbtcfg = (0 << 24) | (14 << 16) | (3 << 8) | 3;
            tdc = (2 << 16) | (15 << 8); // TDC Auto, offset = 15
        } else {
            // 20 MHz oscillator: 10 TQ, BRP=0, TSEG1=6 (7 TQ), TSEG2=1 (2 TQ), SJW=1
            dbtcfg = (0 << 24) | (6 << 16) | (1 << 8) | 1;
            tdc = (2 << 16) | (7 << 8);
        }
        mcp2518fd_write_32(dev, MCP2518FD_REG_CiDBTCFG, dbtcfg);
        mcp2518fd_write_32(dev, MCP2518FD_REG_CiTDC, tdc);
    }

    // 6. Configure FIFOs in RAM (2048 bytes max):
    // Classic CAN uses PLSIZE=0 (8B payload = 16B/obj): 16 TX (256B) + 32 RX (512B) = 768B
    // CAN FD uses PLSIZE=7 (64B payload = 72B/obj): 4 TX (288B) + 24 RX (1728B) = 2016B
    uint32_t plsize = config->can_fd_enabled ? 7U : 0U;
    uint32_t tx_fsize = config->can_fd_enabled ? 3U : 15U;
    uint32_t rx_fsize = config->can_fd_enabled ? 23U : 31U;

    // FIFO 1: TX FIFO, TXAT=1 (3 retries), TXEN=1
    uint32_t fifocon1 = (plsize << 29) | (tx_fsize << 24) | (1 << 21) | (1 << 7);
    mcp2518fd_write_32(dev, MCP2518FD_REG_CiFIFOCON(1), fifocon1);

    // FIFO 2: RX FIFO, RX Not Empty IRQ enable (TFNRFNIE=1)
    uint32_t fifocon2 = (plsize << 29) | (rx_fsize << 24) | (1 << 0);
    mcp2518fd_write_32(dev, MCP2518FD_REG_CiFIFOCON(2), fifocon2);
    dev->rx_fifocon_cached = fifocon2;

    // 7. Configure Filter 0: Accept All frames (standard + extended) and route to FIFO 2
    // FLTEN=1, F0BP=2 (FIFO 2)
    uint32_t fltcon0 = (1 << 7) | 2;
    mcp2518fd_write_32(dev, MCP2518FD_REG_CiFLTCON(0), fltcon0);
    mcp2518fd_write_32(dev, MCP2518FD_REG_CiFLTOBJ(0), 0x00000000);
    mcp2518fd_write_32(dev, MCP2518FD_REG_CiMASK(0), 0x00000000); // 0 mask (MIDE=0) matches all std & ext

    // 8. Enable RX FIFO Interrupt (RXIE = BIT(17) in CiINT) so hardware nINT pin asserts LOW on RX
    // Leave IOCON at reset default (push-pull active-low nINT) to avoid multi-byte IOCON errata.
    mcp2518fd_write_32(dev, MCP2518FD_REG_CiINT, (1 << 17));

    // 9. Transition to Operational Mode
    mcp2518fd_mode_t target_mode;
    if (config->listen_only) {
        target_mode = MCP2518FD_MODE_LISTEN_ONLY;
    } else if (config->can_fd_enabled) {
        target_mode = MCP2518FD_MODE_NORMAL;
    } else {
        target_mode = MCP2518FD_MODE_CLASSIC;
    }

    ret = mcp2518fd_set_mode(dev, target_mode);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed setting operational mode %d on CS=%d", (int)target_mode, config->cs_pin);
        return ret;
    }

    dev->initialized = true;
    ESP_LOGI(TAG, "MCP2518FD on CS=%d initialized successfully (Mode: %s, %s, 500k%s)",
             config->cs_pin,
             config->listen_only ? "LISTEN_ONLY" : (config->can_fd_enabled ? "CAN_FD" : "CLASSIC_CAN"),
             config->osc_freq == MCP2518FD_OSC_40MHZ ? "40MHz" : "20MHz",
             config->can_fd_enabled ? "/2M" : "");

    return ESP_OK;
}

bool mcp2518fd_rx_available(mcp2518fd_t *dev) {
    if (!dev || !dev->initialized) return false;

    // Fast path via active-LOW nINT pin; also fallback-poll SPI every 20ms in case INT line isn't seated
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    if (dev->config.int_pin >= 0) {
        if (gpio_get_level(dev->config.int_pin) != 0 && (now_ms - dev->last_rx_poll_ms) < 20) {
            return false;
        }
    }
    dev->last_rx_poll_ms = now_ms;

    if (dev->mutex && xSemaphoreTake(dev->mutex, pdMS_TO_TICKS(5)) != pdTRUE) {
        return false;
    }

    // Verify RX FIFO 2 Not Empty status (TFNRFNIF = BIT(0))
    uint32_t fifosta = 0;
    esp_err_t ret = mcp2518fd_read_32(dev, MCP2518FD_REG_CiFIFOSTA(2), &fifosta);

    if (dev->mutex) {
        xSemaphoreGive(dev->mutex);
    }
    return (ret == ESP_OK) && ((fifosta & 0x01) != 0);
}

esp_err_t mcp2518fd_transmit(mcp2518fd_t *dev, const can_fd_frame_t *frame, TickType_t wait_ticks) {
    if (!dev || !dev->initialized || !frame) return ESP_ERR_INVALID_ARG;
    if (dev->config.listen_only) return ESP_ERR_INVALID_STATE;

    if (xSemaphoreTake(dev->mutex, wait_ticks) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    // 1. Check if TX FIFO 1 has room (TFNRFNIF = 1)
    uint32_t fifosta = 0;
    esp_err_t ret = mcp2518fd_read_32(dev, MCP2518FD_REG_CiFIFOSTA(1), &fifosta);
    if (ret != ESP_OK || !(fifosta & 0x01)) {
        xSemaphoreGive(dev->mutex);
        dev->tx_fail_count++;
        return ESP_ERR_NO_MEM; // TX FIFO full
    }

    // 2. Read User Address for message staging in RAM
    uint32_t fifoua = 0;
    ret = mcp2518fd_read_32(dev, MCP2518FD_REG_CiFIFOUA(1), &fifoua);
    if (ret != ESP_OK) {
        xSemaphoreGive(dev->mutex);
        return ret;
    }
    uint16_t ram_addr = (uint16_t)(fifoua & 0x0FFF) + MCP2518FD_RAM_START;

    // 3. Assemble Message Object Header
    uint32_t word0 = 0;
    if (frame->flags.extd) {
        // Extended ID: ID[17:0] in EID (bits 28:11), ID[28:18] in SID (bits 10:0)
        word0 = ((frame->identifier & 0x3FFFF) << 11) | ((frame->identifier >> 18) & 0x7FF);
    } else {
        // Standard ID: bits 10:0
        word0 = frame->identifier & 0x7FF;
    }

    uint8_t max_bytes = dev->config.can_fd_enabled ? 64 : 8;
    uint8_t clamped_len = frame->len > max_bytes ? max_bytes : frame->len;
    uint8_t dlc = bytes_to_dlc(clamped_len);
    uint32_t word1 = dlc & 0x0F;
    if (frame->flags.extd) word1 |= (1 << 4); // IDE
    if (frame->flags.rtr)  word1 |= (1 << 5); // RTR
    if (frame->flags.brs && dev->config.can_fd_enabled)  word1 |= (1 << 6); // BRS
    if (frame->flags.fdf && dev->config.can_fd_enabled)  word1 |= (1 << 7); // FDF

    // 4. Write Header and Payload to RAM
    uint8_t tx_buf[8 + 64] = {0};
    tx_buf[0] = (uint8_t)(word0 & 0xFF);
    tx_buf[1] = (uint8_t)((word0 >> 8) & 0xFF);
    tx_buf[2] = (uint8_t)((word0 >> 16) & 0xFF);
    tx_buf[3] = (uint8_t)((word0 >> 24) & 0xFF);
    tx_buf[4] = (uint8_t)(word1 & 0xFF);
    tx_buf[5] = (uint8_t)((word1 >> 8) & 0xFF);
    tx_buf[6] = (uint8_t)((word1 >> 16) & 0xFF);
    tx_buf[7] = (uint8_t)((word1 >> 24) & 0xFF);

    uint8_t dlc_bytes = dlc_to_bytes(dlc);
    if (clamped_len > 0) {
        memcpy(&tx_buf[8], frame->data, clamped_len > dlc_bytes ? dlc_bytes : clamped_len);
    }

    // MCP2518FD RAM writes must be 4-byte aligned
    size_t write_len = (8 + dlc_bytes + 3U) & ~3U;
    ret = mcp2518fd_write_bytes(dev, ram_addr, tx_buf, write_len);
    if (ret != ESP_OK) {
        xSemaphoreGive(dev->mutex);
        return ret;
    }

    // 5. Request Transmission & Increment FIFO Pointer (UINC = BIT(8), TXREQ = BIT(9))
    uint32_t fifocon1 = 0;
    mcp2518fd_read_32(dev, MCP2518FD_REG_CiFIFOCON(1), &fifocon1);
    fifocon1 |= (1 << 8) | (1 << 9); // Set UINC and TXREQ
    ret = mcp2518fd_write_32(dev, MCP2518FD_REG_CiFIFOCON(1), fifocon1);

    xSemaphoreGive(dev->mutex);
    return ret;
}

esp_err_t mcp2518fd_receive(mcp2518fd_t *dev, can_fd_frame_t *frame, TickType_t wait_ticks) {
    if (!dev || !dev->initialized || !frame) return ESP_ERR_INVALID_ARG;

    if (xSemaphoreTake(dev->mutex, wait_ticks) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    // 1. Sequentially read CiFIFOSTA(2) (0x06C) + CiFIFOUA(2) (0x070) in one SPI transfer
    uint8_t sta_ua[8] = {0};
    esp_err_t ret = mcp2518fd_read_bytes(dev, MCP2518FD_REG_CiFIFOSTA(2), sta_ua, sizeof(sta_ua));
    if (ret != ESP_OK) {
        xSemaphoreGive(dev->mutex);
        return ret;
    }

    uint32_t fifosta = (uint32_t)sta_ua[0] | ((uint32_t)sta_ua[1] << 8) | ((uint32_t)sta_ua[2] << 16) | ((uint32_t)sta_ua[3] << 24);
    if (!(fifosta & 0x01)) {
        xSemaphoreGive(dev->mutex);
        return ESP_ERR_NOT_FOUND;
    }

    uint32_t fifoua = (uint32_t)sta_ua[4] | ((uint32_t)sta_ua[5] << 8) | ((uint32_t)sta_ua[6] << 16) | ((uint32_t)sta_ua[7] << 24);
    uint16_t ram_off = (uint16_t)(fifoua & 0x0FFFU);
    if (ram_off + 16U > MCP2518FD_RAM_SIZE) {
        xSemaphoreGive(dev->mutex);
        return ESP_ERR_INVALID_RESPONSE;
    }
    uint16_t ram_addr = ram_off + MCP2518FD_RAM_START;

    // 2. Read Header (8B) + first 8B payload; fetch extended CAN FD tail only when len > 8
    uint8_t rx_buf[8 + 64] = {0};
    size_t max_payload = dev->config.can_fd_enabled ? 64 : 8;
    ret = mcp2518fd_read_bytes(dev, ram_addr, rx_buf, 16);
    if (ret != ESP_OK) {
        xSemaphoreGive(dev->mutex);
        return ret;
    }

    uint32_t word0 = (uint32_t)rx_buf[0] | ((uint32_t)rx_buf[1] << 8) | ((uint32_t)rx_buf[2] << 16) | ((uint32_t)rx_buf[3] << 24);
    uint32_t word1 = (uint32_t)rx_buf[4] | ((uint32_t)rx_buf[5] << 8) | ((uint32_t)rx_buf[6] << 16) | ((uint32_t)rx_buf[7] << 24);

    uint8_t dlc = word1 & 0x0F;
    uint8_t num_bytes = dlc_to_bytes(dlc);
    if (num_bytes > max_payload) {
        num_bytes = (uint8_t)max_payload;
    }

    if (num_bytes > 8) {
        size_t rem_len = ((size_t)(num_bytes - 8) + 3U) & ~3U;
        if (ram_off + 16U + rem_len <= MCP2518FD_RAM_SIZE) {
            ret = mcp2518fd_read_bytes(dev, ram_addr + 16, &rx_buf[16], rem_len);
            if (ret != ESP_OK) {
                xSemaphoreGive(dev->mutex);
                return ret;
            }
        } else {
            num_bytes = 8;
        }
    }

    // 3. Increment RX FIFO Pointer (UINC=1) using cached CiFIFOCON(2) before clearing overflow
    uint32_t fifocon2 = dev->rx_fifocon_cached;
    if (fifocon2 == 0) {
        mcp2518fd_read_32(dev, MCP2518FD_REG_CiFIFOCON(2), &fifocon2);
        dev->rx_fifocon_cached = fifocon2;
    }
    mcp2518fd_write_32(dev, MCP2518FD_REG_CiFIFOCON(2), fifocon2 | (1 << 8));

    // 4. Clear overflow flag (RXOVIF = BIT(3)) after UINC has freed a slot
    if (fifosta & (1 << 3)) {
        dev->rx_overflow_count++;
        mcp2518fd_write_32(dev, MCP2518FD_REG_CiFIFOSTA(2), fifosta & ~(1 << 3));
    }

    xSemaphoreGive(dev->mutex);

    // 5. Decode Header & Payload
    memset(frame, 0, sizeof(can_fd_frame_t));
    bool is_ext = (word1 & (1 << 4)) != 0;
    if (is_ext) {
        frame->identifier = ((word0 >> 11) & 0x3FFFF) | ((word0 & 0x7FF) << 18);
        frame->flags.extd = 1;
    } else {
        frame->identifier = word0 & 0x7FF;
        frame->flags.extd = 0;
    }

    frame->flags.rtr = (word1 >> 5) & 1;
    frame->flags.brs = (word1 >> 6) & 1;
    frame->flags.fdf = (word1 >> 7) & 1;
    frame->flags.esi = (word1 >> 8) & 1;

    frame->len = num_bytes;
    if (num_bytes > 0) {
        memcpy(frame->data, &rx_buf[8], num_bytes);
    }

    return ESP_OK;
}

esp_err_t mcp2518fd_get_error_counts(mcp2518fd_t *dev, uint8_t *tec, uint8_t *rec, bool *bus_off) {
    if (!dev || !dev->initialized) return ESP_ERR_INVALID_ARG;
    if (dev->mutex && xSemaphoreTake(dev->mutex, pdMS_TO_TICKS(10)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    uint32_t trec = 0;
    esp_err_t ret = mcp2518fd_read_32(dev, MCP2518FD_REG_CiTREC, &trec);
    if (dev->mutex) {
        xSemaphoreGive(dev->mutex);
    }
    if (ret == ESP_OK) {
        if (rec) *rec = trec & 0xFF;         // REC is bits 7:0
        if (tec) *tec = (trec >> 8) & 0xFF;  // TEC is bits 15:8
        if (bus_off) *bus_off = (trec & (1 << 21)) != 0; // TXBO bit 21
    }
    return ret;
}

esp_err_t mcp2518fd_recover(mcp2518fd_t *dev) {
    if (!dev || !dev->initialized) return ESP_ERR_INVALID_ARG;
    ESP_LOGW(TAG, "CS=%d: Re-initializing MCP2518FD controller after fault...", dev->config.cs_pin);
    SemaphoreHandle_t mtx = dev->mutex;
    if (mtx && xSemaphoreTake(mtx, pdMS_TO_TICKS(50)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    mcp2518fd_config_t cfg = dev->config;
    esp_err_t ret = mcp2518fd_init(dev, &cfg);
    if (mtx) {
        xSemaphoreGive(mtx);
    }
    return ret;
}

// =========================================================================
// Dual-CAN Subsystem Manager
// =========================================================================

static mcp2518fd_t s_can_bus[CAN_BUS_COUNT];
static bool s_dual_can_initialized = false;

esp_err_t dual_can_init(void) {
    if (s_dual_can_initialized) return ESP_OK;

#if CONFIG_IDF_TARGET_ESP32S3
    ESP_LOGI(TAG, "Initializing Dual-CAN subsystem on ESP32-S3...");

    // 1. Initialize Channel 0 SPI master bus (SPI2_HOST)
    spi_bus_config_t bus0_cfg = {};
    bus0_cfg.mosi_io_num = CAN0_SPI_MOSI_PIN;
    bus0_cfg.miso_io_num = CAN0_SPI_MISO_PIN;
    bus0_cfg.sclk_io_num = CAN0_SPI_SCK_PIN;
    bus0_cfg.quadwp_io_num = -1;
    bus0_cfg.quadhd_io_num = -1;
    bus0_cfg.max_transfer_sz = 128;

    esp_err_t ret = spi_bus_initialize(CAN0_SPI_HOST, &bus0_cfg, SPI_DMA_CH_AUTO);
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "Failed initializing SPI bus for Channel 0 (%s)", esp_err_to_name(ret));
    }

    // 2. Initialize Channel 1 SPI master bus (SPI3_HOST)
#if defined(CAN1_SPI_HOST)
    if (CAN1_SPI_HOST != CAN0_SPI_HOST) {
        spi_bus_config_t bus1_cfg = {};
        bus1_cfg.mosi_io_num = CAN1_SPI_MOSI_PIN;
        bus1_cfg.miso_io_num = CAN1_SPI_MISO_PIN;
        bus1_cfg.sclk_io_num = CAN1_SPI_SCK_PIN;
        bus1_cfg.quadwp_io_num = -1;
        bus1_cfg.quadhd_io_num = -1;
        bus1_cfg.max_transfer_sz = 128;

        ret = spi_bus_initialize(CAN1_SPI_HOST, &bus1_cfg, SPI_DMA_CH_AUTO);
        if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "Failed initializing SPI bus for Channel 1 (%s)", esp_err_to_name(ret));
        }
    }
#endif

    // 3. Initialize Channel 0: Standard CAN 2.0B (500 kbps)
    mcp2518fd_config_t cfg0 = {};
    cfg0.spi_host = CAN0_SPI_HOST;
    cfg0.cs_pin = CAN0_CS_PIN;
    cfg0.int_pin = CAN0_INT_PIN;
    cfg0.osc_freq = MCP2518FD_OSC_40MHZ;
    cfg0.nominal_kbps = 500;
    cfg0.can_fd_enabled = false; // Classical CAN 2.0B mode
    cfg0.listen_only = false;

    esp_err_t ret0 = mcp2518fd_init(&s_can_bus[CAN_BUS_0], &cfg0);
    if (ret0 != ESP_OK) {
        ESP_LOGW(TAG, "Channel 0 (CAN 2.0B) failed to init (%s)", esp_err_to_name(ret0));
    }

    // 4. Initialize Channel 1: CAN FD (500 kbps nominal + 2 Mbps data phase)
    mcp2518fd_config_t cfg1 = {};
    cfg1.spi_host = CAN1_SPI_HOST;
    cfg1.cs_pin = CAN1_CS_PIN;
    cfg1.int_pin = CAN1_INT_PIN;
    cfg1.osc_freq = MCP2518FD_OSC_40MHZ;
    cfg1.nominal_kbps = 500;
    cfg1.data_kbps = 2000;
    cfg1.can_fd_enabled = true; // CAN FD mode with BRS
    cfg1.listen_only = false;

    esp_err_t ret1 = mcp2518fd_init(&s_can_bus[CAN_BUS_1], &cfg1);
    if (ret1 != ESP_OK) {
        ESP_LOGW(TAG, "Channel 1 (CAN FD) failed to init (%s)", esp_err_to_name(ret1));
    }

    if (ret0 == ESP_OK || ret1 == ESP_OK) {
        s_dual_can_initialized = true;
        ESP_LOGI(TAG, "Dual-CAN operational: Bus 0 (Classical CAN: %s), Bus 1 (CAN FD: %s)",
                 ret0 == ESP_OK ? "READY" : "OFFLINE",
                 ret1 == ESP_OK ? "READY" : "OFFLINE");
        return ESP_OK;
    }

    return ESP_FAIL;
#else
    ESP_LOGI(TAG, "Single-CAN platform (ESP32-C3 TWAI on-chip)");
    return ESP_OK;
#endif
}

bool dual_can_is_available(can_bus_t bus) {
    if (bus >= CAN_BUS_COUNT) return false;
    return s_can_bus[bus].initialized;
}

mcp2518fd_t* dual_can_get_device(can_bus_t bus) {
    if (bus >= CAN_BUS_COUNT) return nullptr;
    return &s_can_bus[bus];
}

esp_err_t dual_can_send(can_bus_t bus, const can_fd_frame_t *frame, TickType_t wait_ticks) {
    if (bus >= CAN_BUS_COUNT || !s_can_bus[bus].initialized) return ESP_ERR_INVALID_STATE;
    return mcp2518fd_transmit(&s_can_bus[bus], frame, wait_ticks);
}

esp_err_t dual_can_send_twai(can_bus_t bus, const twai_message_t *msg, TickType_t wait_ticks) {
    if (!msg) return ESP_ERR_INVALID_ARG;
    can_fd_frame_t frame;
    can_twai_to_fd(msg, bus, &frame);
    return dual_can_send(bus, &frame, wait_ticks);
}

esp_err_t dual_can_receive(can_bus_t bus, can_fd_frame_t *frame, TickType_t wait_ticks) {
    if (bus >= CAN_BUS_COUNT || !s_can_bus[bus].initialized) return ESP_ERR_INVALID_STATE;
    return mcp2518fd_receive(&s_can_bus[bus], frame, wait_ticks);
}

esp_err_t dual_can_poll_receive(can_bus_t bus, can_fd_frame_t *frame) {
    if (bus >= CAN_BUS_COUNT || !frame) return ESP_ERR_INVALID_ARG;
    mcp2518fd_t *dev = &s_can_bus[bus];
    if (!dev->initialized) return ESP_ERR_INVALID_STATE;

    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    if (dev->config.int_pin >= 0) {
        if (gpio_get_level(dev->config.int_pin) != 0 && (now_ms - dev->last_rx_poll_ms) < 20) {
            return ESP_ERR_NOT_FOUND;
        }
    }
    dev->last_rx_poll_ms = now_ms;
    return mcp2518fd_receive(dev, frame, pdMS_TO_TICKS(5));
}

esp_err_t dual_can_set_listen_only(bool listen_only) {
    esp_err_t overall = ESP_OK;
    for (int i = 0; i < CAN_BUS_COUNT; i++) {
        mcp2518fd_t *dev = &s_can_bus[i];
        if (!dev->initialized) continue;
        dev->config.listen_only = listen_only;
        mcp2518fd_mode_t mode = listen_only
            ? MCP2518FD_MODE_LISTEN_ONLY
            : (dev->config.can_fd_enabled ? MCP2518FD_MODE_NORMAL : MCP2518FD_MODE_CLASSIC);
        esp_err_t ret = mcp2518fd_set_mode(dev, mode);
        if (ret != ESP_OK) {
            overall = ret;
        } else {
            ESP_LOGI(TAG, "Dual-CAN bus %d switched to %s", i, listen_only ? "LISTEN_ONLY" : "ACTIVE");
        }
    }
    return overall;
}

void dual_can_shutdown(void) {
#if CONFIG_IDF_TARGET_ESP32S3
    if (!s_dual_can_initialized) return;
    s_dual_can_initialized = false;

    for (int i = 0; i < CAN_BUS_COUNT; i++) {
        mcp2518fd_t *dev = &s_can_bus[i];
        if (dev->mutex) xSemaphoreTake(dev->mutex, pdMS_TO_TICKS(50));
        bool was_init = dev->initialized;
        dev->initialized = false;
        if (was_init && dev->spi) {
            mcp2518fd_write_32(dev, MCP2518FD_REG_CiINT, 0x00000000);
            uint32_t cicon = 0;
            if (mcp2518fd_read_32(dev, MCP2518FD_REG_CiCON, &cicon) == ESP_OK) {
                cicon &= ~(0x7 << 24);
                cicon |= ((uint32_t)MCP2518FD_MODE_CONFIG) << 24;
                mcp2518fd_write_32(dev, MCP2518FD_REG_CiCON, cicon);
            }
        }
        if (dev->spi) {
            spi_bus_remove_device(dev->spi);
            dev->spi = nullptr;
        }
        if (dev->mutex) xSemaphoreGive(dev->mutex);
    }

    spi_bus_free(CAN0_SPI_HOST);
#if defined(CAN1_SPI_HOST)
    if (CAN1_SPI_HOST != CAN0_SPI_HOST) {
        spi_bus_free(CAN1_SPI_HOST);
    }
#endif

    // Restore SPI pins (including strapping pins GPIO3 / GPIO46 on CAN0) to clean defaults before reset
    gpio_reset_pin(CAN0_SPI_SCK_PIN);
    gpio_reset_pin(CAN0_SPI_MOSI_PIN);
    gpio_reset_pin(CAN0_SPI_MISO_PIN);
    gpio_reset_pin(CAN0_CS_PIN);
    gpio_reset_pin(CAN1_SPI_SCK_PIN);
    gpio_reset_pin(CAN1_SPI_MOSI_PIN);
    gpio_reset_pin(CAN1_SPI_MISO_PIN);
    gpio_reset_pin(CAN1_CS_PIN);
    ESP_LOGI(TAG, "Dual-CAN SPI buses and strapping pins quiesced for restart");
#endif
}

