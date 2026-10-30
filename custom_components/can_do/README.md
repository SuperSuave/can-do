# CAN Do — Home Assistant Custom Integration

The **CAN Do** Home Assistant integration connects your vehicle's ESP32 **CAN Do** controller to Home Assistant. It reads entity definitions directly from `can_do_catalog.json` (`catalog_loader.py`) and exposes rich vehicle telemetry, controls, notifications, and diagnostic services under a unified Home Assistant device.

---

## ✨ Supported Platforms & Entities

All entities are dynamically generated and mapped from the single-source-of-truth catalog:

* **Binary Sensors (`binary_sensor.py`)**: Doors, trunk/frunk, hood, lock states, seatbelts, brake pedal, charging status, and preconditioning indicators.
* **Sensors (`sensor.py`)**: SOC, HV battery temperatures, tire pressures/temperatures, odometer, speed, 12V auxiliary battery voltage (`vbat_sensor`), and gear selection.
* **Climate (`climate.py`)**: Cabin HVAC controls and remote climate presets.
* **Covers (`cover.py`)**: Windows, sunroof/sunshade, charge port door, and tailgate.
* **Locks (`lock.py`)**: Central door lock/unlock control.
* **Switches (`switch.py`)**: Battery preconditioning toggle, seat heaters/ventilation, steering wheel heater, and automation enable/disable toggles.
* **Buttons (`button.py`)**: One-shot CAN actions, wake pulses, horn/flash, and chime triggers.
* **Lights (`light.py`)**: Interior ambient lighting color, brightness, and dynamic animation modes (`ambient_anim`).
* **Numbers & Selects (`number.py`, `select.py`)**: Target charge limits, drive modes, regenerative braking levels, and configurable thresholds.
* **Events (`event.py`)**: Steering wheel and console button press events (single, double, long press).
* **Notifications (`notify.py`)**: Send custom text popups (`track_popup`), HUD navigation prompts (`hud_nav`), and audible chimes (`beep`) directly to the vehicle's instrument cluster / infotainment screen.

---

## 📦 Installation

### Option 1: HACS (Recommended)
1. Open **HACS** in Home Assistant -> **Integrations**.
2. Click the three-dot menu in the top right and select **Custom repositories**.
3. Enter `https://github.com/SuperSuave/can-do` and select **Integration** as the category.
4. Click **Download** on the **CAN Do** integration.
5. Restart Home Assistant.

### Option 2: Manual Installation
1. Copy the `custom_components/can_do` folder into your Home Assistant `<config>/custom_components/` directory.
2. Restart Home Assistant.

---

## ⚙️ Configuration

1. Go to **Settings** -> **Devices & Services** -> **Add Integration**.
2. Search for **CAN Do** and follow the configuration flow (`config_flow.py`) to connect to your CAN Do device / MQTT broker.

---

## 📊 Sample Dashboard & Automations

This directory includes ready-to-use templates to jumpstart your setup:
* **`lovelace_dashboard.yaml`**: A pre-built Lovelace dashboard layout for monitoring E-GMP battery temperatures, preconditioning state, doors/windows, and climate controls.
* **`sample_automations.yaml`**: Example Home Assistant automations demonstrating how to trigger vehicle actions, send infotainment track popup notifications, and react to CAN button events.
* **`services.yaml`**: Custom `can_do.*` service definitions for raw/catalog command execution and vehicle notifications.