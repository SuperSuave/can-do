# CAN Do: ESP32 Autonomous Vehicle Engine

**CAN Do** is an edge-first automotive CAN bus integration and automation platform designed primarily for Hyundai, Kia, and Genesis (E-GMP) vehicles.

It transforms an ESP32 (such as the ESP32-S3 Dual CAN FD HAT prototype or WiCAN-OBD-C3) into a standalone, offline controller that evaluates network states and executes commands directly on the CAN bus, exposing bi-directional state synchronization via MQTT, WebSockets, USB-CAN, and Home Assistant.

---

## 🏗 System Architecture

1. **Edge-First Execution (ESP32)**: Operates 100% offline. Vehicle triggers, conditions, and actions execute locally without needing an active Wi-Fi or MQTT connection.
2. **Single Source of Truth (`catalog/`)**: All entity definitions, byte masks, and automation rules are defined in `catalog/can_do_catalog.json` using 1-based indexing (`D1`–`D8`).
3. **Storage & Packaging (LittleFS)**: The JSON catalog, preferences, automations, and compressed web interface assets are bundled into a dedicated LittleFS flash partition (`storage`) across 4 MB (`esp32c3`: 960 KB LittleFS) and 8 MB (`esp32s3` + PSRAM: 1984 KB LittleFS) dual-OTA layouts.
4. **Boot Parser (cJSON)**: Deserializes the catalog into PSRAM/RAM once at startup, building ultra-fast 0-indexed C++ bitmasks for sub-microsecond CAN frame evaluations.
5. **Execution Engine & Protocols (FreeRTOS)**:
   * **`can_rx_task` (Priority 5)**: Real-time listener for Dual MCP2518FD SPI CAN FD (`CAN0` + `CAN1`, with optional catalog-driven `network.mitm` bridge on ESP32-S3) and on-chip TWAI (`CAN0` on ESP32-C3); updates the RAM State Cache and dispatches state updates.
   * **`can_tx_task` (Priority 4)**: Consumes commands from `tx_command_queue` and transmits single frames, frame bursts, ISO-TP multi-frame payloads, and UDS diagnostic sequences without blocking network tasks.
6. **Built-in Vehicle Subsystems**:
   * **Battery Preconditioning**: State-machine-driven manual and automated HV battery preconditioning (`precondition`).
   * **Cluster & Infotainment Feedback**: Media track popups (`track_popup`), HUD navigation cues (`hud_nav`), ambient lighting animations (`ambient_anim`), and audible vehicle chimes (`beep`).
   * **Remote Climate**: Wakes the E-GMP gateway via AUTOSAR Network Management (`0x561`–`0x565`) + UDS `TesterPresent` (`0x7DF`) and maintains `TMU_01_200ms` (`0x39B`) 5 Hz keepalive and release bursts with target temperature, front defrost, and session duration control (`remote_climate`).
   * **UDS BMS Telemetry**: Stationary/parked and charging HV battery diagnostic poller (`0x7E4` → `0x7EC` PID `220101`) with 12V cutoff, quiet-hours, and driving safety gates (`uds_engine`).
7. **Multi-Interface Connectivity**:
   * **Home Assistant Bridge**: Native custom component (`custom_components/can_do`, HACS-ready) communicating over MQTT, plus optional MQTT Auto-Discovery grouping all entities under a unified vehicle device registry.
   * **Bluetooth BLE HID & iBeacon (ESP32-S3)**: NimBLE Central pairing for BLE HID steering-wheel/media remotes (single/multi-click, hold, and button chords) plus passive Observer tracking for phone iBeacons (`ble_mgr`).
   * **Diagnostic & Telemetry Interfaces**: Supports SavvyCAN via GVRET (`gvret_server`) and USB-CAN / SLCAN (`usb_can`).
   * **Web Management & Real-time Logs**: Streams static gzipped assets from LittleFS, provides REST endpoints (`/api/states`, `/api/command`, `/api/test_automation`, `/api/upload`, `/api/ota`, `/api/ota/cloud_pull`), and pipes system logs over `/ws` using an `esp_log_set_vprintf` hook.

---

## 📂 Repo Structure

```text
/can-do
├── /catalog
│   └── can_do_catalog.json          # Single source of truth (D1-D8 byte maps, entities, automations)
│
├── /firmware                        # ESP-IDF C/C++ autonomous vehicle engine
│   ├── partitions.csv               # Custom 4MB partition table (dual OTA + LittleFS) for ESP32-C3
│   ├── partitions_8mb.csv           # Custom 8MB partition table (dual OTA + LittleFS) for ESP32-S3
│   ├── sdkconfig.defaults           # Default ESP-IDF configuration (ESP32-C3)
│   ├── sdkconfig.defaults.esp32s3   # ESP32-S3 configuration (Dual-CAN, 2MB PSRAM, NimBLE BLE)
│   ├── upload_web.py                # Helper script for pushing web assets over HTTP
│   ├── flash_ota.py                 # Helper script for pushing firmware binaries over HTTP OTA
│   ├── version.txt                  # Firmware build version tracker
│   ├── /data                        # Default LittleFS staging (automations.json, preferences.json, /www)
│   └── /main
│       ├── main.cpp                 # Application entry, task scheduling, and initialization
│       ├── /core                    # Core CAN & catalog evaluation engine
│       │   ├── can_engine.cpp/.h    # State cache, condition evaluation, MITM bridge, and TX burst queue
│       │   ├── mcp2518fd.cpp/.h     # Dual SPI CAN FD controller driver (ESP32-S3)
│       │   ├── parser.cpp/.h        # cJSON catalog/automation loader and bitmask generator
│       │   ├── psram_alloc.h        # PSRAM-backed STL allocator helpers
│       │   ├── board_pins.h         # Hardware GPIO definitions
│       │   ├── can.h                # Low-level CAN interface definitions
│       │   └── types.h              # Shared C++ data structures
│       ├── /net                     # Network, API, BLE, and hardware bridge services
│       │   ├── api.cpp/.h           # REST endpoints, WebSocket broadcaster, Cloud OTA, and log hook
│       │   ├── ble_mgr.cpp/.h       # NimBLE HID Central & iBeacon Observer manager (ESP32-S3)
│       │   ├── config_server.c/.h   # Cluster OSD °C/°F unit preference loader
│       │   ├── gvret_server.cpp/.h  # GVRET server for SavvyCAN integration
│       │   ├── mqtt_mgr.cpp/.h      # MQTT client and Home Assistant Auto-Discovery
│       │   ├── network_mgr.cpp/.h   # Wi-Fi AP/STA connection manager
│       │   ├── serial_cli.cpp/.h    # USB serial JSON/text diagnostics & Wi-Fi provisioning CLI
│       │   └── usb_can.cpp/.h       # USB-CAN / SLCAN serial interface
│       ├── /platform                # Device power, NVS, and sensor management
│       │   ├── persistent_settings.c/.h # NVS settings storage (cando_cfg / precon_en)
│       │   ├── power_mgr.cpp/.h     # Tier 1/2/3 sleep, low-12V cutoff, and safe restart manager
│       │   ├── timezone_mgr.cpp/.h  # NTP and POSIX timezone handling
│       │   └── vbat_sensor.cpp/.h   # 12V auxiliary battery voltage monitoring
│       ├── /protocols               # Transport layers and state machine frameworks
│       │   ├── hsm.c/.h             # Hierarchical State Machine (HSM) core
│       │   ├── isotp_tx.c/.h        # ISO-TP (ISO 15765-2) multi-frame CAN transmitter
│       │   ├── uds_engine.cpp/.h    # UDS diagnostic request/response engine
│       │   └── utf8_utf16_converter.c/.h # UTF-8 to UTF-16LE converter for CAN text payloads
│       └── /subsystems              # E-GMP vehicle feature modules
│           ├── ambient_anim.cpp/.h  # Dynamic ambient lighting animations
│           ├── beep.c/.h            # Vehicle cluster/head-unit chime generator
│           ├── hud_nav.c/.h         # Head-Up Display (HUD) navigation rendering
│           ├── precondition.c/.h    # HV battery preconditioning state machine
│           ├── remote_climate.cpp/.h# Remote climate and wake control
│           └── track_popup.c/.h     # Infotainment media track popup notifications
│
├── /frontend                        # Catalog explorer, visualizer & automation builder (React 19 + Vite 6 + TypeScript + Tailwind 4 + HeroUI)
│   ├── src/                         # Components, DBC converter, live evaluator, and WebSocket services
│   ├── package.json                 # Frontend dependencies and scripts
│   └── vite.config.ts               # Vite bundler configuration
│
├── /custom_components/can_do        # Home Assistant custom integration (HACS ready)
│   ├── manifest.json                # HA integration manifest
│   ├── brand/                       # Local HACS dark/light icons and logos
│   └── *.py                         # binary_sensor, button, climate, cover, event, light, lock, notify, number, select, sensor, switch
│
├── /scripts                         # Tooling: catalog optimizer, WiCAN log replay, and vehicle stress tests
├── /tests                           # Python unittest suite (HA MQTT coordinator/entities, E-GMP decoders, charging power/time, HUD nav, catalog_loader, remote_climate)
└── /docs                            # Architecture specs, E-GMP CAN reference, and MICOM filter tables

```

---

## 🚀 Getting Started

### 1. Catalog & Automation Builder (`frontend/`)

```bash
cd frontend
npm install
npm run dev     # Start catalog builder UI on http://localhost:3000
npm run lint    # Type-check with tsc --noEmit
npm run build   # Build production web bundle
npm test        # Run frontend unit tests (DBC converter, validators, automation converters)

```

### 2. ESP32 Firmware (`firmware/`)

Requires [ESP-IDF v5.0+](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/):

```bash
cd firmware
idf.py set-target esp32s3   # Dual-CAN FD + BLE HID/iBeacon (or esp32c3 for WiCAN-OBD-C3)
idf.py build
idf.py -p COMx flash monitor

```

### 3. Home Assistant Integration (`custom_components/can_do/`)

1. In Home Assistant, open **HACS** -> **Integrations** -> **Custom repositories**.
2. Add `https://github.com/SuperSuave/can-do` with category **Integration**.


3. Install **CAN Do**, restart Home Assistant, and add the integration via **Settings** -> **Devices & Services**.

---

## 🔄 OTA & Diagnostic Features

* **Firmware OTA**: Upload `can-do-esp32s3.bin` or `can-do-esp32c3.bin` via `POST /api/ota` (or trigger a staged GitHub Release pull via `POST /api/ota/cloud_pull`) directly from the web dashboard.


* **Catalog & Web Hot-Push**: Push updated JSON or web assets via `POST /api/upload` (or `firmware/upload_web.py`) without re-flashing the application partition.


* **Test Automation**: Test rules using `POST /api/test_automation` in either `dry_run` (evaluate conditions against current cache) or `live_fire` (force trigger actions).


* **SavvyLens/SavvyCAN / GVRET**: Connect SavvyLens/SavvyCAN over Wi-Fi via the built-in GVRET server (`gvret_server`) to inspect live bus traffic.


* **Wireless Console**: Connect to `/ws` to stream real-time FreeRTOS system logs directly to your browser or mobile dashboard.



---

## 🙏 Acknowledgments & Credits

Portions of the E-GMP vehicle subsystem logic and transport protocols in `firmware/main/` are adapted and maintained in sync (with project-specific modifications) from **[L1Z3/wicant-i-precondition](https://github.com/L1Z3/wicant-i-precondition)** (developed by [@L1Z3](https://github.com/L1Z3), [@tylerharvey](https://github.com/tylerharvey), and contributors for the [Electroniq Buttons](https://electroniqbuttons.com/) / [Ioniq5_CAN](https://github.com/tylerharvey/Ioniq5_CAN) project, forked from [@meatpiHQ/wican-fw](https://github.com/meatpiHQ/wican-fw)):

* **`firmware/main/subsystems/precondition.c/.h`** — E-GMP HV battery preconditioning state machine and control logic


* **`firmware/main/subsystems/beep.c/.h`** — Audible vehicle chime/beep feedback generation over CAN


* **`firmware/main/subsystems/track_popup.c/.h`** — Infotainment media track popup notification rendering


* **`firmware/main/protocols/isotp_tx.c/.h`** — ISO-TP (ISO 15765-2) multi-frame CAN transport layer transmitter


* **`firmware/main/protocols/utf8_utf16_converter.c/.h`** — UTF-8 to UTF-16LE string encoding helper for CAN payloads


* **`firmware/main/protocols/hsm.c/.h`** — Hierarchical State Machine (HSM) core framework

* **`firmware/main/net/config_server.c/.h`** & **`firmware/main/platform/persistent_settings.c/.h`** - Interface compatibility with the upstream WiCAN / `wicant-i-precondition` modules.

Upstream code from `L1Z3/wicant-i-precondition` and `meatpiHQ/wican-fw` is licensed under the [GNU General Public License v3.0 (GPL-3.0)](https://github.com/L1Z3/wicant-i-precondition/blob/main/LICENSE).