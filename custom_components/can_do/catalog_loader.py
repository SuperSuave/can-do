"""Catalog loader for CAN Do integration."""

import json
import logging
import os
from typing import Any

from .const import VERSION

_LOGGER = logging.getLogger(__name__)

# Track which (command_id, vehicle_id) pairs have already emitted a variant
# fallback warning so we don't spam the log on every CAN frame.
_warned_variants: set[tuple[str, str]] = set()

_CATALOG_DATA: dict[str, Any] | None = None
_VEHICLE_CACHE: dict[str, dict[str, Any]] | None = None


def normalize_can_id(cid: str | None) -> str:
    """Normalize CAN ID to standard 3-digit lower-case hex format (e.g. '0x045', '0x1ac')."""
    if not cid:
        return ""
    s = str(cid).strip().lower()
    if s.startswith("0x"):
        try:
            return f"0x{int(s, 16):03x}"
        except ValueError:
            pass
    return s


def load_catalog() -> dict[str, Any]:
    """Load can_do_catalog.json from repository, fresh local cache, or GitHub."""
    global _CATALOG_DATA
    if _CATALOG_DATA is not None:
        return _CATALOG_DATA

    repo_catalog = os.path.abspath(
        os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "catalog",
            "can_do_catalog.json",
        )
    )
    local_cache = os.path.join(os.path.dirname(__file__), "can_do_catalog.json")

    # 1. Monorepo root canonical catalog (single source of truth in git)
    try:
        with open(repo_catalog, "r", encoding="utf-8") as f:
            _CATALOG_DATA = json.load(f)
            _LOGGER.debug("Loaded CAN Do catalog from %s", repo_catalog)
            return _CATALOG_DATA
    except FileNotFoundError:
        pass
    except Exception as ex:
        _LOGGER.error("Failed to parse catalog at %s: %s", repo_catalog, ex)

    # 2. Local HACS cached catalog (use directly if version matches integration VERSION)
    cached_data: dict[str, Any] | None = None
    try:
        with open(local_cache, "r", encoding="utf-8") as f:
            cached_data = json.load(f)
            if cached_data.get("can_do_version") == VERSION:
                _LOGGER.debug("Loaded CAN Do catalog from %s (v%s)", local_cache, VERSION)
                _CATALOG_DATA = cached_data
                return _CATALOG_DATA
            _LOGGER.info(
                "Cached catalog version '%s' differs from integration '%s'; refreshing",
                cached_data.get("can_do_version"),
                VERSION,
            )
    except FileNotFoundError:
        pass
    except Exception as ex:
        _LOGGER.error("Failed to parse catalog at %s: %s", local_cache, ex)

    # 3. Dynamic fetch for standalone HACS installations without repo clone or with stale cache
    online_url = "https://raw.githubusercontent.com/SuperSuave/can-do/main/catalog/can_do_catalog.json"
    try:
        import urllib.request
        _LOGGER.info("Fetching canonical CAN Do catalog from GitHub: %s", online_url)
        with urllib.request.urlopen(online_url, timeout=10) as resp:
            data = resp.read()
            _CATALOG_DATA = json.loads(data.decode("utf-8"))
            try:
                with open(local_cache, "wb") as f:
                    f.write(data)
            except Exception:
                pass
            return _CATALOG_DATA
    except Exception as ex:
        _LOGGER.warning("Could not fetch remote catalog: %s", ex)

    if cached_data is not None:
        _LOGGER.warning("Using stale cached CAN Do catalog from %s", local_cache)
        _CATALOG_DATA = cached_data
        return _CATALOG_DATA

    _LOGGER.error("Could not locate can_do_catalog.json in candidates")
    _CATALOG_DATA = {"can_do_version": "unknown", "vehicles": [], "commands": []}
    return _CATALOG_DATA


async def async_load_catalog(hass: Any) -> dict[str, Any]:
    """Load catalog asynchronously via executor to avoid blocking the event loop."""
    global _CATALOG_DATA
    if _CATALOG_DATA is not None:
        return _CATALOG_DATA
    return await hass.async_add_executor_job(load_catalog)


def get_vehicles() -> list[tuple[str, str]]:
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


async def async_get_vehicles(hass: Any) -> list[tuple[str, str]]:
    """Return list of (vehicle_id, display_name) asynchronously via executor."""
    await async_load_catalog(hass)
    return get_vehicles()


def get_vehicle_definition(vehicle_id: str) -> dict[str, Any] | None:
    """Get vehicle metadata dict by vehicle_id."""
    global _VEHICLE_CACHE
    if _VEHICLE_CACHE is None:
        catalog = load_catalog()
        _VEHICLE_CACHE = {v.get("id"): v for v in catalog.get("vehicles", []) if "id" in v}
    return _VEHICLE_CACHE.get(vehicle_id)


def resolve_variant(command: dict[str, Any], vehicle_id: str) -> dict[str, Any]:
    """Return a copy of *command* with network/options resolved for *vehicle_id*.

    If the command has no ``variants`` key it is returned unchanged (zero-copy).
    When a matching variant is found its ``network`` and ``options`` are merged
    over the base command dict.  When *no* variant matches the selected vehicle
    or its family, a one-time warning is logged and the first variant is used as
    a best-guess fallback.
    """
    variants = command.get("variants")
    if not variants:
        return command

    vehicle = get_vehicle_definition(vehicle_id)
    family = vehicle.get("family", "") if vehicle else ""

    EGMP_FAMILIES = {"all_egmp", "hyundai_ioniq5", "hyundai_ioniq6", "kia_ev6", "genesis_gv60"}
    GEN2_GEN3_FAMILIES = {"all_gen2", "all_gen2a", "all_gen3", "kia_niro_ev", "hyundai_kona_ev", "kia_soul_ev", "hyundai_ioniq_ev"}

    for variant in variants:
        targets = variant.get("targets", [])
        is_match = (
            vehicle_id in targets
            or (family and family in targets)
            or ("all_egmp" in targets and (family in EGMP_FAMILIES or vehicle_id in EGMP_FAMILIES))
            or (
                ("all_gen2" in targets or "all_gen2a" in targets or "all_gen3" in targets)
                and (family in GEN2_GEN3_FAMILIES or vehicle_id in GEN2_GEN3_FAMILIES)
            )
        )
        if is_match:
            resolved = dict(command)
            if "network" in variant:
                resolved["network"] = variant["network"]
                if "state_can_id" in variant["network"]:
                    resolved["state_can_id"] = variant["network"]["state_can_id"]
                if "action_can_id" in variant["network"]:
                    resolved["action_can_id"] = variant["network"]["action_can_id"]
            if "options" in variant:
                resolved["options"] = variant["options"]
            return resolved

    # No matching variant — warn once per (command, vehicle) pair, use first as fallback
    warn_key = (command.get("id", ""), vehicle_id)
    if warn_key not in _warned_variants:
        _warned_variants.add(warn_key)
        _LOGGER.warning(
            "CAN Do catalog: command '%s' has variants but none match vehicle '%s' "
            "(family: '%s'). Falling back to first variant as best-guess.",
            command.get("id", "<unknown>"),
            vehicle_id,
            family or "<none>",
        )

    fallback = variants[0]
    resolved = dict(command)
    if "network" in fallback:
        resolved["network"] = fallback["network"]
        if "state_can_id" in fallback["network"]:
            resolved["state_can_id"] = fallback["network"]["state_can_id"]
        if "action_can_id" in fallback["network"]:
            resolved["action_can_id"] = fallback["network"]["action_can_id"]
    if "options" in fallback:
        resolved["options"] = fallback["options"]
    return resolved


def get_vehicle_commands(
    vehicle_id: str,
    enabled_categories: list[str] | set[str] | None = None,
    active_can_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Filter commands applicable to the selected vehicle, resolving variants and optional filters."""
    catalog = load_catalog()
    vehicle = get_vehicle_definition(vehicle_id)
    family = vehicle.get("family", "") if vehicle else ""

    cat_set = set(enabled_categories) if enabled_categories is not None else None
    act_set = {normalize_can_id(cid) for cid in active_can_ids if cid} if active_can_ids is not None else None

    matched = []
    for c in catalog.get("commands", []):
        tags = c.get("tags", [])
        if "all_egmp" in tags or vehicle_id in tags or (family and family in tags):
            if cat_set is not None:
                cat = c.get("category", "")
                if cat and cat not in cat_set:
                    continue

            resolved = resolve_variant(c, vehicle_id)

            if act_set is not None:
                net = resolved.get("network", {})
                scid = net.get("state_can_id") or resolved.get("state_can_id")
                acid = net.get("action_can_id") or resolved.get("action_can_id")
                # If command has a state telemetry CAN ID and no action trigger, verify it is active
                if scid:
                    if normalize_can_id(scid) not in act_set and not acid:
                        continue

            matched.append(resolved)
    return matched


def get_monitored_can_ids(
    vehicle_id: str,
    enabled_categories: list[str] | set[str] | None = None,
) -> list[str]:
    """Get unique state CAN IDs (e.g. '0x448') used by the selected vehicle's commands."""
    commands = get_vehicle_commands(vehicle_id, enabled_categories=enabled_categories)
    ids: set[str] = set()
    has_climate = False
    has_light = False
    has_outdoor_temp = False
    has_12v = False
    for c in commands:
        net = c.get("network", {})
        cid = net.get("state_can_id") or c.get("state_can_id")
        if cid:
            ids.add(normalize_can_id(cid))

        domain = c.get("ha_metadata", {}).get("domain")
        cmd_id = str(c.get("id", "")).lower()
        if domain == "climate":
            has_climate = True
        elif domain == "light":
            has_light = True
        if cmd_id in ("outdoor_temperature", "cond_ambient_temperature", "ambient_temperature") or "ambient_temp" in cmd_id:
            has_outdoor_temp = True
        if "12v" in cmd_id or "aux" in cmd_id:
            has_12v = True

    if has_climate:
        ids.update(("0x226", "0x227", "0x31c", "0x2ad", "0x2ae", "0x475"))
    if has_light:
        ids.update(("0x455", "0x2db"))
    if has_outdoor_temp:
        ids.update(("0x31c", "0x227", "0x226"))
    if has_12v:
        ids.add("0x1cf")

    return sorted(ids)


DEFAULT_ENDIANNESS = "little"


def get_d_index(key: str) -> int:
    """Convert 'D1'..'D8' (1-based) to 0..7 index."""
    if not isinstance(key, str):
        return -1
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


def parse_hex_val(val: Any) -> tuple[int, bool]:
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


def normalize_endianness(endianness: Any) -> str:
    """Normalize endianness string to 'little' (default) or 'big'."""
    if isinstance(endianness, str):
        e = endianness.strip().lower()
        if e in ("big", "be", "motorola"):
            return "big"
        if e in ("little", "le", "intel"):
            return "little"
    return DEFAULT_ENDIANNESS


def parse_state_byte_spec(
    net: dict[str, Any] | None,
    default_byte: str = "D1",
) -> tuple[int, int, str]:
    """Parse (start_idx, byte_length, endianness) from a catalog network dict.

    Supports single starting 1-based state_byte ('D1'..'D8'), explicit byte_length
    (1 or 2, default 1), and endianness ('little' default, or 'big').
    Returns start_idx == -1 if state_byte or byte_length is invalid.
    """
    net_dict = net if isinstance(net, dict) else {}
    raw_byte = net_dict.get("state_byte")
    byte_str = default_byte if raw_byte is None else raw_byte
    start_idx = get_d_index(byte_str) if isinstance(byte_str, str) else -1

    endianness = normalize_endianness(net_dict.get("endianness"))

    raw_len = net_dict.get("byte_length")
    if raw_len is None:
        byte_length = 1
    elif isinstance(raw_len, bool):
        return -1, 0, endianness
    else:
        try:
            byte_length = int(raw_len)
        except (TypeError, ValueError):
            return -1, 0, endianness
        if byte_length not in (1, 2):
            return -1, 0, endianness

    return start_idx, byte_length, endianness


def decode_can_uint(
    payload: list[int] | tuple[int, ...],
    start_idx: int,
    byte_length: int = 1,
    endianness: str = DEFAULT_ENDIANNESS,
    mask: Any = None,
) -> int | None:
    """Decode a 1-byte or 2-byte unsigned integer from CAN payload with bounds checking.

    Returns None if payload is invalid or start_idx + byte_length exceeds len(payload).
    """
    if not isinstance(payload, (list, tuple)):
        return None
    if isinstance(byte_length, bool) or byte_length not in (1, 2):
        return None
    if start_idx < 0 or start_idx + byte_length > len(payload):
        return None

    if byte_length == 1:
        raw = int(payload[start_idx]) & 0xFF
    else:
        b0 = int(payload[start_idx]) & 0xFF
        b1 = int(payload[start_idx + 1]) & 0xFF
        if normalize_endianness(endianness) == "big":
            raw = (b0 << 8) | b1
        else:
            raw = b0 | (b1 << 8)

    if mask is not None and not isinstance(mask, bool):
        if isinstance(mask, (int, str)) and (not isinstance(mask, str) or mask.strip()):
            mask_val, _ = parse_hex_val(mask)
            raw &= mask_val

    return raw


def check_match(data: list[int], match_dict: dict[str, Any], mask_spec: Any = None) -> bool:
    """Check whether raw 8-byte CAN payload matches the condition."""
    if not match_dict or not data or not isinstance(data, (list, tuple)):
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
