# HKMC E-GMP CAN Bus & Protocol Engineering Reference

This document provides a comprehensive technical reference for the CAN bus signals, command payloads, and ISO-TP transport protocols decoded from Hyundai/Kia/Genesis E-GMP firmware (Kia EV6, Hyundai Ioniq 5, Ioniq 6, Genesis GV60) and implemented in the **CAN Do** system.

---

## 📑 Table of Contents
1. [Network Topology & Bus Layout](#1-network-topology--bus-layout)
2. [Power Windows & Body Control (`ALL_HU_CNTL_E_01`)](#2-power-windows--body-control-all_hu_cntl_e_01)
3. [Instrument Cluster Call & Alert Modal Popups](#3-instrument-cluster-call--alert-modal-popups)
4. [High Voltage Battery, Preconditioning & Charging](#4-high-voltage-battery-preconditioning--charging)
5. [HVAC, Climate Control & DATC](#5-hvac-climate-control--datc)
6. [Seats & Steering Wheel Comfort](#6-seats--steering-wheel-comfort)
7. [Doors, Access & Power Tailgate](#7-doors-access--power-tailgate)
8. [Ambient Mood Lighting (`MLM` DualLight RGB via ISO-TP)](#8-ambient-mood-lighting-mlm-duallight-rgb-via-iso-tp)
9. [Transmission & Shifter State](#9-transmission--shifter-state)

---

## 1. Network Topology & Bus Layout

E-GMP vehicles employ a segmented multi-bus architecture connected through a Central Gateway (CGW) / Integrated Central Control Unit (ICU):
* **C-CAN / B-CAN (Chassis & Body)**: Central gateway frames (`0x541`, `0x559`), body commands (`0x4A2`), power seats, door modules, lighting.
* **E-CAN / P-CAN (Powertrain & EV)**: VCU, BMS (`0x5D7`, `0x2AD`), Inverter/Motor controllers, OBC (`0x30E`).
* **M-CAN (Multimedia & Infotainment)**: Head unit (AVN), Instrument Cluster (CLU), telematics unit (TMU2 / `0x588`), HUD.

Diagnostic & Multi-Frame ISO-TP communication operates via physical request IDs (`0x7A0`–`0x7DF`) and flow-control response IDs (`0x7A8`–`0x7E8`).

---

## 2. Power Windows & Body Control (`ALL_HU_CNTL_E_01`)

Individual and global power window control is executed through the body command frame on **CAN ID `0x4A2`** (or TMU2 **`0x588`**), corresponding to function `ALL_HU_CNTL_E_01` (Function `0x15` in `BODY.Bcan.TE_TX_IL`).

### 2.1 Action Command Structure (`0x4A2`)

| Byte Index | 1-Based (Catalog) | Name | Description / Valid Values |
| :---: | :---: | :--- | :--- |
| `0` | `D1` | **Command ID** | Always `0x15` (`ALL_HU_CNTL_E_01`) |
| `1` | `D2` | **Driver Window** | `0x05`=Close, `0x06`=Open, `0x04`=Vent, `0x0F`=Ignore |
| `2` | `D3` | **Passenger Window** | `0x05`=Close, `0x06`=Open, `0x04`=Vent, `0x0F`=Ignore |
| `3` | `D4` | **IMS Memory Recall** | **`0x07`** (Ignore IMS recall), `0x01` (Profile 1), `0x02` (Profile 2) |
| `4` | `D5` | **Rear Left Window** | `0x05`=Close, `0x06`=Open, `0x04`=Vent, `0x0F`=Ignore |
| `5` | `D6` | **Rear Right Window** | `0x05`=Close, `0x06`=Open, `0x04`=Vent, `0x0F`=Ignore |
| `6` | `D7` | **Reserved** | `0x00` |
| `7` | `D8` | **Reserved** | `0x00` |

> [!NOTE]
> Setting Byte 3 (IMS) to **`0x07`** is critical: it prevents unintended seat, steering column, and side mirror motorized movement when sending window adjustment commands.

#### Example Command Payloads:
* **Roll Down Driver Window Only**: `15 06 0F 07 0F 0F 00 00`
* **Roll Up Driver Window Only**: `15 05 0F 07 0F 0F 00 00`
* **Vent All 4 Windows**: `15 04 04 07 04 04 00 00`
* **Global Close (Roll Up All 4 Windows)**: `15 05 05 07 05 05 00 00`
* **Global Open (Roll Down All 4 Windows)**: `15 06 06 07 06 06 00 00`
* **Front Windows Only (Open Fronts, Leave Rears)**: `15 06 06 07 0F 0F 00 00`

---

### 2.2 Live Window Telemetry (`0x559` CGW4)

The Central Gateway broadcasts open/closed window status on **CAN ID `0x559` (`CGW4`)**, located in **Byte 1 (`D2` in 1-based notation)**:

| Signal Name | Bit (Global) | Byte `D2` Bit | Mask | Values |
| :--- | :---: | :---: | :---: | :--- |
| `CF_Gway_DrvWdwStat` | Bit 8 | Bit 0 | `0x01` | `0` = Closed, `1` = Open / Venting |
| `CF_Gway_RLWdwState` | Bit 9 | Bit 1 | `0x02` | `0` = Closed, `1` = Open / Venting |
| `CF_Gway_RRWdwState` | Bit 10 | Bit 2 | `0x04` | `0` = Closed, `1` = Open / Venting |
| `CF_Gway_AstWdwStat` | Bit 11 | Bit 3 | `0x08` | `0` = Closed, `1` = Open / Venting |
| **All Windows Group** | Bits 8–11 | Bits 0–3 | `0x0F` | `0x00` = All Closed, `0x0F` = All Open |

---

## 3. Instrument Cluster Call & Alert Modal Popups

The instrument cluster supports high-priority alert dialogs via the handsfree / telematics channel. This enables Home Assistant or CAN Do to pop up notification modals (with audio beeps) directly in the driver's display.

### 3.1 Architecture & CAN Protocol
```
[CAN Do / HA] ───(Trigger: 0x52A / 0x4CE)───► [Instrument Cluster] (Modal Opens)
              ───(ISO-TP: 0x6D4 / 0x6B4)────► [Instrument Cluster] (UTF-16LE Text Rendered)
              ───(Hold Duration: 5000ms)────► [Driver View]
              ───(Dismiss: 0x10, 0x03)─────► [Instrument Cluster] (Modal Closed Cleanly)
```

1. **Trigger Phase**:
   * Broadcast 3 pulses of `{ 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 }` spaced 10ms apart on **CAN ID `0x52A`** (telematics incoming alert) and **`0x4CE`** (media/bluetooth fallback).
   * 5ms settle delay before text transmission.
2. **Text Payload Transport (ISO 15765-2)**:
   * **TX CAN ID**: `0x6D4`
   * **Flow Control Response ID**: `0x6B4`
   * **Encoding**: UTF-16LE without BOM.
   * **Format**: `Caller/Title
Message Body`. The newline (`0x000A`) creates the visual split between the header banner and the message body on the cluster.
3. **Clean Dismissal**:
   * Send `{ 0x10, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 }` on `0x52A` and `{ 0x10, 0x00, ... }` on `0x4CE` to dismiss the modal cleanly.
4. **Bridge Filtering**:
   * While the modal is active, the bridge filter suppresses factory head unit frames on `0x52A` and `0x6D4` towards the cluster, and blocks flow control `0x6B4` towards the head unit.

---

## 4. High Voltage Battery, Preconditioning & Charging

### 4.1 Manual Battery Preconditioning
Unlike the factory infotainment system which requires setting a fast charger in the factory navigation, CAN Do triggers preconditioning directly via the Battery Management Unit (BMU).

* **Trigger Frame**: **CAN ID `0x0C7`**
  * Byte 3 (`D4`): `0x40` (On) / `0x00` (Off)
  * Byte 4 (`D5`): `0x03` (On) / `0x00` (Off)
* **Telemetry Status**: **CAN ID `0x2AD` (`BMS_Precond_Status`)**
  * Byte 1 (`D2`):
    * `0x41` (65): Off / Inactive
    * `0x45` (69): Preparing / Conditioning
    * `0x55` (85): On / Active Heating

### 4.2 Live Charging Power Sensor
* **CAN ID**: **`0x30E` (`Charging_Power`)**
* **Signal**: Byte 6 (`D7`): Direct charging power in **kW** (`0`–`255` kW).
* Valid for both AC Level 2 and DC Fast Charging.

### 4.3 AC / DC Target Charge Limits
* **CAN ID**: **`0x4C5` (`Charge_Limit_Control`)**
* **Factor**: 0.5 (Raw = Limit% $	imes$ 2)
  * Byte 4 (`D5`): AC Target Limit (`0x64`=50%, `0x78`=60%, `0x8C`=70%, `0xA0`=80%, `0xB4`=90%, `0xC8`=100%)
  * Byte 5 (`D6`): DC Fast Charge Target Limit

### 4.4 High Voltage Battery Module Temperatures
* **CAN ID**: **`0x5D7` (`BMS`)**
* **Offset**: $-40^\circ	ext{C}$
  * Byte 1 (`D2`): Highest Battery Module Temp (`Temp = raw - 40`)
  * Byte 2 (`D3`): Lowest Battery Module Temp (`Temp = raw - 40`)

---

## 5. HVAC, Climate Control & DATC

### 5.1 Direct Head Unit DATC Frame
* **CAN ID**: **`0x520`** (or **`0x5A0`**)
* When broadcast alongside the Cluster keep-alive frame (**`0x4F1`**), the vehicle VCU automatically engages high-voltage contactors and runs the electric A/C compressor and PTC cabin heater while parked.
  * Byte 0 (`D1`): `0x01` (Enable HVAC)
  * Byte 1 (`D2`): Target Temp in $0.5^\circ	ext{C}$ increments (`raw = Temp_C * 2`)
    * `68°F` ($20.0^\circ	ext{C}$): `0x28`
    * `70°F` ($21.0^\circ	ext{C}$): `0x2A`
    * `72°F` ($22.0^\circ	ext{C}$): `0x2C`
    * `74°F` ($23.5^\circ	ext{C}$): `0x2F`
    * `76°F` ($24.5^\circ	ext{C}$): `0x31`
  * Byte 2 (`D3`): `0x04` (Blower & Auto mode)
  * Byte 3 (`D4`): `0x01` (Vent airflow distribution)

### 5.2 Displayed Target Temperature Sensor
* **CAN ID**: **`0x5F5` (`DATC1`)**
  * Byte 2 (`D3`): Driver Displayed Temp in integer Fahrenheit (`0x44` = 68°F, `0x48` = 72°F)
  * Byte 1 (`D2`): Driver Displayed Temp in $0.5^\circ	ext{C}$ resolution

### 5.3 Driver-Only Zone Toggle
* **CAN ID**: **`0x465` (`Climate_Button_Status`)**
  * Byte 6 (`D7`): `0x04` (Driver Only Active / On), `0x0C` (Driver Only Inactive / Off). Isolates airflow to the driver's side to conserve high-voltage battery when driving solo.
  * *Note*: Can also receive direct DATC injection via frame `0x41D` (`HU_DATC_DrvOnlySet`, Byte 4 `D5`: `0x0D`=On, `0x0C`=Off).

---

## 6. Seats & Steering Wheel Comfort

### 6.1 Individual Seat Ventilation & Heating (`0x4A2`)
* **CAN ID**: `0x4A2`, Byte 4 (`D5`)
  * High Nibble (`0xF0`): Driver Seat
  * Low Nibble (`0x0F`): Front Passenger Seat
  * Values:
    * `0x2`: Clear / Off
    * `0x3`: Vent Level 1 (Low)
    * `0x4`: Vent Level 2 (Medium)
    * `0x5`: Vent Level 3 (High)
    * `0xF`: Idle / No Change

### 6.2 Synchronized Comfort Profiles (`0x4F2`)
Sends unified commands to driver seat warmer, passenger seat warmer, and heated steering wheel simultaneously:
* **All Warmers Off**: `02 FF FF FF 03 00 00 00`
* **Driver Heat Level 2 + Wheel On**: `02 FF CD FF 03 01 00 00`
* **Both Front Seats Level 2 + Wheel On**: `02 FF DD FF 03 01 00 00`

### 6.3 Heated Steering Wheel Telemetry
* **CAN ID**: **`0x559` (`CGW4`)**
  * Byte 0 (`D1`), Bit 4 (`mask = 0x10`): `0` = Off, `1` = Heated Steering Wheel Active.

### 6.4 Rear Defogger & Mirror Heaters Telemetry
* **CAN ID**: **`0x541` (`CGW1`)**
  * Byte 4 (`D5`), Bit 4 (`mask = 0x10`): `0` = Off, `1` = Rear Defogger / Heated Side Mirrors Active.

---

## 7. Doors, Access & Power Tailgate

### 7.1 Remote Tailgate Control
* **Command ID**: **`0x588` (`TMU2`)**
  * Open Tailgate: `01 00`
  * Close Tailgate: `02 00`
* **Position Telemetry**: **`0x3A6` (`PTGM_01`)**
  * Byte 0 (`D1`), Mask `0x0F`: `0x01` = Open, `0x02` = Closed.

### 7.2 Door Switches & Lock Status (`0x541` CGW1)
* **CAN ID**: **`0x541`**
  * Driver Door Switch: Byte 1 (`D2`), Bits 0–1
  * Passenger Door Switch: Byte 4 (`D5`), Bit 3
  * Sunroof Glass State: Byte 7 (`D8`), Bit 1 (`0` = Closed, `1` = Open)

---

## 8. Ambient Mood Lighting (`MLM` DualLight RGB via ISO-TP)

Ambient lighting in E-GMP vehicles uses multi-frame ISO-TP transport over physical diagnostic addressing to the BCM/ICU gateway.

* **Physical Request ID**: `0x7A0`
* **Flow Control Response ID**: `0x7A8`

### Payload Formats:
* **9-Byte RGB Control**:
  * Byte 0: `0x64` (`MLMALL` command)
  * Bytes 1–2: 16-bit Red level (big-endian)
  * Bytes 3–4: 16-bit Green level (big-endian)
  * Bytes 5–6: 16-bit Blue level (big-endian)
  * Byte 7: Animation Mode (`0x00`=Off, `0x01`=Normal, `0x02`=Welcome, `0x03`=DriveMode Sync)
  * Byte 8: Reserved (`0x00`)

---

## 9. Transmission & Shifter State

E-GMP Rotary Shift-by-Wire (SBW) status:
* **CAN ID**: **`0x45`** (Primary) or **`0x70`** (Secondary)
  * Byte 5 (`D6` on `0x45`) / Byte 7 (`D8` on `0x70`), Mask `0x70`:
    * `0x00`: **Park (P)**
    * `0x50`: **Drive (D)**
    * `0x60`: **Neutral (N)**
    * `0x70`: **Reverse (R)**

---

## 10. Instrument Cluster Brightness Button Injection

Physical or automated injection of dash illumination level stepping:
* **CAN ID**: **`0x474` (`Cluster_Brightness_Button`)**
  * Byte 7 (`D8`):
    * `0x0A`: **Idle / Released**
    * `0x4A`: **Brightness Up (+)**
    * `0x8A`: **Brightness Down (-)**
  * *Automation Pattern*: Send 3 repeats of the active pulse (`0x4A` or `0x8A`) at 20ms interval followed by 2 repeats of `0x0A` to emulate a clean momentary button click.
