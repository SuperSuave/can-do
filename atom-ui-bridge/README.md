# M5Stack Atom Lite (ESP32-PICO-D4) UI & BLE Bridge for WiCAN

This is a lightweight stop-gap bridge designed to offload the React SPA Web UI and Bluetooth LE (BLE) button scanning from the ESP32-C3 WiCAN to a spare **M5Stack Atom Lite**, until your WiCAN S3 hardware arrives.

---

## 1. Hardware Pinout & Wiring

Connect the M5Stack Atom Lite's **Grove Port** to the WiCAN's top 2x5 expansion pins using 3 wires:

| Atom Lite Grove Port | Pin | Wire Color | WiCAN Pin | Description |
| :--- | :--- | :--- | :--- | :--- |
| **G26 (RX)** | Pin 1 | Yellow | **IO1 (TX)** | High-speed telemetry from WiCAN to Atom Lite |
| **G32 (TX)** | Pin 2 | White | **IO5 (RX)** | Commands / Triggers from Atom Lite to WiCAN |
| **GND** | Pin 4 | Black | **GND** | Shared common ground reference |
| **Power** | USB-C | — | — | Power the Atom Lite via a standard 5V USB-C cable |

> [!WARNING]
> Do NOT connect to WiCAN **IO4** (OBD Battery ADC) or **IO6** (CAN Transceiver Standby).  
> Power the Atom Lite via its USB-C port to prevent drawing excessive current from WiCAN's internal 3.3V rail.

---

## 2. Flashing the Atom Lite

### Option A: Using PlatformIO (VS Code Extension or CLI)

1. Open `atom-ui-bridge` in VS Code with PlatformIO installed.
2. Sync the latest web assets to `atom-ui-bridge/data`:
   ```bash
   python sync_web_assets.py
   ```
3. Connect your Atom Lite to your PC via USB-C.
4. Build and upload the firmware:
   ```bash
   pio run -t upload
   ```
5. Upload the web assets to LittleFS:
   ```bash
   pio run -t uploadfs
   ```

---

## 3. How It Works

1. **Wi-Fi Access Point:**
   - The Atom Lite broadcasts an open Access Point named **`CAN-Do`**.
   - Connect your phone or laptop to `CAN-Do` and navigate to:
     ```
     http://192.168.4.1
     ```
2. **Web Serving:**
   - The Atom Lite serves the full CAN-Do React UI directly from LittleFS in pre-compressed `.gz` format (~640 KB total).
   - WiCAN's flash and RAM are completely freed from serving web pages.
3. **High-Speed UART Bridge (921,600 baud):**
   - Live telemetry, CAN frames, and vehicle states streamed from WiCAN are received on Grove Pin 26 and immediately broadcast to your browser's WebSocket (`/ws`).
   - UI button clicks and commands sent to `/api/command` are relayed directly to WiCAN over Grove Pin 32.
4. **Bluetooth LE (BLE) Support:**
   - The Atom Lite runs NimBLE scanning for Bluetooth buttons/remotes.
   - Pair buttons in the UI under **Bluetooth Manager**.
   - When a paired button is clicked, Atom Lite immediately fires a trigger to WiCAN to toggle preconditioning/automations.
5. **Status LED Indicators:**
   - **Green:** Wi-Fi AP active, awaiting connections.
   - **Blue:** Web browser connected to WebSocket.
   - **Purple Flash:** BLE button press detected.
   - **Red:** WiCAN UART communication lost.
   - **Onboard Button (Pin 39):** Pressing the Atom Lite's face button sends an instant preheat/preconditioning toggle command to the vehicle!

---

## 4. Reverting when the WiCAN S3 Arrives

When your ESP32-S3 WiCAN arrives:
1. Disconnect the Atom Lite.
2. In WiCAN firmware: simply remove `uart_bridge.cpp` from `CMakeLists.txt` and re-enable native static serving.
