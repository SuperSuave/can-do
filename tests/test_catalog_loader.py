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

from custom_components.can_do.catalog_loader import check_match, get_d_index, parse_hex_val


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


if __name__ == "__main__":
    unittest.main()
