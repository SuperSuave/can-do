"""Unit tests for CAN Do conversion and helper utilities."""

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

from custom_components.can_do.can_utils import build_action_steps, build_hex_payload


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


if __name__ == "__main__":
    unittest.main()
