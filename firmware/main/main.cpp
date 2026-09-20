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
#include "board_pins.h"
#include "mqtt_mgr.h"
#include "network_mgr.h"
#include "gvret_server.h"
#include "ble_mgr.h"
#include "vbat_sensor.h"
#include "uds_engine.h"

#include "esp_mac.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "mdns.h"

static const char* TAG = "MAIN";

std::string g_device_id = "can-do";
#define DEVICE_ID g_device_id

static void init_device_id(void) {
#ifdef CONFIG_CAN_DO_DEVICE_IDENTIFIER
    if (strlen(CONFIG_CAN_DO_DEVICE_IDENTIFIER) > 0) {
        g_device_id = CONFIG_CAN_DO_DEVICE_IDENTIFIER;
        ESP_LOGI(TAG, "Device ID configured via Kconfig: %s", g_device_id.c_str());
        return;
    }
#endif
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        char buf[32];
        snprintf(buf, sizeof(buf), "can-do-%02X%02X", mac[4], mac[5]);
        g_device_id = buf;
    } else {
        g_device_id = "can-do-0000";
    }
    ESP_LOGI(TAG, "Device ID initialized from MAC: %s", g_device_id.c_str());
}

static esp_err_t init_fs(void) {
    esp_vfs_littlefs_conf_t conf = {};
    conf.base_path = "/spiffs";
    conf.partition_label = "storage";
    conf.format_if_mount_failed = true;
    conf.dont_mount = false;

    esp_err_t ret = esp_vfs_littlefs_register(&conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to mount LittleFS (%s)", esp_err_to_name(ret));
    }
    return ret;
}

static esp_err_t init_twai(void) {
    twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_NORMAL);
    g_config.rx_queue_len = 64;
    g_config.tx_queue_len = 32;
    g_config.alerts_enabled = TWAI_ALERT_BUS_OFF | TWAI_ALERT_BUS_RECOVERED | TWAI_ALERT_ERR_PASS | TWAI_ALERT_BUS_ERROR | TWAI_ALERT_RX_QUEUE_FULL;
    twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
    twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

    esp_err_t ret = twai_driver_install(&g_config, &t_config, &f_config);
    if (ret != ESP_OK) return ret;
    return twai_start();
}

static void init_sntp(void) {
    ESP_LOGI(TAG, "Initializing SNTP time synchronization (pool.ntp.org)...");
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "pool.ntp.org");
    esp_sntp_init();
}

static void init_mdns(void) {
    esp_err_t err = mdns_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "mDNS init failed: %s", esp_err_to_name(err));
        return;
    }
    mdns_hostname_set(g_device_id.c_str());
    mdns_instance_name_set("CAN Do Vehicle Interface");
    mdns_service_add(nullptr, "_http", "_tcp", 80, nullptr, 0);
    ESP_LOGI(TAG, "mDNS responder started: http://%s.local", g_device_id.c_str());
}

static void app_ip_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data) {
    if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        auto event = static_cast<ip_event_got_ip_t*>(event_data);
        ESP_LOGI(TAG, "Network ready. IP: " IPSTR, IP2STR(&event->ip_info.ip));
        init_sntp();
        init_mdns();
        mqtt_mgr_start();
    }
}

extern "C" void app_main(void) {
    // 0. Initialize WiCAN board hardware (CAN Transceiver STB pin and LEDs)
    board_hardware_init();
    vbat_sensor_init();

    // 1. Core Networking Subsystems (MUST be initialized before any sockets or wifi)
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &app_ip_event_handler, nullptr, nullptr));

    // Initialize unique Device ID from hardware MAC (can-do-[last 4 of MAC])
    init_device_id();

    ESP_LOGI(TAG, "CAN Do ESP32 Firmware starting (Device ID: %s)...", g_device_id.c_str());

    // 2. NVS flash
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // 3. Mount LittleFS and load catalog & automations
    init_fs();
    if (!load_catalog_from_fs("/spiffs/catalog.json")) {
        if (!load_catalog_from_fs("/spiffs/catalog/can_do_catalog.json")) {
            load_catalog_from_fs("/spiffs/can_do_catalog.json");
        }
    }
    load_automations_from_fs("/spiffs/automations.json");
    mqtt_mgr_init();

    // 3.5. Init Bluetooth Low Energy (BLE HID Controller)
    ble_mgr_init();

    // 4. Network connectivity (Multi-SSID Roaming, Auto-AP Fallback, 192.168.4.1)
    network_mgr_init();

    // 5. Start Web Server and WS Hook (now that network stack is running)
    start_webserver();

    // 6. Start GVRET TCP Port 23 Server (SavvyCAN / SavvyLens)
    gvret_server_init(23);

    // 7. Init TWAI (CAN)
    ESP_ERROR_CHECK(init_twai());

    // 8. Init Cluster Track Selection Popup & Preconditioning Subsystems
    precondition_init();

    // 9. Command Queues and Tasks
    init_can_engine();
    uds_engine_init();
    xTaskCreate(can_rx_task, "CAN_RX", 4096, nullptr, 5, nullptr);
    xTaskCreate(can_tx_task, "CAN_TX", 4096, nullptr, 4, nullptr);
    xTaskCreate(time_scheduler_task, "TIME_SCHED", 3072, nullptr, 3, nullptr);

    ESP_LOGI(TAG, "Initialization complete. Ready.");
}

