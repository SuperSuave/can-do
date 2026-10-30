# CAN Do: Atom UI Bridge (`atom-ui-bridge`)

**Atom UI Bridge** is a lightweight stop-gap bridge and PlatformIO companion firmware for the **M5Stack Atom Lite (ESP32-PICO-D4)** that pairs with the main **CAN Do** ESP32 vehicle engine over a high-speed UART link (`uart_bridge`). It offloads physical UI controls, BLE scanning, and the React SPA Web UI from the ESP32-C3 WiCAN until WiCAN S3 hardware arrives.

---

## 📂 Directory Structure

```text
/atom-ui-bridge
├── src/
│   └── main.cpp                 # Companion firmware entry point, UART bridge, BLE, and UI logic
├── data/                        # LittleFS filesystem image contents
│   ├── catalog/
│   │   ├── can_do_catalog.json  # Synced CAN Do catalog
│   │   └── can_do_catalog.json.gz
│   ├── frontend_manifest.json   # Build manifest for static web assets
│   ├── index.html(.gz)          # Compressed React frontend bundle
│   └── *.js.gz / *.css.gz       # Code-split gzipped frontend chunks
├── partitions.csv               # Custom flash partition layout
├── platformio.ini               # PlatformIO build environment configuration
├── sync_web_assets.py           # Syncs compiled frontend/ and catalog/ assets into data/
└── can-do-atom-bridge.bin       # Pre-built firmware binary

```

---

## 1. Hardware Pinout & Wiring

Connect the M5Stack Atom Lite's **Grove Port** to the WiCAN's top 2x5 expansion pins using 3 wires:

| Atom Lite Grove Port | Pin | Wire Color | WiCAN Pin | Description |
| --- | --- | --- | --- | --- |
| **G26 (RX)** | Pin 1 | Yellow | **IO1 (TX)** | High-speed telemetry from WiCAN to Atom Lite |
| **G32 (TX)** | Pin 2 | White | **IO5 (RX)** | Commands / Triggers from Atom Lite to WiCAN |
| **GND** | Pin 4 | Black | **GND** | Shared common ground reference |
| **Power** | USB-C | — | — | Power the Atom Lite via a standard 5V USB-C cable |

> [!WARNING]
> Do NOT connect to WiCAN **IO4** (OBD Battery ADC) or **IO6** (CAN Transceiver Standby).
> Power the Atom Lite via its USB-C port to prevent drawing excessive current from WiCAN's internal 3.3V rail.

---

## 🚀 Building & Flashing

### Prerequisites

* [PlatformIO Core (CLI)](https://docs.platformio.org/en/latest/core/installation/index.html) or the PlatformIO VS Code Extension.
* Python 3 and Node.js / npm (if rebuilding the React frontend or running sync scripts).

### 1. Sync Web & Catalog Assets

Whenever you update `/catalog/can_do_catalog.json` or rebuild the React frontend, sync the latest compressed assets into `atom-ui-bridge/data/`:

```bash
python sync_web_assets.py

```

### 2. Build and Flash Firmware

Connect your Atom Lite to your PC via USB-C. Using PlatformIO CLI from inside `atom-ui-bridge/`:

```bash
# Compile and upload the firmware application
pio run -t upload

# Build and upload the LittleFS data/ partition (web UI + catalog)
pio run -t uploadfs

# Open the serial monitor
pio device monitor

```

---

## 3. How It Works

1. **Wi-Fi Access Point:**
* The Atom Lite broadcasts an open Access Point named **`CAN-Do`**.
* Connect your phone or laptop to `CAN-Do` and navigate to:
```
http://192.168.4.1

```




2. **Web Serving:**
* The Atom Lite serves the full CAN-Do React UI directly from LittleFS in pre-compressed `.gz` format (~640 KB total).
* WiCAN's flash and RAM are completely freed from serving web pages.


3. **High-Speed UART Bridge (921,600 baud):**
* Live telemetry, CAN frames, and vehicle states streamed from WiCAN are received on Grove Pin 26 and immediately broadcast to your browser's WebSocket (`/ws`).
* UI button clicks and commands sent to `/api/command` are relayed directly to WiCAN over Grove Pin 32.


4. **Bluetooth LE (BLE) Support:**
* The Atom Lite runs NimBLE scanning for Bluetooth buttons/remotes.
* Pair buttons in the UI under **Bluetooth Manager**.
* When a paired button is clicked, Atom Lite immediately fires a trigger to WiCAN to toggle preconditioning/automations.


5. **Status LED Indicators:**
* **Green:** Wi-Fi AP active, awaiting connections.
* **Blue:** Web browser connected to WebSocket.
* **Purple Flash:** BLE button press detected.
* **Red:** WiCAN UART communication lost.
* **Onboard Button (Pin 39):** Pressing the Atom Lite's face button sends an instant preheat/preconditioning toggle command to the vehicle!



---

## 🔗 Integration with Main Firmware

The Atom UI Bridge communicates bi-directionally with the primary CAN Do ESP32 controller via `firmware/main/net/uart_bridge.cpp`:

* Receives live vehicle state updates and subsystem status (preconditioning, climate, bus activity) from the main controller.
* Forwards button presses, command triggers, and API/web requests back to the main CAN engine for execution on the vehicle bus.

---

## 4. Reverting when the WiCAN S3 Arrives

When the ESP32-S3 WiCAN hardware arrives:

1. Disconnect the Atom Lite bridge.
2. In the main WiCAN firmware: simply remove `uart_bridge.cpp` from `CMakeLists.txt` and re-enable native static web serving.