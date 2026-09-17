#include <cstdio>
#include <string>
#include <vector>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_system.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "driver/twai.h"
#include "esp_littlefs.h"
#include "esp_sntp.h"
#include "mqtt_client.h"
#include <ctime>
#include <sys/time.h>

#include "types.h"
#include "parser.h"
#include "can_engine.h"
#include "api.h"
#include "track_popup.h"
#include "precondition.h"

static const char* TAG = "MAIN";

const std::string DEVICE_ID = "cando_vehicle";
const std::string MQTT_BASE_TOPIC = "cando";
esp_mqtt_client_handle_t global_mqtt_client = nullptr;

static esp_err_t init_fs(void) {
    esp_vfs_littlefs_conf_t conf = {
        .base_path = "/spiffs",
        .partition_label = "storage",
        .format_if_mount_failed = true,
        .dont_mount = false
    };
    esp_err_t ret = esp_vfs_littlefs_register(&conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to mount LittleFS (%s)", esp_err_to_name(ret));
    }
    return ret;
}

static esp_err_t init_twai(void) {
    twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(GPIO_NUM_4, GPIO_NUM_5, TWAI_MODE_NORMAL);
    twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
    twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

    esp_err_t ret = twai_driver_install(&g_config, &t_config, &f_config);
    if (ret != ESP_OK) return ret;
    return twai_start();
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

    std::string cmd_topic = MQTT_BASE_TOPIC + "/set/" + entity.id;
    std::string state_topic = MQTT_BASE_TOPIC + "/state/" + entity.id;
    cJSON_AddStringToObject(root, "command_topic", cmd_topic.c_str());
    cJSON_AddStringToObject(root, "state_topic", state_topic.c_str());

    cJSON *device = cJSON_AddObjectToObject(root, "device");
    cJSON *identifiers = cJSON_AddArrayToObject(device, "identifiers");
    cJSON_AddItemToArray(identifiers, cJSON_CreateString(DEVICE_ID.c_str()));
    cJSON_AddStringToObject(device, "name", "CAN Do Vehicle");
    cJSON_AddStringToObject(device, "manufacturer", "CAN Do");
    cJSON_AddStringToObject(device, "model", "E-GMP");

    char *payload = cJSON_PrintUnformatted(root);
    std::string topic = "homeassistant/" + entity.ha_domain + "/" + DEVICE_ID + "/" + entity.id + "/config";
    esp_mqtt_client_publish(client, topic.c_str(), payload, 0, 1, 1);

    cJSON_Free(payload);
    cJSON_Delete(root);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    auto event = static_cast<esp_mqtt_event_handle_t>(event_data);
    switch (event->event_id) {
        case MQTT_EVENT_CONNECTED:
            ESP_LOGI(TAG, "MQTT connected. Publishing discovery & subscribing...");
            esp_mqtt_client_subscribe(global_mqtt_client, (MQTT_BASE_TOPIC + "/set/#").c_str(), 1);
            for (const auto& entity : global_catalog) {
                publish_ha_discovery(global_mqtt_client, entity);
            }
            break;

        case MQTT_EVENT_DATA: {
            std::string topic(event->topic, event->topic_len);
            std::string payload(event->data, event->data_len);
            std::string base_path = MQTT_BASE_TOPIC + "/set/";
            if (topic.rfind(base_path, 0) == 0) {
                std::string entity_id = topic.substr(base_path.length());
                queue_entity_command(entity_id, payload);
            }
            break;
        }
        default:
            break;
    }
}

#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"

#ifdef CONFIG_CAN_DO_DEVICE_IDENTIFIER
const std::string DEVICE_ID = CONFIG_CAN_DO_DEVICE_IDENTIFIER;
#else
const std::string DEVICE_ID = "cando_vehicle";
#endif

static void start_mqtt(void) {
#if defined(CONFIG_CAN_DO_MQTT_BROKER_URL) && !defined(CONFIG_CAN_DO_MQTT_DISABLE)
    if (global_mqtt_client) return;
    esp_mqtt_client_config_t mqtt_cfg = {};
    mqtt_cfg.broker.address.uri = CONFIG_CAN_DO_MQTT_BROKER_URL;
#if defined(CONFIG_CAN_DO_MQTT_USERNAME)
    mqtt_cfg.credentials.username = CONFIG_CAN_DO_MQTT_USERNAME;
#endif
#if defined(CONFIG_CAN_DO_MQTT_PASSWORD)
    mqtt_cfg.credentials.authentication.password = CONFIG_CAN_DO_MQTT_PASSWORD;
#endif
    global_mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(global_mqtt_client, MQTT_EVENT_ANY, mqtt_event_handler, nullptr);
    esp_mqtt_client_start(global_mqtt_client);
    ESP_LOGI(TAG, "MQTT client started for broker: %s", CONFIG_CAN_DO_MQTT_BROKER_URL);
#endif
}

static void init_sntp(void) {
    ESP_LOGI(TAG, "Initializing SNTP time synchronization (pool.ntp.org)...");
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "pool.ntp.org");
    esp_sntp_init();
}

#include "network_mgr.h"
#include "gvret_server.h"

static void app_ip_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data) {
    if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        auto event = static_cast<ip_event_got_ip_t*>(event_data);
        ESP_LOGI(TAG, "Network ready. IP: " IPSTR, IP2STR(&event->ip_info.ip));
        init_sntp();
        start_mqtt();
    }
}

extern "C" void app_main(void) {
    ESP_LOGI(TAG, "CAN Do ESP32 Firmware starting...");

    // 1. NVS flash
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // 2. Mount LittleFS and load catalog (edge-first: offline execution guaranteed)
    init_fs();
    if (!load_catalog_from_fs("/spiffs/catalog/can_do_catalog.json")) {
        load_catalog_from_fs("/spiffs/can_do_catalog.json");
    }
    // Load active user automations from dedicated LittleFS storage
    load_automations_from_fs("/spiffs/automations.json");

    // 3. Init TWAI (CAN)
    ESP_ERROR_CHECK(init_twai());

    // 3b. Init Cluster Track Selection Popup & Preconditioning Subsystems
    precondition_init();

    // 4. Command Queues and Tasks
    init_can_engine();
    xTaskCreate(can_rx_task, "CAN_RX", 4096, nullptr, 5, nullptr);
    xTaskCreate(can_tx_task, "CAN_TX", 4096, nullptr, 4, nullptr);
    xTaskCreate(time_scheduler_task, "TIME_SCHED", 3072, nullptr, 3, nullptr);

    // 5. Start Web Server and WS Hook
    start_webserver();

    // 6. Network connectivity (Multi-SSID Roaming, Auto-AP Fallback, 192.168.4.1)
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &app_ip_event_handler, nullptr, nullptr));
    network_mgr_init();

    // 7. Start GVRET TCP Port 23 Server (SavvyCAN / SavvyLens)
    gvret_server_init(23);

    ESP_LOGI(TAG, "Initialization complete. Ready.");
}

