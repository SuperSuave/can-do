#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include <esp_mac.h>
#include <esp_wifi.h>
#include <esp_netif.h>
#include <LittleFS.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <NimBLEDevice.h>
#include <map>
#include <vector>
#include <mutex>
#include <Update.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// ============================================================================
// Hardware Pin Definitions (M5Stack Atom Lite connected to WiCAN)
// ============================================================================
#define LED_PIN          27      // SK6812 Single RGB LED
#define BUTTON_PIN       39      // Onboard user button (active LOW)

// WiCAN Hardware Link (Rear Header Pins):
// WiCAN TX (Corner pad GPIO 21) -> Atom Lite G21 (RX)
// WiCAN RX (Corner pad GPIO 20) -> Atom Lite G25 (TX)
#define BRIDGE_RX_PIN    21      // Connect to WiCAN TX
#define BRIDGE_TX_PIN    25      // Connect to WiCAN RX
#define UART_BAUD        460800  // High-speed, zero-error UART link

CRGB leds[1];

// ============================================================================
// Web Server & WebSocket
// ============================================================================
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

// State Cache (mirrors latest states from WiCAN)
std::map<String, String> g_state_cache;
static std::mutex g_state_cache_mutex;
unsigned long g_last_wican_rx_ms = 0;
bool g_wican_online = false;

#ifndef CAN_DO_VERSION
#define CAN_DO_VERSION "2026.10.7-b001"
#endif

String g_can_do_version = CAN_DO_VERSION;

// ============================================================================
// BLE Subsystem Data Structures & State
// ============================================================================
bool g_ble_scanning = false;
unsigned long g_ble_scan_start_ms = 0;
unsigned long g_ble_scan_duration_ms = 10000;

struct BleButtonEvent {
    String device_address;
    String device_name;
    String button_name;
    String action; // "press", "release", "hold"
    uint32_t timestamp_ms;
};

struct PairedDevice {
    String address;
    String name;
    int rssi = -60;
    bool connected = false;
    bool bonded = false;
    int battery_pct = 100;
    uint8_t addr_type = 0; // BLE_ADDR_PUBLIC (0) or BLE_ADDR_RANDOM (1)
};

struct DiscoveredDevice {
    String address;
    String name;
    int rssi;
    bool is_connectable;
    uint8_t addr_type = 0;
};

std::vector<DiscoveredDevice> g_discovered_devices;
std::vector<PairedDevice> g_paired_devices;
BleButtonEvent g_last_ble_event = {};
bool g_has_last_event = false;
std::vector<BleButtonEvent> g_recent_ble_events;
std::vector<String> g_held_buttons;
#define BLE_MIN_RSSI_DISCOVERY -70

// Beacon & Proximity Data Structures
struct BeaconTarget {
    String uuid;
    String mac;
    String name = "Phone Beacon";
    int enter_rssi = -75;
    int exit_timeout_s = 10;
    bool is_present = false;
    unsigned long last_seen_ms = 0;
    int last_rssi = -100;
    uint16_t major = 0;
    uint16_t minor = 0;
    unsigned long last_prox_send_ms = 0;
};
std::vector<BeaconTarget> g_beacon_targets;

struct DiscoveredBeacon {
    String uuid;
    String mac;
    int rssi = -100;
    uint16_t major = 0;
    uint16_t minor = 0;
    unsigned long last_seen_ms = 0;
};
std::vector<DiscoveredBeacon> g_discovered_beacons;
Preferences g_beacon_prefs;

NimBLEClient* g_ble_client = nullptr;
bool g_ble_client_connected = false;
String g_connected_device_addr = "";

// Deferred BLE Connection State (prevents deadlocking NimBLE Host task inside onResult)
static std::mutex g_ble_pending_mutex;
static String g_pending_ble_connect_addr = "";
static uint8_t g_pending_ble_connect_type = 0xFF;
static bool g_pending_ble_connect_req = false;

// Thread-Safe WebSocket Outbox Queue (marshals NimBLE & async_tcp events safely into loop())
static std::mutex g_ws_outbox_mutex;
static std::vector<String> g_ws_outbox;

void safe_ws_broadcast(const String& payload) {
    if (ws.count() == 0 || payload.isEmpty()) return;
    std::lock_guard<std::mutex> lock(g_ws_outbox_mutex);
    if (g_ws_outbox.size() < 24) {
        g_ws_outbox.push_back(payload);
    }
}

void flush_ws_outbox() {
    if (ws.count() == 0) {
        std::lock_guard<std::mutex> lock(g_ws_outbox_mutex);
        g_ws_outbox.clear();
        return;
    }
    if (!ws.availableForWriteAll()) return;

    std::vector<String> batch;
    {
        std::lock_guard<std::mutex> lock(g_ws_outbox_mutex);
        if (g_ws_outbox.empty()) return;
        batch.swap(g_ws_outbox);
    }
    for (const auto& msg : batch) {
        if (ws.availableForWriteAll()) {
            ws.textAll(msg);
        } else {
            break; // Drop remaining if client TCP window filled mid-batch
        }
    }
}

// Forward Declarations
void set_led_color(CRGB color);
void update_led_status();
void send_to_wican(const String& line);
void request_wican_states_throttled();
void handle_wican_message(const String& line);
void fire_ble_button_event(const String& addr, const String& name, const String& button, const String& action = "press", const String& combo = "");
void connect_ble_device(const String& address, uint8_t addr_type = 0xFF, NimBLEAdvertisedDevice* pAdvDev = nullptr);
void disconnect_ble_client();
void broadcast_ble_status();
String get_ble_status_json();
void start_ble_scan(uint32_t dur = 10);
void pair_ble_device(const String& addr, String name = "");
void unpair_all_ble_devices();

// ============================================================================
// Preferences / NVS Storage
// ============================================================================
Preferences g_wifi_prefs;
Preferences g_ble_prefs;

void load_paired_ble_devices() {
    g_paired_devices.clear();
    g_ble_prefs.begin("ble_config", true);
    String json_str = g_ble_prefs.getString("paired", "[]");
    g_ble_prefs.end();

    JsonDocument doc;
    if (deserializeJson(doc, json_str) == DeserializationError::Ok) {
        JsonArray arr = doc.as<JsonArray>();
        for (JsonObject item : arr) {
            PairedDevice dev;
            dev.address = item["address"] | item["mac"] | "";
            dev.name = item["name"] | "Paired Controller";
            dev.rssi = item["rssi"] | -60;
            dev.connected = false;
            dev.bonded = item["bonded"] | true;
            dev.battery_pct = item["battery_pct"] | 100;
            dev.addr_type = item["addr_type"] | 0;
            if (!dev.address.isEmpty()) {
                g_paired_devices.push_back(dev);
            }
        }
    }
    Serial.printf("[BLE] Loaded %u paired devices from NVS\n", g_paired_devices.size());
}

void persist_paired_ble_devices() {
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (const auto& dev : g_paired_devices) {
        JsonObject item = arr.add<JsonObject>();
        item["address"] = dev.address;
        item["name"] = dev.name;
        item["rssi"] = dev.rssi;
        item["bonded"] = dev.bonded;
        item["battery_pct"] = dev.battery_pct;
        item["addr_type"] = dev.addr_type;
    }
    String json_str;
    serializeJson(doc, json_str);
    g_ble_prefs.begin("ble_config", false);
    g_ble_prefs.putString("paired", json_str);
    g_ble_prefs.end();
}

void load_beacon_targets() {
    g_beacon_targets.clear();
    g_beacon_prefs.begin("beacon_cfg", true);
    String json_str = g_beacon_prefs.getString("targets", "[]");
    g_beacon_prefs.end();

    JsonDocument doc;
    if (deserializeJson(doc, json_str) == DeserializationError::Ok) {
        JsonArray arr = doc.as<JsonArray>();
        for (JsonObject item : arr) {
            BeaconTarget b;
            b.uuid = item["uuid"] | "";
            b.mac = item["mac"] | item["address"] | "";
            b.name = item["name"] | "Phone Beacon";
            b.enter_rssi = item["enter_rssi"] | -75;
            b.exit_timeout_s = item["exit_timeout_s"] | item["exit_timeout"] | 10;
            if (!b.uuid.isEmpty() || !b.mac.isEmpty()) {
                g_beacon_targets.push_back(b);
            }
        }
    }
    Serial.printf("[BEACON] Loaded %u beacon targets from NVS\n", g_beacon_targets.size());
}

void persist_beacon_targets() {
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (const auto& b : g_beacon_targets) {
        JsonObject item = arr.add<JsonObject>();
        item["uuid"] = b.uuid;
        item["mac"] = b.mac;
        item["name"] = b.name;
        item["enter_rssi"] = b.enter_rssi;
        item["exit_timeout_s"] = b.exit_timeout_s;
    }
    String json_str;
    serializeJson(doc, json_str);
    g_beacon_prefs.begin("beacon_cfg", false);
    g_beacon_prefs.putString("targets", json_str);
    g_beacon_prefs.end();
}

// ============================================================================
// Wi-Fi Storage & Manager
// ============================================================================
String g_device_id = "can-do";
String g_ap_ssid = "CAN Do";
String g_ap_pass = "candorules";
bool g_softap_active = false;

void start_softap();
void stop_softap();

void init_device_id() {
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        char buf[32];
        snprintf(buf, sizeof(buf), "can-do-%02X%02X", mac[4], mac[5]);
        g_device_id = buf;
        char ap_buf[32];
        snprintf(ap_buf, sizeof(ap_buf), "CAN Do-%02X%02X", mac[4], mac[5]);
        g_ap_ssid = ap_buf;
    } else {
        g_device_id = "can-do-0000";
        g_ap_ssid = "CAN Do-0000";
    }
    Serial.printf("[SYSTEM] Device ID: %s, SoftAP: '%s'\n", g_device_id.c_str(), g_ap_ssid.c_str());
}

struct SavedWifiNetwork {
    String ssid;
    String password;
    int priority;
};

std::vector<SavedWifiNetwork> g_saved_wifi;
void persist_saved_wifi();

void load_saved_wifi() {
    g_saved_wifi.clear();
    g_wifi_prefs.begin("wifi_config", false);
    String custom_ap_ssid = g_wifi_prefs.getString("ap_ssid", "");
    String custom_ap_pass = g_wifi_prefs.getString("ap_pass", "");
    if (!custom_ap_ssid.isEmpty()) g_ap_ssid = custom_ap_ssid;
    if (!custom_ap_pass.isEmpty()) g_ap_pass = custom_ap_pass;

    String json_str = g_wifi_prefs.getString("networks", "[]");
    g_wifi_prefs.end();

    JsonDocument doc;
    if (deserializeJson(doc, json_str) == DeserializationError::Ok) {
        JsonArray arr = doc.as<JsonArray>();
        for (JsonObject item : arr) {
            SavedWifiNetwork net;
            net.ssid = item["ssid"].as<String>();
            net.password = item["password"].as<String>();
            net.priority = item["priority"] | 50;
            if (!net.ssid.isEmpty()) {
                g_saved_wifi.push_back(net);
            }
        }
    }
    if (g_saved_wifi.empty()) {
        g_saved_wifi.push_back({"THE Internet of Things", "kinetic@doorbell@residence", 100});
        persist_saved_wifi();
    }
    Serial.printf("[WIFI] Loaded %u saved roaming networks from NVS:\n", g_saved_wifi.size());
    for (size_t i = 0; i < g_saved_wifi.size(); i++) {
        Serial.printf("  [%u] '%s' (Pass: '%s', Priority: %d)\n", (unsigned)i, g_saved_wifi[i].ssid.c_str(), g_saved_wifi[i].password.c_str(), g_saved_wifi[i].priority);
    }
}

void persist_saved_wifi() {
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (const auto& net : g_saved_wifi) {
        JsonObject item = arr.add<JsonObject>();
        item["ssid"] = net.ssid;
        item["password"] = net.password;
        item["priority"] = net.priority;
    }
    String json_str;
    serializeJson(doc, json_str);
    g_wifi_prefs.begin("wifi_config", false);
    g_wifi_prefs.putString("networks", json_str);
    g_wifi_prefs.end();
}

void start_softap() {
    if (g_softap_active) return;
    WiFi.enableAP(true);
    IPAddress apIP(192, 168, 4, 1);
    WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
    WiFi.softAP(g_ap_ssid.c_str(), g_ap_pass.c_str(), 1, 0, 4);
    WiFi.softAPsetHostname(g_device_id.c_str());
    g_softap_active = true;
    Serial.printf("[WIFI] Fallback SoftAP '%s' active (Pass: '%s') at IP: %s\n",
                  g_ap_ssid.c_str(), g_ap_pass.c_str(), WiFi.softAPIP().toString().c_str());
    update_led_status();
}

void stop_softap() {
    if (!g_softap_active) return;
    WiFi.softAPdisconnect(true);
    WiFi.enableAP(false);
    g_softap_active = false;
    Serial.println("[WIFI] Station connected -> SoftAP shut down to clear air and free 2.4GHz radio");
    update_led_status();
}

void connect_to_best_wifi() {
    if (g_saved_wifi.empty()) {
        start_softap();
        return;
    }

    Serial.println("[WIFI] Scanning for known networks in the air...");
    int n = WiFi.scanNetworks(false, false, false, 250);
    int best_saved_idx = -1;
    int best_prio = -1;
    int best_rssi = -100;

    if (n > 0) {
        for (int i = 0; i < n; i++) {
            String found_ssid = WiFi.SSID(i);
            int found_rssi = WiFi.RSSI(i);
            for (size_t s = 0; s < g_saved_wifi.size(); s++) {
                if (g_saved_wifi[s].ssid.equalsIgnoreCase(found_ssid)) {
                    if (g_saved_wifi[s].priority > best_prio ||
                       (g_saved_wifi[s].priority == best_prio && found_rssi > best_rssi)) {
                        best_saved_idx = s;
                        best_prio = g_saved_wifi[s].priority;
                        best_rssi = found_rssi;
                    }
                }
            }
        }
        WiFi.scanDelete();
    }

    if (best_saved_idx < 0 && !g_saved_wifi.empty()) {
        best_saved_idx = 0;
    }

    if (best_saved_idx >= 0) {
        Serial.printf("[WIFI] Connecting to '%s' as '%s'...\n",
                      g_saved_wifi[best_saved_idx].ssid.c_str(), g_device_id.c_str());
        WiFi.setHostname(g_device_id.c_str());
        esp_netif_t* netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        if (netif) {
            esp_netif_set_hostname(netif, g_device_id.c_str());
        }
        WiFi.begin(g_saved_wifi[best_saved_idx].ssid.c_str(), g_saved_wifi[best_saved_idx].password.c_str());
    } else {
        Serial.println("[WIFI] No known networks detected nearby. Keeping fallback SoftAP active.");
        start_softap();
    }
}

// ============================================================================
// LED & Status Helpers
// ============================================================================
void set_led_color(CRGB color) {
    leds[0] = color;
    FastLED.show();
}

void update_led_status() {
    if (!g_wican_online) {
        set_led_color(CRGB::Red);
    } else if (ws.count() > 0) {
        set_led_color(CRGB::Blue); // Web browser client connected
    } else {
        set_led_color(CRGB::Green); // WiCAN online & ready
    }
}

// ============================================================================
// BLE Button Event & Trigger Dispatcher
// ============================================================================
void fire_ble_button_event(const String& addr, const String& name, const String& button, const String& action, const String& combo) {
    g_last_ble_event.device_address = addr;
    g_last_ble_event.device_name = name;
    g_last_ble_event.button_name = button;
    g_last_ble_event.action = action;
    g_last_ble_event.timestamp_ms = millis();
    g_has_last_event = true;

    // Record in recent events ring buffer
    BleButtonEvent evt = g_last_ble_event;
    if (combo.length() > 0) {
        evt.button_name = combo;
    }
    g_recent_ble_events.insert(g_recent_ble_events.begin(), evt);
    if (g_recent_ble_events.size() > 30) {
        g_recent_ble_events.pop_back();
    }

    // Flash LED Purple
    set_led_color(CRGB::Purple);

    Serial.printf("[BLE] Button Event: '%s' (%s) combo='%s' from %s [%s]\n",
                  button.c_str(), action.c_str(), combo.c_str(), name.c_str(), addr.c_str());

    // 1. Broadcast to WebSocket clients (for UI real-time feedback & Automations)
    JsonDocument ws_doc;
    ws_doc["type"] = "ble_event";
    ws_doc["address"] = addr;
    ws_doc["name"] = name;
    ws_doc["button_name"] = button;
    ws_doc["action"] = action;
    if (combo.length() > 0) {
        ws_doc["combo"] = combo;
    }
    JsonArray held_arr = ws_doc["held"].to<JsonArray>();
    for (const auto& h : g_held_buttons) {
        held_arr.add(h);
    }
    ws_doc["timestamp_ms"] = g_last_ble_event.timestamp_ms;
    String ws_str;
    serializeJson(ws_doc, ws_str);
    safe_ws_broadcast(ws_str);

    // 2. Forward BLE event and trigger to WiCAN over high-speed UART link
    String uart_msg = "{\"type\":\"ble_event\",\"address\":\"" + addr + "\",\"button\":\"" + button + "\",\"action\":\"" + action + "\"";
    if (combo.length() > 0) {
        uart_msg += ",\"combo\":\"" + combo + "\"";
    }
    uart_msg += "}";
    send_to_wican(uart_msg);

    // Note: External BLE button events & chords are forwarded to WiCAN above via ble_event
    // (Automation rules & MQTT handle specific actions; we do NOT hijack buttons to trigger preconditioning)

    // 3. Immediately broadcast status so polling Web UI and WiCAN update last_event
    broadcast_ble_status();

    update_led_status();
}

// ============================================================================
// BLE Client / HID Notification Callback
// ============================================================================
void on_hid_report_notify(NimBLERemoteCharacteristic* pChar, uint8_t* pData, size_t length, bool isNotify) {
    if (length == 0 || !pData) return;

    Serial.printf("[BLE HID RAW] Char %s (len=%u): ", pChar ? pChar->getUUID().toString().c_str() : "???", length);
    for (size_t i = 0; i < length; i++) {
        Serial.printf("%02X ", pData[i]);
    }
    Serial.println();

    String btn = "volume_up";
    String act = "press";

    String addr = g_connected_device_addr.isEmpty() ? "BLE Device" : g_connected_device_addr;
    String name = "BLE Controller";
    for (const auto& dev : g_paired_devices) {
        if (dev.address.equalsIgnoreCase(addr)) {
            name = dev.name;
            break;
        }
    }

    // 1. Check for keyboard / consumer release event (all zeros in report)
    bool all_zero = true;
    for (size_t i = 0; i < length; i++) {
        if (pData[i] != 0) {
            all_zero = false;
            break;
        }
    }

    if (all_zero) {
        act = "release";
        String combo_released = "";
        if (g_held_buttons.size() > 1) {
            std::vector<String> sorted_held = g_held_buttons;
            std::sort(sorted_held.begin(), sorted_held.end());
            for (size_t i = 0; i < sorted_held.size(); i++) {
                if (i > 0) combo_released += "+";
                combo_released += sorted_held[i];
            }
        }

        if (!g_held_buttons.empty()) {
            for (const auto& h : g_held_buttons) {
                fire_ble_button_event(addr, name, h, "release", combo_released);
            }
            g_held_buttons.clear();
        } else {
            btn = g_last_ble_event.button_name.isEmpty() ? "button" : g_last_ble_event.button_name;
            fire_ble_button_event(addr, name, btn, "release");
        }
        return;
    } else if (length >= 8 && (pData[2] != 0 || pData[3] != 0 || pData[4] != 0)) {
        // Standard HID Keyboard report: 8 bytes [modifier, reserved, keycode1..6]
        std::vector<String> packet_keys;
        for (size_t k = 2; k < length && k < 8; k++) {
            uint8_t kc = pData[k];
            if (kc == 0) continue;
            String k_str = "";
            switch (kc) {
                case 0x1E: k_str = "key_1"; break;
                case 0x1F: k_str = "key_2"; break;
                case 0x20: k_str = "key_3"; break;
                case 0x21: k_str = "key_4"; break;
                case 0x22: k_str = "key_5"; break;
                case 0x23: k_str = "key_6"; break;
                case 0x24: k_str = "key_7"; break;
                case 0x25: k_str = "key_8"; break;
                case 0x26: k_str = "key_9"; break;
                case 0x27: k_str = "key_0"; break;
                case 0x28: k_str = "enter"; break;
                case 0x29: k_str = "escape"; break;
                case 0x2A: k_str = "backspace"; break;
                case 0x2B: k_str = "tab"; break;
                case 0x2C: k_str = "space"; break;
                case 0x4F: k_str = "arrow_right"; break;
                case 0x50: k_str = "arrow_left"; break;
                case 0x51: k_str = "arrow_down"; break;
                case 0x52: k_str = "arrow_up"; break;
                case 0x80: k_str = "volume_up"; break;
                case 0x81: k_str = "volume_down"; break;
                default: {
                    if (kc >= 0x04 && kc <= 0x1D) {
                        char c = 'a' + (kc - 0x04);
                        k_str = String("key_") + c;
                    } else {
                        char buf[16];
                        snprintf(buf, sizeof(buf), "hid_%02X", kc);
                        k_str = buf;
                    }
                }
            }
            if (!k_str.isEmpty()) {
                packet_keys.push_back(k_str);
            }
        }

        if (!packet_keys.empty()) {
            btn = packet_keys[0];
            for (const auto& pk : packet_keys) {
                bool already = false;
                for (const auto& h : g_held_buttons) {
                    if (h == pk) { already = true; break; }
                }
                if (!already) g_held_buttons.push_back(pk);
            }
        }
    } else {
        // Consumer Control / Media / Macro Keypad reports
        uint16_t usage = 0;
        if (length >= 2 && pData[0] == 0x00 && (pData[1] != 0 || (length >= 3 && pData[2] != 0))) {
            usage = pData[1] | ((uint16_t)pData[2] << 8);
        } else if (length >= 2 && (pData[0] != 0 || pData[1] != 0)) {
            usage = pData[0] | ((uint16_t)pData[1] << 8);
        } else {
            usage = pData[0];
        }

        std::vector<String> consumer_keys;
        if (usage == 0xE9 || (usage & 0x01 && (usage <= 0xFF))) consumer_keys.push_back("volume_up");
        if (usage == 0xEA || (usage & 0x02 && (usage <= 0xFF))) consumer_keys.push_back("volume_down");
        if (usage == 0xE2 || (usage & 0x20 && (usage <= 0xFF))) consumer_keys.push_back("mute");
        if (usage == 0xCD || (usage & 0x04 && (usage <= 0xFF))) consumer_keys.push_back("play_pause");
        if (usage == 0xB5 || (usage & 0x08 && (usage <= 0xFF))) consumer_keys.push_back("next_track");
        if (usage == 0xB6 || (usage & 0x10 && (usage <= 0xFF))) consumer_keys.push_back("prev_track");
        if (usage == 0x28) consumer_keys.push_back("shutter");

        if (!consumer_keys.empty()) {
            btn = consumer_keys[0];
            for (const auto& ck : consumer_keys) {
                bool already = false;
                for (const auto& h : g_held_buttons) {
                    if (h == ck) { already = true; break; }
                }
                if (!already) g_held_buttons.push_back(ck);
            }
        } else {
            char buf[16];
            snprintf(buf, sizeof(buf), "hid_%02X", (uint8_t)(usage & 0xFF));
            btn = buf;
            bool already = false;
            for (const auto& h : g_held_buttons) {
                if (h == btn) { already = true; break; }
            }
            if (!already) g_held_buttons.push_back(btn);
        }
    }

    String combo = "";
    if (g_held_buttons.size() > 1) {
        std::vector<String> sorted_held = g_held_buttons;
        std::sort(sorted_held.begin(), sorted_held.end());
        for (size_t i = 0; i < sorted_held.size(); i++) {
            if (i > 0) combo += "+";
            combo += sorted_held[i];
        }
    }

    fire_ble_button_event(addr, name, btn, "press", combo);
}

class ClientCallbacks : public NimBLEClientCallbacks {
    void onConnect(NimBLEClient* pClient) override {
        Serial.printf("[BLE] Connected to %s\n", pClient->getPeerAddress().toString().c_str());
        NimBLEDevice::getScan()->stop();
        g_ble_client_connected = true;
        g_connected_device_addr = pClient->getPeerAddress().toString().c_str();
        String dev_name = "";
        for (auto& dev : g_paired_devices) {
            if (dev.address.equalsIgnoreCase(g_connected_device_addr)) {
                dev.connected = true;
                dev_name = dev.name;
                break;
            }
        }
        int cur_rssi = pClient->getRssi();
        String uart_ev = "{\"type\":\"ble_device_event\",\"event\":\"connected\",\"address\":\"" + g_connected_device_addr + "\",\"name\":\"" + dev_name + "\",\"rssi\":" + String(cur_rssi) + "}";
        send_to_wican(uart_ev);
        safe_ws_broadcast(uart_ev);
    }

    void onDisconnect(NimBLEClient* pClient) override {
        Serial.println("[BLE] Client disconnected");
        String disc_addr = g_connected_device_addr;
        g_ble_client_connected = false;
        g_held_buttons.clear();
        for (auto& dev : g_paired_devices) {
            if (dev.address.equalsIgnoreCase(disc_addr)) {
                dev.connected = false;
                break;
            }
        }
        g_connected_device_addr = "";
        String uart_ev = "{\"type\":\"ble_device_event\",\"event\":\"disconnected\",\"address\":\"" + disc_addr + "\"}";
        send_to_wican(uart_ev);
        safe_ws_broadcast(uart_ev);
        broadcast_ble_status();
        // Resume continuous background scan to listen for button press wakeups
        NimBLEDevice::getScan()->start(0, nullptr, false);
    }
};

void connect_ble_device(const String& address, uint8_t addr_type, NimBLEAdvertisedDevice* pAdvDev) {
    if (address.isEmpty() && !pAdvDev) return;

    if (!g_ble_client) {
        g_ble_client = NimBLEDevice::createClient();
        g_ble_client->setClientCallbacks(new ClientCallbacks());
    }

    if (g_ble_client->isConnected()) {
        g_ble_client->disconnect();
        delay(100);
    }

    g_ble_client->setConnectTimeout(2);
    bool connected = false;
    uint8_t target_type = addr_type;

    if (pAdvDev) {
        Serial.printf("[BLE] Direct connecting to advertised device %s (type=%d)...\n",
                      pAdvDev->getAddress().toString().c_str(), pAdvDev->getAddress().getType());
        connected = g_ble_client->connect(pAdvDev, false);
        if (connected) {
            target_type = pAdvDev->getAddress().getType();
        }
    }

    if (!connected && !address.isEmpty()) {
        // Determine target address type (public vs random)
        if (target_type == 0xFF) {
            for (const auto& dev : g_paired_devices) {
                if (dev.address.equalsIgnoreCase(address)) {
                    target_type = dev.addr_type;
                    break;
                }
            }
        }
        if (target_type == 0xFF) {
            for (const auto& dev : g_discovered_devices) {
                if (dev.address.equalsIgnoreCase(address)) {
                    target_type = dev.addr_type;
                    break;
                }
            }
        }
        if (target_type == 0xFF) {
            // BLE Static Random addresses have top 2 bits set (0xC0..0xFF)
            uint8_t first_byte = (uint8_t)strtoul(address.substring(0, 2).c_str(), nullptr, 16);
            target_type = ((first_byte & 0xC0) == 0xC0) ? BLE_ADDR_RANDOM : BLE_ADDR_PUBLIC;
        }

        NimBLEAddress bleAddr(address.c_str(), target_type);
        Serial.printf("[BLE] Attempting connection to %s (type=%d)...\n", address.c_str(), target_type);

        connected = g_ble_client->connect(bleAddr, false);
        if (!connected) {
            // Retry with alternate address type
            uint8_t alt_type = (target_type == BLE_ADDR_RANDOM) ? BLE_ADDR_PUBLIC : BLE_ADDR_RANDOM;
            Serial.printf("[BLE] Retrying connection to %s with alternate type (%d)...\n", address.c_str(), alt_type);
            NimBLEAddress altAddr(address.c_str(), alt_type);
            connected = g_ble_client->connect(altAddr, false);
            if (connected) {
                target_type = alt_type;
            }
        }
    }

    if (connected) {
        Serial.printf("[BLE] Connected to %s! Starting security handshake...\n", address.c_str());
        g_ble_client->secureConnection();

        // Save active address type
        for (auto& dev : g_paired_devices) {
            if (dev.address.equalsIgnoreCase(address)) {
                dev.addr_type = target_type;
                dev.connected = true;
                break;
            }
        }
        persist_paired_ble_devices();

        // Discover all remote services & characteristics (use cached to prevent radio starvation)
        Serial.println("[BLE] Discovering all remote services & characteristics...");
        auto pServices = g_ble_client->getServices(false);
        if (!pServices || pServices->empty()) {
            pServices = g_ble_client->getServices(true);
        }
        if (pServices) {
            for (auto pService : *pServices) {
                if (!pService) continue;
                Serial.printf("[BLE] Service: %s\n", pService->getUUID().toString().c_str());
                auto pChars = pService->getCharacteristics(true);
                if (pChars) {
                    for (auto pChar : *pChars) {
                        if (pChar) {
                            Serial.printf("  -> Char %s (notify=%d, indicate=%d, read=%d)\n",
                                          pChar->getUUID().toString().c_str(),
                                          pChar->canNotify(), pChar->canIndicate(), pChar->canRead());
                            if (pChar->canNotify()) {
                                if (pChar->subscribe(true, on_hid_report_notify)) {
                                    Serial.printf("  [+] Subscribed (notify) to %s\n", pChar->getUUID().toString().c_str());
                                }
                            } else if (pChar->canIndicate()) {
                                if (pChar->subscribe(false, on_hid_report_notify)) {
                                    Serial.printf("  [+] Subscribed (indicate) to %s\n", pChar->getUUID().toString().c_str());
                                }
                            }

                            // Read battery level if battery characteristic
                            if (pChar->getUUID().equals(NimBLEUUID((uint16_t)0x2A19)) && pChar->canRead()) {
                                uint8_t batt = pChar->readValue<uint8_t>();
                                Serial.printf("[BLE] Battery level: %d%%\n", batt);
                                for (auto& dev : g_paired_devices) {
                                    if (dev.address.equalsIgnoreCase(address)) {
                                        dev.battery_pct = batt;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    } else {
        Serial.printf("[BLE] Connection to %s failed (will listen via advertisements)\n", address.c_str());
    }

    broadcast_ble_status();
}

void disconnect_ble_client() {
    if (g_ble_client && g_ble_client->isConnected()) {
        g_ble_client->disconnect();
    }
    g_ble_client_connected = false;
    g_connected_device_addr = "";
    for (auto& dev : g_paired_devices) {
        dev.connected = false;
    }
}

// ============================================================================
// NimBLE Scan & Device Management
// ============================================================================
String get_ble_status_json() {
    JsonDocument doc;
    doc["enabled"] = true;
    doc["scanning"] = g_ble_scanning;

    // Connected Device Object: only non-null when actually connected
    bool has_conn = false;
    for (const auto& dev : g_paired_devices) {
        if (dev.connected || dev.address.equalsIgnoreCase(g_connected_device_addr)) {
            JsonObject conn = doc["connected_device"].to<JsonObject>();
            conn["address"] = dev.address;
            conn["name"] = dev.name;
            conn["rssi"] = dev.rssi;
            conn["connected"] = true;
            conn["bonded"] = dev.bonded;
            conn["battery_pct"] = dev.battery_pct;
            has_conn = true;
            break;
        }
    }
    if (!has_conn) {
        doc["connected_device"] = nullptr;
    }

    // Paired Devices List
    JsonArray paired = doc["paired_devices"].to<JsonArray>();
    for (const auto& dev : g_paired_devices) {
        JsonObject item = paired.add<JsonObject>();
        item["address"] = dev.address;
        item["name"] = dev.name;
        item["rssi"] = dev.rssi;
        item["connected"] = dev.connected || dev.address.equalsIgnoreCase(g_connected_device_addr);
        item["bonded"] = dev.bonded;
        item["battery_pct"] = dev.battery_pct;
    }

    // Discovered Devices List
    JsonArray discovered = doc["discovered_devices"].to<JsonArray>();
    for (const auto& dev : g_discovered_devices) {
        JsonObject obj = discovered.add<JsonObject>();
        obj["address"] = dev.address;
        obj["name"] = dev.name;
        obj["rssi"] = dev.rssi;
        obj["connected"] = false;
        obj["bonded"] = false;
    }

    // Last Button Event
    if (g_has_last_event) {
        JsonObject ev = doc["last_event"].to<JsonObject>();
        ev["device_address"] = g_last_ble_event.device_address;
        ev["device_name"] = g_last_ble_event.device_name;
        ev["button_name"] = g_last_ble_event.button_name;
        ev["action"] = g_last_ble_event.action;
        ev["timestamp_ms"] = g_last_ble_event.timestamp_ms;
    } else {
        doc["last_event"] = nullptr;
    }

    // Recent Button Events Log (up to 30 events)
    JsonArray recent = doc["recent_events"].to<JsonArray>();
    for (const auto& ev : g_recent_ble_events) {
        JsonObject item = recent.add<JsonObject>();
        item["device_address"] = ev.device_address;
        item["device_name"] = ev.device_name;
        item["button_name"] = ev.button_name;
        item["action"] = ev.action;
        item["timestamp_ms"] = ev.timestamp_ms;
    }

    // Beacon Targets
    JsonArray beacon_targets_arr = doc["beacon_targets"].to<JsonArray>();
    for (const auto& b : g_beacon_targets) {
        JsonObject item = beacon_targets_arr.add<JsonObject>();
        item["uuid"] = b.uuid;
        item["mac"] = b.mac;
        item["name"] = b.name;
        item["enter_rssi"] = b.enter_rssi;
        item["exit_timeout_s"] = b.exit_timeout_s;
        item["is_present"] = b.is_present;
        item["rssi"] = b.last_rssi;
        item["major"] = b.major;
        item["minor"] = b.minor;
        item["last_seen_ms"] = b.last_seen_ms;
    }

    // Discovered Beacons (within last 60 seconds)
    JsonArray disc_beacons_arr = doc["discovered_beacons"].to<JsonArray>();
    for (const auto& b : g_discovered_beacons) {
        if (millis() - b.last_seen_ms < 60000) {
            JsonObject item = disc_beacons_arr.add<JsonObject>();
            item["uuid"] = b.uuid;
            item["mac"] = b.mac;
            item["rssi"] = b.rssi;
            item["major"] = b.major;
            item["minor"] = b.minor;
            item["last_seen_ms"] = b.last_seen_ms;
        }
    }

    String out;
    serializeJson(doc, out);
    return out;
}

void broadcast_ble_status() {
    static unsigned long s_last_ble_bcast_ms = 0;
    // Throttle automatic BLE status dumps to max 2Hz to protect UART and WS queues
    if (millis() - s_last_ble_bcast_ms < 500) return;
    s_last_ble_bcast_ms = millis();

    String st = get_ble_status_json();
    String wrapped = "{\"type\":\"ble_status\",\"data\":" + st + "}";
    send_to_wican(wrapped);
    safe_ws_broadcast(wrapped);
}

void on_scan_complete(NimBLEScanResults results) {
    g_ble_scanning = false;
    Serial.printf("[BLE] Scan complete. Found %d devices in results vector\n", results.getCount());
    for (int i = 0; i < results.getCount(); i++) {
        NimBLEAdvertisedDevice dev = results.getDevice(i);
        String addr = dev.getAddress().toString().c_str();
        String name = dev.getName().c_str();
        if (name.isEmpty() || name == "Unknown Device") {
            char short_buf[32];
            snprintf(short_buf, sizeof(short_buf), "BLE Device [%s]", addr.substring(addr.length() > 8 ? addr.length() - 8 : 0).c_str());
            name = short_buf;
        }
        int rssi = dev.getRSSI();
        if (rssi < BLE_MIN_RSSI_DISCOVERY) continue; // In-car filter: ignore distant BLE devices

        bool exists = false;
        for (auto& d : g_discovered_devices) {
            if (d.address.equalsIgnoreCase(addr)) {
                d.rssi = rssi;
                if (!name.isEmpty() && !name.startsWith("BLE Device")) {
                    d.name = name;
                }
                exists = true;
                break;
            }
        }
        if (!exists) {
            DiscoveredDevice nd;
            nd.address = addr;
            nd.name = name;
            nd.rssi = rssi;
            nd.is_connectable = true;
            nd.addr_type = dev.getAddress().getType();
            g_discovered_devices.push_back(nd);
        }
    }
    Serial.printf("[BLE] Total discovered in-car devices: %u\n", g_discovered_devices.size());
    broadcast_ble_status();
    if (!g_ble_client_connected) {
        NimBLEDevice::getScan()->start(0, nullptr, false);
    }
}

void start_ble_scan(uint32_t dur) {
    if (dur == 0 || dur > 60) dur = 10;
    g_discovered_devices.clear();
    g_ble_scan_duration_ms = dur * 1000;
    g_ble_scan_start_ms = millis();
    g_ble_scanning = true;

    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->stop();
    pScan->clearResults();
    pScan->start(dur, on_scan_complete, false);
    Serial.printf("[BLE] Started async %u second in-car scan (min RSSI: %d dBm)...\n", dur, BLE_MIN_RSSI_DISCOVERY);
    broadcast_ble_status();
}

void pair_ble_device(const String& addr, String name) {
    if (addr.isEmpty()) return;
    uint8_t addr_type = BLE_ADDR_PUBLIC;
    for (const auto& d : g_discovered_devices) {
        if (d.address.equalsIgnoreCase(addr)) {
            if (name.isEmpty() || name == "Unknown Device") {
                name = d.name;
            }
            addr_type = d.addr_type;
            break;
        }
    }
    if (name.isEmpty() || name == "Unknown Device") name = "Bluetooth Button";

    bool found = false;
    for (auto& p : g_paired_devices) {
        if (p.address.equalsIgnoreCase(addr)) {
            p.name = name;
            p.addr_type = addr_type;
            found = true;
            break;
        }
    }
    if (!found) {
        PairedDevice dev;
        dev.address = addr;
        dev.name = name;
        dev.rssi = -50;
        dev.connected = false;
        dev.bonded = true;
        dev.battery_pct = 100;
        dev.addr_type = addr_type;
        g_paired_devices.push_back(dev);
    }
    persist_paired_ble_devices();
    Serial.printf("[BLE] Paired: %s (%s, type=%d)\n", addr.c_str(), name.c_str(), addr_type);
    connect_ble_device(addr, addr_type);
    broadcast_ble_status();
}

void unpair_all_ble_devices() {
    disconnect_ble_client();
    g_paired_devices.clear();
    g_held_buttons.clear();
    persist_paired_ble_devices();
    Serial.println("[BLE] Unpaired all devices");
    broadcast_ble_status();
}

class AdvertisedDeviceCallbacks : public NimBLEAdvertisedDeviceCallbacks {
    void onResult(NimBLEAdvertisedDevice* advertisedDevice) override {
        String addr = advertisedDevice->getAddress().toString().c_str();
        String name = advertisedDevice->getName().c_str();
        if (name.isEmpty() || name == "Unknown Device") {
            char short_buf[32];
            snprintf(short_buf, sizeof(short_buf), "BLE Device [%s]", addr.substring(addr.length() > 8 ? addr.length() - 8 : 0).c_str());
            name = short_buf;
        }
        int rssi = advertisedDevice->getRSSI();
        uint8_t a_type = advertisedDevice->getAddress().getType();

        // Only add to discovered devices during an active user-initiated scan AND if within in-car range (>= -70 dBm)
        if (g_ble_scanning && rssi >= BLE_MIN_RSSI_DISCOVERY) {
            bool exists = false;
            for (auto& dev : g_discovered_devices) {
                if (dev.address.equalsIgnoreCase(addr)) {
                    dev.rssi = rssi;
                    dev.addr_type = a_type;
                    if (!name.isEmpty() && !name.startsWith("BLE Device")) {
                        dev.name = name;
                    }
                    exists = true;
                    break;
                }
            }
            if (!exists) {
                DiscoveredDevice nd;
                nd.address = addr;
                nd.name = name;
                nd.rssi = rssi;
                nd.is_connectable = true;
                nd.addr_type = a_type;
                g_discovered_devices.push_back(nd);
            }
        }

        // Check if device is paired
        for (auto& paired : g_paired_devices) {
            if (paired.address.equalsIgnoreCase(addr)) {
                paired.rssi = rssi;
                paired.addr_type = a_type;
                if (!name.isEmpty() && !name.startsWith("BLE Device")) {
                    paired.name = name;
                }

                static unsigned long last_prox_send = 0;
                if (millis() - last_prox_send > 2000) {
                    last_prox_send = millis();
                    String uart_prox = "{\"type\":\"ble_device_event\",\"event\":\"proximity\",\"address\":\"" + addr + "\",\"name\":\"" + paired.name + "\",\"rssi\":" + String(rssi) + "}";
                    send_to_wican(uart_prox);
                }

                // CRITICAL FIX: Never call connect_ble_device() inside NimBLE Host callback!
                // Defer the connection request to loop() to prevent NimBLE Host task deadlock.
                static unsigned long last_adv_connect_attempt = 0;
                if (!g_ble_client_connected && !g_pending_ble_connect_req && (millis() - last_adv_connect_attempt > 15000)) {
                    last_adv_connect_attempt = millis();
                    std::lock_guard<std::mutex> lock(g_ble_pending_mutex);
                    g_pending_ble_connect_addr = addr;
                    g_pending_ble_connect_type = a_type;
                    g_pending_ble_connect_req = true;
                }
                break;
            }
        }

        // ====================================================================
        // iBeacon & Beacon Target Detection
        // ====================================================================
        String adv_uuid = "";
        uint16_t adv_major = 0;
        uint16_t adv_minor = 0;

        if (advertisedDevice->haveManufacturerData()) {
            std::string mfg = advertisedDevice->getManufacturerData();
            if (mfg.length() >= 25 &&
                (uint8_t)mfg[0] == 0x4C && (uint8_t)mfg[1] == 0x00 &&
                (uint8_t)mfg[2] == 0x02 && (uint8_t)mfg[3] == 0x15) {

                char uuid_buf[37];
                snprintf(uuid_buf, sizeof(uuid_buf),
                         "%02X%02X%02X%02X-%02X%02X-%02X%02X-%02X%02X-%02X%02X%02X%02X%02X%02X",
                         (uint8_t)mfg[4], (uint8_t)mfg[5], (uint8_t)mfg[6], (uint8_t)mfg[7],
                         (uint8_t)mfg[8], (uint8_t)mfg[9],
                         (uint8_t)mfg[10], (uint8_t)mfg[11],
                         (uint8_t)mfg[12], (uint8_t)mfg[13],
                         (uint8_t)mfg[14], (uint8_t)mfg[15], (uint8_t)mfg[16], (uint8_t)mfg[17], (uint8_t)mfg[18], (uint8_t)mfg[19]);
                adv_uuid = uuid_buf;
                adv_major = ((uint8_t)mfg[20] << 8) | (uint8_t)mfg[21];
                adv_minor = ((uint8_t)mfg[22] << 8) | (uint8_t)mfg[23];

                bool b_exists = false;
                for (auto& b : g_discovered_beacons) {
                    if (b.uuid.equalsIgnoreCase(adv_uuid)) {
                        b.rssi = rssi;
                        b.mac = addr;
                        b.major = adv_major;
                        b.minor = adv_minor;
                        b.last_seen_ms = millis();
                        b_exists = true;
                        break;
                    }
                }
                if (!b_exists) {
                    if (g_discovered_beacons.size() >= 10) g_discovered_beacons.erase(g_discovered_beacons.begin());
                    DiscoveredBeacon nb;
                    nb.uuid = adv_uuid;
                    nb.mac = addr;
                    nb.rssi = rssi;
                    nb.major = adv_major;
                    nb.minor = adv_minor;
                    nb.last_seen_ms = millis();
                    g_discovered_beacons.push_back(nb);
                }
            }
        }

        for (auto& target : g_beacon_targets) {
            bool match = false;
            if (!adv_uuid.isEmpty() && !target.uuid.isEmpty() && target.uuid.equalsIgnoreCase(adv_uuid)) {
                match = true;
            }
            if (!target.mac.isEmpty() && target.mac.equalsIgnoreCase(addr)) {
                match = true;
            }

            if (match) {
                target.last_seen_ms = millis();
                target.last_rssi = rssi;
                if (adv_major != 0) target.major = adv_major;
                if (adv_minor != 0) target.minor = adv_minor;
                if (target.mac.isEmpty() && addr.length() > 0) target.mac = addr;

                if (!target.is_present && rssi >= target.enter_rssi) {
                    target.is_present = true;
                    target.last_prox_send_ms = millis();
                    String uart_msg = "{\"type\":\"ble_beacon\",\"event\":\"enter\",\"uuid\":\"" + target.uuid + "\",\"mac\":\"" + addr + "\",\"name\":\"" + target.name + "\",\"rssi\":" + String(rssi) + ",\"major\":" + String(target.major) + ",\"minor\":" + String(target.minor) + "}";
                    send_to_wican(uart_msg);
                    safe_ws_broadcast(uart_msg);
                } else if (target.is_present && (millis() - target.last_prox_send_ms > 2500)) {
                    target.last_prox_send_ms = millis();
                    String uart_msg = "{\"type\":\"ble_beacon\",\"event\":\"proximity\",\"uuid\":\"" + target.uuid + "\",\"mac\":\"" + addr + "\",\"name\":\"" + target.name + "\",\"rssi\":" + String(rssi) + ",\"major\":" + String(target.major) + ",\"minor\":" + String(target.minor) + "}";
                    send_to_wican(uart_msg);
                    safe_ws_broadcast(uart_msg);
                }
            }
        }
    }
};

// ============================================================================
// WiCAN UART Communication Link
// ============================================================================
void send_to_wican(const String& line) {
    if (line.isEmpty()) return;
    Serial2.print(line);
    if (!line.endsWith("\n")) {
        Serial2.print("\n");
    }
}

void request_wican_states_throttled() {
    static unsigned long s_last_req_ms = 0;
    if (millis() - s_last_req_ms >= 2500) {
        s_last_req_ms = millis();
        send_to_wican("{\"type\":\"get_states\"}");
    }
}

void handle_wican_message(const String& line) {
    g_last_wican_rx_ms = millis();
    if (!g_wican_online) {
        g_wican_online = true;
        Serial.println("[UART] WiCAN link established!");
        update_led_status();
        request_wican_states_throttled();
    }

    // Consume heartbeat messages without forwarding to WebSockets or echoing
    if (line.indexOf("\"type\":\"pong\"") >= 0 || line.indexOf("\"type\":\"ping\"") >= 0) {
        return;
    }

    // WiCAN requested BLE status or triggered BLE action
    if (line.indexOf("\"type\":\"ble_get_status\"") >= 0) {
        broadcast_ble_status();
        return;
    } else if (line.indexOf("\"type\":\"ble_scan\"") >= 0) {
        JsonDocument doc;
        uint32_t dur = 10;
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            dur = doc["duration"] | 10;
        }
        start_ble_scan(dur);
        return;
    } else if (line.indexOf("\"type\":\"ble_pair\"") >= 0) {
        JsonDocument doc;
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            String addr = doc["address"] | doc["mac"] | "";
            String name = doc["name"] | "";
            if (!addr.isEmpty()) {
                pair_ble_device(addr, name);
            }
        }
        return;
    } else if (line.indexOf("\"type\":\"ble_unpair\"") >= 0) {
        unpair_all_ble_devices();
        return;
    } else if (line.indexOf("\"type\":\"ble_test_event\"") >= 0) {
        JsonDocument doc;
        String btn = "volume_up";
        String act = "press";
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            btn = doc["button"] | "volume_up";
            act = doc["action"] | "press";
        }
        fire_ble_button_event("VIRTUAL-SIM", "Virtual Simulator", btn, act);
        return;
    } else if (line.indexOf("\"type\":\"ble_beacon_config\"") >= 0) {
        JsonDocument doc;
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            String act = doc["action"] | "set";
            String uuid = doc["uuid"] | "";
            String mac = doc["mac"] | doc["address"] | "";
            String name = doc["name"] | "Phone Beacon";
            int enter_rssi = doc["enter_rssi"] | -75;
            int exit_timeout = doc["exit_timeout_s"] | doc["exit_timeout"] | 10;
            if (act == "delete") {
                for (auto it = g_beacon_targets.begin(); it != g_beacon_targets.end(); ) {
                    if ((!uuid.isEmpty() && it->uuid.equalsIgnoreCase(uuid)) ||
                        (!mac.isEmpty() && it->mac.equalsIgnoreCase(mac))) {
                        it = g_beacon_targets.erase(it);
                    } else {
                        ++it;
                    }
                }
                persist_beacon_targets();
            } else {
                bool found = false;
                for (auto& b : g_beacon_targets) {
                    if ((!uuid.isEmpty() && b.uuid.equalsIgnoreCase(uuid)) ||
                        (!mac.isEmpty() && b.mac.equalsIgnoreCase(mac))) {
                        b.uuid = uuid;
                        b.mac = mac;
                        b.name = name;
                        b.enter_rssi = enter_rssi;
                        b.exit_timeout_s = exit_timeout;
                        found = true;
                        break;
                    }
                }
                if (!found && (!uuid.isEmpty() || !mac.isEmpty())) {
                    BeaconTarget bt;
                    bt.uuid = uuid;
                    bt.mac = mac;
                    bt.name = name;
                    bt.enter_rssi = enter_rssi;
                    bt.exit_timeout_s = exit_timeout;
                    g_beacon_targets.push_back(bt);
                }
                persist_beacon_targets();
            }
            broadcast_ble_status();
        }
        return;
    }

    // Forward raw JSON directly to connected WebSockets
    safe_ws_broadcast(line);

    // Inspect for state caching
    if (line.indexOf("\"type\":\"state\"") >= 0) {
        JsonDocument doc;
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            const char* entity = doc["entity"];
            const char* state = doc["state"];
            if (entity && state) {
                std::lock_guard<std::mutex> lock(g_state_cache_mutex);
                g_state_cache[String(entity)] = String(state);
            }
        }
    } else if (line.indexOf("\"type\":\"states_dump\"") >= 0) {
        JsonDocument doc;
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            JsonArray arr = doc["data"].as<JsonArray>();
            {
                std::lock_guard<std::mutex> lock(g_state_cache_mutex);
                for (JsonObject item : arr) {
                    const char* entity = item["entity"];
                    const char* state = item["state"];
                    if (entity && state) {
                        g_state_cache[String(entity)] = String(state);
                    }
                }
            }
            Serial.printf("[CACHE] Cached %u vehicle states from WiCAN\n", g_state_cache.size());
        }
    }
}

// ============================================================================
// WebSocket Event Handler
// ============================================================================
void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.printf("[WS] Client #%u connected from %s\n", client->id(), client->remoteIP().toString().c_str());

        // Deliver initial state cache to freshly connected browser client
        JsonDocument doc;
        JsonArray arr = doc.to<JsonArray>();
        {
            std::lock_guard<std::mutex> lock(g_state_cache_mutex);
            for (const auto& pair : g_state_cache) {
                JsonObject item = arr.add<JsonObject>();
                item["entity"] = pair.first;
                item["state"] = pair.second;
            }
        }
        String out;
        serializeJson(doc, out);
        client->text(out);

        // Request fresh state sync from WiCAN
        request_wican_states_throttled();
        update_led_status();

    } else if (type == WS_EVT_DISCONNECT) {
        Serial.printf("[WS] Client #%u disconnected\n", client->id());
        update_led_status();

    } else if (type == WS_EVT_DATA) {
        AwsFrameInfo *info = (AwsFrameInfo*)arg;
        if (info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT) {
            String msg = "";
            for (size_t i = 0; i < len; i++) {
                msg += (char)data[i];
            }
            // Forward client commands transparently to WiCAN
            send_to_wican(msg);
        }
    }
}

// ============================================================================
// Setup
// ============================================================================
struct AtomOtaState {
    bool in_progress = false;
    int progress_pct = 0;
    bool success = false;
    String error_msg = "";
};
static AtomOtaState g_atom_ota_state;

void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println("\n==========================================");
    Serial.println("  CAN-Do M5Stack Atom Lite UI & BLE Bridge");
    Serial.println("==========================================");

    // 0. Initialize Device Identity from MAC
    init_device_id();

    // 1. Initialize RGB LED
    FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, 1);
    set_led_color(CRGB::Orange);

    // 2. Button setup (Atom Lite face button)
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // 3. Hardware Serial2 link to WiCAN (Corner Pad TX -> Atom G21 RX, Corner Pad RX -> Atom G25 TX)
    Serial2.setRxBufferSize(4096);
    Serial2.setTxBufferSize(2048);
    Serial2.begin(UART_BAUD, SERIAL_8N1, BRIDGE_RX_PIN, BRIDGE_TX_PIN);
    Serial.printf("[UART] Serial2 initialized at %d baud (RX: GPIO%d, TX: GPIO%d)\n",
                  UART_BAUD, BRIDGE_RX_PIN, BRIDGE_TX_PIN);

    // 4. Mount LittleFS for Frontend SPA assets
    if (!LittleFS.begin(true)) {
        Serial.println("[FS] ERROR: LittleFS mount failed!");
        set_led_color(CRGB::Red);
    } else {
        Serial.printf("[FS] LittleFS mounted successfully. Total: %u KB, Used: %u KB\n",
                      LittleFS.totalBytes() / 1024, LittleFS.usedBytes() / 1024);

        // Synchronize CAN Do version dynamically from LittleFS manifest if present
        if (LittleFS.exists("/frontend_manifest.json")) {
            File mf = LittleFS.open("/frontend_manifest.json", "r");
            if (mf) {
                JsonDocument mDoc;
                if (deserializeJson(mDoc, mf) == DeserializationError::Ok && mDoc["version"].is<const char*>()) {
                    g_can_do_version = mDoc["version"].as<String>();
                    Serial.printf("[SYSTEM] Synchronized CAN Do version from LittleFS manifest: %s\n", g_can_do_version.c_str());
                }
                mf.close();
            }
        }
    }

    // 5. Initialize Wi-Fi
    // Set hostnames BEFORE initializing Wi-Fi modes so DHCP Option 12 reliably advertises can-do-XXXX
    WiFi.setHostname(g_device_id.c_str());
    WiFi.softAPsetHostname(g_device_id.c_str());
    WiFi.mode(WIFI_AP_STA);

    esp_netif_t* sta_netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (sta_netif) {
        esp_netif_set_hostname(sta_netif, g_device_id.c_str());
    }
    esp_netif_t* ap_netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if (ap_netif) {
        esp_netif_set_hostname(ap_netif, g_device_id.c_str());
    }

    WiFi.setAutoReconnect(true);

    WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
        if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
            uint8_t reason = info.wifi_sta_disconnected.reason;
            Serial.printf("[WIFI] Station disconnected, reason: %d\n", reason);
            start_softap();
        } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
            Serial.printf("[WIFI] Station connected successfully! IP: %s (Hostname: %s)\n",
                          WiFi.localIP().toString().c_str(), g_device_id.c_str());
            stop_softap();
            broadcast_ble_status();
        }
    });

    load_saved_wifi();
    if (!g_saved_wifi.empty()) {
        connect_to_best_wifi();
    } else {
        start_softap();
    }

    if (MDNS.begin(g_device_id.c_str())) {
        MDNS.addService("http", "tcp", 80);
        Serial.printf("[MDNS] Responder active: http://%s.local\n", g_device_id.c_str());
    }

    // 6. Setup NimBLE & Load Paired Devices & Beacons
    NimBLEDevice::init(g_device_id.c_str());
    NimBLEDevice::setSecurityAuth(true, true, true);
    NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
    load_paired_ble_devices();
    load_beacon_targets();

    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->setAdvertisedDeviceCallbacks(new AdvertisedDeviceCallbacks(), true);
    pScan->setActiveScan(true);
    pScan->setInterval(160); // 100ms interval
    pScan->setWindow(40);    // 25ms window (25% duty cycle: reserves 75% airtime for Wi-Fi coex)
    pScan->setMaxResults(50);
    pScan->start(0, nullptr, false);
    Serial.println("[BLE] Continuous background scan active (25% coex duty cycle)");

    // 7. Configure Web Server Routes
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "*");

    ws.onEvent(onWsEvent);
    server.addHandler(&ws);

    // REST: GET /api/states
    server.on("/api/states", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        JsonArray arr = doc.to<JsonArray>();
        {
            std::lock_guard<std::mutex> lock(g_state_cache_mutex);
            for (const auto& pair : g_state_cache) {
                JsonObject item = arr.add<JsonObject>();
                item["entity"] = pair.first;
                item["state"] = pair.second;
            }
        }
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
        request_wican_states_throttled();
    });

    // REST: POST /api/command
    server.on("/api/command", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];

            JsonDocument doc;
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                if (!doc["type"].is<const char*>()) {
                    doc["type"] = "cmd";
                }
                String out;
                serializeJson(doc, out);
                send_to_wican(out);
            } else {
                send_to_wican(body);
            }
            request->send(200, "application/json", "{\"status\":\"queued\"}");
        }
    );

    // REST: POST /api/notify
    server.on("/api/notify", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];

            JsonDocument doc;
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                const char* msg = doc["message"] | doc["text"] | doc["popup_message"] | "";
                const char* lvl = doc["level"] | "info";
                const char* caller = doc["caller"] | doc["title"] | "";
                const char* type = doc["type"] | "notify";
                uint32_t hold_ms = doc["hold_ms"] | 5000;
                if (strlen(msg) > 0) {
                    JsonDocument cmd;
                    cmd["type"] = type;
                    cmd["message"] = msg;
                    cmd["level"] = lvl;
                    if (strlen(caller) > 0) cmd["caller"] = caller;
                    if (hold_ms != 5000) cmd["hold_ms"] = hold_ms;
                    String out;
                    serializeJson(cmd, out);
                    send_to_wican(out);
                    request->send(200, "application/json", "{\"status\":\"ok\",\"message\":\"Notification queued for cluster\"}");
                    return;
                }
            }
            request->send(400, "application/json", "{\"error\":\"Missing message\"}");
        }
    );

    // REST: GET /api/automations (dummy placeholder on Atom Bridge to prevent 404 alert)
    server.on("/api/automations", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json", "{\"settings\":{},\"rules\":[]}");
    });
    server.on("/api/automations/diagnostics", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json", "{\"automations_enabled\":true,\"rules\":[]}");
    });

    // REST: GET /api/system/status
    server.on("/api/system/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["device"] = "M5Stack Atom Lite UI Bridge";
        doc["device_id"] = g_device_id;
        doc["can_do_version"] = g_can_do_version;
        doc["wican_online"] = g_wican_online;
        doc["free_heap"] = ESP.getFreeHeap();
        doc["uptime_s"] = millis() / 1000;
        doc["ws_clients"] = ws.count();
        doc["ble_paired_count"] = g_paired_devices.size();
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    // REST: POST /api/system/control (reboot support for Web UI updates)
    server.on("/api/system/control", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            bool rebootReq = false;
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                if (doc["reboot"].as<bool>() || doc["action"] == "reboot") {
                    rebootReq = true;
                }
            }
            request->send(200, "application/json", "{\"status\":\"ok\",\"rebooting\":true}");
            if (rebootReq) {
                Serial.println("[SYSTEM] Reboot requested via Web API...");
                delay(500);
                ESP.restart();
            }
        }
    );

    // REST: POST /api/ota (Firmware OTA flash from Web UI - supports raw binary or multipart)
    server.on("/api/ota", HTTP_POST,
        [](AsyncWebServerRequest *request) {
            bool success = !Update.hasError() && Update.isFinished();
            AsyncWebServerResponse *response = request->beginResponse(
                success ? 200 : 500,
                "application/json",
                success ? "{\"status\":\"success\",\"message\":\"Firmware flashed. Rebooting...\"}"
                        : "{\"status\":\"error\",\"message\":\"OTA flash failed\"}"
            );
            response->addHeader("Connection", "close");
            response->addHeader("Access-Control-Allow-Origin", "*");
            request->send(response);
            if (success) {
                Serial.println("[OTA] Firmware write complete. Restarting ESP32 in 1s...");
                delay(1000);
                ESP.restart();
            }
        },
        [](AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final) {
            // Multipart upload handler
            if (!index) {
                Serial.printf("[OTA] Multipart firmware update started (file: %s)\n", filename.c_str());
                if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)) {
                    Update.printError(Serial);
                }
            }
            if (!Update.hasError()) {
                if (Update.write(data, len) != len) {
                    Update.printError(Serial);
                }
            }
            if (final) {
                if (Update.end(true)) {
                    Serial.printf("[OTA] Firmware flash completed: %u bytes written\n", index + len);
                } else {
                    Update.printError(Serial);
                }
            }
        },
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            // Raw binary stream handler (used by XMLHttpRequest.send(blob) & fetch)
            if (!index) {
                Serial.printf("[OTA] Raw binary firmware update started: %u bytes\n", total);
                if (!Update.begin(total > 0 ? total : UPDATE_SIZE_UNKNOWN, U_FLASH)) {
                    Update.printError(Serial);
                }
            }
            if (!Update.hasError()) {
                if (Update.write(data, len) != len) {
                    Update.printError(Serial);
                }
            }
            if (index + len >= total) {
                if (Update.end(true)) {
                    Serial.printf("[OTA] Raw firmware flash completed: %u bytes written\n", total);
                } else {
                    Update.printError(Serial);
                }
            }
        }
    );

    // REST: GET /api/ota/status
    server.on("/api/ota/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["in_progress"] = g_atom_ota_state.in_progress;
        doc["progress"] = g_atom_ota_state.progress_pct;
        doc["success"] = g_atom_ota_state.success;
        doc["error"] = g_atom_ota_state.error_msg;
        String out;
        serializeJson(doc, out);
        AsyncWebServerResponse *resp = request->beginResponse(200, "application/json", out);
        resp->addHeader("Access-Control-Allow-Origin", "*");
        request->send(resp);
    });

    // REST: POST /api/ota/cloud_pull
    server.on("/api/ota/cloud_pull", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            String download_url = "";
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                download_url = doc["url"] | "";
            }
            if (download_url.isEmpty()) {
                request->send(400, "application/json", "{\"error\":\"Missing url\"}");
                return;
            }
            if (g_atom_ota_state.in_progress) {
                request->send(409, "application/json", "{\"error\":\"OTA already in progress\"}");
                return;
            }

            g_atom_ota_state.in_progress = true;
            g_atom_ota_state.progress_pct = 0;
            g_atom_ota_state.success = false;
            g_atom_ota_state.error_msg = "";

            AsyncWebServerResponse *resp = request->beginResponse(200, "application/json", "{\"status\":\"started\"}");
            resp->addHeader("Access-Control-Allow-Origin", "*");
            request->send(resp);

            String *urlAlloc = new String(download_url);
            xTaskCreate([](void* param) {
                String* targetUrl = static_cast<String*>(param);
                Serial.printf("[OTA] Starting Cloud Pull from %s\n", targetUrl->c_str());
                WiFiClientSecure client;
                client.setInsecure();
                HTTPClient http;
                http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
                http.setTimeout(30000);

                if (http.begin(client, *targetUrl)) {
                    int httpCode = http.GET();
                    if (httpCode == HTTP_CODE_OK) {
                        int totalLen = http.getSize();
                        WiFiClient *stream = http.getStreamPtr();
                        if (Update.begin(totalLen > 0 ? totalLen : UPDATE_SIZE_UNKNOWN, U_FLASH)) {
                            size_t written = 0;
                            uint8_t buff[1024];
                            while (http.connected() && (totalLen < 0 || written < (size_t)totalLen)) {
                                size_t avail = stream->available();
                                if (avail) {
                                    int c = stream->readBytes(buff, std::min(avail, sizeof(buff)));
                                    Update.write(buff, c);
                                    written += c;
                                    if (totalLen > 0) {
                                        g_atom_ota_state.progress_pct = (written * 100) / totalLen;
                                    }
                                }
                                vTaskDelay(1);
                            }
                            if (Update.end(true)) {
                                g_atom_ota_state.success = true;
                                g_atom_ota_state.progress_pct = 100;
                                Serial.println("[OTA] Cloud pull success! Rebooting in 1s...");
                                vTaskDelay(pdMS_TO_TICKS(1000));
                                ESP.restart();
                            } else {
                                g_atom_ota_state.error_msg = "Flash write failed";
                            }
                        } else {
                            g_atom_ota_state.error_msg = "Update.begin failed";
                        }
                    } else {
                        g_atom_ota_state.error_msg = String("HTTP error ") + httpCode;
                    }
                    http.end();
                } else {
                    g_atom_ota_state.error_msg = "Connection failed";
                }
                g_atom_ota_state.in_progress = false;
                delete targetUrl;
                vTaskDelete(NULL);
            }, "atom_ota_task", 8192, urlAlloc, 2, NULL);
        }
    );

    // REST: POST /api/upload (LittleFS file staging from Web UI - supports raw binary or multipart)
    server.on("/api/upload", HTTP_POST,
        [](AsyncWebServerRequest *request) {
            AsyncWebServerResponse *response = request->beginResponse(200, "application/json", "{\"status\":\"success\",\"message\":\"File saved successfully.\"}");
            response->addHeader("Access-Control-Allow-Origin", "*");
            request->send(response);
        },
        [](AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final) {
            // Multipart staging
            static File s_upload_file;
            if (!index) {
                String path = "";
                if (request->hasHeader("X-File-Path")) {
                    path = request->getHeader("X-File-Path")->value();
                } else {
                    path = "/" + filename;
                }
                if (!path.startsWith("/")) path = "/" + path;
                int lastSlash = path.lastIndexOf('/');
                if (lastSlash > 0) {
                    String dirPath = path.substring(0, lastSlash);
                    LittleFS.mkdir(dirPath);
                }
                s_upload_file = LittleFS.open(path, "w");
                Serial.printf("[UPLOAD] Staging file: %s\n", path.c_str());
            }
            if (s_upload_file && len > 0) {
                s_upload_file.write(data, len);
            }
            if (final) {
                if (s_upload_file) {
                    s_upload_file.close();
                    Serial.printf("[UPLOAD] Finished: %s (%u bytes)\n", filename.c_str(), index + len);
                }
            }
        },
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            // Raw binary staging
            static File s_raw_file;
            if (!index) {
                String path = "";
                if (request->hasHeader("X-File-Path")) {
                    path = request->getHeader("X-File-Path")->value();
                } else {
                    path = "/upload.bin";
                }
                if (!path.startsWith("/")) path = "/" + path;
                int lastSlash = path.lastIndexOf('/');
                if (lastSlash > 0) {
                    String dirPath = path.substring(0, lastSlash);
                    LittleFS.mkdir(dirPath);
                }
                s_raw_file = LittleFS.open(path, "w");
                Serial.printf("[UPLOAD] Staging raw file: %s (%u bytes)\n", path.c_str(), total);
            }
            if (s_raw_file && len > 0) {
                s_raw_file.write(data, len);
            }
            if (index + len >= total) {
                if (s_raw_file) {
                    s_raw_file.close();
                    Serial.printf("[UPLOAD] Finished raw file (%u bytes)\n", total);
                }
            }
        }
    );

    // REST: BLE API for BluetoothManager.tsx
    // GET /api/ble/status
    server.on("/api/ble/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json", get_ble_status_json());
    });

    // POST /api/ble/scan
    server.on("/api/ble/scan", HTTP_POST, [](AsyncWebServerRequest *request) {
        uint32_t dur = 10;
        if (request->hasParam("duration")) {
            dur = request->getParam("duration")->value().toInt();
            if (dur == 0 || dur > 60) dur = 10;
        }
        start_ble_scan(dur);
        request->send(200, "application/json", "{\"status\":\"scanning_started\"}");
    });

    // POST /api/ble/pair
    server.on("/api/ble/pair", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                String addr = doc["mac"] | doc["address"] | "";
                String name = doc["name"] | "";
                if (!addr.isEmpty()) {
                    pair_ble_device(addr, name);
                    request->send(200, "application/json", "{\"status\":\"paired\",\"address\":\"" + addr + "\"}");
                    return;
                }
            }
            request->send(400, "application/json", "{\"error\":\"invalid_payload\"}");
        }
    );

    // REST: GET /api/automations & /automations.json (Avoids UI loading alerts when browsing Atom Lite bridge directly)
    server.on("/api/automations", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json", "{\"settings\":{\"vehicle_model\":\"all_egmp\",\"unit_system\":\"imperial\"},\"rules\":[]}");
    });
    server.on("/automations.json", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json", "{\"settings\":{\"vehicle_model\":\"all_egmp\",\"unit_system\":\"imperial\"},\"rules\":[]}");
    });

    // POST /api/ble/unpair
    server.on("/api/ble/unpair", HTTP_POST, [](AsyncWebServerRequest *request) {
        unpair_all_ble_devices();
        request->send(200, "application/json", "{\"status\":\"unpaired\"}");
    });

    // POST /api/ble/disconnect
    server.on("/api/ble/disconnect", HTTP_POST, [](AsyncWebServerRequest *request) {
        disconnect_ble_client();
        broadcast_ble_status();
        request->send(200, "application/json", "{\"status\":\"disconnected\"}");
    });

    // POST /api/ble/test_event
    server.on("/api/ble/test_event", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            String btn = "volume_up";
            String act = "press";
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                btn = doc["button"] | "volume_up";
                act = doc["action"] | "press";
            }
            String dev_name = !g_paired_devices.empty() ? g_paired_devices[0].name : "Virtual Remote";
            String dev_addr = !g_paired_devices.empty() ? g_paired_devices[0].address : "00:00:00:00:00:00";
            fire_ble_button_event(dev_addr, dev_name, btn, act);
            request->send(200, "application/json", "{\"status\":\"ok\"}");
        }
    );

    // REST: GET /api/ble/beacons
    server.on("/api/ble/beacons", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        JsonArray targets = doc["targets"].to<JsonArray>();
        for (const auto& b : g_beacon_targets) {
            JsonObject item = targets.add<JsonObject>();
            item["uuid"] = b.uuid;
            item["mac"] = b.mac;
            item["name"] = b.name;
            item["enter_rssi"] = b.enter_rssi;
            item["exit_timeout_s"] = b.exit_timeout_s;
            item["is_present"] = b.is_present;
            item["rssi"] = b.last_rssi;
            item["major"] = b.major;
            item["minor"] = b.minor;
        }
        JsonArray discovered = doc["discovered"].to<JsonArray>();
        for (const auto& b : g_discovered_beacons) {
            if (millis() - b.last_seen_ms < 60000) {
                JsonObject item = discovered.add<JsonObject>();
                item["uuid"] = b.uuid;
                item["mac"] = b.mac;
                item["rssi"] = b.rssi;
                item["major"] = b.major;
                item["minor"] = b.minor;
            }
        }
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    // REST: POST /api/ble/beacons
    server.on("/api/ble/beacons", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                String uuid = doc["uuid"] | "";
                String mac = doc["mac"] | doc["address"] | "";
                String name = doc["name"] | "Phone Beacon";
                int enter_rssi = doc["enter_rssi"] | -75;
                int exit_timeout = doc["exit_timeout_s"] | doc["exit_timeout"] | 10;
                if (!uuid.isEmpty() || !mac.isEmpty()) {
                    bool updated = false;
                    for (auto& b : g_beacon_targets) {
                        if ((!uuid.isEmpty() && b.uuid.equalsIgnoreCase(uuid)) ||
                            (!mac.isEmpty() && b.mac.equalsIgnoreCase(mac))) {
                            b.uuid = uuid;
                            b.mac = mac;
                            b.name = name;
                            b.enter_rssi = enter_rssi;
                            b.exit_timeout_s = exit_timeout;
                            updated = true;
                            break;
                        }
                    }
                    if (!updated) {
                        BeaconTarget bt;
                        bt.uuid = uuid;
                        bt.mac = mac;
                        bt.name = name;
                        bt.enter_rssi = enter_rssi;
                        bt.exit_timeout_s = exit_timeout;
                        g_beacon_targets.push_back(bt);
                    }
                    persist_beacon_targets();
                    broadcast_ble_status();
                    request->send(200, "application/json", "{\"status\":\"ok\"}");
                    return;
                }
            }
            request->send(400, "application/json", "{\"error\":\"invalid_payload\"}");
        }
    );

    // REST: DELETE /api/ble/beacons
    server.on("/api/ble/beacons", HTTP_DELETE, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            String target_uuid = "";
            String target_mac = "";
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                target_uuid = doc["uuid"] | "";
                target_mac = doc["mac"] | doc["address"] | "";
            } else if (request->hasParam("uuid")) {
                target_uuid = request->getParam("uuid")->value();
            } else if (request->hasParam("mac")) {
                target_mac = request->getParam("mac")->value();
            }

            if (!target_uuid.isEmpty() || !target_mac.isEmpty()) {
                for (auto it = g_beacon_targets.begin(); it != g_beacon_targets.end(); ) {
                    if ((!target_uuid.isEmpty() && it->uuid.equalsIgnoreCase(target_uuid)) ||
                        (!target_mac.isEmpty() && it->mac.equalsIgnoreCase(target_mac))) {
                        it = g_beacon_targets.erase(it);
                    } else {
                        ++it;
                    }
                }
                persist_beacon_targets();
                broadcast_ble_status();
                request->send(200, "application/json", "{\"status\":\"ok\"}");
                return;
            }
            request->send(400, "application/json", "{\"error\":\"missing_target\"}");
        }
    );

    // REST: GET /api/wifi/status
    server.on("/api/wifi/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        bool connected = (WiFi.status() == WL_CONNECTED);
        doc["sta_connected"] = connected;
        doc["sta_ssid"] = connected ? WiFi.SSID() : "";
        doc["sta_ip"] = connected ? WiFi.localIP().toString() : "";
        doc["sta_gw"] = connected ? WiFi.gatewayIP().toString() : "";
        doc["sta_mask"] = connected ? WiFi.subnetMask().toString() : "";
        doc["sta_rssi"] = connected ? WiFi.RSSI() : 0;

        doc["ap_active"] = g_softap_active;
        doc["ap_ssid"] = g_ap_ssid;
        doc["ap_ip"] = g_softap_active ? WiFi.softAPIP().toString() : "";
        doc["ap_clients"] = g_softap_active ? WiFi.softAPgetStationNum() : 0;
        doc["ap_mode"] = "auto";

        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    // REST: GET /api/wifi/networks
    server.on("/api/wifi/networks", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        JsonArray arr = doc.to<JsonArray>();
        for (const auto& net : g_saved_wifi) {
            JsonObject item = arr.add<JsonObject>();
            item["ssid"] = net.ssid;
            item["priority"] = net.priority;
        }
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    // REST: POST /api/wifi/networks
    server.on("/api/wifi/networks", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                const char* ssid = doc["ssid"];
                const char* pass = doc["password"] | "";
                int prio = doc["priority"] | 50;

                if (ssid && strlen(ssid) > 0) {
                    bool updated = false;
                    for (auto& net : g_saved_wifi) {
                        if (net.ssid.equalsIgnoreCase(ssid)) {
                            net.password = pass;
                            net.priority = prio;
                            updated = true;
                            break;
                        }
                    }
                    if (!updated) {
                        g_saved_wifi.push_back({String(ssid), String(pass), prio});
                    }
                    persist_saved_wifi();
                    Serial.printf("[WIFI] Saved network '%s' (priority %d)\n", ssid, prio);

                    // Connect immediately
                    WiFi.begin(ssid, pass);

                    // Forward to WiCAN over UART bridge
                    JsonDocument wican_doc;
                    wican_doc["type"] = "wifi_save";
                    wican_doc["ssid"] = ssid;
                    wican_doc["password"] = pass;
                    wican_doc["priority"] = prio;
                    String wican_str;
                    serializeJson(wican_doc, wican_str);
                    send_to_wican(wican_str);

                    request->send(200, "application/json", "{\"status\":\"ok\",\"message\":\"Network saved\"}");
                    return;
                }
            }
            request->send(400, "application/json", "{\"error\":\"invalid_payload\"}");
        }
    );

    // REST: DELETE /api/wifi/networks
    server.on("/api/wifi/networks", HTTP_DELETE, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            String target_ssid = "";
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                target_ssid = doc["ssid"].as<String>();
            } else if (request->hasParam("ssid")) {
                target_ssid = request->getParam("ssid")->value();
            }

            if (!target_ssid.isEmpty()) {
                for (auto it = g_saved_wifi.begin(); it != g_saved_wifi.end(); ) {
                    if (it->ssid.equalsIgnoreCase(target_ssid)) {
                        it = g_saved_wifi.erase(it);
                    } else {
                        ++it;
                    }
                }
                persist_saved_wifi();
                Serial.printf("[WIFI] Deleted network '%s'\n", target_ssid.c_str());

                // Forward removal to WiCAN over UART bridge
                JsonDocument wican_doc;
                wican_doc["type"] = "wifi_delete";
                wican_doc["ssid"] = target_ssid;
                String wican_str;
                serializeJson(wican_doc, wican_str);
                send_to_wican(wican_str);

                request->send(200, "application/json", "{\"status\":\"ok\"}");
                return;
            }
            request->send(400, "application/json", "{\"error\":\"missing_ssid\"}");
        }
    );

    // REST: GET /api/wifi/scan
    server.on("/api/wifi/scan", HTTP_GET, [](AsyncWebServerRequest *request) {
        int n = WiFi.scanNetworks();
        JsonDocument doc;
        JsonArray arr = doc.to<JsonArray>();
        for (int i = 0; i < n; i++) {
            JsonObject item = arr.add<JsonObject>();
            item["ssid"] = WiFi.SSID(i);
            item["rssi"] = WiFi.RSSI(i);
            item["authmode"] = (int)WiFi.encryptionType(i);
            item["channel"] = WiFi.channel(i);
        }
        WiFi.scanDelete();
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    // REST: POST /api/wifi/settings
    server.on("/api/wifi/settings", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                const char* ssid = doc["ap_ssid"];
                const char* pass = doc["ap_password"];
                g_wifi_prefs.begin("wifi_config", false);
                if (ssid && strlen(ssid) > 0) {
                    g_ap_ssid = ssid;
                    g_wifi_prefs.putString("ap_ssid", g_ap_ssid);
                }
                if (pass && strlen(pass) >= 8) {
                    g_ap_pass = pass;
                    g_wifi_prefs.putString("ap_pass", g_ap_pass);
                }
                g_wifi_prefs.end();
                WiFi.softAP(g_ap_ssid.c_str(), g_ap_pass.c_str());
                Serial.printf("[WIFI] Updated SoftAP credentials: '%s' / '%s'\n", g_ap_ssid.c_str(), g_ap_pass.c_str());
            }
            request->send(200, "application/json", "{\"status\":\"ok\"}");
        }
    );

    // Serve Static SPA files from LittleFS
    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html").setCacheControl("max-age=600");

    // SPA Fallback for client-side routing (strictly never for /api/ routes)
    server.onNotFound([](AsyncWebServerRequest *request) {
        if (request->url().startsWith("/api/")) {
            AsyncWebServerResponse *response = request->beginResponse(404, "application/json", "{\"status\":\"error\",\"message\":\"Endpoint not found\"}");
            response->addHeader("Access-Control-Allow-Origin", "*");
            request->send(response);
            return;
        }
        if (request->method() == HTTP_OPTIONS) {
            request->send(204);
        } else if (LittleFS.exists("/index.html.gz")) {
            AsyncWebServerResponse *response = request->beginResponse(LittleFS, "/index.html.gz", "text/html");
            response->addHeader("Content-Encoding", "gzip");
            request->send(response);
        } else if (LittleFS.exists("/index.html")) {
            request->send(LittleFS, "/index.html", "text/html");
        } else {
            request->send(404, "text/plain", "CAN-Do Web Assets Not Found. Flash LittleFS data partition.");
        }
    });

    server.begin();
    Serial.println("[HTTP] Web server started on port 80");

    // Initial ping to WiCAN
    send_to_wican("{\"type\":\"ping\"}");
    request_wican_states_throttled();

    update_led_status();
}

// ============================================================================
// Main Loop
// ============================================================================
void loop() {
    // 1. Clean up stale WebSocket clients & flush thread-safe WS outbox
    ws.cleanupClients();
    flush_ws_outbox();

    // 1b. Service deferred BLE connection requests outside NimBLE Host callback context
    if (g_pending_ble_connect_req) {
        String target_addr;
        uint8_t target_type;
        {
            std::lock_guard<std::mutex> lock(g_ble_pending_mutex);
            target_addr = g_pending_ble_connect_addr;
            target_type = g_pending_ble_connect_type;
            g_pending_ble_connect_req = false;
        }
        if (!target_addr.isEmpty() && !g_ble_client_connected) {
            NimBLEDevice::getScan()->stop();
            connect_ble_device(target_addr, target_type, nullptr);
            if (!g_ble_client_connected && !g_ble_scanning) {
                NimBLEDevice::getScan()->start(0, nullptr, false);
            }
        }
    }

    // 2. Bounded UART read from WiCAN (max 16 lines per loop pass so HTTP/WS never starve)
    static String rx_line = "";
    int lines_read = 0;
    while (Serial2.available() && lines_read < 16) {
        char c = (char)Serial2.read();
        if (c == '\n' || c == '\r') {
            if (rx_line.length() > 0) {
                handle_wican_message(rx_line);
                rx_line = "";
                lines_read++;
            }
        } else if ((uint8_t)c >= 0x20 && (uint8_t)c <= 0x7E) {
            if (rx_line.length() < 8192) {
                rx_line += c;
            } else {
                rx_line = "";
            }
        } else {
            rx_line = "";
        }
    }

    // 3. Heartbeat / link check
    static unsigned long last_ping_ms = 0;
    if (millis() - last_ping_ms > 3000) {
        last_ping_ms = millis();
        if (millis() - g_last_wican_rx_ms > 6000) {
            if (g_wican_online) {
                g_wican_online = false;
                Serial.println("[UART] WiCAN link lost (no response)");
                update_led_status();
            }
        }
        send_to_wican("{\"type\":\"ping\"}");
    }

    // 4. BLE Scan Periodic Status Broadcast
    static unsigned long last_scan_broadcast_ms = 0;
    if (g_ble_scanning && (millis() - last_scan_broadcast_ms > 2000)) {
        last_scan_broadcast_ms = millis();
        broadcast_ble_status();
    }

    // 5. Onboard Atom Lite Button Check (Toggles Precondition on press)
    static bool last_btn_state = HIGH;
    bool btn_state = digitalRead(BUTTON_PIN);
    if (last_btn_state == HIGH && btn_state == LOW) {
        delay(50); // Debounce
        if (digitalRead(BUTTON_PIN) == LOW) {
            Serial.println("[BTN] Atom Lite button pressed -> sending preheat toggle to WiCAN");
            set_led_color(CRGB::White);
            send_to_wican("{\"type\":\"trigger\",\"action\":\"precon_toggle\"}");
            delay(200);
            update_led_status();
        }
    }
    last_btn_state = btn_state;

    // 6. Wi-Fi Station reconnect watchdog (every 60s)
    static unsigned long last_wifi_check_ms = 0;
    if (millis() - last_wifi_check_ms > 60000) {
        last_wifi_check_ms = millis();
        if (!g_saved_wifi.empty() && WiFi.status() != WL_CONNECTED) {
            connect_to_best_wifi();
        }
    }

    // 7. Auto-reconnect to paired BLE device if disconnected and not scanning
    static unsigned long last_ble_reconnect_ms = 0;
    if (!g_ble_scanning && !g_ble_client_connected && !g_paired_devices.empty() && (millis() - last_ble_reconnect_ms > 45000)) {
        last_ble_reconnect_ms = millis();
        Serial.printf("[BLE] Auto-reconnecting to paired device %s (type=%d)...\n",
                      g_paired_devices[0].address.c_str(), g_paired_devices[0].addr_type);
        connect_ble_device(g_paired_devices[0].address, g_paired_devices[0].addr_type);
    }

    // 8. Beacon Exit Timeout Watchdog
    static unsigned long last_beacon_exit_check = 0;
    if (millis() - last_beacon_exit_check > 1000) {
        last_beacon_exit_check = millis();
        for (auto& target : g_beacon_targets) {
            if (target.is_present && (millis() - target.last_seen_ms > (unsigned long)target.exit_timeout_s * 1000)) {
                target.is_present = false;
                Serial.printf("[BEACON] Target '%s' EXITED (timeout %ds)\n",
                              target.name.c_str(), target.exit_timeout_s);
                String uart_msg = "{\"type\":\"ble_beacon\",\"event\":\"exit\",\"uuid\":\"" + target.uuid + "\",\"mac\":\"" + target.mac + "\",\"name\":\"" + target.name + "\",\"rssi\":" + String(target.last_rssi) + "}";
                send_to_wican(uart_msg);
                safe_ws_broadcast(uart_msg);
            }
        }
    }

    // 8. Interactive Serial Console Commands
    static String console_line = "";
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            console_line.trim();
            if (console_line.length() > 0) {
                if (console_line.equalsIgnoreCase("help")) {
                    Serial.println("\n--- Atom Bridge BLE CLI Commands ---");
                    Serial.println("  scan               - Start BLE scan (10s)");
                    Serial.println("  devices            - List discovered BLE devices");
                    Serial.println("  paired             - List paired BLE devices");
                    Serial.println("  pair <mac>         - Pair with BLE device");
                    Serial.println("  unpair <mac>       - Unpair BLE device");
                    Serial.println("  test               - Fire test BLE button press (volume_up)");
                    Serial.println("  btn                - Simulate Atom face button (precon toggle)");
                    Serial.println("  status             - Print bridge & Wi-Fi status");
                    Serial.println("------------------------------------");
                } else if (console_line.equalsIgnoreCase("scan")) {
                    start_ble_scan(10);
                } else if (console_line.equalsIgnoreCase("devices")) {
                    Serial.printf("[BLE] Discovered %u devices:\n", g_discovered_devices.size());
                    for (const auto& dev : g_discovered_devices) {
                        Serial.printf("  %s | %s (RSSI: %d dBm)\n", dev.address.c_str(), dev.name.c_str(), dev.rssi);
                    }
                } else if (console_line.equalsIgnoreCase("paired")) {
                    Serial.printf("[BLE] Paired %u devices:\n", g_paired_devices.size());
                    for (const auto& dev : g_paired_devices) {
                        Serial.printf("  %s | %s (Conn: %d, Batt: %d%%)\n", dev.address.c_str(), dev.name.c_str(), dev.connected, dev.battery_pct);
                    }
                } else if (console_line.startsWith("pair ")) {
                    String target = console_line.substring(5);
                    target.trim();
                    pair_ble_device(target);
                } else if (console_line.startsWith("unpair")) {
                    unpair_all_ble_devices();
                } else if (console_line.equalsIgnoreCase("test")) {
                    fire_ble_button_event("TEST-ADDR", "BLE Test Button", "volume_up", "press");
                } else if (console_line.equalsIgnoreCase("btn")) {
                    Serial.println("[BTN] Atom button triggered via CLI -> sending precon_toggle to WiCAN");
                    send_to_wican("{\"type\":\"trigger\",\"action\":\"precon_toggle\"}");
                } else if (console_line.startsWith("wifi ")) {
                    String rest = console_line.substring(5);
                    rest.trim();
                    String s = "", p = "";
                    if (rest.startsWith("\"")) {
                        int q2 = rest.indexOf('"', 1);
                        if (q2 > 1) {
                            s = rest.substring(1, q2);
                            p = rest.substring(q2 + 1);
                            p.trim();
                        }
                    } else {
                        int spaceIdx = rest.indexOf(' ');
                        if (spaceIdx > 0) {
                            s = rest.substring(0, spaceIdx);
                            p = rest.substring(spaceIdx + 1);
                            p.trim();
                        }
                    }
                    if (!s.isEmpty()) {
                        bool found = false;
                        for (auto& net : g_saved_wifi) {
                            if (net.ssid.equalsIgnoreCase(s)) {
                                net.password = p;
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            g_saved_wifi.insert(g_saved_wifi.begin(), {s, p, 100});
                        }
                        persist_saved_wifi();
                        Serial.printf("[WIFI] Saved network '%s' -> connecting...\n", s.c_str());
                        connect_to_best_wifi();
                    }
                } else if (console_line.equalsIgnoreCase("status")) {
                    Serial.printf("[STATUS] Device: %s, WiCAN Online: %d, Free Heap: %u, WS Clients: %u\n",
                                  g_device_id.c_str(), g_wican_online, ESP.getFreeHeap(), ws.count());
                    Serial.printf("[WIFI] Mode: SoftAP '%s' (192.168.4.1), STA: %s (IP: %s)\n",
                                  g_ap_ssid.c_str(), WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected",
                                  WiFi.localIP().toString().c_str());
                } else {
                    // Forward unknown raw command directly to WiCAN over bridge
                    send_to_wican(console_line);
                }
                console_line = "";
            }
        } else {
            if (console_line.length() < 256) console_line += c;
        }
    }
}
