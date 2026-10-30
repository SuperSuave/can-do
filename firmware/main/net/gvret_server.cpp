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

static uint8_t s_rx_accum[1024];
static size_t s_accum_len = 0;

static bool handle_client_rx(int sock) {
    if (sizeof(s_rx_accum) - s_accum_len < 256) {
        s_accum_len = 0;
    }

    int r = recv(sock, s_rx_accum + s_accum_len, sizeof(s_rx_accum) - s_accum_len, MSG_DONTWAIT);
    if (r == 0) {
        s_accum_len = 0;
        return false; // Client closed connection
    }
    if (r < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return true; // No data available
        }
        s_accum_len = 0;
        return false; // Fatal socket error
    }

    s_accum_len += r;
    size_t idx = 0;

    while (idx < s_accum_len) {
        uint8_t b = s_rx_accum[idx];

        if (b == 0xE7) {
            // Binary mode toggle
            idx++;
            continue;
        }

        if (b != 0xF1) {
            // Desynced, advance to next byte
            idx++;
            continue;
        }

        if (idx + 1 >= s_accum_len) {
            // Incomplete command, wait for next recv
            break;
        }

        uint8_t cmd = s_rx_accum[idx + 1];

        if (cmd == 0x00) {
            // SavvyCAN TX frame: 0xF1 0x00 + 4B ID + 1B bus + 1B len + len data + 1B checksum
            if (idx + 8 > s_accum_len) {
                break; // Header not fully received yet
            }
            uint8_t len = s_rx_accum[idx + 7];
            if (len > 8) len = 8;
            size_t total_frame_len = 8 + len + 1;

            if (idx + total_frame_len > s_accum_len) {
                break; // Payload not fully received yet
            }

            size_t frame_pos = idx + 2;
            uint32_t id = s_rx_accum[frame_pos] | (s_rx_accum[frame_pos+1] << 8) | 
                          (s_rx_accum[frame_pos+2] << 16) | (s_rx_accum[frame_pos+3] << 24);
            frame_pos += 4;
            uint8_t bus = s_rx_accum[frame_pos++];
            (void)bus;
            frame_pos++; // skip len

            twai_message_t tx_msg = {};
            tx_msg.extd = (id & 0x80000000) ? 1 : 0;
            tx_msg.identifier = id & 0x1FFFFFFF;
            tx_msg.data_length_code = len;
            for (int i = 0; i < len; i++) {
                tx_msg.data[i] = s_rx_accum[frame_pos++];
            }

            // Feed into internal CAN engine parser (enables bench log playback & SavvyCAN simulation)
            can_engine_inject_frame(&tx_msg);

            if (!g_sniffer_mode.load()) {
                twai_status_info_t info;
                if (twai_get_status_info(&info) == ESP_OK && info.state == TWAI_STATE_RUNNING) {
                    tx_msg.ss = 1; // Single-Shot mode
                    twai_transmit(&tx_msg, pdMS_TO_TICKS(10));
                }
            } else {
                ESP_LOGD(TAG, "Sniffer mode active: GVRET client TX 0x%03lX suppressed", (unsigned long)tx_msg.identifier);
            }

            idx += total_frame_len;
        } else if (cmd == 0x01) {
            uint32_t now_us = (uint32_t)esp_timer_get_time();
            uint8_t reply[6] = {
                0xF1, 0x01,
                (uint8_t)(now_us & 0xFF),
                (uint8_t)((now_us >> 8) & 0xFF),
                (uint8_t)((now_us >> 16) & 0xFF),
                (uint8_t)((now_us >> 24) & 0xFF)
            };
            send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            idx += 2;
        } else if (cmd == 0x02) {
            uint8_t reply[3] = { 0xF1, 0x02, 0x00 };
            send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            idx += 2;
        } else if (cmd == 0x03) {
            uint8_t reply[10] = { 0xF1, 0x03, 0, 0, 0, 0, 0, 0, 0, 0 };
            send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            idx += 2;
        } else if (cmd == 0x04) {
            if (idx + 3 > s_accum_len) break;
            idx += 3;
        } else if (cmd == 0x05) {
            if (idx + 10 > s_accum_len) break;
            size_t pos = idx + 2;
            uint32_t bus0_cfg = s_rx_accum[pos] | (s_rx_accum[pos+1] << 8) | (s_rx_accum[pos+2] << 16) | (s_rx_accum[pos+3] << 24);
            uint32_t speed = bus0_cfg & 0xFFFFF;
            if (speed > 1000000) speed = 1000000;
            else if (speed == 0) speed = 500000;
            bool listen_only = (bus0_cfg & 0x20000000) != 0;
            if (listen_only != g_hardware_listen_only.load()) {
                set_sniffer_mode(g_sniffer_mode.load(), listen_only);
            }
            idx += 10;
        } else if (cmd == 0x06) {
            uint8_t bus0_flags = 0x01;
            if (g_hardware_listen_only.load()) bus0_flags |= 0x10;
            uint32_t bus0_speed = 500000;
            uint8_t bus1_flags = 0x00;
            uint32_t bus1_speed = 0;
            uint8_t reply[12] = {
                0xF1, 0x06,
                bus0_flags,
                (uint8_t)(bus0_speed & 0xFF),
                (uint8_t)((bus0_speed >> 8) & 0xFF),
                (uint8_t)((bus0_speed >> 16) & 0xFF),
                (uint8_t)((bus0_speed >> 24) & 0xFF),
                bus1_flags,
                (uint8_t)(bus1_speed & 0xFF),
                (uint8_t)((bus1_speed >> 8) & 0xFF),
                (uint8_t)((bus1_speed >> 16) & 0xFF),
                (uint8_t)((bus1_speed >> 24) & 0xFF)
            };
            send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            idx += 2;
        } else if (cmd == 0x07) {
            uint8_t reply[7] = { 0xF1, 0x07, 0x20, 0x00, 0x01, 0x01, 0x01 };
            send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            idx += 2;
        } else if (cmd == 0x08) {
            if (idx + 3 > s_accum_len) break;
            idx += 3;
        } else if (cmd == 0x09) {
            uint8_t reply[4] = { 0xF1, 0x09, 0xDE, 0xAD };
            send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            idx += 2;
        } else if (cmd == 0x0A) {
            if (idx + 3 > s_accum_len) break;
            idx += 3;
        } else if (cmd == 0x0C) {
            uint8_t reply[3] = { 0xF1, 0x0C, 0x01 };
            send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            idx += 2;
        } else if (cmd == 0x0D) {
            if (idx + 14 > s_accum_len) break;
            idx += 14;
        } else {
            idx += 2;
        }
    }

    if (idx > 0) {
        if (idx < s_accum_len) {
            memmove(s_rx_accum, s_rx_accum + idx, s_accum_len - idx);
            s_accum_len -= idx;
        } else {
            s_accum_len = 0;
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

        while (true) {
            // 1. Process client incoming commands/frames
            if (!handle_client_rx(client_sock)) {
                ESP_LOGI(TAG, "GVRET client disconnected (rx error/close)");
                break;
            }

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
                if (!send_flush_buffer(client_sock, batch_buf, batch_len)) {
                    ESP_LOGI(TAG, "GVRET client disconnected (tx error)");
                    break;
                }
                last_flush_us = cur_us;
            }

            // Note: client connection closure & fatal socket errors are continuously
            // detected and handled by handle_client_rx() at the top of the loop.
        }

        close(client_sock);
        s_active_client_fd = -1;
        s_client_count.store(0);
        s_accum_len = 0;
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
