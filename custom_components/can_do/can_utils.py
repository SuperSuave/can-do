"""CAN conversion and helper utilities for CAN Do."""

import re
from typing import Any

from .catalog_loader import get_d_index, parse_hex_val

_OFF_OPTION_RE = re.compile(r"\b(off|inactive|disabled?|shut|stop|cancel)\b", re.IGNORECASE)
_ON_OPTION_RE = re.compile(r"\b(on|active|enabled?|start)\b", re.IGNORECASE)


def is_off_option_label(label: str) -> bool:
    """Return True if an option label indicates an OFF/inactive/disabled state."""
    return bool(label and _OFF_OPTION_RE.search(label))


def is_on_option_label(label: str) -> bool:
    """Return True if an option label indicates an ON/active/enabled state."""
    if not label or is_off_option_label(label):
        return False
    return bool(_ON_OPTION_RE.search(label))


def find_switch_option(command: dict[str, Any], turn_on: bool) -> dict[str, Any] | None:
    """Select the catalog option corresponding to turning a switch on or off."""
    options = command.get("options", [])
    if not options:
        return None

    matcher = is_on_option_label if turn_on else is_off_option_label
    opposite = is_off_option_label if turn_on else is_on_option_label

    for opt in options:
        if matcher(opt.get("label", "")):
            return opt

    for opt in options:
        if not opposite(opt.get("label", "")):
            return opt

    return None


def _build_step_dict(
    step_spec: dict[str, Any],
    base_payload: list[int] | None = None,
) -> dict[str, Any]:
    """Convert a catalog step specification dict into an ESP32 action step dict."""
    step_type = step_spec.get("type")
    if step_type == "delay":
        return {
            "type": "delay",
            "delay_ms": step_spec.get("delay_ms", step_spec.get("dwell_ms", 20)),
        }

    step: dict[str, Any] = {
        "payload": build_hex_payload(step_spec.get("payload", {}), base_payload),
        "repeat": step_spec.get("repeat", 1),
        "delay_ms": step_spec.get("delay_ms", step_spec.get("dwell_ms", 20)),
    }
    if step_type:
        step["type"] = step_type
    step_can_id = step_spec.get("can_id") or step_spec.get("action_can_id")
    if step_can_id:
        step["can_id"] = step_can_id
    if "bus" in step_spec and step_spec["bus"] is not None:
        step["bus"] = step_spec["bus"]
    return step


def resolve_base_payload(
    coordinator: Any,
    command: dict[str, Any],
    action_can_id: str | None,
    state_can_id: str | None,
) -> list[int] | None:
    """Resolve an 8-byte base payload from live CAN state (when IDs match) or network defaults."""
    if state_can_id and action_can_id and state_can_id.lower() == action_can_id.lower():
        curr = coordinator.get_can_payload(state_can_id)
        if curr and len(curr) == 8:
            return list(curr)

    net_base = command.get("network", {}).get("base_payload")
    if isinstance(net_base, list) and len(net_base) == 8:
        base: list[int] = []
        for b in net_base:
            val, _ = parse_hex_val(b) if isinstance(b, str) else (int(b), False)
            base.append(val & 0xFF)
        return base
    return None


def build_hex_payload(payload_spec: Any, base_payload: list[int] | None = None) -> str:
    """Build a 16-character hex string representing an 8-byte CAN message."""
    data = list(base_payload) if base_payload and len(base_payload) == 8 else [0] * 8

    if isinstance(payload_spec, str):
        # Raw hex string
        clean = payload_spec.strip().replace(" ", "").replace("0x", "")
        if len(clean) == 16:
            return clean.upper()
        # Short hex string padded to 8 bytes
        return clean.ljust(16, "0").upper()

    if isinstance(payload_spec, dict):
        if "hex" in payload_spec:
            return str(payload_spec["hex"]).strip().replace(" ", "").replace("0x", "").upper()
        if "data" in payload_spec:
            return str(payload_spec["data"]).strip().replace(" ", "").replace("0x", "").upper()
        if "raw" in payload_spec:
            return str(payload_spec["raw"]).strip().replace(" ", "").replace("0x", "").upper()
        for k, v in payload_spec.items():
            idx = get_d_index(k)
            if 0 <= idx < 8:
                val, _ = parse_hex_val(v)
                data[idx] = val & 0xFF

    return "".join(f"{b:02X}" for b in data)


def build_action_steps(
    command: dict[str, Any],
    option: dict[str, Any] | None = None,
    base_payload: list[int] | None = None,
) -> list[dict[str, Any]]:
    """Generate list of action steps suitable for ESP32 raw burst transmission."""
    steps: list[dict[str, Any]] = []

    # 1. Option-level steps
    if option:
        if "steps" in option:
            return [_build_step_dict(s, base_payload) for s in option["steps"]]
        elif "payload" in option:
            steps.append(
                {
                    "payload": build_hex_payload(option["payload"], base_payload),
                    "repeat": option.get("repeat", 1),
                    "delay_ms": option.get("delay_ms", 20),
                }
            )
            return steps

    # 2. Command-level steps
    if "steps" in command:
        return [_build_step_dict(s, base_payload) for s in command["steps"]]

    # 3. Fallback default single frame if payload exists
    if "payload" in command:
        steps.append(
            {
                "payload": build_hex_payload(command["payload"], base_payload),
                "repeat": command.get("repeat", 1),
                "delay_ms": command.get("delay_ms", 20),
            }
        )

    return steps


def decode_outdoor_temperature_c(
    p_31c: list[int] | None = None,
    p_227: list[int] | None = None,
    p_226: list[int] | None = None,
) -> float | None:
    """Decode E-GMP outdoor ambient temperature in °C from 0x31C (primary) or 0x227/0x226 fallbacks."""
    if isinstance(p_31c, list) and len(p_31c) >= 1:
        raw = p_31c[0]
        if 2 <= raw <= 202:
            return round(raw * 0.5 - 41.0, 1)

    if isinstance(p_227, list) and len(p_227) >= 8:
        raw_f = ((p_227[7] & 0x07) << 5) | ((p_227[6] >> 3) & 0x1F)
        if 0 < raw_f <= 180:
            return round(((raw_f - 40) - 32.0) / 1.8, 2)

    if isinstance(p_226, list) and len(p_226) >= 4:
        raw_c = p_226[3]
        if 0 < raw_c <= 100:
            return float(raw_c - 40)

    return None
