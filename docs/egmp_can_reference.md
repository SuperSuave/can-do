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
8. [Ambient Mood Lighting (Native M-CAN 2-Stage Sequence on `0x4AD`)](#8-ambient-mood-lighting-native-m-can-2-stage-sequence-on-0x4ad)
9. [Transmission & Shifter State](#9-transmission--shifter-state)
10. [Instrument Cluster Rheostat & Backlight Synchronization (`0x474`)](#10-instrument-cluster-rheostat--backlight-synchronization-0x474)
11. [Infotainment User Settings Menus (`HU_USM_E_02` on `0x542`)](#11-infotainment-user-settings-menus-hu_usm_e_02-on-0x542)
12. [External Audio DSP Amplifier (`HU_AMP_E_01` on `0x60C` / `0x520`)](#12-external-audio-dsp-amplifier-hu_amp_e_01-on-0x60c--0x520)
13. [Central Gateway Body State, EV Controls & Power Supervision (`0x410` / `0x541` / `0x559`)](#13-central-gateway-body-state-ev-controls--power-supervision-0x410--0x541--0x559)
14. [Cockpit Physical Controls & Steering Wheel Switches (`0x4A2` / `0x448` / `0x651` / `0x1CF`)](#14-cockpit-physical-controls--steering-wheel-switches-0x4a2--0x448--0x651--0x1cf)
15. [Virtual Engine Sound System (VESS) & Pedestrian Acoustic Alert (`0x387` / `0x410`)](#15-virtual-engine-sound-system-vess--pedestrian-acoustic-alert-0x387--0x410)
16. [Navigation, Head-Up Display & TPEG Guidance (`0x386` / `HUD_01`)](#16-navigation-head-up-display--tpeg-guidance-0x386--hud_01)
17. [Unified Diagnostic Services (UDS) & Firmware Flashing (`0x7DF` / `0x7EC` / `0x7E4`)](#17-unified-diagnostic-services-uds--firmware-flashing-0x7df--0x7ec--0x7e4)
18. [Tire Pressure Monitoring System (TPMS) & Wheel Speed Dynamics (`0x593` / `0x4B0` / `0x4B1`)](#18-tire-pressure-monitoring-system-tpms--wheel-speed-dynamics-0x593--0x4b0--0x4b1)
19. [Electronic Parking Brake (EPB), Auto Hold & Braking Dynamics (`0x490` / `0x47F` / `0x220` / `0x412`)](#19-electronic-parking-brake-epb-auto-hold--braking-dynamics-0x490--0x47f--0x220--0x412)
20. [Advanced Driver Assistance Systems (ADAS), Smart Cruise & Smart Summon (`0x38C` / `0x420` / `0x421` / `0x38D` / `0x203`)](#20-advanced-driver-assistance-systems-adas-smart-cruise--smart-summon-0x38c--0x420--0x421--0x38d--0x203)
21. [Blind-Spot Collision-Avoidance Assist (BCA), Rear Cross-Traffic & Safe Exit Assist (`0x1BA` / `0x391` / `0x393`)](#21-blind-spot-collision-avoidance-assist-bca-rear-cross-traffic--safe-exit-assist-0x1ba--0x391--0x393)
22. [Surround View Monitor (SVM), Parking Distance Warning (PDW) & Camera Video Multiplexing (`0x476` / `0x477` / `0x436` / `0x434`)](#22-surround-view-monitor-svm-parking-distance-warning-pdw--camera-video-multiplexing-0x476--0x477--0x436--0x434)
23. [Vehicle-to-Load (V2L) & Bi-Directional Power Export (`0x578` / `0x5D0` / `0x598` / `0x4F0`)](#23-vehicle-to-load-v2l--bi-directional-power-export-0x578--0x5d0--0x598--0x4f0)
24. [Active Air Flaps (AAF) & Thermal Aerodynamics (`0x584`)](#24-active-air-flaps-aaf--thermal-aerodynamics-0x584)

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

## 3. Instrument Cluster OSD Track & Alert Banner Popups

The Head Unit MICOM pushes media metadata, navigation turn-by-turn prompts, incoming call dialogs, and alert banners to the digital instrument cluster over M-CAN via **`All_HU_CLU_PE_01`/`06`** and **`cluster_track_popup_message`**.

```
[CAN Do / Head Unit]
       │
       ├──── Step 1: 0x4CE Trigger Frame (3x @ 10 ms) ────────► [Instrument Cluster]
       │     (Payload: [media_type, 0x11, 00, 00, 00, 00, 00, 00])   (Opens OSD Card)
       │
       ├──── Step 2: ISO 15765-2 ISO-TP Text (0x6E0) ────────► [Instrument Cluster]
       │     (Payload: UTF-16LE Title / Notification String)   (Renders Custom Text)
       │
       ◄──── Step 3: Flow Control (0x6BE: 30 00 00 00...) ────── [Instrument Cluster]
```

### 3.1 Step 1: Trigger Frame Specification (`0x4CE` / `HU_DATC_MediaSource`)

* **CAN ID**: `0x4CE` (Standard 11-bit ID `1230` dec)
* **Bus**: M-CAN
* **DLC**: 8 bytes
* **Transmission Pattern**: 3 repeats @ 10 ms interval immediately prior to ISO-TP text stream.

#### Signal Layout:
| Byte Index | 1-Based | Signal Name | Description / Valid Values |
| :---: | :---: | :--- | :--- |
| `0` | `D1` | `CF_Hu_MediaType` | Active media transport category:<br>`0x04`: General Apps / Sounds of Nature (Default fallback, pairs with `0x6E0`)<br>`0x10`: Bluetooth Audio (pairs with `0x6D4`)<br>`0x22`: AM/FM Radio (pairs with `0x6DC`)<br>`0x62`: SiriusXM Satellite Radio (pairs with `0x6EC`)<br>`0xC4`: USB Flash Audio (pairs with `0x6EA`)<br>`0xDC`: Apple CarPlay (pairs with `0x6D6`)<br>`0xDE`: Android Auto (pairs with `0x6D2`) |
| `1` | `D2` | `CF_Hu_MediaPulse` | **`0x11`**: High-priority track change / OSD popup notification pulse |
| `2`–`7` | `D3`–`D8` | Reserved | `0x00 0x00 0x00 0x00 0x00 0x00` |

---

### 3.2 Step 2: Text Transport Specification (`0x6E0` via ISO 15765-2)

* **TX CAN ID**: **`0x6E0`** (Default Apps transport; or active media paired ID from table below)
* **Flow Control CAN ID**: **`0x6BE`** (Cluster acknowledgment)
* **Character Encoding**: **UTF-16LE** (2 bytes per character, little-endian)
* **Maximum Length**: 64 UTF-16 code units (128 bytes)

#### Paired Transport Identifiers:
| Media Source (`0x4CE` D1) | ISO-TP TX CAN ID | Cluster Flow Control CAN ID |
| :--- | :---: | :---: |
| **Apps / Fallback (`0x04`)** | **`0x6E0`** | **`0x6BE`** |
| **Bluetooth Audio (`0x10`)** | `0x6D4` | `0x6B4` |
| **Radio Tuner (`0x22`)** | `0x6DC` | `0x6BB` |
| **SiriusXM (`0x62`)** | `0x6EC` | `0x6CA` |
| **USB Media (`0xC4`)** | `0x6EA` | `0x6C8` |
| **Apple CarPlay (`0xDC`)** | `0x6D6` | `0x6B6` |
| **Android Auto (`0xDE`)** | `0x6D2` | `0x6B2` |

---

### 3.3 Valid Example Message Payloads:

#### 1. Short Single-Frame Notification: "Pre-Heat" (UTF-16LE: 8 chars = 16 bytes)
* **Step 1 (Trigger)**:
  `04 11 00 00 00 00 00 00` on CAN ID `0x4CE` (3 repeats @ 10 ms)
* **Step 2 (First Frame on `0x6E0`)**:
  `10 10 50 00 72 00 65 00` (First Frame: 16 bytes total; 'P', 'r', 'e')
* **Step 3 (Cluster Flow Control on `0x6BE`)**:
  `30 00 00 00 00 00 00 00` (Clear to send, BS=0, ST=0)
* **Step 4 (Consecutive Frame on `0x6E0`)**:
  `21 2D 00 48 00 65 00 61` (CF 1: '-', 'H', 'e', 'a')
* **Step 5 (Consecutive Frame on `0x6E0`)**:
  `22 74 00 00 00 00 00 00` (CF 2: 't', null terminator)

#### 2. Verified In-Vehicle Toast Notifications:
| Notification Label | Trigger (`0x4CE`) | ISO-TP Target | Rendered Display Text |
| :--- | :---: | :---: | :--- |
| **Preconditioning Active** | `04 11 00 00 00 00 00 00` | `0x6E0` | ⓘ Preconditioning Active |
| **Battery Cold / Limited** | `04 11 00 00 00 00 00 00` | `0x6E0` | ⚠ Battery Cold / Limited |
| **Charge Interrupted** | `04 11 00 00 00 00 00 00` | `0x6E0` | ‼ Charge Interrupted |
| **Seat Comfort Auto-Set** | `04 11 00 00 00 00 00 00` | `0x6E0` | ⓘ Seat Comfort Set |
| **Tailgate Open Warning** | `04 11 00 00 00 00 00 00` | `0x6E0` | ⚠ Tailgate Open |

> [!NOTE]
> Frame **`0x52A` (`CLU15`)** is strictly an **output telemetry broadcast** from the instrument cluster carrying vehicle speed, odometer, and gear selector status; the cluster firmware ignores incoming command injections on `0x52A`. Verified on-screen dialogs rely exclusively on `0x4CE` + `0x6E0`.

---

## 4. High Voltage Battery, Preconditioning & Charging

E-GMP's 800V high-voltage battery architecture integrates the Battery Management Unit (BMU), On-Board Charger (OBC), and Integrated Center Control Unit (ICCU) with the Infotainment EV subsystems.

---

### 4.1 Manual & Navigation Battery Preconditioning (`0x0C7` / `0x4ED` / `0x2AD`)

To achieve peak 800V DC fast-charging speeds (up to 240 kW), the traction battery cells must be preheated to $\ge 21^\circ\text{C}$ ($70^\circ\text{F}$).

1. **Manual / Automation Trigger Frame (`0x0C7`)**:
   * **CAN ID**: `0x0C7` (B-CAN / E-CAN, DLC: 8)
   * Byte 3 (`D4`): `0x40` (Preconditioning Request ON) / `0x00` (OFF)
   * Byte 4 (`D5`): `0x03` (Control Subtype Latch) / `0x00` (Release)
   * **Active Payload**: `00 00 00 40 03 00 00 00` (Sent in 3 repeats at 20 ms)
   * **Idle Payload**: `00 00 00 00 00 00 00 00`

2. **Infotainment Navigation Preconditioning Status (`0x4ED` / `AVN_Precond_Status`)**:
   * Broadcast by the Head Unit when a DC fast charger is set as destination:
   * Bytes `D6`–`D7`: 16-bit distance to fast charger (in decameters / meters).
   * Byte `D8`: Preconditioning activation request: `0x01` = Active, `0x00` = Inactive.

3. **Telemetry Feedback (`0x2AD` / `BMU_Precond_Status`)**:
   * Broadcast by BMU at 100 ms:
   * Byte 1 (`D2` in 1-based indexing), Mask `0x1F`:
     * `0x01`: **Preconditioning Off / Idle** (Coolant heater disabled)
     * `0x05`: **Preparing / Handshake** (Circulation pump starting)
     * `0x09` / `0x55`: **Active Conditioning** (High-voltage PTC coolant heater energized)
     * `0x11`: **Target Temperature Reached** (Cells $\ge 21^\circ\text{C}$, maximum 800V charge rate unlocked)

---

### 4.2 Live Charging Power Telemetry (`0x30E` / `OBC_01`)

The On-Board Charger (OBC) and BMS broadcast the instantaneous net charging power in integer kilowatts on CAN ID **`0x30E`** at 100 ms (DLC: 8):
* **Signal**: Byte 6 (`D7` in 1-based indexing, unsigned 8-bit integer):
  $$\text{Power (kW)} = \text{Byte } D7$$
* Directly reports live charging rate from `0` to `255` kW without requiring high-voltage Volts $\times$ Amps multiplication.

| Charging Scenario | Typical Power | Payload (`0x30E`) | Description |
| :--- | :---: | :---: | :--- |
| **Not Charging / Standby** | 0 kW | `00 00 00 00 00 00 00 00` | No charging power flow |
| **Level 1 Trickle (120V / 12A)** | 1.4 kW | `00 00 00 00 00 00 01 00` | Portable emergency cordset |
| **Level 2 AC (240V / 48A)** | 11 kW | `00 00 00 00 00 00 0B 00` | Home wallbox / 48A commercial AC |
| **50 kW Commercial DCFC** | 48 kW | `00 00 00 00 00 00 30 00` | Standard urban DC fast charger |
| **150 kW DC Fast Charger** | 148 kW | `00 00 00 00 00 00 94 00` | High-power CCS DC station |
| **350 kW / 800V Peak Curve** | 235 kW | `00 00 00 00 00 00 EB 00` | E-GMP maximum 800V charge acceptance |

---

### 4.3 EV Charging Status, Power Source & Remaining Time (`0x594` / `0x595` / `0x597`)

1. **Plugged In & Active Charging State (`0x594` / `BMS1`)**:
   * Byte 1 (`D2`), Bit 1 (`mask = 0x02`): `CF_Bms_ChsSts`
     * `0x02`: Charging In Progress
     * `0x00`: Not Charging / Disconnected
2. **Charging Power Source & Protocol (`0x595` / `BMS2`)**:
   * Byte 0 (`D1`):
     * Bit 1 (`0x02`): Standard Level 2 AC Charging (208V–240V)
     * Bit 2 (`0x04`): DC Fast Charging (CCS / 800V DCFC)
     * Bit 3 (`0x08`): Level 1 Portable AC Charging (120V)
3. **Remaining Charging Time to Target Limit (`0x597` / `BMS3`)**:
   * **AC Level 2 Remaining Time**: Bytes `D2`–`D3` (16-bit uint, minutes):
     $$\text{Minutes} = D2 \mid (D3 \ll 8)$$
     * Value `0xFFFF` (65535) indicates inactive / not AC charging.
   * **DC Fast Charge Remaining Time**: Bytes `D4`–`D5` (16-bit uint, minutes):
     $$\text{Minutes} = D4 \mid (D5 \ll 8)$$
     * Value `0xFFFF` (65535) indicates inactive / not DC charging.

---

### 4.4 AC / DC Target Charge Limits (`0x4C5` / `Charge_Limit_Control`)

The Head Unit EV settings screen configures target state-of-charge limits (50% to 100% in 10% increments) on CAN ID **`0x4C5`**:
* **Factor**: $0.5$ (Encoding formula: $\text{Raw} = \text{Limit\%} \times 2$)
* **Byte 4 (`D5`)**: AC Target Charge Limit
* **Byte 5 (`D6`)**: DC Fast Charge Target Limit

| Limit Percentage | Encoded Value (Hex) | Encoded Value (Dec) |
| :---: | :---: | :---: |
| **50%** | `0x64` | 100 |
| **60%** | `0x78` | 120 |
| **70%** | `0x8C` | 140 |
| **80%** (Factory Recommended) | `0xA0` | 160 |
| **90%** | `0xB4` | 180 |
| **100%** | `0xC8` | 200 |

* **Example Payload (AC 80% / DC 100%)**: `00 00 00 00 A0 C8 00 00`
* **Example Payload (AC 100% / DC 80%)**: `00 00 00 00 C8 A0 00 00`

---

### 4.5 High Voltage Battery Module Extremes & Temperatures (`0x5D7` / `BMS`)

The BMS broadcasts pack thermal health across all battery cell modules on CAN ID **`0x5D7`** at 100 ms (DLC: 8):
* **Byte 0 (`D1`)**: `CR_Bms_BatMaxTemp_C` (Highest Battery Module Temperature)
* **Byte 1 (`D2`)**: `CR_Bms_BatMinTemp_C` (Lowest Battery Module Temperature)
* **Temperature Offset**: $-40^\circ\text{C}$
  $$\text{Temperature } (^\circ\text{C}) = \text{Raw Byte} - 40$$

| Temperature State | Raw Byte (Hex) | Raw Value (Dec) | Decoded Temp ($^\circ\text{C}$) | Decoded Temp ($^\circ\text{F}$) |
| :--- | :---: | :---: | :---: | :---: |
| **Severely Cold Battery** | `0x1E` | 30 | $-10^\circ\text{C}$ | $14^\circ\text{F}$ |
| **Cold Battery (Needs Preconditioning)** | `0x32` | 50 | $+10^\circ\text{C}$ | $50^\circ\text{F}$ |
| **Preconditioning Target Reached** | `0x3D` | 61 | $+21^\circ\text{C}$ | $70^\circ\text{F}$ |
| **Optimal Warm Battery** | `0x46` | 70 | $+30^\circ\text{C}$ | $86^\circ\text{F}$ |
| **High Battery Warning** | `0x55` | 85 | $+45^\circ\text{C}$ | $113^\circ\text{F}$ |

* **Example Payload (Cold Pack: Min 10°C, Max 12°C)**: `34 32 00 00 00 00 00 00`
* **Example Payload (Conditioned Pack: Min 21°C, Max 23°C)**: `3F 3D 00 00 00 00 00 00`

---

### 4.6 Vehicle-to-Load (V2L) Minimum Discharge Threshold (`0x0C7` / `0x151`)

Controls the minimum traction battery state-of-charge percentage reserved before the Vehicle-to-Load bidirectional 120V/240V inverter automatically cuts off:
* **Command ID (`0x0C7`)**:
  * Byte 1 (`D2`): Scaled percentage value (`raw = percent * 2`):
    * `20%`: `0x28`
    * `30%`: `0x3C`
    * `40%`: `0x50`
    * `50%`: `0x64`
    * `60%`: `0x78`
    * `70%`: `0x8C`
    * `80%`: `0xA0`
  * **Transmission Protocol**: Send 3 repeats of the target command byte at 20ms intervals followed by 3 repeats of `0xFF` latch frame.
* **Telemetry State (`0x151`)**:
  * Byte 6 (`D7`): Active V2L cutoff limit percentage matching command scale (`0x28`=20%, `0x3C`=30%, `0x50`=40%, `0x64`=50%, `0x78`=60%, `0x8C`=70%, `0xA0`=80%).


## 5. HVAC, Remote Climate Control & DATC

### 5.1 Remote Climate Activation via Telematics Unit (`TMU_01_200ms` on `0x39B`)

Remote climate preconditioning is initiated and maintained over CAN ID **`0x39B` (`TMU_01_200ms`)**, which emulates the onboard Telematics Modem Unit (TMU / Kia Connect / Hyundai Bluelink).

```
[CAN Do / HA] ───(0x39B @ 5Hz, 200ms)─────────► [DATC / VCU] (Runs Compressor & PTC Heater)
              ───(0x7DF TesterPresent @ 2Hz)──► [CGW / ICU]  (Prevents Bus Sleep)
              ◄──(0x384 DATC Feedback)───────── [DATC]       (Byte D4 = 0x0A Active)
              ◄──(0x2AD / 0x2AE VCU Telemetry)─ [VCU]        (HV Contactors Closed)
```

> [!NOTE]
> Earlier reverse engineering notes occasionally confused CAN ID `0x520` with climate control. In verified E-GMP firmware, **`0x520`** is `AMP_HU_PE_01` (External Audio Amplifier DSP master volume and tone). The authentic remote climate execution frame is strictly **`0x39B`**.

#### Frame Specification: `0x39B` (DLC: 8, Periodic: 200 ms / 5 Hz)

| Byte Index | 1-Based (Catalog) | Bit(s) | Signal Name | Description / Scaling |
| :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | Bit 0 | `CF_Tmu_VehSld` | **`1`** = Active / Authorized subscription |
| `0` | `D1` | Bits 1–3 | Reserved | `0x0` |
| `0` | `D1` | Bit 4 | `CF_Tmu_AirconCtr` | **`1`** = Start / Run Remote Climate, **`0`** = Stop |
| `0` | `D1` | Bit 5 | `CF_Tmu_TempMd` | **`0`** = Celsius ($0.5^\circ\text{C}$ steps), **`1`** = Fahrenheit ($1^\circ\text{F}$) |
| `0` | `D1` | Bits 6–7 | `CF_Tmu_TempSet[1:0]` | Lower 2 bits of target temperature raw code |
| `1` | `D2` | Bits 0–5 | `CF_Tmu_TempSet[7:2]` | Upper 6 bits of target temperature raw code: $\text{code} = \text{round}(\text{Temp\_C} / 0.5)$ |
| `1` | `D2` | Bit 6 | `CF_Tmu_DefrostCtr` | **`1`** = Max Windshield Defrost Active, **`0`** = Normal Auto Mode |
| `1` | `D2` | Bit 7 | Reserved | `0` |
| `2`–`6` | `D3`–`D7` | All | Reserved / Aux | `0x00 0x00 0x00 0x00 0x00` |
| `7` | `D8` | Bits 0–3 | `CF_Tmu_AliveCnt1` | Rolling alive counter (`0` to `15` / `0x0`–`0xF`) |
| `7` | `D8` | Bits 4–7 | Reserved | `0x0` |

#### Temperature Encoding Table:
* **$20.0^\circ\text{C}$ / 68°F**: $\text{code} = 40$ (`0x28`): Byte `D1` = `0x11` (with aircon bit 4 & veh_sld bit 0), Byte `D2` = `0x0A`
* **$21.0^\circ\text{C}$ / 70°F**: $\text{code} = 42$ (`0x2A`): Byte `D1` = `0x91`, Byte `D2` = `0x0A`
* **$22.0^\circ\text{C}$ / 72°F**: $\text{code} = 44$ (`0x2C`): Byte `D1` = `0x11`, Byte `D2` = `0x0B`
* **$23.5^\circ\text{C}$ / 74°F**: $\text{code} = 47$ (`0x2F`): Byte `D1` = `0xD1`, Byte `D2` = `0x0B`

#### Keep-Alive & Shutdown Mechanics:
1. **Network Wake Keep-Alive**: Broadcast functional UDS `TesterPresent` (`0x07DF`: `02 3E 80 00 00 00 00 00`) every **500 ms** concurrently with `0x39B`. This keeps the Central Gateway awake and prevents the vehicle power management unit from going into sleep mode while parked.
2. **Clean Session Termination**: When stopping remote climate, transmit a burst of **5 release frames** (`CF_Tmu_AirconCtr = 0`, `CF_Tmu_DefrostCtr = 0`) spaced at **50 ms** intervals to guarantee the DATC and VCU release high-voltage contactors gracefully.

---

### 5.2 Live Remote Climate Telemetry & Execution State

The vehicle confirms active remote climate operation across multiple independent ECUs:

| CAN ID | Frame / ECU | Byte (1-Based) | Mask / Bits | Signal Name | Meaning / Active Value |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **`0x384`** | `DATC_07_200ms` | Byte `D4` | `0xFF` | `CF_Datc_RemtClimStat` | **`0x0A`** = Remote Climate Active, **`0x00`** = Inactive / Off |
| **`0x384`** | `DATC_07_200ms` | Byte `D1` | `0x0F` | `CF_Datc_BlowerSpeed` | Blower fan speed level (`1`–`8`, `0` = fan off) |
| **`0x02AD`**| `VCU_04_100ms_3`| Byte `D1` | Bits 2–3 | `CF_Vcu_AirconAct` | **`> 0`** = High-voltage A/C compressor / PTC heater running |
| **`0x02AE`**| `VCU_04_100ms_4`| Byte `D5` | Bits 6–7 | `CF_Vcu_HvContactStat` | **`> 0`** = High-voltage battery main contactors closed |
| **`0x5F5`** | `DATC1` | Byte `D2` | `0xFF` | `CR_Datc_DrTargetTempC`| Driver Displayed Target Temp in $0.5^\circ\text{C}$ steps |
| **`0x5F5`** | `DATC1` | Byte `D3` | `0xFF` | `CR_Datc_DrTargetTempF`| Driver Displayed Target Temp in $^\circ\text{F}$ integer (`0x44` = 68°F, `0x48` = 72°F) |
| **`0x31B`** | `HVAC` | Byte `D4` | `0x0F` | `CF_Datc_BlowerFan` | Blower fan speed status (`0` = Off, `1`–`8` = Active) |
| **`0x226`** | `Outdoor_Temp` | Byte `D4` | `0xFF` | `CR_Datc_OutAirTemp` | Ambient outdoor temperature ($\text{Temp\_C} = \text{raw} - 40$) |

---

### 5.3 Direct Head Unit Setpoint Commands (`0x4A0` / `HU_DATC_E_01`)

While the vehicle is awake or driving, touchscreen target temperature adjustments and Passenger Zone Sync commands are transmitted from the Head Unit MICOM over **CAN ID `0x4A0` (`HU_DATC_E_01`)**.

* **CAN ID**: `0x4A0` (Standard 11-bit ID `1184` dec)
* **Bus**: M-CAN
* **DLC**: 8 bytes
* **Transmission Pattern**: 3 repeats of the active setpoint frame @ 20 ms interval, followed by 3 repeats of `0xFF` idle release on the active byte.

#### Signal Layout:

| Byte Index | 1-Based | Mask | Signal Name | Valid Values & Scaling |
| :---: | :---: | :---: | :--- | :--- |
| `1` | `D2` | `0xFF` | `CF_Hu_DrTargetTemp` | Driver cabin target temp code (`0x06` to `0x1A`):<br>$\text{raw} = \text{Temp\_F} - 56$ (or $0.5^\circ\text{C}$ steps from 17.0°C)<br>`0xFF`: Idle / No Change |
| `3` | `D4` | `0xFF` | `CF_Hu_DualSyncSet` | `0x0B`: **Sync Active** (Passenger setpoint follows Driver)<br>`0x07`: **Dual Split / Sync Off** (Independent passenger zone) |
| `7` | `D8` | `0xFF` | `CF_Hu_AstTargetTemp`| Passenger cabin target temp code (`0x06` to `0x1A`):<br>$\text{raw} = \text{Temp\_F} - 56$<br>`0xFF`: Idle / No Change |

#### Temperature Encoding Table:

| Target Temperature | Raw Code (`D2` Driver / `D8` Passenger) | Step 1 Active Burst (3x @ 20 ms) | Step 2 Idle Release (3x @ 20 ms) |
| :---: | :---: | :--- | :--- |
| **62°F** ($17.0^\circ\text{C}$) | `0x06` | `00 06 00 00 00 00 00 00` | `00 FF 00 00 00 00 00 00` |
| **68°F** ($20.0^\circ\text{C}$) | `0x0C` | `00 0C 00 00 00 00 00 00` | `00 FF 00 00 00 00 00 00` |
| **70°F** ($21.0^\circ\text{C}$) | `0x0E` | `00 0E 00 00 00 00 00 00` | `00 FF 00 00 00 00 00 00` |
| **72°F** ($22.0^\circ\text{C}$) | `0x10` | `00 10 00 00 00 00 00 00` | `00 FF 00 00 00 00 00 00` |
| **74°F** ($23.5^\circ\text{C}$) | `0x12` | `00 12 00 00 00 00 00 00` | `00 FF 00 00 00 00 00 00` |
| **76°F** ($24.5^\circ\text{C}$) | `0x14` | `00 14 00 00 00 00 00 00` | `00 FF 00 00 00 00 00 00` |
| **82°F** ($27.5^\circ\text{C}$) | `0x1A` | `00 1A 00 00 00 00 00 00` | `00 FF 00 00 00 00 00 00` |

#### Passenger Zone Sync Payloads:
* **Sync Passenger to Driver**: `00 00 00 0B 00 00 00 00` (Byte `D4` = `0x0B`)
* **Split Independent Dual Zone**: `00 00 00 07 00 00 00 00` (Byte `D4` = `0x07`)
* **Simultaneous Dual Cabin 72°F**: `00 10 00 0B 00 00 00 10` (Sets driver `D2` and passenger `D8` concurrently)

---


### 5.4 Driver-Only Zone & Defog Controls

* **Driver-Only Airflow**: **CAN ID `0x465` (`Climate_Button_Status`)**, Byte `D7`:
  * **`0x04`** = Driver-Only Mode Active (Isolates airflow to driver side to conserve HV battery).
  * **`0x0C`** = Driver-Only Mode Inactive (All cabin vents active).
* **Rear Defogger & Heated Mirrors**: **CAN ID `0x4A2`**, Byte `D1`: `0x15`, with telemetry feedback on **`0x541` (`CGW1`)** Byte `D5` Bit 4 (`0x10` = Defogger active).

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

Access, closure monitoring, and power tailgate automation in the E-GMP architecture coordinate across several Electronic Control Units bridged via the Central Gateway:
* **Body Control Module (BCM / IPM)**: Broadcasts low-level door latch switches, frunk/hood latches, trunk switches, and lock actuator positions on CAN IDs **`0x411`** and **`0x414`** at 100 ms.
* **Central Gateway (CGW1 / `0x541` & CGW2 / `0x553`)**: Broadcasts consolidated door switches, rear defogger, smart key driver profiles, and proximity handshakes at 100 ms.
* **Power Tailgate Module (PTGM / `0x3A6`)**: Controls the electronic spindle motors, pinch sensors, and power latch for the rear liftgate.
* **Head Unit Actuator Injection (`0x4A2` / `ALL_HU_CNTL_E_01`)**: Transmits physical multi-step door lock/unlock pulses from the cockpit touchscreen.
* **Telematics Modem Units (`TMU1` / `0x587` & `TMU2` / `0x588`)**: Ingests remote wireless cellular commands for door locks, hazard/horn triggers, and tailgate movement.

---

### 7.1 Cabin Door Latches, Hood & Trunk Telemetry (`0x411` / `0x414` / `0x541`)

Cabin doors, front hood (frunk), and rear liftgate latch sensors are monitored for display on the instrument cluster and infotainment screens, as well as providing safety interlocks for remote climate and drive-away readiness.

#### A. Low-Level Body Status Frame (`0x411` / `Body_Status_1041`)
Broadcast periodically at 100 ms (10 Hz). DLC = 8 bytes. Transmitting node: **BCM / IPM**.

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `3` | `D4` | [0] | `0x01` | `CF_Bcm_DrvDoorSw` | Driver Door: `0` = Closed, `1` = Open / Ajar |
| `4` | `D5` | [2] | `0x04` | `CF_Bcm_PassDoorSw` | Passenger Door: `0` = Closed, `1` = Open / Ajar |
| `5` | `D6` | [4] | `0x10` | `CF_Bcm_HoodSw` | Front Hood / Frunk Latch: `0` = Latched, `1` = Open / Ajar |
| `6` | `D7` | [4] | `0x10` | `CF_Bcm_RLDoorSw` | Rear-Left Door: `0` = Closed, `1` = Open / Ajar |
| `7` | `D8` | [0] | `0x01` | `CF_Bcm_RRDoorSw` | Rear-Right Door: `0` = Closed, `1` = Open / Ajar |

#### B. Trunk / Tailgate Latch Status (`0x414` / `Body_Status_Trunk`)
Broadcast periodically at 100 ms (10 Hz). DLC = 8 bytes. Transmitting node: **BCM / IPM**.

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `3` | `D4` | [0] | `0x01` | `CF_Bcm_TrunkSw` | Trunk / Tailgate Latch: `0` = Closed & Latched, `1` = Open / Ajar |
| `3` | `D4` | [1] | `0x02` | `CF_Bcm_TrunkPawl`| Trunk Safety Secondary Pawl: `0` = Latched, `1` = Released |

#### C. Central Gateway Consolidated Frame (`0x541` / `CGW1`)
Broadcast periodically at 100 ms (10 Hz). DLC = 8 bytes. Transmitting node: **Central Gateway (CGW)**.

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `1` | `D2` | [1:0] | `0x03` | `CF_Gway_DrvDoorSw` | Driver Door Switch: `0x00` = Closed, `0x01` = Open / Ajar |
| `1` | `D2` | [2] | `0x04` | `CF_Gway_RLDoorSw` | Rear-Left Door Switch: `0` = Closed, `1` = Open |
| `4` | `D5` | [2] | `0x04` | `CF_Gway_RRDoorSw` | Rear-Right Door Switch: `0` = Closed, `1` = Open |
| `4` | `D5` | [3] | `0x08` | `CF_Gway_PassDoorSw` | Passenger Door Switch: `0` = Closed, `1` = Open |
| `4` | `D5` | [4] | `0x10` | `CF_Gway_DefoggerSw` | Rear Defogger & Heated Side Mirrors: `0` = Off, `1` = Active |
| `7` | `D8` | [1] | `0x02` | `CF_Gway_SunroofSw` | Panoramic Sunroof Glass: `0` = Closed, `1` = Open / Vent |

---

### 7.2 Central Door Locking Actuation & Telemetry (`0x411` / `0x4A2` / `0x587`)

Central door locks are locked/unlocked via either the cockpit touchscreen actuator injection (`0x4A2`), telematics remote commands (`0x587`), or physical door handles/fob.

#### A. Lock State Telemetry (`0x411`)
* Ingested from CAN ID `0x411` Byte 2 (`D3`):
  * **All Doors Unlocked**: `D3 & 0x40 == 0x40`
  * **All Doors Locked**: `D3 & 0x40 == 0x00`

#### B. Touchscreen Actuator Pulse Injection (`0x4A2` / `ALL_HU_CNTL_E_01`)
The cockpit touchscreen injects a progressive 4-step frame sequence to command door lock actuators:
* **Unlock Doors Sequence**:
  1. `[00 00 FF 43 FF FF C0 00]` (4 repeats @ 25 ms)
  2. `[00 00 FF C3 FF FF C0 00]` (4 repeats @ 25 ms)
  3. `[00 00 FF C3 FF FF D0 00]` (4 repeats @ 25 ms)
  4. `[00 00 FF C3 FF FF F0 00]` (2 repeats @ 25 ms)
* **Lock Doors Sequence**:
  1. `[00 00 FF 73 FF FF FF 00]` (4 repeats @ 25 ms)
  2. `[00 00 FF F3 FF FF 7F 00]` (4 repeats @ 25 ms)
  3. `[00 00 FF F3 FF FF FF 00]` (3 repeats @ 25 ms)

#### C. Telematics Remote Lock Commands (`0x587` / `TMU1_0x587`)
* Injected by telematics modem or edge gateway on CAN ID `0x587`:
  * **Lock Doors**: `[01 00 00 00 00 00 00 00]`
  * **Unlock Doors**: `[02 00 00 00 00 00 00 00]`
  * **Flash Hazards & Honk Horn Alert**: `[00 01 00 00 00 00 00 00]`

---

### 7.3 Power Tailgate Module (PTGM) State Machine & Remote Actuation (`0x3A6` / `0x588`)

Vehicles equipped with an electric power liftgate communicate via the dedicated Power Tailgate Module (PTGM).

#### A. PTGM Status & Motion Telemetry (`0x3A6` / `PTGM_01`)
Broadcast periodically at 100 ms (10 Hz). DLC = 8 bytes. Transmitting node: **PTGM**.

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | [3:0] | `0x0F` | `PTGM_TailgateStatus` | Tailgate Operating State:<br>`0x01`: Fully Opened<br>`0x02`: Fully Closed & Latched<br>`0x03`: Actively Opening in Motion<br>`0x04`: Actively Closing in Motion<br>`0x05`: Stopped / Paused at Intermediate Position<br>`0x08`: Anti-Pinch / Obstacle Detected (safety reversing) |
| `1` | `D2` | [7:0] | `0xFF` | `PTGM_OpeningHeight` | Real-time opening height percentage: `0` to `100%` (`0x00` = Closed, `0x64` = 100% Full Open) |
| `2` | `D3` | [7:0] | `0xFF` | `PTGM_PinchSensors` | Anti-pinch left/right contact strip resistance & warning flags |

#### B. Remote Tailgate Actuation Command (`0x588` / `TMU2_0x588`)
Handled by the Head Unit MICOM at firmware routine `sub_can_047D40_TMU2_0x588` (`0x047D40`). Injected across M-CAN / C-CAN:

| Action | Payload (`0x588`) | Transmission Pattern | Functional Behavior |
| :--- | :---: | :---: | :--- |
| **Open Tailgate** | `[01 00 00 00 00 00 00 00]` | 3 repeats @ 25 ms | Unlatches cinch motor and raises tailgate to programmed user height |
| **Close Tailgate** | `[02 00 00 00 00 00 00 00]` | 3 repeats @ 25 ms | Drives spindle motors downward and triggers motorized cinch latch |
| **Stop Motion** | `[03 00 00 00 00 00 00 00]` | 3 repeats @ 25 ms | Immediately brakes spindle motors at current height |

---

### 7.4 Smart Key Fob Proximity & Driver Recognition (`0x553` / `CGW2`)

Broadcast periodically at 100 ms (10 Hz). DLC = 8 bytes. Transmitting node: **Smart Key Unit (SMK) / Central Gateway**.
Registered in the Mobis Head Unit MICOM firmware descriptor table at offset `0x029A50`.

#### Payload Layout

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `6` | `D7` | [2:0] | `0x07` | `CF_Gway_SMKFobID` | Active Key Fob / Driver Profile Identifier:<br>`0x00`: No Key Detected / Out of Range<br>`0x01`: Driver 1 (Key Fob 1)<br>`0x02`: Driver 2 (Key Fob 2)<br>`0x03`: Smartphone NFC / UWB Digital Key<br>`0x04`: Valet Key / Card Key |
| `7` | `D8` | [0] | `0x01` | `CF_Gway_SMKApproach` | Proximity Welcome Handshake:<br>`0`: Key not in exterior welcome perimeter<br>`1`: Key detected in proximity zone ($\le 1.5	ext{ m}$) |

---

### 7.5 Welcome Mirrors & Smart Hands-Free Proximity Trunk (`0x410` / `CGW_USM1`)

Vehicle user settings for welcome accessories and hands-free automatic trunk opening are supervised by the Central Gateway on CAN ID **`0x410`**:

| Signal Name | 1-Based Byte (`can-do`) | Bitmask | Description & Functional Options |
| :--- | :---: | :---: | :--- |
| `CF_Gway_WlightRValue` | `D3` | `0x03` | Welcome Mirror Unfold & Approach Light:<br>`0x00`: Feature Disabled / Off<br>`0x02`: Welcome Unfold On Approach (unfolds mirrors when fob within 1.5 m) |
| `CF_Gway_HfreeTrunkRValue` | `D5` | `0x07` | Smart Proximity Hands-Free Trunk:<br>`0x00`: Feature Disabled / Off<br>`0x07`: Smart Proximity Trunk Active (automatically opens if standing near tailgate for 3s) |

---

## 8. Ambient Mood Lighting (Native M-CAN 2-Stage Sequence on `0x4AD` / `0x48F`)

Ambient lighting in E-GMP vehicles (Kia EV6, Hyundai Ioniq 5/6, Genesis GV60) is commanded directly from the Head Unit MICOM over M-CAN via a verified **2-Stage State Machine**. The Mood Lamp Units require a latch/commit frame following the active color burst to commit the PWM color register into EEPROM/RAM.

* **Front / Center Console Zone**: **CAN ID `0x4AD` (`MLU_01`)**
* **Rear / Door Panel Zone**: **CAN ID `0x48F` (`MLU_02`)** (Synchronized with `0x4AD`)
* **Timing**: Spacing of 20–25 ms between consecutive frames

### 8.1 Two-Stage Transmission Protocol:
1. **Stage 1 (Active Color Burst)**: 3 frames @ 25 ms delay:
   * `[D1, D2, D3, D4, 0x00, 0x00, 0x00, 0x00]`
   * Byte `D1`: Red channel or primary theme code
   * Byte `D2`: Green channel or secondary theme code
   * Byte `D3`: Blue channel
   * Byte `D4`: Brightness level scaling (`0x0F` = 100%, `0x07` = 50%, `0x03` = 25%, `0x00` = Off)
2. **Stage 2 (Latch / Commit Frame)**: 3 frames @ 25 ms delay:
   * **`00 02 08 20 00 00 00 00`**
   * *Critical*: Without this latch burst, the MLU microcontroller discards the RGB burst after 200 ms timeout.

### 8.2 Valid Message Payloads:

#### Factory Dual-Color Theme Presets:
| Theme Name | Stage 1 Payload (`0x4AD` / `0x48F`) | Stage 2 Latch Payload | Description |
| :--- | :--- | :--- | :--- |
| **Golden Insight / Orange Delight** | `D0 C1 75 15 00 00 00 00` | `00 02 08 20 00 00 00 00` | Warm Gold upper + Deep Amber lower |
| **Blue Flight** | `4F 29 36 1C 00 00 00 00` | `00 02 08 20 00 00 00 00` | Sky Blue upper + Royal Blue lower |
| **Peaceful Forest** | `7F 69 A6 17 00 00 00 00` | `00 02 08 20 00 00 00 00` | Emerald Green upper + Mint lower |
| **Dreamy Purple** | `6B 69 55 19 00 00 00 00` | `00 02 08 20 00 00 00 00` | Magenta upper + Indigo lower |
| **Violet Cloud** | `A7 89 F5 17 00 00 00 00` | `00 02 08 20 00 00 00 00` | Soft Lavender upper + Violet lower |
| **Refreshing Sea** | `32 69 E6 19 00 00 00 00` | `00 02 08 20 00 00 00 00` | Turquoise upper + Cyan lower |

#### Single-Color Spectrum Presets:
| Color Name | Stage 1 Payload (`0x4AD` / `0x48F`) | Stage 2 Latch Payload | Target Tone |
| :--- | :--- | :--- | :--- |
| **Crimson Red** | `FE 88 00 00 00 00 00 00` | `00 02 08 20 00 00 00 00` | Sport / Warning Red |
| **Electric Blue** | `00 54 F1 0F 00 00 00 00` | `00 02 08 20 00 00 00 00` | Pure EV Blue |
| **Pure Cyan / Aqua Wave** | `00 64 53 0F 00 00 00 00` | `00 02 08 20 00 00 00 00` | Cyan / Turquoise |
| **Deep Purple / Violet** | `80 00 F0 0F 00 00 00 00` | `00 02 08 20 00 00 00 00` | Rich Purple |
| **Magenta / Neon Pink** | `FF 00 10 0F 00 00 00 00` | `00 02 08 20 00 00 00 00` | Hot Pink |
| **Warm Sunset / Amber** | `FF 50 72 07 00 00 00 00` | `00 02 08 20 00 00 00 00` | Amber / Orange |
| **Champagne White** | `FE B4 53 0A 00 00 00 00` | `00 02 08 20 00 00 00 00` | Neutral Warm White |
| **Lime / Mint Glow** | `F7 FC 63 0B 00 00 00 00` | `00 02 08 20 00 00 00 00` | Lime Green |
| **Mood Light Off** | `00 00 00 00 00 00 00 00` | `00 02 08 20 00 00 00 00` | Complete Illumination Cutoff |

---

## 9. Transmission, Shifter & Drive Mode Ingestion (`0x45` / `0x130` / `0x434` / `0x478`)

The transmission and shifter subsystem handles gear position arbitration, physical rotary shift-by-wire (SBW) dial turns, brake pedal interlocks, drive mode selection, and rear-view camera video activation.

In the STD5W Head Unit MICOM (`dec_micom_sw.bin`), gear status from CAN ID `0x434` / `0x45` directly triggers the video multiplexer hardware and camera power controller (`0x0C82CA`: `SET CAMERA`, `0x0FF338`: `DrvGpio_Camera_Pwr on`), automatically switching the infotainment screen to the analog/LVDS rear-view backup camera display when Reverse (`R`) is selected.

---

### 9.1 Powertrain Gear Selector State (`0x45` / `E_CAN`)

Broadcast at high frequency (10 ms / 100 Hz) by the Vehicle Control Unit (VCU) on E-CAN / P-CAN (DLC: 8):

| Byte Index | 1-Based | Bit(s) | Mask | Signal Name | Valid States & Values |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `5` | `D6` | Bits 4–6 | `0x70` | `CF_Vcu_CurGear` | **Active Gear Position**:<br>`0x00`: **Park (P)**<br>`0x50`: **Drive (D)**<br>`0x60`: **Neutral (N)**<br>`0x70`: **Reverse (R)** |

#### Valid Example Payloads (`0x45`):
* **Parked (P)**: `xx xx xx xx xx 00 xx xx` (e.g. `00 00 00 00 00 00 00 00`)
* **Drive (D)**: `xx xx xx xx xx 50 xx xx` (e.g. `00 00 00 00 00 50 00 00`)
* **Neutral (N)**: `xx xx xx xx xx 60 xx xx` (e.g. `00 00 00 00 00 60 00 00`)
* **Reverse (R)**: `xx xx xx xx xx 70 xx xx` (e.g. `00 00 00 00 00 70 00 00`)

---

### 9.2 Rotary Shift-by-Wire (SBW) Console Dial (`0x130` / `B_CAN`)

Broadcast at 20 ms by the center console Shift-by-Wire module, digitizing driver turns of the rotary shift knob and presses of the central Park button:

| Signal Name | Byte | Bit(s) | Mask | Valid States & Values |
| :--- | :---: | :---: | :---: | :--- |
| `CF_Sbw_ParkBtn` | `D5` | Bits 4–7 | `0xF0` | `0x00` = Released, `0x10` = Park (P) Button Pressed |
| `CF_Sbw_TurnKnob` | `D6` | Bits 4–7 | `0xF0` | `0x00` = Center/Detent, `0x10` = Turned to Reverse (R), `0x50` = Turned to Drive (D) |

#### Valid Example Payloads (`0x130`):
* **Park Button Pressed In**: `00 00 00 00 10 00 00 00`
* **Dial Turned Right to Drive (D)**: `00 00 00 00 00 50 00 00`
* **Dial Turned Left to Reverse (R)**: `00 00 00 00 00 10 00 00`
* **Neutral / Idle Detent**: `00 00 00 00 00 00 00 00`

---

### 9.3 Vehicle Drive Mode Selection (`0x478` / `C_CAN`)

Broadcast at 100 ms from the steering wheel Drive Mode selector button to the Instrument Cluster and Infotainment display:

| Byte Index | 1-Based | Bit(s) | Mask | Signal Name | Drive Mode Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `3` | `D4` | Bits 4–7 | `0xF0` | `CF_Vcu_DriveMode` | `0x10`: **Normal Mode** (Balanced acceleration & regen)<br>`0x20`: **Eco Mode** (Torque limiting, eco HVAC limits)<br>`0x30`: **Sport Mode** (Maximum torque response, tightened steering)<br>`0x40`: **Snow Mode / Custom** (AWD 50:50 torque split, slip suppression) |

#### Valid Example Payloads (`0x478`):
* **Normal Mode Active**: `00 00 00 10 00 00 00 00`
* **Eco Mode Active**: `00 00 00 20 00 00 00 00`
* **Sport Mode Active**: `00 00 00 30 00 00 00 00`
* **Snow Mode Active**: `00 00 00 40 00 00 00 00`

---

### 9.4 Head Unit Camera Trigger & Screen Switching

Inside the STD5W MICOM video supervisor (`0x0C82A0`–`0x0C8320`):
1. **Gear Monitoring**: Evaluates gear telemetry from CAN traffic. When Reverse (`R`) is detected:
2. **Camera Power GPIO**: Executes `DrvGpio_Camera_Pwr on` (`0x0FF338`) to energize the rear camera and Surround View Monitor (SVM) sensors.
3. **Display Layer Switching**: Executes `SET CAMERA` (`0x0C82CA`) to switch the video multiplexer from the Linux UI framebuffer to the analog/LVDS camera feed with parking trajectory overlay.
4. **Hysteresis Exit**: Upon shifting out of `R`, the camera feed remains active until forward vehicle speed exceeds 15 km/h (10 mph) or a 10-second timeout elapses.

---

## 10. Instrument Cluster Rheostat & Backlight Synchronization (`0x474`)

The dashboard, instrument cluster, and center infotainment display illumination levels are synchronized across the CAN network. The vehicle allows illumination stepping via the physical dash buttons (+ / -), steering wheel menus, or software CAN injection on CAN ID **`0x474`** (`Cluster_Brightness_Button`).

In the STD5W Head Unit MICOM (`dec_micom_sw.bin`), brightness state changes are ingested and processed by the illumination task at flash offsets `0x10AC60`–`0x10AF50`, which tracks the vehicle rheostat wire level (`WIRE_RHEO_LEVEL_VEHICLE` at `0x0FFC8C`), references the nonlinear LCD duty-cycle step table at `0x10AEC0`, and applies smooth fade filtering (`+Fade ING` at `0x0FF490` until `+Fade END` at `0x0FF4C0`).

---

### 10.1 Frame Specification & Byte Layout (`0x474`)

* **CAN ID**: `0x474` (Standard 11-bit ID `1140` dec)
* **DLC**: 8 bytes
* **Bus**: B-CAN / M-CAN

| Byte Index | 1-Based | Bit(s) | Mask | Signal Name | Description / Values |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0–6` | `D1–D7` | 8-bit | `0xFF` | `CF_Clu_Reserved` | Padded static frame bytes (`0x00 00 00 00 00 00 00`) |
| `7` | `D8` | Bits 0–7 | `0xFF` | `CF_Clu_RheoBtn` | **Brightness Stepping Command**:<br>`0x0A`: **Idle / Button Released**<br>`0x4A`: **Brightness Up (+)** (Step illumination up)<br>`0x8A`: **Brightness Down (-)** (Step illumination down) |

---

### 10.2 Valid Message Payloads on `0x474`

| Function / Action | Payload (`0x474`) | Repetition Pattern | Description |
| :--- | :---: | :---: | :--- |
| **Brightness Up (+)** | `00 00 00 00 00 00 00 4A` | 3 repeats @ 20 ms | Momentary active button press increment |
| **Brightness Down (-)** | `00 00 00 00 00 00 00 8A` | 3 repeats @ 20 ms | Momentary active button press decrement |
| **Idle Release Pulse** | `00 00 00 00 00 00 00 0A` | 2 repeats @ 20 ms | Mandatory idle latch release after active press |

> [!IMPORTANT]
> **Momentary Button Emulation Protocol**:
> Automotive body microcontrollers register button presses as discrete edge transitions. Transmitting a single raw `0x4A` frame will leave the ECU in a stuck-button state. Automation engines must always execute a 2-stage burst:
> 1. **Active Pulse**: 3 consecutive frames of `0x4A` or `0x8A` at 20 ms intervals.
> 2. **Idle Release**: 2 consecutive frames of `0x0A` at 20 ms intervals.

---

### 10.3 MICOM Backlight Synchronization & Fade Logic

When an illumination step command is accepted on `0x474`, the STD5W MICOM coordinates the display transition:
1. **Rheostat Ingestion**: Reads updated vehicle level (`WIRE_RHEO_LEVEL_VEHICLE`).
2. **Curve Interpolation**: Looks up the target pulse width modulation (`PULSE DUTY`) from the step array at `0x10AEC0` (20 discrete illumination steps from `0x0035` [53] to `0x007D` [125]).
3. **Adaptive Backlight Fading**:
   - If `gained_brightness > 340`: Applies direct immediate step (`0x0FF43C`).
   - If `gained_brightness < 340`: Initiates smooth multi-frame fade (`+Fade ING, dbg_cnt:%d, cur lv:%d, target:%d` at `0x0FF490`).
   - Terminates fade at target brightness level (`+Fade END dbg_cnt:%d, target:%d` at `0x0FF4C0`).

---

## 11. Infotainment User Settings Menus (`HU_USM_E_02` on `0x542`)

The Head Unit MICOM broadcasts vehicle user preferences configured on the touchscreen under *"Vehicle Settings"* to body and lighting controllers on CAN ID **`0x542` (`HU_USM_E_02`)**.

* **CAN ID**: `0x542` (Standard 11-bit ID `1346` dec)
* **Periodic Rate**: 50 ms (20 Hz)
* **DLC**: 8 bytes

### 11.1 Byte-by-Byte Signal Layout:

| Byte Index | 1-Based | Mask | Signal Name | Valid Values & Meanings |
| :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | `0x0F` | `CF_Hu_AutoLockOpt` | `0x00`: Disabled<br>`0x01`: Auto-Lock on Shift out of Park (P)<br>`0x02`: Auto-Lock on Vehicle Speed (> 15 km/h / 10 mph) |
| `1` | `D2` | `0x0F` | `CF_Hu_AutoUnlockOpt` | `0x00`: Disabled<br>`0x01`: Auto-Unlock on Shift into Park (P)<br>`0x02`: Auto-Unlock on Vehicle Power Off (IGN Off) |
| `2` | `D3` | `0xFF` | `CF_Hu_OneTouchFlash` | `0x00`: Disabled<br>`0x03`: One-Touch Turn Signal 3 Flashes<br>`0x05`: One-Touch Turn Signal 5 Flashes<br>`0x07`: One-Touch Turn Signal 7 Flashes |
| `3` | `D4` | `0x0F` | `CF_Hu_EscortHeadlamp` | `0x00`: Headlight Delay Off<br>`0x01`: Headlight Delay / Escort Active (15s after exit) |
| `4` | `D5` | `0x01` | `CF_Hu_MoodLinkDrive` | `0`: Ambient Light Independent<br>`1`: Ambient Light Linked to Drive Mode |
| `4` | `D5` | `0x02` | `CF_Hu_MoodDimDark` | `0`: Full Brightness Always<br>`1`: Dim Ambient Light in Dark / Night Driving |
| `4` | `D5` | `0x04` | `CF_Hu_WelcomeMirror` | `0`: Manual Side Mirrors<br>`1`: Auto-Unfold Side Mirrors on Smart Key Approach |
| `5`–`7` | `D6`–`D8` | All | Reserved | `0x00 0x00 0x00` |

### 11.2 Valid Example Message Payloads:
* **Standard Factory Preset (Speed Lock, Park Unlock, 5 Flashes, Escort On, Dim In Dark)**:
  `02 01 05 01 02 00 00 00`
* **Shift-to-P Lock & Unlock with 7 Flashes**:
  `01 01 07 01 02 00 00 00`
* **All Convenience Features Disabled (Manual Locks, No Escort, 3 Flashes)**:
  `00 00 03 00 00 00 00 00`

---

## 12. External Audio DSP Amplifier (`HU_AMP_E_01` on `0x60C` / `0x520`)

On E-GMP vehicles equipped with premium sound systems (Meridian on Kia EV6, Bose on Ioniq 5/6, Lexicon / Bang & Olufsen on Genesis GV60), the Head Unit outputs raw digital audio over SPDIF / A2B while full digital signal processing (volume, balance, fader, 3-band EQ, surround sound, and quiet mode) is executed by the external DSP amplifier over M-CAN via **CAN ID `0x60C`** (or legacy **`0x520`**).

* **Native E-GMP CAN ID**: **`0x60C`** (`HU_AMP_E_01`, M-CAN)
* **Legacy Gen5 CAN ID**: **`0x520`** (`AMP_HU_PE_01`, C-CAN)
* **DLC**: 8 bytes
* **Broadcast**: Periodic 100 ms (10 Hz) or burst-on-event (knob turns / touchscreen EQ adjustments).

### 12.1 Byte-by-Byte Payload Layout:

| Byte Index | 1-Based | Range / Mask | Signal Name | Description / Scaling |
| :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | `0`–`75` (`0x00`–`0x4B`) | `CF_Hu_MasterVol` | Master volume step (`0` = Mute, `45` = Max standard, `75` = Max premium) |
| `1` | `D2` | Bitfield | `CF_Hu_AmpMuteMode` | `0x00`: Normal Audio Active<br>`0x01`: Master Mute Active (`AMP_Mute`)<br>`0x02`: SPDIF Hardware Mute (`AMP_SPDIFMute`)<br>`0x04`: Phone Call Audio Routing<br>`0x08`: Navigation Prompt / TTS Mode |
| `2` | `D3` | `0`–`20` (`0x00`–`0x14`) | `CF_Hu_AudioFader` | Front / Rear Fader balance (Offset 10):<br>`0x0A` (10): Centered (0)<br>`0x14` (20): Full Front (+10)<br>`0x00` (0): Full Rear (-10) |
| `3` | `D4` | `0`–`20` (`0x00`–`0x14`) | `CF_Hu_AudioBalance` | Left / Right Balance (Offset 10):<br>`0x0A` (10): Centered (0)<br>`0x14` (20): Full Right (+10)<br>`0x00` (0): Full Left (-10) |
| `4` | `D5` | `0`–`20` (`0x00`–`0x14`) | `CF_Hu_EqBass` | Bass Band Equalizer (Offset 10):<br>`0x0A` (10): Flat (0 dB)<br>`0x14` (20): Max Bass (+10 dB)<br>`0x00` (0): Min Bass (-10 dB) |
| `5` | `D6` | `0`–`20` (`0x00`–`0x14`) | `CF_Hu_EqMid` | Midrange Band Equalizer (Offset 10):<br>`0x0A` (10): Flat (0 dB)<br>`0x14` (20): Max Mid (+10 dB)<br>`0x00` (0): Min Mid (-10 dB) |
| `6` | `D7` | `0`–`20` (`0x00`–`0x14`) | `CF_Hu_EqTreb` | Treble Band Equalizer (Offset 10):<br>`0x0A` (10): Flat (0 dB)<br>`0x14` (20): Max Treble (+10 dB)<br>`0x00` (0): Min Treble (-10 dB) |
| `7` | `D8` | Bitfield | `CF_Hu_DspModes` | Bit 0 (`0x01`): Speed-Dependent Volume Control (SDVC)<br>Bit 1 (`0x02`): Meridian Horizon / Bose Surround Sound<br>Bit 2 (`0x04`): Quiet Mode (Limits front volume to 25, mutes rear speakers)<br>Bit 3 (`0x08`): Kids / Passenger Talk Mode |

### 12.2 Valid Message Payloads:

| Function / Preset | Payload (`0x60C` / `0x520`) | Description |
| :--- | :---: | :--- |
| **Normal Listening (Vol 25, Flat EQ, Centered)** | `19 00 0A 0A 0A 0A 0A 00` | Factory neutral audio state |
| **Audiophile Preset (Vol 35, Bass +5, Treb +3, Surround On)** | `23 00 0A 0A 0F 0A 0D 02` | Enhanced soundstage with surround |
| **Master Mute Active** | `19 01 0A 0A 0A 0A 0A 00` | Mutes DSP output while preserving volume step |
| **Quiet Mode Active** | `16 00 0A 0A 0A 0A 0A 04` | Restricts cabin sound to front row |
| **Kids Music Mode** | `16 00 0A 0A 0A 0A 0A 08` | Optimizes frequency response for children |
| **SPDIF Digital Audio Mute** | `19 02 0A 0A 0A 0A 0A 00` | Hardware digital audio link suppression |
| **Audio Completely Off (Vol 0, Muted)** | `00 01 0A 0A 0A 0A 0A 00` | Complete audio system shutdown |


---

## 13. Central Gateway Body State, EV Controls & Power Supervision (`0x410` / `0x541` / `0x559`)

The Central Gateway (CGW) arbitrates body status, door lock states, power window switches, and vehicle settings between the high-speed powertrain (C-CAN / E-CAN) and the infotainment multimedia network (M-CAN).

In the Mobis STD5W Head Unit MICOM (`dec_micom_sw.bin`), the Central Gateway interface is divided into:
1. **`0x410` (`CGW_USM1`)**: Bidirectional EV user settings menu (USMService IPC command dispatch & CGW telemetry feedback).
2. **`0x541` (`CGW1`)**: Ingested body frame (individual door ajar switches, rear defogger, wiper stalks, and sunroof position).
3. **`0x559` (`CGW4`)**: Ingested comfort & closure frame (power window open/closed status and heated steering wheel active telemetry).
4. **Power State Management (`0x04A000`–`0x04F000`)**: MICOM power state machine tracking Standby, Deep Sleep (`STOP`), Accessory (`ACC MODE`), and Battery Low-Voltage Protection.

---

### 13.1 User Settings & EV Control Dispatch (`0x410` / `CGW_USM1`)

When the user adjusts EV drive settings (i-Pedal, Smart Regenerative Braking, or Virtual Engine Sound System volume) on the infotainment touchscreen, the Head Unit `USMService` dispatches a standard 8-byte command packet on **CAN ID `0x410`**:

#### Command Structure (`USMService.sendEcoVehicle`):
* **Protocol Header (Bytes `D1`–`D4`)**: `0x92, 0x11, 0x11, 0x1B` (`0x111B` = Function ID 4379)
* **Subtype (Byte `D5`)**: Target vehicle subsystem function
* **Setting Value (Byte `D6`)**: Desired parameter / level
* **Padded Trailing Bytes (`D7`–`D8`)**: `0x00, 0x00`

| Function Target | Subtype (`D5`) | Setting Value (`D6`) | Action Description |
| :--- | :---: | :---: | :--- |
| **i-Pedal (One-Pedal Hold)** | `0x0E` | `0x01` | Latch i-Pedal ON (one-pedal driving & full stop hold) |
| **i-Pedal (One-Pedal Hold)** | `0x0E` | `0x00` | Turn i-Pedal OFF |
| **Smart Regenerative Braking** | `0x04` | `0x00` | Radar-guided auto regen OFF |
| **Smart Regenerative Braking** | `0x04` | `0x01` | Smart Regen Gentle (Level 1) |
| **Smart Regenerative Braking** | `0x04` | `0x02` | Smart Regen Medium (Level 2) |
| **Smart Regenerative Braking** | `0x04` | `0x03` | Smart Regen Strong (Level 3) |
| **VESS Speaker Volume** | `0x06` | `0x00` | External Pedestrian Speaker Normal |
| **VESS Speaker Volume** | `0x06` | `0x01` | External Pedestrian Speaker Mute / Off |
| **VESS Speaker Volume** | `0x06` | `0x02` | External Pedestrian Speaker Low |
| **VESS Speaker Volume** | `0x06` | `0x03` | External Pedestrian Speaker High |

#### Telemetry Feedback Broadcast (`CGW_USM1` on `0x410`):
The Central Gateway broadcasts periodic status confirming the active vehicle preferences:
* **`CF_Gway_WlightRValue` (Byte `D3`, Bits 0–1, `mask = 0x03`)**: Welcome mirror unfold on approach (`0x00` = Disabled, `0x02` = Enabled).
* **`CF_Gway_MoodLpRValue` (Byte `D4`, Bits 6–7, `mask = 0xC0`)**: Ambient mood lighting active (`0x00` = Off, `0x40` = On).
* **`CF_Gway_HfreeTrunkRValue` (Byte `D5`, Bits 0–2, `mask = 0x07`)**: Smart hands-free trunk proximity unlock (`0x00` = Disabled, `0x07` = Enabled).
* **`CF_Gway_PasSpkrLvRValue` (Byte `D6`, Bits 0–2, `mask = 0x07`)**: VESS speaker volume status (`0x00` = Normal, `0x01` = Mute, `0x02` = Low, `0x03` = High).

---

### 13.2 Central Gateway Body State Ingestion (`0x541` / `CGW1`)

Broadcast periodically at 100 ms (10 Hz) by the Central Gateway. Precedes `0x542` in the MICOM message descriptor table (`0x010657`, `0x0108E6`, `0x010B75`):

| Byte Index | 1-Based | Bit(s) | Mask | Signal Name | Description / Values |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `1` | `D2` | Bit 0 | `0x01` | `CF_Gway_DrvDoorSw` | Driver Front Door Ajar: `0` = Closed, `1` = Open |
| `1` | `D2` | Bit 1 | `0x02` | `CF_Gway_RLDoorSw` | Rear-Left Door Ajar: `0` = Closed, `1` = Open |
| `3` | `D4` | Bits 4–7 | `0xF0` | `CF_Gway_WiperStalk` | Wiper stalk switch: `0x00` = Off, `0x10` = Active / Mist / Auto |
| `4` | `D5` | Bit 2 | `0x04` | `CF_Gway_RRDoorSw` | Rear-Right Door Ajar: `0` = Closed, `1` = Open |
| `4` | `D5` | Bit 3 | `0x08` | `CF_Gway_AstDoorSw` | Passenger (Front-Right) Door Ajar: `0` = Closed, `1` = Open |
| `4` | `D5` | Bit 4 | `0x10` | `CF_Gway_RearDefogSw` | Rear Glass Defogger & Heated Side Mirrors: `0` = Off, `1` = Active |
| `7` | `D8` | Bit 1 | `0x02` | `CF_Gway_SunroofStat` | Sunroof Glass State: `0` = Closed, `1` = Open / Venting |

#### Valid Example Payloads (`0x541`):
* **All Doors Closed, Normal Idle**: `00 00 00 00 00 00 00 00`
* **Driver Door Ajar**: `00 01 00 00 00 00 00 00`
* **Passenger Door Open**: `00 00 00 00 08 00 00 00`
* **Rear Defogger & Heated Mirrors Active**: `00 00 00 00 10 00 00 00`
* **Sunroof Open / Venting**: `00 00 00 00 00 00 00 02`
* **Wipers Active / Misting**: `00 00 00 10 00 00 00 00`

---

### 13.3 Power Windows & Heated Steering Wheel (`0x559` / `CGW4`)

Broadcast periodically at 100 ms (10 Hz). Handled by the MICOM body supervision module at flash offsets `0x04186E`, `0x0418B4`, and `0x04A480`:

| Byte Index | 1-Based | Bit(s) | Mask | Signal Name | Description / Values |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | Bit 4 | `0x10` | `CF_Gway_HtdStrrWhlStat` | Heated Steering Wheel: `0` = Inactive, `1` = Active / Heating |
| `1` | `D2` | Bit 0 | `0x01` | `CF_Gway_DrvWdwStat` | Driver Front Window: `0` = Closed, `1` = Open / Venting |
| `1` | `D2` | Bit 1 | `0x02` | `CF_Gway_RLWdwState` | Rear-Left Window: `0` = Closed, `1` = Open / Venting |
| `1` | `D2` | Bit 2 | `0x04` | `CF_Gway_RRWdwState` | Rear-Right Window: `0` = Closed, `1` = Open / Venting |
| `1` | `D2` | Bit 3 | `0x08` | `CF_Gway_AstWdwStat` | Passenger (Front-Right) Window: `0` = Closed, `1` = Open / Venting |
| `1` | `D2` | Bits 0–3 | `0x0F` | **All Windows Group** | `0x00` = All 4 Closed, `0x0F` = All 4 Open |

#### Valid Example Payloads (`0x559`):
* **All Windows Closed, Heated Wheel Off**: `00 00 00 00 00 00 00 00`
* **Heated Steering Wheel Active**: `10 00 00 00 00 00 00 00`
* **Driver Window Open / Cracked**: `00 01 00 00 00 00 00 00`
* **All 4 Windows Open / Venting**: `00 0F 00 00 00 00 00 00`
* **Heated Steering Wheel On + Front Windows Open**: `10 09 00 00 00 00 00 00`

---

### 13.4 Head Unit MICOM Power Management State Machine

The STD5W MICOM continuously monitors vehicle power rails and CGW body bus activity in tasks executing between `0x04A000` and `0x04F000`:
* **Operating States**:
  - **`STANDBY`**: Infotainment Linux AP suspended; MICOM listening on CAN bus for wake triggers.
  - **`STOP` (Deep Sleep)**: Vehicle locked, bus sleep requested, low-quiescent current mode.
  - **`ACC MODE` (`0x04CF3A`)**: Accessory power enabled (Infotainment display active, powertrain inactive).
  - **`ACC OFF MODE` (`0x04D8DA`)**: Accessory shutdown sequence initiated.
* **Monitored Wake Triggers & Events**:
  - `STOP_PANIC` (`0x0FF550`)
  - `STOP_WLIGHT_ON` (`0x0FF560`): Proximity welcome mirror / puddle lamp activation.
  - `STOP_DOOR_OPEN` / `STANDBY_DOOR_OPEN` (`0x0FF574` / `0x0FF6F4`)
  - `STOP_DOOR_UNLOCK` / `STANDBY_DOOR_UNLOCK` (`0x0FF5F8` / `0x0FF6D8`)
  - `STOP_TRUNK_OPEN` (`0x0FF640`)
  - `STOP_CHARGING` (`0x0FF674`): EV charging session started or terminated.
  - `STOP_REMOTE_ENG_RUN` (`0x0FF6AC`): Remote climate / high-voltage contactor pre-run.
  - `BATT_AUTO_CUT_PREWRNG` (`0x0FF658`): 12V auxiliary battery discharge warning / auto-cut protection.


---

## 14. Cockpit Physical Controls & Steering Wheel Switches (`0x4A2` / `0x448` / `0x651` / `0x1CF`)

Cockpit physical interaction encompasses both **downstream command transmission** from the Head Unit MICOM (`ALL_HU_CNTL_E_01` on CAN ID `0x4A2`) and **upstream button ingestion** from steering wheel clockspring switches (`0x448`, `0x1CF`) and console rotary encoders (`0x651`).

---

### 14.1 Head Unit Master Cockpit Actuator (`0x4A2` / `ALL_HU_CNTL_E_01`)

CAN ID `0x4A2` is the primary physical actuator channel transmitted by the Head Unit MICOM (handled at flash offset `0x046A00` and registered in channel table at `0x020545`). It operates in four distinct functional multiplex modes:

#### Mode 1: Power Windows & IMS Seat Recall (`D1 = 0x15`)
* Transmitted in bursts of 3 frames with 20 ms interval:
  * `D1`: `0x15` (Window & IMS Command Header)
  * `D2`: Driver Window (`0x05`=Close, `0x06`=Open, `0x04`=Vent, `0x0F`=Ignore)
  * `D3`: Front Passenger Window (`0x05`=Close, `0x06`=Open, `0x04`=Vent, `0x0F`=Ignore)
  * `D4`: IMS Memory Recall (**`0x07`** = Ignore seat/mirror movement, `0x01` = Profile 1, `0x02` = Profile 2)
  * `D5`: Rear Left Window (`0x05`=Close, `0x06`=Open, `0x04`=Vent, `0x0F`=Ignore)
  * `D6`: Rear Right Window (`0x05`=Close, `0x06`=Open, `0x04`=Vent, `0x0F`=Ignore)
  * `D7`–`D8`: `0x00, 0x00`

#### Mode 2: Heated Steering Wheel & Rear Defogger Trigger (`D1 = 0x00`)
* Dispatches active comfort heating pulses (followed by `0xFF` idle latch release):
  * `D1`–`D2`: `0x00, 0x00`
  * `D3`: Function Trigger:
    * `0x1F`: Heated Steering Wheel ON
    * `0x0F`: Heated Steering Wheel OFF
    * `0xCF`: Rear Defogger & Heated Side Mirrors ON
    * `0xFF`: Idle / Release Pulse
  * `D4`: `0x03` (Control Subtype)
  * `D5`–`D6`: `0xFF, 0xFF` (Collision prevention mask for seat warmer registers)
  * `D7`–`D8`: `0x00, 0x00`

#### Mode 3: Motorized Charge Port Door Actuation (`D4 = 0xC3`)
* Commands the motorized high-voltage charge port flap:
  * `D1`–`D2`: `0x00, 0x00`
  * `D3`: `0xFF`
  * `D4`: `0xC3`
  * `D5`–`D6`: `0xFF, 0xFF`
  * `D7`: `0x02` = Open Charge Door, `0x01` = Close / Lock Charge Door
  * `D8`: `0x00`

#### Valid Message Payloads on `0x4A2`:

| Function / Action | Payload (1-Based `D1`–`D8`) | Repetition | Purpose |
| :--- | :---: | :---: | :--- |
| **Heated Steering Wheel ON** | `00 00 1F 03 FF FF 00 00` | 3 repeats | Latch steering wheel heating ON |
| **Heated Steering Wheel OFF** | `00 00 0F 03 FF FF 00 00` | 3 repeats | Turn steering wheel heating OFF |
| **Rear Defogger & Mirrors ON** | `00 00 CF 03 FF FF 00 00` | 3 repeats | Activate rear glass + side mirror grid |
| **Rear Defogger & Mirrors OFF** | `00 00 0F 03 FF FF 00 00` | 3 repeats | Deactivate rear defogger grid |
| **Idle Release Pulse** | `00 00 FF 03 FF FF 00 00` | 3 repeats | Clear trigger flags after actuation |
| **Charge Port Door Open** | `00 00 FF C3 FF FF 02 00` | 3 repeats | Motorized flap pop open |
| **Charge Port Door Close** | `00 00 FF C3 FF FF 01 00` | 3 repeats | Motorized flap close & lock |
| **Vent All 4 Windows** | `15 04 04 07 04 04 00 00` | 3 repeats | Crack windows for ventilation |
| **Roll Up All 4 Windows** | `15 05 05 07 05 05 00 00` | 3 repeats | Full closure of all glass panels |

---

### 14.2 Steering Wheel Media & Menu Switches (`0x448` / `CLU_HU_PE_01`)

The Instrument Cluster digitizes the steering wheel clockspring resistance ladder and broadcasts physical button presses on CAN ID `0x448` (`CLU_HU_PE_01`) at 100 ms:

| Signal Name | Byte | Bit(s) | Mask | Value Meaning |
| :--- | :---: | :---: | :---: | :--- |
| `CF_Clu_ModeSw` | `D3` | Bit 6 | `0x40` | `1` = Mode Button Pressed (Cycle AM/FM/Media/CarPlay) |
| `CF_Clu_VoiceSw` | `D4` | Bit 0 | `0x01` | `1` = Voice Recognition Button Pressed (Siri/Assistant) |
| `CF_Clu_CallSw` | `D4` | Bit 2 | `0x04` | `1` = Phone Call / Answer Pressed |
| `CF_Clu_SeekUp` | `D4` | Bit 4 | `0x10` | `1` = Seek / Track Up Pressed |
| `CF_Clu_SeekDown` | `D4` | Bit 2 | `0x04` | `1` = Seek / Track Down Pressed (when Call inactive) |
| `CF_Clu_VolUp` | `D5` | Bit 0 | `0x01` | `1` = Volume Toggle Up Pressed |
| `CF_Clu_VolDown` | `D5` | Bit 6 | `0x40` | `1` = Volume Toggle Down Pressed |
| `CF_Clu_VolMute` | `D5` | Bit 2 | `0x04` | `1` = Volume Toggle Pressed In (Mute) |
| `CF_Clu_CustomSw` | `D6` | Bit 4 | `0x10` | `1` = Custom Star Button (★) Pressed |
| `CF_Clu_MenuUp` | `D7` | Bit 1 | `0x02` | `1` = Cluster Menu Toggle Up |
| `CF_Clu_MenuDown` | `D7` | Bit 0 | `0x01` | `1` = Cluster Menu Toggle Down |
| `CF_Clu_MenuOk` | `D7` | Bit 4 | `0x10` | `1` = Cluster Menu OK / Select Pressed In |

#### Valid Example Payloads (`0x448`):
* **No Buttons Pressed (Idle)**: `00 00 00 00 00 00 00 00`
* **Volume Up Pressed**: `00 00 00 00 01 00 00 00`
* **Volume Down Pressed**: `00 00 00 00 40 00 00 00`
* **Volume Mute Pressed**: `00 00 00 00 04 00 00 00`
* **Seek / Skip Up Pressed**: `00 00 00 10 00 00 00 00`
* **Custom Star (★) Pressed**: `00 00 00 00 00 10 00 00`
* **Voice Assistant Pressed**: `00 00 00 01 00 00 00 00`
* **Mode Button Pressed**: `00 00 40 00 00 00 00 00`

---

### 14.3 Rotary Encoder Knobs & Center Switches (`0x651` / `HU_ROTARY_KNOB`)

The infotainment display center knobs transmit discrete momentary press states on CAN ID `0x651`:
* **Volume Knob Center Press (Power / Audio Mute)**: Byte `D2`, Bit 6 (`mask = 0x40`): `0x40` = Pressed, `0x00` = Released.
  * Verified Payload: `00 40 00 00 00 00 00 00`
* **Tuner / File Scroll Center Press**: Byte `D4`, Bit 6 (`mask = 0x40`): `0x40` = Pressed, `0x00` = Released.
  * Verified Payload: `00 00 00 40 00 00 00 00`

---

### 14.4 Steering Wheel Regenerative Braking Paddles & ADAS (`0x1CF`)

The steering column paddles and cruise control cluster broadcast at 10 ms (100 Hz) on CAN ID `0x1CF`:
* **Left Regenerative Paddle (Pull & Hold)**: Byte `D4`, Bit 7 (`mask = 0x80`): `0x80` = Pulled (Max regen deceleration / stop).
* **Right Regenerative Paddle (Pull & Hold)**: Byte `D4`, Bit 5 (`mask = 0x20`): `0x20` = Pulled (Coast / regen level decrease).
* **Adaptive Cruise Control Button**: Byte `D3`, Bit 7 (`mask = 0x80`): `0x80` = Cruise toggled.
* **Distance Gap Cycle Button**: Byte `D3`, Bits 4–5 (`mask = 0x30`): `0x30` = Following distance adjusted.
* **Resume / Accelerate (+) Toggle**: Byte `D3`, Bit 4 (`mask = 0x10`): `0x10` = Accel toggle pushed up.
* **Set / Decelerate (-) Toggle**: Byte `D3`, Bit 5 (`mask = 0x20`): `0x20` = Decel toggle pushed down.


---

## 15. Virtual Engine Sound System (VESS) & Pedestrian Acoustic Alert (`0x387` / `0x410`)

The Virtual Engine Sound System (VESS) generates synthesized external acoustic alerts through a waterproof speaker assembly mounted behind the front bumper fascia. It ensures compliance with pedestrian safety regulations (FMVSS 141 / UNECE R138) by emitting forward low-speed motor hums, reverse warning chimes, and EV charging status voice announcements.

In the Mobis STD5W Head Unit MICOM (`dec_micom_sw.bin`), CAN ID `0x0387` is registered in the primary CAN dispatch table at `0x0FDED7` alongside `0x039B` (`TMU_01`), sharing message descriptor offset `0x160C`.

---

### 15.1 Real-Time Acoustic Telemetry (`0x387` / `VESS_01`)

Broadcast periodically at 100 ms (10 Hz) by the external VESS ECU (DLC: 8):

| Byte Index | 1-Based | Bit(s) | Mask | Signal Name | Description / Valid States |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | Bits 0–3 | `0x0F` | `CF_Vess_Mod` | **Acoustic Operating Mode**:<br>`0x00`: Sound Inactive / Standby (Vehicle in Park or speed > 30 km/h)<br>`0x01`: Forward Driving Synthesized Hum Active (0–30 km/h)<br>`0x02`: Reverse Warning Chime Active (Transmission in `R`)<br>`0x03`: EV Charging Voice Announcement Active<br>`0x04`: Welcome / Goodbye Chime Sequence |
| `0` | `D1` | Bits 4–7 | `0xF0` | `CF_Vess_Vol` | **Sound Pressure Level Output**:<br>`0x00`: Muted / Sound Off<br>`0x10`: Level 1 (Low Volume)<br>`0x20`: Level 2 (Standard / Normal Volume)<br>`0x30`: Level 3 (High Volume) |
| `1` | `D2` | Bits 0–3 | `0x0F` | `CF_Vess_Stat` | **Hardware & Speaker Diagnostic Status**:<br>`0x00`: Normal / No Fault<br>`0x01`: External Speaker Disconnected / Open Circuit<br>`0x02`: Speaker Output Short to Ground<br>`0x04`: Internal ECU Thermal Fault / Hardware Error |
| `2` | `D3` | Bits 0–3 | `0x0F` | `CF_Vess_ChgStat` | **Charging Notification Audio State**:<br>`0x00`: Idle / Normal<br>`0x01`: Plug Insertion Audio Chime<br>`0x02`: Fast DC Charging Voice Announcement ("Charging Started")<br>`0x03`: Scheduled Charging Confirmation Chime |

---

### 15.2 Valid Message Payloads on `0x387`

| Vehicle State / Event | Payload (`0x387`) | Active Acoustic Output |
| :--- | :---: | :--- |
| **Forward Driving (0–30 km/h, Normal Volume)** | `21 00 00 00 00 00 00 00` | Forward synthesized EV motor hum (`Vol = 2`, `Mode = 1`) |
| **Reverse Warning Chime (Gear in R)** | `22 00 00 00 00 00 00 00` | Intermittent pedestrian reverse beeper (`Vol = 2`, `Mode = 2`) |
| **EV Charging Started Voice Announcement** | `23 00 02 00 00 00 00 00` | Voice prompt: "Charging Started" (`Vol = 2`, `Mode = 3`) |
| **Standby / Silent Idle (Parked, Ready)** | `20 00 00 00 00 00 00 00` | System active, speaker silent (`Vol = 2`, `Mode = 0`) |
| **Forward Driving (Low Volume Preset)** | `11 00 00 00 00 00 00 00` | Quiet forward synthesized hum (`Vol = 1`, `Mode = 1`) |
| **Forward Driving (High Volume Preset)** | `31 00 00 00 00 00 00 00` | Maximum forward pedestrian alert (`Vol = 3`, `Mode = 1`) |
| **Muted by User Preference** | `01 00 00 00 00 00 00 00` | Forward drive sound suppressed (`Vol = 0`, `Mode = 1`) |
| **Speaker Open Circuit Fault** | `20 01 00 00 00 00 00 00` | Diagnostic alert: Front speaker disconnected (`Stat = 1`) |

---

### 15.3 Coordination with Head Unit USM Commands (`0x410`)

When the user adjusts VESS volume settings in the Infotainment touchscreen menu, the settings synchronize across the two CAN frames:

1. **Touchscreen Action**: Dispatches `[92 11 11 1B 06 <Val> 00 00]` on **`0x410`**.
2. **Gateway Acknowledgment**: Central Gateway reports `CF_Gway_PasSpkrLvRValue` on **`0x410`** Byte `D6` bits 0–2 (`mask = 0x07`).
3. **VESS Acoustic Output**: The VESS ECU sets its high-nibble output volume `CF_Vess_Vol` on **`0x387`** Byte `D1` bits 4–7:
   - Volume Normal: `0x410` `D6` = `0x00` $
ightarrow$ `0x387` `D1` high nibble = `0x2_`
   - Volume Mute: `0x410` `D6` = `0x01` $
ightarrow$ `0x387` `D1` high nibble = `0x0_`
   - Volume Low: `0x410` `D6` = `0x02` $
ightarrow$ `0x387` `D1` high nibble = `0x1_`
   - Volume High: `0x410` `D6` = `0x03` $
ightarrow$ `0x387` `D1` high nibble = `0x3_`


---

## 16. Navigation, Head-Up Display & TPEG Guidance (`0x386` / `HUD_01`)

The Head Unit (AVN) navigation subsystem transmits turn-by-turn guidance maneuvers, countdown distances, road speed limits, speed camera enforcement alerts, and real-time TPEG traffic conditions to the windshield Head-Up Display (HUD) and Instrument Cluster navigation view over M-CAN on CAN ID **`0x386`** (`HUD_01`).

In `dec_micom_sw.bin`, CAN ID `0x0386` is registered in the CAN channel routing table at `0x020609` and handled in navigation tasks referencing `NAVI_STATUS_TPEG` (`0x0FD853`), `NAVI_PRESENT_POSITION` (`0x0FD87B`), `NAVI_DELETE_DESTINATION` (`0x0FD8A3`), and `NAVI_OPERATION_STATUS_C` (`0x0FFCC0`).

---

### 16.1 Byte-by-Byte Payload Layout (`0x386` / `HUD_01`)

* **CAN ID**: `0x386` (decimal 902)
* **DLC**: 8 bytes
* **Broadcast**: Periodic 100 ms (10 Hz) while vehicle is awake

| Byte Index | 1-Based | Bit(s) | Mask | Signal Name | Description / Scaling |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | Bits 0–3 | `0x0F` | `CF_Hud_TurnIcon` | **Maneuver Symbol Code**:<br>`0x00`: No Guidance / Off<br>`0x01`: Straight / Continue on Route<br>`0x02`: Slight Right / Bear Right<br>`0x03`: Right Turn<br>`0x04`: Sharp Right Turn<br>`0x05`: U-Turn (Left / Right)<br>`0x06`: Sharp Left Turn<br>`0x07`: Left Turn<br>`0x08`: Slight Left / Bear Left<br>`0x09`: Highway Exit / Fork Right<br>`0x0A`: Highway Exit / Fork Left<br>`0x0B`: Roundabout (1st Exit)<br>`0x0C`: Roundabout (2nd Exit)<br>`0x0D`: Roundabout (3rd Exit)<br>`0x0E`: Destination Arrived (Checkered Flag) |
| `0` | `D1` | Bits 4–7 | `0xF0` | `CF_Hud_NaviStat` | **Guidance State**:<br>`0x00`: Guidance Inactive<br>`0x10`: Route Active / Guidance Ongoing<br>`0x20`: Rerouting / Recalculating<br>`0x30`: Guidance Suspended / Paused |
| `1–2` | `D2–D3` | 12-bit | `0x0FFF` | `CF_Hud_TurnDist` | **Distance to Next Maneuver**:<br>`D2` = Low 8 bits, `D3` bits 0–3 = High 4 bits.<br>Scaling: `1 count = 10 meters` (or 10 ft / 0.01 mi).<br>`0x0000` = Turn Now. |
| `2` | `D3` | Bits 4–5 | `0x30` | `CF_Hud_DistUnit` | **Distance Unit**:<br>`0x00`: Meters / Kilometers<br>`0x10`: Feet<br>`0x20`: Miles<br>`0x30`: Yards |
| `3` | `D4` | 8-bit | `0xFF` | `CF_Hud_SpeedLimit` | **Speed Limit / Camera Target**:<br>`0x00`: No Limit / Camera Inactive.<br>Integer speed in mph or km/h (e.g. `0x19`=25, `0x23`=35, `0x2D`=45, `0x37`=55, `0x41`=65, `0x46`=70). |
| `4` | `D5` | 8-bit | `0xFF` | `CF_Hud_CameraDist` | **Distance to Speed Camera**:<br>`1 count = 10 meters` countdown (e.g. `0x32` = 500 meters). |
| `5` | `D6` | 8-bit | `0xFF` | `CF_Hud_LaneGuidance` | **Highway Lane Recommendation**:<br>Bitmask of recommended lanes (e.g. `0x02` = Lane 2, `0x06` = Lanes 2 & 3). |
| `6` | `D7` | Bits 0–3 | `0x0F` | `CF_Hud_TpegTraffic` | **TPEG Traffic Congestion Status**:<br>`0x00`: Clear / Smooth Flow (Green)<br>`0x01`: Moderate Delay (Yellow)<br>`0x02`: Heavy Congestion (Red)<br>`0x03`: Severe Delay / Road Closed |
| `7` | `D8` | Bits 0–3 | `0x0F` | `CF_Hud_AliveCnt` | **Rolling Alive Counter**: `0`–`15` (`0x0`–`0xF`) |

---

### 16.2 Valid Example Message Payloads on `0x386`

| Guidance Scenario | Payload (`0x386`) | Decoded Status |
| :--- | :---: | :--- |
| **No Guidance / Idle Route** | `00 00 00 00 00 00 00 00` | Navigation inactive |
| **Right Turn in 200m (45 mph Limit, Clear)** | `13 14 00 2D 00 02 00 01` | `NaviStat`=1, `Turn`=Right (3), `Dist`=200m, `Speed`=45 mph, `Lane`=2 |
| **Left Turn in 500m (35 mph Limit, Yellow Traffic)** | `17 32 00 23 00 01 01 02` | `NaviStat`=1, `Turn`=Left (7), `Dist`=500m, `Speed`=35 mph, `Traffic`=Yellow |
| **Highway Exit Fork Right in 1.2 km (70 mph)** | `19 78 00 46 00 08 00 03` | `NaviStat`=1, `Turn`=Fork Right (9), `Dist`=1200m, `Speed`=70 mph |
| **Speed Camera Alert (65 mph Zone, 300m to Camera)** | `11 64 00 41 1E 00 02 04` | Straight, 1000m to next turn, Camera in 300m (`D5=0x1E`), `Traffic`=Red |
| **Roundabout 2nd Exit in 150m** | `1C 0F 00 28 00 00 00 05` | `NaviStat`=1, `Turn`=Roundabout 2nd (0xC), `Dist`=150m, `Speed`=40 mph |
| **Destination Arrived** | `1E 00 00 00 00 00 00 06` | `NaviStat`=1, `Turn`=Flag (0xE), `Dist`=0m |


---

## 17. Unified Diagnostic Services (UDS) & Firmware Flashing (`0x7DF` / `0x7EC` / `0x7E4`)

The Mobis STD5W Head Unit MICOM implements the ISO 14229-1 (UDS) standard running over ISO 15765-2 (DoCAN) network layer. This interface serves diagnostic trouble code (DTC) interrogation, data identifier (DID) parameter reads, security unlock handshakes, flash memory reprogramming, and bus communication silence controls.

In `dec_micom_sw.bin`, the physical diagnostic addresses are assigned in the CAN routing table at `0x020818` (`0x7EC`) and `0x020833` (`0x7E4`). The global diagnostic request gateway filter executes at flash offset `0x092B20` (`0x7DF`, `0x7E0`, `0x7D0`), dispatching to routine control handlers referencing `START_ROUTINE_BY_IDENTIFIER` (`0x09FFA0`), `DISABLE_TX_ALL` (`0x0871C0`), `ENABLE_NORMAL_MSG_ALL` (`0x0FCDC7`), and `DOWNLOAD_SERVICE_POS_RES` (`0x0FC87B`).

---

### 17.1 Diagnostic Addressing Identifiers

| Identifier Type | CAN ID (Hex) | CAN ID (Dec) | Target / Direction | Description |
| :--- | :---: | :---: | :---: | :--- |
| **Functional Request** | **`0x7DF`** | `2015` | External Tester $
ightarrow$ All ECUs | Broadcast discovery, TesterPresent, global DTC clearing |
| **Head Unit Physical Request** | **`0x7EC`** | `2028` | External Tester $
ightarrow$ Head Unit (AVN) | Dedicated unicast diagnostic requests to MICOM |
| **Head Unit Physical Response**| **`0x7E4`** | `2020` | Head Unit (AVN) $
ightarrow$ External Tester | Dedicated unicast diagnostic replies & multi-frame transfers |

---

### 17.2 Core UDS Services & Payload Layout

#### 1. Diagnostic Session Control (`Service 0x10`)
* **Request (`0x7EC`)**: `[02 10 <SubFunction> 00 00 00 00 00]`
* **Sub-functions**:
  * `0x01`: Default Session (standard operational mode)
  * `0x02`: Programming Session (bootloader flash memory access)
  * `0x03`: Extended Diagnostic Session (advanced calibration & actuator test)
* **Positive Response (`0x7E4`)**: `[06 50 <SubFunction> <P2_High> <P2_Low> <P2*_High> <P2*_Low> 00]`
  * Example (`Extended Session`): `06 50 03 00 32 01 F4 00` ($P2 = 50	ext{ ms}, P2* = 5000	ext{ ms}$)

#### 2. Tester Present / Keep-Alive Heartbeat (`Service 0x3E`)
* Maintains non-default diagnostic sessions without timing out (sent every 2000 ms):
* **Request (`0x7EC`)**: `[02 3E 80 00 00 00 00 00]` (`0x80` = Suppress Positive Response)
* **Request with Response**: `[02 3E 00 00 00 00 00 00]` $
ightarrow$ **Response (`0x7E4`)**: `[02 7E 00 00 00 00 00 00]`

#### 3. Communication Control (`Service 0x28` / `DISABLE_TX_ALL`)
* Handled in firmware at `0x0871C0` (`DISABLE_TX_ALL`) and `0x0FCDC7` (`ENABLE_NORMAL_MSG_ALL`). Silences standard cyclic CAN transmissions during high-speed flash reprogramming:
* **Disable All Transmissions (`0x7EC`)**: `[03 28 01 01 00 00 00 00]` (`SubFunction 0x01` = disableRxAndTx, `CommunicationType 0x01` = normalCommunication)
  * **Positive Response (`0x7E4`)**: `[02 68 01 00 00 00 00 00]`
* **Enable Normal Transmissions (`0x7EC`)**: `[03 28 00 01 00 00 00 00]` (`SubFunction 0x00` = enableRxAndTx)
  * **Positive Response (`0x7E4`)**: `[02 68 00 00 00 00 00 00]`

#### 4. Read Data By Identifier (`Service 0x22`)
* Queries ECU configuration and identification records:
* **Request (`0x7EC`)**: `[03 22 <DID_High> <DID_Low> 00 00 00 00]`

| Target DID | DID Name | Length | Decoded Content / Example |
| :---: | :--- | :---: | :--- |
| **`0xF190`** | `VINDataIdentifier` | 17 bytes | Vehicle Identification Number (ASCII string, ISO-TP multi-frame) |
| **`0xF187`** | `SparePartNumber` | 10–13 bytes | Mobis Head Unit Part Specification (e.g. `96560-GI000`) |
| **`0xF189`** | `SoftwareVersionNumber` | 8–16 bytes | MICOM Firmware Revision Tag |
| **`0xF195`** | `SystemSupplierECUSoftwareVersion`| 8 bytes | Mobis STD5W OS / Kernel Version Tag |
| **`0x0100`** | `USM_VehicleConfiguration` | 4 bytes | Active vehicle settings menu option bitmask |

#### 5. Routine Control (`Service 0x31` / `START_ROUTINE_BY_IDENTIFIER`)
* Handled in firmware at `0x09FFA0` for firmware sector erase and integrity checks:
* **Erase Flash Memory (`ERASE_CODE`)**:
  * **Request (`0x7EC`)**: `[04 31 01 FF 00 00 00 00]` (`SubFunction 0x01` = Start, `RoutineID 0xFF00` = Flash Erase)
  * **Pending Response (`0x7E4`)**: `[03 7F 31 78 00 00 00 00]` (`NRC 0x78` = RequestCorrectlyReceivedResponsePending)
  * **Success Response (`0x7E4`)**: `[04 71 01 FF 00 00 00 00]` (`0x71` = Positive Routine Response)
* **Check Memory Checksum / CRC32**:
  * **Request (`0x7EC`)**: `[04 31 01 02 01 00 00 00]` (`RoutineID 0x0201` = CRC Verification)
  * **Success Response (`0x7E4`)**: `[05 71 01 02 01 00 00 00]`

#### 6. Firmware Download & Data Transfer (`Services 0x34` / `0x36` / `0x37`)
* Handled in firmware routines `DOWNLOAD_SERVICE_POS_RES` (`0x0FC87B`) and `TRANSPER_DATA_PKT` (`0x0FC9C3`):
* **Request Download (`Service 0x34`)**:
  * **Request (`0x7EC`)**: `[08 34 00 44 <MemAddr 4B> <MemSize 4B>]` (via ISO-TP First Frame)
  * **Positive Response (`0x7E4`)**: `[04 74 20 <MaxBlockLength 2B> 00 00 00]`
* **Transfer Data (`Service 0x36`)**:
  * **Request (`0x7EC`)**: `[<Len> 36 <BlockSeqCounter> <ChunkData...>]`
  * **Positive Response (`0x7E4`)**: `[02 76 <BlockSeqCounter> 00 00 00 00 00]`
* **Request Transfer Exit (`Service 0x37`)**:
  * **Request (`0x7EC`)**: `[01 37 00 00 00 00 00 00]`
  * **Positive Response (`0x7E4`)**: `[01 77 00 00 00 00 00 00]`

---

### 17.3 Negative Response Code (NRC) Frame Structure

When an invalid request, incorrect sequence, or security violation occurs, the Head Unit returns an NRC frame on CAN ID **`0x7E4`**:
* **Payload Structure**: `[03 7F <RejectedSID> <NRC_Code> 00 00 00 00]`

| NRC Hex | Code Name | Description / Trigger Condition |
| :---: | :--- | :--- |
| **`0x12`** | `SubFunctionNotSupported` | Requested sub-function byte is not implemented in active session |
| **`0x13`** | `IncorrectMessageLength` | Frame DLC or ISO-TP length does not match service requirement |
| **`0x22`** | `ConditionsNotCorrect` | Request attempted outside required state (e.g. erasing while driving) |
| **`0x31`** | `RequestOutOfRange` | Target memory address, routine ID, or DID does not exist |
| **`0x33`** | `SecurityAccessDenied` | Attempted protected write/flash operation without unlocking Service 0x27 |
| **`0x35`** | `InvalidKey` | Cryptographic signature or calculated response key did not match |
| **`0x36`** | `ExceedNumberOfAttempts` | Security lockout due to consecutive failed key attempts (10s delay) |
| **`0x78`** | `ResponsePending` | Long-running operation active (erase/checksum); host must wait |
---

## 18. Tire Pressure Monitoring System (TPMS) & Wheel Speed Dynamics (`0x593` / `0x4B0` / `0x4B1`)

Tire monitoring and chassis dynamics in the E-GMP architecture span three distinct subsystems:
1. **Periodic Status & Warning Broadcasts (`0x593` / `TPMS11`)**: Broadcast by the Body Control Module (BCM) / TPMS receiver at 100 ms (10 Hz) across C-CAN and bridged to the Instrument Cluster (CLU) and Infotainment Head Unit (IBOX).
2. **Individual Wheel Speed Telemetry (`0x4B0` / `WHL_SPD`)**: Broadcast at 10 ms (100 Hz) / 20 ms (50 Hz) by the Electronic Stability Control (ESC) / ABS module across C-CAN, providing 16-bit rotational wheel speed for all four corners.
3. **High-Resolution Dead-Reckoning Wheel Pulses (`0x4B1` / `WHL_PUL`)**: Broadcast at 20 ms (50 Hz) by the ESC/ABS module. Registered directly in the Mobis Head Unit MICOM firmware at descriptor table offset `0x0207C1` (`B1 04`), used by the onboard navigation dead-reckoning engine during GPS signal loss (e.g., tunnels, underground parking).
4. **On-Demand UDS Diagnostic Telemetry (`0x7D6` / `0x7DE`)**: Diagnostic requests via UDS Mode `0x22` allow querying live individual tire pressures (in PSI or bar) and internal tire temperatures (in °C).

---

### 18.1 TPMS Warning Lamp & Corner Indicators (`0x593` / `TPMS11`)

Broadcast periodically at 100 ms (10 Hz). DLC = 6 bytes. Transmitting node: **BCM / TPMS Module**.

#### Byte 0 (`D1`) Bitfield Layout

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | [1:0] | `0x03` | `TPMS_W_LAMP` | Master TPMS Warning Lamp:<br>`0x00`: Normal / Lamp Off<br>`0x01`: Solid Low Pressure Warning Lamp ON<br>`0x02`: Blinking System Malfunction / Sensor Comm Error |
| `0` | `D1` | [3:2] | `0x0C` | `TREAD_W_LAMP` | Tread & Severe Deflation Alert:<br>`0x00`: Normal<br>`0x04`: Low Tire Pressure Warning Active<br>`0x08`: Severe / Rapid Pressure Loss Warning |
| `0` | `D1` | [4] | `0x10` | `POS_FL_W_LAMP` | Front-Left Tire Warning:<br>`0`: Pressure OK<br>`1`: Front-Left Low Pressure Warning |
| `0` | `D1` | [5] | `0x20` | `POS_FR_W_LAMP` | Front-Right Tire Warning:<br>`0`: Pressure OK<br>`1`: Front-Right Low Pressure Warning |
| `0` | `D1` | [6] | `0x40` | `POS_RL_W_LAMP` | Rear-Left Tire Warning:<br>`0`: Pressure OK<br>`1`: Rear-Left Low Pressure Warning |
| `0` | `D1` | [7] | `0x80` | `POS_RR_W_LAMP` | Rear-Right Tire Warning:<br>`0`: Pressure OK<br>`1`: Rear-Right Low Pressure Warning |

#### Bytes 1–5 (`D2`–`D6`) Status & Sensor Flags

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bitmask | Signal Name | Description |
| :---: | :---: | :---: | :--- | :--- |
| `1` | `D2` | `0x0F` | `TPMS_AliveCounter` | Rolling 4-bit message counter (0 to 15) |
| `1` | `D2` | `0xF0` | `TPMS_SysState` | TPMS Controller Operating State (0: Initializing, 1: Normal, 2: Calibrating) |
| `2` | `D3` | `0x0F` | `TPMS_SensorBatLow_FL` | Front-Left Sensor Battery Low Indicator |
| `2` | `D3` | `0xF0` | `TPMS_SensorBatLow_FR` | Front-Right Sensor Battery Low Indicator |
| `3` | `D4` | `0x0F` | `TPMS_SensorBatLow_RL` | Rear-Left Sensor Battery Low Indicator |
| `3` | `D4` | `0xF0` | `TPMS_SensorBatLow_RR` | Rear-Right Sensor Battery Low Indicator |
| `4` | `D5` | `0xFF` | `TPMS_Reserved` | System status and factory calibration reserved byte |
| `5` | `D6` | `0xFF` | `TPMS_Checksum` | 8-bit CRC / Checksum byte |

#### Verified Frame Examples (`0x593`)
* **All Tires Normal (No Warnings)**:
  `[00 00 00 00 00 00]`
* **Front-Left Low Pressure Warning (`0x10` + `0x01` Lamp + `0x04` Tread = `0x15`)**:
  `[15 00 00 00 00 00]`
* **Rear-Right Low Pressure Warning (`0x80` + `0x01` Lamp + `0x04` Tread = `0x85`)**:
  `[85 00 00 00 00 00]`
* **Both Front Tires Low (`0x30` + `0x01` Lamp + `0x04` Tread = `0x35`)**:
  `[35 00 00 00 00 00]`
* **TPMS Sensor System Fault / Blinking Warning (`0x02`)**:
  `[02 00 00 00 00 00]`

---

### 18.2 ESC 4-Wheel Speed Telemetry (`0x4B0` / `WHL_SPD`)

Broadcast periodically at 10 ms (100 Hz) to 20 ms (50 Hz). DLC = 8 bytes. Transmitting node: **ESC / ABS Module**.
Each wheel speed is represented as a 16-bit big-endian unsigned integer (MSB first).

#### Payload Layout

| Byte Range (0-Indexed) | Byte Range (`can-do`) | Signal Name | Endianness | Formula / Resolution | Valid Range |
| :---: | :---: | :--- | :---: | :--- | :--- |
| `0`–`1` | `D1`–`D2` | `WHL_SPD_FL` | Big-Endian (MSB first) | $\text{Speed (km/h)} = \text{Raw} \times 0.03125$ | $0.0\text{ to }511.9\text{ km/h}$ |
| `2`–`3` | `D3`–`D4` | `WHL_SPD_FR` | Big-Endian (MSB first) | $\text{Speed (km/h)} = \text{Raw} \times 0.03125$ | $0.0\text{ to }511.9\text{ km/h}$ |
| `4`–`5` | `D5`–`D6` | `WHL_SPD_RL` | Big-Endian (MSB first) | $\text{Speed (km/h)} = \text{Raw} \times 0.03125$ | $0.0\text{ to }511.9\text{ km/h}$ |
| `6`–`7` | `D7`–`D8` | `WHL_SPD_RR` | Big-Endian (MSB first) | $\text{Speed (km/h)} = \text{Raw} \times 0.03125$ | $0.0\text{ to }511.9\text{ km/h}$ |

> [!NOTE]
> Alternative platform variants scale raw integers directly in hundredths of a km/h ($\text{Speed} = \text{Raw} / 100$). For standard E-GMP CAN bus logs, the $0.03125$ factor ($1/32$) matches openpilot and factory ESC calibration.
> To convert km/h to mph: $\text{Speed (mph)} = \text{Speed (km/h)} \times 0.621371$.

#### Verified Frame Examples (`0x4B0`)
* **Vehicle Stationary (0.0 km/h on all wheels)**:
  `[00 00 00 00 00 00 00 00]`
* **Vehicle Cruising at ~60.0 km/h (~37.3 mph)** ($\text{Raw} = 60.0 / 0.03125 = 1920 = \text{0x0780}$):
  `[07 80 07 80 07 80 07 80]`
* **Vehicle Cruising at ~100.0 km/h (~62.1 mph)** ($\text{Raw} = 100.0 / 0.03125 = 3200 = \text{0x0C80}$):
  `[0C 80 0C 80 0C 80 0C 80]`

---

### 18.3 Dead-Reckoning Wheel Pulses (`0x4B1` / `WHL_PUL`)

Broadcast periodically at 20 ms (50 Hz). DLC = 8 bytes. Transmitting node: **ESC / ABS Module**.
Registered in the Head Unit MICOM firmware at offset `0x0207C1` (`B1 04`). Each corner maintains a continuous 16-bit pulse counter.

#### Payload Layout

| Byte Range (0-Indexed) | Byte Range (`can-do`) | Signal Name | Endianness | Description |
| :---: | :---: | :--- | :---: | :--- |
| `0`–`1` | `D1`–`D2` | `WHL_PUL_FL` | Big-Endian | Front-Left wheel sensor pulse edge accumulator |
| `2`–`3` | `D3`–`D4` | `WHL_PUL_FR` | Big-Endian | Front-Right wheel sensor pulse edge accumulator |
| `4`–`5` | `D5`–`D6` | `WHL_PUL_RL` | Big-Endian | Rear-Left wheel sensor pulse edge accumulator |
| `6`–`7` | `D7`–`D8` | `WHL_PUL_RR` | Big-Endian | Rear-Right wheel sensor pulse edge accumulator |

> [!TIP]
> The Head Unit navigation engine uses wheel pulse counts (nominally ~48 to 96 pulses per wheel revolution depending on tone ring tooth count and tire circumference) along with steering angle (`0x1CF` / `SAS11`) and yaw rate to accurately track vehicle position through tunnels and parking garages.

---

### 18.4 On-Demand UDS Diagnostic Query for Live Tire Pressures & Temperatures (`0x7D6` / `0x7DE`)

Because raw tire pressures and internal temperatures are transmitted via RF (433.92 MHz) from wheel-mounted sensor transmitters and internalized by the TPMS module, they are read dynamically via UDS Service `0x22` (`ReadDataByIdentifier`):

* **Request CAN ID**: `0x7D6` (TPMS ECU Physical Request)
* **Response CAN ID**: `0x7DE` (TPMS ECU Physical Response)
* **UDS Service**: `0x22` (`ReadDataByIdentifier`)
* **Data Identifier (DID)**: `0x0106` (or `0x2106`)

#### Request Frame
```text
CAN ID: 0x7D6
Payload: [03 22 01 06 00 00 00 00]
```

#### Response Payload Decoding Formulas
The multi-frame ISO-TP response returns an array containing pressure and temperature bytes for each tire position:

| Metric | Raw Byte Offset in Response | Scaling Formula | Unit |
| :--- | :---: | :--- | :---: |
| **Front-Left Pressure** | Byte `e` (offset 14) | $\text{Pressure} = \text{Raw} \times 0.25$ | $\text{PSI}$ |
| **Front-Left Temperature** | Byte `f` (offset 15) | $\text{Temp} = \text{Raw} - 55$ | $^\circ\text{C}$ |
| **Front-Right Pressure** | Byte `m` (offset 22) | $\text{Pressure} = \text{Raw} \times 0.25$ | $\text{PSI}$ |
| **Front-Right Temperature** | Byte `n` (offset 23) | $\text{Temp} = \text{Raw} - 55$ | $^\circ\text{C}$ |
| **Rear-Left Pressure** | Byte `u` (offset 30) | $\text{Pressure} = \text{Raw} \times 0.25$ | $\text{PSI}$ |
| **Rear-Left Temperature** | Byte `v` (offset 31) | $\text{Temp} = \text{Raw} - 55$ | $^\circ\text{C}$ |
| **Rear-Right Pressure** | Byte `ac` (offset 38) | $\text{Pressure} = \text{Raw} \times 0.25$ | $\text{PSI}$ |
| **Rear-Right Temperature** | Byte `ad` (offset 39) | $\text{Temp} = \text{Raw} - 55$ | $^\circ\text{C}$ |

* **Pressure Conversion to Bar**: $\text{Bar} = \text{PSI} \times 0.0689476 \approx \text{Raw} \times 0.01724$ (or $\text{Raw} \times 0.02$).
* **Temperature in Fahrenheit**: $\text{Temp (}^\circ\text{F)} = (\text{Temp (}^\circ\text{C)} \times 1.8) + 32$.
* **Example Calculation**:
  * Raw pressure byte = `0x90` ($144$ decimal): $144 \times 0.25 = 36.0\text{ PSI}$ ($2.48\text{ bar}$).
  * Raw temperature byte = `0x4B` ($75$ decimal): $75 - 55 = 20^\circ\text{C}$ ($68^\circ\text{F}$).
---

## 19. Electronic Parking Brake (EPB), Auto Hold & Braking Dynamics (`0x490` / `0x47F` / `0x220` / `0x412`)

The E-GMP braking system integrates traditional friction braking, high-voltage regenerative deceleration, automated standstill vehicle hold, and electric motorized rear caliper clamping. Telemetry spans the Electronic Parking Brake module (`EPB`), Electronic Stability Control / Integrated Electronic Brake (`ESC` / `IEB`), and Body Control Module (`BCM`).

---

### 19.1 Electronic Parking Brake Module (`0x490` / `EPB11`)

Broadcast periodically at 10 ms (100 Hz) to 20 ms (50 Hz). DLC = 7 or 8 bytes. Transmitting node: **EPB Module**.
Handled directly in the Head Unit MICOM firmware at assembly offset `0x0417A1` (`mov 0x490, rX`):

#### Byte 0 (`D1`) Bitfield Layout

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | [1:0] | `0x03` | `EPB_I_LAMP` | Parking Brake Indicator Lamp:<br>`0x00`: Released (Park brake disengaged, indicator off)<br>`0x01`: Clamped / Engaged (Solid red "PARK" / brake lamp ON)<br>`0x02`: Transitioning / Blinking (Motor clamping or releasing in progress)<br>`0x03`: State invalid / error |
| `0` | `D1` | [2] | `0x04` | `EPB_F_LAMP` | EPB Fault / Warning Lamp:<br>`0`: Normal operation<br>`1`: System Malfunction (Amber EPB warning light ON) |
| `0` | `D1` | [3] | `0x08` | `EPB_ALARM` | Acoustic Alert Request:<br>`0`: Silent<br>`1`: Chime / Warning buzzer active |
| `1` | `D2` | [1:0] | `0x03` | `EPB_SwitchStatus` | Physical Console EPB Switch:<br>`0x00`: Neutral / Idle<br>`0x01`: Pulled UP (Manual apply command)<br>`0x02`: Pushed DOWN (Manual release command) |

#### Verified Frame Examples (`0x490`)
* **Parking Brake Released (Driving Normally)**:
  `[00 00 00 00 00 00 00 00]`
* **Parking Brake Clamped / Engaged (`0x01` in `D1`)**:
  `[01 00 00 00 00 00 00 00]`
* **Parking Brake Clamping/Releasing Transition (`0x02` in `D1`)**:
  `[02 00 00 00 00 00 00 00]`
* **EPB System Fault Lamp Active (`0x04` in `D1`)**:
  `[04 00 00 00 00 00 00 00]`

---

### 19.2 Automatic Vehicle Hold (`0x47F` / `ESP11`)

Broadcast periodically at 10 ms (100 Hz). DLC = 6 bytes. Transmitting node: **ESC Module**.
Auto Hold allows the driver to release the physical brake pedal at a complete stop while maintaining hydraulic line pressure until the accelerator pedal is depressed.

#### Byte 0 (`D1`) Bitfield Layout

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | [1:0] | `0x03` | `AVH_STAT` | Auto Vehicle Hold Operational State:<br>`0x00`: Auto Hold OFF (System deactivated by driver)<br>`0x01`: Auto Hold STANDBY (White indicator on cluster - system armed, vehicle moving or brake not firmly latched)<br>`0x02`: Auto Hold ACTIVE / HOLDING (Green indicator on cluster - standstill hydraulic brake pressure locked at 0 km/h)<br>`0x03`: Auto Hold FAULT / Warning (Amber indicator on cluster) |

#### Verified Frame Examples (`0x47F`)
* **Auto Hold Deactivated**:
  `[00 00 00 00 00 00]`
* **Auto Hold Standby (Armed / White Dash Lamp)**:
  `[01 00 00 00 00 00]`
* **Auto Hold Active (Braking Locked / Green Dash Lamp)**:
  `[02 00 00 00 00 00]`
* **Auto Hold System Malfunction (Amber Dash Lamp)**:
  `[03 00 00 00 00 00]`

---

### 19.3 Master Cylinder Hydraulic Brake Line Pressure (`0x220` / `ESP12`)

Broadcast periodically at 10 ms (100 Hz). DLC = 8 bytes. Transmitting node: **ESC / Integrated Electronic Brake (IEB)**.
Reports high-frequency physical brake line pressure used by the Vehicle Control Unit (VCU) for blending regenerative electric deceleration with mechanical friction calipers.

#### Payload Layout

| 0-Indexed Start Bit | 1-Based Bytes (`can-do`) | Length | Endianness | Signal Name | Scaling & Formula | Range |
| :---: | :---: | :---: | :---: | :--- | :--- | :---: |
| `26` | `D4`–`D5` | 12 bits | Intel (Little-Endian) | `CYL_PRES` | $\text{Pressure (Bar)} = \text{Raw} \times 0.1\text{ bar}$<br>$\text{Pressure (PSI)} = \text{Raw} \times 1.45038\text{ psi}$ | $0.0\text{ to }409.5\text{ bar}$<br>($0\text{ to }5939\text{ psi}$) |
| `38` | `D5` | 1 bit | - | `CYL_PRES_STAT` | Sensor Validity: `0` = Valid, `1` = Sensor Fault | $0\text{ or }1$ |
| `0` | `D1`–`D2` | 11 bits | Intel (Little-Endian) | `LAT_ACCEL` | $\text{Lateral Accel (m/s}^2\text{)} = (\text{Raw} \times 0.01) - 10.23$ | $-10.23\text{ to }+10.24\text{ m/s}^2$ |

* **Formula Details**:
  $$\text{Pressure (Bar)} = \frac{\text{Raw}_{12\text{-bit}}}{10}$$
  $$\text{Pressure (PSI)} = \text{Pressure (Bar)} \times 14.5038$$
* **Example Calculation**:
  * Raw value = `350` (`0x15E`): $350 \times 0.1 = 35.0\text{ bar}$ ($507.6\text{ psi}$ — moderate driver braking).
  * Raw value = `1200` (`0x4B0`): $1200 \times 0.1 = 120.0\text{ bar}$ ($1740.5\text{ psi}$ — emergency hard braking).

---

### 19.4 Driver Brake Pedal Switch (`0x412` / `Brake_Pedal_Status`)

Broadcast periodically at 100 ms (10 Hz). DLC = 8 bytes. Transmitting node: **BCM / IPM**.

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `6` | `D7` | [2] | `0x04` | `CF_Bcm_BrakePedalSw` | Primary Brake Light Switch:<br>`0x00`: Released (Driver foot off brake)<br>`0x04`: Depressed / Pressed (Foot on brake pedal, brake lights active) |
---

## 20. Advanced Driver Assistance Systems (ADAS), Smart Cruise & Smart Summon (`0x38C` / `0x420` / `0x421` / `0x38D` / `0x203`)

The E-GMP ADAS suite coordinates radar sensors, forward cameras, ultrasonic perimeter transceivers, and steering/braking actuators across high-speed CAN networks.

---

### 20.1 Remote Smart Parking Assist / Smart Summon (`0x38C` / `RSPA11`)

Broadcast periodically at 20 ms (50 Hz). DLC = 8 bytes. Transmitting node: **ADAS Parking Controller (`ADAS_PRK`) / Smart Key Unit**.
Handled directly in the Head Unit MICOM firmware at offset `0x041961` (`7D 8C 03`):

#### Payload Layout

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | [3:0] | `0x0F` | `RSPA_DriveRequest` | Remote Motion Command / State:<br>`0x00`: RSPA Idle / Disengaged<br>`0x01`: Remote Forward Drive Request (vehicle crawls forward at $\le 2	ext{--}3	ext{ km/h}$)<br>`0x02`: Remote Reverse Drive Request (vehicle crawls backward at $\le 2	ext{--}3	ext{ km/h}$)<br>`0x0F`: Emergency Halt / Obstacle Abort (calipers instantly clamped) |
| `1` | `D2` | [7:0] | `0xFF` | `RSPA_TargetSpeed` | Commanded target crawling velocity ($0.1	ext{ km/h}$ resolution, typically $2.5	ext{ km/h}$) |
| `2` | `D3` | [7:0] | `0xFF` | `RSPA_DistanceRemaining`| Distance to target parking envelope endpoint ($0.01	ext{ m}$ resolution) |

#### Verified Frame Examples (`0x38C`)
* **RSPA Idle / Normal Driving**:
  `[00 00 00 00 00 00 00 00]`
* **Remote Forward Summon Crawl (`0x01` in `D1`)**:
  `[01 19 00 00 00 00 00 00]` ($19	ext{ hex} = 25	ext{ dec} = 2.5	ext{ km/h}$)
* **Remote Reverse Summon Crawl (`0x02` in `D1`)**:
  `[02 19 00 00 00 00 00 00]`
* **Emergency Halt / Obstacle Triggered (`0x0F` in `D1`)**:
  `[0F 00 00 00 00 00 00 00]`

---

### 20.2 Smart Cruise Control Acceleration & Standstill Hold (`0x420` / `SCC11`)

Broadcast periodically at 20 ms (50 Hz). DLC = 8 bytes. Transmitting node: **Front Radar Module (`SCC`)**.

#### Payload Layout

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0`–`1` | `D1`–`D2` | [10:0] | `0x07FF` | `aReqValue` | Longitudinal Acceleration Request:<br>Signed 11-bit integer, scale $0.01	ext{ m/s}^2$<br>Range: $-10.23	ext{ to }+10.24	ext{ m/s}^2$ |
| `2` | `D3` | [0] | `0x01` | `StopReq` | Standstill Brake Hold Request:<br>`0`: Active cruising / deceleration<br>`1`: Standstill Hold (Stop & Go traffic latch at 0 km/h) |

---

### 20.3 Smart Cruise Lead Vehicle & Distance Gaps (`0x421` / `SCC12`)

Broadcast periodically at 50 ms (20 Hz). DLC = 8 bytes. Transmitting node: **Front Radar Module (`SCC`)**.

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | [0] | `0x01` | `CF_VS_VehPresent` | Lead Vehicle Present Ahead:<br>`0`: Open road (No lead target)<br>`1`: Lead vehicle locked ahead |
| `1` | `D2` | [7:0] | `0xFF` | `VSetDis` | Cruise Set Speed ($1	ext{ km/h}$ integer, e.g. `0x46` = 70 km/h) |
| `2` | `D3` | [2:0] | `0x07` | `DistFolder` | Following Distance Gap Setting (1 to 4 bars):<br>`0x01`: Gap 1 (Shortest, ~1.0s)<br>`0x02`: Gap 2 (~1.3s)<br>`0x03`: Gap 3 (~1.6s)<br>`0x04`: Gap 4 (Longest, ~2.1s) |

---

### 20.4 Forward Collision-Avoidance Assist (`0x38D` / `FCA11`)

Broadcast periodically at 20 ms (50 Hz). DLC = 8 bytes. Transmitting node: **Front Safety Camera / Radar Fusion Controller**.

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `0` | `D1` | [1:0] | `0x03` | `FCA_Warn` | Collision Warning Stage:<br>`0x00`: No Warning<br>`0x01`: Level 1 Alert (Visual popup + low chime)<br>`0x02`: Level 2 Alert (Urgent visual + rapid acoustic alarm + brake pre-fill)<br>`0x03`: Level 3 Intervention (Autonomous Emergency Braking clamped) |
| `1` | `D2` | [0] | `0x01` | `FCA_Act` | Active Autonomous Emergency Braking (AEB):<br>`0`: Inactive<br>`1`: Active AEB Deceleration Clamped |

---

### 20.5 Lane Following Assist (LFA) & Highway Driving Assist (`0x203` / `LFA_ALT`)

Broadcast periodically at 20 ms (50 Hz). DLC = 8 to 24 bytes (CAN-FD layout). Transmitting node: **Front View Camera (`FCU_C`) / Central Gateway**.

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `3` | `D4` | [3:0] | `0x0F` | `ADAS_ActvACISta` | LFA Operating State:<br>`0x00`: LFA Off<br>`0x01`: LFA Standby (White lane icon on cluster — searching for lane lines)<br>`0x02`: LFA Active / Steering (Green lane icon on cluster — actively centering vehicle between lines)<br>`0x03`: Hands-Off Alert Level 1 (Visual warning to hold steering wheel)<br>`0x04`: Hands-Off Alert Level 2 (Acoustic alarm + red wheel alert) |
| `4`–`5` | `D5`–`D6` | [13:0] | `0x3FFF` | `ADAS_StrAnglReqVal` | Commanded Steering Angle Request: Signed 14-bit, scale $0.1^\circ$ |
| `7` | `D8` | [1:0] | `0x03` | `FCA_ESA_ActvSta` | Evasive Steering Assist (ESA) Active Flag (`0` = Off, `1` = Active) |
---

## 21. Blind-Spot Collision-Avoidance Assist (BCA), Rear Cross-Traffic & Safe Exit Assist (`0x1BA` / `0x391` / `0x393`)

The E-GMP blind-spot safety suite is driven by dual 77 GHz Rear Corner Radars (`RR_C_RDR`) mounted inside the rear bumper corners, interfaced across the central gateway and Head Unit MICOM (descriptor table offset `0x028D45` / handler `0x04E462`).

---

### 21.1 Subsystem Functional Scope

1. **Blind-Spot Collision Warning (BCW)**:
   - Operates at vehicle speeds $\ge 20	ext{ km/h}$ ($\ge 12	ext{ mph}$).
   - Solid Amber Mirror LED (`0x01`): Indicates an approaching vehicle detected within the adjacent lane blind-spot zone.
   - Flashing Amber LED + Acoustic Chime (`0x02`): Triggers when the driver activates the turn signal toward an occupied blind-spot lane.
2. **Blind-Spot Collision-Avoidance Assist (BCA)**:
   - In imminent collision scenarios where the vehicle drifts toward an occupied lane, BCA commands asymmetric single-sided caliper braking (`Brake_Control_RL` / `Brake_Control_RR`) through the ESC to yaw the vehicle back into its lane.
3. **Rear Cross-Traffic Collision-Avoidance Assist (RCCA / RCTA)**:
   - Active when shifting into Reverse (`R`).
   - Scans 180° perpendicular to the rear bumper up to 25 meters away for approaching cross-traffic.
   - Broadcasts left/right directional warning arrows to the instrument cluster and triggers autonomous emergency brake clamping.
4. **Safe Exit Assist (SEA)**:
   - When the vehicle is stopped, monitors approaching traffic from the rear.
   - Overrides the electronic rear child lock to keep rear doors latched if a passenger attempts to open a door into oncoming traffic or bicycles.

---

### 21.2 Message Payload Specifications (`0x1BA` / `442` & `0x391`)

Broadcast periodically at 50 ms (20 Hz). DLC = 24 bytes (CAN-FD) or 8 bytes (C-CAN). Transmitting node: **Rear Corner Radar (`RR_C_RDR`) / Central Gateway**.

#### Bitfield Layout

| 0-Indexed Byte | 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :---: | :--- | :--- |
| `3` | `D4` | [1:0] | `0x03` | `BCW_LtIndSta` | Left Blind-Spot Indicator Status:<br>`0x00`: No Detection / Blind Spot Clear<br>`0x01`: Vehicle Detected (Solid Amber LED in Left Mirror)<br>`0x02`: Flashing Alert (Turn signal active + Vehicle in blind spot)<br>`0x03`: Reserved / Invalid |
| `3` | `D4` | [3:2] | `0x0C` | `BCW_LtSndWrngSta` | Left Acoustic Warning Chime: `0` = Silent, `1` = Beep / Alarm |
| `4` | `D5` | [1:0] | `0x03` | `BCW_RtIndSta` | Right Blind-Spot Indicator Status:<br>`0x00`: No Detection / Blind Spot Clear<br>`0x01`: Vehicle Detected (Solid Amber LED in Right Mirror)<br>`0x02`: Flashing Alert (Turn signal active + Vehicle in blind spot)<br>`0x03`: Reserved / Invalid |
| `4` | `D5` | [3:2] | `0x0C` | `BCW_RtSndWrngSta` | Right Acoustic Warning Chime: `0` = Silent, `1` = Beep / Alarm |
| `9` | `D10` | [3:0] | `0x0F` | `BCA_DRV_WarnSta` | BCA Avoidance State:<br>`0x00`: Inactive / Monitoring<br>`0x01`: Warning Stage 1<br>`0x02`: Active Asymmetric Braking Intervention |
| `16` | `D17` | [1:0] | `0x03` | `OSMrrLamp_LtIndSta` | Outside Left Mirror LED Physical Output (`0` = Off, `1` = On, `2` = Blink) |
| `16` | `D17` | [3:2] | `0x0C` | `OSMrrLamp_RtIndSta` | Outside Right Mirror LED Physical Output (`0` = Off, `1` = On, `2` = Blink) |

#### Verified Frame Examples (`0x1BA`)
* **All Blind Spots Clear (Normal Driving)**:
  `[00 00 00 00 00 00 00 00 ...]`
* **Vehicle Detected in Left Blind Spot (`D4 = 0x01`)**:
  `[00 00 00 01 00 00 00 00 ...]` (Solid Amber LED on Left Mirror)
* **Vehicle in Left Blind Spot + Left Turn Signal Active (`D4 = 0x06`)**:
  `[00 00 00 06 00 00 00 00 ...]` (`0x02` flashing + `0x04` chime active)
* **Vehicle Detected in Right Blind Spot (`D5 = 0x01`)**:
  `[00 00 00 00 01 00 00 00 ...]` (Solid Amber LED on Right Mirror)
* **Vehicles in Both Blind Spots (`D4 = 0x01`, `D5 = 0x01`)**:
  `[00 00 00 01 01 00 00 00 ...]`
---

## 22. Surround View Monitor (SVM), Parking Distance Warning (PDW) & Camera Video Multiplexing (`0x476` / `0x477` / `0x436` / `0x434`)

The E-GMP 360° Surround View Monitor (SVM) and Parking Distance Warning (PDW / PAS) architecture coordinates 4 wide-angle mega-pixel cameras (front grille, tailgate, left/right exterior mirrors) and 8-12 ultrasonic distance transceivers through dedicated image processing and parking assistance ECUs.

---

### 22.1 Subsystem Functional Scope & Head Unit Hardware Trigger

1. **Hardware Video Multiplexer Switching**:
   - In the Mobis STD5W Head Unit MICOM (`dec_micom_sw.bin`), gear status from CAN ID `0x434` / `0x45` (`GEAR = R`) or the physical cockpit "View" button (`0x4A2` / `0x448`) triggers the camera controller:
     - `0x0FF338`: `DrvGpio_Camera_Pwr on` (energizes camera and SVM sensor power supply rail).
     - `0x0C82CA`: `SET CAMERA` (instructs the video multiplexer hardware to switch the display stream from Linux application framebuffer to the low-latency analog/LVDS camera feed with trajectory guideline overlays).
2. **Surround View Camera Control (`0x476`)**:
   - Broadcast from the Head Unit / Central Gateway to the SVM ECU requesting camera power and view perspectives.
3. **Surround View Camera Status (`0x477`)**:
   - Broadcast from the Surround View Camera ECU to report active perspective (Rear, Front, Top-Down 360°, Curb / Side View) and dynamic trajectory guideline status.
4. **Parking Distance Warning / Ultrasonic Sensors (`0x436`, `PAS11`)**:
   - Consolidated ultrasonic distance zone readings and acoustic beep frequency stages across Front Left, Front Center, Front Right, Rear Left, Rear Center, and Rear Right bumper sensors.

---

### 22.2 Message Specifications: Surround View Camera (`0x476` & `0x477`)

Broadcast periodically at 50 ms (20 Hz). DLC = 8 bytes.

#### Camera Control (`0x476` / `1142` dec)

| 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :--- | :--- |
| `D1` | [0] | `0x01` | `SVC_PowerReq` | Camera System Power Request:<br>`0x00`: Off / Standby<br>`0x01`: Active / Camera Energized |
| `D3` | [7:0] | `0xFF` | `SVC_ViewModeCmd` | Requested View Perspective:<br>`0x42`: Rear Camera Feed + 360° Top View<br>`0x52`: Front Camera Feed + 360° Top View |
| `D8` | [7:0] | `0xFF` | `SVC_AliveCnt` | Rolling Counter / Checksum flag (`0x03`) |

#### Camera Status (`0x477` / `1143` dec)

| 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :--- | :--- |
| `D1` | [7:0] | `0xFF` | `SVC_ActiveViewStatus` | Active Camera Perspective:<br>`0x00`: Camera System Off / Standby<br>`0x41`: Rear Camera Active (Reverse Feed + 360° Top View)<br>`0x42`: Front Camera Active (Forward Feed + 360° Top View) |
| `D2` | [7:0] | `0xFF` | `SVC_GuidelineStatus` | Trajectory Guidelines & Angle:<br>`0x00`: Standby / Off<br>`0x01`: Standard Angle View<br>`0x3D`: Wide Angle View with Dynamic Steering Trajectory Guidelines |
| `D3` | [7:0] | `0xFF` | `SVC_ModeByte3` | Operating Mode (`0x20` normal operation) |
| `D4` | [7:0] | `0xFF` | `SVC_ModeByte4` | System Ready Flag (`0x01` ready) |
| `D5-D8` | [31:0] | `0xFF` | `SVC_DiagBytes` | Calibration & Diagnostic Signature (`B3 11 0C 04`) |

---

### 22.3 Message Specifications: Parking Distance Warning Ultrasonic Sensors (`0x436`, `PAS11`)

Broadcast periodically at 100 ms (10 Hz). DLC = 8 bytes. Transmitting node: **PDW / PAS ECU (`1078` dec)**.

| 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :--- | :--- |
| `D1` | [2:0] | `0x07` | `CF_Gway_PASDisplayFLH` | Front Left Sensor Distance Zone (`0`=Clear, `1`=Far ~100cm, `2`=Mid ~60cm, `3`=Close ~30cm) |
| `D1` | [5:3] | `0x38` | `CF_Gway_PASDisplayFRH` | Front Right Sensor Distance Zone (`0`=Clear, `1`=Far, `2`=Mid, `3`=Close) |
| `D1` | [7:6] | `0xC0` | `CF_Gway_PASRsound` | Rear Acoustic Chime Frequency: `0`=Silent, `1`=Slow Beep, `2`=Fast Beep, `3`=Continuous Tone |
| `D2` | [2:0] | `0x07` | `CF_Gway_PASDisplayFCTR` | Front Center Sensor Distance Zone (`0`=Clear, `1`=Far, `2`=Mid, `3`=Close) |
| `D2` | [5:3] | `0x38` | `CF_Gway_PASDisplayRCTR` | Rear Center Sensor Distance Zone (`0`=Clear, `1`=Far, `2`=Mid, `3`=Close) |
| `D2` | [7:6] | `0xC0` | `CF_Gway_PASFsound` | Front Acoustic Chime Frequency: `0`=Silent, `1`=Slow Beep, `2`=Fast Beep, `3`=Continuous Tone |
| `D3` | [2:0] | `0x07` | `CF_Gway_PASDisplayRLH` | Rear Left Sensor Distance Zone (`0`=Clear, `1`=Far, `2`=Mid, `3`=Close) |
| `D3` | [5:3] | `0x38` | `CF_Gway_PASDisplayRRH` | Rear Right Sensor Distance Zone (`0`=Clear, `1`=Far, `2`=Mid, `3`=Close) |
| `D4` | [1:0] | `0x03` | `CF_Gway_PASSystemOn` | PDW System State: `0`=Off, `1`=Active / Monitoring, `2`=Fault / Sensor Blocked |

#### Verified Frame Examples
* **Surround View Standby (Driving Forward > 15 km/h)**:
  `0x476`: `00 00 52 00 00 00 00 03`
  `0x477`: `00 00 78 00 30 00 30 00`
* **Reverse Engaged (`GEAR = R`), Rear Camera + 360° Top View Active with Guidelines**:
  `0x476`: `01 00 42 00 00 00 00 03`
  `0x477`: `41 3D 20 01 B3 11 0C 04`
* **Cockpit "View" Button Pressed, Front Camera + 360° Top View Active**:
  `0x476`: `01 00 52 00 00 00 00 03`
  `0x477`: `42 3D 20 01 B3 11 0C 04`
---

## 23. Vehicle-to-Load (V2L) & Bi-Directional Power Export (`0x578` / `0x5D0` / `0x598` / `0x4F0`)

E-GMP vehicles feature an Integrated Charging Control Unit (ICCU) capable of bidirectional AC power export (Vehicle-to-Load / V2L) up to 3.6 kW (230V / 16A in Europe/Asia or 120V / 15A–20A in North America). V2L powers an internal cabin 120V/230V AC socket under the rear seat and an external charging-port V2L adapter plug.

---

### 23.1 Subsystem Functional Scope & Safety Interlocks

1. **Discharge Threshold Protection & Edge Control**:
   - Direct edge control of the minimum V2L reserve threshold is commanded over CAN ID `0x0C7` (`D2`) with telemetry feedback monitored on `0x151` (`D7`) (see **Section 4.6** for full command and timing details).
   - When the High-Voltage Battery System drains down to the configured cutoff SOC, the ICCU immediately de-energizes the bi-directional inverter, trips the adapter output relay, and posts an acoustic/visual banner on the instrument cluster.
2. **AC Charging Current Derating (`0x578`)**:
   - Configures maximum continuous current draw during Level 2 AC charging:
     - `0x02`: **Maximum (100%)** — Full 32A / 48A circuit capacity.
     - `0x01`: **Reduced (90%)** — Derates current draw by ~10% to protect aging household branch circuits.
     - `0x00`: **Minimum (60%)** — Derates current draw by ~40% (e.g. 16A on a 32A circuit).
3. **Hardware Adapter Detection & Mode Negotiation**:
   - The exterior V2L adapter contains a specific passive resistance encoding between the Proximity Pilot (PP) and PE pins. When inserted into the vehicle's charge receptacle, the ICCU detects the V2L impedance, locks the charge inlet motorized latch, and signals the VCU to approve high-voltage contactor closure.

---

### 23.2 Message Specifications: EV Configuration (`0x578`, `EV_CP5`)

Broadcast periodically at 100 ms (10 Hz). DLC = 8 bytes. Transmitting node: **Head Unit (`AVN`) / Central Gateway**. Receiving nodes: **VCU (`0x4F0`), ICCU / OBC (`0x598`)**.

| 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :--- | :--- |
| `D3` | [1:0] | `0x03` | `AC_Current_Limit` | AC Charging Current Derate Mode:<br>`0x00`: Minimum (60% derated current draw)<br>`0x01`: Reduced (90% derated current draw)<br>`0x02`: Maximum (100% full rating) |
| `D4` | [7:0] | `0xFF` | `V2L_Discharge_SOC_Limit` | Head Unit Displayed Cutoff Threshold (telemetry mirror; active bus actuation via `0x0C7` / `0x151`) |

#### Verified Frame Examples (`0x578`)
* **Standard Factory Default (Max AC Current)**:
  `[00 00 02 14 00 00 00 00]`
* **Reduced AC Current (90%)**:
  `[00 00 01 14 00 00 00 00]`
* **Minimum AC Current (60%)**:
  `[00 00 00 14 00 00 00 00]`
---

## 24. Active Air Flaps (AAF) & Thermal Aerodynamics (`0x584`)

E-GMP vehicles (Kia EV6, Hyundai Ioniq 5/6, Genesis GV60) feature dual motorized Active Air Flap shutters integrated into the front lower bumper intake. The flaps dynamically modulate frontal airflow between aerodynamic drag reduction (cruising efficiency) and high-volume cooling (DC ultra-fast charging, high-load hill climbs, or extreme ambient HVAC demand).

---

### 24.1 Subsystem Functional Scope & Control Strategy

1. **Aerodynamic Drag Reduction ($C_d$)**:
   - At highway speeds ($\ge 80	ext{ km/h}$ / $\ge 50	ext{ mph}$), when battery and power electrics coolant temperatures remain below thermal thresholds ($< 35^\circ	ext{C}$), the flaps close completely (`0x00`). This smooths frontal airflow, directing air beneath the flat aerodynamic underbody trays and reducing the vehicle drag coefficient ($C_d$) to as low as 0.21–0.28 depending on vehicle model.
2. **Intermediate & Thermal Cooling Demand**:
   - The Vehicle Control Unit (VCU) and Thermal Management System (TMS) command intermediate positions (`0x01` ~50% partial open or dynamic percentage `0-100%`) during moderate air conditioning compressor load or gentle regenerative braking thermal cycles.
3. **Ultra-Fast DC Charging & Heavy Dissipation**:
   - During 800V DC ultra-fast charging (up to 240–350 kW), high-voltage coolant chillers dissipate massive heat loads. The flaps rotate to 100% full open (`0x02`), accompanied by maximum cooling fan RPM, ensuring the battery pack stays within the optimal charging envelope.
4. **Anti-Pinch & Ice Jamming Failsafe**:
   - If freezing rain or road debris obstructs shutter rotation, the AAF ECU detects motor stall current, sets `CF_Aaf_ModeStatus = 0x02` (Failsafe), activates `CF_Aaf_WrnLamp`, and holds the flaps in the safest open position to prevent powertrain overheating.

---

### 24.2 Message Specifications: Active Air Flaps (`0x584`, `AAF11`)

Broadcast periodically at 100 ms (10 Hz). DLC = 8 bytes. Transmitting node: **Active Air Flap Controller (`AAF11` / `1412` dec)**. Receiving nodes: **VCU, Instrument Cluster (`CLU`), Engine/Motor Management (`EMS`)**.

#### Bitfield Layout

| 1-Based Byte (`can-do`) | Bits | Bitmask | Signal Name | Values & Functional Description |
| :---: | :---: | :---: | :--- | :--- |
| `D1` | [1:0] | `0x03` | `CF_Aaf_ActFlapStatus` | **Actual Air Flap Physical Position**:<br>`0x00`: Fully Closed (Drag Reduction)<br>`0x01`: Intermediate / Partial Open (~50%)<br>`0x02`: Fully Open (Maximum Cooling Airflow)<br>`0x03`: Initializing / Error |
| `D1` | [4:2] | `0x1C` | `CF_Aaf_ModeStatus` | **AAF Operating Mode**:<br>`0x00`: Automatic Thermal Control<br>`0x04`: Manual Test / Diagnostic Mode<br>`0x08`: Failsafe Protection Mode |
| `D1` | [5] | `0x20` | `CF_Aaf_WrnLamp` | **Cluster Warning Lamp Request**: `0` = Off, `1` = Warning Active |
| `D4` | [7:0] | `0xFF` | `CF_Aaf_PStatus` | **Flap Open Percentage**: `0%` (0x00) to `100%` (0x64) |

#### Verified Frame Examples (`0x584`)
* **Highway Cruising (Flaps Fully Closed, 0% Open)**:
  `[00 00 00 00 00 00 00 00]`
* **Moderate HVAC / Cooling Load (Intermediate ~50% Open)**:
  `[01 00 00 32 00 00 00 00]` (`D1 = 0x01`, `D4 = 0x32` / 50%)
* **350 kW DC Fast Charging (Flaps Fully Open, 100% Airflow)**:
  `[02 00 00 64 00 00 00 00]` (`D1 = 0x02`, `D4 = 0x64` / 100%)
* **Ice Jamming / Stall Warning (Failsafe Mode + Warning Lamp Active)**:
  `[2A 00 00 64 00 00 00 00]` (`D1 = 0x2A`: `0x02` open + `0x08` failsafe + `0x20` warning lamp)
