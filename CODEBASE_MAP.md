# CAN Do — Codebase Archaeology & Architecture Map

> **Ground Truth Basis**: Derived directly from live source code in `d:\Documents\can-do` (catalog & version `2026.11.6-b008`). Every subsystem boundary, route, topic, wire format, line number, and broken wire below reflects what the code **actually executes today**, not what comments or docs claim.

---

## 1. System Architecture & Data Flow

### 1.1 Runtime Architecture & Communication Topology

```mermaid
flowchart TB
    subgraph Vehicle["Vehicle Physical Layer (Hyundai / Kia / Genesis E-GMP)"]
        CAN0["CAN Bus 0\nClassic CAN 2.0B 500 kbps\n(B-CAN / M-CAN / C-CAN)"]
        CAN1["CAN Bus 1 (ESP32-S3 only)\nCAN FD 500k / 2M\n(E-CAN / C-CAN FD)"]
        VBAT["12V Aux Battery Rail\n(ADC1 Voltage Divider)"]
        BLE_HW["BLE HID Remotes and\nPhone iBeacons"]
    end

    subgraph ESP32["ESP32 Firmware (ESP32-S3 Dual-CAN+BLE / ESP32-C3 WiCAN)"]
        direction TB
        DRV["CAN PHY Drivers\nmcp2518fd.cpp (SPI2/SPI3, S3)\nESP-IDF TWAI (C3 / fallback)"]
        ADC["vbat_sensor.cpp\nVBAT_MON (3s ADC poll)"]
        BLE["ble_mgr.cpp (S3 only)\nNimBLE Central + Observer\nble_worker (chords / holds / beacons)"]

        subgraph CoreSpine["Core Engine & Persistence"]
            ENGINE["can_engine.cpp (4,240 LOC)\nCAN_RX (prio 5) | CAN_TX (prio 4)\nTIME_SCHED (prio 3) | async bursts\nMITM Bridge (CAN0 <-> CAN1)\nHardcoded Cockpit Decoders (~713 LOC)"]
            PARSER["parser.cpp (2,059 LOC)\nCatalog + Automations Parser\nPSRAM Indexes & MITM Rules"]
            FS["LittleFS (/spiffs)\ncatalog.json, automations.json,\npreferences.json, mqtt.json,\nnetworks.json, monitored_ids.json,\nwww/*.gz, crash_diag.json\n+ NVS (ble_cfg) + RTC NOINIT Cache"]
        end

        subgraph Subsystems["Protocol & Vehicle Subsystems"]
            UDS["uds_engine.cpp\nUDS_WORKER: BMS PID 220101\n0x7E4 -> 0x7EC + ISO-TP RX"]
            PRECON["precondition.c + hsm.c\nconfig_server.c (static stub)\npersistent_settings.c (RAM stub)"]
            POPUP["track_popup.c + isotp_tx.c\nutf8_utf16_converter.c + beep.c"]
            HUD["hud_nav.c + isotp_tx.c\n0x29B / 0x29C (E-GMP) | 0x6E2 / 0x6C0"]
            RCLIM["remote_climate.cpp\nTMU 0x39B + NM 0x561-565 + UDS 0x7DF"]
            AMB["ambient_anim.cpp\n0x4AD 64-Color & Dynamic Effects"]
        end

        subgraph NetBridges["Network, Radio & Host Transports"]
            NET["network_mgr.cpp\nMulti-SSID STA Roam + SoftAP 192.168.4.1\nmDNS (can-do-XXXX.local) + SNTP"]
            HTTP["api.cpp (Port 80)\n39 REST Routes + Static SPA + CORS\nWebSocket /ws + ws_log_wkr\ncloud_ota_task (HTTPS Pull)"]
            MQTT_FW["mqtt_mgr.cpp\nesp_mqtt_client + mqtt_pub\nmqtt_cmd + mqtt_sync + mqtt_auto"]
            GVRET["gvret_server.cpp\nTCP Ports 23 & 3333 (Binary GVRET)\nSuspends automations while connected"]
            USBCAN["usb_can.cpp + serial_cli.cpp\nSTDIN Mux: Binary GVRET 0xF1 0x00,\nSLCAN t/T, JSON CLI, Text CLI"]
            PWR["power_mgr.cpp + timezone_mgr.cpp\nTier 1/2 Sleep + Safe Restart + POSIX TZ"]
        end
    end

    subgraph External["External Clients, Brokers & Services"]
        BROKER["MQTT Broker\n(Mosquitto / HA)"]
        HA["Home Assistant Integration\ncustom_components/can_do/\nPure-MQTT Coordinator + 12 Platforms\n7 Services + 3 HA Bus Events"]
        WEBUI["React 19 SPA (frontend/)\nLittleFS / GitHub Pages\ndeviceWs.ts (/ws) + REST /api/*\nmqtt.js (wss:// automations sync)"]
        GITHUB["GitHub Releases & Raw CDN\nSuperSuave/can-do"]
        SAVVY["SavvyCAN Desktop\n(GVRET TCP 23 / 3333)"]
        PYTOOLS["Host CLI Scripts\nupload_web.py, flash_ota.py,\nwican_log_replay.py, wican_vehicle_stress.py"]
    end

    CAN0 <--> DRV
    CAN1 <--> DRV
    DRV <--> ENGINE
    VBAT --> ADC
    ADC --> ENGINE
    ADC --> HTTP
    ADC --> MQTT_FW
    ADC --> UDS
    BLE_HW <--> BLE
    BLE --> ENGINE
    BLE --> HTTP
    BLE --> MQTT_FW

    FS <--> PARSER
    PARSER <--> ENGINE
    ENGINE <--> UDS
    UDS --> HTTP
    UDS --> MQTT_FW
    ENGINE <--> PRECON
    PRECON --> POPUP
    POPUP --> ENGINE
    ENGINE <--> HUD
    ENGINE <--> RCLIM
    RCLIM --> HTTP
    RCLIM --> MQTT_FW
    ENGINE <--> AMB

    ENGINE <--> HTTP
    ENGINE <--> MQTT_FW
    ENGINE <--> GVRET
    USBCAN <--> ENGINE
    USBCAN <--> NET
    NET <--> MQTT_FW
    NET --> ENGINE
    PWR --> BLE
    PWR --> DRV
    UDS --> PWR
    UDS --> NET

    HTTP <-->|"HTTP REST + WS /ws"| WEBUI
    HTTP -->|"HTTPS Pull"| GITHUB
    MQTT_FW <-->|"MQTT TCP / WS"| BROKER
    BROKER <-->|"MQTT"| HA
    BROKER <-->|"mqtt.js (wss://)"| WEBUI
    WEBUI -->|"HTTPS releases / catalog / assets"| GITHUB
    HA -->|"HTTPS fallback catalog fetch"| GITHUB
    GVRET <-->|"Binary GVRET TCP 23 / 3333"| SAVVY
    PYTOOLS -->|"HTTP /api/ota, /api/upload, /api/test_automation"| HTTP
    PYTOOLS -->|"GVRET TCP 23"| GVRET
    PYTOOLS -->|"USB Serial"| USBCAN
```

### 1.2 Directory & Root Artifact Responsibility Map

| Path | Actual Responsibility Today |
| :--- | :--- |
| [`catalog/`](file:///d:/Documents/can-do/catalog/can_do_catalog.json) | Stores canonical `can_do_catalog.json` (`v2026.11.6-b008`: 24 vehicles, 152 commands across 12 HA domains plus 1 domainless `ambient_light_brightness`, strictly 1-based `D1`–`D8`). Also contains gitignored local scratch script [`catalog/bulk_ingest_telemetry.py`](file:///d:/Documents/can-do/catalog/bulk_ingest_telemetry.py) pointing to a local decompilation path. |
| [`firmware/`](file:///d:/Documents/can-do/firmware/CMakeLists.txt) | ESP-IDF build root, 4 MB (`partitions.csv`: 2×1500 KB OTA + 960 KB LittleFS) and 8 MB (`partitions_8mb.csv`: 2×3072 KB OTA + 1984 KB LittleFS) tables, `sdkconfig.defaults` (C3) and `sdkconfig.defaults.esp32s3` (S3 + 2 MB PSRAM + NimBLE), `version.txt`, prebuilt CI binaries (`can-do-esp32c3.bin`, `can-do-esp32s3.bin`), untracked `can-do-esp32s3-merged.bin`, default [`firmware/automations.json`](file:///d:/Documents/can-do/firmware/automations.json) (`v2026.9.9`), and Python flashers [`upload_web.py`](file:///d:/Documents/can-do/firmware/upload_web.py) / [`flash_ota.py`](file:///d:/Documents/can-do/firmware/flash_ota.py). |
| [`firmware/data/`](file:///d:/Documents/can-do/firmware/data/preferences.json) | LittleFS (`storage` partition) staging tree: gzipped web bundle `www/*.gz` + `frontend_manifest.json`, default `automations.json`, `preferences.json`, gitignored local `mqtt.json` & `networks.json`, and gitignored minified `catalog.json` (regenerated by Vite `closeBundle` or `idf.py build`). |
| [`firmware/main/`](file:///d:/Documents/can-do/firmware/main/main.cpp) | Boot orchestrator [`main.cpp`](file:///d:/Documents/can-do/firmware/main/main.cpp) (PSRAM cJSON hooks, crash diagnostics persistence, LittleFS mount, NVS/Wi-Fi/mDNS/SNTP/BLE/CAN/HTTP/MQTT/GVRET/USB/UDS startup) and [`CMakeLists.txt`](file:///d:/Documents/can-do/firmware/main/CMakeLists.txt) (compiles **26** `.c`/`.cpp` sources and minifies the canonical catalog into `firmware/data/catalog.json`). |
| [`firmware/main/core/`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp) | Core CAN & automation spine: `can_engine.cpp` (4,240 LOC: RX/TX/sched tasks, automation matcher, MITM bridge, RTC NOINIT cache, plus ~713 LOC hardcoded cockpit decoders), `parser.cpp` (2,059 LOC: streaming PSRAM catalog/automation compiler), `mcp2518fd.cpp` (784 LOC: dual SPI CAN FD driver), `types.h`, `can.h`, `board_pins.h`, `psram_alloc.h`. |
| [`firmware/main/net/`](file:///d:/Documents/can-do/firmware/main/net/api.cpp) | All external I/O transports: `api.cpp` (2,865 LOC: HTTP/REST + `/ws` + static SPA + Cloud OTA), `mqtt_mgr.cpp` (1,386 LOC), `ble_mgr.cpp` (1,531 LOC), `network_mgr.cpp` (914 LOC), `gvret_server.cpp` (509 LOC), `usb_can.cpp` (175 LOC), `serial_cli.cpp` (297 LOC), and hardcoded static stub `config_server.c` (33 LOC). |
| [`firmware/main/platform/`](file:///d:/Documents/can-do/firmware/main/platform/power_mgr.cpp) | Hardware/OS support: 12V ADC voltage monitor (`vbat_sensor.cpp`), Tier 1/2 sleep + safe restart (`power_mgr.cpp`), POSIX TZ mapper (`timezone_mgr.cpp`), and volatile RAM-only stub `persistent_settings.c` (27 LOC). |
| [`firmware/main/protocols/`](file:///d:/Documents/can-do/firmware/main/protocols/uds_engine.cpp) | Diagnostic & framing helpers: UDS BMS poller (`uds_engine.cpp`), ISO-TP multi-frame TX (`isotp_tx.c`), hierarchical state machine kernel (`hsm.c`), and UTF-8→UTF-16LE encoder (`utf8_utf16_converter.c`). |
| [`firmware/main/subsystems/`](file:///d:/Documents/can-do/firmware/main/subsystems/remote_climate.cpp) | Vehicle feature state machines: battery preconditioning HSM (`precondition.c`, 1,694 LOC), cluster OSD track popup (`track_popup.c`), HUD turn-by-turn nav (`hud_nav.c`), TMU remote climate keepalive (`remote_climate.cpp`), 64-color/effect ambient lighting (`ambient_anim.cpp`), and head-unit chime (`beep.c`). |
| [`custom_components/can_do/`](file:///d:/Documents/can-do/custom_components/can_do/__init__.py) | HACS Home Assistant integration (`v2026.11.6-b008`) communicating **exclusively via MQTT** (zero HTTP calls to ESP32): `coordinator.py` (797 LOC), `catalog_loader.py`, `config_flow.py`, `entity.py`, `can_utils.py`, 12 entity platforms, `services.yaml`, and gitignored local catalog cache `can_do_catalog.json`. |
| [`frontend/`](file:///d:/Documents/can-do/frontend/vite.config.ts) | React 19 + Vite 6 + TypeScript + Tailwind 4 + HeroUI SPA (`v2026.11.6-b008`). `vite.config.ts` mocks several `/api/*` endpoints in dev and outputs pre-gzipped assets + `frontend_manifest.json` directly to `firmware/data/www/`. Includes stray scratch script [`frontend/test.ts`](file:///d:/Documents/can-do/frontend/test.ts). |
| [`scripts/`](file:///d:/Documents/can-do/scripts/optimize_catalog.py) | Catalog schema normalizer/validator (`optimize_catalog.py`, enforced in CI) and bench stress/replay harnesses (`wican_vehicle_stress.py`, `wican_log_replay.py`). |
| [`tests/`](file:///d:/Documents/can-do/tests/test_remote_climate.py) | Python `unittest` suite (`test_remote_climate.py`, 1,112 LOC) validating remote climate `0x39B` frame packing and catalog integrity. |
| [`docs/`](file:///d:/Documents/can-do/docs/architecture.md) | Architecture specification (`architecture.md`), empirically verified E-GMP CAN/MICOM reference (`egmp_can_reference.md`), and setup/user guides. |
| [`.github/workflows/`](file:///d:/Documents/can-do/.github/workflows/firmware.yml) | CI/CD pipelines: `firmware.yml` (stamps versions, builds frontend + C3/S3 firmware, publishes GitHub Release, pushes `[skip ci]` sync to `main`), `deploy.yml` (GitHub Pages deploy of `frontend/dist` + `.bin` copies), `validate_catalog.yml` (catalog lint + Python `unittest`). |
| Root Files | Monorepo [`package.json`](file:///d:/Documents/can-do/package.json) + `bun.lock`, [`hacs.json`](file:///d:/Documents/can-do/hacs.json), leftover AI Studio [`metadata.json`](file:///d:/Documents/can-do/metadata.json), gitignored IDE MCP stdio-to-TCP proxy [`savvylens_bridge.py`](file:///d:/Documents/can-do/savvylens_bridge.py) (unrelated to ESP32/GVRET), gitignored merged binaries (`can-do-atom-bridge-merged.bin`, `can-do-esp32c3-merged.bin`), and orphaned root `__pycache__/*.pyc` from deleted scripts. |

---

## 2. The Wiring & Contract Table

### 2A. HTTP REST & Static Endpoints (`firmware/main/net/api.cpp`, Port 80)

> [`start_webserver()`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2811-L2852) registers **42 URI handlers** (`max_uri_handlers = 48`): **39 REST routes** (`L2811-L2849`) + `/ws` (`L2850`) + `/*` OPTIONS (`L2851`) + `/*` GET static SPA (`L2852`).

| Endpoint | Producer (Caller) | Consumer (Firmware Handler) | Payload Shape (Req → Resp) |
| :--- | :--- | :--- | :--- |
| `GET /api/states` | [`VehicleDashboard.tsx:1159`](file:///d:/Documents/can-do/frontend/src/components/VehicleDashboard.tsx#L1159) (mount/reconnect + 3s fallback poll only while WS disconnected), [`AutomationBuilder.tsx:573`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L573), `wican_vehicle_stress.py` | [`api.cpp:399`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L399) (`api_states_handler`) | `→ [{"entity":str,"state":str}, ...]` (**Array**; appends `cond_aux_12v_battery` ADC fallback; Vite dev mock at [`vite.config.ts:145`](file:///d:/Documents/can-do/frontend/vite.config.ts#L145) now matches `[]`) |
| `POST /api/command` | [`VehicleDashboard.tsx:789`](file:///d:/Documents/can-do/frontend/src/components/VehicleDashboard.tsx#L789), [`AutomationBuilder.tsx:1068-1240`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1068-L1240), `wican_vehicle_stress.py` | [`api.cpp:454`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L454) (`api_command_handler`) | `{entity,command}` OR `{can_id,steps:[...],bus,delay_ms}` OR `{can_id,payload,repeat,delay_ms,bus} → {"status":"queued"}` (max 8 KB; Vite mock returns `{"status":"ok"}`) |
| `POST /api/notify` | [`AutomationBuilder.tsx:878`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L878), `wican_vehicle_stress.py` | [`api.cpp:2331`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2331) (`api_notify_handler`) | `{message\|text\|popup_message, level?:"info"\|"warning"\|"error"\|"critical", title?, caller?, type?, hold_ms?} → {"status":"ok",...}` (`title`/`caller`/`type`/`hold_ms` parsed & discarded!) |
| `POST /api/nav` | [`AutomationBuilder.tsx:918`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L918), `wican_vehicle_stress.py` | [`api.cpp:2390`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2390) (`api_nav_handler`) | `{action:"update"\|"clear", icon, direction\|direction_deg\|heading, distance\|distance_meters, bars, speed_limit, camera_alert, street, lanes\|num_lanes, lane_directions[], lane_recommended\|lane_highlights[], platform?:"gen2"\|"egmp"} → {"status":"ok",...}` |
| `POST /api/test_automation` | [`wican_vehicle_stress.py:379`](file:///d:/Documents/can-do/scripts/wican_vehicle_stress.py#L379) | [`api.cpp:600`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L600) (`api_test_automation_handler`) | `{id, mode:"dry_run"\|"live_fire"\|"run_actions", actions?:[...]} → {status, passed?, message}` (alias of `/api/automations/test`) |
| `POST /api/automations/test` | [`AutomationBuilder.tsx:1331,1369`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1331-L1373) | [`api.cpp:600`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L600) (`api_test_automation_handler`) | Same as above (max 16 KB) |
| `GET /api/automations/diagnostics` | [`DeviceDashboard.tsx:519`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L519) | [`api.cpp:721`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L721) (`api_automations_diagnostics_handler`) | `→ {automations_enabled, rules:[{id,name,enabled,ha_expose,triggers[],conditions[],actions[],...}]}` |
| `GET /api/automations` | [`App.tsx:1084`](file:///d:/Documents/can-do/frontend/src/App.tsx#L1084), [`AutomationBuilder.tsx:1701`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1701) | [`api.cpp:1358`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1358) (`api_get_automations_handler`) | `→ /spiffs/automations.json` raw JSON (fallback `{settings:{...}, rules:[]}`) |
| `POST /api/automations` | [`App.tsx:1069`](file:///d:/Documents/can-do/frontend/src/App.tsx#L1069), [`AutomationBuilder.tsx:1592`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1592) | [`api.cpp:1391`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1391) (`api_post_automations_handler`) | Raw `automations.json` (max 128 KB) → atomic `.tmp` rename, reloads engine + triggers MQTT automation sync |
| `GET /api/preferences` | [`settings.ts:101`](file:///d:/Documents/can-do/frontend/src/types/settings.ts#L101) | [`api.cpp:1450`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1450) (`api_get_preferences_handler`) | `→ /spiffs/preferences.json` raw JSON (fallback `{}`) |
| `POST /api/preferences` | [`settings.ts:135`](file:///d:/Documents/can-do/frontend/src/types/settings.ts#L135) | [`api.cpp:1478`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1478) (`api_post_preferences_handler`) | JSON prefs (max 8 KB) → overwrites `/spiffs/preferences.json`, reloads `uds_engine`, `can_engine`, `timezone_mgr` |
| `GET /api/system/status` | [`DeviceDashboard.tsx:329,476`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L476), [`DeviceRebootModal.tsx:121`](file:///d:/Documents/can-do/frontend/src/components/DeviceRebootModal.tsx#L121), [`updateService.ts:416`](file:///d:/Documents/can-do/frontend/src/services/updateService.ts#L416), `wican_log_replay.py` | [`api.cpp:1531`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1531) (`api_system_status_handler`) | `→ {status, target, device, can_do_version, catalog_version, device_id, uptime_sec, free_heap, min_free_heap, internal_free_heap, psram_free_heap, storage_*, vbat_volts, automations_enabled, sniffer_mode, hardware_listen_only, mitm_bridge_enabled, twai_state, can0_*, can1_*, gvret_*, time_synced, system_time, reset_reason, last_crash?, persisted_crash?}` |
| `POST /api/system/control` | [`DeviceDashboard.tsx:427,707-774`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L707-L774), [`updateService.ts:482,500,629,875`](file:///d:/Documents/can-do/frontend/src/services/updateService.ts#L482-L504), `upload_web.py:293` | [`api.cpp:1773`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1773) (`api_system_control_handler`) | `{action:"restart"\|"reboot"\|"list_files"\|"clean_stale_web"\|"clean_www"\|"reload_catalog"\|"toggle_automations"\|"toggle_sniffer"\|"set_hardware_listen_only"\|"toggle_mitm_bridge"\|"disconnect_gvret"\|"reset_gvret", keep?, enabled?, automations_enabled?, sniffer_mode?, hardware_listen_only?, mitm_bridge_enabled?, reboot?}` |
| `POST /api/system/time` | [`DeviceDashboard.tsx:796,2704`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L796) | [`api.cpp:1706`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1706) (`api_system_set_time_handler`) | `{epoch:number (>=1704067200), timezone?:string} → {"status":"success",...}` + emits WS `state/system_time` |
| `GET /api/wifi/status` | [`DeviceDashboard.tsx:494`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L494), [`AutomationBuilder.tsx:595`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L595) | [`api.cpp:1943`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1943) (`api_wifi_status_handler`) | `→ {sta_connected, sta_ssid, sta_ip, sta_gw, sta_mask, sta_rssi, ap_active, ap_ssid, ap_ip, ap_clients, ap_mode}` |
| `GET /api/wifi/networks` | [`DeviceDashboard.tsx:505`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L505) | [`api.cpp:1972`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1972) (`api_wifi_get_networks_handler`) | `→ [{ssid, priority}, ...]` (JSON array) |
| `POST /api/wifi/networks` | [`DeviceDashboard.tsx:833`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L833), fallback SoftAP HTML [`api.cpp:338`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L338) | [`api.cpp:1990`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1990) (`api_wifi_post_networks_handler`) | `{ssid, password?, priority?} → {"status":"ok","message":"Network saved"}` |
| `DELETE /api/wifi/networks` | [`DeviceDashboard.tsx:856`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L856) | [`api.cpp:2049`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2049) (`api_wifi_delete_networks_handler`) | Body `{ssid}` or query `?ssid=... → {"status":"ok"}` or `404` |
| `GET /api/wifi/scan` | [`DeviceDashboard.tsx:816`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L816) | [`api.cpp:2101`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2101) (`api_wifi_scan_handler`) | Fires async scan, immediately returns `{scanning:bool, results:[{ssid,rssi,authmode,in_known_list},...]}` (safe in `APSTA` mode; `WIFI_EVENT_SCAN_DONE` harvests scan results even while STA or SoftAP clients are connected) |
| `POST /api/wifi/settings` | **NONE** (Ghost endpoint) | [`api.cpp:2129`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2129) (`api_wifi_settings_handler`) | `{ap_mode?:"auto"\|"always_on"\|"disabled", ap_ssid?, ap_password?} → {"status":"ok"}` |
| `GET /api/ble/status` | [`BluetoothManager.tsx:75`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L75), [`BleSelects.tsx:33`](file:///d:/Documents/can-do/frontend/src/components/BleSelects.tsx#L33), [`AutomationBuilder.tsx:609`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L609) | [`api.cpp:2602`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2602) (`api_ble_status_handler`) | `→ {enabled, scanning, connected, connected_device, paired_devices[], discovered_devices[], recent_events[], beacon_targets[], discovered_beacons[]}` (Vite dev mock at [`vite.config.ts:149`](file:///d:/Documents/can-do/frontend/vite.config.ts#L149)) |
| `POST /api/ble/scan` | [`BluetoothManager.tsx:179`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L179) | [`api.cpp:2610`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2610) (`api_ble_scan_handler`) | Query `?duration=1..60 → {"status":"scanning_started"}` |
| `POST /api/ble/pair` | [`BluetoothManager.tsx:210`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L210) | [`api.cpp:2627`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2627) (`api_ble_pair_handler`) | `{mac\|address, name?} → {"status":"pairing_requested"}` |
| `POST /api/ble/unpair` | [`BluetoothManager.tsx:232`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L232) | [`api.cpp:2655`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2655) (`api_ble_unpair_handler`) | `{mac?\|address?} → {"status":"ok"}` |
| `POST /api/ble/test_event` | [`BluetoothManager.tsx:262`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L262), `wican_vehicle_stress.py` | [`api.cpp:2679`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2679) (`api_ble_test_event_handler`) | `{button, action} → {"status":"ok"}` |
| `POST /api/ble/clear_events` | [`BluetoothManager.tsx:284`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L284) | [`api.cpp:2703`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2703) (`api_ble_clear_events_handler`) | `{} → {"status":"ok"}` |
| `GET /api/ble/beacons` | **NONE** (Ghost endpoint) | [`api.cpp:2711`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2711) (`api_ble_beacons_get_handler`) | `→ {beacon_targets:[], discovered_beacons:[]}` |
| `POST /api/ble/beacons` | [`BluetoothManager.tsx:319,361`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L319) | [`api.cpp:2719`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2719) (`api_ble_beacons_post_handler`) | `{uuid, mac\|address, name, enter_rssi, exit_timeout_s\|exit_timeout} → {"status":"ok"}` |
| `DELETE /api/ble/beacons` | [`BluetoothManager.tsx:340`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L340) | [`api.cpp:2755`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2755) (`api_ble_beacons_delete_handler`) | `{uuid, mac\|address} → {"status":"ok"}` |
| `GET /api/mqtt` | [`DeviceDashboard.tsx:536`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L536) | [`api.cpp:2162`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2162) (`api_mqtt_get_handler`) | `→ {enabled, ha_discovery, broker_url, username, has_password, connected}` |
| `POST /api/mqtt` | [`DeviceDashboard.tsx:573`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L573) | [`api.cpp:2181`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2181) (`api_mqtt_post_handler`) | `{enabled, ha_discovery, broker_url, username, password?, keep_password?} → {"status":"ok"}` |
| `GET /api/can/monitored_ids` | [`DeviceDashboard.tsx:603`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L603) | [`api.cpp:2233`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2233) (`api_can_monitored_ids_get_handler`) | `→ {customized:bool, monitored_ids:["0x...",...]}` |
| `POST /api/can/monitored_ids` | [`DeviceDashboard.tsx:624`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L624) | [`api.cpp:2254`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2254) (`api_can_monitored_ids_post_handler`) | `{monitored_ids:["0x...",...]} → {"status":"ok","count":N}` (persists `/spiffs/monitored_ids.json`) |
| `POST /api/can/monitored_ids/reset` | [`DeviceDashboard.tsx:642`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L642) | [`api.cpp:2303`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2303) (`api_can_monitored_ids_reset_handler`) | `{} → {"status":"ok",...}` (unlinks `/spiffs/monitored_ids.json`, restores default monitored IDs) |
| `GET /api/can/active_ids` | [`DeviceDashboard.tsx:604`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L604) | [`api.cpp:2311`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2311) (`api_can_active_ids_get_handler`) | `→ {"count":N, "active_ids":["0x038", ...]}` |
| `POST /api/upload` | [`updateService.ts:308,337`](file:///d:/Documents/can-do/frontend/src/services/updateService.ts#L308-L341), [`upload_web.py:18,27,344`](file:///d:/Documents/can-do/firmware/upload_web.py#L18-L345) | [`api.cpp:974`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L974) (`api_file_upload_handler`) | Headers `X-File-Path: /spiffs/...`, optional `X-No-Reboot: 1`. Raw bytes (0-byte deletes; `/spiffs/catalog.json` reboots unless `X-No-Reboot: 1`). |
| `POST /api/ota` | [`DeviceDashboard.tsx:884`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L884), [`updateService.ts:358`](file:///d:/Documents/can-do/frontend/src/services/updateService.ts#L358), [`flash_ota.py:21`](file:///d:/Documents/can-do/firmware/flash_ota.py#L21) | [`api.cpp:1039`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1039) (`api_ota_handler`) | Raw ESP32 app `.bin` stream → writes OTA partition, emits ghost WS `ota_progress`, schedules reboot |
| `POST /api/ota/cloud_pull` | [`updateService.ts:813`](file:///d:/Documents/can-do/frontend/src/services/updateService.ts#L813) | [`api.cpp:1303`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1303) (`api_ota_cloud_pull_handler`) | `{url:"https://..."} → {"status":"started"}` (spawns `cloud_ota_task`) |
| `GET /api/ota/status` | [`updateService.ts:834`](file:///d:/Documents/can-do/frontend/src/services/updateService.ts#L834) | [`api.cpp:1341`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1341) (`api_ota_status_handler`) | `→ {in_progress:bool, progress:0-100, success:bool, error:str}` |
| `OPTIONS /*` | Browser CORS preflights | [`api.cpp:397`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L397) (`options_handler`) | `204 No Content` with `Access-Control-Allow-Origin: *` |
| `GET /*` (Static SPA) | Browser, [`App.tsx:588`](file:///d:/Documents/can-do/frontend/src/App.tsx#L588), [`updateService.ts:528,543`](file:///d:/Documents/can-do/frontend/src/services/updateService.ts#L528-L543), `upload_web.py` | [`api.cpp:258`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L258) (`static_file_handler`) | `/` → `/spiffs/www/index.html(.gz)` (inline SoftAP HTML fallback if missing); `/catalog.json` or `*can_do_catalog.json` → `/spiffs/catalog.json`; `/automations.json` → `/spiffs/automations.json`; else `/spiffs/www{uri}(.gz)` |
| `GET /api/catalog` *(Dev-Only Mock)* | Local Vite dev server only | [`vite.config.ts:86`](file:///d:/Documents/can-do/frontend/vite.config.ts#L86) | Serves `catalog/can_do_catalog.json` in `npm run dev` (**does not exist on ESP32**) |

### 2B. WebSocket (`/ws`) Message Contracts

| Direction & `type` | Producer | Consumer | Payload Shape |
| :--- | :--- | :--- | :--- |
| S→C `state` | [`api.cpp:138,1732,2531`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L138-L149) (`broadcast_ws_state`, `ws_send_initial_snapshot`), [`uds_engine.cpp:174-187`](file:///d:/Documents/can-do/firmware/main/protocols/uds_engine.cpp#L174-L187) (via `broadcast_ws_raw`) | [`deviceWs.ts:82`](file:///d:/Documents/can-do/frontend/src/services/deviceWs.ts#L82) → [`VehicleDashboard.tsx:1205`](file:///d:/Documents/can-do/frontend/src/components/VehicleDashboard.tsx#L1205), [`AutomationBuilder.tsx:677`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L677), [`DeviceDashboard.tsx:673`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L673), [`App.tsx:278`](file:///d:/Documents/can-do/frontend/src/App.tsx#L278) (defers ambient updates while dashboard tab is active) | `{"type":"state","entity":str,"state":str}` |
| S→C `log` | [`api.cpp:181-214`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L181-L214) (`custom_websocket_logger` → `ws_log_worker_task`) | [`DeviceDashboard.tsx:664`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L664) | `{"type":"log","msg":str}` |
| S→C `automation_fired` | [`api.cpp:151-163`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L151-L163) (`broadcast_ws_automation_event`) | [`DeviceDashboard.tsx:670`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L670), [`AutomationBuilder.tsx:680`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L680) | `{"type":"automation_fired","id":str,"name":str}` (consumers also check absent `rule_id` & `trigger_id`) |
| S→C `ble_event` | [`ble_mgr.cpp:368-386`](file:///d:/Documents/can-do/firmware/main/net/ble_mgr.cpp#L368-L386) (`fire_ble_button_event`) | [`BluetoothManager.tsx:120`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L120), [`BleButtonComboPicker.tsx:123`](file:///d:/Documents/can-do/frontend/src/components/BleButtonComboPicker.tsx#L123) | `{"type":"ble_event","address":str,"device_name":str,"button":str,"action":str,"combo"?:str,"hold_seconds"?:num,"timestamp_ms":num}` |
| S→C `ble_beacon` | [`ble_mgr.cpp:991,1099`](file:///d:/Documents/can-do/firmware/main/net/ble_mgr.cpp#L991-L1111) | [`BluetoothManager.tsx:148`](file:///d:/Documents/can-do/frontend/src/components/BluetoothManager.tsx#L148), [`AutomationBuilder.tsx:697`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L697) | `{"type":"ble_beacon","event":"enter"\|"proximity"\|"exit","uuid":str,"mac":str,"name":str,"rssi":num,"major"?:num,"minor"?:num}` (omits `is_present` & `exit` `major`/`minor`; both consumers derive presence from `event`) |
| S→C `ble_device_event` | [`ble_mgr.cpp:609,648`](file:///d:/Documents/can-do/firmware/main/net/ble_mgr.cpp#L609-L657) | **NONE** (Ghost emitter) | `{"type":"ble_device_event","event":"connected"\|"disconnected","address":str,"name"?:str,"rssi"?:num}` |
| S→C `ota_progress` | [`api.cpp:1262`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1262) (`api_ota_handler`) | **NONE** (Ghost emitter) | `{"type":"ota_progress","pct":int,"bytes":int}` |
| S→C `can_frame` | **NONE** (`broadcast_ws_can_frame()` removed from `api.cpp`/`api.h`) | [`AutomationBuilder.tsx:673`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L673) (`App.tsx` listeners & dead `VehicleDashboard.tsx` decoder removed) | Ghost listener expecting `{"type":"can_frame","id":str,"dlc":int,"data":hex}` |
| S→C `wifi_status` / `ble_proximity` | **NONE** | [`AutomationBuilder.tsx:688,697`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L688-L719) (`states_dump` parser removed from `deviceWs.ts`) | Ghost listeners |
| C→S `ble_learn` | [`BleButtonComboPicker.tsx:138,147`](file:///d:/Documents/can-do/frontend/src/components/BleButtonComboPicker.tsx#L138-L148) | [`api.cpp:2585-2593`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2585-L2593) (`ws_handler`) | `{"type":"ble_learn","active":bool,"duration_ms"?:num}` (buffer cap 127 bytes) |

### 2C. MQTT Topic Contracts

> **Inbound Control Prefix Aliasing**: [`mqtt_mgr.cpp:570-591`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L570-L591) (`extract_target_topic_suffix`) accepts all inbound commands under **3 prefixes**: `cando/{DEVICE_ID}/...`, hardcoded legacy **`cando/can-do/...`**, and unscoped **`cando/...`** (subscribed via 14 filters at [`mqtt_mgr.cpp:503-539`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L503-L539)).

| Topic Pattern | Producer | Consumer | Payload Shape |
| :--- | :--- | :--- | :--- |
| `cando/{dev}/status` | [`mqtt_mgr.cpp:552,1006`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L552-L553) (LWT `"offline"` + connect `"online"`, retained) | [`coordinator.py:99,171,257`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L257), [`config_flow.py:76`](file:///d:/Documents/can-do/custom_components/can_do/config_flow.py#L76) | `"online"` / `"offline"` |
| `cando/{dev}/state/0x{ID}` | [`mqtt_mgr.cpp:220-230`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L220-L230) (`mqtt_mgr_publish_can_state`, retained) | [`coordinator.py:104,177,307`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L307) (`_handle_can_state_message`) | Compact uppercase hex without spaces, e.g. `"AABBCCDDEEFF0011"` |
| `cando/state/{entity_id}` *(Unscoped!)* | [`mqtt_mgr.cpp:232-236`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L232-L236) (`mqtt_mgr_publish_entity_state`, retained) | [`coordinator.py:109,181,307`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L307); [`mqtt_mgr.cpp:544,629`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L629) (cold-boot hydration) | Decoded string (e.g. `"80%"`, `"12345.6 km"`, `"Driver Door Opened, ..."`, `"ON"`) |
| `cando/{dev}/state/vbat`, `cando/{dev}/state/cond_aux_12v_battery`, `cando/state/cond_aux_12v_battery` | [`mqtt_mgr.cpp:1261-1277`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L1261-L1277) (`mqtt_mgr_publish_vbat`, retained) | [`coordinator.py:337-357`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L337-L357) | Decimal string `"13.4"` |
| `cando/{dev}/state/bms_{hv_kw,soc,hv_v,hv_a,cell_delta_mv}` & `cando/state/bms_{hv_power_kw,display_soc,hv_voltage,hv_current,cell_delta_mv}` | [`mqtt_mgr.cpp:1279-1306`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L1279-L1306) (`mqtt_mgr_publish_bms`, retained; drops `min_t`/`max_t`) | [`coordinator.py:26-36,358-361`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L26-L36) | Numeric string (`"%.2f"`, `"%.1f"`, `"%.0f"`) |
| `cando/{dev}/active_ids` | [`mqtt_mgr.cpp:238-266,459,1081`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L238-L266) (`mqtt_mgr_publish_active_ids`, retained, 10s throttle) | [`coordinator.py:150,215,274`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L274) (`_handle_active_ids_message`) | JSON array `["0x038","0x411",...]` |
| `cando/{dev}/ble_button` | [`mqtt_mgr.cpp:1308-1333`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L1308-L1333) (called via `can_engine_on_ble_event`) | [`coordinator.py:114,187,437`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L437) | `{device_id, address, button, action, combo?, hold_seconds?}` |
| `cando/{dev}/ble_device` | [`mqtt_mgr.cpp:1335-1357`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L1335-L1357) (called via `can_engine_on_ble_device_event`) | [`coordinator.py:124,205,509`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L509) | `{device_id, address, event:"connected"\|"disconnected", rssi, connected:bool, name?}` |
| `cando/{dev}/ble_beacon` | [`mqtt_mgr.cpp:1359-1386`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L1359-L1386) (called via `can_engine_on_ble_beacon_event`) | [`coordinator.py:119,196,465`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L465) | `{device_id, uuid, event:"enter"\|"proximity"\|"exit", rssi, major, minor, present:bool, mac?, name?}` |
| `cando/{dev}/config/automations/state` | [`mqtt_mgr.cpp:411-434`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L411-L434) (`publish_automations_json_state`, retained) | [`AutomationBuilder.tsx:1642`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1642) (`mqtt.js` over `wss://`) | Full `automations.json` (or `"[]"` if missing or >32 KB) |
| `cando/{dev}/config/automations/status` | [`mqtt_mgr.cpp:1178-1190`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L1178-L1190) (`mqtt_auto_reload_task`) | **NONE** (Ghost emitter) | `{"status":"ok"}` or `{"status":"error","message":"Invalid JSON syntax"}` |
| `cando/{dev}/config/automations/get` | [`AutomationBuilder.tsx:1644`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1644) | [`mqtt_mgr.cpp:641`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L641) | Empty `""` → triggers `publish_automations_json_state()` |
| `cando/{dev}/config/automations/set` | [`AutomationBuilder.tsx:1561`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1561) | [`mqtt_mgr.cpp:593-623`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L593-L623) | Chunked `automations.json` → `/spiffs/automations.json.tmp` → `mqtt_auto` reload task |
| `cando/{dev}/tx` | [`coordinator.py:610-627`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L610-L627) (`async_send_action`) | [`mqtt_mgr.cpp:767-847`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L767-L847) | `{entity,command}` OR `{can_id, delay_ms?, bus?, steps:[...]}` OR `{can_id, payload, repeat?, delay_ms?, bus?}` |
| `cando/{dev}/set/{entity_id}` | [`coordinator.py:629-651`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L629-L651) (`async_send_entity_command`, `async_send_remote_climate`), HA Discovery `command_topic` | [`mqtt_mgr.cpp:865-877`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L865-L877) → `mqtt_cmd` → `queue_entity_command()` | Plain label / `"ON"` / `"OFF"` / `"press"` / `"lock"` / `"unlock"` / JSON (`remote_climate`, `ambient_light_colors`) |
| `cando/{dev}/notify` | [`coordinator.py:653-668`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L653-L668) (`async_send_notification`) | [`mqtt_mgr.cpp:653-676`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L653-L676) | `{message\|text\|popup_message, level?:"info"\|"warning"\|"error"\|"critical", hold_ms?}` (`hold_ms` discarded!) or plain text |
| `cando/{dev}/nav/set` | [`coordinator.py:670-703`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L670-L703) (`async_send_hud_nav`, `async_clear_hud_nav`) | [`mqtt_mgr.cpp:677-766`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L677-L766) | `{action?:"clear", icon, direction?, distance?, bars?, speed_limit?, camera_alert?, street?, lanes?, lane_directions?, lane_recommended?, platform?}` |
| `cando/{dev}/subscribe_ids` | [`coordinator.py:245-254`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L245-L254) (`async_publish_monitored_ids`, retained) | [`mqtt_mgr.cpp:848-864`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L848-L864) | JSON array `["0x411","0x2FC",...]` |
| `homeassistant/{domain}/{dev}/{entity_id}/config` & `homeassistant/switch/{dev}/{rule_id}/config` | [`mqtt_mgr.cpp:307-405`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L307-L405) (when `ha_discovery==true`, retained) | Home Assistant built-in MQTT Discovery | HA Discovery JSON pointing `command_topic` at `cando/{dev}/set/{id}` and `state_topic` at unscoped `cando/state/{id}` |

### 2D. Serial / USB / GVRET Wire Protocols

| Protocol / Transport | Producer | Consumer | Command / Frame Contract |
| :--- | :--- | :--- | :--- |
| **GVRET TCP** (Ports `23` & `3333`) | SavvyCAN, `wican_log_replay.py`, `wican_vehicle_stress.py` | [`gvret_server.cpp:152-498`](file:///d:/Documents/can-do/firmware/main/net/gvret_server.cpp#L152-L498) | `0xE7` binary mode toggle; `0xF1` commands (`0x00` BUILD_CAN_FRAME, `0x01` TIME_SYNC, `0x02` DIG_INPUTS, `0x03` ANALOG, `0x04` SET_DIG_OUT, `0x05` SETUP_CANBUS, `0x06` GET_CANBUS_PARAMS, `0x07` GET_DEV_INFO, `0x08` SET_SINGLEWIRE, `0x09` KEEPALIVE `0xDE 0xAD`, `0x0A` SET_SYSTYPE, `0x0B` ECHO_CAN, `0x0C` GET_NUM_BUSES, `0x0D` GET_EXT_BUSES, `0x0E` SET_EXT_BUSES). **Suspends automations while connected (`gvret_server.cpp:304,358`).** |
| **USB Binary GVRET** (STDIN) | `wican_vehicle_stress.py` / SavvyCAN serial | [`usb_can.cpp:52-86`](file:///d:/Documents/can-do/firmware/main/net/usb_can.cpp#L52-L86) | Only `0xF1 0x00` (4B LE ID + 1B bus [discarded!] + 1B DLC + data + 1B checksum) → `can_engine_inject_frame()` (always bus 0). Any other `0xF1 <cmd>` skips 2 bytes silently (no `0xE7`, no `0x09` keepalive reply). |
| **USB SLCAN** (STDIN) | Serial CAN tools | [`usb_can.cpp:104-140`](file:///d:/Documents/can-do/firmware/main/net/usb_can.cpp#L104-L140) | Only `t<3hexID><DLC><hexData>\r` (11-bit) and `T<8hexID><DLC><hexData>\r` (29-bit) → `can_engine_inject_frame()`. Standard SLCAN control commands (`O`/`C`/`S*`/`V`/`N`) are **not** implemented and fall through to `serial_cli_process_line()`. |
| **USB JSON CLI** (STDIN, `{...}`) | Serial setup tools / user | [`serial_cli.cpp:85-127`](file:///d:/Documents/can-do/firmware/main/net/serial_cli.cpp#L85-L127) | `wifi_delete` (`{type:"wifi_delete",ssid}`, matched first at `L95-L101` before `wifi_save` at `L102`, with typeless `ssid` fallback guarded by `type_str[0] == '\0'`), `wifi_save` (`{type,ssid,password?,priority?}`), `ping` (`→ {"type":"pong"}`), `lock` / `unlock` (`→ queue_entity_command("door_locks")` fallback `"doors_lock_state"`). |
| **USB Text CLI** (STDIN) | User terminal | [`serial_cli.cpp:128-294`](file:///d:/Documents/can-do/firmware/main/net/serial_cli.cpp#L128-L294) | `help`/`?`, `reboot`/`restart`, `status`, `can`, `ble` (`ble scan` \| `ble`), `wifi status`, `wifi scan`, `wifi clear`, `wifi delete "<SSID>"`, `wifi ap "<SSID>" [PASS]`, `wifi [add\|set] "<SSID>" [PASS] [PRIO]`. |

### 2E. Home Assistant Integration Contracts (`custom_components/can_do/`)

#### HA Services, Bus Events & Discovery

| Interface | Producer | Consumer | Payload / Behavior |
| :--- | :--- | :--- | :--- |
| Service `can_do.set_hud_nav` | HA Automations / UI ([`services.yaml:45-105`](file:///d:/Documents/can-do/custom_components/can_do/services.yaml#L45-L105)) | [`__init__.py:50-67,95`](file:///d:/Documents/can-do/custom_components/can_do/__init__.py#L50-L95) → `coordinator.async_send_hud_nav()` | `{icon, distance, bars, street?, speed_limit?, camera_alert?}` → broadcasts to **all** coordinators on `cando/{dev}/nav/set` (`speed_limit`/`camera_alert` ignored by `hud_nav.c`) |
| Service `can_do.clear_hud_nav` | HA Automations / UI ([`services.yaml:106-109`](file:///d:/Documents/can-do/custom_components/can_do/services.yaml#L106-L109)) | [`__init__.py:69-73,96`](file:///d:/Documents/can-do/custom_components/can_do/__init__.py#L69-L96) → `coordinator.async_clear_hud_nav()` | `{}` → `{"action":"clear"}` on `cando/{dev}/nav/set` |
| Service `can_do.set_audio_dsp` | HA Automations / UI ([`services.yaml:110-211`](file:///d:/Documents/can-do/custom_components/can_do/services.yaml#L110-L211)) | [`__init__.py:75-97`](file:///d:/Documents/can-do/custom_components/can_do/__init__.py#L75-L97) → `coordinator.async_send_audio_dsp()` | `{volume?, fader?, balance?, bass?, midrange?, treble?, quiet_mode?, kids_mode?, master_mute?, surround?, sdvc?, can_id?}` → `cando/{dev}/tx` — all E-GMP profiles including `hi6_*` route to `0x60C`; legacy Gen 2 profiles keep `0x520` |
| Service `can_do.start_remote_climate` | HA Automations / UI ([`services.yaml:212-247`](file:///d:/Documents/can-do/custom_components/can_do/services.yaml#L212-L247)) | [`__init__.py:100-114,122`](file:///d:/Documents/can-do/custom_components/can_do/__init__.py#L100-L122) → `coordinator.async_send_remote_climate()` | `{temperature, defrost, duration_minutes}` → `{"action":"start","temp", "defrost","duration"}` on `cando/{dev}/set/remote_climate` |
| Service `can_do.stop_remote_climate` | HA Automations / UI ([`services.yaml:248-251`](file:///d:/Documents/can-do/custom_components/can_do/services.yaml#L248-L251)) | [`__init__.py:116-123`](file:///d:/Documents/can-do/custom_components/can_do/__init__.py#L116-L123) → `coordinator.async_send_remote_climate()` | `{}` → `{"action":"stop",...}` on `cando/{dev}/set/remote_climate` |
| Services `can_do.notify` & `notify.can_do` | HA Automations / UI ([`services.yaml:1-44`](file:///d:/Documents/can-do/custom_components/can_do/services.yaml#L1-L44)) | [`notify.py:38-51`](file:///d:/Documents/can-do/custom_components/can_do/notify.py#L38-L51) → `coordinator.async_send_notification()` | `{message, title?, level?:"info"\|"warning"\|"error", hold_ms?, data?}` → `cando/{dev}/notify` (`hold_ms` discarded by firmware) |
| HA Event `cando_ble_button_event` | [`coordinator.py:456`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L456) | User HA Automations | `{device_id, address, button, action, combo}` (**drops `hold_seconds`**) |
| HA Event `cando_ble_beacon_event` | [`coordinator.py:500`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L500) | User HA Automations | `{device_id, uuid, mac, name, event, rssi, major, minor, present}` |
| HA Event `cando_ble_device_event` | [`coordinator.py:534`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L534) | User HA Automations | `{device_id, address, name, event, rssi, connected}` |
| Discovery: Zeroconf & MQTT | [`manifest.json:15-29`](file:///d:/Documents/can-do/custom_components/can_do/manifest.json#L15-L29) | [`config_flow.py:76-116`](file:///d:/Documents/can-do/custom_components/can_do/config_flow.py#L76-L116) | Zeroconf `_http._tcp.local.` (`CAN Do*`) & MQTT `cando/+/status` (6 `ble_*` manifest topics always abort with `invalid_discovery_info`) |

#### HA Entity Platforms (12 Platforms in [`const.py:33-46`](file:///d:/Documents/can-do/custom_components/can_do/const.py#L33-L46))

| Platform File | Entities Created | State Input (Coordinator) | Command Output (MQTT) |
| :--- | :--- | :--- | :--- |
| [`sensor.py`](file:///d:/Documents/can-do/custom_components/can_do/sensor.py) (669 LOC) | 54 catalog `sensor` entities + 3 BLE diagnostic sensors (`LastButton`, `BeaconRssi`, `DeviceRssi`) | `get_can_state(id)`, `get_can_payload(state_can_id)`, BLE listeners | Read-only |
| [`binary_sensor.py`](file:///d:/Documents/can-do/custom_components/can_do/binary_sensor.py) (282 LOC) | 27 catalog `binary_sensor` entities + 2 BLE sensors (`BeaconPresence`, `DeviceConnected`) | `get_can_state(id)`, `get_can_payload(state_can_id)`, BLE listeners | Read-only |
| [`switch.py`](file:///d:/Documents/can-do/custom_components/can_do/switch.py) (125 LOC) | 17 catalog `switch` entities | `get_can_state(id)`, `get_can_payload(state_can_id)` | `async_send_action` → `tx` (or `async_send_remote_climate` → `set/remote_climate`) |
| [`select.py`](file:///d:/Documents/can-do/custom_components/can_do/select.py) (143 LOC) | 19 catalog `select` entities | `get_can_state(id)`, `get_can_payload(state_can_id)` | `async_send_action` → `tx` or `async_send_entity_command` → `set/{id}` |
| [`event.py`](file:///d:/Documents/can-do/custom_components/can_do/event.py) (159 LOC) | 17 catalog `event` entities + `CanDoBleButtonEventEntity` | `get_can_payload(state_can_id)`, BLE button listener | Read-only |
| [`number.py`](file:///d:/Documents/can-do/custom_components/can_do/number.py) (108 LOC) | 7 catalog `number` entities (Audio DSP levels) | `get_can_state(id)`, `get_can_payload(state_can_id)` | `async_send_action` → `tx` (uses `state_byte` for decode and `action_byte` for TX, falling back to `byte` → `"D1"`) |
| [`climate.py`](file:///d:/Documents/can-do/custom_components/can_do/climate.py) (444 LOC) | 2 catalog `climate` entities (`climate_driver_temp`, `climate_passenger_temp`) | `get_can_state`, `get_can_payload`, + 10 auxiliary listeners | `async_send_action` → `tx` + `async_send_remote_climate` → `set/remote_climate` |
| [`lock.py`](file:///d:/Documents/can-do/custom_components/can_do/lock.py) (144 LOC) | 2 catalog `lock` entities (`door_locks`, etc.) | `get_can_payload(state_can_id)` | `async_send_action` → `tx` or `async_send_entity_command` → `set/{id}` |
| [`cover.py`](file:///d:/Documents/can-do/custom_components/can_do/cover.py) (209 LOC) | 2 catalog `cover` entities (trunk/sunroof/windows) | `get_can_state(id)`, `get_can_payload(state_can_id)` | `async_send_action` → `tx` |
| [`notify.py`](file:///d:/Documents/can-do/custom_components/can_do/notify.py) (123 LOC) | 2 catalog `notify` entities + master `notify.can_do` | None | `async_send_notification` → `notify` |
| [`button.py`](file:///d:/Documents/can-do/custom_components/can_do/button.py) (62 LOC) | 1 catalog `button` entity | None | `async_send_action` → `tx` or `async_send_entity_command(id, "press")` → `set/{id}` |
| [`light.py`](file:///d:/Documents/can-do/custom_components/can_do/light.py) (404 LOC) | 1 catalog `light` entity (`ambient_light_colors`) | `get_can_state`, `get_can_payload` (`0x2DB`, `0x455`) | `async_send_entity_command` → `set/ambient_light_colors` (preset label, effect, `off`, or fallback RGB JSON) & `set/ambient_light_brightness` (strict FIFO; no raw `tx`) |

### 2F. Persistence, Schema & Cloud/CDN Boundaries

| Boundary | Producer / Writer | Consumer / Reader | Contract Notes |
| :--- | :--- | :--- | :--- |
| `automations.json` (Frontend ↔ Firmware) | [`automationConverters.ts`](file:///d:/Documents/can-do/frontend/src/utils/automationConverters.ts) (3,357 LOC) via `POST /api/automations` or MQTT `config/automations/set` | [`parser.cpp:643-2059`](file:///d:/Documents/can-do/firmware/main/core/parser.cpp#L643-L2059) → [`can_engine.cpp`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp) | Compiles visual DAG rules into JSON triggers/conditions/actions; `webhook` action & several `climate_target` fields are dropped on the firmware side. |
| LittleFS `/spiffs/` | `api.cpp`, `network_mgr.cpp`, `mqtt_mgr.cpp`, `can_engine.cpp`, `main.cpp`, `CMakeLists.txt`, `vite.config.ts` | `parser.cpp`, `can_engine.cpp`, `uds_engine.cpp`, `api.cpp`, `network_mgr.cpp`, `mqtt_mgr.cpp` | `catalog.json`, `automations.json`, `preferences.json`, `mqtt.json`, `networks.json`, `monitored_ids.json`, `crash_diag.json`, `www/*.gz` (960 KB C3 / 1984 KB S3). |
| NVS (`ble_cfg`) & `RTC_NOINIT_ATTR` | `ble_mgr.cpp` (paired HID + up to 5 beacons), `can_engine.cpp` (CAN state snapshot + `RtcCrashInfo` + clock anchor) | `ble_mgr.cpp`, `can_engine.cpp`, `api.cpp:1656` | Survives warm reboot; `persistent_settings.c` does **not** use NVS (RAM-only stub). |
| GitHub Releases API & Raw CDN | [`.github/workflows/firmware.yml`](file:///d:/Documents/can-do/.github/workflows/firmware.yml#L204-L252), [`deploy.yml`](file:///d:/Documents/can-do/.github/workflows/deploy.yml) | [`updateService.ts:119-817`](file:///d:/Documents/can-do/frontend/src/services/updateService.ts#L119-L817), [`catalog_loader.py:39`](file:///d:/Documents/can-do/custom_components/can_do/catalog_loader.py#L39), [`api.cpp:1303`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1303) | `firmware.yml` pushes with `[skip ci]`, so release commits do not automatically re-trigger `deploy.yml` (GitHub Pages). |

---

## 3. Broken Wires & Ghost Plumbing

### 3A. Emitters With NO Listener Anywhere in the Repo

1. **WS `ota_progress`** — Emitted during direct OTA upload at [`api.cpp:1262`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1262). Zero frontend listeners (`DeviceDashboard.tsx:886` & `updateService.ts:361` rely on `xhr.upload.onprogress`, and Cloud OTA polls `GET /api/ota/status`).
2. **WS `ble_device_event`** — Broadcast on BLE connect/disconnect at [`ble_mgr.cpp:609,648`](file:///d:/Documents/can-do/firmware/main/net/ble_mgr.cpp#L609-L657). Zero WebSocket listeners anywhere in `frontend/src/`.
3. **MQTT `cando/{dev}/config/automations/status`** — Published after MQTT automation saves at [`mqtt_mgr.cpp:1178-1190`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L1178-L1190) (`{"status":"ok"}` / `{"status":"error",...}`). Neither `AutomationBuilder.tsx` nor `custom_components/can_do/` subscribes to it.
4. **Frontend `webhook` Automation Action** — Fully editable in [`ActionNodeEditor.tsx:1702,2979`](file:///d:/Documents/can-do/frontend/src/components/automation/ActionNodeEditor.tsx#L2979) and compiled into `automations.json` by [`automationConverters.ts:812-818`](file:///d:/Documents/can-do/frontend/src/utils/automationConverters.ts#L812-L818) (`{type:'webhook', webhook_url, webhook_method}`), yet `firmware/main/core/parser.cpp` and `can_engine.cpp` have **zero** handling for `webhook`.
5. **HUD Nav `speed_limit` and `camera_alert` (End-to-End Ghost Plumbing)** — Wired through HA ([`services.yaml:88-104`](file:///d:/Documents/can-do/custom_components/can_do/services.yaml#L88-L104), [`__init__.py:56-66`](file:///d:/Documents/can-do/custom_components/can_do/__init__.py#L56-L66), [`coordinator.py:687-690`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L687-L690)), REST ([`api.cpp:2435-2439`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2435-L2439)), MQTT ([`mqtt_mgr.cpp:705-709`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L705-L709)), Frontend ([`AutomationBuilder.tsx:906-907`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L906-L907)), and Automations ([`parser.cpp:751-755`](file:///d:/Documents/can-do/firmware/main/core/parser.cpp#L751-L755), [`can_engine.cpp:1638-1639`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L1638-L1639)) into `hud_nav_instruction_t`, yet **never read or encoded anywhere in [`hud_nav.c`](file:///d:/Documents/can-do/firmware/main/subsystems/hud_nav.c)**.
6. **Notification `hold_ms`, `title`, `caller`, `type` Discarded** — HA [`services.yaml:33-43`](file:///d:/Documents/can-do/custom_components/can_do/services.yaml#L33-L43), [`notify.py:44,48`](file:///d:/Documents/can-do/custom_components/can_do/notify.py#L44-L48), and [`coordinator.py:665`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L665) transmit `hold_ms`; [`api.cpp:2353-2362`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2353-L2362) parses `caller`/`title`, `type`, and `hold_ms` then explicitly discards them (`(void)hold_ms;`), and [`mqtt_mgr.cpp:653-676`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L653-L676) ignores `hold_ms` completely.
7. **`CLIMATE_TARGET` Action Metadata (`zone`, `sync_on`, `driver_only`, `monitor_0x38`)** — Parsed into `ActionStep` at [`parser.cpp:695-715`](file:///d:/Documents/can-do/firmware/main/core/parser.cpp#L695-L715), reported by diagnostics at [`api.cpp:911`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L911), and emitted by [`AutomationBuilder.tsx:1123`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1123), yet completely ignored in [`can_engine.cpp:1621-1626,2070-2113`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L1621-L1626).
8. **UDS BMS `min_t`/`max_t` Dropped on MQTT** — [`uds_engine.cpp:190`](file:///d:/Documents/can-do/firmware/main/protocols/uds_engine.cpp#L190) passes `temp_min`/`temp_max` to [`mqtt_mgr_publish_bms()`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L1279-L1282), which silently discards both (`(void)min_t; (void)max_t;`).
9. **Non-Catalog `remote_climate` State ID** — [`remote_climate.cpp:103,105`](file:///d:/Documents/can-do/firmware/main/subsystems/remote_climate.cpp#L103-L106) emits `remote_climate` (`"ON"`/`"OFF"`), which is absent from `can_do_catalog.json` and ignored by both HA [`climate.py:88`](file:///d:/Documents/can-do/custom_components/can_do/climate.py#L88) (`remote_climate_state`) and [`VehicleDashboard.tsx:1043-1049`](file:///d:/Documents/can-do/frontend/src/components/VehicleDashboard.tsx#L1043-L1049).

### 3B. Listeners, Handlers & Stubs Waiting on Events, Routes, or Callers Nothing Sends

1. **Remaining Dead `can_frame` WebSocket Code**:
   - `broadcast_ws_can_frame()`, the `App.tsx` and `VehicleDashboard.tsx` `can_frame` WS listeners, the `0x455` ambient branch, and the unreferenced 522-line `handleIncomingCanFrame()` decoder block (plus dead `canMappings`, refs, and imports) in [`VehicleDashboard.tsx`](file:///d:/Documents/can-do/frontend/src/components/VehicleDashboard.tsx) have all been removed.
   - Only the ghost `can_frame` listener in [`AutomationBuilder.tsx:673`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L673) remains (and tested helpers in [`cockpitDecoders.ts`](file:///d:/Documents/can-do/frontend/src/utils/cockpitDecoders.ts) remain active via [`cockpitDecoders.test.ts`](file:///d:/Documents/can-do/frontend/src/utils/cockpitDecoders.test.ts)).
2. **Ghost Frontend WebSocket Listeners**:
   - `wifi_status` ([`AutomationBuilder.tsx:688`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L688)) — firmware never sends WS `wifi_status`.
   - `ble_proximity` ([`AutomationBuilder.tsx:697`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L697)) — firmware only sends `ble_beacon`.
   - `automation_fired.trigger_id` & `rule_id` ([`deviceWs.ts:13`](file:///d:/Documents/can-do/frontend/src/services/deviceWs.ts#L13), [`AutomationBuilder.tsx:681-684`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L681-L684)) — firmware only emits `{"type":"automation_fired","id":...,"name":...}` ([`api.cpp:154`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L154)).
   - Unused `wsRef` in [`DeviceDashboard.tsx:447`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L447).
3. **Uncalled REST Endpoints**:
   - `POST /api/wifi/settings` ([`api.cpp:2129,2830`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2129)) — zero callers anywhere in the repo.
   - `GET /api/ble/beacons` ([`api.cpp:2711,2837`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2711)) — zero callers (`BluetoothManager.tsx` only uses `POST`/`DELETE` and reads `beacon_targets` via `GET /api/ble/status`).
4. **6 Dead HA MQTT Discovery Topics** — [`manifest.json:17-22`](file:///d:/Documents/can-do/custom_components/can_do/manifest.json#L17-L22) registers `cando/+/ble_{button,beacon,device}` and unscoped `cando/ble_{button,beacon,device}`, but [`config_flow.py:82-83`](file:///d:/Documents/can-do/custom_components/can_do/config_flow.py#L82-L83) aborts with `invalid_discovery_info` for every topic whose last segment is not `"status"`.
5. **4 Unscoped HA MQTT Subscriptions Firmware Never Emits Unscoped** — [`coordinator.py:191-222`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L191-L222) subscribes to `cando/ble_button`, `cando/ble_beacon`, `cando/ble_device`, and `cando/active_ids`, whereas `mqtt_mgr.cpp` only publishes those under `cando/{DEVICE_ID}/...`.
6. **Non-Catalog Legacy IDs in HA & Firmware**:
   - [`climate.py:388`](file:///d:/Documents/can-do/custom_components/can_do/climate.py#L388) checks `climate_dual_cabin_temp` (missing from catalog; catalog defines `climate_driver_temp` & `climate_passenger_temp`).
   - [`sensor.py:394`](file:///d:/Documents/can-do/custom_components/can_do/sensor.py#L394) checks `wheel_speeds` (missing from catalog; only emitted by hardcoded `can_engine.cpp:3272`).
   - [`parser.cpp:1232`](file:///d:/Documents/can-do/firmware/main/core/parser.cpp#L1232) checks `cluster_hud_navigation_tbt` (missing from catalog; catalog ID is `hud_turn_by_turn_maneuver`, working only via `network.type == "hud_nav"`).
   - [`serial_cli.cpp:117`](file:///d:/Documents/can-do/firmware/main/net/serial_cli.cpp#L117) falls back to non-existent `doors_lock_state` (missing from catalog; catalog has `door_locks`).
7. **Dead Stubs & Uncalled Firmware Exports**:
   - [`config_server.c`](file:///d:/Documents/can-do/firmware/main/net/config_server.c#L1-L33) — returns hardcoded constants (`button=0`, `press=0`, `mode=1`, `fahrenheit=false`), locking preconditioning OSD popups to °C regardless of user unit preference.
   - [`persistent_settings.c`](file:///d:/Documents/can-do/firmware/main/platform/persistent_settings.c#L1-L27) — RAM-only `static bool` stub; continuous/persistent preconditioning state is lost on every reboot.
   - Uncalled exports: [`power_mgr_enter_deep_sleep()`](file:///d:/Documents/can-do/firmware/main/platform/power_mgr.cpp#L55), [`precondition_get_state()`](file:///d:/Documents/can-do/firmware/main/subsystems/precondition.c#L1565), [`precondition_get_car_model()`](file:///d:/Documents/can-do/firmware/main/subsystems/precondition.c#L1683), [`uds_engine_get_config()`](file:///d:/Documents/can-do/firmware/main/protocols/uds_engine.cpp#L34), [`uds_engine_set_config()`](file:///d:/Documents/can-do/firmware/main/protocols/uds_engine.cpp#L38), [`uds_engine_get_bms_data()`](file:///d:/Documents/can-do/firmware/main/protocols/uds_engine.cpp#L112).

### 3C. Duplicate Pathways Doing the Same Job

1. **Automations Sync (3 Paths)**: `GET`/`POST /api/automations` ([`api.cpp:1358,1391`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1358-L1391)), static `GET /automations.json` ([`api.cpp:274`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L274)), and MQTT `config/automations/{get,set,state}` ([`mqtt_mgr.cpp:411,593`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L411), [`AutomationBuilder.tsx:1546-1655`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1546-L1655)).
2. **Test Automation Alias Routes**: `POST /api/test_automation` (`wican_vehicle_stress.py`) and `POST /api/automations/test` (`AutomationBuilder.tsx`) both route to [`api_test_automation_handler`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2815-L2816).
3. **Dual OTA & Web Deployers**: Direct XHR `POST /api/ota` (`DeviceDashboard.tsx`, `updateService.ts`, `flash_ota.py`) vs ESP32-side HTTPS `POST /api/ota/cloud_pull` + `GET /api/ota/status`; LittleFS web asset sync duplicated in `updateService.ts` and `firmware/upload_web.py`.
4. **`POST /api/system/control` Double-Dispatch Bug**: [`DeviceDashboard.tsx:707-730`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L707-L730) sends BOTH `action: 'toggle_automations'` + `automations_enabled` (and `action: 'toggle_sniffer'` + `sniffer_mode`). [`api.cpp:1895-1926`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1895-L1926) executes **both** the toggle and the explicit setter sequentially (double CAN hardware reconfiguration + double LittleFS write for sniffer; only `mitm_bridge_enabled` guards against double execution).
5. **Dual-Duplicated Cockpit CAN Decoders**: Hardcoded in [`can_engine.cpp:2589-3301`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L2589-L3301) (~713 LOC, bypassing catalog; duplicate `0x455` ambient decoder removed in `0c74182` — `0x455` now decodes solely via generic `catalog_by_can_id` with `ambient_anim_is_active()` guard at [`L2557`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L2557)), and partially re-decoded in HA [`sensor.py`](file:///d:/Documents/can-do/custom_components/can_do/sensor.py) / [`climate.py`](file:///d:/Documents/can-do/custom_components/can_do/climate.py) — contradicting `GEMINI.md` Axiom 2. (The stale third copy in `VehicleDashboard.tsx` `handleIncomingCanFrame()` was removed.)
6. **Dual Climate TX on HA HVAC Mode Start**: [`climate.py:437-442`](file:///d:/Documents/can-do/custom_components/can_do/climate.py#L437-L442) sends `{"action":"start",...}` to `set/remote_climate` **and** immediately calls `async_set_temperature()`, transmitting a separate `action_can_id` temperature CAN burst before the car wakes.
7. **Duplicate Services, Ports & Status Endpoints**: Both `notify.can_do` and `can_do.notify` register identical handlers in [`notify.py:50-51`](file:///d:/Documents/can-do/custom_components/can_do/notify.py#L50-L51) (and `CanDoClusterMasterNotifyEntity` hardcodes `self.entity_id = "notify.can_do"` at `L89`, colliding in multi-device setups); `gvret_server.cpp:319` binds identical GVRET servers on ports `23` and `3333`; `api.cpp` exposes beacons on both `/api/ble/status` and uncalled `GET /api/ble/beacons`.

### 3D. Naming, Schema, Logic & Payload Mismatches (By Severity)

#### HIGH (Broken UI/HA Features & Cross-Layer Contract Drift)

1. **HA `event.py` Misclassifies All BLE Holds (`hold_1s`..`hold_Ns`) as `"press"` & Drops `hold_seconds`**:
   - [`ble_mgr.cpp:1053`](file:///d:/Documents/can-do/firmware/main/net/ble_mgr.cpp#L1053) emits `"hold_1s"`, `"hold_2s"`, etc. [`event.py:43,87`](file:///d:/Documents/can-do/custom_components/can_do/event.py#L43-L95) only accepts exact `["press","release","hold","combo"]` (defaulting all `hold_Ns` to `"press"`), and [`coordinator.py:449-455`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L449-L455) drops `hold_seconds`.
   - [`CanDoEventEntity`](file:///d:/Documents/can-do/custom_components/can_do/event.py#L101-L144) declares only `["press"]` in `_attr_event_types` even for multi-option catalog entities.
2. **`remote_climate` State Split Across 3 Disconnected IDs**:
   - [`remote_climate.cpp:103-106`](file:///d:/Documents/can-do/firmware/main/subsystems/remote_climate.cpp#L103-L106) emits `remote_climate` (`"ON"`/`"OFF"`) and `remote_climate_tmu` (`"Remote Climate On"`/`"Remote Climate Off"`).
   - HA [`switch.py:57-62`](file:///d:/Documents/can-do/custom_components/can_do/switch.py#L57-L62) only matches exact `("ON","ACTIVE","TRUE","1","HEAT")` / `("OFF","INACTIVE","FALSE","0")` → ignores `"Remote Climate On/Off"`.
   - HA [`climate.py:88,105`](file:///d:/Documents/can-do/custom_components/can_do/climate.py#L88-L105) listens ONLY to `remote_climate_state` (emitted solely by `can_engine.cpp:3106` on `0x384` D4==`0x0A`).
3. **`track_popup` Field Split (`popup_text` vs `popup_message`) & Missing `"critical"` Level**:
   - [`parser.cpp:661`](file:///d:/Documents/can-do/firmware/main/core/parser.cpp#L661) writes `step.popup_text` (leaving `step.popup_message` empty), while [`api.cpp:907`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L907) serializes `act.popup_message` (always `""` in diagnostics).
   - [`can_engine.cpp:1603-1609`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L1603-L1609) omits `"critical"` (maps to `INFO`), whereas [`api.cpp:2374`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L2374) and [`mqtt_mgr.cpp:672`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L672) map `"critical"` to `ERROR`.
4. **`can_engine.cpp` Bus Blindness & Unsynchronized Async Automation Globals**:
   - `can_state_cache`, `catalog_by_can_id`, `watched_auto_ids`, and RX trigger matching never compare `frame_bus` against `trig.bus` or `entity.bus` (same CAN ID on CAN0 and CAN1 overwrites cache and misfires cross-bus triggers).
   - [`s_current_firing_trigger_id`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L371) is an unsynchronized global never propagated into async burst tasks (breaking `triggered_by` conditions in async rules), and [`s_wait_for_start_ms`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L409) is shared across concurrent async rules.
5. **Web UI `UserPreferences` Strips `uds_enabled` on Every Save**:
   - [`uds_engine.cpp:312`](file:///d:/Documents/can-do/firmware/main/protocols/uds_engine.cpp#L312) and [`firmware/data/preferences.json:5`](file:///d:/Documents/can-do/firmware/data/preferences.json#L5) define `uds_enabled`, but [`settings.ts:21-40`](file:///d:/Documents/can-do/frontend/src/types/settings.ts#L21-L40) omits it. Every `POST /api/preferences` overwrites `/spiffs/preferences.json` wholesale ([`api.cpp:1478`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L1478)), deleting `uds_enabled`.
6. **`AutomationBuilder.tsx` `battery_preconditioning` Test Discards Top-Level `mode`/`action`**:
   - [`AutomationBuilder.tsx:1071-1079`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx#L1071-L1079) posts `{entity:'battery_preconditioning', command:..., mode:preconMode, action:preconAction}`. [`api.cpp:484-486`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L484-L486) forwards only `command` to `queue_entity_command()`, discarding top-level `mode`/`action`.

#### MEDIUM (Misclassified Sensors, Multi-Device Collisions, Protocol Quirks)

7. **HA `sensor.py` Unit/Class Bugs**:
   - [`sensor.py:289-292`](file:///d:/Documents/can-do/custom_components/can_do/sensor.py#L289-L292): `elif "soc" in cid or "v2l" in cid or unit == "%":` classifies `v2l_discharge_remaining_time` as `SensorDeviceClass.BATTERY` (`%`) instead of duration/minutes.
   - `remaining_charge_time_{ac,dc,120v}` have no `DURATION`/`min` branch in [`sensor.py:260-296`](file:///d:/Documents/can-do/custom_components/can_do/sensor.py#L260-L296).
8. **Multi-Device MQTT & HA Crosstalk**:
   - [`mqtt_mgr.cpp:232-236`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L232-L236) publishes **all** decoded entity states (and HA Discovery `state_topic` at `L329,376`) to unscoped `cando/state/{entity_id}` — multiple ESP32 adapters overwrite each other on the broker.
   - [`coordinator.py:437-541`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py#L437-L541) BLE handlers never call `_bind_device_id()`, leaking BLE events across multiple coordinators; and `async_start()` publishes retained unscoped `cando/subscribe_ids` when `device_id == "auto"`.
   - [`__init__.py:58-120`](file:///d:/Documents/can-do/custom_components/can_do/__init__.py#L58-L120) broadcasts all 5 services to every coordinator instance unconditionally (no `device_id` targeting).
9. **`mqtt_mgr.cpp` Reliability Bugs**:
   - `s_hydrated_from_mqtt` ([`mqtt_mgr.cpp:542`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L542)) is **never set to `true`** → re-subscribes to `cando/state/+` on every reconnect after cold boot.
   - Chunked `config/automations/set` ([`mqtt_mgr.cpp:606-623`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L606-L623)) checks only global `s_receiving_automations` without verifying continuation chunks belong to the same message → any interleaved MQTT packet corrupts `automations.json.tmp`.
   - [`publish_automations_json_state()`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp#L420,432) publishes `"[]"` when missing/>32 KB, whereas `GET /api/automations` returns `{settings:{...}, rules:[]}`.
10. **TPMS & UDS BMS Entity ID Mismatch**:
    - [`can_engine.cpp:3260-3275`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L3260-L3275) decodes `0x593`/`0x368` into non-catalog `"wheel_speeds"`, while catalog defines `tpms_front_tires` (`0x3A1`) / `tpms_rear_tires` (`0x3A2`).
    - [`uds_engine.cpp:174-187`](file:///d:/Documents/can-do/firmware/main/protocols/uds_engine.cpp#L174-L187) emits non-catalog WS IDs (`hv_power_kw`, `bms_soc`, `hv_battery_voltage`, `hv_battery_current`, `hv_cell_delta_mv`) via `broadcast_ws_raw()` only — absent from `/api/states` and WS initial snapshot.
11. **`0x594` 12V Decoder Reads Wrong Byte (`D6` instead of `D5`)**:
    - [`can_engine.cpp:2692-2694`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L2692-L2694): for 8-byte `0x594`, `data_length_code >= 6 ? data[5] : data[4]` reads `data[5]` (`D6`, belonging to `0x1CF`) instead of `data[4]` (`D5`).
12. **`ambient_light_colors` Early Intercept (Static Lookup Fixed) & Domainless `ambient_light_brightness`**:
    - [`can_engine.cpp:2115-2257`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp#L2115-L2257) now intercepts `ambient_light_colors` **only** for dynamic animations, explicit `"Off"`, and raw RGB/palette JSON payloads (`0c74182`); standard static color labels fall through to `find_entity_in_catalog()` (`L2261`).
    - `ambient_light_brightness` intentionally has `ha_metadata.domain = null` in `can_do_catalog.json`, so HA creates no standalone entity for it; instead [`light.py`](file:///d:/Documents/can-do/custom_components/can_do/light.py) routes brightness/off actions through `/set/ambient_light_brightness` under the single `ambient_light_colors` entity (`8203195`).
13. **HA Platform Edge Cases (`notify.py`, `cover.py`)**:
    - [`notify.py:27-29`](file:///d:/Documents/can-do/custom_components/can_do/notify.py#L27-L29) hijacks catalog entity `cluster_nav_osd_countdown` (`0x4E8`) and routes it to `cando/{dev}/notify` (`track_popup`) instead of its catalog CAN ID.
    - [`cover.py:60-64`](file:///d:/Documents/can-do/custom_components/can_do/cover.py#L60-L64) checks only `opt.get("payload")` (omitting `opt.get("steps")`) when enabling `OPEN_TILT`.
14. **`ble_mgr.cpp`, `gvret_server.cpp` & `usb_can.cpp` Protocol Quirks**:
    - [`ble_mgr.cpp:592`](file:///d:/Documents/can-do/firmware/main/net/ble_mgr.cpp#L592) stops background iBeacon scanning whenever a paired HID remote connects, causing tracked phone beacons to time out and emit false `"exit"` events.
    - [`ble_mgr.cpp:341-343`](file:///d:/Documents/can-do/firmware/main/net/ble_mgr.cpp#L341-L343) emits `device_address`/`button_name` in `/api/ble/status` vs `address`/`button` in WS `ble_event` (`L370-L372`).
    - [`gvret_server.cpp:118-120`](file:///d:/Documents/can-do/firmware/main/net/gvret_server.cpp#L118-L120): `flags = ((bus & 0x0F) << 4) | (dlc & 0x0F); if (rtr) flags |= 0x40;` overlaps bit 6 (`0x40`) with the bus nibble; and both [`gvret_server.cpp:205`](file:///d:/Documents/can-do/firmware/main/net/gvret_server.cpp#L205) and [`usb_can.cpp:66,75`](file:///d:/Documents/can-do/firmware/main/net/usb_can.cpp#L66-L75) discard the incoming `bus` field (always injecting as bus 0).
15. **Dev Mock Drift & Misleading UI Copy**:
    - [`vite.config.ts:86,137`](file:///d:/Documents/can-do/frontend/vite.config.ts#L86-L137) diverges from ESP32 `api.cpp` on `/api/command` (`"ok"` vs `"queued"`) and dev-only `/api/catalog`.
    - [`DeviceDashboard.tsx:1842`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L1842) claims signals stream to `homeassistant/sensor/cando/...` (actual: `cando/state/...`), and [`L2650`](file:///d:/Documents/can-do/frontend/src/components/DeviceDashboard.tsx#L2650) says UDS polls "while driving or charging" (contradicting `uds_engine.cpp:253`).
16. **`/api/automations/diagnostics` Operator Rendering**:
    - [`api.cpp:857-861`](file:///d:/Documents/can-do/firmware/main/net/api.cpp#L857-L861) omits `LESS_THAN_OR_EQUAL` and `GREATER_THAN_OR_EQUAL`, rendering both as `"=="` in diagnostics JSON (runtime condition evaluation in `can_engine.cpp` is fixed).

---

## 4. Recommended Audit Order (Top 10 Load-Bearing Files)

Ordered strictly from the **core data/message spine outward**, prioritizing blast radius, cross-layer coupling, and confirmed defect density:

1. **[`catalog/can_do_catalog.json`](file:///d:/Documents/can-do/catalog/can_do_catalog.json)** *(Canonical Single Source of Truth)*
   - Every firmware index, HA platform, and UI component derives schemas from this file. `number` byte keys (`state_byte`/`action_byte`) and `hi6_*` DSP routing are now consumed cleanly downstream; keep auditing domainless `ambient_light_brightness` and TPMS CAN IDs (`0x3A1`/`0x3A2` vs `0x593`/`0x368`).
2. **[`firmware/main/core/can_engine.cpp`](file:///d:/Documents/can-do/firmware/main/core/can_engine.cpp)** *(4,240 LOC — Core RTOS CAN & Automation Spine)*
   - Highest complexity and defect density in the repo: `<=`/`>=` non-CAN condition operators are **fixed** (`L778-989`), leaving bus-blind cache/triggers, unsynchronized async globals (`s_current_firing_trigger_id`, `s_wait_for_start_ms`), `0x594` `D6`-vs-`D5` bug, ignored `CLIMATE_TARGET` fields, and ~713 LOC hardcoded cockpit decoders competing with the catalog.
3. **[`firmware/main/core/parser.cpp`](file:///d:/Documents/can-do/firmware/main/core/parser.cpp)** *(2,059 LOC — PSRAM Schema & Automation Compiler)*
   - Owns all 1-based→0-based `D1`–`D8` translation, PSRAM allocation discipline (`PsramVector`), MITM rule compilation, and `automations.json` parsing (`popup_text` vs `popup_message`, missing `webhook`, stale `cluster_hud_navigation_tbt`, and parsed fields ignored downstream).
4. **[`firmware/main/net/api.cpp`](file:///d:/Documents/can-do/firmware/main/net/api.cpp)** *(2,865 LOC — HTTP/REST, WebSocket `/ws`, Static SPA & Cloud OTA)*
   - Sole ingress/egress for the Web UI and OTA: audit `/api/system/control` double-dispatch, `/api/automations/diagnostics` (`popup_message`, missing `<=`/`>=`), `/api/notify` discarding `hold_ms`/`title`, `/api/preferences` wholesale overwrite, ghost `ota_progress`, and LittleFS flash safety.
5. **[`firmware/main/net/mqtt_mgr.cpp`](file:///d:/Documents/can-do/firmware/main/net/mqtt_mgr.cpp)** *(1,386 LOC — MQTT Broker & HA Transport Spine)*
   - Sole bridge to Home Assistant: audit unscoped `cando/state/{entity_id}` multi-device collisions, 3-prefix inbound aliasing, `s_hydrated_from_mqtt` never set `true`, `s_receiving_automations` chunk corruption, dropped `min_t`/`max_t` in `mqtt_mgr_publish_bms`, discarded `hold_ms` in `notify`, and mutex/lock ordering.
6. **[`firmware/main/protocols/uds_engine.cpp`](file:///d:/Documents/can-do/firmware/main/protocols/uds_engine.cpp)** *(357 LOC — Active Diagnostic TX Poller & Vehicle Wake/Sleep Gate)*
   - Directly transmits `0x7E4` UDS queries onto the live vehicle bus and drives wake/sleep gating for `power_mgr` and `network_mgr`: `0x1AC` speed byte (`data[0]`) and `0x045`/`0x070` gear safety gate are **fixed** (removing the `0x038` READY misread); remaining items are `uds_enabled` persistence and non-catalog BMS WS entity IDs.
7. **[`firmware/main/net/ble_mgr.cpp`](file:///d:/Documents/can-do/firmware/main/net/ble_mgr.cpp)** *(1,531 LOC — NimBLE HID Central + iBeacon Observer)*
   - Audit Wi-Fi/BLE coex timing, HID connection halting iBeacon scanning (causing false `"exit"` timeouts), REST-vs-WS field drift (`device_address`/`button_name` vs `address`/`button`), missing `is_present` on WS `ble_beacon`, ghost `ble_device_event` WS, and `hold_Ns` contract with HA.
8. **[`custom_components/can_do/coordinator.py`](file:///d:/Documents/can-do/custom_components/can_do/coordinator.py)** *(797 LOC — Home Assistant MQTT State & Command Hub)*
   - Central hub feeding all 12 HA entity platforms and 7 services: `hi6_*` `0x60C` DSP routing is **fixed**; remaining items are multi-device BLE & unscoped subscription isolation, `hold_seconds` stripping, and numeric/string state parsing upstream of `sensor.py`/`binary_sensor.py`/`number.py`.
9. **[`frontend/src/utils/automationConverters.ts`](file:///d:/Documents/can-do/frontend/src/utils/automationConverters.ts)** *(3,357 LOC — Frontend ↔ Firmware `automations.json` Compiler)*
   - Largest single TypeScript contract layer: audit full round-trip parity against `parser.cpp` and `can_engine.cpp` (unsupported `webhook` actions, `climate_target` dropped fields, `popup_message` vs `text`, and trigger/condition operator parity).
10. **[`frontend/src/components/AutomationBuilder.tsx`](file:///d:/Documents/can-do/frontend/src/components/AutomationBuilder.tsx)** *(2,839 LOC — Primary Web UI REST/WS/MQTT Consumer)*
    - `/api/states`, `/api/ble/status`, and WS `ble_beacon` contracts (plus `vite.config.ts` mocks) are **fixed**; remaining items are `battery_preconditioning` test payload and ghost WS handlers.

> **Immediate Leaf-Layer Quick Wins (Status)**: **Done** — [`custom_components/can_do/number.py`](file:///d:/Documents/can-do/custom_components/can_do/number.py#L45) (`D1` overwrite), [`custom_components/can_do/binary_sensor.py`](file:///d:/Documents/can-do/custom_components/can_do/binary_sensor.py#L233) (`doors_status` false-Closed), [`custom_components/can_do/sensor.py`](file:///d:/Documents/can-do/custom_components/can_do/sensor.py#L269-L276) (odometer km unit), [`firmware/main/net/serial_cli.cpp`](file:///d:/Documents/can-do/firmware/main/net/serial_cli.cpp#L95) (`wifi_delete`), [`firmware/main/net/network_mgr.cpp`](file:///d:/Documents/can-do/firmware/main/net/network_mgr.cpp) (`/api/wifi/scan`), and [`frontend/src/components/VehicleDashboard.tsx`](file:///d:/Documents/can-do/frontend/src/components/VehicleDashboard.tsx) (dead `handleIncomingCanFrame`). **Open** — [`custom_components/can_do/sensor.py`](file:///d:/Documents/can-do/custom_components/can_do/sensor.py#L289-L292) (`v2l` `%` unit bug) and [`firmware/main/subsystems/precondition.c`](file:///d:/Documents/can-do/firmware/main/subsystems/precondition.c#L1-L1694) (MITM forwarding hook + stubbed `config_server.c`/`persistent_settings.c`).
