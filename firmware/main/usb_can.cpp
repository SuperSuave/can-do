#include "usb_can.h"
#include <unistd.h>
#include <fcntl.h>
#include <cstring>
#include <cstdint>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "can_engine.h"
#include "esp_log.h"
#include "driver/usb_serial_jtag_vfs.h"

static const char* TAG = "USB_CAN";

static inline int hex_char_to_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void usb_can_task(void* pvParameters) {
    // Disable CRLF conversion on stdin so raw binary or \r does not get mangled
    usb_serial_jtag_vfs_set_rx_line_endings(ESP_LINE_ENDINGS_LF);

    uint8_t rx_buf[256];
    uint8_t accum[1024];
    size_t accum_len = 0;

    ESP_LOGI(TAG, "USB Serial CAN ingestion task started (SLCAN & GVRET support on COM port)");

    static uint32_t s_injected_count = 0;

    while (true) {
        int n = read(STDIN_FILENO, rx_buf, sizeof(rx_buf));
        if (n > 0) {
            if (accum_len + n <= sizeof(accum)) {
                memcpy(accum + accum_len, rx_buf, n);
                accum_len += n;
            } else {
                accum_len = 0;
            }

            size_t idx = 0;
            while (idx < accum_len) {
                uint8_t b = accum[idx];

                // 1. Check for SLCAN: 't' (standard 11-bit) or 'T' (extended 29-bit)
                if (b == 't' || b == 'T') {
                    size_t eol = idx;
                    while (eol < accum_len && accum[eol] != '\r' && accum[eol] != '\n') {
                        eol++;
                    }
                    if (eol >= accum_len) {
                        break; // Wait for full line
                    }

                    bool is_ext = (b == 'T');
                    size_t id_len = is_ext ? 8 : 3;
                    size_t min_len = 1 + id_len + 1; // prefix + ID + DLC

                    if (eol - idx >= min_len) {
                        uint32_t id = 0;
                        bool valid = true;
                        for (size_t i = 0; i < id_len; i++) {
                            int v = hex_char_to_val((char)accum[idx + 1 + i]);
                            if (v < 0) { valid = false; break; }
                            id = (id << 4) | v;
                        }

                        int dlc = hex_char_to_val((char)accum[idx + 1 + id_len]);
                        if (valid && dlc >= 0 && dlc <= 8 && (eol - idx >= min_len + dlc * 2)) {
                            twai_message_t tx_msg = {};
                            tx_msg.extd = is_ext ? 1 : 0;
                            tx_msg.identifier = id;
                            tx_msg.data_length_code = dlc;

                            size_t dpos = idx + 1 + id_len + 1;
                            for (int d = 0; d < dlc; d++) {
                                int h = hex_char_to_val((char)accum[dpos + d * 2]);
                                int l = hex_char_to_val((char)accum[dpos + d * 2 + 1]);
                                if (h < 0 || l < 0) { valid = false; break; }
                                tx_msg.data[d] = (uint8_t)((h << 4) | l);
                            }

                            if (valid) {
                                can_engine_inject_frame(&tx_msg);
                                s_injected_count++;
                                if (s_injected_count % 1000 == 0) {
                                    ESP_LOGI(TAG, "USB Ingested %lu frames", (unsigned long)s_injected_count);
                                }
                            }
                        }
                    }

                    idx = eol + 1;
                    while (idx < accum_len && (accum[idx] == '\r' || accum[idx] == '\n')) {
                        idx++;
                    }
                    continue;
                }

                // 2. Check for binary GVRET (starts with 0xF1)
                if (b == 0xF1) {
                    if (idx + 1 >= accum_len) break;
                    uint8_t cmd = accum[idx + 1];
                    if (cmd == 0x00) {
                        if (idx + 8 > accum_len) break;
                        uint8_t dlc = accum[idx + 7];
                        if (dlc > 8) dlc = 8;
                        size_t total_len = 8 + dlc + 1;
                        if (idx + total_len > accum_len) break;

                        size_t fpos = idx + 2;
                        uint32_t id = accum[fpos] | (accum[fpos+1] << 8) | 
                                      (accum[fpos+2] << 16) | (accum[fpos+3] << 24);
                        fpos += 4;
                        fpos++; // bus
                        fpos++; // len
                        twai_message_t tx_msg = {};
                        tx_msg.extd = (id & 0x80000000) ? 1 : 0;
                        tx_msg.identifier = id & 0x1FFFFFFF;
                        tx_msg.data_length_code = dlc;
                        for (int d = 0; d < dlc; d++) {
                            tx_msg.data[d] = accum[fpos++];
                        }
                        can_engine_inject_frame(&tx_msg);
                        s_injected_count++;
                        if (s_injected_count % 1000 == 0) {
                            ESP_LOGI(TAG, "USB Ingested %lu frames", (unsigned long)s_injected_count);
                        }
                        idx += total_len;
                        continue;
                    } else {
                        idx += 2;
                        continue;
                    }
                }

                // Unrecognized byte, advance
                idx++;
            }

            if (idx > 0) {
                if (idx < accum_len) {
                    memmove(accum, accum + idx, accum_len - idx);
                    accum_len -= idx;
                } else {
                    accum_len = 0;
                }
            }
        } else {
            vTaskDelay(pdMS_TO_TICKS(2));
        }
    }
}

esp_err_t usb_can_init(void) {
    BaseType_t res = xTaskCreate(usb_can_task, "USB_CAN", 4096, nullptr, 5, nullptr);
    return (res == pdPASS) ? ESP_OK : ESP_FAIL;
}
