"""Unit tests for catalog loader and CAN frame condition matching."""

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

from custom_components.can_do.catalog_loader import (
    DEFAULT_ENDIANNESS,
    check_match,
    decode_can_uint,
    decode_network_state_value,
    get_d_index,
    parse_hex_val,
    parse_state_byte_spec,
)


class TestCheckMatch(unittest.TestCase):
    """Test suite for check_match condition evaluator."""

    def test_empty_or_none_inputs(self) -> None:
        """Empty, None, or non-sequence payloads and match dictionaries should return False."""
        self.assertFalse(check_match([], {"D1": "0x01"}))
        self.assertFalse(check_match([0] * 8, {}))
        self.assertFalse(check_match(None, {"D1": "0x01"}))
        self.assertFalse(check_match([0] * 8, None))
        self.assertFalse(check_match(12.6, {"D1": "0x01"}))
        self.assertFalse(check_match("12.6", {"D1": "0x01"}))
        self.assertFalse(check_match(100, {"D1": "0x01"}))

    def test_exact_single_byte_matches(self) -> None:
        """1-based D1..D8 payload matching should verify correct byte indexes."""
        # Axiom #3: D1 maps to byte 0, D8 maps to byte 7
        data = [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]
        self.assertTrue(check_match(data, {"D1": "0x10"}))
        self.assertTrue(check_match(data, {"D8": "0x80"}))
        self.assertFalse(check_match(data, {"D1": "0x11"}))
        self.assertFalse(check_match(data, {"D8": "0x00"}))

    def test_multi_byte_matches(self) -> None:
        """Multi-byte match conditions should require all specified bytes to match."""
        data = [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]
        self.assertTrue(check_match(data, {"D1": "0x10", "D4": "0x40", "D8": "0x80"}))
        self.assertFalse(check_match(data, {"D1": "0x10", "D4": "0x41", "D8": "0x80"}))

    def test_hex_and_integer_values(self) -> None:
        """Values provided as ints, hex strings, or un-prefixed hex should match."""
        data = [0x12, 0x34, 0, 0, 0, 0, 0, 0]
        self.assertTrue(check_match(data, {"D1": 0x12}))
        self.assertTrue(check_match(data, {"D1": "0x12"}))
        self.assertTrue(check_match(data, {"D1": "12"}))
        self.assertTrue(check_match(data, {"D2": 0x34}))

    def test_global_mask_string_and_int(self) -> None:
        """Single global mask should be applied to all matching bytes."""
        # data[0] has high nibble 1, low nibble 5
        data = [0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        # Match high nibble 0x10 with 0xF0 mask
        self.assertTrue(check_match(data, {"D1": "0x10"}, mask_spec="0xF0"))
        self.assertTrue(check_match(data, {"D1": "0x10"}, mask_spec=0xF0))

        # Matching full byte without mask should fail
        self.assertFalse(check_match(data, {"D1": "0x10"}))

        # Match low nibble with 0x0F mask
        self.assertTrue(check_match(data, {"D1": "0x05"}, mask_spec="0x0F"))
        self.assertFalse(check_match(data, {"D1": "0x10"}, mask_spec="0x0F"))

    def test_per_byte_dict_mask(self) -> None:
        """Dictionary mask_spec should apply specific masks to specific D-bytes."""
        data = [0x15, 0x2A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        masks = {"D1": "0xF0", "D2": "0x0F"}
        self.assertTrue(check_match(data, {"D1": "0x10", "D2": "0x0A"}, mask_spec=masks))

        # D3 without an explicit mask in dict should default to 0xFF
        self.assertTrue(check_match(data, {"D1": "0x10", "D2": "0x0A", "D3": "0x00"}, mask_spec=masks))
        self.assertFalse(check_match(data, {"D1": "0x10", "D2": "0x0A", "D3": "0x01"}, mask_spec=masks))

    def test_inverted_matching(self) -> None:
        """Prefixing target with ! should invert the equality check."""
        data = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        # Matches if D1 != 0x00
        self.assertTrue(check_match(data, {"D1": "!0x00"}))
        # Fails because D1 == 0x01
        self.assertFalse(check_match(data, {"D1": "!0x01"}))

        # Inverted with mask
        data_nibble = [0x15, 0, 0, 0, 0, 0, 0, 0]
        self.assertTrue(check_match(data_nibble, {"D1": "!0x20"}, mask_spec="0xF0"))
        self.assertFalse(check_match(data_nibble, {"D1": "!0x10"}, mask_spec="0xF0"))

    def test_case_insensitivity_and_unrecognized_keys(self) -> None:
        """Keys should be case-insensitive, and out-of-range keys should be skipped."""
        data = [0xAA, 0xBB, 0, 0, 0, 0, 0, 0]
        self.assertTrue(check_match(data, {"d1": "0xAA", "D2": "0xBB"}))
        # D9 and INVALID are out of bounds and skipped
        self.assertTrue(check_match(data, {"D1": "0xAA", "D9": "0xFF", "INVALID": "0x00"}))


class TestGetDIndex(unittest.TestCase):
    """Test suite for get_d_index byte offset converter."""

    def test_valid_1_based_d_indices(self) -> None:
        """D1..D8 should map to 0..7."""
        self.assertEqual(get_d_index("D1"), 0)
        self.assertEqual(get_d_index("d1"), 0)
        self.assertEqual(get_d_index("D2"), 1)
        self.assertEqual(get_d_index("D7"), 6)
        self.assertEqual(get_d_index("D8"), 7)

    def test_invalid_d_indices(self) -> None:
        """Out of bounds or non-D keys should return -1."""
        self.assertEqual(get_d_index("D9"), -1)
        self.assertEqual(get_d_index("DX"), -1)
        self.assertEqual(get_d_index(""), -1)
        self.assertEqual(get_d_index("BYTE1"), -1)


class TestParseHexVal(unittest.TestCase):
    """Test suite for parse_hex_val."""

    def test_hex_strings_and_integers(self) -> None:
        """Hex strings and integers should parse to integer values without inversion."""
        self.assertEqual(parse_hex_val("0x12"), (0x12, False))
        self.assertEqual(parse_hex_val("12"), (0x12, False))
        self.assertEqual(parse_hex_val(0x12), (0x12, False))
        self.assertEqual(parse_hex_val("0xFF"), (255, False))

    def test_inverted_strings(self) -> None:
        """Prefix '!' should flag is_inverted as True."""
        self.assertEqual(parse_hex_val("!0x12"), (0x12, True))
        self.assertEqual(parse_hex_val("!12"), (0x12, True))
        self.assertEqual(parse_hex_val("!0"), (0, True))

    def test_invalid_strings(self) -> None:
        """Malformed strings should fall back to 0."""
        self.assertEqual(parse_hex_val("not_hex"), (0, False))
        self.assertEqual(parse_hex_val("!xyz"), (0, True))


class TestVehicleCommandFiltering(unittest.TestCase):
    """Test suite for vehicle command category and active CAN ID filtering."""

    def test_category_filtering(self) -> None:
        """Filtering by category should return only commands matching the allowed categories."""
        from custom_components.can_do.catalog_loader import get_vehicle_commands
        all_cmds = get_vehicle_commands("ev6_gtline")
        doors_cmds = get_vehicle_commands("ev6_gtline", enabled_categories=["Doors, Access & Security"])
        self.assertGreater(len(all_cmds), len(doors_cmds))
        self.assertTrue(all(c.get("category") == "Doors, Access & Security" for c in doors_cmds))

    def test_active_can_id_filtering(self) -> None:
        """Filtering by active CAN IDs should exclude state telemetry commands whose ID is not seen."""
        from custom_components.can_do.catalog_loader import get_vehicle_commands
        all_cmds = get_vehicle_commands("ev6_gtline")
        # Give only 0x4CE and 0x0A2
        active_ids = {"0x4ce", "0x0a2"}
        filtered = get_vehicle_commands("ev6_gtline", active_can_ids=active_ids)
        self.assertGreater(len(all_cmds), len(filtered))
        for c in filtered:
            scid = c.get("network", {}).get("state_can_id") or c.get("state_can_id")
            acid = c.get("network", {}).get("action_can_id") or c.get("action_can_id")
            if scid and not acid:
                norm = f"0x{int(scid, 16):03x}"
                self.assertIn(norm, active_ids)

    def test_monitored_can_ids_filtered(self) -> None:
        """get_monitored_can_ids should respect enabled categories."""
        from custom_components.can_do.catalog_loader import get_monitored_can_ids
        all_ids = get_monitored_can_ids("ev6_gtline")
        doors_ids = get_monitored_can_ids("ev6_gtline", enabled_categories=["Doors, Access & Security"])
        self.assertGreater(len(all_ids), len(doors_ids))
        self.assertTrue(set(doors_ids).issubset(set(all_ids)))


class TestMultiByteStateDecoding(unittest.TestCase):
    """Test suite for 1-byte and 2-byte (16-bit) state_byte decoding and bounds checking."""

    def test_default_endianness_is_little(self) -> None:
        self.assertEqual(DEFAULT_ENDIANNESS, "little")

    def test_parse_state_byte_spec(self) -> None:
        self.assertEqual(parse_state_byte_spec({"state_byte": "D1"}), (0, 1, "little"))
        self.assertEqual(
            parse_state_byte_spec({"state_byte": "D3", "byte_length": 2}),
            (2, 2, "little"),
        )
        self.assertEqual(
            parse_state_byte_spec({"state_byte": "D7", "byte_length": 2, "endianness": "big"}),
            (6, 2, "big"),
        )
        # Legacy range strings must fail cleanly with start_idx == -1
        self.assertEqual(parse_state_byte_spec({"state_byte": "D1-D2"})[0], -1)
        # Unsupported byte_length must fail cleanly
        self.assertEqual(parse_state_byte_spec({"state_byte": "D1", "byte_length": 3})[0], -1)
        self.assertEqual(parse_state_byte_spec({"state_byte": "D1", "byte_length": 0})[0], -1)
        self.assertEqual(parse_state_byte_spec({"state_byte": "D1", "byte_length": True})[0], -1)

    def test_decode_can_uint_endianness_and_mask(self) -> None:
        payload = [0x48, 0x03, 0x14, 0x00, 0x12, 0x34, 0x2C, 0x01]
        # 1-byte default
        self.assertEqual(decode_can_uint(payload, 0, 1), 0x48)
        # 2-byte little-endian (default): D1=0x48, D2=0x03 -> 0x0348 = 840
        self.assertEqual(decode_can_uint(payload, 0, 2), 840)
        self.assertEqual(decode_can_uint(payload, 6, 2, "little"), 300)
        # 2-byte big-endian: D5=0x12, D6=0x34 -> 0x1234
        self.assertEqual(decode_can_uint(payload, 4, 2, "big"), 0x1234)
        # Optional bitmask on 16-bit value
        self.assertEqual(decode_can_uint(payload, 4, 2, "big", mask="0x0FFF"), 0x0234)

    def test_decode_can_uint_bounds_checking(self) -> None:
        payload_8 = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]
        # D8 (idx 7) + 2 bytes exceeds 8-byte payload
        self.assertIsNone(decode_can_uint(payload_8, 7, 2))
        self.assertIsNone(
            decode_network_state_value(payload_8, {"state_byte": "D8", "byte_length": 2})
        )
        # Short payload (DLC=1) for 2-byte read starting at D1
        self.assertIsNone(decode_can_uint([0x48], 0, 2))
        # Short payload (DLC=3) for 2-byte read starting at D3 (idx 2)
        self.assertIsNone(decode_can_uint([0x00, 0x00, 0x14], 2, 2))
        # Negative start index
        self.assertIsNone(decode_can_uint(payload_8, -1, 2))


if __name__ == "__main__":
    unittest.main()
