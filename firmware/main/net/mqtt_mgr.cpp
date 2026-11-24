#include "mqtt_mgr.h"
#include "parser.h"
#include "can_engine.h"
#include "psram_alloc.h"
#include "track_popup.h"
#include "hud_nav.h"
#include "power_mgr.h"
#include "cJSON.h"
#include "esp_log.h"
#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iterator>
#include <memory>
#include <mutex>
#include <unordered_set>
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/idf_additions.h>
#include <sys/unistd.h>
#include <sys/stat.h>

static const char* TAG = "MQTT_MGR";
static const char* MQTT_CONFIG_FILE = "/spiffs/mqtt.json";

extern std::string g_device_id;
#define DEVICE_ID g_device_id

#define MQTT_BASE_TOPIC_LIT "cando"
static constexpr const char* MQTT_BASE_TOPIC = "cando";
static esp_mqtt_client_handle_t global_mqtt_client = nullptr;
std::mutex g_automations_file_mutex;

static constexpr const char* MQTT_CONFIG_TMP_FILE = "/spiffs/mqtt.json.tmp";
static constexpr const char* MQTT_AUTOMATIONS_STAGE_FILE = "/spiffs/automations.json.mqtt.stage";
static constexpr const char* MQTT_AUTOMATIONS_PENDING_FILE = "/spiffs/automations.json.mqtt.pending";
static constexpr const char* MQTT_AUTOMATIONS_WORK_FILE = "/spiffs/automations.json.mqtt.work";
static constexpr size_t kMaxMqttAutomationsBytes = 128 * 1024;
static constexpr size_t kMaxMonitoredIdsFileBytes = 16 * 1024;
static constexpr size_t kMaxMqttConfigFileBytes = 4 * 1024;
static constexpr uint32_t kMaxCanId = 0x1FFFFFFFUL;
static constexpr uint32_t kMaxDelayMs = 3600000U;

static std::mutex s_mqtt_mutex;
static MqttConfig s_mqtt_cfg;
static char* s_active_broker_url = nullptr;
static std::atomic<bool> s_mqtt_connected{false};
static std::atomic<bool> s_hydrated_from_mqtt{false};
static std::mutex s_sync_mutex;
static bool s_sync_task_running = false;
static bool s_sync_pending = false;
static uint32_t s_sync_generation = 0;
static std::atomic<uint32_t> s_last_ha_birth_sync_ms{0};
static std::atomic<bool> s_need_clear_discovery{false};
static std::mutex s_auto_reload_mutex;
static bool s_auto_reload_task_running = false;
static bool s_auto_reload_pending = false;
static std::atomic<bool> s_auto_parse_tmp_pending{false};
static std::atomic<bool> s_monitored_ids_persist_pending{false};
static PsramUnorderedSet<std::string> s_exposed_auto_ids;
static std::string s_lwt_topic;

static bool save_monitored_ids_to_fs(void);
static void trigger_post_connect_sync(void);
static void mqtt_mgr_start(void);
static void mqtt_mgr_stop(void);
static void mqtt_mgr_publish_discovery(void);
static void mqtt_mgr_clear_discovery(void);

static bool parse_valid_can_id(const cJSON* item, uint32_t& out_id) {
    if (!item) return false;
    if (cJSON_IsString(item) && item->valuestring) {
        const char* p = item->valuestring;
        while (*p && isspace(static_cast<unsigned char>(*p))) ++p;
        if (*p == '\0' || *p == '-' || *p == '+') return false;
        errno = 0;
        char* endptr = nullptr;
        unsigned long val = strtoul(p, &endptr, 0);
        if (endptr == p || errno == ERANGE) return false;
        while (*endptr && isspace(static_cast<unsigned char>(*endptr))) ++endptr;
        if (*endptr != '\0') return false;
        if (val > kMaxCanId) return false;
        out_id = static_cast<uint32_t>(val);
        return true;
    }
    if (cJSON_IsNumber(item)) {
        double v = item->valuedouble;
        if (!std::isfinite(v) || v < 0.0 || v > static_cast<double>(kMaxCanId) || std::floor(v) != v) {
            return false;
        }
        out_id = static_cast<uint32_t>(v);
        return true;
    }
    return false;
}

struct HeapFreeDeleter {
    void operator()(void* ptr) const noexcept {
        free(ptr);
    }
};

static inline char* alloc_mqtt_pub_buf(size_t sz) {
#if CONFIG_SPIRAM
    return (char*)heap_caps_malloc_prefer(sz, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT);
#else
    return (char*)malloc(sz);
#endif
}

static bool atomic_write_text_file(const char* target_path, const char* tmp_path, const char* data, size_t len) {
    if (!target_path || !tmp_path || !data) {
        return false;
    }
    FILE* f = fopen(tmp_path, "w");
    if (!f) {
        ESP_LOGE(TAG, "Failed to open %s for atomic write", tmp_path);
        return false;
    }
    size_t written = (len > 0) ? fwrite(data, 1, len, f) : 0;
    bool write_ok = (written == len) && (ferror(f) == 0);
    bool flush_ok = write_ok && (fflush(f) == 0);
    bool close_ok = (fclose(f) == 0);
    if (!write_ok || !flush_ok || !close_ok) {
        ESP_LOGE(TAG, "Failed writing %s (written=%zu/%zu, write_ok=%d, flush_ok=%d, close_ok=%d)",
                 tmp_path, written, len, (int)write_ok, (int)flush_ok, (int)close_ok);
        unlink(tmp_path);
        return false;
    }
    if (rename(tmp_path, target_path) != 0) {
        ESP_LOGE(TAG, "Failed to atomically rename %s -> %s", tmp_path, target_path);
        unlink(tmp_path);
        return false;
    }
    return true;
}

enum class MqttCmdKind : uint8_t {
    ENTITY_CMD = 0,
    PERSIST_MONITORED_IDS = 1,
};

struct MqttSetCmd {
    MqttCmdKind kind;
    char entity_id[64];
    char payload[384];
};
static QueueHandle_t s_mqtt_cmd_queue = nullptr;
static StaticQueue_t s_mqtt_cmd_queue_struct;
static uint8_t* s_mqtt_cmd_queue_storage = nullptr;

static void mqtt_enqueue_entity_cmd(const char* entity_id, const char* payload, const char* source_label) {
    if (!entity_id || !payload) return;
    const size_t entity_len = strlen(entity_id);
    const size_t payload_len = strlen(payload);
    if (entity_len == 0 || entity_len >= sizeof(MqttSetCmd::entity_id)) {
        ESP_LOGW(TAG, "Rejecting MQTT %s command with %s entity_id (len=%zu, max=%zu)",
                 source_label ? source_label : "cmd",
                 entity_len == 0 ? "empty" : "oversized",
                 entity_len, sizeof(MqttSetCmd::entity_id) - 1);
        return;
    }
    if (payload_len >= sizeof(MqttSetCmd::payload)) {
        ESP_LOGW(TAG, "Rejecting oversized MQTT %s payload for '%s' (%zu bytes > %zu max)",
                 source_label ? source_label : "cmd",
                 entity_id, payload_len, sizeof(MqttSetCmd::payload) - 1);
        return;
    }
    if (s_mqtt_cmd_queue) {
        std::unique_ptr<MqttSetCmd, HeapFreeDeleter> cmd(
            static_cast<MqttSetCmd*>(static_cast<void*>(alloc_mqtt_pub_buf(sizeof(MqttSetCmd)))));
        if (!cmd) {
            ESP_LOGE(TAG, "OOM allocating MqttSetCmd for %s/%s", source_label ? source_label : "cmd", entity_id);
            return;
        }
        memset(cmd.get(), 0, sizeof(MqttSetCmd));
        cmd->kind = MqttCmdKind::ENTITY_CMD;
        memcpy(cmd->entity_id, entity_id, entity_len + 1);
        memcpy(cmd->payload, payload, payload_len + 1);
        if (xQueueSend(s_mqtt_cmd_queue, cmd.get(), 0) != pdTRUE) {
            ESP_LOGW(TAG, "MQTT cmd queue full, dropping %s/%s", source_label ? source_label : "cmd", cmd->entity_id);
        }
    } else {
        ESP_LOGW(TAG, "MQTT cmd queue not initialized");
    }
}

static void mqtt_cmd_worker_task(void* arg) {
    (void)arg;
    std::unique_ptr<MqttSetCmd, HeapFreeDeleter> cmd(
        static_cast<MqttSetCmd*>(static_cast<void*>(alloc_mqtt_pub_buf(sizeof(MqttSetCmd)))));
    if (!cmd) {
        ESP_LOGE(TAG, "Failed to allocate MqttSetCmd buffer for mqtt_cmd task");
        vTaskDelete(nullptr);
        return;
    }
    while (true) {
        TickType_t wait_ticks = s_monitored_ids_persist_pending.load(std::memory_order_acquire)
            ? pdMS_TO_TICKS(50)
            : portMAX_DELAY;
        if (xQueueReceive(s_mqtt_cmd_queue, cmd.get(), wait_ticks) == pdTRUE) {
            if (cmd->kind == MqttCmdKind::ENTITY_CMD) {
                rtc_crash_record_event("mqtt_set_cmd");
                queue_entity_command(cmd->entity_id, cmd->payload);
            }
        }
        if (s_monitored_ids_persist_pending.exchange(false, std::memory_order_acq_rel)) {
            save_monitored_ids_to_fs();
        }
    }
}

#if CONFIG_SPIRAM
static constexpr size_t kMaxMqttReassemblyBytes = 16 * 1024;
static constexpr int kMqttOutBufSize = 16384;
static constexpr int kMqttOutboxLimit = 65536;
#else
static constexpr size_t kMaxMqttReassemblyBytes = 8 * 1024;
static constexpr int kMqttOutBufSize = 4096;
static constexpr int kMqttOutboxLimit = 16384;
#endif

struct AutomationsRxState {
    bool active = false;
    bool write_failed = false;
    int msg_id = -1;
    int total_len = 0;
    int received_len = 0;
};

struct MqttRxReassembly {
    bool active = false;
    bool dropping = false;
    int msg_id = -1;
    int total_len = 0;
    int received_len = 0;
    std::string topic;
    char* buf = nullptr;
};

static FILE* s_automations_tmp_file = nullptr;
static AutomationsRxState s_auto_rx;
static MqttRxReassembly s_rx_reassembly;

static void abort_mqtt_automations_rx(void) {
    bool had_rx = s_auto_rx.active || (s_automations_tmp_file != nullptr);
    if (s_automations_tmp_file) {
        fclose(s_automations_tmp_file);
        s_automations_tmp_file = nullptr;
    }
    if (had_rx) {
        std::lock_guard<std::mutex> file_lock(g_automations_file_mutex);
        unlink(MQTT_AUTOMATIONS_STAGE_FILE);
    }
    s_auto_rx = {};
}

static void abort_mqtt_reassembly_rx(void) {
    if (s_rx_reassembly.buf) {
        free(s_rx_reassembly.buf);
        s_rx_reassembly.buf = nullptr;
    }
    s_rx_reassembly.active = false;
    s_rx_reassembly.dropping = false;
    s_rx_reassembly.msg_id = -1;
    s_rx_reassembly.total_len = 0;
    s_rx_reassembly.received_len = 0;
    s_rx_reassembly.topic.clear();
}

struct MqttPubItem {
    char topic[96];
    char inline_data[144];
    char* heap_data;
    int len;
    uint8_t qos;
    uint8_t retain;
};
#if CONFIG_SPIRAM
static constexpr UBaseType_t MQTT_PUB_QUEUE_LEN = 64;
#else
static constexpr UBaseType_t MQTT_PUB_QUEUE_LEN = 16;
#endif
static StaticQueue_t s_mqtt_pub_queue_struct;
static uint8_t* s_mqtt_pub_queue_storage = nullptr;
static QueueHandle_t s_mqtt_pub_queue = nullptr;
static std::mutex s_mqtt_pub_mutex;

static void mqtt_pub_worker_task(void* arg) {
    (void)arg;
    MqttPubItem item;
    uint32_t last_err_log_ms = 0;
    uint32_t suppressed_errs = 0;
    while (true) {
        if (xQueueReceive(s_mqtt_pub_queue, &item, portMAX_DELAY) == pdTRUE) {
            if (s_mqtt_connected.load(std::memory_order_relaxed)) {
                int res = 0;
                bool attempted = false;
                {
                    std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
                    if (global_mqtt_client && s_mqtt_connected.load(std::memory_order_relaxed)) {
                        attempted = true;
                        const char* payload_ptr = item.heap_data ? item.heap_data : item.inline_data;
                        const size_t approx_packet_len =
                            (item.len > 0 ? static_cast<size_t>(item.len) : 0) + strlen(item.topic) + 32;
                        if (approx_packet_len > static_cast<size_t>(kMqttOutBufSize)) {
                            // Stream oversized payloads directly so out_buffer/outbox limits do not drop them
                            res = esp_mqtt_client_publish(global_mqtt_client, item.topic, payload_ptr, item.len, item.qos, item.retain);
                        } else {
                            res = esp_mqtt_client_enqueue(global_mqtt_client, item.topic, payload_ptr, item.len, item.qos, item.retain, true);
                        }
                    }
                }
                if (attempted && res < 0) {
                    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                    if (last_err_log_ms == 0 || (now_ms - last_err_log_ms >= 5000)) {
                        ESP_LOGW(TAG, "MQTT publish/enqueue failed (res=%d, topic=%s, len=%d, suppressed=%lu)",
                                 res, item.topic, item.len, (unsigned long)suppressed_errs);
                        last_err_log_ms = now_ms;
                        suppressed_errs = 0;
                    } else {
                        ++suppressed_errs;
                    }
                }
            }
            if (item.heap_data) {
                free(item.heap_data);
            }
        }
    }
}

// Non-blocking MQTT enqueue helper: queues to s_mqtt_pub_queue with 0-tick wait so can_rx_task never touches MQTT_API_LOCK
static void mqtt_enqueue_nonblocking(const char* topic, const char* data, int len, int qos, int retain) {
    if (!s_mqtt_pub_queue || !global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed) || !topic) return;
    if (len < 0) return;
    const size_t topic_len = strlen(topic);
    if (topic_len == 0 || topic_len >= sizeof(MqttPubItem::topic)) {
        ESP_LOGW(TAG, "Rejecting MQTT publish with %s topic (len=%zu, max=%zu): %.64s",
                 topic_len == 0 ? "empty" : "oversized",
                 topic_len, sizeof(MqttPubItem::topic) - 1, topic);
        return;
    }
    int actual_len = (!data) ? 0 : ((len > 0) ? len : (int)strlen(data));
    MqttPubItem item = {};
    memcpy(item.topic, topic, topic_len + 1);
    item.len = actual_len;
    item.qos = (uint8_t)qos;
    item.retain = (uint8_t)retain;
    if (actual_len > 0 && data) {
        if (actual_len <= (int)sizeof(item.inline_data)) {
            memcpy(item.inline_data, data, actual_len);
        } else {
            item.heap_data = alloc_mqtt_pub_buf((size_t)actual_len);
            if (!item.heap_data) {
                ESP_LOGW(TAG, "OOM allocating %d-byte MQTT publish payload for %s", actual_len, item.topic);
                return;
            }
            memcpy(item.heap_data, data, actual_len);
        }
    }
    if (xQueueSend(s_mqtt_pub_queue, &item, 0) != pdTRUE) {
        if (item.heap_data) {
            free(item.heap_data);
        }
        static std::atomic<uint32_t> s_last_full_log_ms{0};
        static std::atomic<uint32_t> s_dropped_pub_count{0};
        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
        uint32_t last_ms = s_last_full_log_ms.load(std::memory_order_relaxed);
        if ((last_ms == 0 || (now_ms - last_ms >= 5000)) &&
            s_last_full_log_ms.compare_exchange_strong(last_ms, now_ms ? now_ms : 1, std::memory_order_acq_rel)) {
            uint32_t suppressed = s_dropped_pub_count.exchange(0, std::memory_order_acq_rel);
            ESP_LOGW(TAG, "MQTT pub queue full, dropping publish (topic=%s, len=%d, suppressed=%lu)",
                     item.topic, item.len, (unsigned long)suppressed);
        } else {
            s_dropped_pub_count.fetch_add(1, std::memory_order_relaxed);
        }
    }
}

// Default monitored CAN IDs (Gen5W / E-GMP vehicle telemetry) stored in flash rodata
static constexpr uint32_t s_default_monitored_ids[] = {
    0x038, 0x045, 0x070, 0x0A2, 0x130, 0x151, 0x152, 0x1AC, 0x1BA, 0x1CF, 0x1F1, 0x1F9, 0x1FA,
    0x200, 0x203, 0x220, 0x226, 0x227, 0x258, 0x259, 0x25C, 0x29B, 0x29C, 0x2AD, 0x2AF, 0x2C0, 0x2DB, 0x2FC,
    0x30B, 0x30C, 0x30E, 0x31B, 0x31C, 0x321, 0x324, 0x326, 0x327, 0x328, 0x340, 0x380, 0x384,
    0x38C, 0x38D, 0x39B, 0x3A1, 0x3A2, 0x3A6, 0x3AA, 0x3C1,
    0x410, 0x411, 0x412, 0x413, 0x414, 0x418, 0x41D, 0x420, 0x421, 0x435, 0x436, 0x438,
    0x442, 0x448, 0x450, 0x453, 0x455, 0x465, 0x474, 0x475, 0x476, 0x477, 0x478, 0x47F,
    0x490, 0x496, 0x49C, 0x4A2, 0x4C5, 0x4CE, 0x4E2, 0x4ED,
    0x540, 0x541, 0x542, 0x553, 0x559, 0x578, 0x584, 0x587, 0x593, 0x594, 0x595, 0x597, 0x5CC,
    0x5D0, 0x5D6, 0x5D7, 0x5F5, 0x5F7, 0x60C, 0x60D, 0x60E, 0x60F, 0x651, 0x652, 0x7EC
};
static PsramUnorderedSet<uint32_t> s_monitored_ids;
static bool s_monitored_ids_initialized = false;
static std::mutex s_monitored_mutex;
static std::mutex s_monitored_file_mutex;
static const char* MONITORED_IDS_FILE = "/spiffs/monitored_ids.json";
static const char* MONITORED_IDS_TMP_FILE = "/spiffs/monitored_ids.json.tmp";

static void ensure_monitored_ids_seeded_locked(void) {
    if (!s_monitored_ids_initialized) {
        s_monitored_ids.clear();
        s_monitored_ids.reserve(sizeof(s_default_monitored_ids) / sizeof(s_default_monitored_ids[0]));
        s_monitored_ids.insert(std::begin(s_default_monitored_ids), std::end(s_default_monitored_ids));
        s_monitored_ids_initialized = true;
    }
}

static void load_monitored_ids_from_fs(void) {
    FILE* f = fopen(MONITORED_IDS_FILE, "r");
    if (!f) {
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        ensure_monitored_ids_seeded_locked();
        return;
    }

    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (len <= 0 || static_cast<size_t>(len) > kMaxMonitoredIdsFileBytes) {
        if (len > static_cast<long>(kMaxMonitoredIdsFileBytes)) {
            ESP_LOGW(TAG, "Ignoring oversized %s (%ld > %zu bytes)", MONITORED_IDS_FILE, len, kMaxMonitoredIdsFileBytes);
        }
        fclose(f);
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        ensure_monitored_ids_seeded_locked();
        return;
    }

    char* buf = alloc_mqtt_pub_buf(static_cast<size_t>(len) + 1);
    if (!buf) {
        ESP_LOGE(TAG, "Failed to allocate %ld bytes for %s", len + 1, MONITORED_IDS_FILE);
        fclose(f);
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        ensure_monitored_ids_seeded_locked();
        return;
    }
    size_t nread = fread(buf, 1, static_cast<size_t>(len), f);
    fclose(f);
    buf[nread] = '\0';

    cJSON* root = cJSON_ParseWithLength(buf, nread);
    free(buf);
    if (!root || !cJSON_IsArray(root)) {
        if (root) cJSON_Delete(root);
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        ensure_monitored_ids_seeded_locked();
        return;
    }

    std::lock_guard<std::mutex> lock(s_monitored_mutex);
    s_monitored_ids.clear();
    int count = cJSON_GetArraySize(root);
    if (count > 0) {
        s_monitored_ids.reserve(static_cast<size_t>(count));
    }
    for (int i = 0; i < count; i++) {
        cJSON* itm = cJSON_GetArrayItem(root, i);
        uint32_t parsed_id = 0;
        if (parse_valid_can_id(itm, parsed_id)) {
            s_monitored_ids.insert(parsed_id);
        } else {
            ESP_LOGW(TAG, "Ignoring invalid monitored CAN ID at index %d in %s", i, MONITORED_IDS_FILE);
        }
    }
    s_monitored_ids_initialized = true;
    cJSON_Delete(root);
    ESP_LOGI(TAG, "Loaded %d monitored CAN IDs from %s", (int)s_monitored_ids.size(), MONITORED_IDS_FILE);
}

static bool save_monitored_ids_to_fs(void) {
    std::lock_guard<std::mutex> file_lock(s_monitored_file_mutex);
    cJSON* root = cJSON_CreateArray();
    if (!root) return false;
    {
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        ensure_monitored_ids_seeded_locked();
        PsramVector<uint32_t> sorted(s_monitored_ids.begin(), s_monitored_ids.end());
        std::sort(sorted.begin(), sorted.end());
        for (uint32_t id : sorted) {
            char hex_buf[16];
            snprintf(hex_buf, sizeof(hex_buf), "0x%03lX", (unsigned long)id);
            cJSON* str_item = cJSON_CreateString(hex_buf);
            if (!str_item || !cJSON_AddItemToArray(root, str_item)) {
                if (str_item) cJSON_Delete(str_item);
                cJSON_Delete(root);
                return false;
            }
        }
    }

    char* rendered = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!rendered) return false;

    bool ok = atomic_write_text_file(MONITORED_IDS_FILE, MONITORED_IDS_TMP_FILE, rendered, strlen(rendered));
    free(rendered);
    if (ok) {
        ESP_LOGI(TAG, "Persisted %s", MONITORED_IDS_FILE);
    }
    return ok;
}

void mqtt_mgr_publish_can_state(uint32_t can_id, const uint8_t* data, size_t len) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    char topic[64];
    snprintf(topic, sizeof(topic), "%s/%s/state/0x%03lX", MQTT_BASE_TOPIC, DEVICE_ID.c_str(), (unsigned long)can_id);
    char hex_payload[17] = {0};
    for (size_t i = 0; i < len && i < 8; i++) {
        snprintf(&hex_payload[i * 2], 3, "%02X", data[i]);
    }
    // QoS 0 + non-blocking enqueue prevents outbox bloat and TCP stalls in can_rx_task
    mqtt_enqueue_nonblocking(topic, hex_payload, (int)(len > 8 ? 16 : len * 2), 0, 1);
}

void mqtt_mgr_publish_entity_state(const std::string& entity_id, const std::string& state) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    std::string topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/state/" + entity_id;
    mqtt_enqueue_nonblocking(topic.c_str(), state.c_str(), (int)state.length(), 0, 1);
}

void mqtt_mgr_publish_active_ids(bool force) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    static std::atomic<uint32_t> s_last_active_pub_ms{0};
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    uint32_t last_ms = s_last_active_pub_ms.load(std::memory_order_relaxed);
    if (!force && (now_ms - last_ms < 10000)) {
        return; // Throttle to at most once per 10s
    }
    if (!force && !can_engine_has_active_ids_changed()) {
        return;
    }

    std::vector<uint32_t> active = can_engine_get_active_ids();
    if (active.empty() && !force) return;

    cJSON* root = cJSON_CreateArray();
    if (!root) return;
    for (uint32_t id : active) {
        char hex_buf[16];
        snprintf(hex_buf, sizeof(hex_buf), "0x%03lX", (unsigned long)id);
        cJSON* str_item = cJSON_CreateString(hex_buf);
        if (!str_item || !cJSON_AddItemToArray(root, str_item)) {
            if (str_item) cJSON_Delete(str_item);
            cJSON_Delete(root);
            return;
        }
    }
    char* rendered = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!rendered) return;

    char topic[64];
    snprintf(topic, sizeof(topic), "%s/%s/active_ids", MQTT_BASE_TOPIC, DEVICE_ID.c_str());
    mqtt_enqueue_nonblocking(topic, rendered, (int)strlen(rendered), 0, 1);
    free(rendered);

    s_last_active_pub_ms.store(now_ms, std::memory_order_relaxed);
    can_engine_clear_active_ids_changed();
}

void mqtt_mgr_set_monitored_ids(const std::vector<uint32_t>& ids, bool persist) {
    PsramUnorderedSet<uint32_t> next_ids(ids.begin(), ids.end());
    bool changed = false;
    {
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        ensure_monitored_ids_seeded_locked();
        if (next_ids != s_monitored_ids) {
            s_monitored_ids.swap(next_ids);
            changed = true;
        }
    }
    if (!persist || !changed) {
        return;
    }
    s_monitored_ids_persist_pending.store(true, std::memory_order_release);
    if (s_mqtt_cmd_queue) {
        std::unique_ptr<MqttSetCmd, HeapFreeDeleter> cmd(
            static_cast<MqttSetCmd*>(static_cast<void*>(alloc_mqtt_pub_buf(sizeof(MqttSetCmd)))));
        if (!cmd) {
            ESP_LOGW(TAG, "OOM allocating MqttSetCmd; deferring monitored_ids persistence");
        } else {
            memset(cmd.get(), 0, sizeof(MqttSetCmd));
            cmd->kind = MqttCmdKind::PERSIST_MONITORED_IDS;
            if (xQueueSend(s_mqtt_cmd_queue, cmd.get(), 0) != pdTRUE) {
                ESP_LOGW(TAG, "MQTT cmd queue full; deferring monitored_ids persistence");
            }
        }
    } else if (s_monitored_ids_persist_pending.exchange(false, std::memory_order_acq_rel)) {
        save_monitored_ids_to_fs();
    }
}

std::vector<uint32_t> mqtt_mgr_get_monitored_ids(void) {
    std::lock_guard<std::mutex> lock(s_monitored_mutex);
    ensure_monitored_ids_seeded_locked();
    std::vector<uint32_t> ids(s_monitored_ids.begin(), s_monitored_ids.end());
    std::sort(ids.begin(), ids.end());
    return ids;
}

void mqtt_mgr_reset_monitored_ids(void) {
    std::lock_guard<std::mutex> file_lock(s_monitored_file_mutex);
    {
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        s_monitored_ids.clear();
        s_monitored_ids.reserve(sizeof(s_default_monitored_ids) / sizeof(s_default_monitored_ids[0]));
        s_monitored_ids.insert(std::begin(s_default_monitored_ids), std::end(s_default_monitored_ids));
        s_monitored_ids_initialized = true;
    }
    s_monitored_ids_persist_pending.store(false, std::memory_order_release);
    unlink(MONITORED_IDS_FILE);
    unlink(MONITORED_IDS_TMP_FILE);
    ESP_LOGI(TAG, "Reset monitored CAN IDs to default");
}

bool mqtt_mgr_is_monitored_ids_customized(void) {
    struct stat st;
    return stat(MONITORED_IDS_FILE, &st) == 0;
}

bool mqtt_mgr_is_monitored_id(uint32_t can_id) {
    std::lock_guard<std::mutex> lock(s_monitored_mutex);
    ensure_monitored_ids_seeded_locked();
    return s_monitored_ids.find(can_id) != s_monitored_ids.end();
}

static void publish_ha_discovery(esp_mqtt_client_handle_t client, const CanEntity& entity) {
    if (!client || entity.ha_domain.empty()) return;

    cJSON *root = cJSON_CreateObject();
    if (!root) return;
    cJSON_AddStringToObject(root, "name", entity.ha_name.c_str());

    std::string unique_id = DEVICE_ID + "_" + entity.id;
    cJSON_AddStringToObject(root, "unique_id", unique_id.c_str());
    cJSON_AddStringToObject(root, "object_id", entity.id.c_str());

    if (!entity.ha_icon.empty()) {
        cJSON_AddStringToObject(root, "icon", entity.ha_icon.c_str());
    }

    if (entity.ha_domain == "select" && !entity.options.empty()) {
        cJSON *options_array = cJSON_AddArrayToObject(root, "options");
        if (!options_array) {
            cJSON_Delete(root);
            return;
        }
        for (const auto& opt : entity.options) {
            cJSON *opt_str = cJSON_CreateString(opt.label.c_str());
            if (!opt_str || !cJSON_AddItemToArray(options_array, opt_str)) {
                if (opt_str) cJSON_Delete(opt_str);
                cJSON_Delete(root);
                return;
            }
        }
    }

    const bool is_controllable =
        (entity.ha_domain != "sensor" &&
         entity.ha_domain != "binary_sensor" &&
         entity.ha_domain != "event");
    if (is_controllable) {
        std::string cmd_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/set/" + entity.id;
        cJSON_AddStringToObject(root, "command_topic", cmd_topic.c_str());
    }
    std::string state_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/state/" + entity.id;
    std::string availability_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/status";
    cJSON_AddStringToObject(root, "state_topic", state_topic.c_str());
    cJSON_AddStringToObject(root, "availability_topic", availability_topic.c_str());
    cJSON_AddStringToObject(root, "payload_available", "online");
    cJSON_AddStringToObject(root, "payload_not_available", "offline");

    if (entity.ha_domain == "switch") {
        cJSON_AddStringToObject(root, "payload_on", "ON");
        cJSON_AddStringToObject(root, "payload_off", "OFF");
        cJSON_AddStringToObject(root, "state_on", "ON");
        cJSON_AddStringToObject(root, "state_off", "OFF");
    }

    cJSON *device = cJSON_AddObjectToObject(root, "device");
    if (!device) {
        cJSON_Delete(root);
        return;
    }
    cJSON_AddStringToObject(device, "identifiers", DEVICE_ID.c_str());
    cJSON_AddStringToObject(device, "name", ("CAN Do (" + DEVICE_ID + ")").c_str());
    cJSON_AddStringToObject(device, "model", "Edge Engine");
    cJSON_AddStringToObject(device, "manufacturer", "CAN Do");

    char *payload = cJSON_PrintUnformatted(root);
    if (payload) {
        std::string topic = "homeassistant/" + entity.ha_domain + "/" + DEVICE_ID + "/" + entity.id + "/config";
        mqtt_enqueue_nonblocking(topic.c_str(), payload, (int)strlen(payload), 0, 1);
        free(payload);
    }
    cJSON_Delete(root);
}

static void clear_ha_discovery(esp_mqtt_client_handle_t client, const CanEntity& entity) {
    if (!client || entity.ha_domain.empty()) return;
    std::string topic = "homeassistant/" + entity.ha_domain + "/" + DEVICE_ID + "/" + entity.id + "/config";
    mqtt_enqueue_nonblocking(topic.c_str(), "", 0, 0, 1);
}

static void publish_ha_automation_discovery(esp_mqtt_client_handle_t client, const AutomationRule& rule) {
    if (!client || !rule.ha_expose || rule.id.empty()) return;

    cJSON *root = cJSON_CreateObject();
    if (!root) return;
    cJSON_AddStringToObject(root, "name", rule.name.c_str());

    std::string unique_id = DEVICE_ID + "_auto_" + rule.id;
    cJSON_AddStringToObject(root, "unique_id", unique_id.c_str());
    cJSON_AddStringToObject(root, "object_id", ("auto_" + rule.id).c_str());

    if (!rule.ha_icon.empty()) {
        cJSON_AddStringToObject(root, "icon", rule.ha_icon.c_str());
    }

    std::string cmd_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/set/" + rule.id;
    std::string state_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/state/" + rule.id;
    std::string availability_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/status";
    cJSON_AddStringToObject(root, "command_topic", cmd_topic.c_str());
    cJSON_AddStringToObject(root, "state_topic", state_topic.c_str());
    cJSON_AddStringToObject(root, "availability_topic", availability_topic.c_str());
    cJSON_AddStringToObject(root, "payload_available", "online");
    cJSON_AddStringToObject(root, "payload_not_available", "offline");

    cJSON_AddStringToObject(root, "payload_on", "ON");
    cJSON_AddStringToObject(root, "payload_off", "OFF");
    cJSON_AddStringToObject(root, "state_on", "ON");
    cJSON_AddStringToObject(root, "state_off", "OFF");

    cJSON *device = cJSON_AddObjectToObject(root, "device");
    if (!device) {
        cJSON_Delete(root);
        return;
    }
    cJSON_AddStringToObject(device, "identifiers", DEVICE_ID.c_str());
    cJSON_AddStringToObject(device, "name", ("CAN Do (" + DEVICE_ID + ")").c_str());
    cJSON_AddStringToObject(device, "model", "Edge Engine");
    cJSON_AddStringToObject(device, "manufacturer", "CAN Do");

    char *payload = cJSON_PrintUnformatted(root);
    if (payload) {
        std::string topic = "homeassistant/switch/" + DEVICE_ID + "/" + rule.id + "/config";
        mqtt_enqueue_nonblocking(topic.c_str(), payload, (int)strlen(payload), 0, 1);
        free(payload);
    }
    mqtt_enqueue_nonblocking(state_topic.c_str(), rule.enabled ? "ON" : "OFF", rule.enabled ? 2 : 3, 0, 1);
    cJSON_Delete(root);
}

static void clear_ha_automation_topic(esp_mqtt_client_handle_t client, const std::string& rule_id) {
    if (!client || rule_id.empty()) return;
    std::string topic = "homeassistant/switch/" + DEVICE_ID + "/" + rule_id + "/config";
    mqtt_enqueue_nonblocking(topic.c_str(), "", 0, 0, 1);
}

static void publish_automations_json_state(void) {
    if (!global_mqtt_client || !s_mqtt_connected.load()) return;
    std::string state_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/config/automations/state";
    char* sbuf = nullptr;
    size_t slen = 0;
    {
        std::lock_guard<std::mutex> file_lock(g_automations_file_mutex);
        FILE* state_f = fopen("/spiffs/automations.json", "r");
        if (state_f) {
            fseek(state_f, 0, SEEK_END);
            long raw_len = ftell(state_f);
            fseek(state_f, 0, SEEK_SET);
            if (raw_len > 0 && static_cast<size_t>(raw_len) <= kMaxMqttAutomationsBytes) {
                sbuf = alloc_mqtt_pub_buf(static_cast<size_t>(raw_len) + 1);
                if (sbuf) {
                    slen = fread(sbuf, 1, static_cast<size_t>(raw_len), state_f);
                    sbuf[slen] = '\0';
                }
            } else if (raw_len > static_cast<long>(kMaxMqttAutomationsBytes)) {
                ESP_LOGW(TAG, "Automations file exceeds MQTT limit (%ld > %zu bytes)", raw_len, kMaxMqttAutomationsBytes);
            }
            fclose(state_f);
        }
    }
    if (sbuf && slen > 0) {
        mqtt_enqueue_nonblocking(state_topic.c_str(), sbuf, (int)slen, 0, 1);
    } else {
        static const char kEmptyAutomations[] = "{\"settings\":{},\"rules\":[]}";
        mqtt_enqueue_nonblocking(state_topic.c_str(), kEmptyAutomations, (int)(sizeof(kEmptyAutomations) - 1), 0, 1);
    }
    if (sbuf) {
        free(sbuf);
    }
}

static void mqtt_post_connect_sync_task(void* arg) {
    (void)arg;
    while (true) {
        uint32_t my_gen = 0;
        {
            std::lock_guard<std::mutex> lock(s_sync_mutex);
            if (!s_sync_pending) {
                s_sync_task_running = false;
                break;
            }
            s_sync_pending = false;
            my_gen = s_sync_generation;
        }

        auto is_superseded = [my_gen]() -> bool {
            std::lock_guard<std::mutex> lock(s_sync_mutex);
            return s_sync_generation != my_gen;
        };

        vTaskDelay(pdMS_TO_TICKS(500));
        if (!s_mqtt_connected.load() || is_superseded()) continue;

        // 1. Stream cached CAN frames with yields so outbox and IDLE0 never starve
        PsramVector<uint32_t> mon_snapshot;
        {
            std::lock_guard<std::mutex> lock(s_monitored_mutex);
            ensure_monitored_ids_seeded_locked();
            mon_snapshot.assign(s_monitored_ids.begin(), s_monitored_ids.end());
        }
        int count = 0;
        for (uint32_t can_id : mon_snapshot) {
            if (!s_mqtt_connected.load() || is_superseded()) break;
            uint8_t data[8] = {0};
            if (get_cached_can_frame(can_id, data)) {
                mqtt_mgr_publish_can_state(can_id, data, 8);
                if (++count % 8 == 0) {
                    vTaskDelay(pdMS_TO_TICKS(10));
                }
            }
        }
        if (!s_mqtt_connected.load() || is_superseded()) continue;

        // 1b. Publish active bus manifest (detected CAN IDs)
        mqtt_mgr_publish_active_ids(true);

        // 2. Publish automations state
        if (!s_mqtt_connected.load() || is_superseded()) continue;
        publish_automations_json_state();
        vTaskDelay(pdMS_TO_TICKS(500));

        // 3. Publish HA discovery if enabled (or clear once if explicitly disabled via settings)
        if (!s_mqtt_connected.load() || is_superseded()) continue;
        {
            bool disco_en = false;
            {
                std::lock_guard<std::mutex> lock(s_mqtt_mutex);
                disco_en = s_mqtt_cfg.ha_discovery_enabled;
            }
            if (disco_en) {
                s_need_clear_discovery.store(false);
                mqtt_mgr_publish_discovery();
            } else if (s_need_clear_discovery.exchange(false)) {
                mqtt_mgr_clear_discovery();
            }
        }

        // 4. If we subscribed to retained states during cold boot, unsubscribe after hydration window
        if (!g_state_restored_from_rtc.load() && !s_hydrated_from_mqtt.load() &&
            s_mqtt_connected.load() && !is_superseded()) {
            for (int i = 0; i < 50; ++i) {
                if (!s_mqtt_connected.load() || is_superseded()) break;
                vTaskDelay(pdMS_TO_TICKS(100));
            }
            if (s_mqtt_connected.load() && !is_superseded()) {
                std::string state_sub = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/state/+";
                bool unsubscribed = false;
                {
                    std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
                    if (global_mqtt_client) {
                        esp_mqtt_client_unsubscribe(global_mqtt_client, state_sub.c_str());
                        unsubscribed = true;
                    }
                }
                if (unsubscribed) {
                    s_hydrated_from_mqtt.store(true, std::memory_order_release);
                    ESP_LOGI(TAG, "Completed cold-boot state hydration from MQTT; unsubscribed from %s", state_sub.c_str());
                }
            }
        }
    }

    vTaskDelete(NULL);
}

static void trigger_post_connect_sync(void) {
    bool should_spawn = false;
    {
        std::lock_guard<std::mutex> lock(s_sync_mutex);
        s_sync_pending = true;
        ++s_sync_generation;
        if (!s_sync_task_running) {
            s_sync_task_running = true;
            should_spawn = true;
        }
    }
    if (should_spawn) {
        if (xTaskCreate(mqtt_post_connect_sync_task, "mqtt_sync", 6144, nullptr, 2, nullptr) != pdPASS) {
            ESP_LOGE(TAG, "Failed to create mqtt_sync task (free=%lu, internal=%lu)",
                     (unsigned long)esp_get_free_heap_size(),
                     (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            std::lock_guard<std::mutex> lock(s_sync_mutex);
            s_sync_task_running = false;
        }
    }
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    auto event = static_cast<esp_mqtt_event_handle_t>(event_data);
    switch (event->event_id) {
        case MQTT_EVENT_CONNECTED: {
            const char* broker_url = handler_args ? static_cast<const char*>(handler_args) : "";
            ESP_LOGI(TAG, "MQTT connected to broker (%s)", broker_url);

            // 1. Pack all 14 control topics into a SINGLE MQTT SUBSCRIBE packet (QoS 0)
            // Stored in flash rodata to avoid 14 stack std::string objects on esp_mqtt_task
            static constexpr esp_mqtt_topic_t kSubList[] = {
                { .filter = MQTT_BASE_TOPIC_LIT "/+/tx",                     .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/tx",                       .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/+/notify",                 .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/notify",                   .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/+/nav/set",                .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/nav/set",                  .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/+/subscribe_ids",          .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/subscribe_ids",            .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/+/config/automations/set", .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/config/automations/set",   .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/+/config/automations/get", .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/config/automations/get",   .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/+/set/#",                  .qos = 0 },
                { .filter = MQTT_BASE_TOPIC_LIT "/set/#",                    .qos = 0 },
                { .filter = "homeassistant/status",                          .qos = 0 },
            };

            bool ha_disco_en = false;
            {
                std::lock_guard<std::mutex> lock(s_mqtt_mutex);
                ha_disco_en = s_mqtt_cfg.ha_discovery_enabled;
            }

            const int sub_count = (int)(sizeof(kSubList) / sizeof(kSubList[0])) - (ha_disco_en ? 0 : 1);
            esp_mqtt_client_subscribe_multiple(event->client, kSubList, sub_count);

            // Cold-boot fallback: If RTC state cache was empty, subscribe to retained entity states once
            if (!g_state_restored_from_rtc.load() && !s_hydrated_from_mqtt.load(std::memory_order_acquire)) {
                char state_sub[64];
                int sub_len = snprintf(state_sub, sizeof(state_sub), "%s/%s/state/+", MQTT_BASE_TOPIC, DEVICE_ID.c_str());
                if (sub_len > 0 && sub_len < static_cast<int>(sizeof(state_sub))) {
                    esp_mqtt_client_subscribe(event->client, state_sub, 0);
                    ESP_LOGI(TAG, "Cold boot detected without RTC cache: Subscribed to retained states (%s)", state_sub);
                }
            }

            // 2. Mark connected after subscribe finishes and publish LWT online status
            rtc_crash_record_event("mqtt_connected");
            s_mqtt_connected.store(true, std::memory_order_relaxed);
            uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
            s_last_ha_birth_sync_ms.store(now_ms ? now_ms : 1, std::memory_order_relaxed);
            char status_topic[64];
            snprintf(status_topic, sizeof(status_topic), "%s/%s/status", MQTT_BASE_TOPIC, DEVICE_ID.c_str());
            mqtt_enqueue_nonblocking(status_topic, "online", 6, 0, 1);

            // 3. Defer state dump & HA discovery to background worker (queues fresh pass if already running)
            trigger_post_connect_sync();
            break;
        }

        case MQTT_EVENT_DISCONNECTED:
            s_mqtt_connected.store(false, std::memory_order_relaxed);
            abort_mqtt_automations_rx();
            abort_mqtt_reassembly_rx();
            ESP_LOGW(TAG, "MQTT disconnected from broker");
            break;

        case MQTT_EVENT_DATA: {
            if (event->data_len < 0 || event->total_data_len < 0 || event->current_data_offset < 0 ||
                event->topic_len < 0 || (event->topic_len > 0 && event->topic == nullptr) ||
                (event->data_len > 0 && event->data == nullptr)) {
                ESP_LOGW(TAG, "Invalid MQTT_EVENT_DATA bounds/pointers (offset=%d, len=%d, total=%d, topic_len=%d); aborting partial RX",
                         event->current_data_offset, event->data_len, event->total_data_len, event->topic_len);
                abort_mqtt_automations_rx();
                abort_mqtt_reassembly_rx();
                return;
            }

            auto extract_target_topic_suffix = [](const std::string& t, std::string& out_suffix) -> bool {
                const std::string base_prefix = std::string(MQTT_BASE_TOPIC) + "/";
                if (t.rfind(base_prefix, 0) != 0) return false;
                std::string rest = t.substr(base_prefix.length());

                const std::string dev_prefix = DEVICE_ID + "/";
                if (rest.rfind(dev_prefix, 0) == 0) {
                    out_suffix = rest.substr(dev_prefix.length());
                    return true;
                }
                if (rest.rfind("can-do/", 0) == 0) {
                    out_suffix = rest.substr(7);
                    return true;
                }
                if (rest == "tx" || rest == "notify" || rest == "nav/set" ||
                    rest == "subscribe_ids" || rest == "config/automations/set" ||
                    rest == "config/automations/get" || rest.rfind("set/", 0) == 0) {
                    out_suffix = rest;
                    return true;
                }
                return false;
            };

            const bool is_new_message = (event->current_data_offset == 0 && event->topic != nullptr && event->topic_len > 0);
            if (is_new_message) {
                std::string init_topic(event->topic, static_cast<size_t>(event->topic_len));
                std::string init_suffix;
                if (extract_target_topic_suffix(init_topic, init_suffix) && init_suffix == "config/automations/set") {
                    abort_mqtt_automations_rx();
                    abort_mqtt_reassembly_rx();
                    s_auto_rx.active = true;
                    s_auto_rx.write_failed = false;
                    s_auto_rx.msg_id = event->msg_id;
                    s_auto_rx.total_len = event->total_data_len;
                    s_auto_rx.received_len = 0;
                    if (event->total_data_len <= 0 ||
                        static_cast<size_t>(event->total_data_len) > kMaxMqttAutomationsBytes) {
                        ESP_LOGE(TAG, "Rejecting MQTT automations payload with invalid size (%d bytes)", event->total_data_len);
                        s_auto_rx.write_failed = true;
                    } else {
                        s_automations_tmp_file = fopen(MQTT_AUTOMATIONS_STAGE_FILE, "w");
                        if (!s_automations_tmp_file) {
                            ESP_LOGE(TAG, "Failed to open %s for writing", MQTT_AUTOMATIONS_STAGE_FILE);
                            s_auto_rx.write_failed = true;
                        }
                    }
                } else {
                    if (s_auto_rx.active) {
                        ESP_LOGW(TAG, "Aborting incomplete automations RX due to new message on %s", init_topic.c_str());
                        abort_mqtt_automations_rx();
                    }
                    if (s_rx_reassembly.active) {
                        ESP_LOGW(TAG, "Aborting incomplete MQTT reassembly on %s due to new message on %s",
                                 s_rx_reassembly.topic.c_str(), init_topic.c_str());
                        abort_mqtt_reassembly_rx();
                    }
                }
            }

            if (s_auto_rx.active) {
                if (event->data_len < 0 ||
                    event->current_data_offset != s_auto_rx.received_len ||
                    event->total_data_len != s_auto_rx.total_len ||
                    event->msg_id != s_auto_rx.msg_id ||
                    event->data_len > (s_auto_rx.total_len - s_auto_rx.received_len)) {
                    ESP_LOGW(TAG, "Aborting chunked automations RX on mismatch (msg_id=%d/%d, offset=%d/%d, total=%d/%d, len=%d)",
                             event->msg_id, s_auto_rx.msg_id,
                             event->current_data_offset, s_auto_rx.received_len,
                             event->total_data_len, s_auto_rx.total_len,
                             event->data_len);
                    abort_mqtt_automations_rx();
                    return;
                }

                if (!s_auto_rx.write_failed && s_automations_tmp_file && event->data_len > 0) {
                    if (!event->data) {
                        s_auto_rx.write_failed = true;
                    } else {
                        size_t written = fwrite(event->data, 1, static_cast<size_t>(event->data_len), s_automations_tmp_file);
                        if (written != static_cast<size_t>(event->data_len)) {
                            ESP_LOGE(TAG, "Short fwrite on %s (%zu / %d)", MQTT_AUTOMATIONS_STAGE_FILE, written, event->data_len);
                            s_auto_rx.write_failed = true;
                        }
                    }
                }

                s_auto_rx.received_len += event->data_len;
                bool is_final_chunk = (s_auto_rx.received_len >= s_auto_rx.total_len);
                if (is_final_chunk) {
                    bool had_file = (s_automations_tmp_file != nullptr);
                    bool flush_ok = true;
                    bool close_ok = true;
                    if (s_automations_tmp_file) {
                        flush_ok = (fflush(s_automations_tmp_file) == 0);
                        close_ok = (fclose(s_automations_tmp_file) == 0);
                        s_automations_tmp_file = nullptr;
                    }
                    bool write_ok = had_file && !s_auto_rx.write_failed && flush_ok && close_ok &&
                                    (s_auto_rx.received_len == s_auto_rx.total_len);
                    s_auto_rx = {};

                    if (write_ok) {
                        bool stage_ok = false;
                        {
                            std::lock_guard<std::mutex> file_lock(g_automations_file_mutex);
                            stage_ok = (rename(MQTT_AUTOMATIONS_STAGE_FILE, MQTT_AUTOMATIONS_PENDING_FILE) == 0);
                            if (stage_ok) {
                                s_auto_parse_tmp_pending.store(true, std::memory_order_release);
                            } else {
                                ESP_LOGE(TAG, "Failed to atomically stage %s -> %s", MQTT_AUTOMATIONS_STAGE_FILE, MQTT_AUTOMATIONS_PENDING_FILE);
                                unlink(MQTT_AUTOMATIONS_STAGE_FILE);
                            }
                        }
                        if (stage_ok) {
                            mqtt_mgr_on_automations_reloaded();
                        } else {
                            std::string status_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/config/automations/status";
                            static const char kErrMsg[] = "{\"status\":\"error\",\"message\":\"Failed staging automations\"}";
                            mqtt_enqueue_nonblocking(status_topic.c_str(), kErrMsg, (int)(sizeof(kErrMsg) - 1), 0, 0);
                        }
                    } else {
                        {
                            std::lock_guard<std::mutex> file_lock(g_automations_file_mutex);
                            unlink(MQTT_AUTOMATIONS_STAGE_FILE);
                        }
                        std::string status_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/config/automations/status";
                        static const char kErrMsg[] = "{\"status\":\"error\",\"message\":\"Failed writing automations\"}";
                        mqtt_enqueue_nonblocking(status_topic.c_str(), kErrMsg, (int)(sizeof(kErrMsg) - 1), 0, 0);
                    }
                }
                return;
            }

            struct MallocBufGuard {
                char* ptr = nullptr;
                ~MallocBufGuard() {
                    if (ptr) free(ptr);
                }
            };

            std::string topic;
            std::string single_payload;
            MallocBufGuard reassembled_buf;
            const char* payload_cstr = "";
            size_t payload_len = 0;

            if (is_new_message) {
                if (event->data_len > event->total_data_len) {
                    ESP_LOGW(TAG, "Dropping malformed MQTT frame (data_len=%d > total_data_len=%d)",
                             event->data_len, event->total_data_len);
                    return;
                }
                topic.assign(event->topic, static_cast<size_t>(event->topic_len));

                if (event->total_data_len > event->data_len) {
                    std::string init_suffix;
                    bool is_reassemblable = false;
                    if (extract_target_topic_suffix(topic, init_suffix)) {
                        is_reassemblable = (init_suffix == "tx" ||
                                            init_suffix == "subscribe_ids" ||
                                            init_suffix == "nav/set" ||
                                            init_suffix == "notify" ||
                                            init_suffix.rfind("set/", 0) == 0);
                    }
                    if (!is_reassemblable) {
                        ESP_LOGW(TAG, "Dropping fragmented payload on non-reassemblable topic %s (%d bytes)",
                                 topic.c_str(), event->total_data_len);
                        s_rx_reassembly.active = true;
                        s_rx_reassembly.dropping = true;
                        s_rx_reassembly.msg_id = event->msg_id;
                        s_rx_reassembly.total_len = event->total_data_len;
                        s_rx_reassembly.received_len = event->data_len;
                        s_rx_reassembly.topic = std::move(topic);
                        return;
                    }
                    if (static_cast<size_t>(event->total_data_len) > kMaxMqttReassemblyBytes) {
                        ESP_LOGW(TAG, "Dropping oversized MQTT payload on %s (%d bytes > %zu cap)",
                                 topic.c_str(), event->total_data_len, kMaxMqttReassemblyBytes);
                        s_rx_reassembly.active = true;
                        s_rx_reassembly.dropping = true;
                        s_rx_reassembly.msg_id = event->msg_id;
                        s_rx_reassembly.total_len = event->total_data_len;
                        s_rx_reassembly.received_len = event->data_len;
                        s_rx_reassembly.topic = std::move(topic);
                        return;
                    }

                    char* buf = alloc_mqtt_pub_buf(static_cast<size_t>(event->total_data_len) + 1);
                    if (!buf) {
                        ESP_LOGW(TAG, "Failed allocating %d-byte MQTT reassembly buffer for %s; dropping",
                                 event->total_data_len + 1, topic.c_str());
                        s_rx_reassembly.active = true;
                        s_rx_reassembly.dropping = true;
                        s_rx_reassembly.msg_id = event->msg_id;
                        s_rx_reassembly.total_len = event->total_data_len;
                        s_rx_reassembly.received_len = event->data_len;
                        s_rx_reassembly.topic = std::move(topic);
                        return;
                    }
                    if (event->data_len > 0) {
                        if (!event->data) {
                            free(buf);
                            return;
                        }
                        memcpy(buf, event->data, static_cast<size_t>(event->data_len));
                    }
                    s_rx_reassembly.active = true;
                    s_rx_reassembly.dropping = false;
                    s_rx_reassembly.msg_id = event->msg_id;
                    s_rx_reassembly.total_len = event->total_data_len;
                    s_rx_reassembly.received_len = event->data_len;
                    s_rx_reassembly.topic = std::move(topic);
                    s_rx_reassembly.buf = buf;
                    return;
                }

                if (event->data != nullptr && event->data_len > 0) {
                    single_payload.assign(event->data, static_cast<size_t>(event->data_len));
                }
                payload_cstr = single_payload.c_str();
                payload_len = single_payload.size();
            } else if (s_rx_reassembly.active) {
                if (event->data_len < 0 ||
                    event->current_data_offset != s_rx_reassembly.received_len ||
                    event->total_data_len != s_rx_reassembly.total_len ||
                    event->msg_id != s_rx_reassembly.msg_id ||
                    event->data_len > (s_rx_reassembly.total_len - s_rx_reassembly.received_len)) {
                    ESP_LOGW(TAG, "Aborting MQTT reassembly on %s due to chunk mismatch (msg_id=%d/%d, offset=%d/%d, total=%d/%d, len=%d)",
                             s_rx_reassembly.topic.c_str(),
                             event->msg_id, s_rx_reassembly.msg_id,
                             event->current_data_offset, s_rx_reassembly.received_len,
                             event->total_data_len, s_rx_reassembly.total_len,
                             event->data_len);
                    abort_mqtt_reassembly_rx();
                    return;
                }

                if (!s_rx_reassembly.dropping && s_rx_reassembly.buf && event->data_len > 0) {
                    if (!event->data) {
                        abort_mqtt_reassembly_rx();
                        return;
                    }
                    memcpy(s_rx_reassembly.buf + s_rx_reassembly.received_len, event->data, static_cast<size_t>(event->data_len));
                }
                s_rx_reassembly.received_len += event->data_len;
                if (s_rx_reassembly.received_len < s_rx_reassembly.total_len) {
                    return;
                }

                if (s_rx_reassembly.dropping || !s_rx_reassembly.buf) {
                    abort_mqtt_reassembly_rx();
                    return;
                }

                topic = std::move(s_rx_reassembly.topic);
                reassembled_buf.ptr = s_rx_reassembly.buf;
                payload_len = static_cast<size_t>(s_rx_reassembly.total_len);
                reassembled_buf.ptr[payload_len] = '\0';
                payload_cstr = reassembled_buf.ptr;
                s_rx_reassembly.buf = nullptr;
                abort_mqtt_reassembly_rx();
            } else {
                return;
            }

            if (topic == "homeassistant/status") {
                if (payload_len == 6 && memcmp(payload_cstr, "online", 6) == 0) {
                    bool disco_en = false;
                    {
                        std::lock_guard<std::mutex> lock(s_mqtt_mutex);
                        disco_en = s_mqtt_cfg.ha_discovery_enabled;
                    }
                    if (disco_en) {
                        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
                        uint32_t last_ms = s_last_ha_birth_sync_ms.load(std::memory_order_relaxed);
                        if (last_ms == 0 || (now_ms - last_ms >= 5000)) {
                            s_last_ha_birth_sync_ms.store(now_ms ? now_ms : 1, std::memory_order_relaxed);
                            ESP_LOGI(TAG, "HA birth message received (homeassistant/status=online); triggering discovery/state refresh");
                            std::string status_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/status";
                            mqtt_enqueue_nonblocking(status_topic.c_str(), "online", 6, 0, 1);
                            trigger_post_connect_sync();
                        }
                    }
                }
                return;
            }

            std::string state_prefix = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/state/";
            if (topic.rfind(state_prefix, 0) == 0 && topic.length() > state_prefix.length()) {
                std::string entity_id = topic.substr(state_prefix.length());
                if (entity_id.rfind("0x", 0) != 0 && entity_id.rfind("0X", 0) != 0) {
                    can_engine_hydrate_from_mqtt(
                        entity_id,
                        (payload_cstr != nullptr && payload_len > 0) ? std::string(payload_cstr, payload_len) : std::string());
                }
                return;
            }

            std::string suffix;
            if (!extract_target_topic_suffix(topic, suffix)) {
                return;
            }

            if (suffix == "config/automations/get") {
                mqtt_mgr_on_automations_reloaded();
                return;
            }

            bool is_notify = (suffix == "notify");
            bool is_nav_set = (suffix == "nav/set");
            bool is_tx = (suffix == "tx");
            bool is_sub_ids = (suffix == "subscribe_ids");
            bool is_set_cmd = (suffix.rfind("set/", 0) == 0);

            if (is_notify) {
                std::string msg = (payload_cstr != nullptr && payload_len > 0) ? std::string(payload_cstr, payload_len) : std::string();
                std::string level = "info";

                cJSON* root = (payload_cstr != nullptr && payload_len > 0) ? cJSON_ParseWithLength(payload_cstr, payload_len) : nullptr;
                if (root) {
                    if (cJSON_IsObject(root)) {
                        msg.clear();
                        cJSON* m = cJSON_GetObjectItem(root, "message");
                        if (!cJSON_IsString(m)) m = cJSON_GetObjectItem(root, "text");
                        if (!cJSON_IsString(m)) m = cJSON_GetObjectItem(root, "popup_message");
                        if (cJSON_IsString(m) && m->valuestring) msg = m->valuestring;

                        cJSON* l = cJSON_GetObjectItem(root, "level");
                        if (cJSON_IsString(l) && l->valuestring) level = l->valuestring;
                    }
                    cJSON_Delete(root);
                }

                if (msg.empty()) {
                    return;
                }

                if (level == "warning") {
                    track_popup_show_warning(msg.c_str());
                } else if (level == "error" || level == "critical") {
                    track_popup_show_error(msg.c_str());
                } else {
                    track_popup_show_info(msg.c_str());
                }
            } else if (is_nav_set) {
                cJSON* root = (payload_cstr != nullptr && payload_len > 0) ? cJSON_ParseWithLength(payload_cstr, payload_len) : nullptr;
                if (root) {
                    cJSON* act = cJSON_GetObjectItem(root, "action");
                    if (act && cJSON_IsString(act) && strcmp(act->valuestring, "clear") == 0) {
                        hud_nav_clear();
                    } else {
                        hud_nav_instruction_t instr{};
                        instr.distance_meters = 0xFFFF; // Inactive default
                        auto clamp_u16 = [](const cJSON* item, uint16_t max_val, uint16_t fallback) -> uint16_t {
                            if (!item || !cJSON_IsNumber(item) || !std::isfinite(item->valuedouble)) return fallback;
                            double v = item->valuedouble;
                            if (v < 0.0) return 0;
                            if (v > static_cast<double>(max_val)) return max_val;
                            return static_cast<uint16_t>(v);
                        };

                        cJSON* icon_item = cJSON_GetObjectItem(root, "icon");
                        if (icon_item && cJSON_IsNumber(icon_item) && std::isfinite(icon_item->valuedouble)) {
                            instr.icon = static_cast<hud_maneuver_icon_t>(clamp_u16(icon_item, 255, HUD_MANEUVER_STRAIGHT));
                        } else {
                            instr.icon = HUD_MANEUVER_STRAIGHT;
                        }

                        cJSON* dir_item = cJSON_GetObjectItem(root, "direction");
                        if (!dir_item) dir_item = cJSON_GetObjectItem(root, "direction_deg");
                        if (!dir_item) dir_item = cJSON_GetObjectItem(root, "heading");
                        if (dir_item && cJSON_IsNumber(dir_item) && std::isfinite(dir_item->valuedouble)) {
                            instr.direction_deg = clamp_u16(dir_item, 65535, 0);
                        }

                        cJSON* dist_item = cJSON_GetObjectItem(root, "distance");
                        if (!dist_item) dist_item = cJSON_GetObjectItem(root, "distance_meters");
                        if (dist_item && cJSON_IsNumber(dist_item) && std::isfinite(dist_item->valuedouble)) {
                            instr.distance_meters = clamp_u16(dist_item, 65535, 0xFFFF);
                        }

                        cJSON* bars_item = cJSON_GetObjectItem(root, "bars");
                        if (bars_item && cJSON_IsNumber(bars_item) && std::isfinite(bars_item->valuedouble)) {
                            instr.bar_graph = static_cast<uint8_t>(clamp_u16(bars_item, 255, 0));
                        }

                        cJSON* spd_item = cJSON_GetObjectItem(root, "speed_limit");
                        if (spd_item && cJSON_IsNumber(spd_item) && std::isfinite(spd_item->valuedouble)) {
                            instr.speed_limit_kph = static_cast<uint8_t>(clamp_u16(spd_item, 255, 0));
                        }

                        cJSON* cam_item = cJSON_GetObjectItem(root, "camera_alert");
                        if (cam_item && cJSON_IsBool(cam_item)) instr.speed_camera_alert = cJSON_IsTrue(cam_item);

                        cJSON* street_item = cJSON_GetObjectItem(root, "street");
                        if (street_item && cJSON_IsString(street_item)) instr.street_name = street_item->valuestring;

                        cJSON* lanes_item = cJSON_GetObjectItem(root, "lanes");
                        if (!lanes_item) lanes_item = cJSON_GetObjectItem(root, "num_lanes");
                        if (lanes_item && cJSON_IsNumber(lanes_item) && std::isfinite(lanes_item->valuedouble)) {
                            double raw_lanes = lanes_item->valuedouble;
                            int lanes_val = (raw_lanes < 0.0) ? 0 : (raw_lanes > 8.0 ? 8 : static_cast<int>(raw_lanes));
                            instr.num_lanes = static_cast<uint8_t>(lanes_val);
                        }

                        cJSON* lane_dirs = cJSON_GetObjectItem(root, "lane_directions");
                        if (lane_dirs && cJSON_IsArray(lane_dirs)) {
                            int n = cJSON_GetArraySize(lane_dirs);
                            if (instr.num_lanes == 0 && n > 0) {
                                instr.num_lanes = static_cast<uint8_t>(std::min(n, 8));
                            }
                            for (int i = 0; i < n && i < 8; i++) {
                                cJSON* elem = cJSON_GetArrayItem(lane_dirs, i);
                                if (elem && cJSON_IsNumber(elem) && std::isfinite(elem->valuedouble)) {
                                    instr.lane_directions[i] = static_cast<uint8_t>(clamp_u16(elem, 255, 0));
                                }
                            }
                        }

                        cJSON* lane_recs = cJSON_GetObjectItem(root, "lane_recommended");
                        if (!lane_recs) lane_recs = cJSON_GetObjectItem(root, "lane_highlights");
                        if (lane_recs && cJSON_IsArray(lane_recs)) {
                            int n = cJSON_GetArraySize(lane_recs);
                            if (instr.num_lanes == 0 && n > 0) {
                                instr.num_lanes = static_cast<uint8_t>(std::min(n, 8));
                            }
                            for (int i = 0; i < n && i < 8; i++) {
                                cJSON* elem = cJSON_GetArrayItem(lane_recs, i);
                                if (elem) {
                                    if (cJSON_IsBool(elem)) {
                                        instr.lane_recommended[i] = cJSON_IsTrue(elem) ? 1 : 0;
                                    } else if (cJSON_IsNumber(elem) && std::isfinite(elem->valuedouble)) {
                                        instr.lane_recommended[i] = static_cast<uint8_t>(clamp_u16(elem, 255, 0));
                                    }
                                }
                            }
                        }

                        instr.has_lane_guidance = (instr.num_lanes > 0);

                        cJSON* plat_item = cJSON_GetObjectItem(root, "platform");
                        if (plat_item && cJSON_IsString(plat_item)) {
                            if (strcmp(plat_item->valuestring, "gen2") == 0 || strcmp(plat_item->valuestring, "ccan") == 0) {
                                hud_nav_set_platform(HUD_PLATFORM_GEN2_CCAN);
                            } else if (strcmp(plat_item->valuestring, "egmp") == 0 || strcmp(plat_item->valuestring, "canfd") == 0) {
                                hud_nav_set_platform(HUD_PLATFORM_EGMP_CANFD);
                            }
                        }

                        hud_nav_update(&instr);
                    }
                    cJSON_Delete(root);
                }
            } else if (is_tx) {
                cJSON* root = (payload_cstr != nullptr && payload_len > 0) ? cJSON_ParseWithLength(payload_cstr, payload_len) : nullptr;
                if (root) {
                    bool handled = false;
                    cJSON* target_entity = cJSON_GetObjectItem(root, "entity");
                    cJSON* target_cmd = cJSON_GetObjectItem(root, "command");
                    if (cJSON_IsString(target_entity) && target_entity->valuestring && target_entity->valuestring[0] != '\0') {
                        std::string cmd_str = (cJSON_IsString(target_cmd) && target_cmd->valuestring) ? target_cmd->valuestring : "";
                        cJSON* mode_item = cJSON_GetObjectItem(root, "mode");
                        cJSON* action_item = cJSON_GetObjectItem(root, "action");
                        const bool has_mode = cJSON_IsString(mode_item) && mode_item->valuestring && mode_item->valuestring[0] != '\0';
                        const bool has_action = cJSON_IsString(action_item) && action_item->valuestring && action_item->valuestring[0] != '\0';
                        const bool is_precon_entity =
                            (strcmp(target_entity->valuestring, "battery_preconditioning") == 0 ||
                             strcmp(target_entity->valuestring, "precondition") == 0);
                        if ((has_mode || has_action) && (is_precon_entity || cmd_str.empty()) &&
                            (cmd_str.empty() || cmd_str[0] != '{')) {
                            cJSON* fwd = cJSON_CreateObject();
                            if (fwd) {
                                if (has_mode) cJSON_AddStringToObject(fwd, "mode", mode_item->valuestring);
                                if (has_action) cJSON_AddStringToObject(fwd, "action", action_item->valuestring);
                                char* fwd_str = cJSON_PrintUnformatted(fwd);
                                cJSON_Delete(fwd);
                                if (fwd_str) {
                                    cmd_str = fwd_str;
                                    free(fwd_str);
                                }
                            }
                        }
                        mqtt_enqueue_entity_cmd(target_entity->valuestring, cmd_str.c_str(), "/tx");
                        handled = true;
                    }

                    if (!handled) {
                        uint32_t can_id = 0;
                        cJSON* id_item = cJSON_GetObjectItem(root, "can_id");
                        if (id_item && !cJSON_IsNull(id_item) && !parse_valid_can_id(id_item, can_id)) {
                            ESP_LOGW(TAG, "Ignoring invalid can_id in MQTT /tx payload");
                            can_id = 0;
                        }

                        uint8_t top_bus = 0;
                        cJSON* bus_item = cJSON_GetObjectItem(root, "bus");
                        if (bus_item && cJSON_IsNumber(bus_item) && std::isfinite(bus_item->valuedouble)) {
                            double bv = bus_item->valuedouble;
                            top_bus = (bv <= 0.0) ? 0 : (bv >= 1.0 ? 1 : static_cast<uint8_t>(bv));
                        } else if (bus_item && cJSON_IsString(bus_item) && bus_item->valuestring) {
                            const char* p = bus_item->valuestring;
                            while (*p && isspace(static_cast<unsigned char>(*p))) ++p;
                            if (*p != '\0' && *p != '-' && *p != '+') {
                                errno = 0;
                                char* endptr = nullptr;
                                unsigned long bv = strtoul(p, &endptr, 0);
                                if (endptr != p && errno != ERANGE) {
                                    top_bus = (bv >= 1UL) ? 1 : 0;
                                }
                            }
                        }

                        uint32_t delay_ms = 20;
                        cJSON* del_item = cJSON_GetObjectItem(root, "delay_ms");
                        if (del_item && cJSON_IsNumber(del_item) && std::isfinite(del_item->valuedouble)) {
                            double dv = del_item->valuedouble;
                            if (dv < 0.0) {
                                delay_ms = 0;
                            } else if (dv > static_cast<double>(kMaxDelayMs)) {
                                delay_ms = kMaxDelayMs;
                            } else {
                                delay_ms = static_cast<uint32_t>(dv);
                            }
                        }

                        PsramVector<ActionStep> steps;
                        cJSON* steps_arr = cJSON_GetObjectItem(root, "steps");
                        if (steps_arr && cJSON_IsArray(steps_arr) && cJSON_GetArraySize(steps_arr) > 0) {
                            steps.reserve(static_cast<size_t>(cJSON_GetArraySize(steps_arr)));
                            cJSON* s_item = nullptr;
                            cJSON_ArrayForEach(s_item, steps_arr) {
                                steps.emplace_back();
                                ActionStep& step = steps.back();
                                if (parse_action_step(s_item, step)) {
                                    if (step.type == ActionType::TRANSMIT_FRAME) {
                                        if (step.can_id == 0) step.can_id = can_id;
                                        if (!cJSON_GetObjectItem(s_item, "bus")) step.bus = top_bus;
                                        if (step.repeat == 0) step.repeat = 1;
                                    }
                                    if (step.type == ActionType::TRANSMIT_FRAME && step.can_id == 0) {
                                        steps.pop_back();
                                    }
                                } else {
                                    steps.pop_back();
                                }
                            }
                        } else if (can_id != 0 && cJSON_GetObjectItem(root, "payload")) {
                            cJSON* type_item = cJSON_GetObjectItem(root, "type");
                            const bool is_transmit_type =
                                (!type_item || cJSON_IsNull(type_item) ||
                                 (cJSON_IsString(type_item) && type_item->valuestring &&
                                  (type_item->valuestring[0] == '\0' ||
                                   strcmp(type_item->valuestring, "transmit") == 0 ||
                                   strcmp(type_item->valuestring, "transmit_frame") == 0 ||
                                   strcmp(type_item->valuestring, "can_tx") == 0)));
                            if (is_transmit_type) {
                                steps.emplace_back();
                                ActionStep& step = steps.back();
                                if (parse_action_step(root, step)) {
                                    step.type = ActionType::TRANSMIT_FRAME;
                                    step.can_id = can_id;
                                    step.bus = top_bus;
                                    if (step.repeat == 0) step.repeat = 1;
                                } else {
                                    steps.pop_back();
                                }
                            }
                        }

                        uint32_t burst_cid = can_id;
                        if (burst_cid == 0) {
                            for (const auto& st : steps) {
                                if (st.type == ActionType::TRANSMIT_FRAME && st.can_id != 0) {
                                    burst_cid = st.can_id;
                                    break;
                                }
                            }
                        }
                        if (!steps.empty()) {
                            queue_action_steps(burst_cid, delay_ms, steps);
                        }
                    }
                    cJSON_Delete(root);
                }
            } else if (is_sub_ids) {
                cJSON* root = (payload_cstr != nullptr && payload_len > 0) ? cJSON_ParseWithLength(payload_cstr, payload_len) : nullptr;
                if (root && cJSON_IsArray(root)) {
                    std::vector<uint32_t> ids;
                    int count = cJSON_GetArraySize(root);
                    for (int i = 0; i < count; i++) {
                        cJSON* itm = cJSON_GetArrayItem(root, i);
                        uint32_t parsed_id = 0;
                        if (parse_valid_can_id(itm, parsed_id)) {
                            ids.push_back(parsed_id);
                        } else {
                            ESP_LOGW(TAG, "Ignoring invalid CAN ID at index %d in subscribe_ids", i);
                        }
                    }
                    mqtt_mgr_set_monitored_ids(ids, true);
                    ESP_LOGI(TAG, "Updated monitored CAN IDs (%d IDs)", (int)ids.size());
                }
                if (root) cJSON_Delete(root);
            } else if (is_set_cmd) {
                std::string entity_id = suffix.substr(4);
                if (payload_len >= sizeof(MqttSetCmd::payload)) {
                    ESP_LOGW(TAG, "Rejecting oversized MQTT /set payload for '%s' (%zu bytes > %zu max)",
                             entity_id.c_str(), payload_len, sizeof(MqttSetCmd::payload) - 1);
                    return;
                }
                mqtt_enqueue_entity_cmd(entity_id.c_str(), payload_cstr ? payload_cstr : "", "/set");
            }
            break;
        }
        case MQTT_EVENT_ERROR: {
            if (event->error_handle) {
                const auto* err = event->error_handle;
                ESP_LOGW(TAG, "MQTT error: type=%d sock_errno=%d connect_rc=%d tls_err=0x%x",
                         (int)err->error_type,
                         err->esp_transport_sock_errno,
                         (int)err->connect_return_code,
                         (unsigned)err->esp_tls_last_esp_err);
                if (err->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT ||
                    err->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
                    s_mqtt_connected.store(false, std::memory_order_relaxed);
                    abort_mqtt_automations_rx();
                    abort_mqtt_reassembly_rx();
                }
            } else {
                ESP_LOGW(TAG, "MQTT error event with null error_handle");
            }
            break;
        }
        default:
            break;
    }
}

static bool s_mqtt_initialized = false;

static void load_settings_from_fs_locked(void) {
#if defined(CONFIG_CAN_DO_MQTT_BROKER_URL)
    s_mqtt_cfg.broker_url = CONFIG_CAN_DO_MQTT_BROKER_URL;
#else
    s_mqtt_cfg.broker_url = "mqtt://homeassistant.local:1883";
#endif
#if defined(CONFIG_CAN_DO_MQTT_USERNAME)
    s_mqtt_cfg.username = CONFIG_CAN_DO_MQTT_USERNAME;
#endif
#if defined(CONFIG_CAN_DO_MQTT_PASSWORD)
    s_mqtt_cfg.password = CONFIG_CAN_DO_MQTT_PASSWORD;
#endif
    s_mqtt_cfg.enabled = true;

    FILE* f = fopen(MQTT_CONFIG_FILE, "r");
    if (!f) {
        s_mqtt_initialized = true;
        return;
    }

    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (len <= 0 || static_cast<size_t>(len) > kMaxMqttConfigFileBytes) {
        if (len > static_cast<long>(kMaxMqttConfigFileBytes)) {
            ESP_LOGW(TAG, "Ignoring oversized %s (%ld > %zu bytes)", MQTT_CONFIG_FILE, len, kMaxMqttConfigFileBytes);
        }
        fclose(f);
        s_mqtt_initialized = true;
        return;
    }

    char* content = alloc_mqtt_pub_buf(static_cast<size_t>(len) + 1);
    if (!content) {
        ESP_LOGE(TAG, "Failed to allocate %ld bytes for %s", len + 1, MQTT_CONFIG_FILE);
        fclose(f);
        s_mqtt_initialized = true;
        return;
    }
    size_t nread = fread(content, 1, static_cast<size_t>(len), f);
    fclose(f);
    content[nread] = '\0';

    cJSON* root = cJSON_ParseWithLength(content, nread);
    free(content);
    if (!root) {
        s_mqtt_initialized = true;
        return;
    }

    cJSON* enabled_item = cJSON_GetObjectItem(root, "enabled");
    if (cJSON_IsBool(enabled_item)) s_mqtt_cfg.enabled = cJSON_IsTrue(enabled_item);

    cJSON* disco_item = cJSON_GetObjectItem(root, "ha_discovery");
    s_mqtt_cfg.ha_discovery_enabled = cJSON_IsBool(disco_item) ? cJSON_IsTrue(disco_item) : false;

    cJSON* url_item = cJSON_GetObjectItem(root, "broker_url");
    if (cJSON_IsString(url_item) && strlen(url_item->valuestring) > 0) s_mqtt_cfg.broker_url = url_item->valuestring;

    cJSON* user_item = cJSON_GetObjectItem(root, "username");
    if (cJSON_IsString(user_item)) s_mqtt_cfg.username = user_item->valuestring;

    cJSON* pass_item = cJSON_GetObjectItem(root, "password");
    if (cJSON_IsString(pass_item)) s_mqtt_cfg.password = pass_item->valuestring;

    cJSON_Delete(root);
    s_mqtt_initialized = true;
}

static void load_settings_from_fs(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);
    load_settings_from_fs_locked();
}

void mqtt_mgr_init(void) {
    load_settings_from_fs();
    load_monitored_ids_from_fs();
    if (!s_mqtt_pub_queue) {
        s_mqtt_pub_queue_storage = (uint8_t*)alloc_mqtt_pub_buf(MQTT_PUB_QUEUE_LEN * sizeof(MqttPubItem));
        if (s_mqtt_pub_queue_storage) {
            s_mqtt_pub_queue = xQueueCreateStatic(MQTT_PUB_QUEUE_LEN, sizeof(MqttPubItem), s_mqtt_pub_queue_storage, &s_mqtt_pub_queue_struct);
        } else {
            s_mqtt_pub_queue = xQueueCreate(16, sizeof(MqttPubItem));
        }
        if (s_mqtt_pub_queue) {
            BaseType_t pub_task_ok = pdFAIL;
#if CONFIG_SPIRAM
            pub_task_ok = xTaskCreateWithCaps(mqtt_pub_worker_task, "mqtt_pub", 4096, nullptr, 3, nullptr, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (pub_task_ok != pdPASS) {
                pub_task_ok = xTaskCreate(mqtt_pub_worker_task, "mqtt_pub", 3072, nullptr, 3, nullptr);
            }
#else
            pub_task_ok = xTaskCreate(mqtt_pub_worker_task, "mqtt_pub", 3072, nullptr, 3, nullptr);
#endif
            if (pub_task_ok != pdPASS) {
                ESP_LOGE(TAG, "Failed to create mqtt_pub task (free=%lu, internal=%lu)",
                         (unsigned long)esp_get_free_heap_size(),
                         (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            }
        }
    }
    if (!s_mqtt_cmd_queue) {
        s_mqtt_cmd_queue_storage = (uint8_t*)alloc_mqtt_pub_buf(16 * sizeof(MqttSetCmd));
        if (s_mqtt_cmd_queue_storage) {
            s_mqtt_cmd_queue = xQueueCreateStatic(16, sizeof(MqttSetCmd), s_mqtt_cmd_queue_storage, &s_mqtt_cmd_queue_struct);
        } else {
            s_mqtt_cmd_queue = xQueueCreate(16, sizeof(MqttSetCmd));
        }
        if (s_mqtt_cmd_queue) {
            if (xTaskCreate(mqtt_cmd_worker_task, "mqtt_cmd", 4096, nullptr, 4, nullptr) != pdPASS) {
                ESP_LOGE(TAG, "Failed to create mqtt_cmd task (free=%lu, internal=%lu)",
                         (unsigned long)esp_get_free_heap_size(),
                         (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            }
        }
    }
}

static void mqtt_mgr_start(void) {
    esp_mqtt_client_handle_t failed_client = nullptr;
    char* failed_broker_url = nullptr;
    {
        std::lock_guard<std::mutex> lock(s_mqtt_mutex);
        if (!s_mqtt_initialized) {
            load_settings_from_fs_locked();
        }
        if (!s_mqtt_cfg.enabled || s_mqtt_cfg.broker_url.empty()) return;

        {
            std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
            if (global_mqtt_client) {
                esp_mqtt_client_reconnect(global_mqtt_client);
                return;
            }
        }

        esp_mqtt_client_config_t mqtt_cfg = {};
        mqtt_cfg.broker.address.uri = s_mqtt_cfg.broker_url.c_str();
        mqtt_cfg.credentials.client_id = DEVICE_ID.c_str();
        if (!s_mqtt_cfg.username.empty()) {
            mqtt_cfg.credentials.username = s_mqtt_cfg.username.c_str();
        }
        if (!s_mqtt_cfg.password.empty()) {
            mqtt_cfg.credentials.authentication.password = s_mqtt_cfg.password.c_str();
        }

        s_lwt_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/status";
        mqtt_cfg.session.last_will.topic = s_lwt_topic.c_str();
        mqtt_cfg.session.last_will.msg = "offline";
        mqtt_cfg.session.last_will.msg_len = 7;
        mqtt_cfg.session.last_will.qos = 0; // QoS 0 avoids broker session state buildup on network drops
        mqtt_cfg.session.last_will.retain = 1;

        // Hardened timeouts & bounded outbox for ws:// & cellular roaming (timeout < 3s TWDT)
        mqtt_cfg.session.keepalive = 30;
        mqtt_cfg.network.reconnect_timeout_ms = 5000;
        mqtt_cfg.network.timeout_ms = 2000;
        mqtt_cfg.buffer.size = 2048;
        mqtt_cfg.buffer.out_size = kMqttOutBufSize;
        mqtt_cfg.outbox.limit = kMqttOutboxLimit;
        mqtt_cfg.task.stack_size = 6144;

        esp_mqtt_client_handle_t client = esp_mqtt_client_init(&mqtt_cfg);
        if (!client) {
            ESP_LOGE(TAG, "esp_mqtt_client_init failed (free=%lu, internal=%lu)",
                     (unsigned long)esp_get_free_heap_size(),
                     (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            return;
        }

        size_t url_len = s_mqtt_cfg.broker_url.size();
        char* broker_url_copy = static_cast<char*>(malloc(url_len + 1));
        if (broker_url_copy) {
            memcpy(broker_url_copy, s_mqtt_cfg.broker_url.c_str(), url_len + 1);
        }

        esp_err_t err = esp_mqtt_client_register_event(client, MQTT_EVENT_ANY, mqtt_event_handler, broker_url_copy);
        if (err == ESP_OK) {
            {
                std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
                global_mqtt_client = client;
                s_active_broker_url = broker_url_copy;
            }
            err = esp_mqtt_client_start(client);
            if (err != ESP_OK) {
                std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
                if (global_mqtt_client == client) {
                    global_mqtt_client = nullptr;
                    s_active_broker_url = nullptr;
                }
            }
        }
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "MQTT client start failed (%s; free=%lu, internal=%lu)",
                     esp_err_to_name(err),
                     (unsigned long)esp_get_free_heap_size(),
                     (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            failed_client = client;
            failed_broker_url = broker_url_copy;
        }
    }
    if (failed_client) {
        esp_mqtt_client_destroy(failed_client);
    }
    if (failed_broker_url) {
        free(failed_broker_url);
    }
}

static void mqtt_mgr_stop(void) {
    esp_mqtt_client_handle_t client = nullptr;
    char* broker_url_copy = nullptr;
    bool was_connected = false;
    std::string lwt_topic;
    {
        std::lock_guard<std::mutex> lock(s_mqtt_mutex);
        std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
        if (global_mqtt_client) {
            was_connected = s_mqtt_connected.exchange(false, std::memory_order_acq_rel);
            lwt_topic = s_lwt_topic;
            client = global_mqtt_client;
            global_mqtt_client = nullptr;
            broker_url_copy = s_active_broker_url;
            s_active_broker_url = nullptr;
            if (s_mqtt_pub_queue) {
                MqttPubItem item;
                while (xQueueReceive(s_mqtt_pub_queue, &item, 0) == pdTRUE) {
                    if (item.heap_data) {
                        free(item.heap_data);
                    }
                }
            }
        }
    }
    if (client) {
        if (was_connected && !lwt_topic.empty()) {
            esp_mqtt_client_publish(client, lwt_topic.c_str(), "offline", 7, 0, 1);
            vTaskDelay(pdMS_TO_TICKS(50));
        }
        esp_mqtt_client_stop(client);
        esp_mqtt_client_destroy(client);
        abort_mqtt_automations_rx();
        abort_mqtt_reassembly_rx();
    }
    if (broker_url_copy) {
        free(broker_url_copy);
    }
}

void mqtt_mgr_on_wifi_disconnect(void) {
    s_mqtt_connected.store(false, std::memory_order_relaxed);
}

void mqtt_mgr_on_wifi_connect(void) {
    bool need_start = false;
    {
        std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
        if (!global_mqtt_client) {
            need_start = true;
        } else if (!s_mqtt_connected.load(std::memory_order_relaxed)) {
            esp_mqtt_client_reconnect(global_mqtt_client);
        }
    }
    if (need_start) {
        mqtt_mgr_start();
    }
}

void mqtt_mgr_watchdog(void) {
    bool has_client = false;
    {
        std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
        has_client = (global_mqtt_client != nullptr);
    }
    if (!has_client) {
        mqtt_mgr_start();
    } else {
        mqtt_mgr_publish_active_ids(false);
    }
}

bool mqtt_mgr_is_connected(void) {
    return s_mqtt_connected.load();
}

MqttConfig mqtt_mgr_get_config(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);
    return s_mqtt_cfg;
}

bool mqtt_mgr_save_config(const MqttConfig& cfg) {
    bool persisted = false;
    {
        std::lock_guard<std::mutex> lock(s_mqtt_mutex);
        cJSON* root = cJSON_CreateObject();
        if (!root) {
            ESP_LOGE(TAG, "Failed to allocate JSON object for %s", MQTT_CONFIG_FILE);
            return false;
        }
        if (!cJSON_AddBoolToObject(root, "enabled", cfg.enabled) ||
            !cJSON_AddBoolToObject(root, "ha_discovery", cfg.ha_discovery_enabled) ||
            !cJSON_AddStringToObject(root, "broker_url", cfg.broker_url.c_str()) ||
            !cJSON_AddStringToObject(root, "username", cfg.username.c_str()) ||
            !cJSON_AddStringToObject(root, "password", cfg.password.c_str())) {
            cJSON_Delete(root);
            ESP_LOGE(TAG, "Failed to populate JSON object for %s", MQTT_CONFIG_FILE);
            return false;
        }

        char* rendered = cJSON_Print(root);
        cJSON_Delete(root);
        if (!rendered) {
            ESP_LOGE(TAG, "Failed to serialize %s", MQTT_CONFIG_FILE);
            return false;
        }

        persisted = atomic_write_text_file(MQTT_CONFIG_FILE, MQTT_CONFIG_TMP_FILE, rendered, strlen(rendered));
        free(rendered);
        if (!persisted) {
            return false;
        }

        if (s_mqtt_cfg.ha_discovery_enabled && !cfg.ha_discovery_enabled) {
            s_need_clear_discovery.store(true);
        }
        s_mqtt_cfg = cfg;
        s_mqtt_initialized = true;
    }

    mqtt_mgr_stop();
    if (cfg.enabled) {
        mqtt_mgr_start();
    }
    return persisted;
}

static PsramVector<AutomationRule> snapshot_automations_for_mqtt(void) {
    std::lock_guard<std::mutex> lock(g_automations_mutex);
    return global_automations;
}

static void refresh_automation_discovery_locked_check(void) {
    bool disco_en = false;
    PsramUnorderedSet<std::string> prev_exposed;
    {
        std::lock_guard<std::mutex> lock(s_mqtt_mutex);
        disco_en = s_mqtt_cfg.ha_discovery_enabled;
        prev_exposed = s_exposed_auto_ids;
    }
    if (!disco_en) return;

    PsramVector<AutomationRule> rules_snapshot = snapshot_automations_for_mqtt();
    PsramUnorderedSet<std::string> new_exposed;
    for (const auto& rule : rules_snapshot) {
        if (rule.ha_expose && !rule.id.empty()) {
            new_exposed.insert(rule.id);
        }
    }

    for (const auto& old_id : prev_exposed) {
        if (!global_mqtt_client || !s_mqtt_connected.load()) break;
        if (new_exposed.find(old_id) == new_exposed.end()) {
            clear_ha_automation_topic(global_mqtt_client, old_id);
            vTaskDelay(pdMS_TO_TICKS(15));
        }
    }

    for (const auto& rule : rules_snapshot) {
        if (!global_mqtt_client || !s_mqtt_connected.load()) break;
        if (rule.ha_expose && !rule.id.empty()) {
            publish_ha_automation_discovery(global_mqtt_client, rule);
            vTaskDelay(pdMS_TO_TICKS(25));
        }
    }

    {
        std::lock_guard<std::mutex> lock(s_mqtt_mutex);
        s_exposed_auto_ids.swap(new_exposed);
    }
}

static bool validate_automations_json_file(const char* filepath) {
    struct stat st;
    if (!filepath || stat(filepath, &st) != 0 || st.st_size <= 0 ||
        static_cast<size_t>(st.st_size) > kMaxMqttAutomationsBytes) {
        return false;
    }

    const size_t file_size = static_cast<size_t>(st.st_size);
    FILE* f = fopen(filepath, "r");
    if (!f) {
        return false;
    }

#if CONFIG_SPIRAM
    char* buf = static_cast<char*>(heap_caps_malloc_prefer(file_size + 1, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_DEFAULT));
#else
    char* buf = static_cast<char*>(malloc(file_size + 1));
#endif
    if (!buf) {
        fclose(f);
        return false;
    }

    size_t nread = fread(buf, 1, file_size, f);
    bool read_err = (ferror(f) != 0);
    fclose(f);
    if (read_err || nread != file_size) {
        free(buf);
        return false;
    }
    buf[file_size] = '\0';

    // Reject embedded NUL bytes that could conceal trailing garbage
    if (strlen(buf) != file_size) {
        free(buf);
        return false;
    }

    const char* parse_end = nullptr;
    cJSON* root = cJSON_ParseWithOpts(buf, &parse_end, false);
    bool valid = false;
    if (root && parse_end) {
        bool trailing_ok = true;
        while (*parse_end != '\0') {
            if (*parse_end != ' ' && *parse_end != '\t' && *parse_end != '\r' && *parse_end != '\n') {
                trailing_ok = false;
                break;
            }
            ++parse_end;
        }
        if (trailing_ok) {
            if (cJSON_IsArray(root)) {
                valid = true;
            } else if (cJSON_IsObject(root)) {
                cJSON* rules_item = cJSON_GetObjectItemCaseSensitive(root, "rules");
                if (!rules_item) {
                    rules_item = cJSON_GetObjectItemCaseSensitive(root, "automations");
                }
                valid = (rules_item != nullptr && cJSON_IsArray(rules_item));
            }
        }
    }

    if (root) {
        cJSON_Delete(root);
    }
    free(buf);
    return valid;
}

static void mqtt_auto_reload_task(void* arg) {
    (void)arg;
    while (true) {
        {
            std::lock_guard<std::mutex> lock(s_auto_reload_mutex);
            if (!s_auto_reload_pending) {
                s_auto_reload_task_running = false;
                break;
            }
            s_auto_reload_pending = false;
        }

        rtc_crash_record_event("auto_reload");

        bool claimed_pending = false;
        bool claim_error = false;
        {
            std::lock_guard<std::mutex> file_lock(g_automations_file_mutex);
            if (s_auto_parse_tmp_pending.exchange(false, std::memory_order_acq_rel)) {
                struct stat st;
                if (stat(MQTT_AUTOMATIONS_PENDING_FILE, &st) == 0) {
                    if (rename(MQTT_AUTOMATIONS_PENDING_FILE, MQTT_AUTOMATIONS_WORK_FILE) == 0) {
                        claimed_pending = true;
                    } else {
                        ESP_LOGE(TAG, "Failed to claim %s -> %s", MQTT_AUTOMATIONS_PENDING_FILE, MQTT_AUTOMATIONS_WORK_FILE);
                        unlink(MQTT_AUTOMATIONS_PENDING_FILE);
                        claim_error = true;
                    }
                } else {
                    claim_error = true;
                }
            }
        }

        if (claimed_pending || claim_error) {
            std::string status_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/config/automations/status";
            if (claim_error) {
                static const char kErrMsg[] = "{\"status\":\"error\",\"message\":\"Failed staging automations\"}";
                mqtt_enqueue_nonblocking(status_topic.c_str(), kErrMsg, (int)(sizeof(kErrMsg) - 1), 0, 0);
                continue;
            }

            bool valid = validate_automations_json_file(MQTT_AUTOMATIONS_WORK_FILE);
            if (valid) {
                valid = load_automations_from_fs(MQTT_AUTOMATIONS_WORK_FILE);
            }

            bool commit_ok = false;
            if (valid) {
                {
                    std::lock_guard<std::mutex> file_lock(g_automations_file_mutex);
                    commit_ok = (rename(MQTT_AUTOMATIONS_WORK_FILE, "/spiffs/automations.json") == 0);
                    if (!commit_ok) {
                        ESP_LOGE(TAG, "Failed to atomically commit %s to /spiffs/automations.json", MQTT_AUTOMATIONS_WORK_FILE);
                        unlink(MQTT_AUTOMATIONS_WORK_FILE);
                    }
                }
                if (!commit_ok) {
                    // Reload on-disk automations.json so RAM and flash never diverge
                    load_automations_from_fs("/spiffs/automations.json");
                }
            } else {
                unlink(MQTT_AUTOMATIONS_WORK_FILE);
            }

            if (valid && commit_ok) {
                static const char kOkMsg[] = "{\"status\":\"ok\"}";
                mqtt_enqueue_nonblocking(status_topic.c_str(), kOkMsg, (int)(sizeof(kOkMsg) - 1), 0, 0);
            } else if (!valid) {
                static const char kErrMsg[] = "{\"status\":\"error\",\"message\":\"Invalid JSON syntax\"}";
                mqtt_enqueue_nonblocking(status_topic.c_str(), kErrMsg, (int)(sizeof(kErrMsg) - 1), 0, 0);
                continue;
            } else {
                static const char kErrMsg[] = "{\"status\":\"error\",\"message\":\"Failed committing automations\"}";
                mqtt_enqueue_nonblocking(status_topic.c_str(), kErrMsg, (int)(sizeof(kErrMsg) - 1), 0, 0);
                continue;
            }
        }

        if (s_mqtt_connected.load(std::memory_order_relaxed)) {
            publish_automations_json_state();
            refresh_automation_discovery_locked_check();
        }
    }
    vTaskDelete(NULL);
}

void mqtt_mgr_on_automations_reloaded(void) {
    if (!s_auto_parse_tmp_pending.load(std::memory_order_acquire) &&
        !s_mqtt_connected.load(std::memory_order_relaxed)) {
        return;
    }
    bool should_spawn = false;
    {
        std::lock_guard<std::mutex> lock(s_auto_reload_mutex);
        s_auto_reload_pending = true;
        if (!s_auto_reload_task_running) {
            s_auto_reload_task_running = true;
            should_spawn = true;
        }
    }
    if (should_spawn) {
        if (xTaskCreate(mqtt_auto_reload_task, "mqtt_auto", 6144, nullptr, 2, nullptr) != pdPASS) {
            ESP_LOGE(TAG, "Failed to create mqtt_auto task (free=%lu, internal=%lu)",
                     (unsigned long)esp_get_free_heap_size(),
                     (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            std::lock_guard<std::mutex> lock(s_auto_reload_mutex);
            s_auto_reload_task_running = false;
        }
    }
}

static void mqtt_mgr_publish_discovery(void) {
    if (global_mqtt_client && s_mqtt_connected.load()) {
        stream_catalog_entities([](const CanEntity& entity) -> bool {
            if (!global_mqtt_client || !s_mqtt_connected.load()) return false;
            publish_ha_discovery(global_mqtt_client, entity);
            vTaskDelay(pdMS_TO_TICKS(25));
            return true;
        });

        PsramVector<AutomationRule> rules_snapshot = snapshot_automations_for_mqtt();
        PsramUnorderedSet<std::string> new_exposed;
        for (const auto& rule : rules_snapshot) {
            if (!global_mqtt_client || !s_mqtt_connected.load()) break;
            if (rule.ha_expose && !rule.id.empty()) {
                new_exposed.insert(rule.id);
                publish_ha_automation_discovery(global_mqtt_client, rule);
                vTaskDelay(pdMS_TO_TICKS(25));
            }
        }
        {
            std::lock_guard<std::mutex> lock(s_mqtt_mutex);
            s_exposed_auto_ids.swap(new_exposed);
        }
    }
}

static void mqtt_mgr_clear_discovery(void) {
    if (global_mqtt_client && s_mqtt_connected.load()) {
        stream_catalog_entities([](const CanEntity& entity) -> bool {
            if (!global_mqtt_client || !s_mqtt_connected.load()) return false;
            clear_ha_discovery(global_mqtt_client, entity);
            vTaskDelay(pdMS_TO_TICKS(15));
            return true;
        });

        PsramVector<AutomationRule> rules_snapshot = snapshot_automations_for_mqtt();
        for (const auto& rule : rules_snapshot) {
            if (!global_mqtt_client || !s_mqtt_connected.load()) break;
            clear_ha_automation_topic(global_mqtt_client, rule.id);
            vTaskDelay(pdMS_TO_TICKS(15));
        }
        {
            std::lock_guard<std::mutex> lock(s_mqtt_mutex);
            s_exposed_auto_ids.clear();
        }
    }
}

void mqtt_mgr_publish_vbat(float vbat) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    if (!std::isfinite(vbat)) return;

    char val_str[16];
    int len = snprintf(val_str, sizeof(val_str), "%.1f", vbat);
    if (len <= 0) return;
    int safe_len = std::min(len, static_cast<int>(sizeof(val_str) - 1));

    // Publish to device-scoped vbat and cond_aux_12v_battery topics (do NOT overwrite raw 8-byte hex 0x1CF topic!)
    std::string vbat_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/state/vbat";
    mqtt_enqueue_nonblocking(vbat_topic.c_str(), val_str, safe_len, 0, 1);

    std::string entity_topic = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/state/cond_aux_12v_battery";
    mqtt_enqueue_nonblocking(entity_topic.c_str(), val_str, safe_len, 0, 1);
}

void mqtt_mgr_publish_bms(float kw, float soc, float v, float a, float delta_mv, int min_t, int max_t) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;

    auto publish_bms_metric = [](const char* metric, const char* val_str, int len) {
        if (!metric || !val_str || len <= 0) return;
        char dev_topic[96];
        int dev_len = snprintf(dev_topic, sizeof(dev_topic), "%s/%s/state/%s",
                               MQTT_BASE_TOPIC, DEVICE_ID.c_str(), metric);
        if (dev_len > 0 && dev_len < static_cast<int>(sizeof(dev_topic))) {
            mqtt_enqueue_nonblocking(dev_topic, val_str, len, 0, 1);
        }
    };

    auto publish_bms_float = [&publish_bms_metric](const char* metric, const char* fmt, float value) {
        if (!std::isfinite(value)) return;
        char val_str[32];
        int len = snprintf(val_str, sizeof(val_str), fmt, value);
        if (len <= 0) return;
        int safe_len = std::min(len, static_cast<int>(sizeof(val_str) - 1));
        publish_bms_metric(metric, val_str, safe_len);
    };

    auto publish_bms_int = [&publish_bms_metric](const char* metric, int value) {
        char val_str[16];
        int len = snprintf(val_str, sizeof(val_str), "%d", value);
        if (len <= 0) return;
        int safe_len = std::min(len, static_cast<int>(sizeof(val_str) - 1));
        publish_bms_metric(metric, val_str, safe_len);
    };

    publish_bms_float("bms_hv_power_kw", "%.2f", kw);
    publish_bms_float("bms_display_soc", "%.1f", soc);
    publish_bms_float("bms_hv_voltage", "%.1f", v);
    publish_bms_float("bms_hv_current", "%.1f", a);
    publish_bms_float("bms_cell_delta_mv", "%.0f", delta_mv);
    publish_bms_int("bms_temp_min_c", min_t);
    publish_bms_int("bms_temp_max_c", max_t);
}

void mqtt_mgr_publish_ble_button(const std::string& address, const std::string& button, const std::string& action, const std::string& combo, uint32_t hold_seconds) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;

    cJSON* root = cJSON_CreateObject();
    if (!root) return;

    cJSON_AddStringToObject(root, "device_id", DEVICE_ID.c_str());
    cJSON_AddStringToObject(root, "address", address.c_str());
    cJSON_AddStringToObject(root, "button", button.c_str());
    cJSON_AddStringToObject(root, "action", action.c_str());
    if (!combo.empty()) {
        cJSON_AddStringToObject(root, "combo", combo.c_str());
    }
    if (hold_seconds > 0) {
        cJSON_AddNumberToObject(root, "hold_seconds", hold_seconds);
    }

    char* payload = cJSON_PrintUnformatted(root);
    if (payload) {
        // Publish ONLY to device-scoped topic so Home Assistant wildcard doesn't fire twice
        std::string topic_dev = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/ble_button";
        mqtt_enqueue_nonblocking(topic_dev.c_str(), payload, (int)strlen(payload), 0, 0);
        free(payload);
    }
    cJSON_Delete(root);
}

void mqtt_mgr_publish_ble_device(const std::string& address, const std::string& event, int8_t rssi, const std::string& name) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;

    cJSON* root = cJSON_CreateObject();
    if (!root) return;

    cJSON_AddStringToObject(root, "device_id", DEVICE_ID.c_str());
    cJSON_AddStringToObject(root, "address", address.c_str());
    cJSON_AddStringToObject(root, "event", event.c_str());
    cJSON_AddNumberToObject(root, "rssi", rssi);
    cJSON_AddBoolToObject(root, "connected", (event == "connected"));
    if (!name.empty()) {
        cJSON_AddStringToObject(root, "name", name.c_str());
    }

    char* payload = cJSON_PrintUnformatted(root);
    if (payload) {
        std::string topic_dev = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/ble_device";
        mqtt_enqueue_nonblocking(topic_dev.c_str(), payload, (int)strlen(payload), 0, 0);
        free(payload);
    }
    cJSON_Delete(root);
}

void mqtt_mgr_publish_ble_beacon(const std::string& uuid, const std::string& event, int8_t rssi, uint16_t major, uint16_t minor, const std::string& mac, const std::string& name) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;

    cJSON* root = cJSON_CreateObject();
    if (!root) return;

    cJSON_AddStringToObject(root, "device_id", DEVICE_ID.c_str());
    cJSON_AddStringToObject(root, "uuid", uuid.c_str());
    cJSON_AddStringToObject(root, "event", event.c_str());
    cJSON_AddNumberToObject(root, "rssi", rssi);
    cJSON_AddNumberToObject(root, "major", major);
    cJSON_AddNumberToObject(root, "minor", minor);
    cJSON_AddBoolToObject(root, "present", (event != "exit"));
    if (!mac.empty()) {
        cJSON_AddStringToObject(root, "mac", mac.c_str());
    }
    if (!name.empty()) {
        cJSON_AddStringToObject(root, "name", name.c_str());
    }

    char* payload = cJSON_PrintUnformatted(root);
    if (payload) {
        std::string topic_dev = std::string(MQTT_BASE_TOPIC) + "/" + DEVICE_ID + "/ble_beacon";
        mqtt_enqueue_nonblocking(topic_dev.c_str(), payload, (int)strlen(payload), 0, 0);
        free(payload);
    }
    cJSON_Delete(root);
}
