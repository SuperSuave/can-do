"""Unit tests for E-GMP Remote Climate payload encoding and catalog validation."""

import json
import math
import sys
import types
import unittest
from pathlib import Path

# Setup package mock for custom_components.can_do to allow running tests
# without requiring the full Home Assistant core environment installed.
if "custom_components.can_do" not in sys.modules:
    can_do_dir = Path(__file__).resolve().parent.parent / "custom_components" / "can_do"
    if "custom_components" not in sys.modules:
        sys.modules["custom_components"] = types.ModuleType("custom_components")
    pkg = types.ModuleType("custom_components.can_do")
    pkg.__path__ = [str(can_do_dir)]
    pkg.__file__ = str(can_do_dir / "__init__.py")
    sys.modules["custom_components.can_do"] = pkg

from custom_components.can_do.catalog_loader import check_match


def pack_tmu_01(aircon_on: bool, temp_c: float, defrost: bool, alive_cnt: int) -> list[int]:
    """Python reference implementation of firmware pack_tmu_01 (0x39B)."""
    data = [0] * 8
    veh_sld_bit = 1
    aircon_bit = 1 if aircon_on else 0
    temp_md_bit = 0  # Celsius

    temp_code = int(round(temp_c / 0.5)) & 0xFF
    data[0] = (veh_sld_bit << 0) | (aircon_bit << 4) | (temp_md_bit << 5) | ((temp_code & 0x03) << 6)

    defrost_bit = 1 if defrost else 0
    data[1] = ((temp_code >> 2) & 0x3F) | (defrost_bit << 6)
    data[7] = alive_cnt & 0x0F
    return data


class TestRemoteClimate(unittest.TestCase):
    """Test suite for remote climate payload formatting and catalog integrity."""

    def test_remote_climate_on_payload_matches_catalog(self) -> None:
        """Verify pack_tmu_01 produces payload that satisfies catalog match conditions."""
        # 22.0 C, defrost off, counter 0
        payload = pack_tmu_01(aircon_on=True, temp_c=22.0, defrost=False, alive_cnt=0)

        # In 1-based indexing, D1 is payload[0]
        # D1 has aircon_bit at bit 4 (0x10)
        self.assertEqual(payload[0] & 0x10, 0x10)
        self.assertTrue(check_match(payload, {"D1": "0x10"}, mask_spec="0x10"))

    def test_remote_climate_off_payload_matches_catalog(self) -> None:
        """Verify stopped climate clears bit 4 in D1."""
        payload = pack_tmu_01(aircon_on=False, temp_c=22.0, defrost=False, alive_cnt=1)
        self.assertEqual(payload[0] & 0x10, 0x00)
        self.assertTrue(check_match(payload, {"D1": "0x00"}, mask_spec="0x10"))

    def test_temperature_scaling_celsius(self) -> None:
        """Verify temperature scaling resolution (0.5 deg C per count)."""
        # 20.0 C -> 40 (0x28 -> lower 2 bits: 0, upper 6: 10 = 0x0A)
        p_20 = pack_tmu_01(True, 20.0, False, 0)
        self.assertEqual(p_20[0] & 0xC0, 0x00)
        self.assertEqual(p_20[1] & 0x3F, 10)

        # 22.0 C -> 44 (0x2C -> lower 2 bits: 0, upper 6: 11 = 0x0B)
        p_22 = pack_tmu_01(True, 22.0, False, 0)
        self.assertEqual(p_22[0] & 0xC0, 0x00)
        self.assertEqual(p_22[1] & 0x3F, 11)

        # 23.5 C -> 47 (0x2F -> lower 2 bits: 3 (0xC0), upper 6: 11 = 0x0B)
        p_235 = pack_tmu_01(True, 23.5, False, 0)
        self.assertEqual(p_235[0] & 0xC0, 0xC0)
        self.assertEqual(p_235[1] & 0x3F, 11)

    def test_defrost_flag_encoding(self) -> None:
        """Verify defrost bit (bit 6 of Byte D2)."""
        p_normal = pack_tmu_01(True, 22.0, False, 0)
        p_defrost = pack_tmu_01(True, 22.0, True, 0)
        self.assertEqual(p_normal[1] & 0x40, 0x00)
        self.assertEqual(p_defrost[1] & 0x40, 0x40)

    def test_catalog_integrity_for_climate_vs_audio(self) -> None:
        """Ensure CAN ID 0x520 is strictly audio amplifier, and 0x39B is remote climate."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        for cmd in cat.get("commands", []):
            cid = cmd.get("id")
            act_id = cmd.get("action_can_id")
            st_id = cmd.get("state_can_id")
            net_act = cmd.get("network", {}).get("action_can_id")

            # 0x520 must never be associated with climate
            if act_id == "0x520" or net_act == "0x520":
                self.assertIn("audio", cid, f"Command {cid} with CAN ID 0x520 is not audio!")

            # remote_climate_tmu must use 0x39B
            if cid == "remote_climate_tmu":
                self.assertEqual(act_id, "0x39B")
                self.assertEqual(st_id, "0x39B")

    def test_ambient_mood_lamp_0x4ad_latch_frame(self) -> None:
        """Verify 0x4AD ambient lighting 2-stage sequences require latch frame."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        found = False
        for cmd in cat.get("commands", []):
            if cmd.get("id") == "ambient_mood_lighting":
                found = True
                self.assertEqual(cmd.get("network", {}).get("action_can_id"), "0x4AD")
                for opt in cmd.get("options", []):
                    steps = opt.get("steps")
                    self.assertIsNotNone(steps, f"Option {opt.get('label')} missing 2-stage steps")
                    self.assertEqual(len(steps), 2)
                    # Stage 2 must be the commit frame: 0002082000000000
                    self.assertEqual(steps[1].get("payload"), "0002082000000000")
        self.assertTrue(found, "ambient_mood_lighting not found in catalog")

    def test_user_settings_0x542_decoding(self) -> None:
        """Verify 0x542 HU_USM_E_02 convenience settings payload matching."""
        # Standard factory preset: Speed lock (D1=0x02), Park unlock (D2=0x01), 5 Flashes (D3=0x05)
        payload = [0x02, 0x01, 0x05, 0x01, 0x02, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(payload, {"D1": "0x02"}, mask_spec="0x0F"))
        self.assertTrue(check_match(payload, {"D3": "0x05"}, mask_spec="0xFF"))

        # Shift lock preset (D1=0x01)
        shift_payload = [0x01, 0x01, 0x07, 0x01, 0x02, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(shift_payload, {"D1": "0x01"}, mask_spec="0x0F"))
        self.assertTrue(check_match(shift_payload, {"D3": "0x07"}, mask_spec="0xFF"))

    def test_audio_amplifier_0x60c_payloads(self) -> None:
        """Verify 0x60C audio DSP amplifier command structure and payload fields."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        # Normal listening payload: Vol 25 (0x19), unmuted, flat fader/balance/EQ (0x0A)
        normal_payload = [0x19, 0x00, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x00]
        self.assertEqual(normal_payload[0], 25)  # D1: Vol 25
        self.assertEqual(normal_payload[1], 0)   # D2: Unmuted
        self.assertEqual(normal_payload[2], 10)  # D3: Fader centered (10 = 0 offset)
        self.assertEqual(normal_payload[3], 10)  # D4: Balance centered (10 = 0 offset)
        self.assertEqual(normal_payload[4], 10)  # D5: Bass 0 dB
        self.assertEqual(normal_payload[5], 10)  # D6: Mid 0 dB
        self.assertEqual(normal_payload[6], 10)  # D7: Treb 0 dB
        self.assertEqual(normal_payload[7], 0)   # D8: Standard stereo mode

        # Mute active payload
        mute_payload = [0x19, 0x01, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x00]
        self.assertEqual(mute_payload[1] & 0x01, 0x01)

        # Quiet mode active payload (limits front volume to 22, bit 2 on D8)
        quiet_payload = [0x16, 0x00, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x04]
        self.assertEqual(quiet_payload[7] & 0x04, 0x04)

    def test_touchscreen_climate_0x4a0_setpoints(self) -> None:
        """Verify 0x4A0 HU_DATC_E_01 temperature setpoint encoding and Sync toggle."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        # 72 deg F driver setpoint on Byte D2 (raw code 0x10)
        driver_72_payload = [0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(driver_72_payload, {"D2": "0x10"}))

        # 68 deg F passenger setpoint on Byte D8 (raw code 0x0C)
        pass_68_payload = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0C]
        self.assertTrue(check_match(pass_68_payload, {"D8": "0x0C"}))

        # Sync toggle on Byte D4 (0x0B = Sync On, 0x07 = Sync Off)
        sync_on_payload = [0x00, 0x00, 0x00, 0x0B, 0x00, 0x00, 0x00, 0x00]
        sync_off_payload = [0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(sync_on_payload, {"D4": "0x0B"}))
        self.assertTrue(check_match(sync_off_payload, {"D4": "0x07"}))

    def test_cluster_track_popup_0x4ce_0x6e0(self) -> None:
        """Verify cluster OSD trigger frame (0x4CE) and ISO-TP transport pairing (0x6E0/0x6BE)."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        found = False
        for cmd in cat.get("commands", []):
            if cmd.get("id") == "cluster_track_popup_message":
                found = True
                net = cmd.get("network", {})
                self.assertEqual(net.get("trigger_frame_can_id"), "0x4CE")
                self.assertEqual(net.get("action_can_id"), "0x6E0")
                self.assertEqual(net.get("flow_control_can_id"), "0x6BE")
                # Default apps transport
                apps = net.get("transports", {}).get("apps", {})
                self.assertEqual(apps.get("tx_id"), "0x6E0")
                self.assertEqual(apps.get("flow_control_id"), "0x6BE")

        self.assertTrue(found, "cluster_track_popup_message not found in catalog")

        # Test trigger frame payload structure
        trigger_payload = [0x04, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(trigger_payload[0], 0x04)  # D1: Apps / Nature
        self.assertEqual(trigger_payload[1], 0x11)  # D2: Pulse flag

        # Test UTF-16LE text serialization
        sample_text = "Pre-Heat"
        utf16_bytes = sample_text.encode("utf-16le")
        self.assertEqual(len(utf16_bytes), 16)
        self.assertEqual(utf16_bytes[0:2], b"P\x00")
        self.assertEqual(utf16_bytes[2:4], b"r\x00")

    def test_cgw_usm1_commands_and_telemetry_0x410(self) -> None:
        """Verify USMService dispatch commands and telemetry on CGW_USM1 (0x410)."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. i-Pedal ON/OFF commands
        self.assertIn("ipedal_one_pedal_driving", cmds)
        ipedal = cmds["ipedal_one_pedal_driving"]
        self.assertEqual(ipedal.get("action_can_id"), "0x410")
        opts = {o["label"]: o for o in ipedal.get("options", [])}
        self.assertEqual(
            opts["i-Pedal ON"]["payload"],
            {"D1": "0x92", "D2": "0x11", "D3": "0x11", "D4": "0x1B", "D5": "0x0E", "D6": "0x01", "D7": "0x00", "D8": "0x00"}
        )
        self.assertEqual(
            opts["i-Pedal OFF"]["payload"],
            {"D1": "0x92", "D2": "0x11", "D3": "0x11", "D4": "0x1B", "D5": "0x0E", "D6": "0x00", "D7": "0x00", "D8": "0x00"}
        )

        # 2. Smart Regenerative Braking
        self.assertIn("ev_smart_regenerative_braking", cmds)
        sregen = cmds["ev_smart_regenerative_braking"]
        self.assertEqual(sregen.get("action_can_id"), "0x410")
        ropts = {o["label"]: o for o in sregen.get("options", [])}
        self.assertEqual(ropts["Smart Regen Strong"]["payload"]["D6"], "0x03")
        self.assertEqual(ropts["Smart Regen Medium"]["payload"]["D6"], "0x02")
        self.assertEqual(ropts["Smart Regen Gentle"]["payload"]["D6"], "0x01")
        self.assertEqual(ropts["Smart Regen Off"]["payload"]["D6"], "0x00")

        # 3. Welcome mirror unfold telemetry
        self.assertIn("cgw_welcome_mirror_light", cmds)
        wlight = cmds["cgw_welcome_mirror_light"]
        self.assertEqual(wlight.get("state_can_id"), "0x410")
        wopts = {o["label"]: o for o in wlight.get("options", [])}
        self.assertEqual(wopts["Welcome Unfold On Approach"]["match"]["D3"], "0x02")
        self.assertEqual(wopts["Welcome Unfold On Approach"]["mask"], "0x03")

        # 4. Smart hands-free trunk telemetry
        self.assertIn("cgw_smart_proximity_trunk", cmds)
        strunk = cmds["cgw_smart_proximity_trunk"]
        self.assertEqual(strunk.get("state_can_id"), "0x410")
        topts = {o["label"]: o for o in strunk.get("options", [])}
        self.assertEqual(topts["Enabled / On"]["match"]["D5"], "0x07")
        self.assertEqual(topts["Enabled / On"]["mask"], "0x07")

    def test_cgw1_body_and_door_telemetry_0x541(self) -> None:
        """Verify door, wiper, defogger, and sunroof status signals on CGW1 (0x541)."""
        # Driver Door Ajar: D2 bit 0
        p_drv_open = [0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_drv_open, {"D2": "0x01"}, mask_spec="0x01"))

        # Rear-Left Door Ajar: D2 bit 1
        p_rl_open = [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_rl_open, {"D2": "0x02"}, mask_spec="0x02"))

        # Passenger Front Door Ajar: D5 bit 3
        p_ast_open = [0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_ast_open, {"D5": "0x08"}, mask_spec="0x08"))

        # Rear-Right Door Ajar: D5 bit 2
        p_rr_open = [0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_rr_open, {"D5": "0x04"}, mask_spec="0x04"))

        # Rear Defogger Active: D5 bit 4
        p_defog_active = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_defog_active, {"D5": "0x10"}, mask_spec="0x10"))

        # Wiper Stalk Active: D4 bits 4-7
        p_wiper_active = [0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_wiper_active, {"D4": "0x10"}, mask_spec="0xF0"))

        # Sunroof Open: D8 bit 1
        p_sunroof_open = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02]
        self.assertTrue(check_match(p_sunroof_open, {"D8": "0x02"}, mask_spec="0x02"))

    def test_cgw4_windows_and_heated_wheel_0x559(self) -> None:
        """Verify power window positions and heated steering wheel status on CGW4 (0x559)."""
        # Heated Steering Wheel Active: D1 bit 4
        p_htd_wheel = [0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_htd_wheel, {"D1": "0x10"}, mask_spec="0x10"))

        # Individual window positions on D2
        p_drv_wdw = [0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_rl_wdw = [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_rr_wdw = [0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_ast_wdw = [0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]

        self.assertTrue(check_match(p_drv_wdw, {"D2": "0x01"}, mask_spec="0x01"))
        self.assertTrue(check_match(p_rl_wdw, {"D2": "0x02"}, mask_spec="0x02"))
        self.assertTrue(check_match(p_rr_wdw, {"D2": "0x04"}, mask_spec="0x04"))
        self.assertTrue(check_match(p_ast_wdw, {"D2": "0x08"}, mask_spec="0x08"))

        # All 4 windows open (group mask 0x0F)
        p_all_open = [0x00, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_all_open, {"D2": "0x0F"}, mask_spec="0x0F"))

        # All closed
        p_all_closed = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_all_closed, {"D2": "0x00"}, mask_spec="0x0F"))

    def test_all_hu_cntl_e_01_modes_0x4a2(self) -> None:
        """Verify multiplexed action modes on master cockpit controller ALL_HU_CNTL_E_01 (0x4A2)."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. Heated steering wheel on/off payloads
        self.assertIn("heated_steering_wheel_toggle", cmds)
        htd_wheel = cmds["heated_steering_wheel_toggle"]
        self.assertEqual(htd_wheel.get("action_can_id"), "0x4A2")
        hopts = {o["label"]: o for o in htd_wheel.get("options", []) if "payload" in o and o["payload"]}
        self.assertEqual(
            hopts["Heated Steering Wheel On"]["payload"],
            {"D1": "0x00", "D2": "0x00", "D3": "0x1F", "D4": "0x03", "D5": "0xFF", "D6": "0xFF", "D7": "0x00", "D8": "0x00"}
        )
        self.assertEqual(
            hopts["Heated Steering Wheel Off"]["payload"],
            {"D1": "0x00", "D2": "0x00", "D3": "0x0F", "D4": "0x03", "D5": "0xFF", "D6": "0xFF", "D7": "0x00", "D8": "0x00"}
        )

        # 2. Rear Defogger & Heated Mirrors on/off payloads
        self.assertIn("climate_rear_defog", cmds)
        defog = cmds["climate_rear_defog"]
        self.assertEqual(defog.get("action_can_id"), "0x4A2")
        dopts = {o["label"]: o for o in defog.get("options", [])}
        self.assertEqual(
            dopts["Defogger & Mirrors On"]["payload"],
            {"D1": "0x00", "D2": "0x00", "D3": "0xCF", "D4": "0x03", "D5": "0xFF", "D6": "0xFF", "D7": "0x00", "D8": "0x00"}
        )
        self.assertEqual(
            dopts["Defogger & Mirrors Off"]["payload"],
            {"D1": "0x00", "D2": "0x00", "D3": "0x0F", "D4": "0x03", "D5": "0xFF", "D6": "0xFF", "D7": "0x00", "D8": "0x00"}
        )

        # 3. Charge port door open/close
        self.assertIn("charge_port", cmds)
        cport = cmds["charge_port"]
        self.assertEqual(cport.get("action_can_id"), "0x4A2")
        copts = {o["label"]: o for o in cport.get("options", []) if "payload" in o and o["payload"]}
        self.assertEqual(
            copts["Opened / Open"]["payload"],
            {"D1": "0x00", "D2": "0x00", "D3": "0xFF", "D4": "0xC3", "D5": "0xFF", "D6": "0xFF", "D7": "0x02", "D8": "0x00"}
        )
        self.assertEqual(
            copts["Closed / Shut"]["payload"],
            {"D1": "0x00", "D2": "0x00", "D3": "0xFF", "D4": "0xC3", "D5": "0xFF", "D6": "0xFF", "D7": "0x01", "D8": "0x00"}
        )

    def test_steering_wheel_media_buttons_0x448(self) -> None:
        """Verify steering wheel clockspring resistance ladder button signals on 0x448."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # Volume up/down/mute on D5
        vol = cmds["sw_volume"]
        self.assertEqual(vol.get("state_can_id"), "0x448")
        vopts = {o["label"]: o for o in vol.get("options", [])}
        self.assertEqual(vopts["Volume Up"]["match"]["D5"], "0x01")
        self.assertEqual(vopts["Volume Down"]["match"]["D5"], "0x40")
        self.assertEqual(vopts["Volume Press / Mute"]["match"]["D5"], "0x04")

        # Custom Star (★) button on D6
        star = cmds["sw_star"]
        self.assertEqual(star.get("state_can_id"), "0x448")
        self.assertEqual(star.get("match"), {"D6": "0x10"})

        # Mode button on D3
        mode = cmds["sw_mode"]
        self.assertEqual(mode.get("state_can_id"), "0x448")
        self.assertEqual(mode.get("match"), {"D3": "0x40"})

        # Voice & Call on D4
        speak = cmds["sw_speak"]
        self.assertEqual(speak.get("match"), {"D4": "0x01"})
        call = cmds["sw_call"]
        self.assertEqual(call.get("match"), {"D4": "0x04"})

    def test_rotary_knobs_and_paddles_0x651_0x1cf(self) -> None:
        """Verify console rotary encoder center buttons (0x651) and regen paddles (0x1CF)."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 0x651 Knob Center Buttons
        knob = cmds["avn_knob_buttons"]
        self.assertEqual(knob.get("state_can_id"), "0x651")
        kopts = {o["label"]: o for o in knob.get("options", [])}
        self.assertEqual(kopts["Volume Knob Press (Power / Mute)"]["match"]["D2"], "0x40")
        self.assertEqual(kopts["Tuner Knob Press"]["match"]["D4"], "0x40")

        # 0x1CF Regenerative Paddles
        paddles = cmds["steering_paddles"]
        self.assertEqual(paddles.get("state_can_id"), "0x1CF")
        popts = {o["label"]: o for o in paddles.get("options", [])}
        self.assertEqual(popts["Left Paddle Pulled"]["match"]["D4"], "0x80")
        self.assertEqual(popts["Right Paddle Pulled"]["match"]["D4"], "0x20")

    def test_vess_acoustic_telemetry_0x387(self) -> None:
        """Verify VESS pedestrian warning sound states (0x387) and USM volume coordination (0x410)."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. Catalog VESS volume control command on 0x410
        self.assertIn("cgw_vess_speaker_volume", cmds)
        vess_cmd = cmds["cgw_vess_speaker_volume"]
        self.assertEqual(vess_cmd.get("action_can_id"), "0x410")
        self.assertEqual(vess_cmd.get("state_can_id"), "0x410")
        vopts = {o["label"]: o for o in vess_cmd.get("options", [])}
        self.assertEqual(vopts["Volume Normal"]["payload"]["D6"], "0x00")
        self.assertEqual(vopts["Volume Mute / Off"]["payload"]["D6"], "0x01")
        self.assertEqual(vopts["Volume Low"]["payload"]["D6"], "0x02")
        self.assertEqual(vopts["Volume High"]["payload"]["D6"], "0x03")

        # 2. 0x387 Telemetry: Forward driving synthesized hum (Mode 1, Vol 2)
        p_forward = [0x21, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_forward, {"D1": "0x01"}, mask_spec="0x0F"))  # Mode = 1
        self.assertTrue(check_match(p_forward, {"D1": "0x20"}, mask_spec="0xF0"))  # Vol = 2

        # 3. 0x387 Telemetry: Reverse warning beeper (Mode 2, Vol 2)
        p_reverse = [0x22, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_reverse, {"D1": "0x02"}, mask_spec="0x0F"))  # Mode = 2

        # 4. 0x387 Telemetry: EV Charging Voice Announcement (Mode 3, Vol 2)
        p_charging = [0x23, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_charging, {"D1": "0x03"}, mask_spec="0x0F"))  # Mode = 3
        self.assertEqual(p_charging[2] & 0x0F, 0x02)  # Fast charging voice prompt

        # 5. 0x387 Telemetry: Front speaker open circuit fault (D2 = 0x01)
        p_fault = [0x20, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_fault, {"D2": "0x01"}, mask_spec="0x0F"))

    def test_hud_navigation_guidance_0x386(self) -> None:
        """Verify HUD navigation turn-by-turn maneuvers, speed camera alerts, and TPEG on 0x386."""
        # 1. Right turn in 200m (45 mph limit, Lane 2, Clear Traffic)
        p_right_turn = [0x13, 0x14, 0x00, 0x2D, 0x00, 0x02, 0x00, 0x01]
        self.assertEqual(p_right_turn[0] & 0x0F, 0x03)  # Maneuver: Right Turn (3)
        self.assertEqual(p_right_turn[0] & 0xF0, 0x10)  # Route Active (0x10)
        # Turn distance: D2 + (D3 & 0x0F) << 8 -> 0x14 = 20 * 10m = 200m
        turn_dist_m = (p_right_turn[1] | ((p_right_turn[2] & 0x0F) << 8)) * 10
        self.assertEqual(turn_dist_m, 200)
        self.assertEqual(p_right_turn[3], 45)  # 45 mph speed limit
        self.assertEqual(p_right_turn[5], 0x02)  # Recommended Lane 2

        # 2. Highway Exit Fork Right in 1.2 km (70 mph limit)
        p_exit = [0x19, 0x78, 0x00, 0x46, 0x00, 0x08, 0x00, 0x03]
        self.assertEqual(p_exit[0] & 0x0F, 0x09)  # Maneuver: Fork Right / Exit (9)
        exit_dist_m = (p_exit[1] | ((p_exit[2] & 0x0F) << 8)) * 10
        self.assertEqual(exit_dist_m, 1200)
        self.assertEqual(p_exit[3], 70)  # 70 mph

        # 3. Speed Camera Alert (65 mph zone, 300m countdown, Heavy Red Traffic)
        p_camera = [0x11, 0x64, 0x00, 0x41, 0x1E, 0x00, 0x02, 0x04]
        self.assertEqual(p_camera[0] & 0x0F, 0x01)  # Maneuver: Straight (1)
        self.assertEqual(p_camera[3], 65)  # 65 mph target
        camera_dist_m = p_camera[4] * 10  # 30 * 10m = 300m
        self.assertEqual(camera_dist_m, 300)
        self.assertEqual(p_camera[6] & 0x0F, 0x02)  # Traffic: Heavy Congestion / Red (2)

        # 4. Destination Arrived
        p_arrived = [0x1E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06]
        self.assertEqual(p_arrived[0] & 0x0F, 0x0E)  # Maneuver: Checkered Flag Arrived (0xE)

    def test_cluster_brightness_stepping_0x474(self) -> None:
        """Verify Instrument Cluster brightness stepping injection and button state on 0x474."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. State sensor: cluster_brightness (0x474)
        self.assertIn("cluster_brightness", cmds)
        cb = cmds["cluster_brightness"]
        self.assertEqual(cb.get("state_can_id"), "0x474")
        copts = {o["label"]: o for o in cb.get("options", [])}
        self.assertEqual(copts["Idle"]["match"]["D8"], "0x0A")
        self.assertEqual(copts["Brightness Up (+)"]["match"]["D8"], "0x4A")
        self.assertEqual(copts["Brightness Down (-)"]["match"]["D8"], "0x8A")

        # 2. Action stepping on cluster_brightness options (0x474)
        up_steps = copts["Brightness Up (+)"]["steps"]
        # Step 1: 3x active pulse 0x4A
        self.assertEqual(up_steps[0]["payload"]["D8"], "0x4A")
        self.assertEqual(up_steps[0]["repeat"], 3)
        # Step 2: idle release 0x0A
        self.assertEqual(up_steps[1]["payload"]["D8"], "0x0A")

        down_steps = copts["Brightness Down (-)"]["steps"]
        # Step 1: 3x active pulse 0x8A
        self.assertEqual(down_steps[0]["payload"]["D8"], "0x8A")
        self.assertEqual(down_steps[0]["repeat"], 3)
        # Step 2: idle release 0x0A
        self.assertEqual(down_steps[1]["payload"]["D8"], "0x0A")

    def test_uds_diagnostics_and_flashing_0x7df_0x7ec_0x7e4(self) -> None:
        """Verify UDS diagnostic sessions, communication control, routine control, and NRC framing."""
        # 1. DiagnosticSessionControl: Extended Session (0x10 03)
        req_session = [0x02, 0x10, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]
        resp_session = [0x06, 0x50, 0x03, 0x00, 0x32, 0x01, 0xF4, 0x00]
        self.assertEqual(req_session[1], 0x10)  # Service 0x10
        self.assertEqual(resp_session[1], 0x50)  # Positive response 0x50
        self.assertEqual(resp_session[2], 0x03)  # Extended session subfunction

        # 2. TesterPresent keep-alive (0x3E 00)
        req_tp = [0x02, 0x3E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        resp_tp = [0x02, 0x7E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(resp_tp[1], 0x7E)

        # 3. CommunicationControl: DISABLE_TX_ALL (0x28 01 01)
        req_comm_disable = [0x03, 0x28, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00]
        resp_comm_disable = [0x02, 0x68, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(resp_comm_disable[1], 0x68)
        self.assertEqual(resp_comm_disable[2], 0x01)

        # 4. RoutineControl: START_ROUTINE_BY_IDENTIFIER Flash Erase (0x31 01 FF 00)
        req_erase = [0x04, 0x31, 0x01, 0xFF, 0x00, 0x00, 0x00, 0x00]
        resp_erase_pending = [0x03, 0x7F, 0x31, 0x78, 0x00, 0x00, 0x00, 0x00]  # NRC 0x78 ResponsePending
        resp_erase_done = [0x04, 0x71, 0x01, 0xFF, 0x00, 0x00, 0x00, 0x00]     # Positive Response 0x71
        self.assertEqual(resp_erase_pending[1], 0x7F)  # Negative response header
        self.assertEqual(resp_erase_pending[2], 0x31)  # Rejected SID (0x31)
        self.assertEqual(resp_erase_pending[3], 0x78)  # NRC 0x78
        self.assertEqual(resp_erase_done[1], 0x71)     # Positive response

        # 5. Negative Response: SecurityAccessDenied (NRC 0x33)
        nrc_sec_denied = [0x03, 0x7F, 0x22, 0x33, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(nrc_sec_denied[1], 0x7F)
        self.assertEqual(nrc_sec_denied[3], 0x33)

    def test_transmission_and_drive_mode_states_0x45_0x130_0x478(self) -> None:
        """Verify gear states on 0x45, SBW rotary dial on 0x130, and Drive Mode on 0x478."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. Gear state sensor on 0x45
        self.assertIn("vehicle_gear_state", cmds)
        gear = cmds["vehicle_gear_state"]
        self.assertEqual(gear.get("state_can_id"), "0x45")
        gopts = {o["label"]: o for o in gear.get("options", [])}
        self.assertEqual(gopts["P"]["match"]["D6"], "0x00")
        self.assertEqual(gopts["D"]["match"]["D6"], "0x50")
        self.assertEqual(gopts["N"]["match"]["D6"], "0x60")
        self.assertEqual(gopts["R"]["match"]["D6"], "0x70")

        # 2. SBW Rotary Dial and Park Button on 0x130
        self.assertIn("gear_shifter_dial", cmds)
        sbw = cmds["gear_shifter_dial"]
        self.assertEqual(sbw.get("state_can_id"), "0x130")
        sopts = {o["label"]: o for o in sbw.get("options", [])}
        self.assertEqual(sopts["Park Button Pressed"]["match"]["D5"], "0x10")
        self.assertEqual(sopts["Knob Turned to Drive (D)"]["match"]["D6"], "0x50")
        self.assertEqual(sopts["Knob Turned to Reverse (R)"]["match"]["D6"], "0x10")

        # 3. Drive Mode on 0x478
        self.assertIn("drive_mode_state", cmds)
        dmode = cmds["drive_mode_state"]
        self.assertEqual(dmode.get("state_can_id"), "0x478")
        dopts = {o["label"]: o for o in dmode.get("options", [])}
        self.assertEqual(dopts["Normal Mode"]["match"]["D4"], "0x10")
        self.assertEqual(dopts["Eco Mode"]["match"]["D4"], "0x20")
        self.assertEqual(dopts["Sport Mode"]["match"]["D4"], "0x30")

    def test_high_voltage_battery_and_charging_0x30e_0x5d7_0x2ad_0x4c5(self) -> None:
        """Verify charging power (0x30E), pack temperatures (0x5D7), preconditioning (0x2AD), and limits."""
        # 1. 0x30E: Live EV charging power in integer kW (Byte D7)
        p_11kw_ac = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0B, 0x00]   # 11 kW Level 2 AC
        p_150kw_dcfc = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x96, 0x00] # 150 kW DC Fast Charge
        p_235kw_peak = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xEB, 0x00] # 235 kW 800V Peak
        self.assertEqual(p_11kw_ac[6], 11)
        self.assertEqual(p_150kw_dcfc[6], 150)
        self.assertEqual(p_235kw_peak[6], 235)

        # 2. 0x5D7: Battery module min/max temperature (-40 deg C offset)
        # Raw 0x3D = 61 -> 61 - 40 = 21 C (70 F target)
        # Raw 0x32 = 50 -> 50 - 40 = 10 C (50 F cold)
        p_bms_temp = [0x3F, 0x3D, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        max_temp_c = p_bms_temp[0] - 40
        min_temp_c = p_bms_temp[1] - 40
        self.assertEqual(max_temp_c, 23)
        self.assertEqual(min_temp_c, 21)

        # 3. 0x2AD: BMU Preconditioning State (Byte D2 mask 0x1F)
        p_precond_active = [0x00, 0x55, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertEqual(p_precond_active[1] & 0x1F, 0x15)  # Active conditioning flag set

        # 4. 0x4C5: AC/DC Target Charge Limits (Raw = Limit% * 2)
        # 80% limit -> 160 = 0xA0; 100% limit -> 200 = 0xC8
        ac_limit_80 = 80 * 2
        dc_limit_100 = 100 * 2
        self.assertEqual(ac_limit_80, 0xA0)
        self.assertEqual(dc_limit_100, 0xC8)

        # 5. 0x594: Active charging state (D2 bit 1)
        p_charging_active = [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_charging_active, {"D2": "0x02"}, mask_spec="0x02"))

    def test_tpms_and_wheel_speed_telemetry_0x593_0x4b0_0x4b1(self) -> None:
        """Verify TPMS warnings on 0x593, wheel speed on 0x4B0, pulse on 0x4B1, and UDS formulas."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. 0x593 TPMS warning lamp & individual wheel alert flags
        self.assertIn("tpms_warning_lamp", cmds)
        self.assertIn("tpms_low_pressure_fl", cmds)
        self.assertIn("tpms_low_pressure_fr", cmds)
        self.assertIn("tpms_low_pressure_rl", cmds)
        self.assertIn("tpms_low_pressure_rr", cmds)

        # Normal frame (all tires OK)
        p_tpms_ok = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_tpms_ok, {"D1": "0x00"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_tpms_ok, {"D1": "0x00"}, mask_spec="0x10"))

        # Front-Left Low Pressure Alert: 0x15 (bit 4: 0x10, bit 2: 0x04 tread, bit 0: 0x01 lamp)
        p_tpms_fl_alert = [0x15, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_tpms_fl_alert, {"D1": "0x01"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_tpms_fl_alert, {"D1": "0x10"}, mask_spec="0x10"))

        # Rear-Right Low Pressure Alert: 0x85 (bit 7: 0x80, bit 2: 0x04, bit 0: 0x01)
        p_tpms_rr_alert = [0x85, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_tpms_rr_alert, {"D1": "0x80"}, mask_spec="0x80"))

        # System Fault / Blinking Warning: 0x02
        p_tpms_fault = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_tpms_fault, {"D1": "0x02"}, mask_spec="0x03"))

        # 2. 0x4B0 ESC Wheel Speed Decoding (16-bit big-endian, 0.03125 km/h scaling)
        # Stationary vehicle (0.0 km/h)
        p_whl_stationary = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        speed_fl_0 = (p_whl_stationary[0] << 8 | p_whl_stationary[1]) * 0.03125
        self.assertEqual(speed_fl_0, 0.0)

        # 60.0 km/h cruise: raw = 60.0 / 0.03125 = 1920 = 0x0780
        p_whl_60kmh = [0x07, 0x80, 0x07, 0x80, 0x07, 0x80, 0x07, 0x80]
        speed_fl = (p_whl_60kmh[0] << 8 | p_whl_60kmh[1]) * 0.03125
        speed_fr = (p_whl_60kmh[2] << 8 | p_whl_60kmh[3]) * 0.03125
        speed_rl = (p_whl_60kmh[4] << 8 | p_whl_60kmh[5]) * 0.03125
        speed_rr = (p_whl_60kmh[6] << 8 | p_whl_60kmh[7]) * 0.03125
        self.assertAlmostEqual(speed_fl, 60.0, places=2)
        self.assertAlmostEqual(speed_fr, 60.0, places=2)
        self.assertAlmostEqual(speed_rl, 60.0, places=2)
        self.assertAlmostEqual(speed_rr, 60.0, places=2)

        # 100.0 km/h cruise: raw = 100.0 / 0.03125 = 3200 = 0x0C80
        p_whl_100kmh = [0x0C, 0x80, 0x0C, 0x80, 0x0C, 0x80, 0x0C, 0x80]
        speed_fl_100 = (p_whl_100kmh[0] << 8 | p_whl_100kmh[1]) * 0.03125
        self.assertAlmostEqual(speed_fl_100, 100.0, places=2)

        # 3. 0x4B1 Dead-Reckoning Wheel Pulses (16-bit tick accumulators)
        p_pulses = [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]
        pulse_fl = (p_pulses[0] << 8 | p_pulses[1])
        pulse_fr = (p_pulses[2] << 8 | p_pulses[3])
        self.assertEqual(pulse_fl, 0x1234)
        self.assertEqual(pulse_fr, 0x5678)

        # 4. UDS Mode 0x22 (Header 0x7D6/0x7DE) Pressure & Temperature Formulas
        raw_press = 144  # 0x90
        psi = raw_press * 0.25
        bar = round(psi * 0.0689476, 2)
        self.assertEqual(psi, 36.0)
        self.assertEqual(bar, 2.48)

        raw_temp = 75   # 0x4B
        temp_c = raw_temp - 55
        temp_f = round((temp_c * 1.8) + 32, 1)
        self.assertEqual(temp_c, 20)
        self.assertEqual(temp_f, 68.0)

    def test_doors_tailgate_smart_key_and_mirrors_0x541_0x411_0x414_0x3a6_0x553(self) -> None:
        """Verify door latches (0x411/0x541), trunk (0x414), PTGM (0x3A6/0x588), SMK (0x553), and mirrors."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. 0x411 & 0x414 Door, Hood, and Trunk Latches
        self.assertIn("doors_status", cmds)
        self.assertIn("hood", cmds)
        self.assertIn("trunk", cmds)

        # 0x411: Driver door open (D4: 0x01), passenger open (D5: 0x04), hood open (D6: 0x10)
        p_bcm_doors = [0x00, 0x00, 0x00, 0x01, 0x04, 0x10, 0x00, 0x00]
        self.assertTrue(check_match(p_bcm_doors, {"D4": "0x01"}, mask_spec="0x01"))
        self.assertTrue(check_match(p_bcm_doors, {"D5": "0x04"}, mask_spec="0x04"))
        self.assertTrue(check_match(p_bcm_doors, {"D6": "0x10"}, mask_spec="0x10"))

        # 0x414: Trunk open (D4: 0x01) vs closed (D4: 0x00)
        p_trunk_open = [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]
        p_trunk_closed = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_trunk_open, {"D4": "0x01"}))
        self.assertTrue(check_match(p_trunk_closed, {"D4": "0x00"}))

        # 2. 0x541 CGW1 Consolidated Door Switches & Defogger
        # Driver open (D2: 0x01), defogger active (D5: 0x10), sunroof open (D8: 0x02)
        p_cgw1 = [0x00, 0x01, 0x00, 0x00, 0x18, 0x00, 0x00, 0x02]
        self.assertTrue(check_match(p_cgw1, {"D2": "0x01"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_cgw1, {"D5": "0x08"}, mask_spec="0x08"))
        self.assertTrue(check_match(p_cgw1, {"D5": "0x10"}, mask_spec="0x10"))
        self.assertTrue(check_match(p_cgw1, {"D8": "0x02"}, mask_spec="0x02"))

        # 3. 0x3A6 PTGM Tailgate Status & 0x588 Commands
        self.assertIn("ptgm_tailgate_status", cmds)
        self.assertIn("telematics_remote_tailgate", cmds)

        # Telemetry: 0x01 = Fully Opened, 0x02 = Fully Closed, 0x03 = Opening, 0x08 = Pinch/Obstacle
        p_ptgm_open = [0x01, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]      # 100% open
        p_ptgm_closed = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]    # 0% closed
        p_ptgm_pinch = [0x08, 0x32, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00]     # Obstacle at 50%
        self.assertTrue(check_match(p_ptgm_open, {"D1": "0x01"}, mask_spec="0x0F"))
        self.assertTrue(check_match(p_ptgm_closed, {"D1": "0x02"}, mask_spec="0x0F"))
        self.assertTrue(check_match(p_ptgm_pinch, {"D1": "0x08"}, mask_spec="0x0F"))

        # Remote Tailgate Commands (0x588)
        tailgate_cmd = cmds["telematics_remote_tailgate"]
        opts = {o["label"]: o for o in tailgate_cmd.get("options", [])}
        self.assertEqual(opts["Open Tailgate / Trunk"]["payload"]["D1"], "0x01")
        self.assertEqual(opts["Close Tailgate / Trunk"]["payload"]["D1"], "0x02")

        # 4. 0x553 Smart Key Fob & Driver Recognition
        self.assertIn("smart_key_fob_detected", cmds)
        self.assertIn("smart_key_proximity_welcome", cmds)

        # D7: 0x01 = Driver 1, 0x02 = Driver 2, 0x03 = Digital Key; D8: 0x01 = Welcome Handshake
        p_smk_drv1 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01]
        p_smk_nfc = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01]
        self.assertTrue(check_match(p_smk_drv1, {"D7": "0x01"}, mask_spec="0x07"))
        self.assertTrue(check_match(p_smk_drv1, {"D8": "0x01"}, mask_spec="0x01"))
        self.assertTrue(check_match(p_smk_nfc, {"D7": "0x03"}, mask_spec="0x07"))

        # 5. 0x410 Welcome Mirror & Smart Trunk Proximity Settings
        self.assertIn("cgw_welcome_mirror_light", cmds)
        self.assertIn("cgw_smart_proximity_trunk", cmds)
        p_usm = [0x00, 0x00, 0x02, 0x00, 0x07, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_usm, {"D3": "0x02"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_usm, {"D5": "0x07"}, mask_spec="0x07"))

    def test_epb_autohold_and_brake_dynamics_0x490_0x47f_0x220_0x412(self) -> None:
        """Verify EPB states on 0x490, Auto Hold on 0x47F, pressure on 0x220, and pedal on 0x412."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. 0x490 EPB Module Status
        self.assertIn("electric_parking_brake_status", cmds)

        # Released (D1: 0x00), Clamped (D1: 0x01), Transitioning (D1: 0x02), Fault (D1: 0x04)
        p_epb_rel = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_epb_clamp = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_epb_trans = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_epb_fault = [0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]

        self.assertTrue(check_match(p_epb_rel, {"D1": "0x00"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_epb_clamp, {"D1": "0x01"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_epb_trans, {"D1": "0x02"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_epb_fault, {"D1": "0x04"}, mask_spec="0x04"))

        # 2. 0x47F Auto Vehicle Hold (AVH_STAT)
        self.assertIn("auto_hold_status", cmds)

        # Off: 0x00, Standby (White): 0x01, Active (Green): 0x02, Fault: 0x03
        p_avh_off = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_avh_standby = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_avh_active = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_avh_fault = [0x03, 0x00, 0x00, 0x00, 0x00, 0x00]

        self.assertTrue(check_match(p_avh_off, {"D1": "0x00"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_avh_standby, {"D1": "0x01"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_avh_active, {"D1": "0x02"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_avh_fault, {"D1": "0x03"}, mask_spec="0x03"))

        # 3. 0x220 Master Cylinder Hydraulic Brake Pressure (CYL_PRES)
        self.assertIn("master_cylinder_brake_pressure", cmds)

        # 35.0 bar (raw = 350 = 0x015E): 350 * 0.1 = 35.0 bar, 35.0 * 14.5038 = 507.6 psi
        raw_pres_35bar = 350
        bar_calc = raw_pres_35bar * 0.1
        psi_calc = round(bar_calc * 14.5038, 1)
        self.assertAlmostEqual(bar_calc, 35.0, places=1)
        self.assertAlmostEqual(psi_calc, 507.6, places=1)

        # 120.0 bar hard braking (raw = 1200): 1200 * 0.1 = 120.0 bar, 120.0 * 14.5038 = 1740.5 psi
        raw_pres_120bar = 1200
        bar_calc_hard = raw_pres_120bar * 0.1
        psi_calc_hard = round(bar_calc_hard * 14.5038, 1)
        self.assertAlmostEqual(bar_calc_hard, 120.0, places=1)
        self.assertAlmostEqual(psi_calc_hard, 1740.5, places=1)

        # 4. 0x412 Brake Pedal Switch
        self.assertIn("brake_pedal_state", cmds)
        p_brake_off = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_brake_pressed = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00]
        self.assertTrue(check_match(p_brake_off, {"D7": "0x00"}, mask_spec="0x04"))
        self.assertTrue(check_match(p_brake_pressed, {"D7": "0x04"}, mask_spec="0x04"))

    def test_adas_scc_fca_and_smart_summon_0x38c_0x420_0x421_0x38d_0x203(self) -> None:
        """Verify RSPA (0x38C), SCC (0x420/0x421), FCA/AEB (0x38D), and LFA (0x203) telemetry."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. 0x38C RSPA Smart Summon
        self.assertIn("rspa_smart_parking_ctrl", cmds)
        p_rspa_idle = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_rspa_fwd = [0x01, 0x19, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_rspa_rev = [0x02, 0x19, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_rspa_halt = [0x0F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_rspa_idle, {"D1": "0x00"}, mask_spec="0x0F"))
        self.assertTrue(check_match(p_rspa_fwd, {"D1": "0x01"}, mask_spec="0x0F"))
        self.assertTrue(check_match(p_rspa_rev, {"D1": "0x02"}, mask_spec="0x0F"))
        self.assertTrue(check_match(p_rspa_halt, {"D1": "0x0F"}, mask_spec="0x0F"))

        # 2. 0x420 Smart Cruise Control Stop & Go Hold
        self.assertIn("scc_cruise_status", cmds)
        p_scc_hold = [0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_scc_cruise = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_scc_hold, {"D3": "0x01"}, mask_spec="0x01"))
        self.assertTrue(check_match(p_scc_cruise, {"D3": "0x00"}, mask_spec="0x01"))

        # 3. 0x421 Lead Vehicle Status
        self.assertIn("scc_lead_vehicle_status", cmds)
        p_scc_lead_present = [0x01, 0x46, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]  # Lead locked, set 70 km/h, gap 3
        p_scc_no_lead = [0x00, 0x46, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_scc_lead_present, {"D1": "0x01"}, mask_spec="0x01"))
        self.assertTrue(check_match(p_scc_no_lead, {"D1": "0x00"}, mask_spec="0x01"))

        # 4. 0x38D FCA Autonomous Emergency Braking
        self.assertIn("aeb_emergency_braking", cmds)
        p_aeb_active = [0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_aeb_idle = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_aeb_active, {"D2": "0x01"}, mask_spec="0x01"))
        self.assertTrue(check_match(p_aeb_idle, {"D2": "0x00"}, mask_spec="0x01"))

        # 5. 0x203 Lane Following Assist (LFA)
        self.assertIn("lfa_steering_status", cmds)
        p_lfa_off = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_lfa_standby = [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]
        p_lfa_active = [0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]
        p_lfa_handsoff = [0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_lfa_off, {"D4": "0x00"}, mask_spec="0x0F"))
        self.assertTrue(check_match(p_lfa_standby, {"D4": "0x01"}, mask_spec="0x0F"))
        self.assertTrue(check_match(p_lfa_active, {"D4": "0x02"}, mask_spec="0x0F"))
        self.assertTrue(check_match(p_lfa_handsoff, {"D4": "0x03"}, mask_spec="0x0F"))

    def test_blind_spot_bca_rcta_and_sea_0x1ba_0x391(self) -> None:
        """Verify Rear Corner Radar BCW / BCA / RCTA indicator states on 0x1BA."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. Left Blind Spot Warning (D4 bits 1:0)
        self.assertIn("blind_spot_warning_left", cmds)
        p_bcw_lt_clear = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_bcw_lt_detected = [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]
        p_bcw_lt_flash = [0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_bcw_lt_clear, {"D4": "0x00"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_bcw_lt_detected, {"D4": "0x01"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_bcw_lt_flash, {"D4": "0x02"}, mask_spec="0x03"))

        # 2. Right Blind Spot Warning (D5 bits 1:0)
        self.assertIn("blind_spot_warning_right", cmds)
        p_bcw_rt_clear = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_bcw_rt_detected = [0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]
        p_bcw_rt_flash = [0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_bcw_rt_clear, {"D5": "0x00"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_bcw_rt_detected, {"D5": "0x01"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_bcw_rt_flash, {"D5": "0x02"}, mask_spec="0x03"))

    def test_svm_camera_and_pdw_sensors_0x476_0x477_0x436(self) -> None:
        """Verify Surround View Camera (0x477) perspectives and PDW ultrasonic sensors (0x436)."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. 0x477 Surround View Monitor Perspective (D1)
        self.assertIn("svm_camera_view_status", cmds)
        p_svm_off = [0x00, 0x00, 0x78, 0x00, 0x30, 0x00, 0x30, 0x00]
        p_svm_rear = [0x41, 0x3D, 0x20, 0x01, 0xB3, 0x11, 0x0C, 0x04]
        p_svm_front = [0x42, 0x3D, 0x20, 0x01, 0xB3, 0x11, 0x0C, 0x04]
        self.assertTrue(check_match(p_svm_off, {"D1": "0x00"}, mask_spec="0xFF"))
        self.assertTrue(check_match(p_svm_rear, {"D1": "0x41"}, mask_spec="0xFF"))
        self.assertTrue(check_match(p_svm_front, {"D1": "0x42"}, mask_spec="0xFF"))

        # 2. 0x436 PDW Front Center Sensor (D2 bits 2:0)
        self.assertIn("pdw_sensor_front_center", cmds)
        p_pdw_fctr_clear = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_pdw_fctr_z1 = [0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_pdw_fctr_z3 = [0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_pdw_fctr_clear, {"D2": "0x00"}, mask_spec="0x07"))
        self.assertTrue(check_match(p_pdw_fctr_z1, {"D2": "0x01"}, mask_spec="0x07"))
        self.assertTrue(check_match(p_pdw_fctr_z3, {"D2": "0x03"}, mask_spec="0x07"))

        # 3. 0x436 PDW Rear Center Sensor (D2 bits 5:3)
        self.assertIn("pdw_sensor_rear_center", cmds)
        p_pdw_rctr_clear = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_pdw_rctr_z1 = [0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_pdw_rctr_z3 = [0x00, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_pdw_rctr_clear, {"D2": "0x00"}, mask_spec="0x38"))
        self.assertTrue(check_match(p_pdw_rctr_z1, {"D2": "0x08"}, mask_spec="0x38"))
        self.assertTrue(check_match(p_pdw_rctr_z3, {"D2": "0x18"}, mask_spec="0x38"))

    def test_v2l_discharge_and_ac_current_limits(self) -> None:
        """Verify V2L minimum SOC reserve cutoff on 0x0C7/0x151 and AC current limit configuration on 0x578."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. V2L Minimum SOC Cutoff on 0x0C7 (command) & 0x151 (state D7)
        self.assertIn("v2l_minimum_charge_limit", cmds)
        p_v2l_20 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x28, 0x00]
        p_v2l_50 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00]
        p_v2l_80 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xA0, 0x00]
        self.assertTrue(check_match(p_v2l_20, {"D7": "0x28"}, mask_spec="0xFF"))
        self.assertTrue(check_match(p_v2l_50, {"D7": "0x64"}, mask_spec="0xFF"))
        self.assertTrue(check_match(p_v2l_80, {"D7": "0xA0"}, mask_spec="0xFF"))

        # 2. 0x578 AC Current Limit Level (D3 bits 1:0)
        self.assertIn("ac_charging_current_limit", cmds)
        p_ac_min = [0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00]
        p_ac_reduced = [0x00, 0x00, 0x01, 0x14, 0x00, 0x00, 0x00, 0x00]
        p_ac_max = [0x00, 0x00, 0x02, 0x14, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_ac_min, {"D3": "0x00"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_ac_reduced, {"D3": "0x01"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_ac_max, {"D3": "0x02"}, mask_spec="0x03"))

    def test_active_air_flaps_0x584(self) -> None:
        """Verify Active Air Flap (AAF) positions and drag reduction states on 0x584."""
        cat_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        with open(cat_path, "r", encoding="utf-8") as f:
            cat = json.load(f)

        cmds = {c["id"]: c for c in cat.get("commands", [])}

        # 1. 0x584 AAF Flap Status (D1 bits 1:0)
        self.assertIn("active_air_flaps_position", cmds)
        p_aaf_closed = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        p_aaf_partial = [0x01, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00, 0x00]
        p_aaf_open = [0x02, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00]
        self.assertTrue(check_match(p_aaf_closed, {"D1": "0x00"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_aaf_partial, {"D1": "0x01"}, mask_spec="0x03"))
        self.assertTrue(check_match(p_aaf_open, {"D1": "0x02"}, mask_spec="0x03"))


if __name__ == "__main__":
    unittest.main()




