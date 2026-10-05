#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include <esp_mac.h>
#include <LittleFS.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <NimBLEDevice.h>
#include <map>
#include <vector>

// ============================================================================
// Hardware Pin Definitions (M5Stack Atom Lite)
// ============================================================================
#define LED_PIN         27      // SK6812 Single RGB LED
#define BUTTON_PIN      39      // Onboard user button (active LOW)
#define GROVE_RX_PIN    26      // Connect to WiCAN IO1 (TX)
#define GROVE_TX_PIN    32      // Connect to WiCAN IO5 (RX)
#define UART_BAUD       921600  // High-speed UART link

CRGB leds[1];

// ============================================================================
// Web Server & WebSocket
// ============================================================================
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

// State Cache (mirrors latest states from WiCAN)
std::map<String, String> g_state_cache;
unsigned long g_last_wican_rx_ms = 0;
bool g_wican_online = false;

// ============================================================================
// BLE Subsystem (NimBLE)
// ============================================================================
bool g_ble_scanning = false;
unsigned long g_ble_scan_start_ms = 0;
const unsigned long BLE_SCAN_DURATION_MS = 10000;

struct DiscoveredDevice {
    String address;
    String name;
    int rssi;
    bool is_connectable;
};

std::vector<DiscoveredDevice> g_discovered_devices;
std::vector<String> g_paired_devices;

// Forward Declarations
void set_led_color(CRGB color);
void send_to_wican(const String& line);
void handle_wican_message(const String& line);

// ============================================================================
// Wi-Fi Storage & Manager
// ============================================================================
String g_device_id = "can-do";
String g_ap_ssid = "CAN Do";
String g_ap_pass = "candorules";

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
    Serial.printf("[SYSTEM] Device ID initialized from MAC: %s, SoftAP SSID: '%s'\n", 
                  g_device_id.c_str(), g_ap_ssid.c_str());
}

struct SavedWifiNetwork {
    String ssid;
    String password;
    int priority;
};

std::vector<SavedWifiNetwork> g_saved_wifi;
Preferences g_prefs;

void load_saved_wifi() {
    g_saved_wifi.clear();
    g_prefs.begin("wifi_config", false);
    String custom_ap_ssid = g_prefs.getString("ap_ssid", "");
    String custom_ap_pass = g_prefs.getString("ap_pass", "");
    if (!custom_ap_ssid.isEmpty()) g_ap_ssid = custom_ap_ssid;
    if (!custom_ap_pass.isEmpty()) g_ap_pass = custom_ap_pass;

    String json_str = g_prefs.getString("networks", "[]");
    g_prefs.end();

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
    Serial.printf("[WIFI] Loaded %u saved roaming networks from NVS\n", g_saved_wifi.size());
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
    g_prefs.begin("wifi_config", false);
    g_prefs.putString("networks", json_str);
    g_prefs.end();
}

void connect_to_best_wifi() {
    if (g_saved_wifi.empty()) return;
    int best_idx = 0;
    for (size_t i = 1; i < g_saved_wifi.size(); i++) {
        if (g_saved_wifi[i].priority > g_saved_wifi[best_idx].priority) {
            best_idx = i;
        }
    }
    Serial.printf("[WIFI] Connecting to '%s'...\n", g_saved_wifi[best_idx].ssid.c_str());
    WiFi.begin(g_saved_wifi[best_idx].ssid.c_str(), g_saved_wifi[best_idx].password.c_str());
}

// ============================================================================
// NimBLE Scan Callbacks
// ============================================================================
class AdvertisedDeviceCallbacks : public NimBLEAdvertisedDeviceCallbacks {
    void onResult(NimBLEAdvertisedDevice* advertisedDevice) override {
        String addr = advertisedDevice->getAddress().toString().c_str();
        String name = advertisedDevice->getName().c_str();
        if (name.isEmpty()) name = "Unknown Device";
        int rssi = advertisedDevice->getRSSI();

        // Check if already in scan list
        bool exists = false;
        for (auto& dev : g_discovered_devices) {
            if (dev.address.equalsIgnoreCase(addr)) {
                dev.rssi = rssi;
                exists = true;
                break;
            }
        }
        if (!exists) {
            g_discovered_devices.push_back({addr, name, rssi, true});
        }

        // Check if device is paired and triggered
        for (const auto& paired_addr : g_paired_devices) {
            if (paired_addr.equalsIgnoreCase(addr)) {
                // Button click detected from paired beacon / remote!
                set_led_color(CRGB::Purple);
                Serial.printf("[BLE] Paired button trigger from %s (%s)\n", addr.c_str(), name.c_str());

                // Broadcast to frontend WebSocket
                String event_json = "{\"type\":\"ble_event\",\"address\":\"" + addr + "\",\"name\":\"" + name + "\"}";
                ws.textAll(event_json);

                // Send trigger to WiCAN
                send_to_wican("{\"type\":\"trigger\",\"action\":\"precon_toggle\"}");
                break;
            }
        }
    }
};

// ============================================================================
// Helper Functions
// ============================================================================
void set_led_color(CRGB color) {
    leds[0] = color;
    FastLED.show();
}

void send_to_wican(const String& line) {
    Serial2.print(line);
    if (!line.endsWith("\n")) {
        Serial2.print("\n");
    }
}

void update_led_status() {
    if (!g_wican_online) {
        set_led_color(CRGB::Red);
    } else if (ws.count() > 0) {
        set_led_color(CRGB::Blue); // Web browser client active
    } else {
        set_led_color(CRGB::Green); // Normal idle ready
    }
}

// ============================================================================
// WebSocket Event Handler
// ============================================================================
void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.printf("[WS] Client #%u connected from %s\n", client->id(), client->remoteIP().toString().c_str());
        
        // Dump current cached states to new client
        JsonDocument doc;
        JsonArray arr = doc.to<JsonArray>();
        for (const auto& pair : g_state_cache) {
            JsonObject item = arr.add<JsonObject>();
            item["entity"] = pair.first;
            item["state"] = pair.second;
        }
        String out;
        serializeJson(doc, out);
        client->text(out);

        // Request fresh state sync from WiCAN
        send_to_wican("{\"type\":\"get_states\"}");
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
            // Transparently forward client commands to WiCAN
            send_to_wican(msg);
        }
    }
}

// ============================================================================
// Incoming WiCAN Message Handler
// ============================================================================
void handle_wican_message(const String& line) {
    g_last_wican_rx_ms = millis();
    if (!g_wican_online) {
        g_wican_online = true;
        Serial.println("[UART] WiCAN link established!");
        update_led_status();
    }

    // Forward raw JSON directly to connected WebSockets
    if (ws.count() > 0) {
        ws.textAll(line);
    }

    // Inspect for state caching
    if (line.indexOf("\"type\":\"state\"") >= 0) {
        JsonDocument doc;
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            const char* entity = doc["entity"];
            const char* state = doc["state"];
            if (entity && state) {
                g_state_cache[String(entity)] = String(state);
            }
        }
    } else if (line.indexOf("\"type\":\"states_dump\"") >= 0) {
        JsonDocument doc;
        if (deserializeJson(doc, line) == DeserializationError::Ok) {
            JsonArray arr = doc["data"].as<JsonArray>();
            for (JsonObject item : arr) {
                const char* entity = item["entity"];
                const char* state = item["state"];
                if (entity && state) {
                    g_state_cache[String(entity)] = String(state);
                }
            }
            Serial.printf("[CACHE] Cached %u vehicle states from WiCAN\n", g_state_cache.size());
        }
    }
}

// ============================================================================
// Setup
// ============================================================================
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

    // 2. Button setup
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // 3. Hardware Serial2 link to WiCAN (IO1 -> G26 RX, IO5 -> G32 TX)
    Serial2.begin(UART_BAUD, SERIAL_8N1, GROVE_RX_PIN, GROVE_TX_PIN);
    Serial.printf("[UART] Serial2 initialized at %d baud (RX: %d, TX: %d)\n", UART_BAUD, GROVE_RX_PIN, GROVE_TX_PIN);

    // 4. Mount LittleFS for Frontend SPA assets
    if (!LittleFS.begin(true)) {
        Serial.println("[FS] ERROR: LittleFS mount failed!");
        set_led_color(CRGB::Red);
    } else {
        Serial.printf("[FS] LittleFS mounted successfully. Total: %u KB, Used: %u KB\n",
                      LittleFS.totalBytes() / 1024, LittleFS.usedBytes() / 1024);
    }

    // 5. Initialize Wi-Fi (AP + STA)
    WiFi.mode(WIFI_AP_STA);
    WiFi.setHostname(g_device_id.c_str());

    IPAddress apIP(192, 168, 4, 1);
    WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
    WiFi.softAP(g_ap_ssid.c_str(), g_ap_pass.c_str());
    Serial.printf("[WIFI] SoftAP '%s' active (Pass: '%s') at IP: %s\n", 
                  g_ap_ssid.c_str(), g_ap_pass.c_str(), WiFi.softAPIP().toString().c_str());

    load_saved_wifi();
    if (!g_saved_wifi.empty()) {
        connect_to_best_wifi();
    }

    if (MDNS.begin(g_device_id.c_str())) {
        MDNS.addService("http", "tcp", 80);
        Serial.printf("[MDNS] Responder active: http://%s.local\n", g_device_id.c_str());
    }

    // 6. Setup NimBLE
    NimBLEDevice::init(g_device_id.c_str());
    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->setAdvertisedDeviceCallbacks(new AdvertisedDeviceCallbacks(), false);
    pScan->setActiveScan(true);
    pScan->setInterval(97);
    pScan->setWindow(67);
    pScan->setMaxResults(0); // Do not store in internal cache, handled in callback

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
        for (const auto& pair : g_state_cache) {
            JsonObject item = arr.add<JsonObject>();
            item["entity"] = pair.first;
            item["state"] = pair.second;
        }
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
        // Request fresh sync from WiCAN
        send_to_wican("{\"type\":\"get_states\"}");
    });

    // REST: POST /api/command
    server.on("/api/command", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            
            // Forward command to WiCAN
            send_to_wican(body);
            request->send(200, "application/json", "{\"status\":\"queued\"}");
        }
    );

    // REST: GET /api/system/status
    server.on("/api/system/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["device"] = "M5Stack Atom Lite UI Bridge";
        doc["device_id"] = g_device_id;
        doc["can_do_version"] = "2026.10.2-b001";
        doc["wican_online"] = g_wican_online;
        doc["free_heap"] = ESP.getFreeHeap();
        doc["uptime_s"] = millis() / 1000;
        doc["ws_clients"] = ws.count();
        doc["ble_paired_count"] = g_paired_devices.size();
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    // REST: BLE API for BluetoothManager.tsx
    server.on("/api/ble/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["scanning"] = g_ble_scanning;
        JsonArray paired = doc["paired_devices"].to<JsonArray>();
        for (const auto& addr : g_paired_devices) paired.add(addr);
        
        JsonArray discovered = doc["discovered_devices"].to<JsonArray>();
        for (const auto& dev : g_discovered_devices) {
            JsonObject obj = discovered.add<JsonObject>();
            obj["address"] = dev.address;
            obj["name"] = dev.name;
            obj["rssi"] = dev.rssi;
        }
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    server.on("/api/ble/scan", HTTP_POST, [](AsyncWebServerRequest *request) {
        g_discovered_devices.clear();
        NimBLEDevice::getScan()->start(BLE_SCAN_DURATION_MS / 1000, false);
        g_ble_scanning = true;
        g_ble_scan_start_ms = millis();
        request->send(200, "application/json", "{\"status\":\"scanning_started\"}");
    });

    server.on("/api/ble/pair", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            String body = "";
            for (size_t i = 0; i < len; i++) body += (char)data[i];
            JsonDocument doc;
            if (deserializeJson(doc, body) == DeserializationError::Ok) {
                const char* addr = doc["address"];
                if (addr) {
                    g_paired_devices.push_back(String(addr));
                    request->send(200, "application/json", "{\"status\":\"paired\"}");
                    return;
                }
            }
            request->send(400, "application/json", "{\"error\":\"invalid_payload\"}");
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

        doc["ap_active"] = true;
        doc["ap_ssid"] = g_ap_ssid;
        doc["ap_ip"] = WiFi.softAPIP().toString();
        doc["ap_clients"] = WiFi.softAPgetStationNum();
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
                g_prefs.begin("wifi_config", false);
                if (ssid && strlen(ssid) > 0) {
                    g_ap_ssid = ssid;
                    g_prefs.putString("ap_ssid", g_ap_ssid);
                }
                if (pass && strlen(pass) >= 8) {
                    g_ap_pass = pass;
                    g_prefs.putString("ap_pass", g_ap_pass);
                }
                g_prefs.end();
                WiFi.softAP(g_ap_ssid.c_str(), g_ap_pass.c_str());
                Serial.printf("[WIFI] Updated SoftAP credentials: '%s' / '%s'\n", g_ap_ssid.c_str(), g_ap_pass.c_str());
            }
            request->send(200, "application/json", "{\"status\":\"ok\"}");
        }
    );

    // Serve Static SPA files from LittleFS
    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html").setCacheControl("max-age=600");

    // SPA Fallback for client-side routing
    server.onNotFound([](AsyncWebServerRequest *request) {
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
    send_to_wican("{\"type\":\"get_states\"}");

    update_led_status();
}

// ============================================================================
// Main Loop
// ============================================================================
void loop() {
    // 1. Clean up stale WebSocket clients
    ws.cleanupClients();

    // 2. Read incoming UART from WiCAN
    static String rx_line = "";
    while (Serial2.available()) {
        char c = (char)Serial2.read();
        if (c == '\n' || c == '\r') {
            if (rx_line.length() > 0) {
                handle_wican_message(rx_line);
                rx_line = "";
            }
        } else {
            if (rx_line.length() < 2048) {
                rx_line += c;
            } else {
                rx_line = ""; // Guard buffer overflow
            }
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

    // 4. BLE Scan Timer
    if (g_ble_scanning && (millis() - g_ble_scan_start_ms > BLE_SCAN_DURATION_MS)) {
        g_ble_scanning = false;
        NimBLEDevice::getScan()->stop();
        Serial.println("[BLE] Scan completed");
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

    // 6. Wi-Fi Station reconnect watchdog
    static unsigned long last_wifi_check_ms = 0;
    if (millis() - last_wifi_check_ms > 15000) {
        last_wifi_check_ms = millis();
        if (!g_saved_wifi.empty() && WiFi.status() != WL_CONNECTED) {
            Serial.println("[WIFI] Station disconnected, attempting auto-reconnect...");
            connect_to_best_wifi();
        }
    }
}
