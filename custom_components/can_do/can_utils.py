"""CAN conversion and helper utilities for CAN Do."""

from typing import Any, Dict, List, Optional
from .catalog_loader import get_d_index, parse_hex_val


def build_hex_payload(payload_spec: Any, base_payload: Optional[List[int]] = None) -> str:
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
        for k, v in payload_spec.items():
            idx = get_d_index(k)
            if 0 <= idx < 8:
                val, _ = parse_hex_val(v)
                data[idx] = val & 0xFF

    return "".join(f"{b:02X}" for b in data)


def build_action_steps(
    command: Dict[str, Any],
    option: Optional[Dict[str, Any]] = None,
    base_payload: Optional[List[int]] = None,
) -> List[Dict[str, Any]]:
    """Generate list of action steps suitable for ESP32 raw burst transmission."""
    steps: List[Dict[str, Any]] = []

    # 1. Option-level steps
    if option:
        if "steps" in option:
            for s in option["steps"]:
                steps.append(
                    {
                        "payload": build_hex_payload(s.get("payload", {}), base_payload),
                        "repeat": s.get("repeat", 1),
                        "delay_ms": s.get("delay_ms", 20),
                    }
                )
            return steps
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
        for s in command["steps"]:
            steps.append(
                {
                    "payload": build_hex_payload(s.get("payload", {}), base_payload),
                    "repeat": s.get("repeat", 1),
                    "delay_ms": s.get("delay_ms", 20),
                }
            )
        return steps

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
