#include "network_mgr.h"
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

static const char* TAG = "NET_MGR";
static const char* NETWORKS_FILE = "/spiffs/networks.json";

static esp_netif_t* s_netif_sta = nullptr;
static esp_netif_t* s_netif_ap = nullptr;

static std::mutex s_net_mutex;
static std::vector<KnownNetwork> s_known_networks;
static std::vector<WifiScanResult> s_scan_results;
static std::atomic<bool> s_is_scanning{false};
static std::atomic<bool> s_sta_connected{false};
static std::atomic<bool> s_ap_active{false};

static ApFallbackMode s_ap_mode = AP_MODE_AUTO;
static std::string s_ap_ssid = "CAN-Do-Edge";
static std::string s_ap_pass = "candorules";

static std::string s_cur_sta_ssid = "";
static std::string s_cur_sta_ip = "0.0.0.0";
static std::string s_cur_sta_gw = "0.0.0.0";
static std::string s_cur_sta_mask = "0.0.0.0";
static int8_t s_cur_sta_rssi = 0;

static EventGroupHandle_t s_wifi_event_group;
static const int WIFI_CONNECTED_BIT = BIT0;
static const int WIFI_FAIL_BIT      = BIT1;
static const int WIFI_SCAN_DONE_BIT = BIT2;

static int s_retry_num = 0;
static const int MAXIMUM_RETRY = 3;

// Forward declarations
static void load_settings_from_fs(void);
static void save_settings_to_fs(void);
static void configure_softap_ip(void);
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

static void configure_softap_ip(void) {
    if (!s_netif_ap) return;

    // 1. Stop DHCP server while modifying IP addresses
    esp_netif_dhcps_stop(s_netif_ap);

    // 2. Set static IP 192.168.4.1 / 255.255.255.0
    esp_netif_ip_info_t ip_info;
    memset(&ip_info, 0, sizeof(ip_info));
    IP4_ADDR(&ip_info.ip, 192, 168, 4, 1);
    IP4_ADDR(&ip_info.gw, 192, 168, 4, 1);
    IP4_ADDR(&ip_info.netmask, 255, 255, 255, 0);
    ESP_ERROR_CHECK(esp_netif_set_ip_info(s_netif_ap, &ip_info));

    // 3. Restart DHCP server
    esp_netif_dhcps_start(s_netif_ap);
    ESP_LOGI(TAG, "SoftAP IP locked to 192.168.4.1 (Default DHCP pool)");
}

static void start_softap(void) {
    if (s_ap_mode == AP_MODE_DISABLED) return;

    wifi_config_t ap_config = {};
    strncpy(reinterpret_cast<char*>(ap_config.ap.ssid), s_ap_ssid.c_str(), sizeof(ap_config.ap.ssid));
    strncpy(reinterpret_cast<char*>(ap_config.ap.password), s_ap_pass.c_str(), sizeof(ap_config.ap.password));
    ap_config.ap.authmode = s_ap_pass.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
    ap_config.ap.max_connection = 4;
    ap_config.ap.channel = 1;

    wifi_mode_t mode;
    esp_wifi_get_mode(&mode);
    if (mode == WIFI_MODE_STA) {
        esp_wifi_set_mode(WIFI_MODE_APSTA);
    } else if (mode != WIFI_MODE_APSTA) {
        esp_wifi_set_mode(WIFI_MODE_AP);
    }

    esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    s_ap_active = true;
    ESP_LOGI(TAG, "SoftAP active: SSID='%s', Pass='%s', Gateway=192.168.4.1", s_ap_ssid.c_str(), s_ap_pass.c_str());
}

static void stop_softap(void) {
    if (!s_ap_active) return;

    wifi_mode_t mode;
    esp_wifi_get_mode(&mode);
    if (mode == WIFI_MODE_APSTA) {
        esp_wifi_set_mode(WIFI_MODE_STA);
    } else if (mode == WIFI_MODE_AP) {
        esp_wifi_set_mode(WIFI_MODE_NULL);
    }
    s_ap_active = false;
    ESP_LOGI(TAG, "SoftAP disabled to save power and eliminate 2.4GHz RF contention");
}

static void wifi_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data) {
    if (event_base == WIFI_EVENT) {
        if (event_id == WIFI_EVENT_STA_START) {
            ESP_LOGI(TAG, "Wi-Fi STA started");
        } else if (event_id == WIFI_EVENT_STA_DISCONNECTED) {
            s_sta_connected = false;
            s_cur_sta_ip = "0.0.0.0";
            ESP_LOGW(TAG, "Wi-Fi disconnected from '%s'", s_cur_sta_ssid.c_str());

            if (s_retry_num < MAXIMUM_RETRY) {
                esp_wifi_connect();
                s_retry_num++;
                ESP_LOGI(TAG, "Retrying connection... (%d/%d)", s_retry_num, MAXIMUM_RETRY);
            } else {
                xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
            }
        } else if (event_id == WIFI_EVENT_SCAN_DONE) {
            uint16_t ap_count = 0;
            esp_wifi_scan_get_ap_num(&ap_count);
            std::vector<wifi_ap_record_t> ap_records(ap_count);
            if (ap_count > 0) {
                esp_wifi_scan_get_ap_records(&ap_count, ap_records.data());
            }

            {
                std::lock_guard<std::mutex> lock(s_net_mutex);
                s_scan_results.clear();
                for (const auto& ap : ap_records) {
                    std::string ssid(reinterpret_cast<const char*>(ap.ssid));
                    if (ssid.empty()) continue;

                    bool in_known = false;
                    for (const auto& kn : s_known_networks) {
                        if (kn.ssid == ssid) {
                            in_known = true;
                            break;
                        }
                    }
                    s_scan_results.push_back({ssid, ap.rssi, static_cast<uint8_t>(ap.authmode), in_known});
                }
            }

            s_is_scanning = false;
            xEventGroupSetBits(s_wifi_event_group, WIFI_SCAN_DONE_BIT);
            ESP_LOGI(TAG, "Non-blocking Wi-Fi scan completed: found %d APs", ap_count);
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        auto* event = static_cast<ip_event_got_ip_t*>(event_data);
        char ip_str[16], gw_str[16], mask_str[16];
        esp_ip4addr_ntoa(&event->ip_info.ip, ip_str, sizeof(ip_str));
        esp_ip4addr_ntoa(&event->ip_info.gw, gw_str, sizeof(gw_str));
        esp_ip4addr_ntoa(&event->ip_info.netmask, mask_str, sizeof(mask_str));

        s_cur_sta_ip = ip_str;
        s_cur_sta_gw = gw_str;
        s_cur_sta_mask = mask_str;
        s_sta_connected = true;
        s_retry_num = 0;

        wifi_ap_record_t ap_info;
        if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
            s_cur_sta_rssi = ap_info.rssi;
        }

        ESP_LOGI(TAG, "Associated with '%s'. Got IP: %s (GW: %s)", s_cur_sta_ssid.c_str(), ip_str, gw_str);
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);

        if (s_ap_mode == AP_MODE_AUTO) {
            stop_softap();
        }
    }
}

static void network_roam_task(void* pvParameters) {
    ESP_LOGI(TAG, "Network roaming & watchdog task started");

    while (true) {
        if (!s_sta_connected) {
            std::vector<KnownNetwork> targets;
            {
                std::lock_guard<std::mutex> lock(s_net_mutex);
                targets = s_known_networks;
            }

            if (!targets.empty()) {
                // 1. Trigger non-blocking scan
                s_is_scanning = true;
                xEventGroupClearBits(s_wifi_event_group, WIFI_SCAN_DONE_BIT);
                wifi_scan_config_t scan_cfg = {};
                scan_cfg.show_hidden = false;
                esp_err_t scan_err = esp_wifi_scan_start(&scan_cfg, false); // Asynchronous!

                if (scan_err == ESP_OK) {
                    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group, WIFI_SCAN_DONE_BIT, pdTRUE, pdFALSE, pdMS_TO_TICKS(5000));
                    if (bits & WIFI_SCAN_DONE_BIT) {
                        // 2. Rank candidate networks
                        std::vector<std::pair<KnownNetwork, int8_t>> candidates;
                        {
                            std::lock_guard<std::mutex> lock(s_net_mutex);
                            for (const auto& scan_ap : s_scan_results) {
                                for (const auto& kn : targets) {
                                    if (kn.ssid == scan_ap.ssid) {
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

                        // 3. Attempt association with best ranked candidates
                        bool connected = false;
                        for (const auto& cand : candidates) {
                            ESP_LOGI(TAG, "Attempting connection to '%s' (Priority=%d, RSSI=%d)",
                                     cand.first.ssid.c_str(), cand.first.priority, cand.second);

                            wifi_config_t sta_config = {};
                            strncpy(reinterpret_cast<char*>(sta_config.sta.ssid), cand.first.ssid.c_str(), sizeof(sta_config.sta.ssid));
                            strncpy(reinterpret_cast<char*>(sta_config.sta.password), cand.first.password.c_str(), sizeof(sta_config.sta.password));

                            s_cur_sta_ssid = cand.first.ssid;
                            s_retry_num = 0;
                            xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);

                            esp_wifi_set_config(WIFI_IF_STA, &sta_config);
                            esp_wifi_connect();

                            EventBits_t conn_bits = xEventGroupWaitBits(s_wifi_event_group,
                                WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                pdTRUE, pdFALSE, pdMS_TO_TICKS(10000));

                            if (conn_bits & WIFI_CONNECTED_BIT) {
                                connected = true;
                                break;
                            }
                        }

                        if (!connected) {
                            ESP_LOGW(TAG, "Failed connecting to any candidate network");
                        }
                    }
                }
            }

            // Fallback SoftAP if disconnected and mode permits
            if (!s_sta_connected && (s_ap_mode == AP_MODE_AUTO || s_ap_mode == AP_MODE_ALWAYS_ON)) {
                if (!s_ap_active) {
                    start_softap();
                }
            }
        }

        // Periodic roaming / watchdog tick every 10 seconds
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}

esp_err_t network_mgr_init(void) {
    ESP_LOGI(TAG, "Initializing CAN Do Network Manager...");

    s_wifi_event_group = xEventGroupCreate();

    load_settings_from_fs();

    s_netif_sta = esp_netif_create_default_wifi_sta();
    s_netif_ap = esp_netif_create_default_wifi_ap();
    configure_softap_ip();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, nullptr, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, nullptr, nullptr));

    // Default mode: APSTA so both interfaces are ready
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_start());

    // Initially start SoftAP until STA associates
    if (s_ap_mode != AP_MODE_DISABLED) {
        start_softap();
    }

    xTaskCreate(network_roam_task, "net_roam", 4096, nullptr, 3, nullptr);

    return ESP_OK;
}

NetworkStatusInfo network_mgr_get_status(void) {
    NetworkStatusInfo info;
    info.sta_connected = s_sta_connected;
    info.sta_ssid = s_cur_sta_ssid;
    info.sta_ip = s_cur_sta_ip;
    info.sta_gw = s_cur_sta_gw;
    info.sta_mask = s_cur_sta_mask;
    info.sta_rssi = s_cur_sta_rssi;

    info.ap_active = s_ap_active;
    info.ap_ssid = s_ap_ssid;
    info.ap_ip = "192.168.4.1";
    info.ap_mode = s_ap_mode;

    wifi_sta_list_t sta_list;
    if (s_ap_active && esp_wifi_ap_get_sta_list(&sta_list) == ESP_OK) {
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
    {
        std::lock_guard<std::mutex> lock(s_net_mutex);
        auto it = std::remove_if(s_known_networks.begin(), s_known_networks.end(),
            [&ssid](const KnownNetwork& kn) { return kn.ssid == ssid; });
        if (it != s_known_networks.end()) {
            s_known_networks.erase(it, s_known_networks.end());
            removed = true;
        }
    }
    if (removed) {
        save_settings_to_fs();
    }
    return removed;
}

void network_mgr_set_ap_mode(ApFallbackMode mode) {
    s_ap_mode = mode;
    save_settings_to_fs();
    if (mode == AP_MODE_DISABLED) {
        stop_softap();
    } else if (mode == AP_MODE_ALWAYS_ON && !s_ap_active) {
        start_softap();
    }
}

ApFallbackMode network_mgr_get_ap_mode(void) {
    return s_ap_mode;
}

void network_mgr_set_ap_credentials(const std::string& ssid, const std::string& password) {
    if (ssid.empty()) return;
    s_ap_ssid = ssid;
    s_ap_pass = password;
    save_settings_to_fs();
    if (s_ap_active) {
        start_softap(); // reloads with new credentials
    }
}

bool network_mgr_start_scan(void) {
    if (s_is_scanning) return false;
    s_is_scanning = true;
    wifi_scan_config_t scan_cfg = {};
    scan_cfg.show_hidden = false;
    esp_err_t err = esp_wifi_scan_start(&scan_cfg, false); // non-blocking!
    if (err != ESP_OK) {
        s_is_scanning = false;
        return false;
    }
    return true;
}

bool network_mgr_is_scanning(void) {
    return s_is_scanning;
}

std::vector<WifiScanResult> network_mgr_get_scan_results(void) {
    std::lock_guard<std::mutex> lock(s_net_mutex);
    return s_scan_results;
}
