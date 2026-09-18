"""Catalog loader for CAN Do integration."""

import json
import logging
import os
from typing import Any, Dict, List, Optional, Set, Tuple

_LOGGER = logging.getLogger(__name__)

_CATALOG_DATA: Optional[Dict[str, Any]] = None


def load_catalog() -> Dict[str, Any]:
    """Load can_do_catalog.json from integration directory or repo root."""
    global _CATALOG_DATA
    if _CATALOG_DATA is not None:
        return _CATALOG_DATA

    candidates = [
        os.path.join(os.path.dirname(__file__), "can_do_catalog.json"),
        os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "..",
            "catalog",
            "can_do_catalog.json",
        ),
    ]

    for path in candidates:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    _CATALOG_DATA = json.load(f)
                    _LOGGER.debug("Loaded CAN Do catalog from %s", path)
                    return _CATALOG_DATA
            except Exception as ex:
                _LOGGER.error("Failed to parse catalog at %s: %s", path, ex)

    _LOGGER.error("Could not locate can_do_catalog.json in candidates")
    _CATALOG_DATA = {"catalog_version": "1.0", "vehicles": [], "commands": []}
    return _CATALOG_DATA


def get_vehicles() -> List[Tuple[str, str]]:
    """Return list of (vehicle_id, display_name)."""
    catalog = load_catalog()
    vehicles = []
    for v in catalog.get("vehicles", []):
        vid = v.get("id")
        make = v.get("make", "")
        model = v.get("model", "")
        trim = v.get("name", "")
        region = v.get("region", "").upper()
        reg_str = f" [{region}]" if region and region != "GLOBAL" and region != "UNIVERSAL" else ""
        label = f"{make} {model} {trim}{reg_str}".strip()
        vehicles.append((vid, label))
    return vehicles


def get_vehicle_definition(vehicle_id: str) -> Optional[Dict[str, Any]]:
    """Get vehicle metadata dict by vehicle_id."""
    catalog = load_catalog()
    for v in catalog.get("vehicles", []):
        if v.get("id") == vehicle_id:
            return v
    return None


def get_vehicle_commands(vehicle_id: str) -> List[Dict[str, Any]]:
    """Filter commands applicable to the selected vehicle."""
    catalog = load_catalog()
    vehicle = get_vehicle_definition(vehicle_id)
    family = vehicle.get("family", "") if vehicle else ""

    matched = []
    for c in catalog.get("commands", []):
        tags = c.get("tags", [])
        if "all_egmp" in tags or vehicle_id in tags or (family and family in tags):
            matched.append(c)
    return matched


def get_monitored_can_ids(vehicle_id: str) -> List[str]:
    """Get unique state CAN IDs (e.g. '0x448') used by the selected vehicle's commands."""
    commands = get_vehicle_commands(vehicle_id)
    ids: Set[str] = set()
    for c in commands:
        net = c.get("network", {})
        cid = net.get("state_can_id")
        if cid:
            ids.add(cid.lower())
    return sorted(list(ids))


def get_d_index(key: str) -> int:
    """Convert 'D1'..'D8' (1-based) to 0..7 index."""
    k = key.strip().upper()
    if k.startswith("D") and len(k) >= 2:
        try:
            val = int(k[1:])
            if 1 <= val <= 8:
                return val - 1
            if 0 <= val <= 7:
                return val
        except ValueError:
            pass
    return -1


def parse_hex_val(val: Any) -> Tuple[int, bool]:
    """Parse hex string or int, returning (integer_val, is_inverted)."""
    if isinstance(val, int):
        return val, False
    s = str(val).strip()
    inverted = False
    if s.startswith("!"):
        inverted = True
        s = s[1:].strip()
    try:
        return int(s, 16), inverted
    except ValueError:
        return 0, inverted


def check_match(data: List[int], match_dict: Dict[str, Any], mask_spec: Any = None) -> bool:
    """Check whether raw 8-byte CAN payload matches the condition."""
    if not match_dict or not data:
        return False

    for k, v in match_dict.items():
        idx = get_d_index(k)
        if idx < 0 or idx >= len(data):
            continue

        target_val, inverted = parse_hex_val(v)
        byte_mask = 0xFF

        if isinstance(mask_spec, (str, int)):
            byte_mask, _ = parse_hex_val(mask_spec)
        elif isinstance(mask_spec, dict) and k in mask_spec:
            byte_mask, _ = parse_hex_val(mask_spec[k])

        actual = data[idx] & byte_mask
        target = target_val & byte_mask

        if inverted:
            if actual == target:
                return False
        else:
            if actual != target:
                return False

    return True
