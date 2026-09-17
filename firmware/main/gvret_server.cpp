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

static void send_flush_buffer(int sock, uint8_t* buffer, size_t& len) {
    if (len == 0 || sock < 0) return;
    int sent = send(sock, buffer, len, 0);
    if (sent < 0) {
        ESP_LOGW(TAG, "Socket send error (%d)", errno);
    }
    len = 0;
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

static void handle_client_rx(int sock) {
    uint8_t rx_buf[256];
    int r = recv(sock, rx_buf, sizeof(rx_buf), MSG_DONTWAIT);
    if (r <= 0) return;

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
                send(sock, reply, sizeof(reply), 0);
            } else if (cmd == 0x06) {
                // Bus configuration: reply 0xF1 0x06 + bus0 speed (500k = 500000 = 0x0007A120)
                uint32_t baud = 500000;
                uint8_t reply[6] = {
                    0xF1, 0x06,
                    (uint8_t)(baud & 0xFF),
                    (uint8_t)((baud >> 8) & 0xFF),
                    (uint8_t)((baud >> 16) & 0xFF),
                    (uint8_t)((baud >> 24) & 0xFF)
                };
                send(sock, reply, sizeof(reply), 0);
            } else if (cmd == 0x07) {
                // Device Info: reply 0xF1 0x07 + build_lo, build_hi, eeprom_ver, file_ver, num_buses
                uint8_t reply[7] = { 0xF1, 0x07, 0x20, 0x00, 0x01, 0x01, 0x01 };
                send(sock, reply, sizeof(reply), 0);
            } else if (cmd == 0x09) {
                // Keepalive
                uint8_t reply[4] = { 0xF1, 0x09, 0xDE, 0xAD };
                send(sock, reply, sizeof(reply), 0);
            }
        }
    }
}

static void gvret_server_task(void* pvParameters) {
    uint16_t port = reinterpret_cast<uintptr_t>(pvParameters);
    ESP_LOGI(TAG, "Starting GVRET TCP server on port %d...", port);

    int listen_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listen_sock < 0) {
        ESP_LOGE(TAG, "Failed creating socket: errno %d", errno);
        vTaskDelete(nullptr);
        return;
    }

    int enable = 1;
    setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, &enable, sizeof(int));

    struct sockaddr_in server_addr = {};
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = htonl(INADDR_ANY);
    server_addr.sin_port = htons(port);

    if (bind(listen_sock, (struct sockaddr*)&server_addr, sizeof(server_addr)) != 0) {
        ESP_LOGE(TAG, "Failed binding port %d: errno %d", port, errno);
        close(listen_sock);
        vTaskDelete(nullptr);
        return;
    }

    if (listen(listen_sock, 2) != 0) {
        ESP_LOGE(TAG, "Failed listening on port %d: errno %d", port, errno);
        close(listen_sock);
        vTaskDelete(nullptr);
        return;
    }

    ESP_LOGI(TAG, "GVRET server listening on port %d (SavvyCAN / SavvyLens ready)", port);

    uint8_t* batch_buf = (uint8_t*)malloc(GVRET_BATCH_SIZE + 64);
    if (!batch_buf) {
        ESP_LOGE(TAG, "Failed allocating batch buffer");
        close(listen_sock);
        vTaskDelete(nullptr);
        return;
    }

    while (true) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        int client_sock = accept(listen_sock, (struct sockaddr*)&client_addr, &client_len);

        if (client_sock < 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
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

        size_t batch_len = 0;
        int64_t last_flush_us = esp_timer_get_time();

        while (true) {
            // 1. Process client incoming commands/frames
            handle_client_rx(client_sock);

            // 2. Dequeue outbound CAN frames
            twai_message_t frame;
            bool got_frame = false;
            if (xQueueReceive(s_gvret_queue, &frame, pdMS_TO_TICKS(2)) == pdTRUE) {
                got_frame = true;
                uint32_t now_us = (uint32_t)esp_timer_get_time();
                pack_can_frame(batch_buf, batch_len, &frame, now_us);
            }

            int64_t cur_us = esp_timer_get_time();
            bool timeout_flush = (cur_us - last_flush_us) >= (GVRET_FLUSH_INTERVAL_MS * 1000);
            bool size_flush = (batch_len >= (GVRET_BATCH_SIZE - 32));

            if (batch_len > 0 && (size_flush || timeout_flush)) {
                send_flush_buffer(client_sock, batch_buf, batch_len);
                last_flush_us = cur_us;
            }

            // Check if client is still alive
            if (!got_frame) {
                char probe;
                int check = recv(client_sock, &probe, 1, MSG_PEEK | MSG_DONTWAIT);
                if (check == 0 || (check < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
                    ESP_LOGI(TAG, "GVRET client disconnected");
                    break;
                }
            }
        }

        close(client_sock);
        s_active_client_fd = -1;
        s_client_count.store(0);
        // Clear queue on disconnect
        xQueueReset(s_gvret_queue);
    }

    free(batch_buf);
    close(listen_sock);
    vTaskDelete(nullptr);
}

esp_err_t gvret_server_init(uint16_t port) {
    if (!s_gvret_queue) {
        s_gvret_queue = xQueueCreate(GVRET_QUEUE_SIZE, sizeof(twai_message_t));
        if (!s_gvret_queue) return ESP_ERR_NO_MEM;
    }

    BaseType_t res = xTaskCreate(gvret_server_task, "gvret_srv", 4096, (void*)(uintptr_t)port, 4, nullptr);
    return res == pdPASS ? ESP_OK : ESP_FAIL;
}
