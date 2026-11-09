#include "gvret_server.h"
#include "can_engine.h"
#include "can.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>
#include <cerrno>
#include <atomic>

static const char* TAG = "GVRET";

#define GVRET_QUEUE_SIZE 128
#define GVRET_BATCH_SIZE 512
#define GVRET_FLUSH_INTERVAL_MS 10

static QueueHandle_t s_gvret_queue = nullptr;
static std::atomic<int> s_client_count{0};
static int s_active_client_fd = -1;

int gvret_get_client_count(void) {
    return s_client_count.load();
}

void gvret_enqueue_frame(const twai_message_t* msg, uint8_t bus) {
    if (!s_gvret_queue || s_client_count.load() == 0 || !msg) return;
    can_fd_frame_t frame;
    can_twai_to_fd(msg, (can_bus_t)bus, &frame);
    xQueueSend(s_gvret_queue, &frame, 0); // Drop without blocking if queue is full
}

void gvret_enqueue_fd_frame(const can_fd_frame_t* msg) {
    if (!s_gvret_queue || s_client_count.load() == 0 || !msg) return;
    xQueueSend(s_gvret_queue, msg, 0);
}

static bool send_flush_buffer(int sock, uint8_t* buf, size_t& len) {
    if (len == 0) return true;
    size_t sent = 0;
    while (sent < len) {
        int r = send(sock, buf + sent, len - sent, MSG_DONTWAIT);
        if (r > 0) {
            sent += r;
            continue;
        }
        if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            vTaskDelay(pdMS_TO_TICKS(2));
            continue;
        }
        ESP_LOGW(TAG, "GVRET socket send error (%d), peer disconnected", errno);
        return false;
    }
    len = 0;
    return true;
}

static void pack_can_frame(uint8_t* dest, size_t& offset, const can_fd_frame_t* msg, uint32_t timestamp_us) {
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
    if (msg->flags.extd) {
        id_field |= 0x80000000;
    }

    dest[offset++] = (uint8_t)(id_field & 0xFF);
    dest[offset++] = (uint8_t)((id_field >> 8) & 0xFF);
    dest[offset++] = (uint8_t)((id_field >> 16) & 0xFF);
    dest[offset++] = (uint8_t)((id_field >> 24) & 0xFF);

    uint8_t dlc = msg->len > 8 ? 8 : msg->len;
    uint8_t flags = ((msg->bus & 0x0F) << 4) | (dlc & 0x0F);
    if (msg->flags.rtr) flags |= 0x40;
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
            can_bus_t target_bus = (bus == 1) ? CAN_BUS_1 : CAN_BUS_0;
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
                tx_msg.ss = 1; // Single-Shot mode
                can_send(target_bus, &tx_msg, pdMS_TO_TICKS(10));
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
            // Firmware version reply (CAN Do 2026.11)
            uint8_t reply[4] = { 0xF1, 0x02, 0x04, 0x14 };
            send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            idx += 2;
        } else if (cmd == 0x03) {
            // Filter configuration command (0xF1 0x03 + 8B)
            if (idx + 10 > s_accum_len) break;
            idx += 10;
        } else if (cmd == 0x04) {
            // Baud rate configuration command (0xF1 0x04 + 4B baud)
            if (idx + 6 > s_accum_len) break;
            idx += 6;
        } else if (cmd == 0x05) {
            // Bus configuration command: 0xF1 0x05 + 4B bus0 + 4B bus1
            if (idx + 10 > s_accum_len) break;
            size_t pos = idx + 2;
            uint32_t bus0_cfg = s_rx_accum[pos] | (s_rx_accum[pos+1] << 8) | (s_rx_accum[pos+2] << 16) | (s_rx_accum[pos+3] << 24);
            uint32_t speed = bus0_cfg & 0xFFFFF;
            if (speed > 1000000) speed = 1000000;
            else if (speed == 0) speed = 500000;
            bool listen_only = (bus0_cfg & 0x20000000) != 0;
            if (listen_only != g_hardware_listen_only.load()) {
                set_sniffer_mode(listen_only, listen_only);
            }
            idx += 10;
        } else if (cmd == 0x06) {
            uint8_t bus0_flags = 0x01;
            if (g_hardware_listen_only.load()) bus0_flags |= 0x10;
            uint32_t bus0_speed = 500000;
            uint8_t bus1_flags = can_bus_is_available(CAN_BUS_1) ? 0x01 : 0x00;
            if (g_hardware_listen_only.load() && bus1_flags) bus1_flags |= 0x10;
            uint32_t bus1_speed = can_bus_is_available(CAN_BUS_1) ? 500000 : 0;
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
            idx += 2;
        } else if (cmd == 0x0B) {
            uint8_t reply[2] = { 0xF1, 0x0B };
            send(sock, reply, sizeof(reply), MSG_DONTWAIT);
            idx += 2;
        } else if (cmd == 0x0C) {
            idx += 2;
        } else {
            idx++;
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
            ESP_LOGW(TAG, "Failed binding alternate port %d: errno %d", secondary_port, errno);
        }
    }

    uint8_t* batch_buf = (uint8_t*)malloc(GVRET_BATCH_SIZE);
    if (!batch_buf) {
        ESP_LOGE(TAG, "Failed to allocate GVRET batch buffer");
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

        struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };
        int s = select(max_fd + 1, &read_fds, nullptr, nullptr, &tv);
        if (s <= 0) continue;

        int client_sock = -1;
        if (listen_sock_primary >= 0 && FD_ISSET(listen_sock_primary, &read_fds)) {
            client_sock = accept(listen_sock_primary, nullptr, nullptr);
        } else if (listen_sock_secondary >= 0 && FD_ISSET(listen_sock_secondary, &read_fds)) {
            client_sock = accept(listen_sock_secondary, nullptr, nullptr);
        }

        if (client_sock < 0) continue;

        ESP_LOGI(TAG, "GVRET client connected! Suspending automated burst commands for clean bus sniffing...");
        s_active_client_fd = client_sock;
        s_client_count.store(1);
        s_accum_len = 0;

        bool prev_automations_state = g_automations_enabled.load();
        set_automations_enabled(false);

        size_t batch_len = 0;
        int64_t last_flush_us = esp_timer_get_time();

        while (true) {
            // 1. Process client incoming commands/frames
            if (!handle_client_rx(client_sock)) {
                ESP_LOGI(TAG, "GVRET client disconnected (rx error/close)");
                break;
            }

            // 2. Dequeue outbound CAN frames
            can_fd_frame_t frame;
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
        }

        close(client_sock);
        s_active_client_fd = -1;
        s_client_count.store(0);
        s_accum_len = 0;
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
        s_gvret_queue = xQueueCreate(GVRET_QUEUE_SIZE, sizeof(can_fd_frame_t));
        if (!s_gvret_queue) return ESP_ERR_NO_MEM;
    }

    BaseType_t res = xTaskCreate(gvret_server_task, "gvret_srv", 3072, (void*)(uintptr_t)port, 4, nullptr);
    return res == pdPASS ? ESP_OK : ESP_FAIL;
}
