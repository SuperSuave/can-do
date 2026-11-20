#include "mqtt_mgr.h"
#include "parser.h"
#include "can_engine.h"
#include "track_popup.h"
#include "hud_nav.h"
#include "power_mgr.h"
#include "cJSON.h"
#include "esp_log.h"
#include <cstdio>
#include <cstring>
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

const std::string MQTT_BASE_TOPIC = "cando";
esp_mqtt_client_handle_t global_mqtt_client = nullptr;

static std::mutex s_mqtt_mutex;
static MqttConfig s_mqtt_cfg;
static std::atomic<bool> s_mqtt_connected{false};
static std::atomic<bool> s_sync_task_running{false};
static std::atomic<bool> s_need_clear_discovery{false};
static std::atomic<bool> s_auto_reload_task_running{false};
static std::atomic<bool> s_auto_reload_pending{false};
static std::atomic<bool> s_auto_parse_tmp_pending{false};
static std::unordered_set<std::string> s_exposed_auto_ids;
static std::string s_lwt_topic;

struct MqttSetCmd {
    char entity_id[64];
    char payload[384];
};
static QueueHandle_t s_mqtt_cmd_queue = nullptr;
static StaticQueue_t s_mqtt_cmd_queue_struct;
static uint8_t* s_mqtt_cmd_queue_storage = nullptr;

static void mqtt_cmd_worker_task(void* arg) {
    (void)arg;
    MqttSetCmd cmd;
    while (true) {
        if (xQueueReceive(s_mqtt_cmd_queue, &cmd, portMAX_DELAY) == pdTRUE) {
            rtc_crash_record_event("mqtt_set_cmd");
            queue_entity_command(cmd.entity_id, cmd.payload);
        }
    }
}

static FILE* s_automations_tmp_file = nullptr;
static bool s_receiving_automations = false;

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

static inline char* alloc_mqtt_pub_buf(size_t sz) {
#if CONFIG_SPIRAM
    return (char*)heap_caps_malloc_prefer(sz, 2, MALLOC_CAP_DEFAULT | MALLOC_CAP_SPIRAM, MALLOC_CAP_DEFAULT);
#else
    return (char*)malloc(sz);
#endif
}

static void mqtt_pub_worker_task(void* arg) {
    (void)arg;
    MqttPubItem item;
    while (true) {
        if (xQueueReceive(s_mqtt_pub_queue, &item, portMAX_DELAY) == pdTRUE) {
            if (s_mqtt_connected.load(std::memory_order_relaxed)) {
                std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
                if (global_mqtt_client && s_mqtt_connected.load(std::memory_order_relaxed)) {
                    const char* payload_ptr = item.heap_data ? item.heap_data : item.inline_data;
                    esp_mqtt_client_enqueue(global_mqtt_client, item.topic, payload_ptr, item.len, item.qos, item.retain, true);
                }
            }
            if (item.heap_data) {
                free(item.heap_data);
            }
        }
    }
}

// Non-blocking MQTT enqueue helper: queues to s_mqtt_pub_queue with 0-tick wait so can_rx_task never touches MQTT_API_LOCK
static inline void mqtt_enqueue_nonblocking(const char* topic, const char* data, int len, int qos, int retain) {
    if (!s_mqtt_pub_queue || !global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed) || !topic) return;
    int actual_len = (len > 0) ? len : (data ? (int)strlen(data) : 0);
    MqttPubItem item = {};
    strncpy(item.topic, topic, sizeof(item.topic) - 1);
    item.len = actual_len;
    item.qos = (uint8_t)qos;
    item.retain = (uint8_t)retain;
    if (actual_len > 0 && data) {
        if (actual_len <= (int)sizeof(item.inline_data)) {
            memcpy(item.inline_data, data, actual_len);
        } else {
            item.heap_data = alloc_mqtt_pub_buf((size_t)actual_len);
            if (!item.heap_data) return;
            memcpy(item.heap_data, data, actual_len);
        }
    }
    if (xQueueSend(s_mqtt_pub_queue, &item, 0) != pdTRUE) {
        if (item.heap_data) {
            free(item.heap_data);
        }
    }
}

// Default monitored CAN IDs (Gen5W / E-GMP vehicle telemetry)
static const std::unordered_set<uint32_t> s_default_monitored_ids = {
    0x038, 0x045, 0x070, 0x0A2, 0x130, 0x151, 0x152, 0x1AC, 0x1BA, 0x1CF, 0x1F1, 0x1F9, 0x1FA,
    0x200, 0x203, 0x220, 0x226, 0x227, 0x25C, 0x29B, 0x29C, 0x2AD, 0x2AF, 0x2C0, 0x2DB, 0x2FC,
    0x30B, 0x30C, 0x30E, 0x31B, 0x31C, 0x321, 0x324, 0x326, 0x327, 0x328, 0x340, 0x380, 0x384,
    0x38C, 0x38D, 0x39B, 0x3A1, 0x3A2, 0x3A6, 0x3AA, 0x3C1,
    0x410, 0x411, 0x412, 0x413, 0x414, 0x418, 0x41D, 0x420, 0x421, 0x435, 0x436, 0x438,
    0x442, 0x448, 0x450, 0x453, 0x455, 0x465, 0x474, 0x475, 0x476, 0x477, 0x478, 0x47F,
    0x490, 0x496, 0x49C, 0x4A2, 0x4C5, 0x4CE, 0x4E2, 0x4ED,
    0x540, 0x541, 0x542, 0x553, 0x559, 0x578, 0x584, 0x587, 0x593, 0x594, 0x595, 0x597, 0x5CC,
    0x5D0, 0x5D6, 0x5D7, 0x5F5, 0x5F7, 0x60C, 0x60D, 0x60E, 0x60F, 0x651, 0x652, 0x7EC
};
static std::unordered_set<uint32_t> s_monitored_ids = s_default_monitored_ids;
static std::mutex s_monitored_mutex;
static const char* MONITORED_IDS_FILE = "/spiffs/monitored_ids.json";

static void load_monitored_ids_from_fs(void) {
    FILE* f = fopen(MONITORED_IDS_FILE, "r");
    if (!f) return;

    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (len <= 0) {
        fclose(f);
        return;
    }

    std::string buf(len, '\0');
    fread(&buf[0], 1, len, f);
    fclose(f);

    cJSON* root = cJSON_Parse(buf.c_str());
    if (!root || !cJSON_IsArray(root)) {
        if (root) cJSON_Delete(root);
        return;
    }

    std::lock_guard<std::mutex> lock(s_monitored_mutex);
    s_monitored_ids.clear();
    int count = cJSON_GetArraySize(root);
    for (int i = 0; i < count; i++) {
        cJSON* itm = cJSON_GetArrayItem(root, i);
        if (itm && cJSON_IsString(itm)) {
            s_monitored_ids.insert(strtoul(itm->valuestring, nullptr, 0));
        } else if (itm && cJSON_IsNumber(itm)) {
            s_monitored_ids.insert((uint32_t)itm->valueint);
        }
    }
    cJSON_Delete(root);
    ESP_LOGI(TAG, "Loaded %d monitored CAN IDs from %s", (int)s_monitored_ids.size(), MONITORED_IDS_FILE);
}

static bool save_monitored_ids_to_fs(void) {
    cJSON* root = cJSON_CreateArray();
    {
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        std::vector<uint32_t> sorted(s_monitored_ids.begin(), s_monitored_ids.end());
        std::sort(sorted.begin(), sorted.end());
        for (uint32_t id : sorted) {
            char hex_buf[16];
            snprintf(hex_buf, sizeof(hex_buf), "0x%03lX", (unsigned long)id);
            cJSON_AddItemToArray(root, cJSON_CreateString(hex_buf));
        }
    }

    char* rendered = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!rendered) return false;

    FILE* f = fopen("/spiffs/monitored_ids.json.tmp", "w");
    if (!f) {
        free(rendered);
        return false;
    }
    fputs(rendered, f);
    fclose(f);
    free(rendered);

    unlink(MONITORED_IDS_FILE);
    rename("/spiffs/monitored_ids.json.tmp", MONITORED_IDS_FILE);
    ESP_LOGI(TAG, "Persisted %s", MONITORED_IDS_FILE);
    return true;
}

void mqtt_mgr_publish_can_state(uint32_t can_id, const uint8_t* data, size_t len) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    char topic[64];
    snprintf(topic, sizeof(topic), "%s/%s/state/0x%03lX", MQTT_BASE_TOPIC.c_str(), DEVICE_ID.c_str(), (unsigned long)can_id);
    char hex_payload[17] = {0};
    for (size_t i = 0; i < len && i < 8; i++) {
        snprintf(&hex_payload[i * 2], 3, "%02X", data[i]);
    }
    // QoS 0 + non-blocking enqueue prevents outbox bloat and TCP stalls in can_rx_task
    mqtt_enqueue_nonblocking(topic, hex_payload, (int)(len > 8 ? 16 : len * 2), 0, 1);
}

void mqtt_mgr_publish_entity_state(const std::string& entity_id, const std::string& state) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    std::string topic = MQTT_BASE_TOPIC + "/state/" + entity_id;
    mqtt_enqueue_nonblocking(topic.c_str(), state.c_str(), (int)state.length(), 0, 1);
}

void mqtt_mgr_publish_active_ids(bool force) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    static uint32_t s_last_active_pub_ms = 0;
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    if (!force && (now_ms - s_last_active_pub_ms < 10000)) {
        return; // Throttle to at most once per 10s
    }

    std::vector<uint32_t> active = can_engine_get_active_ids();
    if (active.empty() && !force) return;

    cJSON* root = cJSON_CreateArray();
    for (uint32_t id : active) {
        char hex_buf[16];
        snprintf(hex_buf, sizeof(hex_buf), "0x%03lX", (unsigned long)id);
        cJSON_AddItemToArray(root, cJSON_CreateString(hex_buf));
    }
    char* rendered = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!rendered) return;

    char topic[64];
    snprintf(topic, sizeof(topic), "%s/%s/active_ids", MQTT_BASE_TOPIC.c_str(), DEVICE_ID.c_str());
    mqtt_enqueue_nonblocking(topic, rendered, (int)strlen(rendered), 0, 1);
    free(rendered);

    s_last_active_pub_ms = now_ms;
    can_engine_clear_active_ids_changed();
}

void mqtt_mgr_set_monitored_ids(const std::vector<uint32_t>& ids, bool persist) {
    {
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        s_monitored_ids.clear();
        for (uint32_t id : ids) {
            s_monitored_ids.insert(id);
        }
    }
    if (persist) {
        save_monitored_ids_to_fs();
    }
}

std::vector<uint32_t> mqtt_mgr_get_monitored_ids(void) {
    std::lock_guard<std::mutex> lock(s_monitored_mutex);
    std::vector<uint32_t> ids(s_monitored_ids.begin(), s_monitored_ids.end());
    std::sort(ids.begin(), ids.end());
    return ids;
}

void mqtt_mgr_reset_monitored_ids(void) {
    {
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        s_monitored_ids = s_default_monitored_ids;
    }
    unlink(MONITORED_IDS_FILE);
    ESP_LOGI(TAG, "Reset monitored CAN IDs to default");
}

bool mqtt_mgr_is_monitored_ids_customized(void) {
    struct stat st;
    return stat(MONITORED_IDS_FILE, &st) == 0;
}

bool mqtt_mgr_is_monitored_id(uint32_t can_id) {
    std::lock_guard<std::mutex> lock(s_monitored_mutex);
    return s_monitored_ids.find(can_id) != s_monitored_ids.end();
}

static void publish_ha_discovery(esp_mqtt_client_handle_t client, const CanEntity& entity) {
    if (!client || entity.ha_domain.empty()) return;

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "name", entity.ha_name.c_str());

    std::string unique_id = DEVICE_ID + "_" + entity.id;
    cJSON_AddStringToObject(root, "unique_id", unique_id.c_str());
    cJSON_AddStringToObject(root, "object_id", entity.id.c_str());

    if (!entity.ha_icon.empty()) {
        cJSON_AddStringToObject(root, "icon", entity.ha_icon.c_str());
    }

    if (!entity.options.empty()) {
        cJSON *options_array = cJSON_AddArrayToObject(root, "options");
        for (const auto& opt : entity.options) {
            cJSON_AddItemToArray(options_array, cJSON_CreateString(opt.label.c_str()));
        }
    }

    std::string cmd_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/set/" + entity.id;
    std::string state_topic = MQTT_BASE_TOPIC + "/state/" + entity.id;
    cJSON_AddStringToObject(root, "command_topic", cmd_topic.c_str());
    cJSON_AddStringToObject(root, "state_topic", state_topic.c_str());

    if (entity.ha_domain == "switch") {
        cJSON_AddStringToObject(root, "payload_on", "ON");
        cJSON_AddStringToObject(root, "payload_off", "OFF");
        cJSON_AddStringToObject(root, "state_on", "ON");
        cJSON_AddStringToObject(root, "state_off", "OFF");
    }

    cJSON *device = cJSON_AddObjectToObject(root, "device");
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
    cJSON_AddStringToObject(root, "name", rule.name.c_str());

    std::string unique_id = DEVICE_ID + "_auto_" + rule.id;
    cJSON_AddStringToObject(root, "unique_id", unique_id.c_str());
    cJSON_AddStringToObject(root, "object_id", ("auto_" + rule.id).c_str());

    if (!rule.ha_icon.empty()) {
        cJSON_AddStringToObject(root, "icon", rule.ha_icon.c_str());
    }

    std::string cmd_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/set/" + rule.id;
    std::string state_topic = MQTT_BASE_TOPIC + "/state/" + rule.id;
    cJSON_AddStringToObject(root, "command_topic", cmd_topic.c_str());
    cJSON_AddStringToObject(root, "state_topic", state_topic.c_str());

    cJSON_AddStringToObject(root, "payload_on", "ON");
    cJSON_AddStringToObject(root, "payload_off", "OFF");
    cJSON_AddStringToObject(root, "state_on", "ON");
    cJSON_AddStringToObject(root, "state_off", "OFF");

    cJSON *device = cJSON_AddObjectToObject(root, "device");
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

static void clear_ha_automation_discovery(esp_mqtt_client_handle_t client, const AutomationRule& rule) {
    clear_ha_automation_topic(client, rule.id);
}

static void publish_automations_json_state(void) {
    if (!global_mqtt_client || !s_mqtt_connected.load()) return;
    std::string state_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/state";
    FILE* state_f = fopen("/spiffs/automations.json", "r");
    if (state_f) {
        fseek(state_f, 0, SEEK_END);
        long slen = ftell(state_f);
        fseek(state_f, 0, SEEK_SET);
        if (slen <= 0 || slen > 32768) {
            mqtt_enqueue_nonblocking(state_topic.c_str(), "[]", 2, 0, 1);
        } else {
            char* sbuf = (char*)malloc(slen + 1);
            if (sbuf) {
                fread(sbuf, 1, slen, state_f);
                sbuf[slen] = '\0';
                mqtt_enqueue_nonblocking(state_topic.c_str(), sbuf, (int)slen, 0, 1);
                free(sbuf);
            }
        }
        fclose(state_f);
    } else {
        mqtt_enqueue_nonblocking(state_topic.c_str(), "[]", 2, 0, 1);
    }
}

static void mqtt_post_connect_sync_task(void* arg) {
    vTaskDelay(pdMS_TO_TICKS(500));

    // 1. Stream cached CAN frames with yields so outbox and IDLE0 never starve
    std::vector<uint32_t> mon_snapshot;
    {
        std::lock_guard<std::mutex> lock(s_monitored_mutex);
        mon_snapshot.assign(s_monitored_ids.begin(), s_monitored_ids.end());
    }
    int count = 0;
    for (uint32_t can_id : mon_snapshot) {
        if (!s_mqtt_connected.load()) break;
        uint8_t data[8] = {0};
        if (get_cached_can_frame(can_id, data)) {
            mqtt_mgr_publish_can_state(can_id, data, 8);
            if (++count % 8 == 0) {
                vTaskDelay(pdMS_TO_TICKS(10));
            }
        }
    }

    // 1b. Publish active bus manifest (detected CAN IDs)
    if (s_mqtt_connected.load()) {
        mqtt_mgr_publish_active_ids(true);
    }

    // 2. Publish automations state
    if (s_mqtt_connected.load()) {
        publish_automations_json_state();
        vTaskDelay(pdMS_TO_TICKS(500));
    }

    // 3. Publish HA discovery if enabled (or clear once if explicitly disabled via settings)
    if (s_mqtt_connected.load()) {
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
    if (!g_state_restored_from_rtc.load()) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        std::string state_sub = MQTT_BASE_TOPIC + "/state/+";
        esp_mqtt_client_unsubscribe(global_mqtt_client, state_sub.c_str());
        ESP_LOGI(TAG, "Completed cold-boot state hydration from MQTT; unsubscribed from %s", state_sub.c_str());
    }

    s_sync_task_running.store(false);
    vTaskDelete(NULL);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    auto event = static_cast<esp_mqtt_event_handle_t>(event_data);
    switch (event->event_id) {
        case MQTT_EVENT_CONNECTED: {
            ESP_LOGI(TAG, "MQTT connected to broker (%s)", s_mqtt_cfg.broker_url.c_str());

            // 1. Pack all 14 control topics into a SINGLE MQTT SUBSCRIBE packet (QoS 0)
            // Avoids 14 separate WebSocket frames AND avoids # wildcard broker echo on /state/*
            std::string t_dev_tx       = MQTT_BASE_TOPIC + "/+/tx";
            std::string t_base_tx      = MQTT_BASE_TOPIC + "/tx";
            std::string t_dev_notify   = MQTT_BASE_TOPIC + "/+/notify";
            std::string t_base_notify  = MQTT_BASE_TOPIC + "/notify";
            std::string t_dev_nav      = MQTT_BASE_TOPIC + "/+/nav/set";
            std::string t_base_nav     = MQTT_BASE_TOPIC + "/nav/set";
            std::string t_dev_sub_ids  = MQTT_BASE_TOPIC + "/+/subscribe_ids";
            std::string t_base_sub_ids = MQTT_BASE_TOPIC + "/subscribe_ids";
            std::string t_dev_cfg_set  = MQTT_BASE_TOPIC + "/+/config/automations/set";
            std::string t_base_cfg_set = MQTT_BASE_TOPIC + "/config/automations/set";
            std::string t_dev_cfg_get  = MQTT_BASE_TOPIC + "/+/config/automations/get";
            std::string t_base_cfg_get = MQTT_BASE_TOPIC + "/config/automations/get";
            std::string t_dev_set_all  = MQTT_BASE_TOPIC + "/+/set/#";
            std::string t_base_set_all = MQTT_BASE_TOPIC + "/set/#";

            const esp_mqtt_topic_t sub_list[] = {
                { .filter = t_dev_tx.c_str(),       .qos = 0 },
                { .filter = t_base_tx.c_str(),      .qos = 0 },
                { .filter = t_dev_notify.c_str(),   .qos = 0 },
                { .filter = t_base_notify.c_str(),  .qos = 0 },
                { .filter = t_dev_nav.c_str(),      .qos = 0 },
                { .filter = t_base_nav.c_str(),     .qos = 0 },
                { .filter = t_dev_sub_ids.c_str(),  .qos = 0 },
                { .filter = t_base_sub_ids.c_str(), .qos = 0 },
                { .filter = t_dev_cfg_set.c_str(),  .qos = 0 },
                { .filter = t_base_cfg_set.c_str(), .qos = 0 },
                { .filter = t_dev_cfg_get.c_str(),  .qos = 0 },
                { .filter = t_base_cfg_get.c_str(), .qos = 0 },
                { .filter = t_dev_set_all.c_str(),  .qos = 0 },
                { .filter = t_base_set_all.c_str(), .qos = 0 },
            };

            esp_mqtt_client_subscribe_multiple(
                global_mqtt_client,
                sub_list,
                sizeof(sub_list) / sizeof(sub_list[0])
            );

            // Cold-boot fallback: If RTC state cache was empty, subscribe to retained entity states
            static std::atomic<bool> s_hydrated_from_mqtt{false};
            if (!g_state_restored_from_rtc.load() && !s_hydrated_from_mqtt.load()) {
                std::string state_sub = MQTT_BASE_TOPIC + "/state/+";
                esp_mqtt_client_subscribe(global_mqtt_client, state_sub.c_str(), 0);
                ESP_LOGI(TAG, "Cold boot detected without RTC cache: Subscribed to retained states (%s)", state_sub.c_str());
            }

            // 2. Mark connected after subscribe finishes and publish LWT online status
            rtc_crash_record_event("mqtt_connected");
            s_mqtt_connected.store(true, std::memory_order_relaxed);
            std::string status_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/status";
            mqtt_enqueue_nonblocking(status_topic.c_str(), "online", 6, 0, 1);

            // 3. Defer state dump & HA discovery to single background worker task (6144-byte stack)
            if (!s_sync_task_running.exchange(true)) {
                if (xTaskCreate(mqtt_post_connect_sync_task, "mqtt_sync", 6144, nullptr, 2, nullptr) != pdPASS) {
                    s_sync_task_running.store(false);
                }
            }
            break;
        }

        case MQTT_EVENT_DISCONNECTED:
            s_mqtt_connected = false;
            ESP_LOGW(TAG, "MQTT disconnected from broker");
            break;

        case MQTT_EVENT_DATA: {
            auto extract_target_topic_suffix = [](const std::string& t, std::string& out_suffix) -> bool {
                const std::string base_prefix = MQTT_BASE_TOPIC + "/";
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

            if (event->current_data_offset == 0 && event->topic_len > 0) {
                std::string init_topic(event->topic, event->topic_len);
                std::string init_suffix;
                if (extract_target_topic_suffix(init_topic, init_suffix) && init_suffix == "config/automations/set") {
                    s_receiving_automations = true;
                    s_automations_tmp_file = fopen("/spiffs/automations.json.tmp", "w");
                    if (!s_automations_tmp_file) {
                        ESP_LOGE(TAG, "Failed to open automations.json.tmp for writing");
                        s_receiving_automations = false;
                    }
                }
            }

            if (s_receiving_automations) {
                if (s_automations_tmp_file && event->data_len > 0) {
                    fwrite(event->data, 1, event->data_len, s_automations_tmp_file);
                }

                bool is_final_chunk = (event->current_data_offset + event->data_len >= event->total_data_len);
                if (is_final_chunk) {
                    if (s_automations_tmp_file) {
                        fclose(s_automations_tmp_file);
                        s_automations_tmp_file = nullptr;
                    }
                    s_receiving_automations = false;

                    s_auto_parse_tmp_pending.store(true);
                    mqtt_mgr_on_automations_reloaded();
                }
                return;
            }

            if (event->topic_len == 0) return;
            std::string topic(event->topic, event->topic_len);
            std::string payload(event->data, event->data_len);

            std::string state_prefix = MQTT_BASE_TOPIC + "/state/";
            if (topic.rfind(state_prefix, 0) == 0 && topic.length() > state_prefix.length()) {
                std::string entity_id = topic.substr(state_prefix.length());
                can_engine_hydrate_from_mqtt(entity_id, payload);
                return;
            }

            std::string suffix;
            if (!extract_target_topic_suffix(topic, suffix)) {
                return;
            }

            if (suffix == "config/automations/get") {
                s_auto_reload_pending.store(true);
                mqtt_mgr_on_automations_reloaded();
                return;
            }

            bool is_notify = (suffix == "notify");
            bool is_nav_set = (suffix == "nav/set");
            bool is_tx = (suffix == "tx");
            bool is_sub_ids = (suffix == "subscribe_ids");
            bool is_set_cmd = (suffix.rfind("set/", 0) == 0);

            if (is_notify) {
                std::string msg = payload;
                std::string level = "info";

                cJSON* root = cJSON_Parse(payload.c_str());
                if (root) {
                    cJSON* m = cJSON_GetObjectItem(root, "message");
                    if (!m) m = cJSON_GetObjectItem(root, "text");
                    if (!m) m = cJSON_GetObjectItem(root, "popup_message");
                    if (m && cJSON_IsString(m)) msg = m->valuestring;

                    cJSON* l = cJSON_GetObjectItem(root, "level");
                    if (l && cJSON_IsString(l)) level = l->valuestring;

                    cJSON_Delete(root);
                }

                if (level == "warning") {
                    track_popup_show_warning(msg.c_str());
                } else if (level == "error" || level == "critical") {
                    track_popup_show_error(msg.c_str());
                } else {
                    track_popup_show_info(msg.c_str());
                }
            } else if (is_nav_set) {
                cJSON* root = cJSON_Parse(payload.c_str());
                if (root) {
                    cJSON* act = cJSON_GetObjectItem(root, "action");
                    if (act && cJSON_IsString(act) && strcmp(act->valuestring, "clear") == 0) {
                        hud_nav_clear();
                    } else {
                        hud_nav_instruction_t instr{};
                        instr.distance_meters = 0xFFFF; // Inactive default
                        cJSON* icon_item = cJSON_GetObjectItem(root, "icon");
                        if (icon_item && cJSON_IsNumber(icon_item)) {
                            instr.icon = (hud_maneuver_icon_t)icon_item->valueint;
                        } else {
                            instr.icon = HUD_MANEUVER_STRAIGHT;
                        }

                        cJSON* dir_item = cJSON_GetObjectItem(root, "direction");
                        if (!dir_item) dir_item = cJSON_GetObjectItem(root, "direction_deg");
                        if (!dir_item) dir_item = cJSON_GetObjectItem(root, "heading");
                        if (dir_item && cJSON_IsNumber(dir_item)) instr.direction_deg = (uint16_t)dir_item->valueint;

                        cJSON* dist_item = cJSON_GetObjectItem(root, "distance");
                        if (!dist_item) dist_item = cJSON_GetObjectItem(root, "distance_meters");
                        if (dist_item && cJSON_IsNumber(dist_item)) instr.distance_meters = (uint16_t)dist_item->valueint;

                        cJSON* bars_item = cJSON_GetObjectItem(root, "bars");
                        if (bars_item && cJSON_IsNumber(bars_item)) instr.bar_graph = (uint8_t)bars_item->valueint;

                        cJSON* spd_item = cJSON_GetObjectItem(root, "speed_limit");
                        if (spd_item && cJSON_IsNumber(spd_item)) instr.speed_limit_kph = (uint8_t)spd_item->valueint;

                        cJSON* cam_item = cJSON_GetObjectItem(root, "camera_alert");
                        if (cam_item && cJSON_IsBool(cam_item)) instr.speed_camera_alert = cJSON_IsTrue(cam_item);

                        cJSON* street_item = cJSON_GetObjectItem(root, "street");
                        if (street_item && cJSON_IsString(street_item)) instr.street_name = street_item->valuestring;

                        cJSON* lanes_item = cJSON_GetObjectItem(root, "lanes");
                        if (!lanes_item) lanes_item = cJSON_GetObjectItem(root, "num_lanes");
                        if (lanes_item && cJSON_IsNumber(lanes_item)) {
                            instr.num_lanes = (uint8_t)lanes_item->valueint;
                            if (instr.num_lanes > 8) instr.num_lanes = 8;
                            instr.has_lane_guidance = true;
                        }

                        cJSON* lane_dirs = cJSON_GetObjectItem(root, "lane_directions");
                        if (lane_dirs && cJSON_IsArray(lane_dirs)) {
                            instr.has_lane_guidance = true;
                            int n = cJSON_GetArraySize(lane_dirs);
                            if (instr.num_lanes == 0 && n > 0) {
                                instr.num_lanes = (n > 8) ? 8 : (uint8_t)n;
                            }
                            for (int i = 0; i < n && i < 8; i++) {
                                cJSON* elem = cJSON_GetArrayItem(lane_dirs, i);
                                if (elem && cJSON_IsNumber(elem)) {
                                    instr.lane_directions[i] = (uint8_t)elem->valueint;
                                }
                            }
                        }

                        cJSON* lane_recs = cJSON_GetObjectItem(root, "lane_recommended");
                        if (!lane_recs) lane_recs = cJSON_GetObjectItem(root, "lane_highlights");
                        if (lane_recs && cJSON_IsArray(lane_recs)) {
                            instr.has_lane_guidance = true;
                            int n = cJSON_GetArraySize(lane_recs);
                            for (int i = 0; i < n && i < 8; i++) {
                                cJSON* elem = cJSON_GetArrayItem(lane_recs, i);
                                if (elem) {
                                    if (cJSON_IsBool(elem)) {
                                        instr.lane_recommended[i] = cJSON_IsTrue(elem) ? 1 : 0;
                                    } else if (cJSON_IsNumber(elem)) {
                                        instr.lane_recommended[i] = (uint8_t)elem->valueint;
                                    }
                                }
                            }
                        }

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
                cJSON* root = cJSON_Parse(payload.c_str());
                if (root) {
                    bool handled = false;
                    cJSON* target_entity = cJSON_GetObjectItem(root, "entity");
                    cJSON* target_cmd = cJSON_GetObjectItem(root, "command");
                    if (cJSON_IsString(target_entity)) {
                        const char* cmd_str = cJSON_IsString(target_cmd) ? target_cmd->valuestring : "";
                        if (queue_entity_command(target_entity->valuestring, cmd_str)) {
                            handled = true;
                        }
                    }

                    if (!handled) {
                        uint32_t can_id = 0;
                        cJSON* id_item = cJSON_GetObjectItem(root, "can_id");
                        if (id_item && cJSON_IsString(id_item)) {
                            can_id = strtoul(id_item->valuestring, nullptr, 0);
                        } else if (id_item && cJSON_IsNumber(id_item)) {
                            can_id = (uint32_t)id_item->valueint;
                        }

                        uint8_t top_bus = 0;
                        cJSON* bus_item = cJSON_GetObjectItem(root, "bus");
                        if (bus_item && cJSON_IsNumber(bus_item)) {
                            top_bus = (uint8_t)bus_item->valueint;
                        } else if (bus_item && cJSON_IsString(bus_item)) {
                            top_bus = (uint8_t)strtoul(bus_item->valuestring, nullptr, 0);
                        }

                        uint32_t delay_ms = 20;
                        cJSON* del_item = cJSON_GetObjectItem(root, "delay_ms");
                        if (del_item && cJSON_IsNumber(del_item) && del_item->valueint >= 0) {
                            delay_ms = (uint32_t)del_item->valueint;
                        }

                        std::vector<ActionStep> steps;
                        cJSON* steps_arr = cJSON_GetObjectItem(root, "steps");
                        if (steps_arr && cJSON_IsArray(steps_arr) && cJSON_GetArraySize(steps_arr) > 0) {
                            cJSON* s_item = nullptr;
                            cJSON_ArrayForEach(s_item, steps_arr) {
                                ActionStep step;
                                if (parse_action_step(s_item, step)) {
                                    if (step.type == ActionType::TRANSMIT_FRAME) {
                                        if (step.can_id == 0) step.can_id = can_id;
                                        if (!cJSON_GetObjectItem(s_item, "bus")) step.bus = top_bus;
                                        if (step.repeat == 0) step.repeat = 1;
                                        if (step.delay_ms == delay_ms) step.delay_ms = 0;
                                    }
                                    if (step.type != ActionType::TRANSMIT_FRAME || step.can_id != 0) {
                                        steps.push_back(std::move(step));
                                    }
                                }
                            }
                        } else if (can_id != 0 && cJSON_GetObjectItem(root, "payload")) {
                            ActionStep step;
                            if (parse_action_step(root, step)) {
                                step.type = ActionType::TRANSMIT_FRAME;
                                step.can_id = can_id;
                                step.bus = top_bus;
                                if (step.repeat == 0) step.repeat = 1;
                                if (step.delay_ms == delay_ms) step.delay_ms = 0;
                                steps.push_back(std::move(step));
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
                cJSON* root = cJSON_Parse(payload.c_str());
                if (root && cJSON_IsArray(root)) {
                    std::vector<uint32_t> ids;
                    int count = cJSON_GetArraySize(root);
                    for (int i = 0; i < count; i++) {
                        cJSON* itm = cJSON_GetArrayItem(root, i);
                        if (itm && cJSON_IsString(itm)) {
                            ids.push_back(strtoul(itm->valuestring, nullptr, 0));
                        } else if (itm && cJSON_IsNumber(itm)) {
                            ids.push_back((uint32_t)itm->valueint);
                        }
                    }
                    mqtt_mgr_set_monitored_ids(ids, true);
                    ESP_LOGI(TAG, "Updated monitored CAN IDs (%d IDs)", (int)ids.size());
                }
                if (root) cJSON_Delete(root);
            } else if (is_set_cmd) {
                std::string entity_id = suffix.substr(4);
                if (s_mqtt_cmd_queue) {
                    MqttSetCmd cmd = {};
                    strncpy(cmd.entity_id, entity_id.c_str(), sizeof(cmd.entity_id) - 1);
                    strncpy(cmd.payload, payload.c_str(), sizeof(cmd.payload) - 1);
                    if (xQueueSend(s_mqtt_cmd_queue, &cmd, 0) != pdTRUE) {
                        ESP_LOGW(TAG, "MQTT cmd queue full, dropping /set/%s", cmd.entity_id);
                    }
                } else {
                    ESP_LOGW(TAG, "MQTT cmd queue not initialized");
                }
            }
            break;
        }
        case MQTT_EVENT_ERROR:
            s_mqtt_connected = false;
            break;
        default:
            break;
    }
}

static bool s_mqtt_initialized = false;

static void load_settings_from_fs(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);

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

    if (len <= 0) {
        fclose(f);
        s_mqtt_initialized = true;
        return;
    }

    std::string content(len, '\0');
    fread(&content[0], 1, len, f);
    fclose(f);

    cJSON* root = cJSON_Parse(content.c_str());
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
#if CONFIG_SPIRAM
            if (xTaskCreateWithCaps(mqtt_pub_worker_task, "mqtt_pub", 4096, nullptr, 3, nullptr, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
                xTaskCreate(mqtt_pub_worker_task, "mqtt_pub", 3072, nullptr, 3, nullptr);
            }
#else
            xTaskCreate(mqtt_pub_worker_task, "mqtt_pub", 3072, nullptr, 3, nullptr);
#endif
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
            xTaskCreate(mqtt_cmd_worker_task, "mqtt_cmd", 4096, nullptr, 4, nullptr);
        }
    }
}

void mqtt_mgr_start(void) {
    if (!s_mqtt_initialized) {
        load_settings_from_fs();
    }
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);
    if (!s_mqtt_cfg.enabled || s_mqtt_cfg.broker_url.empty()) return;

    if (global_mqtt_client) {
        esp_mqtt_client_reconnect(global_mqtt_client);
        return;
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

    s_lwt_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/status";
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
    mqtt_cfg.buffer.out_size = 2048;
    mqtt_cfg.outbox.limit = 4096;
    mqtt_cfg.task.stack_size = 6144;

    global_mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    if (!global_mqtt_client) {
        ESP_LOGE(TAG, "esp_mqtt_client_init failed (free=%lu, internal=%lu)",
                 (unsigned long)esp_get_free_heap_size(),
                 (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        return;
    }
    esp_err_t err = esp_mqtt_client_register_event(global_mqtt_client, MQTT_EVENT_ANY, mqtt_event_handler, nullptr);
    if (err == ESP_OK) {
        err = esp_mqtt_client_start(global_mqtt_client);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "MQTT client start failed (%s; free=%lu, internal=%lu)",
                 esp_err_to_name(err),
                 (unsigned long)esp_get_free_heap_size(),
                 (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        esp_mqtt_client_destroy(global_mqtt_client);
        global_mqtt_client = nullptr;
    }
}

void mqtt_mgr_stop(void) {
    std::lock_guard<std::mutex> lock(s_mqtt_mutex);
    if (global_mqtt_client) {
        s_mqtt_connected.store(false, std::memory_order_relaxed);
        esp_mqtt_client_handle_t client = global_mqtt_client;
        esp_mqtt_client_stop(client);
        {
            std::lock_guard<std::mutex> pub_lock(s_mqtt_pub_mutex);
            global_mqtt_client = nullptr;
            if (s_mqtt_pub_queue) {
                MqttPubItem item;
                while (xQueueReceive(s_mqtt_pub_queue, &item, 0) == pdTRUE) {
                    if (item.heap_data) {
                        free(item.heap_data);
                    }
                }
            }
        }
        esp_mqtt_client_destroy(client);
    }
}

void mqtt_mgr_on_wifi_disconnect(void) {
    s_mqtt_connected.store(false, std::memory_order_relaxed);
}

void mqtt_mgr_on_wifi_connect(void) {
    if (!global_mqtt_client) {
        mqtt_mgr_start();
    } else if (!s_mqtt_connected.load(std::memory_order_relaxed)) {
        esp_mqtt_client_reconnect(global_mqtt_client);
    }
}

void mqtt_mgr_watchdog(void) {
    if (!global_mqtt_client) {
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
    {
        std::lock_guard<std::mutex> lock(s_mqtt_mutex);
        if (s_mqtt_cfg.ha_discovery_enabled && !cfg.ha_discovery_enabled) {
            s_need_clear_discovery.store(true);
        }
        s_mqtt_cfg = cfg;

        cJSON* root = cJSON_CreateObject();
        cJSON_AddBoolToObject(root, "enabled", s_mqtt_cfg.enabled);
        cJSON_AddBoolToObject(root, "ha_discovery", s_mqtt_cfg.ha_discovery_enabled);
        cJSON_AddStringToObject(root, "broker_url", s_mqtt_cfg.broker_url.c_str());
        cJSON_AddStringToObject(root, "username", s_mqtt_cfg.username.c_str());
        cJSON_AddStringToObject(root, "password", s_mqtt_cfg.password.c_str());

        char* rendered = cJSON_Print(root);
        cJSON_Delete(root);

        if (rendered) {
            FILE* f = fopen(MQTT_CONFIG_FILE, "w");
            if (f) {
                fputs(rendered, f);
                fclose(f);
            }
            free(rendered);
        }
    }

    mqtt_mgr_stop();
    if (cfg.enabled) {
        mqtt_mgr_start();
    }
    return true;
}

static std::vector<AutomationRule> snapshot_automations_for_mqtt(void) {
    std::lock_guard<std::mutex> lock(g_automations_mutex);
    return global_automations;
}

static void refresh_automation_discovery_locked_check(void) {
    bool disco_en = false;
    std::unordered_set<std::string> prev_exposed;
    {
        std::lock_guard<std::mutex> lock(s_mqtt_mutex);
        disco_en = s_mqtt_cfg.ha_discovery_enabled;
        prev_exposed = s_exposed_auto_ids;
    }
    if (!disco_en) return;

    std::vector<AutomationRule> rules_snapshot = snapshot_automations_for_mqtt();
    std::unordered_set<std::string> new_exposed;
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

static void mqtt_auto_reload_task(void* arg) {
    while (s_auto_reload_pending.exchange(false)) {
        rtc_crash_record_event("auto_reload");
        if (s_auto_parse_tmp_pending.exchange(false)) {
            std::string status_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/config/automations/status";
            bool valid = false;
            struct stat st;
            if (stat("/spiffs/automations.json.tmp", &st) == 0 && st.st_size > 0 && st.st_size <= 32768) {
                valid = load_automations_from_fs("/spiffs/automations.json.tmp");
            }
            if (valid) {
                unlink("/spiffs/automations.json");
                rename("/spiffs/automations.json.tmp", "/spiffs/automations.json");
                mqtt_enqueue_nonblocking(status_topic.c_str(), "{\"status\":\"ok\"}", 15, 0, 0);
            } else {
                unlink("/spiffs/automations.json.tmp");
                mqtt_enqueue_nonblocking(status_topic.c_str(), "{\"status\":\"error\",\"message\":\"Invalid JSON syntax\"}", 50, 0, 0);
                continue;
            }
        }
        if (!global_mqtt_client || !s_mqtt_connected.load()) break;
        publish_automations_json_state();
        refresh_automation_discovery_locked_check();
    }
    s_auto_reload_task_running.store(false);
    vTaskDelete(NULL);
}

void mqtt_mgr_on_automations_reloaded(void) {
    if (!s_auto_parse_tmp_pending.load(std::memory_order_relaxed) &&
        (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed))) return;
    s_auto_reload_pending.store(true);
    if (!s_auto_reload_task_running.exchange(true)) {
        if (xTaskCreate(mqtt_auto_reload_task, "mqtt_auto", 6144, nullptr, 2, nullptr) != pdPASS) {
            s_auto_reload_task_running.store(false);
        }
    }
}

void mqtt_mgr_publish_discovery(void) {
    if (global_mqtt_client && s_mqtt_connected.load()) {
        stream_catalog_entities([](const CanEntity& entity) -> bool {
            if (!global_mqtt_client || !s_mqtt_connected.load()) return false;
            publish_ha_discovery(global_mqtt_client, entity);
            vTaskDelay(pdMS_TO_TICKS(25));
            return true;
        });

        std::vector<AutomationRule> rules_snapshot = snapshot_automations_for_mqtt();
        std::unordered_set<std::string> new_exposed;
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

void mqtt_mgr_clear_discovery(void) {
    if (global_mqtt_client && s_mqtt_connected.load()) {
        stream_catalog_entities([](const CanEntity& entity) -> bool {
            if (!global_mqtt_client || !s_mqtt_connected.load()) return false;
            clear_ha_discovery(global_mqtt_client, entity);
            vTaskDelay(pdMS_TO_TICKS(15));
            return true;
        });

        std::vector<AutomationRule> rules_snapshot = snapshot_automations_for_mqtt();
        for (const auto& rule : rules_snapshot) {
            if (!global_mqtt_client || !s_mqtt_connected.load()) break;
            clear_ha_automation_discovery(global_mqtt_client, rule);
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

    char val_str[16];
    int len = snprintf(val_str, sizeof(val_str), "%.1f", vbat);
    if (len <= 0) return;

    // Publish to vbat and cond_aux_12v_battery topics (do NOT overwrite raw 8-byte hex 0x1CF topic!)
    std::string vbat_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/vbat";
    mqtt_enqueue_nonblocking(vbat_topic.c_str(), val_str, len, 0, 1);

    std::string entity_topic = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/cond_aux_12v_battery";
    mqtt_enqueue_nonblocking(entity_topic.c_str(), val_str, len, 0, 1);

    std::string ha_state_topic = MQTT_BASE_TOPIC + "/state/cond_aux_12v_battery";
    mqtt_enqueue_nonblocking(ha_state_topic.c_str(), val_str, len, 0, 1);
}

void mqtt_mgr_publish_bms(float kw, float soc, float v, float a, float delta_mv, int min_t, int max_t) {
    if (!global_mqtt_client || !s_mqtt_connected.load(std::memory_order_relaxed)) return;
    (void)min_t;
    (void)max_t;

    char val_str[32];
    int len;

    len = snprintf(val_str, sizeof(val_str), "%.2f", kw);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_power_kw").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_hv_power_kw").c_str(), val_str, len, 0, 1);

    len = snprintf(val_str, sizeof(val_str), "%.1f", soc);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_display_soc").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_display_soc").c_str(), val_str, len, 0, 1);

    len = snprintf(val_str, sizeof(val_str), "%.1f", v);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_voltage").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_hv_voltage").c_str(), val_str, len, 0, 1);

    len = snprintf(val_str, sizeof(val_str), "%.1f", a);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_hv_current").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_hv_current").c_str(), val_str, len, 0, 1);

    len = snprintf(val_str, sizeof(val_str), "%.0f", delta_mv);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/state/bms_cell_delta_mv").c_str(), val_str, len, 0, 1);
    mqtt_enqueue_nonblocking((MQTT_BASE_TOPIC + "/state/bms_cell_delta_mv").c_str(), val_str, len, 0, 1);
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
        std::string topic_dev = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/ble_button";
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
        std::string topic_dev = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/ble_device";
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
        std::string topic_dev = MQTT_BASE_TOPIC + "/" + DEVICE_ID + "/ble_beacon";
        mqtt_enqueue_nonblocking(topic_dev.c_str(), payload, (int)strlen(payload), 0, 0);
        free(payload);
    }
    cJSON_Delete(root);
}
