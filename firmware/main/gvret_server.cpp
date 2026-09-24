#include "gvret_server.h"
#include "can_engine.h"
#include <cstdio>
#include <cstring>
#include <vector>
#include <atomic>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_system.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"

static const char* TAG = "GVRET";

#define GVRET_QUEUE_SIZE 256
#define GVRET_BATCH_SIZE 1400
#define GVRET_FLUSH_INTERVAL_MS 10

static QueueHandle_t s_gvret_queue = nullptr;
static std::atomic<int> s_client_count{0};
static int s_active_client_fd = -1;

void gvret_enqueue_frame(const twai_message_t* msg) {
    if (!msg || s_client_count.load() == 0 || !s_gvret_queue) return;

    if (xQueueSend(s_gvret_queue, msg, 0) != pdTRUE) {
        // Drop oldest frame to protect heap and avoid backpressure starvation
        twai_message_t discarded;
        xQueueReceive(s_gvret_queue, &discarded, 0);
        xQueueSend(s_gvret_queue, msg, 0);
    }
}

int gvret_get_client_count(void) {
    return s_client_count.load();
}

static bool send_flush_buffer(int sock, uint8_t* buffer, size_t& len) {
    if (len == 0 || sock < 0) return true;
    int sent = send(sock, buffer, len, MSG_DONTWAIT);
    len = 0;
    if (sent < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            // Buffer full / client paused capture: discard batch silently without log flooding
            return true;
        }
        ESP_LOGW(TAG, "GVRET socket send error (%d), peer disconnected", errno);
        return false;
    }
    return true;
}

static void pack_can_frame(uint8_t* dest, size_t& offset, const twai_message_t* msg, uint32_t timestamp_us) {
    // GVRET Binary Format:
    // 0: 0xF1 (Start of packet)
    // 1: 0x00 (BUILD_CAN_FRAME)
    // 2-5: Timestamp (µs, little-endian)
    // 6-9: CAN ID (uint32_t little-endian, bit 31 set if extended)
    // 10: Bus & Length (bits 4-7 = bus, bits 0-3 = DLC)
    // 11..11+DLC-1: Data payload
    // 11+DLC: Checksum / terminator (0x00)

    dest[offset++] = 0xF1;
    dest[offset++] = 0x00;

    dest[offset++] = (uint8_t)(timestamp_us & 0xFF);
    dest[offset++] = (uint8_t)((timestamp_us >> 8) & 0xFF);
    dest[offset++] = (uint8_t)((timestamp_us >> 16) & 0xFF);
    dest[offset++] = (uint8_t)((timestamp_us >> 24) & 0xFF);

    uint32_t id_field = msg->identifier;
    if (msg->extd) {
        id_field |= 0x80000000;
    }

    dest[offset++] = (uint8_t)(id_field & 0xFF);
    dest[offset++] = (uint8_t)((id_field >> 8) & 0xFF);
    dest[offset++] = (uint8_t)((id_field >> 16) & 0xFF);
    dest[offset++] = (uint8_t)((id_field >> 24) & 0xFF);

    uint8_t dlc = msg->data_length_code > 8 ? 8 : msg->data_length_code;
    uint8_t flags = (0 << 4) | (dlc & 0x0F); // Bus 0
    if (msg->rtr) flags |= 0x40;
    dest[offset++] = flags;

    for (int i = 0; i < dlc; i++) {
        dest[offset++] = msg->data[i];
    }
    dest[offset++] = 0x00; // Checksum / trailing byte
}

static bool handle_client_rx(int sock) {
    uint8_t rx_buf[256];
    int r = recv(sock, rx_buf, sizeof(rx_buf), MSG_DONTWAIT);
    if (r == 0) {
        return false; // Client closed connection
    }
    if (r < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return true; // No data available
        }
        return false; // Fatal socket error
    }

    int idx = 0;
    while (idx < r) {
        uint8_t b = rx_buf[idx++];

        if (b == 0xE7) {
            // Binary mode toggle
            continue;
        }

        if (b == 0xF1 && idx < r) {
            uint8_t cmd = rx_buf[idx++];

            if (cmd == 0x00) {
                // SavvyCAN TX frame: 4 bytes ID, 1 byte bus, 1 byte len, len bytes data, 1 byte checksum
                if (idx + 6 <= r) {
                    uint32_t id = rx_buf[idx] | (rx_buf[idx+1] << 8) | (rx_buf[idx+2] << 16) | (rx_buf[idx+3] << 24);
                    idx += 4;
                    uint8_t bus = rx_buf[idx++];
                    uint8_t len = rx_buf[idx++];
                    (void)bus;

                    if (len <= 8 && idx + len <= r) {
                        twai_message_t tx_msg = {};
                        tx_msg.extd = (id & 0x80000000) ? 1 : 0;
                        tx_msg.identifier = id & 0x1FFFFFFF;
                        tx_msg.data_length_code = len;
                        for (int i = 0; i < len; i++) {
                            tx_msg.data[i] = rx_buf[idx++];
                        }
                        if (idx < r) idx++; // checksum byte

                        if (!g_sniffer_mode.load()) {
                            twai_transmit(&tx_msg, pdMS_TO_TICKS(10));
                        } else {
                            ESP_LOGD(TAG, "Sniffer mode active: GVRET client TX 0x%03lX suppressed", (unsigned long)tx_msg.identifier);
                        }
                    } else {
                        idx += (len <= (size_t)(r - idx)) ? len : (r - idx);
                    }
                }
            } else if (cmd == 0x01) {
                // Time sync: reply 0xF1 0x01 + 4 bytes us
                uint32_t now_us = (uint32_t)esp_timer_get_time();
                uint8_t reply[6] = {
                    0xF1, 0x01,
                    (uint8_t)(now_us & 0xFF),
                    (uint8_t)((now_us >> 8) & 0xFF),
                    (uint8_t)((now_us >> 16) & 0xFF),
                    (uint8_t)((now_us >> 24) & 0xFF)
                };
                send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            } else if (cmd == 0x02) {
                // Digital inputs
                uint8_t reply[3] = { 0xF1, 0x02, 0x00 };
                send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            } else if (cmd == 0x03) {
                // Analog inputs: 8 zeros
                uint8_t reply[10] = { 0xF1, 0x03, 0, 0, 0, 0, 0, 0, 0, 0 };
                send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            } else if (cmd == 0x04) {
                // Set digital outputs: 1 byte
                if (idx < r) idx++;
            } else if (cmd == 0x05) {
                // Setup CAN bus: 8 bytes (4 bytes bus0 baud/flags, 4 bytes bus1 baud/flags)
                if (idx + 8 <= r) {
                    uint32_t bus0_cfg = rx_buf[idx] | (rx_buf[idx+1] << 8) | (rx_buf[idx+2] << 16) | (rx_buf[idx+3] << 24);
                    idx += 8;
                    bool listen_only = (bus0_cfg & 0x20000000) != 0;
                    ESP_LOGI(TAG, "GVRET bus setup: 0x%08lX (listen_only=%d)", (unsigned long)bus0_cfg, listen_only ? 1 : 0);
                } else {
                    idx = r;
                }
            } else if (cmd == 0x06) {
                // Bus configuration: reply 0xF1 0x06 + bus0 speed (500k = 500000 = 0x0007A120) + bus1
                uint32_t baud0 = 500000 | 0x80000000 | 0x40000000;
                uint32_t baud1 = 0;
                uint8_t reply[10] = {
                    0xF1, 0x06,
                    (uint8_t)(baud0 & 0xFF),
                    (uint8_t)((baud0 >> 8) & 0xFF),
                    (uint8_t)((baud0 >> 16) & 0xFF),
                    (uint8_t)((baud0 >> 24) & 0xFF),
                    (uint8_t)(baud1 & 0xFF),
                    (uint8_t)((baud1 >> 8) & 0xFF),
                    (uint8_t)((baud1 >> 16) & 0xFF),
                    (uint8_t)((baud1 >> 24) & 0xFF)
                };
                send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            } else if (cmd == 0x07) {
                // Device Info: reply 0xF1 0x07 + build_lo, build_hi, eeprom_ver, file_ver, num_buses
                uint8_t reply[7] = { 0xF1, 0x07, 0x20, 0x00, 0x01, 0x01, 0x01 };
                send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            } else if (cmd == 0x08) {
                // Single wire mode
                if (idx < r) idx++;
            } else if (cmd == 0x09) {
                // Keepalive
                uint8_t reply[4] = { 0xF1, 0x09, 0xDE, 0xAD };
                send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            } else if (cmd == 0x0A) {
                // System type
                if (idx < r) idx++;
            } else if (cmd == 0x0C) {
                // Num buses: 1
                uint8_t reply[3] = { 0xF1, 0x0C, 0x01 };
                send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            } else if (cmd == 0x0D) {
                // Extended buses
                idx += (idx + 12 <= r) ? 12 : (r - idx);
            }
        }
    }
    return true;
}

static void gvret_server_task(void* pvParameters) {
    uint16_t port = reinterpret_cast<uintptr_t>(pvParameters);
    ESP_LOGI(TAG, "Starting GVRET TCP server on port %d...", port);

    int listen_sock_primary = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int listen_sock_secondary = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int enable = 1;

    uint16_t primary_port = port > 0 ? port : 23;
    uint16_t secondary_port = (primary_port == 3333) ? 23 : 3333;

    struct sockaddr_in addr_pri = {};
    addr_pri.sin_family = AF_INET;
    addr_pri.sin_addr.s_addr = htonl(INADDR_ANY);
    addr_pri.sin_port = htons(primary_port);

    struct sockaddr_in addr_sec = {};
    addr_sec.sin_family = AF_INET;
    addr_sec.sin_addr.s_addr = htonl(INADDR_ANY);
    addr_sec.sin_port = htons(secondary_port);

    if (listen_sock_primary >= 0) {
        setsockopt(listen_sock_primary, SOL_SOCKET, SO_REUSEADDR, &enable, sizeof(int));
        if (bind(listen_sock_primary, (struct sockaddr*)&addr_pri, sizeof(addr_pri)) == 0) {
            listen(listen_sock_primary, 2);
            ESP_LOGI(TAG, "GVRET server listening on port %d", primary_port);
        } else {
            ESP_LOGW(TAG, "Failed binding port %d: errno %d", primary_port, errno);
        }
    }

    if (listen_sock_secondary >= 0) {
        setsockopt(listen_sock_secondary, SOL_SOCKET, SO_REUSEADDR, &enable, sizeof(int));
        if (bind(listen_sock_secondary, (struct sockaddr*)&addr_sec, sizeof(addr_sec)) == 0) {
            listen(listen_sock_secondary, 2);
            ESP_LOGI(TAG, "GVRET server listening on port %d (WiCAN / SavvyCAN alternate)", secondary_port);
        } else {
            ESP_LOGW(TAG, "Failed binding secondary port %d: errno %d", secondary_port, errno);
        }
    }

    uint8_t* batch_buf = (uint8_t*)malloc(GVRET_BATCH_SIZE + 64);
    if (!batch_buf) {
        ESP_LOGE(TAG, "Failed allocating batch buffer");
        if (listen_sock_primary >= 0) close(listen_sock_primary);
        if (listen_sock_secondary >= 0) close(listen_sock_secondary);
        vTaskDelete(nullptr);
        return;
    }

    while (true) {
        fd_set read_fds;
        FD_ZERO(&read_fds);
        int max_fd = -1;

        if (listen_sock_primary >= 0) {
            FD_SET(listen_sock_primary, &read_fds);
            if (listen_sock_primary > max_fd) max_fd = listen_sock_primary;
        }
        if (listen_sock_secondary >= 0) {
            FD_SET(listen_sock_secondary, &read_fds);
            if (listen_sock_secondary > max_fd) max_fd = listen_sock_secondary;
        }

        struct timeval tv = {1, 0};
        int s = select(max_fd + 1, &read_fds, nullptr, nullptr, &tv);
        if (s <= 0) continue;

        int client_sock = -1;
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);

        if (listen_sock_primary >= 0 && FD_ISSET(listen_sock_primary, &read_fds)) {
            client_sock = accept(listen_sock_primary, (struct sockaddr*)&client_addr, &client_len);
        } else if (listen_sock_secondary >= 0 && FD_ISSET(listen_sock_secondary, &read_fds)) {
            client_sock = accept(listen_sock_secondary, (struct sockaddr*)&client_addr, &client_len);
        }

        if (client_sock < 0) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }

        // Set TCP_NODELAY to bypass Nagle's algorithm and ensure instant frame dispatch
        int nodelay = 1;
        setsockopt(client_sock, IPPROTO_TCP, TCP_NODELAY, (char*)&nodelay, sizeof(int));

        // Set non-blocking
        int flags = fcntl(client_sock, F_GETFL, 0);
        fcntl(client_sock, F_SETFL, flags | O_NONBLOCK);

        s_active_client_fd = client_sock;
        s_client_count.store(1);
        ESP_LOGI(TAG, "SavvyCAN / GVRET client connected from %s:%d",
                 inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));

        bool prev_automations_state = g_automations_enabled.load();
        if (prev_automations_state) {
            set_automations_enabled(false);
            ESP_LOGI(TAG, "Automations automatically paused while SavvyCAN/SavvyLens is connected");
        }

        size_t batch_len = 0;
        int64_t last_flush_us = esp_timer_get_time();

        int64_t last_check_us = esp_timer_get_time();

        while (true) {
            // 1. Process client incoming commands/frames
            if (!handle_client_rx(client_sock)) {
                ESP_LOGI(TAG, "GVRET client disconnected (rx error/close)");
                break;
            }

            // 2. Dequeue outbound CAN frames
            twai_message_t frame;
            if (xQueueReceive(s_gvret_queue, &frame, pdMS_TO_TICKS(2)) == pdTRUE) {
                uint32_t now_us = (uint32_t)esp_timer_get_time();
                pack_can_frame(batch_buf, batch_len, &frame, now_us);
            }

            int64_t cur_us = esp_timer_get_time();
            bool timeout_flush = (cur_us - last_flush_us) >= (GVRET_FLUSH_INTERVAL_MS * 1000);
            bool size_flush = (batch_len >= (GVRET_BATCH_SIZE - 32));

            if (batch_len > 0 && (size_flush || timeout_flush)) {
                if (!send_flush_buffer(client_sock, batch_buf, batch_len)) {
                    ESP_LOGI(TAG, "GVRET client disconnected (tx error)");
                    break;
                }
                last_flush_us = cur_us;
            }

            // Periodic peer liveness check (every 500ms)
            if (cur_us - last_check_us >= 500000) {
                last_check_us = cur_us;
                char probe;
                int check = recv(client_sock, &probe, 1, MSG_PEEK | MSG_DONTWAIT);
                if (check == 0 || (check < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
                    ESP_LOGI(TAG, "GVRET client disconnected (connection closed)");
                    break;
                }
            }
        }

        close(client_sock);
        s_active_client_fd = -1;
        s_client_count.store(0);
        // Clear queue on disconnect
        xQueueReset(s_gvret_queue);

        if (prev_automations_state) {
            set_automations_enabled(true);
            ESP_LOGI(TAG, "Automations automatically resumed after SavvyCAN/SavvyLens disconnected");
        }
    }

    free(batch_buf);
    if (listen_sock_primary >= 0) close(listen_sock_primary);
    if (listen_sock_secondary >= 0) close(listen_sock_secondary);
    vTaskDelete(nullptr);
}

esp_err_t gvret_server_init(uint16_t port) {
    if (!s_gvret_queue) {
        s_gvret_queue = xQueueCreate(GVRET_QUEUE_SIZE, sizeof(twai_message_t));
        if (!s_gvret_queue) return ESP_ERR_NO_MEM;
    }

    BaseType_t res = xTaskCreate(gvret_server_task, "gvret_srv", 3072, (void*)(uintptr_t)port, 4, nullptr);
    return res == pdPASS ? ESP_OK : ESP_FAIL;
}
