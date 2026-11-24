#include "gvret_server.h"
#include "can_engine.h"
#include "can.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>
#include <cerrno>
#include <atomic>

static const char* TAG = "GVRET";

#if CONFIG_SPIRAM
#define GVRET_QUEUE_SIZE 512
#else
#define GVRET_QUEUE_SIZE 128
#endif
#define GVRET_BATCH_SIZE 1400
#define GVRET_FLUSH_INTERVAL_MS 10
#define GVRET_TX_STALL_TIMEOUT_US 5000000LL
#define GVRET_DROPPABLE_WAIT_MS 20

static QueueHandle_t s_gvret_queue = nullptr;
static StaticQueue_t s_gvret_queue_struct;
static uint8_t* s_gvret_queue_storage = nullptr;
static std::atomic<int> s_client_count{0};
static int s_active_client_fd = -1;
static std::atomic<bool> s_disconnect_requested{false};

struct GvretConnState {
    int sock;
    int listen_pri;
    int listen_sec;
    int64_t stall_start_us;
    uint32_t dropped_batches;
    int64_t last_drop_log_us;
    bool preempted;
};

int gvret_get_client_count(void) {
    return s_client_count.load();
}

void gvret_disconnect_client(void) {
    s_disconnect_requested.store(true);
    int fd = s_active_client_fd;
    if (fd >= 0) {
        shutdown(fd, SHUT_RDWR);
    }
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

static bool has_pending_preemption(int listen_pri, int listen_sec) {
    fd_set check_fds;
    FD_ZERO(&check_fds);
    int check_max = -1;
    if (listen_pri >= 0) {
        FD_SET(listen_pri, &check_fds);
        if (listen_pri > check_max) check_max = listen_pri;
    }
    if (listen_sec >= 0) {
        FD_SET(listen_sec, &check_fds);
        if (listen_sec > check_max) check_max = listen_sec;
    }
    if (check_max < 0) return false;
    struct timeval tv_zero = { .tv_sec = 0, .tv_usec = 0 };
    return select(check_max + 1, &check_fds, nullptr, nullptr, &tv_zero) > 0;
}

static bool send_gvret_bytes(GvretConnState& st, const uint8_t* data, size_t len, bool droppable) {
    if (len == 0) return true;
    size_t sent = 0;
    int64_t wait_start_us = esp_timer_get_time();
    int64_t last_preempt_check_us = wait_start_us;

    while (sent < len) {
        if (s_disconnect_requested.load()) {
            return false;
        }
        int r = send(st.sock, data + sent, len - sent, MSG_DONTWAIT);
        if (r > 0) {
            sent += static_cast<size_t>(r);
            st.stall_start_us = 0;
            continue;
        }
        if (r < 0 && errno == EINTR) {
            continue;
        }
        if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            int64_t now_us = esp_timer_get_time();
            if (st.stall_start_us == 0) {
                st.stall_start_us = now_us;
            }
            if ((now_us - last_preempt_check_us) >= 20000) {
                last_preempt_check_us = now_us;
                if (has_pending_preemption(st.listen_pri, st.listen_sec)) {
                    st.preempted = true;
                    return false;
                }
            }
            if ((now_us - st.stall_start_us) >= GVRET_TX_STALL_TIMEOUT_US) {
                ESP_LOGW(TAG, "GVRET socket TX buffer stalled (>5s), dropping dead/unresponsive peer");
                return false;
            }
            if (droppable && sent == 0 && (now_us - wait_start_us) >= (GVRET_DROPPABLE_WAIT_MS * 1000LL)) {
                st.dropped_batches++;
                if (st.last_drop_log_us == 0 || (now_us - st.last_drop_log_us) >= 5000000LL) {
                    st.last_drop_log_us = now_us;
                    ESP_LOGW(TAG, "GVRET TX backpressure: dropped %lu CAN batch(es) to preserve stream framing",
                             (unsigned long)st.dropped_batches);
                }
                return true;
            }
            vTaskDelay(pdMS_TO_TICKS(2));
            continue;
        }
        ESP_LOGW(TAG, "GVRET socket send error (%d), peer disconnected", errno);
        return false;
    }
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

static bool handle_client_rx(GvretConnState& st) {
    if (sizeof(s_rx_accum) - s_accum_len < 256) {
        s_accum_len = 0;
    }

    int r = recv(st.sock, s_rx_accum + s_accum_len, sizeof(s_rx_accum) - s_accum_len, MSG_DONTWAIT);
    if (r == 0) {
        s_accum_len = 0;
        return false; // Client closed connection
    }
    if (r < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
            return true; // No data available
        }
        s_accum_len = 0;
        return false; // Fatal socket error
    }

    s_accum_len += static_cast<size_t>(r);
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
            uint8_t len = s_rx_accum[idx + 7] & 0x0F;
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
            if (!send_gvret_bytes(st, reply, sizeof(reply), false)) return false;
            idx += 2;
        } else if (cmd == 0x02) {
            // Firmware version / digital inputs reply (CAN Do 2026.11)
            uint8_t reply[4] = { 0xF1, 0x02, 0x04, 0x14 };
            if (!send_gvret_bytes(st, reply, sizeof(reply), false)) return false;
            idx += 2;
        } else if (cmd == 0x03) {
            // GET_ANALOG_INPUTS: 0xF1 0x03 -> 0xF1 0x03 + 9 bytes
            uint8_t reply[11] = { 0xF1, 0x03 };
            if (!send_gvret_bytes(st, reply, sizeof(reply), false)) return false;
            idx += 2;
        } else if (cmd == 0x04) {
            // SET_DIG_OUTPUTS: 0xF1 0x04 + 1B outputs
            if (idx + 3 > s_accum_len) break;
            idx += 3;
        } else if (cmd == 0x05) {
            // Bus configuration command: 0xF1 0x05 + 4B bus0 + 4B bus1
            if (idx + 10 > s_accum_len) break;
            size_t pos = idx + 2;
            uint32_t bus0_cfg = s_rx_accum[pos] | (s_rx_accum[pos+1] << 8) | (s_rx_accum[pos+2] << 16) | (s_rx_accum[pos+3] << 24);
            uint32_t speed = bus0_cfg & 0xFFFFF;
            if (speed > 1000000) speed = 1000000;
            else if (speed == 0) speed = 500000;
            (void)speed;
            bool listen_only = (bus0_cfg & 0x20000000) != 0;
            if (listen_only != g_hardware_listen_only.load()) {
                set_sniffer_mode(listen_only, listen_only);
            }
            idx += 10;
        } else if (cmd == 0x06) {
            uint8_t bus0_flags = can_bus_is_available(CAN_BUS_0) ? 0x01 : 0x00;
            if (g_hardware_listen_only.load() && bus0_flags) bus0_flags |= 0x10;
            uint32_t bus0_speed = bus0_flags ? 500000 : 0;
            uint8_t bus1_flags = can_bus_is_available(CAN_BUS_1) ? 0x01 : 0x00;
            if (g_hardware_listen_only.load() && bus1_flags) bus1_flags |= 0x10;
            uint32_t bus1_speed = bus1_flags ? 500000 : 0;
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
            if (!send_gvret_bytes(st, reply, sizeof(reply), false)) return false;
            idx += 2;
        } else if (cmd == 0x07) {
            uint8_t reply[7] = { 0xF1, 0x07, 0x20, 0x00, 0x01, 0x01, 0x01 };
            if (!send_gvret_bytes(st, reply, sizeof(reply), false)) return false;
            idx += 2;
        } else if (cmd == 0x08) {
            // SET_SINGLEWIRE_MODE: 0xF1 0x08 + 1B mode
            if (idx + 3 > s_accum_len) break;
            idx += 3;
        } else if (cmd == 0x09) {
            uint8_t reply[4] = { 0xF1, 0x09, 0xDE, 0xAD };
            if (!send_gvret_bytes(st, reply, sizeof(reply), false)) return false;
            idx += 2;
        } else if (cmd == 0x0A) {
            // SET_SYSTYPE: 0xF1 0x0A + 1B systype
            if (idx + 3 > s_accum_len) break;
            idx += 3;
        } else if (cmd == 0x0B) {
            uint8_t reply[2] = { 0xF1, 0x0B };
            if (!send_gvret_bytes(st, reply, sizeof(reply), false)) return false;
            idx += 2;
        } else if (cmd == 0x0C) {
            // GET_NUM_BUSES: 0xF1 0x0C -> 0xF1 0x0C + 1B bus count
            uint8_t num_buses = can_bus_is_available(CAN_BUS_1) ? 2 : 1;
            uint8_t reply[3] = { 0xF1, 0x0C, num_buses };
            if (!send_gvret_bytes(st, reply, sizeof(reply), false)) return false;
            idx += 2;
        } else if (cmd == 0x0D) {
            // GET_EXT_BUSES: 0xF1 0x0D -> 0xF1 0x0D + 15 zero bytes
            uint8_t reply[17] = { 0xF1, 0x0D };
            if (!send_gvret_bytes(st, reply, sizeof(reply), false)) return false;
            idx += 2;
        } else if (cmd == 0x0E) {
            // SET_EXT_BUSES: 0xF1 0x0E + 12B config
            if (idx + 14 > s_accum_len) break;
            idx += 14;
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

#if CONFIG_SPIRAM
    uint8_t* batch_buf = static_cast<uint8_t*>(
        heap_caps_malloc_prefer(GVRET_BATCH_SIZE, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT));
#else
    uint8_t* batch_buf = static_cast<uint8_t*>(malloc(GVRET_BATCH_SIZE));
#endif
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

        // Configure TCP Keepalive to quickly detect dead/unplugged clients
        int keepalive = 1;
        setsockopt(client_sock, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
        int keepidle = 5;      // Probes start after 5 seconds of idle
        setsockopt(client_sock, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
        int keepintvl = 2;     // Probes sent every 2 seconds
        setsockopt(client_sock, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
        int keepcnt = 3;       // 3 unacknowledged probes = drop connection (~11s total)
        setsockopt(client_sock, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));

        // Configure socket send & receive timeouts (2 seconds)
        struct timeval tv_timeout = { .tv_sec = 2, .tv_usec = 0 };
        setsockopt(client_sock, SOL_SOCKET, SO_SNDTIMEO, &tv_timeout, sizeof(tv_timeout));
        setsockopt(client_sock, SOL_SOCKET, SO_RCVTIMEO, &tv_timeout, sizeof(tv_timeout));

        // Disable Nagle's algorithm for immediate dispatch of CAN packets
        int nodelay = 1;
        setsockopt(client_sock, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

        ESP_LOGI(TAG, "GVRET client connected! Suspending automated burst commands for clean bus sniffing...");
        s_active_client_fd = client_sock;
        s_client_count.store(1);
        s_accum_len = 0;
        s_disconnect_requested.store(false);

        bool prev_automations_state = g_automations_enabled.load();
        set_automations_enabled(false);

        GvretConnState conn = {
            .sock = client_sock,
            .listen_pri = listen_sock_primary,
            .listen_sec = listen_sock_secondary,
            .stall_start_us = 0,
            .dropped_batches = 0,
            .last_drop_log_us = 0,
            .preempted = false
        };

        size_t batch_len = 0;
        int64_t last_flush_us = esp_timer_get_time();
        int64_t last_preempt_check_us = last_flush_us;

        while (true) {
            if (s_disconnect_requested.load()) {
                ESP_LOGI(TAG, "GVRET disconnect requested via API");
                break;
            }

            int64_t cur_us = esp_timer_get_time();
            if ((cur_us - last_preempt_check_us) >= 50000) {
                last_preempt_check_us = cur_us;
                if (has_pending_preemption(listen_sock_primary, listen_sock_secondary)) {
                    ESP_LOGI(TAG, "New GVRET client connect detected on listening port; preempting fd %d", client_sock);
                    break;
                }
            }

            // 1. Process client incoming commands/frames
            if (!handle_client_rx(conn)) {
                ESP_LOGI(TAG, "GVRET client disconnected (%s)",
                         conn.preempted ? "preempted" : "rx error/close");
                break;
            }

            // 2. Drain outbound CAN frames into an MSS-sized batch
            can_fd_frame_t frame;
            TickType_t wait_ticks = pdMS_TO_TICKS(batch_len > 0 ? 1 : 2);
            if (xQueueReceive(s_gvret_queue, &frame, wait_ticks) == pdTRUE) {
                uint32_t now_us = (uint32_t)esp_timer_get_time();
                pack_can_frame(batch_buf, batch_len, &frame, now_us);
                while (batch_len < (GVRET_BATCH_SIZE - 32) &&
                       xQueueReceive(s_gvret_queue, &frame, 0) == pdTRUE) {
                    now_us = (uint32_t)esp_timer_get_time();
                    pack_can_frame(batch_buf, batch_len, &frame, now_us);
                }
            }

            cur_us = esp_timer_get_time();
            bool timeout_flush = (cur_us - last_flush_us) >= (GVRET_FLUSH_INTERVAL_MS * 1000LL);
            bool size_flush = (batch_len >= (GVRET_BATCH_SIZE - 32));

            if (batch_len > 0 && (size_flush || timeout_flush)) {
                if (!send_gvret_bytes(conn, batch_buf, batch_len, true)) {
                    ESP_LOGI(TAG, "GVRET client disconnected (%s)",
                             conn.preempted ? "preempted" : "tx error");
                    break;
                }
                batch_len = 0;
                last_flush_us = cur_us;
            }
        }

        close(client_sock);
        s_active_client_fd = -1;
        s_client_count.store(0);
        s_accum_len = 0;
        s_disconnect_requested.store(false);
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
#if CONFIG_SPIRAM
        s_gvret_queue_storage = static_cast<uint8_t*>(
            heap_caps_malloc_prefer(GVRET_QUEUE_SIZE * sizeof(can_fd_frame_t), 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT));
        if (s_gvret_queue_storage) {
            s_gvret_queue = xQueueCreateStatic(GVRET_QUEUE_SIZE, sizeof(can_fd_frame_t), s_gvret_queue_storage, &s_gvret_queue_struct);
        }
#endif
        if (!s_gvret_queue) {
            s_gvret_queue = xQueueCreate(GVRET_QUEUE_SIZE, sizeof(can_fd_frame_t));
        }
        if (!s_gvret_queue) return ESP_ERR_NO_MEM;
    }

    BaseType_t res = xTaskCreate(gvret_server_task, "gvret_srv", 4096, (void*)(uintptr_t)port, 4, nullptr);
    return res == pdPASS ? ESP_OK : ESP_FAIL;
}
