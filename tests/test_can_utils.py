"""Unit tests for CAN Do conversion and helper utilities."""

import json
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

from custom_components.can_do.can_utils import (
    build_action_steps,
    build_hex_payload,
    find_switch_option,
    is_off_option_label,
    is_on_option_label,
    resolve_base_payload,
)


class TestBuildHexPayload(unittest.TestCase):
    """Test suite for build_hex_payload."""

    def test_raw_hex_string_16_chars(self) -> None:
        """16-char hex string should be normalized and uppercased."""
        self.assertEqual(build_hex_payload("0102030405060708"), "0102030405060708")
        self.assertEqual(build_hex_payload("abcdef0123456789"), "ABCDEF0123456789")

    def test_raw_hex_string_with_prefix_and_spaces(self) -> None:
        """Hex string with 0x prefixes and spaces should be cleaned."""
        self.assertEqual(build_hex_payload("0x0102030405060708"), "0102030405060708")
        self.assertEqual(build_hex_payload(" 01 02 03 04 05 06 07 08 "), "0102030405060708")
        self.assertEqual(
            build_hex_payload("0x01 0x02 0x03 0x04 0x05 0x06 0x07 0x08"),
            "0102030405060708",
        )

    def test_short_hex_string_padding(self) -> None:
        """Short hex strings should be right-padded with zeros up to 16 characters."""
        self.assertEqual(build_hex_payload("0102"), "0102000000000000")
        self.assertEqual(build_hex_payload("0xABCD"), "ABCD000000000000")
        self.assertEqual(build_hex_payload(""), "0000000000000000")

    def test_dict_with_hex_data_raw_keys(self) -> None:
        """Dict containing direct 'hex', 'data', or 'raw' keys should be formatted."""
        self.assertEqual(
            build_hex_payload({"hex": "0102030405060708"}),
            "0102030405060708",
        )
        self.assertEqual(
            build_hex_payload({"hex": "  0x01 02 03 04 05 06 07 08  "}),
            "0102030405060708",
        )
        self.assertEqual(
            build_hex_payload({"data": "abcdef0123456789"}),
            "ABCDEF0123456789",
        )
        self.assertEqual(
            build_hex_payload({"raw": "0xDEADBEEFCAFE0011"}),
            "DEADBEEFCAFE0011",
        )

    def test_dict_d_indexed_bytes_default_base(self) -> None:
        """Dict using 1-based D1..D8 keys should correctly map onto an 8-byte payload."""
        # Axiom #3: D1 is byte 0, D8 is byte 7
        self.assertEqual(
            build_hex_payload({"D1": "0x12"}),
            "1200000000000000",
        )
        self.assertEqual(
            build_hex_payload({"D8": "0xFF"}),
            "00000000000000FF",
        )
        self.assertEqual(
            build_hex_payload({"D1": "0xAA", "D3": 0x55, "D7": "0x10"}),
            "AA00550000001000",
        )
        # Case insensitive key
        self.assertEqual(
            build_hex_payload({"d1": "0x01", "D2": "0x02"}),
            "0102000000000000",
        )

    def test_dict_d_indexed_with_base_payload(self) -> None:
        """D1..D8 keys should modify only specified bytes of base_payload."""
        base = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
        result = build_hex_payload({"D2": "0xFF", "D5": 0x00}, base_payload=base)
        self.assertEqual(result, "11FF334400667788")
        # Ensure base payload was not mutated in place
        self.assertEqual(base[1], 0x22)

    def test_invalid_base_payload_fallback(self) -> None:
        """Base payload with length != 8 should fall back to zeros."""
        short_base = [0x11, 0x22, 0x33]
        result = build_hex_payload({"D1": "0xAA"}, base_payload=short_base)
        self.assertEqual(result, "AA00000000000000")

    def test_invalid_keys_and_empty_payload(self) -> None:
        """Unknown keys or empty dicts should produce all zeros."""
        self.assertEqual(build_hex_payload({}), "0000000000000000")
        self.assertEqual(
            build_hex_payload({"D9": "0x02", "D10": "0x03", "foo": "bar"}),
            "0000000000000000",
        )
        self.assertEqual(build_hex_payload(None), "0000000000000000")

    def test_d0_lenient_zero_index_fallback(self) -> None:
        """get_d_index leniently supports D0 as index 0."""
        self.assertEqual(build_hex_payload({"D0": "0x55"}), "5500000000000000")


class TestBuildActionSteps(unittest.TestCase):
    """Test suite for build_action_steps."""

    def test_option_steps_priority(self) -> None:
        """Option-level steps take highest priority."""
        command = {
            "steps": [{"payload": "1111111111111111", "repeat": 1, "delay_ms": 10}],
            "payload": "2222222222222222",
        }
        option = {
            "steps": [
                {"payload": "3333333333333333", "repeat": 2, "delay_ms": 50},
                {"payload": "4444444444444444", "repeat": 1, "delay_ms": 20},
            ]
        }
        steps = build_action_steps(command, option)
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0]["payload"], "3333333333333333")
        self.assertEqual(steps[0]["repeat"], 2)
        self.assertEqual(steps[0]["delay_ms"], 50)
        self.assertEqual(steps[1]["payload"], "4444444444444444")

    def test_command_steps_fallback(self) -> None:
        """When option has no steps, command-level steps are used."""
        command = {
            "steps": [
                {"payload": "AAAAAAAAAAAAAAAA", "repeat": 1, "delay_ms": 25},
            ]
        }
        steps = build_action_steps(command)
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["payload"], "AAAAAAAAAAAAAAAA")
        self.assertEqual(steps[0]["delay_ms"], 25)

    def test_single_payload_fallback(self) -> None:
        """Default fallback when only a single command payload is defined."""
        command = {"payload": "BBBBBBBBBBBBBBBB"}
        steps = build_action_steps(command)
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["payload"], "BBBBBBBBBBBBBBBB")
        self.assertEqual(steps[0]["repeat"], 1)
        self.assertEqual(steps[0]["delay_ms"], 20)

    def test_option_single_payload(self) -> None:
        """Option-level single payload is used when option has no steps array."""
        command = {"payload": "1111111111111111"}
        option = {"payload": "2222222222222222", "repeat": 3, "delay_ms": 30}
        steps = build_action_steps(command, option)
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["payload"], "2222222222222222")
        self.assertEqual(steps[0]["repeat"], 3)
        self.assertEqual(steps[0]["delay_ms"], 30)

    def test_step_defaults_repeat_and_delay(self) -> None:
        """Omitted repeat and delay_ms in steps should default to 1 and 20 respectively."""
        command = {"steps": [{"payload": "AABBCCDDEEFF0011"}]}
        steps = build_action_steps(command)
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["payload"], "AABBCCDDEEFF0011")
        self.assertEqual(steps[0]["repeat"], 1)
        self.assertEqual(steps[0]["delay_ms"], 20)

    def test_empty_command_returns_empty_list(self) -> None:
        """Command with neither steps nor payload should return an empty list."""
        self.assertEqual(build_action_steps({}), [])
        self.assertEqual(build_action_steps({"name": "noop"}), [])

    def test_base_payload_propagation_in_steps(self) -> None:
        """base_payload should be correctly forwarded to format D-indexed step payloads."""
        base = [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]
        command = {
            "steps": [
                {"payload": {"D1": "0xFF"}},
                {"payload": {"D8": "0xAA"}},
            ]
        }
        steps = build_action_steps(command, base_payload=base)
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0]["payload"], "FF20304050607080")
        self.assertEqual(steps[1]["payload"], "10203040506070AA")

    def test_preserves_step_can_id_bus_and_delay_type(self) -> None:
        """Step-level can_id, bus, and delay step types should be preserved."""
        command = {
            "steps": [
                {"can_id": "0x418", "bus": 1, "payload": {"D3": "0x01"}, "repeat": 3},
                {"type": "delay", "delay_ms": 150},
                {"action_can_id": "0x4A2", "payload": {"D3": "0xFF"}, "repeat": 2},
            ]
        }
        steps = build_action_steps(command)
        self.assertEqual(len(steps), 3)
        self.assertEqual(steps[0]["can_id"], "0x418")
        self.assertEqual(steps[0]["bus"], 1)
        self.assertEqual(steps[0]["payload"], "0000010000000000")
        self.assertEqual(steps[1], {"type": "delay", "delay_ms": 150})
        self.assertEqual(steps[2]["can_id"], "0x4A2")
        self.assertEqual(steps[2]["payload"], "0000FF0000000000")


class TestSwitchOptionMatching(unittest.TestCase):
    """Test word-boundary switch option detection across catalog switches."""

    def test_word_boundary_prevents_substring_collisions(self) -> None:
        """Words like 'only', 'ventilation', 'inactive', 'heat' must not false-match."""
        self.assertTrue(is_off_option_label("Driver Only Off"))
        self.assertFalse(is_on_option_label("Driver Only Off"))
        self.assertTrue(is_on_option_label("Driver Only On"))

        self.assertTrue(is_off_option_label("Smart Ventilation Off"))
        self.assertFalse(is_on_option_label("Smart Ventilation Off"))
        self.assertTrue(is_on_option_label("Smart Ventilation On"))

        self.assertTrue(is_off_option_label("Turned OFF / Inactive"))
        self.assertFalse(is_on_option_label("Turned OFF / Inactive"))
        self.assertTrue(is_on_option_label("Turned ON / Active"))

        self.assertTrue(is_off_option_label("Heat Off"))
        self.assertFalse(is_on_option_label("Heat Off"))
        self.assertTrue(is_on_option_label("Heat On"))

    def test_all_catalog_switches_resolve_distinct_on_and_off_options(self) -> None:
        """Every switch entity in can_do_catalog.json should map turn_on and turn_off cleanly."""
        catalog_path = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        switches = [
            c for c in catalog.get("commands", [])
            if c.get("ha_metadata", {}).get("domain") == "switch"
        ]
        self.assertGreaterEqual(len(switches), 17)

        for cmd in switches:
            on_opt = find_switch_option(cmd, True)
            off_opt = find_switch_option(cmd, False)
            self.assertIsNotNone(on_opt, f"{cmd['id']} missing ON option")
            self.assertIsNotNone(off_opt, f"{cmd['id']} missing OFF option")
            self.assertNotEqual(
                on_opt.get("label"),
                off_opt.get("label"),
                f"{cmd['id']} resolved same option for ON and OFF",
            )

        by_id = {c["id"]: c for c in switches}
        self.assertEqual(find_switch_option(by_id["climate_driver_only_toggle"], True)["label"], "Driver Only On")
        self.assertEqual(find_switch_option(by_id["climate_driver_only_toggle"], False)["label"], "Driver Only Off")
        self.assertEqual(find_switch_option(by_id["climate_smart_ventilation"], True)["label"], "Smart Ventilation On")
        self.assertEqual(find_switch_option(by_id["climate_smart_ventilation"], False)["label"], "Smart Ventilation Off")
        self.assertEqual(find_switch_option(by_id["climate_heat_toggle"], True)["label"], "Heat On")
        self.assertEqual(find_switch_option(by_id["climate_heat_toggle"], False)["label"], "Heat Off")
        self.assertEqual(find_switch_option(by_id["climate_ac_toggle"], True)["label"], "A/C On")
        self.assertEqual(find_switch_option(by_id["climate_ac_toggle"], False)["label"], "A/C Off")
        self.assertEqual(find_switch_option(by_id["climate_auto_defrost"], True)["label"], "Auto Defrost On")
        self.assertEqual(find_switch_option(by_id["climate_auto_defrost"], False)["label"], "Auto Defrost Off")
        self.assertEqual(find_switch_option(by_id["climate_sync_toggle"], True)["label"], "Sync Passenger to Driver")
        self.assertEqual(find_switch_option(by_id["climate_sync_toggle"], False)["label"], "Dual Split / Sync Off")
        self.assertEqual(find_switch_option(by_id["hazard_lights"], True)["label"], "Turned ON / Active")
        self.assertEqual(find_switch_option(by_id["hazard_lights"], False)["label"], "Turned OFF / Inactive")
        self.assertEqual(find_switch_option(by_id["heated_steering_wheel_toggle"], True)["label"], "Heated Steering Wheel On")
        self.assertEqual(find_switch_option(by_id["heated_steering_wheel_toggle"], False)["label"], "Heated Steering Wheel Off")


class TestResolveBasePayload(unittest.TestCase):
    """Test base_payload isolation across state and action CAN IDs."""

    class _MockCoord:
        def __init__(self, payloads: dict[str, list[int]]) -> None:
            self._payloads = payloads

        def get_can_payload(self, can_id: str | None) -> list[int] | None:
            return self._payloads.get((can_id or "").lower())

    def test_inherits_live_frame_only_when_ids_match(self) -> None:
        """Live state CAN payload must only seed base_payload when state_can_id == action_can_id."""
        coord = self._MockCoord({"0x465": [0xAA] * 8, "0x60c": [0x19, 0x00, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x00]})

        # Different CAN IDs (e.g. climate_driver_only_toggle: state 0x465 vs action 0x41D) -> must NOT inherit
        cmd_diff = {"network": {"state_can_id": "0x465", "action_can_id": "0x41D"}}
        self.assertIsNone(resolve_base_payload(coord, cmd_diff, "0x41D", "0x465"))

        # Matching CAN IDs (e.g. audio_quiet_mode: 0x60C == 0x60C) -> inherits live frame copy
        cmd_same = {"network": {"state_can_id": "0x60C", "action_can_id": "0x60C"}}
        self.assertEqual(
            resolve_base_payload(coord, cmd_same, "0x60C", "0x60C"),
            [0x19, 0x00, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x00],
        )

        # Fallback to network.base_payload when live frame is unavailable or IDs differ
        cmd_default = {
            "network": {
                "state_can_id": "0x465",
                "action_can_id": "0x41D",
                "base_payload": ["0x10", "0x00", "0x00", "0x00", "0x00", "0x00", "0x00", "0x00"],
            }
        }
        self.assertEqual(
            resolve_base_payload(coord, cmd_default, "0x41D", "0x465"),
            [0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
        )


if __name__ == "__main__":
    unittest.main()
