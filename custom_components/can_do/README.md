# CAN Do: Home Assistant Integration

This directory contains the custom Home Assistant integration for **CAN Do**, providing high-performance, bidirectional control and telemetry for Hyundai/Kia/Genesis vehicles (E-GMP / Gen5W platforms) communicating purely over **MQTT**.

---

## 🌟 Highlights

- **Pure MQTT**: Operates 100% via MQTT topics with Last Will and Testament (LWT) availability. Works seamlessly even when the vehicle is remote or behind cellular/NAT connections.
- **Instrument Cluster Notifications (`notify`)**: Send arbitrary notifications, warnings, and alerts directly into the vehicle's instrument cluster track popup display using ISO-TP.
- **Lean Edge Device**: The ESP32 does not need to store or parse the 127 kB master catalog. It executes lightweight raw CAN action bursts and streams state transitions for monitored CAN IDs.
- **Full Domain Support**:
  - `notify`: Cluster OSD popups & toast notifications
  - `climate`: Driver and passenger cabin target temperature controls (0.5°C increments)
  - `switch`: Heated steering wheel, defrost, comfort toggles
  - `button`: Momentary pulses, climate sync toggle, wake pings
  - `select`: Multi-state options (drive modes, sound stage focus, comfort levels)
  - `sensor`: Road speed, gear selector (PRND), high-voltage battery SOC & temperatures
  - `binary_sensor`: Door locks, tailgate opening, hands-on detection (HOD)
  - `event`: Steering wheel buttons (Star button, Mode button, paddles)
  - `lock`: Door lock and unlock controls
  - `number`: Audio balance and fader controls
  - `light`: Ambient mood lighting controls
- **Native Enable / Disable**: All vehicle entities are registered in Home Assistant's Entity Registry, allowing you to easily disable any features your trim does not have.

---

## 🚀 Installation

### Via HACS (Recommended)
1. In Home Assistant, open **HACS** -> **Integrations**.
2. Click the top right three dots -> **Custom repositories**.
3. Add `https://github.com/SuperSuave/can-do` with category **Integration**.
4. Click **Download** and restart Home Assistant.

### Manual Installation
1. Copy the `custom_components/can_do` folder to your Home Assistant's `config/custom_components/` directory:
   ```bash
   cp -r custom_components/can_do /config/custom_components/
   ```
2. Restart Home Assistant.
3. Go to **Settings -> Devices & Services -> Add Integration** and search for **CAN Do**.
4. Configure your device:
   - **Device ID**: Enter your device ID (e.g. `can-do-c2f4`).
   - **Vehicle Model**: Choose your vehicle from the dropdown (e.g. `Hyundai Ioniq 5 Limited [US]`, `Kia EV6 GT-Line`, etc.).
   - **Base Topic**: Default is `cando`.

---

## 💬 Sending Cluster Notifications

You can send custom messages to your car's cluster from any Home Assistant automation, script, or Developer Tools:

```yaml
service: notify.send_message
target:
  entity_id: notify.can_do_c2f4_instrument_cluster_notification
data:
  message: "Charge Complete!"
  data:
    level: "info" # Options: "info", "warning", "error"
```

---

## 📡 MQTT Topic Contract

| Direction | Topic | Payload | Description |
|---|---|---|---|
| ESP32 -> HA | `cando/{device_id}/status` | `"online"` / `"offline"` | Device availability (Retained, QoS 1 LWT) |
| ESP32 -> HA | `cando/{device_id}/state/0x{CAN_ID}` | `16-char hex` (e.g. `14010000C200F8FF`) | Broadcasted when a monitored CAN ID changes |
| HA -> ESP32 | `cando/{device_id}/notify` | `{"message": "...", "level": "info"}` | Triggers instrument cluster track popup |
| HA -> ESP32 | `cando/{device_id}/tx` | `{"can_id": "0x4A0", "delay_ms": 20, "steps": [...]}` | Executes raw CAN action burst |
| HA -> ESP32 | `cando/{device_id}/subscribe_ids` | `["0x448", "0x4ce", ...]` | Sets dynamic list of CAN IDs to monitor |
