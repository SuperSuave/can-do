#include "network_mgr.h"
#include "mqtt_mgr.h"
#include "can_engine.h"
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <mutex>
#include <atomic>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_system.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "cJSON.h"
#include "lwip/ip4_addr.h"
#include "board_pins.h"

static const char* TAG = "NET_MGR";
static const char* NETWORKS_FILE = "/spiffs/networks.json";

extern std::string g_device_id;

static esp_netif_t* s_netif_sta = nullptr;
static esp_netif_t* s_netif_ap = nullptr;

static std::mutex s_net_mutex;
static std::vector<KnownNetwork> s_known_networks;
static std::vector<WifiScanResult> s_scan_results;
static std::atomic<bool> s_is_scanning{false};
static std::atomic<bool> s_sta_connected{false};
static std::atomic<bool> s_ap_active{false};

static ApFallbackMode s_ap_mode = AP_MODE_AUTO;
static std::string s_ap_ssid = "CAN Do";
static std::string s_ap_pass = "candorules";

static std::string s_cur_sta_ssid = "";
static std::string s_last_connected_ssid = "";
static int s_last_connected_prio = 0;
static std::string s_cur_sta_ip = "0.0.0.0";
static std::string s_cur_sta_gw = "0.0.0.0";
static std::string s_cur_sta_mask = "0.0.0.0";
static std::atomic<int8_t> s_cur_sta_rssi{0};

static EventGroupHandle_t s_wifi_event_group;
static const int WIFI_CONNECTED_BIT    = BIT0;
static const int WIFI_FAIL_BIT         = BIT1;
static const int WIFI_SCAN_DONE_BIT    = BIT2;
// Deferred worker bits so sys_evt task NEVER runs heavy MQTT/CAN/SoftAP logic
static const int DEFER_GOT_IP_BIT      = BIT3;
static const int DEFER_DISCONN_BIT     = BIT4;
static const int DEFER_AP_STACONN_BIT  = BIT5;
static const int DEFER_AP_STADISC_BIT  = BIT6;

static char s_deferred_ap_mac[18] = {0};

// Forward declarations
static void load_settings_from_fs(void);
static void save_settings_to_fs(void);
static void start_softap(void);
static void stop_softap(void);
static void wifi_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data);
static void network_roam_task(void* pvParameters);

static void load_settings_from_fs(void) {
    std::lock_guard<std::mutex> lock(s_net_mutex);
    s_known_networks.clear();

    FILE* f = fopen(NETWORKS_FILE, "r");
    if (!f) {
        ESP_LOGI(TAG, "No networks.json found, creating defaults");
#ifdef CONFIG_CAN_DO_WIFI_SSID
        if (strlen(CONFIG_CAN_DO_WIFI_SSID) > 0) {
            KnownNetwork def;
            def.ssid = CONFIG_CAN_DO_WIFI_SSID;
#ifdef CONFIG_CAN_DO_WIFI_PASSWORD
            def.password = CONFIG_CAN_DO_WIFI_PASSWORD;
#else
            def.password = "";
#endif
            def.priority = 50;
            s_known_networks.push_back(def);
        }
#endif
        return;
    }

    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (len <= 0) {
        fclose(f);
        return;
    }

    std::string content(len, '\0');
    fread(&content[0], 1, len, f);
    fclose(f);

    cJSON* root = cJSON_Parse(content.c_str());
    if (!root) return;

    cJSON* ap_mode_item = cJSON_GetObjectItem(root, "ap_mode");
    if (cJSON_IsString(ap_mode_item)) {
        if (strcmp(ap_mode_item->valuestring, "always_on") == 0) s_ap_mode = AP_MODE_ALWAYS_ON;
        else if (strcmp(ap_mode_item->valuestring, "disabled") == 0) s_ap_mode = AP_MODE_DISABLED;
        else s_ap_mode = AP_MODE_AUTO;
    }

    cJSON* ap_ssid_item = cJSON_GetObjectItem(root, "ap_ssid");
    if (cJSON_IsString(ap_ssid_item) && strlen(ap_ssid_item->valuestring) > 0) {
        s_ap_ssid = ap_ssid_item->valuestring;
    }

    cJSON* ap_pass_item = cJSON_GetObjectItem(root, "ap_password");
    if (cJSON_IsString(ap_pass_item)) {
        s_ap_pass = ap_pass_item->valuestring;
    }

    cJSON* networks_arr = cJSON_GetObjectItem(root, "known_networks");
    if (cJSON_IsArray(networks_arr)) {
        int count = cJSON_GetArraySize(networks_arr);
        for (int i = 0; i < count; i++) {
            cJSON* net_item = cJSON_GetArrayItem(networks_arr, i);
            cJSON* ssid = cJSON_GetObjectItem(net_item, "ssid");
            cJSON* pass = cJSON_GetObjectItem(net_item, "password");
            cJSON* prio = cJSON_GetObjectItem(net_item, "priority");

            if (cJSON_IsString(ssid) && strlen(ssid->valuestring) > 0) {
                KnownNetwork kn;
                kn.ssid = ssid->valuestring;
                kn.password = cJSON_IsString(pass) ? pass->valuestring : "";
                kn.priority = cJSON_IsNumber(prio) ? prio->valueint : 50;
                s_known_networks.push_back(kn);
            }
        }
    }

    cJSON_Delete(root);
    ESP_LOGI(TAG, "Loaded %d known networks from %s (AP mode=%d)", (int)s_known_networks.size(), NETWORKS_FILE, (int)s_ap_mode);
}

static void save_settings_to_fs(void) {
    cJSON* root = cJSON_CreateObject();
    {
        std::lock_guard<std::mutex> lock(s_net_mutex);
        const char* ap_mode_str = "auto";
        if (s_ap_mode == AP_MODE_ALWAYS_ON) ap_mode_str = "always_on";
        else if (s_ap_mode == AP_MODE_DISABLED) ap_mode_str = "disabled";
        cJSON_AddStringToObject(root, "ap_mode", ap_mode_str);
        cJSON_AddStringToObject(root, "ap_ssid", s_ap_ssid.c_str());
        cJSON_AddStringToObject(root, "ap_password", s_ap_pass.c_str());

        cJSON* arr = cJSON_AddArrayToObject(root, "known_networks");
        for (const auto& net : s_known_networks) {
            cJSON* item = cJSON_CreateObject();
            cJSON_AddStringToObject(item, "ssid", net.ssid.c_str());
            cJSON_AddStringToObject(item, "password", net.password.c_str());
            cJSON_AddNumberToObject(item, "priority", net.priority);
            cJSON_AddItemToArray(arr, item);
        }
    }

    char* rendered = cJSON_Print(root);
    cJSON_Delete(root);

    if (!rendered) return;

    FILE* f = fopen(NETWORKS_FILE, "w");
    if (f) {
        fputs(rendered, f);
        fclose(f);
        ESP_LOGI(TAG, "Saved network settings to %s", NETWORKS_FILE);
    } else {
        ESP_LOGE(TAG, "Failed to open %s for write", NETWORKS_FILE);
    }
    free(rendered);
}

static void start_softap(void) {
    if (s_ap_mode == AP_MODE_DISABLED) return;

    wifi_config_t ap_config = {};
    {
        std::lock_guard<std::mutex> lock(s_net_mutex);
        strncpy(reinterpret_cast<char*>(ap_config.ap.ssid), s_ap_ssid.c_str(), sizeof(ap_config.ap.ssid) - 1);
        strncpy(reinterpret_cast<char*>(ap_config.ap.password), s_ap_pass.c_str(), sizeof(ap_config.ap.password) - 1);
        ap_config.ap.authmode = s_ap_pass.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
    }
    ap_config.ap.max_connection = 4;
    ap_config.ap.channel = 1;
    ap_config.ap.ssid_hidden = 0;

    wifi_mode_t mode = WIFI_MODE_NULL;
    esp_wifi_get_mode(&mode);
    if (mode == WIFI_MODE_STA) {
        esp_wifi_set_mode(WIFI_MODE_APSTA);
    } else if (mode != WIFI_MODE_APSTA) {
        esp_wifi_set_mode(WIFI_MODE_AP);
    }

    esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    s_ap_active = true;
    board_led_wifi(true);
    ESP_LOGI(TAG, "SoftAP active: Gateway=192.168.4.1");
}

static void stop_softap(void) {
    if (!s_ap_active) return;

    wifi_mode_t mode = WIFI_MODE_NULL;
    esp_wifi_get_mode(&mode);
    if (mode == WIFI_MODE_APSTA) {
        esp_wifi_set_mode(WIFI_MODE_STA);
    } else if (mode == WIFI_MODE_AP) {
        esp_wifi_set_mode(WIFI_MODE_NULL);
    }
    s_ap_active = false;
    if (!s_sta_connected) board_led_wifi(false);
    ESP_LOGI(TAG, "SoftAP disabled to save power and eliminate 2.4GHz RF contention");
}

// Lightweight, non-blocking event handler: NEVER call MQTT, LittleFS, or CAN engine directly on sys_evt stack!
static void wifi_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data) {
    if (event_base == WIFI_EVENT) {
        if (event_id == WIFI_EVENT_STA_START || event_id == WIFI_EVENT_STA_CONNECTED) {
            esp_wifi_set_ps(WIFI_PS_NONE);
        } else if (event_id == WIFI_EVENT_STA_DISCONNECTED) {
            bool was_connected = s_sta_connected.exchange(false);
            {
                std::lock_guard<std::mutex> lock(s_net_mutex);
                s_cur_sta_ip = "0.0.0.0";
            }
            if (!s_ap_active) board_led_wifi(false);

            auto* disc = static_cast<wifi_event_sta_disconnected_t*>(event_data);
            ESP_LOGW(TAG, "Wi-Fi disconnected (reason %d)", disc ? disc->reason : -1);

            if (was_connected) {
                xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT | DEFER_DISCONN_BIT);
            } else {
                xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
            }
        } else if (event_id == WIFI_EVENT_AP_STACONNECTED) {
            auto* event = static_cast<wifi_event_ap_staconnected_t*>(event_data);
            {
                std::lock_guard<std::mutex> lock(s_net_mutex);
                snprintf(s_deferred_ap_mac, sizeof(s_deferred_ap_mac), "%02X:%02X:%02X:%02X:%02X:%02X",
                         event->mac[0], event->mac[1], event->mac[2],
                         event->mac[3], event->mac[4], event->mac[5]);
            }
            xEventGroupSetBits(s_wifi_event_group, DEFER_AP_STACONN_BIT);
        } else if (event_id == WIFI_EVENT_AP_STADISCONNECTED) {
            auto* event = static_cast<wifi_event_ap_stadisconnected_t*>(event_data);
            {
                std::lock_guard<std::mutex> lock(s_net_mutex);
                snprintf(s_deferred_ap_mac, sizeof(s_deferred_ap_mac), "%02X:%02X:%02X:%02X:%02X:%02X",
                         event->mac[0], event->mac[1], event->mac[2],
                         event->mac[3], event->mac[4], event->mac[5]);
            }
            xEventGroupSetBits(s_wifi_event_group, DEFER_AP_STADISC_BIT);
        } else if (event_id == WIFI_EVENT_SCAN_DONE) {
            s_is_scanning = false;
            xEventGroupSetBits(s_wifi_event_group, WIFI_SCAN_DONE_BIT);
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        esp_wifi_set_ps(WIFI_PS_NONE);
        auto* event = static_cast<ip_event_got_ip_t*>(event_data);
        char ip_str[16], gw_str[16], mask_str[16];
        esp_ip4addr_ntoa(&event->ip_info.ip, ip_str, sizeof(ip_str));
        esp_ip4addr_ntoa(&event->ip_info.gw, gw_str, sizeof(gw_str));
        esp_ip4addr_ntoa(&event->ip_info.netmask, mask_str, sizeof(mask_str));

        {
            std::lock_guard<std::mutex> lock(s_net_mutex);
            s_cur_sta_ip = ip_str;
            s_cur_sta_gw = gw_str;
            s_cur_sta_mask = mask_str;
        }
        s_sta_connected = true;
        board_led_wifi(true);

        wifi_ap_record_t ap_info;
        if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
            s_cur_sta_rssi.store(ap_info.rssi);
        }

        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT | DEFER_GOT_IP_BIT);
    }
}

static void process_deferred_network_events(void) {
    EventBits_t bits = xEventGroupClearBits(s_wifi_event_group,
        DEFER_GOT_IP_BIT | DEFER_DISCONN_BIT | DEFER_AP_STACONN_BIT | DEFER_AP_STADISC_BIT);

    if (bits & DEFER_DISCONN_BIT) {
        std::string ssid_copy;
        {
            std::lock_guard<std::mutex> lock(s_net_mutex);
            ssid_copy = s_cur_sta_ssid;
        }
        mqtt_mgr_on_wifi_disconnect();
        can_engine_on_device_event("wifi_disconnected", ssid_copy, 0);
    }

    if (bits & DEFER_GOT_IP_BIT) {
        std::string ssid_copy, ip_copy;
        {
            std::lock_guard<std::mutex> lock(s_net_mutex);
            ssid_copy = s_cur_sta_ssid;
            ip_copy = s_cur_sta_ip;
            s_last_connected_ssid = s_cur_sta_ssid;
            for (const auto& kn : s_known_networks) {
                if (kn.ssid == s_cur_sta_ssid) {
                    s_last_connected_prio = kn.priority;
                    break;
                }
            }
        }
        int8_t rssi = s_cur_sta_rssi.load();
        ESP_LOGI(TAG, "Connected to '%s' (IP: %s, RSSI: %d dBm)", ssid_copy.c_str(), ip_copy.c_str(), (int)rssi);

        if (s_ap_mode == AP_MODE_AUTO && s_ap_active) {
            vTaskDelay(pdMS_TO_TICKS(250));
            stop_softap();
        }
        mqtt_mgr_on_wifi_connect();
        can_engine_on_device_event("wifi_connected", ssid_copy, rssi);
    }

    if (bits & DEFER_AP_STACONN_BIT) {
        char mac_copy[18];
        {
            std::lock_guard<std::mutex> lock(s_net_mutex);
            memcpy(mac_copy, s_deferred_ap_mac, sizeof(mac_copy));
        }
        int8_t sta_rssi = -50;
        wifi_sta_list_t sta_list = {};
        if (esp_wifi_ap_get_sta_list(&sta_list) == ESP_OK && sta_list.num > 0) {
            sta_rssi = sta_list.sta[sta_list.num - 1].rssi;
        }
        can_engine_on_device_event("ap_client_connected", mac_copy, sta_rssi);
    }

    if (bits & DEFER_AP_STADISC_BIT) {
        char mac_copy[18];
        {
            std::lock_guard<std::mutex> lock(s_net_mutex);
            memcpy(mac_copy, s_deferred_ap_mac, sizeof(mac_copy));
        }
        can_engine_on_device_event("ap_client_disconnected", mac_copy, 0);
    }
}

static void network_roam_task(void* pvParameters) {
    ESP_LOGI(TAG, "Network roaming & watchdog task started");
    uint8_t high_prio_hold_retries = 0;

    while (true) {
        process_deferred_network_events();

        if (!s_sta_connected) {
            std::vector<KnownNetwork> targets;
            std::string prev_ssid;
            int prev_prio = 0;
            {
                std::lock_guard<std::mutex> lock(s_net_mutex);
                targets = s_known_networks;
                prev_ssid = s_last_connected_ssid;
                prev_prio = s_last_connected_prio;
            }

            if (!targets.empty() && !s_is_scanning) {
                // Ensure STA is cleanly idle before starting an active scan
                esp_wifi_disconnect();
                vTaskDelay(pdMS_TO_TICKS(100));

                s_is_scanning = true;
                xEventGroupClearBits(s_wifi_event_group, WIFI_SCAN_DONE_BIT);

                // Active probe scan with 150-300ms dwell so mobile hotspots respond reliably
                wifi_scan_config_t scan_cfg = {};
                scan_cfg.show_hidden = false;
                scan_cfg.scan_type = WIFI_SCAN_TYPE_ACTIVE;
                scan_cfg.scan_time.active.min = 120;
                scan_cfg.scan_time.active.max = 250;

                if (esp_wifi_scan_start(&scan_cfg, false) == ESP_OK) {
                    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group, WIFI_SCAN_DONE_BIT, pdTRUE, pdFALSE, pdMS_TO_TICKS(6000));
                    if (bits & WIFI_SCAN_DONE_BIT) {
                        uint16_t ap_count = 0;
                        esp_wifi_scan_get_ap_num(&ap_count);
                        if (ap_count > 32) ap_count = 32;
                        std::vector<wifi_ap_record_t> ap_records(ap_count);

                        if (ap_count > 0 && esp_wifi_scan_get_ap_records(&ap_count, ap_records.data()) == ESP_OK) {
                            std::lock_guard<std::mutex> lock(s_net_mutex);
                            s_scan_results.clear();
                            for (uint16_t i = 0; i < ap_count; i++) {
                                char clean_ssid[33] = {0};
                                memcpy(clean_ssid, ap_records[i].ssid, 32);
                                clean_ssid[32] = '\0';
                                if (clean_ssid[0] == '\0') continue;

                                std::string ssid(clean_ssid);
                                // Deduplicate multiple BSSIDs for the same SSID (keep strongest RSSI)
                                bool updated_existing = false;
                                for (auto& existing : s_scan_results) {
                                    if (existing.ssid == ssid) {
                                        if (ap_records[i].rssi > existing.rssi) {
                                            existing.rssi = ap_records[i].rssi;
                                        }
                                        updated_existing = true;
                                        break;
                                    }
                                }
                                if (updated_existing) continue;

                                bool in_known = false;
                                for (const auto& kn : targets) {
                                    if (kn.ssid == ssid) {
                                        in_known = true;
                                        break;
                                    }
                                }
                                s_scan_results.push_back({ssid, ap_records[i].rssi, static_cast<uint8_t>(ap_records[i].authmode), in_known});
                            }
                        }

                        // 2. Rank candidate networks
                        std::vector<std::pair<KnownNetwork, int8_t>> candidates;
                        {
                            std::lock_guard<std::mutex> lock(s_net_mutex);
                            for (const auto& scan_ap : s_scan_results) {
                                for (const auto& kn : targets) {
                                    if (kn.ssid == scan_ap.ssid) {
                                        // Ignore very weak low-priority guest networks (<-82 dBm)
                                        if (scan_ap.rssi < -82 && kn.priority < 50) continue;
                                        candidates.push_back({kn, scan_ap.rssi});
                                        break;
                                    }
                                }
                            }
                        }

                        // Sort by priority DESC, then RSSI DESC
                        std::sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) {
                            if (a.first.priority != b.first.priority) {
                                return a.first.priority > b.first.priority;
                            }
                            return a.second > b.second;
                        });

                        // 3. Sticky Hotspot Hold: if we just dropped from a priority >= 50 network (e.g. mobile hotspot)
                        // and only low-priority (< 50) networks are visible in this scan pass, wait 2 scan cycles
                        // and directly probe the hotspot SSID before falling back to a priority 25 guest network!
                        if (!prev_ssid.empty() && prev_prio >= 50 && high_prio_hold_retries < 2) {
                            bool high_prio_seen = false;
                            for (const auto& c : candidates) {
                                if (c.first.priority >= 50) {
                                    high_prio_seen = true;
                                    break;
                                }
                            }
                            if (!high_prio_seen) {
                                for (const auto& kn : targets) {
                                    if (kn.ssid == prev_ssid) {
                                        high_prio_hold_retries++;
                                        ESP_LOGI(TAG, "Holding for priority %d network '%s' (attempt %u/2) before falling back to lower priority",
                                                 prev_prio, prev_ssid.c_str(), (unsigned)high_prio_hold_retries);
                                        candidates.insert(candidates.begin(), {kn, -70});
                                        break;
                                    }
                                }
                            }
                        }

                        // 4. Attempt association with best ranked candidates
                        bool connected = false;
                        for (const auto& cand : candidates) {
                            // If holding for high-priority network, skip low-priority candidates during hold window
                            if (high_prio_hold_retries > 0 && high_prio_hold_retries <= 2 && cand.first.priority < 50) {
                                continue;
                            }

                            ESP_LOGI(TAG, "Attempting connection to '%s' (Priority=%d, RSSI=%d)",
                                     cand.first.ssid.c_str(), cand.first.priority, cand.second);

                            wifi_config_t sta_config = {};
                            strncpy(reinterpret_cast<char*>(sta_config.sta.ssid), cand.first.ssid.c_str(), sizeof(sta_config.sta.ssid) - 1);
                            strncpy(reinterpret_cast<char*>(sta_config.sta.password), cand.first.password.c_str(), sizeof(sta_config.sta.password) - 1);
                            sta_config.sta.threshold.authmode = cand.first.password.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
                            sta_config.sta.pmf_cfg.capable = true;
                            sta_config.sta.pmf_cfg.required = false;

                            {
                                std::lock_guard<std::mutex> lock(s_net_mutex);
                                s_cur_sta_ssid = cand.first.ssid;
                            }

                            esp_wifi_disconnect();
                            vTaskDelay(pdMS_TO_TICKS(150));
                            xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);

                            esp_wifi_set_config(WIFI_IF_STA, &sta_config);
                            esp_wifi_connect();

                            EventBits_t conn_bits = xEventGroupWaitBits(s_wifi_event_group,
                                WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                pdTRUE, pdFALSE, pdMS_TO_TICKS(8000));

                            if (conn_bits & WIFI_CONNECTED_BIT) {
                                connected = true;
                                high_prio_hold_retries = 0;
                                break;
                            } else {
                                // Cleanly abort in-flight association before moving on
                                esp_wifi_disconnect();
                                vTaskDelay(pdMS_TO_TICKS(100));
                            }
                        }

                        if (!connected && high_prio_hold_retries >= 2) {
                            high_prio_hold_retries = 0; // Release hold so next cycle allows low-priority fallback
                        }
                    } else {
                        s_is_scanning = false;
                    }
                } else {
                    s_is_scanning = false;
                }
            }

            process_deferred_network_events();

            // Fallback SoftAP if disconnected and mode permits
            if (!s_sta_connected && (s_ap_mode == AP_MODE_AUTO || s_ap_mode == AP_MODE_ALWAYS_ON)) {
                if (!s_ap_active) {
                    start_softap();
                }
            }
        }

        // Wait up to 5 seconds, waking immediately if any deferred network event bit fires
        EventBits_t wake_bits = xEventGroupWaitBits(s_wifi_event_group,
            DEFER_GOT_IP_BIT | DEFER_DISCONN_BIT | DEFER_AP_STACONN_BIT | DEFER_AP_STADISC_BIT,
            pdFALSE, pdFALSE, pdMS_TO_TICKS(5000));

        if (wake_bits != 0) {
            process_deferred_network_events();
        }

        if (s_sta_connected) {
            mqtt_mgr_watchdog();
        }
    }
}

esp_err_t network_mgr_init(void) {
    ESP_LOGI(TAG, "Initializing CAN Do Network Manager...");

    s_wifi_event_group = xEventGroupCreate();

    load_settings_from_fs();

    s_netif_sta = esp_netif_create_default_wifi_sta();
    s_netif_ap = esp_netif_create_default_wifi_ap();

    if (!g_device_id.empty()) {
        esp_netif_set_hostname(s_netif_sta, g_device_id.c_str());
        esp_netif_set_hostname(s_netif_ap, g_device_id.c_str());
        ESP_LOGI(TAG, "Network hostname configured: %s", g_device_id.c_str());

        if (s_ap_ssid == "CAN Do") {
            auto dash = g_device_id.find_last_of('-');
            if (dash != std::string::npos) {
                s_ap_ssid = "CAN Do-" + g_device_id.substr(dash + 1);
            }
        }
    }

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, nullptr, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, nullptr, nullptr));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));

    if (s_ap_mode != AP_MODE_DISABLED) {
        wifi_config_t ap_config = {};
        strncpy(reinterpret_cast<char*>(ap_config.ap.ssid), s_ap_ssid.c_str(), sizeof(ap_config.ap.ssid) - 1);
        strncpy(reinterpret_cast<char*>(ap_config.ap.password), s_ap_pass.c_str(), sizeof(ap_config.ap.password) - 1);
        ap_config.ap.authmode = s_ap_pass.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
        ap_config.ap.max_connection = 4;
        ap_config.ap.channel = 1;
        ap_config.ap.ssid_hidden = 0;
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
        s_ap_active = true;
        board_led_wifi(true);
    }

    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);
    ESP_LOGI(TAG, "Wi-Fi started. SoftAP '%s' ready (modem sleep disabled).", s_ap_ssid.c_str());

    // 6144 stack size so deferred MQTT/CAN automation callbacks have plenty of headroom
    xTaskCreate(network_roam_task, "net_roam", 6144, nullptr, 3, nullptr);

    return ESP_OK;
}

NetworkStatusInfo network_mgr_get_status(void) {
    NetworkStatusInfo info;
    info.sta_connected = s_sta_connected.load();
    if (info.sta_connected) {
        wifi_ap_record_t ap_info;
        if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
            s_cur_sta_rssi.store(ap_info.rssi);
        }
    }
    {
        std::lock_guard<std::mutex> lock(s_net_mutex);
        info.sta_ssid = s_cur_sta_ssid;
        info.sta_ip = s_cur_sta_ip;
        info.sta_gw = s_cur_sta_gw;
        info.sta_mask = s_cur_sta_mask;
        info.ap_ssid = s_ap_ssid;
        info.ap_mode = s_ap_mode;
    }
    info.sta_rssi = s_cur_sta_rssi.load();
    info.ap_active = s_ap_active.load();
    info.ap_ip = "192.168.4.1";

    wifi_sta_list_t sta_list;
    if (info.ap_active && esp_wifi_ap_get_sta_list(&sta_list) == ESP_OK) {
        info.ap_clients = sta_list.num;
    } else {
        info.ap_clients = 0;
    }

    return info;
}

std::vector<KnownNetwork> network_mgr_get_known_networks(void) {
    std::lock_guard<std::mutex> lock(s_net_mutex);
    return s_known_networks;
}

bool network_mgr_add_known_network(const std::string& ssid, const std::string& password, int priority) {
    if (ssid.empty()) return false;
    {
        std::lock_guard<std::mutex> lock(s_net_mutex);
        bool found = false;
        for (auto& kn : s_known_networks) {
            if (kn.ssid == ssid) {
                kn.password = password;
                kn.priority = priority;
                found = true;
                break;
            }
        }
        if (!found) {
            s_known_networks.push_back({ssid, password, priority});
        }
    }
    save_settings_to_fs();
    return true;
}

bool network_mgr_remove_known_network(const std::string& ssid) {
    bool removed = false;
    bool is_current = false;
    {
        std::lock_guard<std::mutex> lock(s_net_mutex);
        if (s_sta_connected && s_cur_sta_ssid == ssid) {
            is_current = true;
        }
        auto it = std::remove_if(s_known_networks.begin(), s_known_networks.end(),
            [&ssid](const KnownNetwork& kn) { return kn.ssid == ssid; });
        if (it != s_known_networks.end()) {
            s_known_networks.erase(it, s_known_networks.end());
            removed = true;
        }
    }
    if (removed) {
        save_settings_to_fs();
        if (is_current) {
            ESP_LOGI(TAG, "Active network '%s' removed; disconnecting STA", ssid.c_str());
            esp_wifi_disconnect();
        }
    }
    return removed;
}

void network_mgr_set_ap_mode(ApFallbackMode mode) {
    {
        std::lock_guard<std::mutex> lock(s_net_mutex);
        s_ap_mode = mode;
    }
    save_settings_to_fs();
    if (mode == AP_MODE_DISABLED) {
        stop_softap();
    } else if (mode == AP_MODE_ALWAYS_ON && !s_ap_active) {
        start_softap();
    }
}

ApFallbackMode network_mgr_get_ap_mode(void) {
    std::lock_guard<std::mutex> lock(s_net_mutex);
    return s_ap_mode;
}

void network_mgr_set_ap_credentials(const std::string& ssid, const std::string& password) {
    if (ssid.empty()) return;
    {
        std::lock_guard<std::mutex> lock(s_net_mutex);
        s_ap_ssid = ssid;
        s_ap_pass = password;
    }
    save_settings_to_fs();
    if (s_ap_active) {
        start_softap();
    }
}

bool network_mgr_start_scan(void) {
    if (s_is_scanning.exchange(true)) return false;
    wifi_scan_config_t scan_cfg = {};
    scan_cfg.show_hidden = false;
    scan_cfg.scan_type = WIFI_SCAN_TYPE_ACTIVE;
    scan_cfg.scan_time.active.min = 120;
    scan_cfg.scan_time.active.max = 250;
    esp_err_t err = esp_wifi_scan_start(&scan_cfg, false);
    if (err != ESP_OK) {
        s_is_scanning = false;
        return false;
    }
    return true;
}

bool network_mgr_is_scanning(void) {
    return s_is_scanning.load();
}

std::vector<WifiScanResult> network_mgr_get_scan_results(void) {
    std::lock_guard<std::mutex> lock(s_net_mutex);
    return s_scan_results;
}

std::vector<WifiConnectedStation> network_mgr_get_ap_stations(void) {
    std::vector<WifiConnectedStation> stations;
    if (!s_ap_active) return stations;

    wifi_sta_list_t sta_list = {};
    if (esp_wifi_ap_get_sta_list(&sta_list) == ESP_OK) {
        for (int i = 0; i < sta_list.num; i++) {
            char mac_str[18];
            snprintf(mac_str, sizeof(mac_str), "%02X:%02X:%02X:%02X:%02X:%02X",
                     sta_list.sta[i].mac[0], sta_list.sta[i].mac[1], sta_list.sta[i].mac[2],
                     sta_list.sta[i].mac[3], sta_list.sta[i].mac[4], sta_list.sta[i].mac[5]);
            stations.push_back({mac_str, sta_list.sta[i].rssi});
        }
    }
    return stations;
}
