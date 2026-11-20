#!/usr/bin/env python3
"""
Permanent zero-dependency validator for catalog/can_do_catalog.json.

Validates the CAN Do catalog against ESP32 firmware (parser.cpp),
Home Assistant integration (custom_components/can_do), and frontend contracts.

Usage:
    python3 scripts/validate_catalog.py
    python3 scripts/validate_catalog.py catalog/can_do_catalog.json --strict
    python3 scripts/validate_catalog.py --json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

# Supported Home Assistant platforms in custom_components/can_do/
SUPPORTED_HA_DOMAINS: frozenset[str] = frozenset(
    {
        "binary_sensor",
        "button",
        "climate",
        "cover",
        "event",
        "light",
        "lock",
        "notify",
        "number",
        "select",
        "sensor",
        "switch",
    }
)

# Entities explicitly allowed to omit ha_metadata (handled internally by another HA platform)
ALLOW_MISSING_HA_METADATA: frozenset[str] = frozenset(
    {
        "ambient_light_brightness",
    }
)

# Subsystem/protocol types that transmit via dedicated firmware engines instead of raw steps
SUBSYSTEM_TX_TYPES: frozenset[str] = frozenset(
    {
        "track_popup",
        "hud_nav",
        "precondition",
        "remote_climate",
        "ambient_anim",
    }
)

# Legacy non-E-GMP targets that conflict with strict E-GMP project focus
LEGACY_NON_EGMP_TARGETS: frozenset[str] = frozenset(
    {
        "all_gen1",
        "all_gen2",
        "all_gen2a",
        "hyundai_kona_ev",
        "kia_niro_ev",
        "kia_soul_ev",
        "hyundai_ioniq_ev",
    }
)

CLASSIC_BYTE_RE = re.compile(r"^D([1-8])$")
CANFD_BYTE_RE = re.compile(r"^D([1-9]|[1-5][0-9]|6[0-4])$")
HEX_CHARS_RE = re.compile(r"^[0-9a-fA-F]+$")
CAN_ID_RE = re.compile(r"^0[xX][0-9a-fA-F]{1,8}$")


@dataclass(frozen=True)
class Finding:
    severity: str  # "ERROR" | "WARNING"
    category: str
    code: str
    entity_id: str
    reason: str
    option_label: str | None = None
    line: int | None = None


def parse_byte_value(raw: Any, *, allow_invert: bool = False) -> tuple[int | None, bool, str | None]:
    """
    Parse a single-byte hex value (e.g. '0x0F', '!0x00').
    Returns (int_value, is_inverted, error_message).
    """
    if not isinstance(raw, str):
        return None, False, f"expected hex string, got {type(raw).__name__}"

    text = raw.strip()
    inverted = False
    if text.startswith("!"):
        if not allow_invert:
            return None, False, f"unexpected '!' negation prefix in '{raw}'"
        inverted = True
        text = text[1:].strip()

    if not text.lower().startswith("0x"):
        return None, inverted, f"byte value '{raw}' must use '0x' hex prefix"

    hex_part = text[2:]
    if not hex_part or not HEX_CHARS_RE.match(hex_part):
        return None, inverted, f"invalid hex byte value '{raw}'"
    if len(hex_part) % 2 != 0:
        return None, inverted, f"odd-length hex byte value '{raw}'"

    val = int(hex_part, 16)
    if val < 0 or val > 0xFF:
        return None, inverted, f"byte value '{raw}' out of range (0x00..0xFF)"

    return val, inverted, None


def normalize_can_id(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not CAN_ID_RE.match(s):
        return None
    return f"0x{int(s, 16):X}"


def is_can_fd_entity(cmd: dict[str, Any], net: dict[str, Any] | None = None, step: dict[str, Any] | None = None) -> bool:
    for obj in (step, net, cmd):
        if not isinstance(obj, dict):
            continue
        if obj.get("can_fd") is True or obj.get("is_fd") is True or obj.get("fd") is True:
            return True
        protocol = str(obj.get("protocol", "")).lower()
        bus_type = str(obj.get("type", "")).lower()
        if "can_fd" in protocol or "canfd" in protocol or "can_fd" in bus_type or "canfd" in bus_type:
            return True
    return False


def index_catalog_lines(raw_text: str, entity_ids: set[str]) -> tuple[dict[str, int], dict[tuple[str, str], int]]:
    """Best-effort line number index for entities and root option labels."""
    entity_lines: dict[str, int] = {}
    option_lines: dict[tuple[str, str], int] = {}
    current_entity: str | None = None
    in_variants = False

    id_re = re.compile(r'^\s*"id"\s*:\s*"([^"]+)"')
    variants_re = re.compile(r'^\s*"variants"\s*:\s*\[')
    label_re = re.compile(r'^\s*"label"\s*:\s*"((?:[^"\\]|\\.)*)"')

    for lineno, line in enumerate(raw_text.splitlines(), 1):
        m_id = id_re.match(line)
        if m_id and m_id.group(1) in entity_ids:
            eid = m_id.group(1)
            if eid not in entity_lines:
                entity_lines[eid] = lineno
            current_entity = eid
            in_variants = False
            continue

        if current_entity is not None:
            if variants_re.match(line):
                in_variants = True
                continue
            if not in_variants:
                m_lbl = label_re.match(line)
                if m_lbl:
                    lbl = m_lbl.group(1).replace('\\"', '"')
                    key = (current_entity, lbl)
                    if key not in option_lines:
                        option_lines[key] = lineno

    return entity_lines, option_lines


def is_legacy_target(target: str) -> bool:
    t = target.strip().lower()
    return t in LEGACY_NON_EGMP_TARGETS or t.startswith("all_gen1") or t.startswith("all_gen2")


def validate_byte_index_key(
    key: Any,
    *,
    is_fd: bool,
    context: str,
    entity_id: str,
    option_label: str | None,
    line: int | None,
    findings: list[Finding],
) -> int | None:
    if not isinstance(key, str):
        findings.append(
            Finding(
                "ERROR",
                "payload",
                "invalid_byte_index",
                entity_id,
                f"{context} byte key must be string, got {type(key).__name__}",
                option_label,
                line,
            )
        )
        return None

    pattern = CANFD_BYTE_RE if is_fd else CLASSIC_BYTE_RE
    m = pattern.match(key.strip())
    if not m:
        limit_str = "D1-D64 (CAN-FD)" if is_fd else "D1-D8"
        findings.append(
            Finding(
                "ERROR",
                "payload",
                "invalid_byte_index",
                entity_id,
                f"{context} has invalid byte index '{key}' (expected strict {limit_str})",
                option_label,
                line,
            )
        )
        return None
    return int(m.group(1))


VALID_ENDIANNESS_VALUES: frozenset[str] = frozenset({"little", "le", "intel", "big", "be", "motorola"})


def validate_state_byte_length(
    net_obj: dict[str, Any],
    start_byte_idx: int | None,
    *,
    is_fd: bool,
    context: str,
    entity_id: str,
    line: int | None,
    findings: list[Finding],
) -> int:
    """
    Validate optional network.byte_length (1 or 2) and optional network.endianness alongside state_byte.
    Returns validated byte_length (1 or 2, defaulting to 1).
    """
    max_bytes = 64 if is_fd else 8
    byte_length = 1

    if "byte_length" in net_obj and net_obj["byte_length"] is not None:
        raw_len = net_obj["byte_length"]
        if isinstance(raw_len, bool) or not isinstance(raw_len, int) or raw_len not in (1, 2):
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "invalid_byte_length",
                    entity_id,
                    f"{context}.byte_length={raw_len!r} must be integer 1 or 2",
                    None,
                    line,
                )
            )
        else:
            byte_length = raw_len
            if start_byte_idx is not None and (start_byte_idx + byte_length - 1) > max_bytes:
                findings.append(
                    Finding(
                        "ERROR",
                        "payload",
                        "byte_length_exceeds_can_limit",
                        entity_id,
                        f"{context}.state_byte='D{start_byte_idx}' with byte_length={byte_length} "
                        f"exceeds {max_bytes}-byte CAN payload limit",
                        None,
                        line,
                    )
                )

    if "endianness" in net_obj and net_obj["endianness"] is not None:
        raw_endian = net_obj["endianness"]
        if not isinstance(raw_endian, str) or raw_endian.strip().lower() not in VALID_ENDIANNESS_VALUES:
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "invalid_endianness",
                    entity_id,
                    f"{context}.endianness={raw_endian!r} must be one of: little, big",
                    None,
                    line,
                )
            )

    return byte_length


def validate_payload_value(
    payload: Any,
    *,
    is_fd: bool,
    is_match: bool,
    context: str,
    entity_id: str,
    option_label: str | None,
    line: int | None,
    findings: list[Finding],
    allow_byte_list: bool = False,
) -> None:
    max_bytes = 64 if is_fd else 8

    if isinstance(payload, str):
        s = payload.strip()
        if s.lower().startswith("0x"):
            s = s[2:]
        if not s:
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "invalid_hex_payload",
                    entity_id,
                    f"{context} has empty hex string payload",
                    option_label,
                    line,
                )
            )
            return
        if not HEX_CHARS_RE.match(s):
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "invalid_hex_payload",
                    entity_id,
                    f"{context} contains non-hex characters: '{payload}'",
                    option_label,
                    line,
                )
            )
            return
        if len(s) % 2 != 0:
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "odd_length_hex",
                    entity_id,
                    f"{context} has odd-length hex string ({len(s)} chars): '{payload}'",
                    option_label,
                    line,
                )
            )
            return
        byte_len = len(s) // 2
        if byte_len > max_bytes:
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "payload_exceeds_can_limit",
                    entity_id,
                    f"{context} is {byte_len} bytes (exceeds {max_bytes}-byte limit)",
                    option_label,
                    line,
                )
            )
        return

    if isinstance(payload, dict):
        if len(payload) == 0:
            if not is_match:
                findings.append(
                    Finding(
                        "WARNING",
                        "payload",
                        "empty_tx_payload",
                        entity_id,
                        f"{context} has empty TX ByteMap {{}} (relies on implicit zero-fill)",
                        option_label,
                        line,
                    )
                )
            return

        for k, v in payload.items():
            validate_byte_index_key(
                k,
                is_fd=is_fd,
                context=context,
                entity_id=entity_id,
                option_label=option_label,
                line=line,
                findings=findings,
            )
            _, _, err = parse_byte_value(v, allow_invert=is_match)
            if err:
                findings.append(
                    Finding(
                        "ERROR",
                        "payload",
                        "invalid_hex_payload",
                        entity_id,
                        f"{context}[{k}]: {err}",
                        option_label,
                        line,
                    )
                )
        return

    if allow_byte_list and isinstance(payload, list):
        if len(payload) == 0:
            findings.append(
                Finding(
                    "WARNING",
                    "payload",
                    "empty_tx_payload",
                    entity_id,
                    f"{context} has empty byte list []",
                    option_label,
                    line,
                )
            )
            return
        if len(payload) > max_bytes:
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "payload_exceeds_can_limit",
                    entity_id,
                    f"{context} has {len(payload)} bytes (exceeds {max_bytes}-byte limit)",
                    option_label,
                    line,
                )
            )
        for i, elem in enumerate(payload):
            _, _, err = parse_byte_value(elem, allow_invert=False)
            if err:
                findings.append(
                    Finding(
                        "ERROR",
                        "payload",
                        "invalid_hex_payload",
                        entity_id,
                        f"{context}[{i}]: {err}",
                        option_label,
                        line,
                    )
                )
        return

    expected = "a hex string, ByteMap object, or byte list" if allow_byte_list else "a hex string or ByteMap object"
    findings.append(
        Finding(
            "ERROR",
            "payload",
            "invalid_payload_type",
            entity_id,
            f"{context} must be {expected}, got {type(payload).__name__}",
            option_label,
            line,
        )
    )


def validate_mask_value(
    mask: Any,
    *,
    is_fd: bool,
    context: str,
    entity_id: str,
    option_label: str | None,
    line: int | None,
    findings: list[Finding],
) -> None:
    if isinstance(mask, str):
        _, _, err = parse_byte_value(mask, allow_invert=False)
        if err:
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "invalid_mask",
                    entity_id,
                    f"{context}: {err}",
                    option_label,
                    line,
                )
            )
        return

    if isinstance(mask, dict):
        for k, v in mask.items():
            validate_byte_index_key(
                k,
                is_fd=is_fd,
                context=context,
                entity_id=entity_id,
                option_label=option_label,
                line=line,
                findings=findings,
            )
            _, _, err = parse_byte_value(v, allow_invert=False)
            if err:
                findings.append(
                    Finding(
                        "ERROR",
                        "payload",
                        "invalid_mask",
                        entity_id,
                        f"{context}[{k}]: {err}",
                        option_label,
                        line,
                    )
                )
        return

    findings.append(
        Finding(
            "ERROR",
            "payload",
            "invalid_mask",
            entity_id,
            f"{context} must be hex string or ByteMap, got {type(mask).__name__}",
            option_label,
            line,
        )
    )


def resolve_match_constraints(
    opt: dict[str, Any],
    cmd: dict[str, Any],
    net: dict[str, Any],
    *,
    include_network_state_mask: bool,
) -> dict[int, tuple[int, int, bool]] | None:
    """
    Parse an option's `match` ByteMap into {byte_index(1..8): (masked_val, mask_val, inverted)}.
    When include_network_state_mask=True, mirrors Pass 1A parser.cpp / can_utils.py runtime semantics
    (opt.mask -> cmd.mask -> network.state_mask -> 0xFF).
    """
    match = opt.get("match")
    if not isinstance(match, dict) or not match:
        return None

    raw_mask = opt.get("mask")
    if raw_mask is None:
        raw_mask = cmd.get("mask")
    if raw_mask is None and include_network_state_mask:
        raw_mask = net.get("state_mask")
        if raw_mask is None:
            raw_mask = net.get("mask")

    constraints: dict[int, tuple[int, int, bool]] = {}
    for k, v in match.items():
        if not isinstance(k, str):
            continue
        m = CLASSIC_BYTE_RE.match(k.strip())
        if not m:
            continue
        b_idx = int(m.group(1))
        val, inv, err = parse_byte_value(v, allow_invert=True)
        if err or val is None:
            continue

        mask_val = 0xFF
        if isinstance(raw_mask, dict):
            mv_raw = raw_mask.get(k)
            if mv_raw is not None:
                mv, _, merr = parse_byte_value(mv_raw, allow_invert=False)
                if not merr and mv is not None:
                    mask_val = mv
        elif isinstance(raw_mask, str):
            mv, _, merr = parse_byte_value(raw_mask, allow_invert=False)
            if not merr and mv is not None:
                mask_val = mv

        constraints[b_idx] = (val & mask_val, mask_val, inv)

    return constraints or None


def rule_subsumes(earlier: dict[int, tuple[int, int, bool]], later: dict[int, tuple[int, int, bool]]) -> bool:
    """Return True if EVERY possible 8-byte CAN frame matching `later` also matches `earlier`."""
    for b_idx, (v1, m1, i1) in earlier.items():
        c2 = later.get(b_idx)
        if c2 is None:
            # `later` leaves byte b_idx unconstrained, while `earlier` constrains it
            # unless `earlier` matches all 256 values (e.g. mask=0x00, val=0x00, non-inverted)
            for x in range(256):
                ok1 = ((x & m1) != v1) if i1 else ((x & m1) == v1)
                if not ok1:
                    return False
        else:
            v2, m2, i2 = c2
            for x in range(256):
                ok2 = ((x & m2) != v2) if i2 else ((x & m2) == v2)
                if not ok2:
                    continue
                ok1 = ((x & m1) != v1) if i1 else ((x & m1) == v1)
                if not ok1:
                    return False
    return True


def single_byte_prefix_subsumes(
    earlier_rules: list[tuple[int, str, dict[int, tuple[int, int, bool]]]],
    later: dict[int, tuple[int, int, bool]],
) -> tuple[int, list[str]] | None:
    """
    Detect exhaustive single-byte prefix shadowing (e.g., Driver Opened + Driver Closed on D4 & 0x01
    together matching all 256 values of D4, making all subsequent options unreachable).
    Returns (byte_index, [covering_option_labels]) if shadowed, else None.
    """
    by_byte: dict[int, list[tuple[str, tuple[int, int, bool]]]] = {}
    for _, lbl, rule in earlier_rules:
        if len(rule) == 1:
            b_idx, cond = next(iter(rule.items()))
            by_byte.setdefault(b_idx, []).append((lbl, cond))

    for b_idx, single_conds in by_byte.items():
        if len(single_conds) < 2:
            continue
        later_cond = later.get(b_idx)
        used_labels: list[str] = []
        all_covered = True
        for x in range(256):
            if later_cond is not None:
                v2, m2, i2 = later_cond
                ok2 = ((x & m2) != v2) if i2 else ((x & m2) == v2)
                if not ok2:
                    continue
            matched_lbl: str | None = None
            for lbl, (v1, m1, i1) in single_conds:
                ok1 = ((x & m1) != v1) if i1 else ((x & m1) == v1)
                if ok1:
                    matched_lbl = lbl
                    break
            if matched_lbl is None:
                all_covered = False
                break
            if matched_lbl not in used_labels:
                used_labels.append(matched_lbl)

        if all_covered and len(used_labels) >= 2:
            return b_idx, used_labels

    return None


def validate_steps(
    steps: Any,
    *,
    cmd: dict[str, Any],
    net: dict[str, Any],
    entity_id: str,
    option_label: str | None,
    context_prefix: str,
    line: int | None,
    findings: list[Finding],
) -> tuple[bool, bool]:
    """
    Validate a list of TX steps.
    Returns (has_tx_steps, has_missing_delay_on_multistep_or_repeat).
    """
    if not isinstance(steps, list) or len(steps) == 0:
        return False, False

    has_net_delay = net.get("delay_ms") is not None
    missing_delay_flagged = False
    is_multi_step = len(steps) > 1

    for idx, step in enumerate(steps):
        ctx = f"{context_prefix}[{idx}]"
        if not isinstance(step, dict):
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "invalid_step",
                    entity_id,
                    f"{ctx} must be an object",
                    option_label,
                    line,
                )
            )
            continue

        step_type = str(step.get("type", "")).lower()
        is_fd = is_can_fd_entity(cmd, net, step)

        if "payload" in step:
            validate_payload_value(
                step["payload"],
                is_fd=is_fd,
                is_match=False,
                context=f"{ctx}.payload",
                entity_id=entity_id,
                option_label=option_label,
                line=line,
                findings=findings,
            )

        repeat_val = 1
        if "repeat" in step:
            r = step["repeat"]
            if isinstance(r, bool) or not isinstance(r, int) or r < 1 or r > 255:
                findings.append(
                    Finding(
                        "ERROR",
                        "payload",
                        "invalid_repeat",
                        entity_id,
                        f"{ctx}.repeat={r!r} must be an integer between 1 and 255",
                        option_label,
                        line,
                    )
                )
            else:
                repeat_val = r

        if step_type != "delay" and (is_multi_step or repeat_val > 1):
            if step.get("delay_ms") is None and not has_net_delay:
                missing_delay_flagged = True

    return True, missing_delay_flagged


def validate_options_block(
    options: Any,
    *,
    cmd: dict[str, Any],
    net: dict[str, Any],
    entity_id: str,
    scope_prefix: str,
    entity_line: int | None,
    option_lines: dict[tuple[str, str], int],
    findings: list[Finding],
) -> tuple[bool, bool, list[tuple[str, dict[int, tuple[int, int, bool]]]]]:
    """
    Validate an `options` array (either root options or a variant's options).
    Returns (has_tx, has_missing_delay, parsed_runtime_rx_rules).
    """
    if not isinstance(options, list):
        return False, False, []

    seen_labels: dict[str, str] = {}
    has_tx = False
    has_missing_delay = False
    is_fd = is_can_fd_entity(cmd, net)

    # Track parsed RX rules for intra-entity shadowing detection
    runtime_rx_rules: list[tuple[int, str, dict[int, tuple[int, int, bool]]]] = []

    for idx, opt in enumerate(options):
        if not isinstance(opt, dict):
            findings.append(
                Finding(
                    "ERROR",
                    "payload",
                    "invalid_option",
                    entity_id,
                    f"{scope_prefix}options[{idx}] must be an object",
                    None,
                    entity_line,
                )
            )
            continue

        raw_label = opt.get("label")
        label = str(raw_label) if raw_label is not None else f"<index {idx}>"
        opt_line = option_lines.get((entity_id, label), entity_line) if scope_prefix == "" else entity_line
        disp_label = f"{scope_prefix}{label}" if scope_prefix else label

        # Duplicate option label check (case-insensitive)
        norm_label = label.strip().lower()
        if norm_label in seen_labels:
            findings.append(
                Finding(
                    "ERROR",
                    "collisions",
                    "duplicate_option_label",
                    entity_id,
                    f"duplicate option label '{label}' (conflicts with '{seen_labels[norm_label]}')",
                    disp_label,
                    opt_line,
                )
            )
        else:
            seen_labels[norm_label] = label

        # Validate mask
        if "mask" in opt and opt["mask"] is not None:
            validate_mask_value(
                opt["mask"],
                is_fd=is_fd,
                context=f"{scope_prefix}option.mask",
                entity_id=entity_id,
                option_label=disp_label,
                line=opt_line,
                findings=findings,
            )

        # Validate match payload & bitmask/target alignment
        if "match" in opt and opt["match"] is not None:
            validate_payload_value(
                opt["match"],
                is_fd=is_fd,
                is_match=True,
                context=f"{scope_prefix}option.match",
                entity_id=entity_id,
                option_label=disp_label,
                line=opt_line,
                findings=findings,
            )

            # Bitmask/target mismatch check: (target_val & mask_val) != target_val
            if isinstance(opt["match"], dict):
                raw_mask = opt.get("mask")
                if raw_mask is None:
                    raw_mask = cmd.get("mask")
                if raw_mask is None:
                    raw_mask = net.get("state_mask")
                if raw_mask is None:
                    raw_mask = net.get("mask")

                for b_key, b_val_raw in opt["match"].items():
                    if not isinstance(b_key, str) or not CLASSIC_BYTE_RE.match(b_key.strip()):
                        continue
                    t_val, _, t_err = parse_byte_value(b_val_raw, allow_invert=True)
                    if t_err or t_val is None:
                        continue

                    m_val = 0xFF
                    if isinstance(raw_mask, dict):
                        mv_raw = raw_mask.get(b_key)
                        if mv_raw is not None:
                            mv, _, merr = parse_byte_value(mv_raw, allow_invert=False)
                            if not merr and mv is not None:
                                m_val = mv
                    elif isinstance(raw_mask, str):
                        mv, _, merr = parse_byte_value(raw_mask, allow_invert=False)
                        if not merr and mv is not None:
                            m_val = mv

                    if (t_val & m_val) != t_val:
                        mask_note = (
                            " (scalar mask applied to multi-byte match)"
                            if isinstance(raw_mask, str) and len(opt["match"]) > 1
                            else ""
                        )
                        findings.append(
                            Finding(
                                "ERROR",
                                "payload",
                                "mask_target_mismatch",
                                entity_id,
                                f"{b_key}=0x{t_val:02X} has bits outside mask 0x{m_val:02X} "
                                f"(0x{t_val:02X} & 0x{m_val:02X} == 0x{t_val & m_val:02X}){mask_note}",
                                disp_label,
                                opt_line,
                            )
                        )

            # Record runtime RX rule for shadowing analysis (Pass 1A: parser.cpp & can_utils.py fall back to network.state_mask)
            parsed_rule = resolve_match_constraints(opt, cmd, net, include_network_state_mask=True)
            if parsed_rule:
                runtime_rx_rules.append((idx, disp_label, parsed_rule))

        # Validate TX payload / steps
        if "payload" in opt and opt["payload"] is not None:
            has_tx = True
            validate_payload_value(
                opt["payload"],
                is_fd=is_fd,
                is_match=False,
                context=f"{scope_prefix}option.payload",
                entity_id=entity_id,
                option_label=disp_label,
                line=opt_line,
                findings=findings,
            )

        if "steps" in opt and opt["steps"] is not None:
            s_tx, s_miss = validate_steps(
                opt["steps"],
                cmd=cmd,
                net=net,
                entity_id=entity_id,
                option_label=disp_label,
                context_prefix=f"{scope_prefix}option.steps",
                line=opt_line,
                findings=findings,
            )
            has_tx = has_tx or s_tx
            has_missing_delay = has_missing_delay or s_miss

    # Intra-entity shadowed RX option check (pairwise + exhaustive single-byte prefix)
    for j in range(1, len(runtime_rx_rules)):
        j_idx, j_lbl, j_rule = runtime_rx_rules[j]
        opt_line = option_lines.get((entity_id, j_lbl), entity_line) if scope_prefix == "" else entity_line

        shadowed_by: str | None = None
        for i in range(j):
            _, i_lbl, i_rule = runtime_rx_rules[i]
            if rule_subsumes(i_rule, j_rule):
                shadowed_by = i_lbl
                break

        if shadowed_by is not None:
            findings.append(
                Finding(
                    "ERROR",
                    "collisions",
                    "shadowed_rx_option",
                    entity_id,
                    f"RX match is completely shadowed by earlier option '{shadowed_by}'",
                    j_lbl,
                    opt_line,
                )
            )
        else:
            prefix_hit = single_byte_prefix_subsumes(runtime_rx_rules[:j], j_rule)
            if prefix_hit is not None:
                b_idx, cover_lbls = prefix_hit
                lbl_list = " + ".join(f"'{l}'" for l in cover_lbls)
                findings.append(
                    Finding(
                        "ERROR",
                        "collisions",
                        "shadowed_rx_option",
                        entity_id,
                        f"RX match is unreachable: earlier options {lbl_list} exhaust all values of D{b_idx}",
                        j_lbl,
                        opt_line,
                    )
                )

    return has_tx, has_missing_delay, [(lbl, rule) for _, lbl, rule in runtime_rx_rules]


def validate_catalog(catalog_path: Path) -> tuple[list[Finding], int, str]:
    raw_text = catalog_path.read_text(encoding="utf-8")
    data = json.loads(raw_text)

    if not isinstance(data, dict) or not isinstance(data.get("commands"), list):
        raise ValueError("Catalog root must be a JSON object containing a 'commands' list")

    commands: list[dict[str, Any]] = data["commands"]
    version = str(data.get("can_do_version", "unknown"))
    findings: list[Finding] = []

    entity_ids_set = {str(c.get("id")) for c in commands if isinstance(c, dict) and c.get("id")}
    entity_lines, option_lines = index_catalog_lines(raw_text, entity_ids_set)

    # Track global state for cross-entity checks
    seen_entity_ids: dict[str, str] = {}
    entity_domains: dict[str, str | None] = {}

    # Map (bus, CAN_ID) -> list of entity RX summaries for cross-entity collision checks
    # Each entry: (entity_id, line, runtime_rules, intended_rules, byte_mask_info)
    # byte_mask_info: {byte_idx: (runtime_combined_mask, intended_combined_mask, has_unmasked_runtime)}
    rx_by_can_id: dict[
        tuple[int, str],
        list[
            tuple[
                str,
                int | None,
                list[tuple[str, dict[int, tuple[int, int, bool]]]],
                list[tuple[str, dict[int, tuple[int, int, bool]]]],
                dict[int, tuple[int, int, bool]],
            ]
        ],
    ] = {}

    for idx, cmd in enumerate(commands):
        if not isinstance(cmd, dict):
            findings.append(
                Finding("ERROR", "schema", "invalid_command", f"<index {idx}>", "command entry must be a JSON object")
            )
            continue

        eid = str(cmd.get("id", f"<missing_id_{idx}>"))
        eline = entity_lines.get(eid)
        net = cmd.get("network") if isinstance(cmd.get("network"), dict) else {}
        is_fd = is_can_fd_entity(cmd, net)

        # --- 3.1 Duplicate entity IDs ---
        norm_eid = eid.strip().lower()
        if norm_eid in seen_entity_ids:
            findings.append(
                Finding(
                    "ERROR",
                    "collisions",
                    "duplicate_entity_id",
                    eid,
                    f"duplicate entity ID '{eid}' (conflicts with '{seen_entity_ids[norm_eid]}')",
                    None,
                    eline,
                )
            )
        else:
            seen_entity_ids[norm_eid] = eid

        # --- 1. Payload, Byte-Index & Mask Validity (Root & Network) ---
        root_state_byte_idx: int | None = None
        for field in ("state_byte", "action_byte"):
            if field in net and net[field] is not None:
                parsed_idx = validate_byte_index_key(
                    net[field],
                    is_fd=is_fd,
                    context=f"network.{field}",
                    entity_id=eid,
                    option_label=None,
                    line=eline,
                    findings=findings,
                )
                if field == "state_byte":
                    root_state_byte_idx = parsed_idx

        root_byte_length = validate_state_byte_length(
            net,
            root_state_byte_idx,
            is_fd=is_fd,
            context="network",
            entity_id=eid,
            line=eline,
            findings=findings,
        )

        if "mask" in cmd and cmd["mask"] is not None:
            validate_mask_value(
                cmd["mask"],
                is_fd=is_fd,
                context="command.mask",
                entity_id=eid,
                option_label=None,
                line=eline,
                findings=findings,
            )
        for mfield in ("state_mask", "mask"):
            if mfield in net and net[mfield] is not None:
                validate_mask_value(
                    net[mfield],
                    is_fd=is_fd,
                    context=f"network.{mfield}",
                    entity_id=eid,
                    option_label=None,
                    line=eline,
                    findings=findings,
                )

        if "match" in cmd and cmd["match"] is not None:
            validate_payload_value(
                cmd["match"],
                is_fd=is_fd,
                is_match=True,
                context="command.match",
                entity_id=eid,
                option_label=None,
                line=eline,
                findings=findings,
            )

        if "base_payload" in net and net["base_payload"] is not None:
            validate_payload_value(
                net["base_payload"],
                is_fd=is_fd,
                is_match=False,
                context="network.base_payload",
                entity_id=eid,
                option_label=None,
                line=eline,
                findings=findings,
                allow_byte_list=True,
            )

        root_steps_tx, root_missing_delay = validate_steps(
            cmd.get("steps"),
            cmd=cmd,
            net=net,
            entity_id=eid,
            option_label=None,
            context_prefix="command.steps",
            line=eline,
            findings=findings,
        )

        # Validate root options
        opts_tx, opts_missing_delay, runtime_rx_rules = validate_options_block(
            cmd.get("options"),
            cmd=cmd,
            net=net,
            entity_id=eid,
            scope_prefix="",
            entity_line=eline,
            option_lines=option_lines,
            findings=findings,
        )

        # Missing delay_ms warnings for TX entities
        action_can_id_raw = net.get("action_can_id") or cmd.get("action_can_id")
        has_any_tx = root_steps_tx or opts_tx
        if root_missing_delay or opts_missing_delay:
            findings.append(
                Finding(
                    "WARNING",
                    "payload",
                    "missing_delay_ms",
                    eid,
                    "multi-step or repeat>1 TX sequence omits both step-level and network.delay_ms "
                    "(ESP32 CatalogStep defaults to 0ms while HA/Web UI default to 20ms)",
                    None,
                    eline,
                )
            )
        elif (has_any_tx or action_can_id_raw) and net.get("delay_ms") is None:
            # Check if every step explicitly defines delay_ms; if not, warn about missing network.delay_ms
            all_steps: list[dict[str, Any]] = []
            if isinstance(cmd.get("steps"), list):
                all_steps.extend(s for s in cmd["steps"] if isinstance(s, dict))
            if isinstance(cmd.get("options"), list):
                for o in cmd["options"]:
                    if isinstance(o, dict) and isinstance(o.get("steps"), list):
                        all_steps.extend(s for s in o["steps"] if isinstance(s, dict))
            if not all_steps or any(s.get("delay_ms") is None for s in all_steps):
                findings.append(
                    Finding(
                        "WARNING",
                        "payload",
                        "missing_delay_ms",
                        eid,
                        "TX entity omits network.delay_ms (and lacks explicit step-level delay_ms on all steps)",
                        None,
                        eline,
                    )
                )

        # --- 2.1 network.state_mask without option.mask or cmd.mask ---
        net_state_mask_raw = net.get("state_mask")
        if isinstance(net_state_mask_raw, str):
            sm_val, _, sm_err = parse_byte_value(net_state_mask_raw, allow_invert=False)
            if not sm_err and sm_val is not None and sm_val != 0xFF and cmd.get("mask") is None:
                opts = cmd.get("options") if isinstance(cmd.get("options"), list) else []
                match_opts = [o for o in opts if isinstance(o, dict) and isinstance(o.get("match"), dict) and o["match"]]
                missing_mask_opts = [o for o in match_opts if o.get("mask") is None]
                if missing_mask_opts:
                    findings.append(
                        Finding(
                            "WARNING",
                            "masking_variants",
                            "unpropagated_state_mask",
                            eid,
                            f"network.state_mask='{net_state_mask_raw}' relies on runtime fallback in parser.cpp & can_utils.py; "
                            f"{len(missing_mask_opts)}/{len(match_opts)} RX options omit explicit option.mask (and cmd.mask is unset)",
                            None,
                            eline,
                        )
                    )

        # --- 2.2 & 2.3 Variants Integrity ---
        variants = cmd.get("variants")
        if isinstance(variants, list):
            seen_variant_targets: dict[str, int] = {}
            for v_idx, variant in enumerate(variants):
                if not isinstance(variant, dict):
                    findings.append(
                        Finding(
                            "ERROR",
                            "masking_variants",
                            "invalid_variant",
                            eid,
                            f"variants[{v_idx}] must be an object",
                            None,
                            eline,
                        )
                    )
                    continue

                v_net = variant.get("network") if isinstance(variant.get("network"), dict) else {}
                merged_net = {**net, **v_net}
                v_is_fd = is_can_fd_entity(cmd, merged_net)

                # Validate variant network byte indices & masks
                v_state_byte_idx: int | None = None
                for field in ("state_byte", "action_byte"):
                    if field in v_net and v_net[field] is not None:
                        parsed_v_idx = validate_byte_index_key(
                            v_net[field],
                            is_fd=v_is_fd,
                            context=f"variants[{v_idx}].network.{field}",
                            entity_id=eid,
                            option_label=None,
                            line=eline,
                            findings=findings,
                        )
                        if field == "state_byte":
                            v_state_byte_idx = parsed_v_idx
                if "byte_length" in v_net or "endianness" in v_net:
                    validate_state_byte_length(
                        v_net,
                        v_state_byte_idx if v_state_byte_idx is not None else root_state_byte_idx,
                        is_fd=v_is_fd,
                        context=f"variants[{v_idx}].network",
                        entity_id=eid,
                        line=eline,
                        findings=findings,
                    )
                for mfield in ("state_mask", "mask"):
                    if mfield in v_net and v_net[mfield] is not None:
                        validate_mask_value(
                            v_net[mfield],
                            is_fd=v_is_fd,
                            context=f"variants[{v_idx}].network.{mfield}",
                            entity_id=eid,
                            option_label=None,
                            line=eline,
                            findings=findings,
                        )

                # Validate variant options
                if "options" in variant and variant["options"] is not None:
                    validate_options_block(
                        variant["options"],
                        cmd=cmd,
                        net=merged_net,
                        entity_id=eid,
                        scope_prefix=f"variants[{v_idx}]:",
                        entity_line=eline,
                        option_lines=option_lines,
                        findings=findings,
                    )

                # Check duplicate/shadowed targets and legacy non-E-GMP targets
                targets = variant.get("targets")
                if not isinstance(targets, list) or len(targets) == 0:
                    findings.append(
                        Finding(
                            "ERROR",
                            "masking_variants",
                            "missing_variant_targets",
                            eid,
                            f"variants[{v_idx}] is missing non-empty 'targets' array",
                            None,
                            eline,
                        )
                    )
                    continue

                shadowed_targets: list[str] = []
                legacy_targets: list[str] = []
                seen_in_this_variant: set[str] = set()

                for raw_t in targets:
                    t = str(raw_t).strip()
                    t_norm = t.lower()
                    if t_norm in seen_in_this_variant:
                        shadowed_targets.append(f"{t} (duplicated within variants[{v_idx}])")
                    elif t_norm in seen_variant_targets:
                        shadowed_targets.append(f"{t} (shadowed by variants[{seen_variant_targets[t_norm]}])")
                    else:
                        seen_variant_targets[t_norm] = v_idx
                    seen_in_this_variant.add(t_norm)

                    if is_legacy_target(t):
                        legacy_targets.append(t)

                if shadowed_targets:
                    preview = ", ".join(shadowed_targets[:5])
                    extra = f" (+{len(shadowed_targets) - 5} more)" if len(shadowed_targets) > 5 else ""
                    findings.append(
                        Finding(
                            "ERROR",
                            "masking_variants",
                            "shadowed_variant_targets",
                            eid,
                            f"variants[{v_idx}] has duplicate/shadowed targets: {preview}{extra}",
                            None,
                            eline,
                        )
                    )

                if legacy_targets:
                    preview = ", ".join(legacy_targets)
                    findings.append(
                        Finding(
                            "WARNING",
                            "masking_variants",
                            "legacy_non_egmp_target",
                            eid,
                            f"variants[{v_idx}] includes legacy non-E-GMP target(s): {preview}",
                            None,
                            eline,
                        )
                    )

        # --- Collect cross-entity RX metadata on (bus, state_can_id) ---
        state_can_id_norm = normalize_can_id(net.get("state_can_id") or cmd.get("state_can_id"))
        if state_can_id_norm is not None:
            bus = int(net.get("bus", 0)) if isinstance(net.get("bus", 0), int) else 0
            intended_rx_rules: list[tuple[str, dict[int, tuple[int, int, bool]]]] = []
            if isinstance(cmd.get("options"), list):
                for o in cmd["options"]:
                    if isinstance(o, dict) and isinstance(o.get("match"), dict):
                        ir = resolve_match_constraints(o, cmd, net, include_network_state_mask=True)
                        if ir:
                            intended_rx_rules.append((str(o.get("label", "")), ir))

            # Build per-byte mask summary (runtime vs intended)
            byte_mask_info: dict[int, tuple[int, int, bool]] = {}
            for _, rule in runtime_rx_rules:
                for b_idx, (_, m_val, _) in rule.items():
                    r_comb, i_comb, has_unm = byte_mask_info.get(b_idx, (0, 0, False))
                    byte_mask_info[b_idx] = (r_comb | m_val, i_comb, has_unm or (m_val == 0xFF))
            for _, rule in intended_rx_rules:
                for b_idx, (_, m_val, _) in rule.items():
                    r_comb, i_comb, has_unm = byte_mask_info.get(b_idx, (0, 0, False))
                    byte_mask_info[b_idx] = (r_comb, i_comb | m_val, has_unm)

            # Also include single- or 2-byte numeric entities using network.state_byte without options
            sb = net.get("state_byte")
            if isinstance(sb, str) and CLASSIC_BYTE_RE.match(sb.strip()) and not runtime_rx_rules:
                start_b = int(sb.strip()[1:])
                sm_raw = cmd.get("mask") or net.get("state_mask") or net.get("mask")
                i_mask = 0xFF
                if isinstance(sm_raw, str):
                    mv, _, merr = parse_byte_value(sm_raw, allow_invert=False)
                    if not merr and mv is not None:
                        i_mask = mv
                r_mask = i_mask
                for offset in range(root_byte_length):
                    b_idx = start_b + offset
                    if b_idx > 8:
                        break
                    r_comb, i_comb, has_unm = byte_mask_info.get(b_idx, (0, 0, False))
                    byte_mask_info[b_idx] = (r_comb | r_mask, i_comb | i_mask, has_unm or (r_mask == 0xFF))

            if runtime_rx_rules or byte_mask_info:
                rx_by_can_id.setdefault((bus, state_can_id_norm), []).append(
                    (eid, eline, runtime_rx_rules, intended_rx_rules, byte_mask_info)
                )

        # --- 4. Home Assistant Metadata & Role Consistency ---
        ha_meta = cmd.get("ha_metadata")
        ha_domain: str | None = None
        if ha_meta is None:
            if eid not in ALLOW_MISSING_HA_METADATA:
                findings.append(
                    Finding(
                        "ERROR",
                        "ha_metadata",
                        "missing_ha_metadata",
                        eid,
                        "entity omits required 'ha_metadata' block",
                        None,
                        eline,
                    )
                )
        elif not isinstance(ha_meta, dict):
            findings.append(
                Finding(
                    "ERROR",
                    "ha_metadata",
                    "invalid_ha_metadata",
                    eid,
                    "ha_metadata must be an object",
                    None,
                    eline,
                )
            )
        else:
            raw_dom = ha_meta.get("domain")
            if not isinstance(raw_dom, str) or raw_dom not in SUPPORTED_HA_DOMAINS:
                findings.append(
                    Finding(
                        "ERROR",
                        "ha_metadata",
                        "invalid_ha_domain",
                        eid,
                        f"unsupported ha_metadata.domain={raw_dom!r} "
                        f"(supported: {', '.join(sorted(SUPPORTED_HA_DOMAINS))})",
                        None,
                        eline,
                    )
                )
            else:
                ha_domain = raw_dom
        entity_domains[eid] = ha_domain

        # notify entities must target 0x6E0 (or omit action_can_id for track_popup subsystem)
        if ha_domain == "notify":
            acid_norm = normalize_can_id(action_can_id_raw)
            if acid_norm is not None and acid_norm != "0x6E0":
                findings.append(
                    Finding(
                        "ERROR",
                        "ha_metadata",
                        "invalid_notify_can_id",
                        eid,
                        f"notify entity specifies action_can_id='{acid_norm}', but notify.py routes all "
                        f"notify entities to track_popup (0x6E0)",
                        None,
                        eline,
                    )
                )

        # device_class placed at command root instead of ha_metadata
        if "device_class" in cmd and cmd["device_class"] is not None:
            findings.append(
                Finding(
                    "WARNING",
                    "ha_metadata",
                    "root_device_class",
                    eid,
                    f"device_class='{cmd['device_class']}' is placed at command root instead of ha_metadata.device_class",
                    None,
                    eline,
                )
            )

        # Role consistency checks
        roles_raw = cmd.get("roles")
        roles: set[str] = {str(r) for r in roles_raw} if isinstance(roles_raw, list) else set()

        if "action" in roles:
            # Range-controlled entities (action_byte) and dedicated firmware subsystems are valid TX actions
            net_type = str(net.get("type", "")).lower()
            cmd_type = str(cmd.get("type", "")).lower()
            is_subsystem_tx = (net_type in SUBSYSTEM_TX_TYPES) or (cmd_type in SUBSYSTEM_TX_TYPES)
            has_range_tx = net.get("action_byte") is not None
            if not has_any_tx and not has_range_tx and not is_subsystem_tx:
                findings.append(
                    Finding(
                        "WARNING",
                        "ha_metadata",
                        "action_role_without_tx",
                        eid,
                        "entity includes 'action' in roles but defines zero TX steps/payload (and no action_byte/subsystem TX)",
                        None,
                        eline,
                    )
                )

        if "state" in roles and state_can_id_norm is None:
            # Allow virtual/ADC entities explicitly typed outside can_rx/can_tx (e.g. vbat_adc)
            net_type = str(net.get("type", "")).lower()
            if net_type not in ("adc", "vbat", "virtual", "system", "ble", "wifi"):
                findings.append(
                    Finding(
                        "WARNING",
                        "ha_metadata",
                        "state_role_without_can_id",
                        eid,
                        "entity includes 'state' in roles but defines no state_can_id",
                        None,
                        eline,
                    )
                )

        if ha_domain == "sensor" and "action" in roles:
            findings.append(
                Finding(
                    "WARNING",
                    "ha_metadata",
                    "sensor_with_action_role",
                    eid,
                    "read-only HA 'sensor' entity also declares 'action' in roles",
                    None,
                    eline,
                )
            )

    # --- 3.3 & 3.4 Cross-Entity Same (bus, state_can_id) Collisions & Unmasked Overlaps ---
    for (bus, can_id), entries in sorted(rx_by_can_id.items()):
        if len(entries) < 2:
            continue
        for i in range(len(entries)):
            eid_a, line_a, rt_a, int_a, bm_a = entries[i]
            for j in range(i + 1, len(entries)):
                eid_b, _, rt_b, int_b, bm_b = entries[j]

                # 1. Exact match + mask collisions (check both runtime and intended mask signatures)
                dom_pair = {entity_domains.get(eid_a), entity_domains.get(eid_b)}
                is_cover_sensor_pair = dom_pair == {"cover", "sensor"}
                collision_severity = "WARNING" if is_cover_sensor_pair else "ERROR"
                domain_note = " (benign cover+sensor shared nibble)" if is_cover_sensor_pair else ""

                exact_reported: set[tuple[str, str]] = set()
                for lbl_a, rule_a in rt_a:
                    for lbl_b, rule_b in rt_b:
                        if rule_a == rule_b:
                            exact_reported.add((lbl_a, lbl_b))
                            sig = ", ".join(
                                f"D{b}={'!' if inv else ''}0x{val:02X}&0x{msk:02X}"
                                for b, (val, msk, inv) in sorted(rule_a.items())
                            )
                            findings.append(
                                Finding(
                                    collision_severity,
                                    "collisions",
                                    "cross_entity_exact_collision",
                                    eid_a,
                                    f"exact RX match+mask collision on bus {bus} {can_id} ({sig}) "
                                    f"with '{eid_b}' option '{lbl_b}'{domain_note}",
                                    lbl_a,
                                    line_a,
                                )
                            )

                for lbl_a, rule_a in int_a:
                    for lbl_b, rule_b in int_b:
                        if rule_a == rule_b and (lbl_a, lbl_b) not in exact_reported:
                            exact_reported.add((lbl_a, lbl_b))
                            sig = ", ".join(
                                f"D{b}={'!' if inv else ''}0x{val:02X}&0x{msk:02X}"
                                for b, (val, msk, inv) in sorted(rule_a.items())
                            )
                            findings.append(
                                Finding(
                                    collision_severity,
                                    "collisions",
                                    "cross_entity_exact_collision",
                                    eid_a,
                                    f"exact intended RX match+mask collision on bus {bus} {can_id} ({sig}) "
                                    f"with '{eid_b}' option '{lbl_b}' (via network.state_mask){domain_note}",
                                    lbl_a,
                                    line_a,
                                )
                            )

                # 2. Unmasked sibling-bit overlaps on shared bytes
                shared_bytes = sorted(set(bm_a.keys()) & set(bm_b.keys()))
                overlap_descs: list[str] = []
                for b_idx in shared_bytes:
                    rt_mask_a, int_mask_a, unm_a = bm_a[b_idx]
                    rt_mask_b, int_mask_b, unm_b = bm_b[b_idx]
                    # Flag if runtime bits overlap AND at least one entity is unmasked (0xFF) on that byte
                    if (rt_mask_a & rt_mask_b) != 0 and (unm_a or unm_b):
                        overlap_descs.append(
                            f"D{b_idx} ({eid_a}: runtime=0x{rt_mask_a:02X}/intended=0x{int_mask_a:02X}, "
                            f"{eid_b}: runtime=0x{rt_mask_b:02X}/intended=0x{int_mask_b:02X})"
                        )

                if overlap_descs:
                    findings.append(
                        Finding(
                            "WARNING",
                            "collisions",
                            "unmasked_shared_byte_overlap",
                            eid_a,
                            f"unmasked shared-byte overlap on bus {bus} {can_id} with '{eid_b}': "
                            + "; ".join(overlap_descs),
                            None,
                            line_a,
                        )
                    )

    return findings, len(commands), version


def format_text_report(findings: list[Finding], entity_count: int, catalog_path: Path, version: str) -> str:
    errors = [f for f in findings if f.severity == "ERROR"]
    warnings = [f for f in findings if f.severity == "WARNING"]

    try:
        display_path = catalog_path.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        display_path = catalog_path.as_posix()

    lines: list[str] = [
        f"CAN Do Catalog Validation ({display_path} | v{version})",
        "=" * 76,
    ]

    def emit_group(title: str, group: list[Finding]) -> None:
        lines.append(f"\n{title} ({len(group)}):")
        if not group:
            lines.append("  (none)")
            return
        for f in group:
            loc = f" (L{f.line})" if f.line is not None else ""
            opt = f" [{f.option_label}]" if f.option_label else ""
            lines.append(f"  [{f.severity}] [{f.code}] {f.entity_id}{loc}{opt}: {f.reason}")

    emit_group("ERRORS", errors)
    emit_group("WARNINGS", warnings)
    lines.append("")
    lines.append(f"Summary: {len(errors)} errors, {len(warnings)} warnings across {entity_count} entities")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    default_catalog = Path(__file__).resolve().parent.parent / "catalog" / "can_do_catalog.json"

    parser = argparse.ArgumentParser(
        description="Validate catalog/can_do_catalog.json against firmware, Home Assistant, and frontend contracts."
    )
    parser.add_argument(
        "catalog",
        nargs="?",
        type=Path,
        default=default_catalog,
        help=f"Path to can_do_catalog.json (default: {default_catalog})",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit with code 1 on WARNINGs as well as ERRORs.",
    )
    parser.add_argument(
        "--json",
        dest="json_output",
        action="store_true",
        help="Output machine-readable JSON.",
    )
    args = parser.parse_args(argv)

    catalog_path: Path = args.catalog
    if not catalog_path.is_file():
        print(f"ERROR: catalog file not found: {catalog_path}", file=sys.stderr)
        return 2

    try:
        findings, entity_count, version = validate_catalog(catalog_path)
    except Exception as exc:
        print(f"ERROR: failed to parse catalog '{catalog_path}': {exc}", file=sys.stderr)
        return 2

    errors = [f for f in findings if f.severity == "ERROR"]
    warnings = [f for f in findings if f.severity == "WARNING"]

    exit_code = 1 if (errors or (args.strict and warnings)) else 0

    if args.json_output:
        payload = {
            "catalog_path": str(catalog_path),
            "catalog_version": version,
            "entity_count": entity_count,
            "error_count": len(errors),
            "warning_count": len(warnings),
            "strict": args.strict,
            "exit_code": exit_code,
            "findings": [asdict(f) for f in errors] + [asdict(f) for f in warnings],
        }
        print(json.dumps(payload, indent=2))
    else:
        print(format_text_report(findings, entity_count, catalog_path, version))

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
