#!/usr/bin/env python3
"""
CAN Do Catalog Optimizer & Strict CI Schema Validator
Cleans redundancies, fixes byte/taxonomy drift, validates referential integrity,
and preserves backward-compatible root keys & hex payloads for unit tests.
"""

import argparse
import copy
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

# --- Allowed Taxonomy & Schema Constants ---
ALLOWED_CATEGORIES = {
    "Cockpit & Controls",
    "Climate & Comfort",
    "Vehicle State & Telematics",
    "Doors, Access & Security",
    "High Voltage & Charging",
    "Powertrain & Performance",
}

ALLOWED_DOMAINS = {
    "event", "button", "sensor", "binary_sensor",
    "select", "switch", "climate", "lock", "cover",
    "notify", "light", "number",
}

ALLOWED_ROLES = {"trigger", "condition", "state", "action", "sensor", "select"}
ALLOWED_NET_TYPES = {"can_rx", "can_tx", "can_rx_tx", "precondition", "track_popup", "hud_nav"}
ALLOWED_OPERATORS = {"<=", "<", ">=", ">", "=="}

HEX_CAN_ID_RE = re.compile(r"^0[xX][0-9A-Fa-f]{1,8}$")
HEX_BYTE_RE = re.compile(r"^0[xX][0-9A-Fa-f]{2}$")
HEX_RAW_PAYLOAD_RE = re.compile(r"^[0-9A-Fa-f]{2,16}$")
BYTE_KEY_RE = re.compile(r"^D[1-8]$")


def normalize_hex_str(val: Any) -> Any:
    """Normalizes any hex string (e.g. '0X4A', '0x4a', '0X474') to canonical lowercase '0x' with uppercase digits ('0x4A', '0x474')."""
    if isinstance(val, str):
        v = val.strip()
        if re.match(r"^0[xX][0-9A-Fa-f]+$", v):
            return f"0x{v[2:].upper()}"
    return val


def normalize_payload_dict(payload: Any) -> Any:
    """Recursively normalizes all hex byte values in a byte map or payload dict."""
    if isinstance(payload, dict):
        return {k: normalize_hex_str(v) for k, v in payload.items()}
    return payload

# --- Normalization Maps ---
CATEGORY_MAP = {
    "Charging & Battery": "High Voltage & Charging",
    "Powertrain & Battery": "Powertrain & Performance",
}

SUBCATEGORY_MAP = {
    "Seats & Comfort": "Seat Comfort",
    "Battery Preconditioning": "Preconditioning",
    "Remote Climate Controls": "Remote Climate",
    "Tire Pressure & Wheels": "Tire Pressure (TPMS)",
    "Drive Mode & Performance": "Driving Dynamics",
    "Drive Modes & Performance": "Driving Dynamics",
    "Powertrain & Motor": "Powertrain State",
    "Central Locking": "Locks & Security",
    "Trunk & Frunk": "Doors & Latches",
}

OPERATOR_MAP = {
    "less_equal": "<=",
    "less_than": "<",
    "greater_equal": ">=",
    "greater_than": ">",
    "equal": "==",
}

TAG_MAP = {
    "ioniq5": "hyundai_ioniq5",
    "ioniq6": "hyundai_ioniq6",
    "ev6": "kia_ev6",
    "gv60": "genesis_gv60",
}

POWER_MIRRORS_CMD = {
    "id": "power_mirrors",
    "ha_metadata": {
        "name": "Exterior Power Mirrors",
        "domain": "cover",
        "icon": "mdi:car-side",
    },
    "tags": ["all_egmp"],
    "category": "Doors, Access & Security",
    "subcategory": "Doors & Latches",
    "roles": ["trigger", "condition", "state", "action"],
    "network": {
        "bus": 0,
        "type": "can_rx_tx",
        "state_can_id": "0x410",
        "action_can_id": "0x4A2",
        "delay_ms": 20,
    },
    "state_can_id": "0x410",
    "action_can_id": "0x4A2",
    "contributors": [
        {
            "name": "SuaveEV",
            "github": "supersuave",
            "notes": "Commands exterior power mirror fold/unfold via BCM frame 0x4A2 Byte D7 and monitors state via CGW_USM1 (0x410) Byte D3.",
        }
    ],
    "options": [
        {
            "label": "Fold",
            "match": {"D3": "0x00"},
            "mask": "0x03",
            "steps": [
                {
                    "payload": {
                        "D1": "0x00", "D2": "0x00", "D3": "0xFF", "D4": "0x03",
                        "D5": "0xFF", "D6": "0xFF", "D7": "0x10", "D8": "0x00",
                    },
                    "repeat": 3,
                },
                {
                    "payload": {
                        "D1": "0x00", "D2": "0x00", "D3": "0xFF", "D4": "0x03",
                        "D5": "0xFF", "D6": "0xFF", "D7": "0x00", "D8": "0x00",
                    },
                    "repeat": 2,
                },
            ],
            "default": True,
        },
        {
            "label": "Unfold",
            "match": {"D3": "0x02"},
            "mask": "0x03",
            "steps": [
                {
                    "payload": {
                        "D1": "0x00", "D2": "0x00", "D3": "0xFF", "D4": "0x03",
                        "D5": "0xFF", "D6": "0xFF", "D7": "0x20", "D8": "0x00",
                    },
                    "repeat": 3,
                },
                {
                    "payload": {
                        "D1": "0x00", "D2": "0x00", "D3": "0xFF", "D4": "0x03",
                        "D5": "0xFF", "D6": "0xFF", "D7": "0x00", "D8": "0x00",
                    },
                    "repeat": 2,
                },
            ],
        },
    ],
}


def clean_network_block(cmd: Dict[str, Any]) -> None:
    """Synchronizes root & network CAN IDs, normalizes byte/mask keys, and prunes redundant variants."""
    net = cmd.setdefault("network", {})

    # Mirror state_can_id and action_can_id between root and network for test compatibility
    for key in ("state_can_id", "action_can_id"):
        if key in cmd and key not in net:
            net[key] = cmd[key]
        elif key in net:
            cmd[key] = net[key]

    # Normalize CAN IDs and masks to canonical 0x..
    for key in ("state_can_id", "action_can_id", "flow_control_can_id", "trigger_frame_can_id", "control_can_id"):
        if key in cmd:
            cmd[key] = normalize_hex_str(cmd[key])
        if key in net:
            net[key] = normalize_hex_str(net[key])
    if "state_mask" in net:
        net["state_mask"] = normalize_hex_str(net["state_mask"])
    if "action_mask" in net:
        net["action_mask"] = normalize_hex_str(net["action_mask"])
    if "mask" in cmd and isinstance(cmd["mask"], str):
        cmd["mask"] = normalize_hex_str(cmd["mask"])

    # Normalize network.byte -> state_byte / action_byte
    if "byte" in net:
        b = net.pop("byte")
        if net.get("state_can_id") and "state_byte" not in net:
            net["state_byte"] = b
        if net.get("action_can_id") and "action_byte" not in net:
            net["action_byte"] = b

    # Normalize network.mask -> state_mask
    if "mask" in net:
        m = net.pop("mask")
        if "state_mask" not in net:
            net["state_mask"] = normalize_hex_str(m)

    # Fix network.type where both state_can_id and action_can_id exist
    if net.get("state_can_id") and net.get("action_can_id"):
        if net.get("type") in ("can_rx", "can_tx"):
            net["type"] = "can_rx_tx"

    # Prune redundant variants that are identical to the parent network block
    if "variants" in cmd:
        useful_variants = []
        for var in cmd["variants"]:
            var_net = var.get("network", {})
            overrides_net = any(
                var_net.get(k) != net.get(k)
                for k in ("bus", "type", "state_can_id", "action_can_id")
                if k in var_net
            )
            if overrides_net or "options" in var:
                useful_variants.append(var)
        if useful_variants:
            cmd["variants"] = useful_variants
        else:
            cmd.pop("variants")


def clean_options(cmd: Dict[str, Any], shrink_linear: bool = False) -> None:
    cid = cmd.get("id")
    net = cmd.get("network", {})
    options = cmd.get("options", [])

    if "match" in cmd:
        cmd["match"] = normalize_payload_dict(cmd["match"])
    if "payload" in cmd:
        cmd["payload"] = normalize_payload_dict(cmd["payload"])
    for step in cmd.get("steps", []):
        if "payload" in step:
            step["payload"] = normalize_payload_dict(step["payload"])
        if "can_id" in step:
            step["can_id"] = normalize_hex_str(step["can_id"])

    # Fix climate temperature match byte bugs (D4->D2 for driver, D6->D3 for passenger)
    if cid in ("climate_driver_temp", "climate_passenger_temp"):
        correct_state_byte = net.get("state_byte")
        for opt in options:
            if "match" in opt and correct_state_byte:
                old_vals = list(opt["match"].values())
                if old_vals:
                    opt["match"] = {correct_state_byte: normalize_hex_str(old_vals[0])}
        if shrink_linear and cmd.get("type") == "linear_scale":
            cmd.pop("options", None)
            return

    for opt in options:
        if opt.get("default") is False:
            opt.pop("default")
        if "match" in opt:
            opt["match"] = normalize_payload_dict(opt["match"])
        if "payload" in opt:
            opt["payload"] = normalize_payload_dict(opt["payload"])
        if "mask" in opt and isinstance(opt["mask"], str):
            opt["mask"] = normalize_hex_str(opt["mask"])
        for step in opt.get("steps", []):
            if "payload" in step:
                step["payload"] = normalize_payload_dict(step["payload"])
            if "can_id" in step:
                step["can_id"] = normalize_hex_str(step["can_id"])
        if "evaluate" in opt:
            op = opt["evaluate"].get("operator")
            if op in OPERATOR_MAP:
                opt["evaluate"]["operator"] = OPERATOR_MAP[op]
        if isinstance(opt.get("mask"), dict) and len(opt["mask"]) == 1:
            mask_byte, mask_val = next(iter(opt["mask"].items()))
            if isinstance(opt.get("match"), dict) and list(opt["match"].keys()) == [mask_byte]:
                opt["mask"] = normalize_hex_str(mask_val)


def fix_automations(automations: List[Dict[str, Any]]) -> None:
    for auto in automations:
        if "tags" in auto:
            auto["tags"] = [TAG_MAP.get(t, t) for t in auto["tags"]]
        for trig in auto.get("triggers", []):
            for k in ("can_id", "mask", "from", "to"):
                if k in trig and isinstance(trig[k], str):
                    trig[k] = normalize_hex_str(trig[k])
            if "match" in trig:
                trig["match"] = normalize_payload_dict(trig["match"])
        for cond in auto.get("conditions", []):
            for k in ("can_id", "mask", "from", "to"):
                if k in cond and isinstance(cond[k], str):
                    cond[k] = normalize_hex_str(cond[k])
            if "match" in cond:
                cond["match"] = normalize_payload_dict(cond["match"])
            op = cond.get("operator")
            if op in OPERATOR_MAP:
                cond["operator"] = OPERATOR_MAP[op]
        for act in auto.get("actions", []):
            for k in ("can_id", "mask", "from", "to"):
                if k in act and isinstance(act[k], str):
                    act[k] = normalize_hex_str(act[k])
            if "payload" in act:
                act["payload"] = normalize_payload_dict(act["payload"])
            for step in act.get("steps", []):
                if "payload" in step:
                    step["payload"] = normalize_payload_dict(step["payload"])
                if "can_id" in step:
                    step["can_id"] = normalize_hex_str(step["can_id"])

        aid = auto.get("id")
        if aid == "auto_fold_mirrors_on_lock":
            for trig in auto.get("triggers", []):
                if trig.get("can_id") == "0x411" and trig.get("byte") == "D1":
                    trig["byte"] = "D3"
                    trig["mask"] = "0x40"
                    trig["from"] = "0x40"
                    trig["to"] = "0x00"
        elif aid == "park_gear_unlock_doors":
            for trig in auto.get("triggers", []):
                if trig.get("can_id") == "0x2C0":
                    trig["can_id"] = "0x45"
                    trig["byte"] = "D6"
                    trig["mask"] = "0x70"
                    trig["from"] = "0x50"
                    trig["to"] = "0x00"
            for act in auto.get("actions", []):
                if act.get("entity_id") == "door_locks" and act.get("command") == "Unlock":
                    act["command"] = "Unlocked / Unlock"
        elif aid == "hazard_lights_driver_door":
            for trig in auto.get("triggers", []):
                if trig.get("can_id") == "0x411" and trig.get("byte") == "D2":
                    trig["byte"] = "D4"
            for cond in auto.get("conditions", []):
                if cond.get("can_id") == "0x2C0":
                    cond["can_id"] = "0x45"
                    cond["byte"] = "D6"
            for act in auto.get("actions", []):
                if act.get("entity_id") == "hazard_lights":
                    if act.get("command") == "On":
                        act["command"] = "Turned ON / Active"
                    elif act.get("command") == "Off":
                        act["command"] = "Turned OFF / Inactive"


def optimize_catalog(data: Dict[str, Any], shrink_linear: bool = False) -> Dict[str, Any]:
    catalog = copy.deepcopy(data)
    cleaned_commands = []
    seen_ids = set()

    for cmd in catalog.get("commands", []):
        cid = cmd.get("id")
        if cid == "ambient_mood_lamp_color" or cid in seen_ids:
            continue
        seen_ids.add(cid)

        # Upgrade hazard_lights to support TX actions on 0x587
        if cid == "hazard_lights":
            cmd["ha_metadata"]["domain"] = "switch"
            cmd["roles"] = ["trigger", "condition", "state", "action"]
            cmd["network"]["type"] = "can_rx_tx"
            cmd["network"]["action_can_id"] = "0x587"
            cmd["network"]["delay_ms"] = 20
            for opt in cmd.get("options", []):
                if opt.get("label") == "Turned ON / Active":
                    opt["steps"] = [{
                        "payload": {
                            "D1": "0x00", "D2": "0x01", "D3": "0x00", "D4": "0x00",
                            "D5": "0x00", "D6": "0x00", "D7": "0x00", "D8": "0x00",
                        },
                        "repeat": 3,
                    }]
                elif opt.get("label") == "Turned OFF / Inactive":
                    opt["steps"] = [{
                        "payload": {
                            "D1": "0x00", "D2": "0x00", "D3": "0x00", "D4": "0x00",
                            "D5": "0x00", "D6": "0x00", "D7": "0x00", "D8": "0x00",
                        },
                        "repeat": 3,
                    }]

        if cmd.get("category") in CATEGORY_MAP:
            cmd["category"] = CATEGORY_MAP[cmd["category"]]
        if cmd.get("subcategory") in SUBCATEGORY_MAP:
            cmd["subcategory"] = SUBCATEGORY_MAP[cmd["subcategory"]]
        if isinstance(cmd.get("mask"), dict) and len(cmd["mask"]) == 1:
            cmd["mask"] = next(iter(cmd["mask"].values()))
        if cmd.get("popup_message") == "":
            cmd.pop("popup_message")

        clean_network_block(cmd)
        clean_options(cmd, shrink_linear=shrink_linear)
        cleaned_commands.append(cmd)

    if "power_mirrors" not in seen_ids:
        cleaned_commands.append(copy.deepcopy(POWER_MIRRORS_CMD))

    catalog["commands"] = cleaned_commands
    fix_automations(catalog.get("automations", []))
    return catalog


# ==============================================================================
# STRICT SCHEMA & REFERENTIAL INTEGRITY VALIDATOR
# ==============================================================================
def validate_byte_map(bmap: Any, ctx: str, errors: List[str], allow_raw_hex: bool = False) -> None:
    if allow_raw_hex and isinstance(bmap, str):
        clean = bmap.strip().replace(" ", "")
        if len(clean) % 2 != 0 or not HEX_RAW_PAYLOAD_RE.match(clean):
            errors.append(f"{ctx}: invalid raw hex payload string '{bmap}'")
        return
    if not isinstance(bmap, dict):
        errors.append(f"{ctx}: expected byte dict {{'D1': '0x..'}}, got {type(bmap).__name__}")
        return
    for k, v in bmap.items():
        if not BYTE_KEY_RE.match(str(k)):
            errors.append(f"{ctx}: invalid byte key '{k}' (must be D1-D8)")
        if not isinstance(v, str) or not HEX_BYTE_RE.match(v):
            errors.append(f"{ctx}.{k}: invalid hex byte '{v}' (must be 0x00-0xFF)")


def validate_catalog(catalog: Dict[str, Any]) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []

    if not isinstance(catalog.get("can_do_version"), str):
        errors.append("Root: missing or invalid 'can_do_version' string")

    valid_families: Set[str] = {"all_egmp"}
    valid_features: Set[str] = set()
    seen_veh_ids: Set[str] = set()

    for idx, v in enumerate(catalog.get("vehicles", [])):
        vid = v.get("id", f"index_{idx}")
        if vid in seen_veh_ids:
            errors.append(f"vehicles[{vid}]: duplicate vehicle id")
        seen_veh_ids.add(vid)
        for req in ("id", "name", "make", "model", "trim", "region", "family"):
            if not v.get(req):
                errors.append(f"vehicles[{vid}]: missing required field '{req}'")
        if v.get("family"):
            valid_families.add(v["family"])
        for feat in v.get("features", []):
            valid_features.add(feat)

    cmd_map: Dict[str, Dict[str, Any]] = {}
    for idx, cmd in enumerate(catalog.get("commands", [])):
        cid = cmd.get("id")
        if not cid:
            errors.append(f"commands[{idx}]: missing 'id'")
            continue
        if cid in cmd_map:
            errors.append(f"commands[{cid}]: duplicate command id")
        cmd_map[cid] = cmd

        ha = cmd.get("ha_metadata", {})
        if not ha.get("name") or ha.get("domain") not in ALLOWED_DOMAINS:
            errors.append(f"commands[{cid}].ha_metadata: invalid name or domain '{ha.get('domain')}'")

        if cmd.get("category") not in ALLOWED_CATEGORIES:
            errors.append(f"commands[{cid}]: invalid category '{cmd.get('category')}'")

        for t in cmd.get("tags", []):
            if t not in valid_families:
                errors.append(f"commands[{cid}]: unknown vehicle family tag '{t}'")
        if "requires_feature" in cmd and cmd["requires_feature"] not in valid_features:
            errors.append(f"commands[{cid}]: unknown requires_feature '{cmd['requires_feature']}'")

        roles = cmd.get("roles", [])
        if not roles or any(r not in ALLOWED_ROLES for r in roles):
            errors.append(f"commands[{cid}]: invalid roles {roles}")

        net = cmd.get("network", {})
        ntype = net.get("type")
        if ntype not in ALLOWED_NET_TYPES:
            errors.append(f"commands[{cid}].network: invalid type '{ntype}'")

        # Ensure root CAN IDs (if present) match network CAN IDs
        for can_key in ("state_can_id", "action_can_id"):
            if can_key in cmd and can_key in net and cmd[can_key] != net[can_key]:
                errors.append(
                    f"commands[{cid}]: root {can_key} ({cmd[can_key]}) != network.{can_key} ({net[can_key]})"
                )

        for can_key in ("state_can_id", "action_can_id", "flow_control_can_id", "trigger_frame_can_id"):
            if can_key in net and not HEX_CAN_ID_RE.match(str(net[can_key])):
                errors.append(f"commands[{cid}].network.{can_key}: invalid CAN ID '{net[can_key]}'")

        if "action" in roles and not net.get("action_can_id"):
            errors.append(f"commands[{cid}]: has 'action' role but missing network.action_can_id")

        if "match" in cmd:
            validate_byte_map(cmd["match"], f"commands[{cid}].match", errors)
        for s_idx, step in enumerate(cmd.get("steps", [])):
            if "payload" in step:
                validate_byte_map(
                    step["payload"], f"commands[{cid}].steps[{s_idx}].payload",
                    errors, allow_raw_hex=True
                )
            if "can_id" in step and not HEX_CAN_ID_RE.match(str(step["can_id"])):
                errors.append(f"commands[{cid}].steps[{s_idx}].can_id: invalid CAN ID '{step['can_id']}'")

        state_byte = net.get("state_byte")
        for o_idx, opt in enumerate(cmd.get("options", [])):
            o_ctx = f"commands[{cid}].options[{o_idx}]"
            if not opt.get("label"):
                errors.append(f"{o_ctx}: missing 'label'")
            if "match" in opt:
                validate_byte_map(opt["match"], f"{o_ctx}.match", errors)
                if state_byte and len(opt["match"]) == 1 and state_byte not in opt["match"]:
                    errors.append(
                        f"{o_ctx}.match: byte {list(opt['match'].keys())} does not match network.state_byte '{state_byte}'"
                    )
            if "payload" in opt:
                validate_byte_map(opt["payload"], f"{o_ctx}.payload", errors, allow_raw_hex=True)
            for s_idx, step in enumerate(opt.get("steps", [])):
                if "payload" in step:
                    validate_byte_map(
                        step["payload"], f"{o_ctx}.steps[{s_idx}].payload",
                        errors, allow_raw_hex=True
                    )
                if "can_id" in step and not HEX_CAN_ID_RE.match(str(step["can_id"])):
                    errors.append(f"{o_ctx}.steps[{s_idx}].can_id: invalid CAN ID '{step['can_id']}'")
            if "evaluate" in opt:
                ev = opt["evaluate"]
                if ev.get("operator") not in ALLOWED_OPERATORS:
                    errors.append(f"{o_ctx}.evaluate: unnormalized operator '{ev.get('operator')}'")
                if not BYTE_KEY_RE.match(str(ev.get("byte", ""))):
                    errors.append(f"{o_ctx}.evaluate: invalid byte '{ev.get('byte')}'")

    # Validate Automations & Cross-References
    for idx, auto in enumerate(catalog.get("automations", [])):
        aid = auto.get("id", f"index_{idx}")
        for t in auto.get("tags", []):
            if t not in valid_families:
                errors.append(f"automations[{aid}]: unknown vehicle family tag '{t}'")

        for cond in auto.get("conditions", []):
            cid_ref = cond.get("source_command_id")
            if cid_ref and cid_ref not in cmd_map:
                errors.append(f"automations[{aid}].conditions: unknown source_command_id '{cid_ref}'")

        for act in auto.get("actions", []):
            if act.get("type") == "entity_command":
                target_id = act.get("entity_id")
                target_cmd_label = act.get("command")
                if target_id not in cmd_map:
                    errors.append(
                        f"automations[{aid}]: action references missing command entity_id '{target_id}'"
                    )
                else:
                    target_cmd = cmd_map[target_id]
                    if "action" not in target_cmd.get("roles", []):
                        errors.append(
                            f"automations[{aid}]: action targets read-only entity '{target_id}' (missing 'action' role)"
                        )
                    opt_labels = {o.get("label") for o in target_cmd.get("options", [])}
                    if opt_labels and target_cmd_label not in opt_labels:
                        errors.append(
                            f"automations[{aid}]: command '{target_cmd_label}' not found in '{target_id}' options {opt_labels}"
                        )

    return errors, warnings


def strip_for_esp32(catalog: Dict[str, Any]) -> Dict[str, Any]:
    """Strips UI metadata AND mirrored root CAN IDs for minimal ESP32 flash footprint."""
    runtime = copy.deepcopy(catalog)
    runtime.pop("vehicles", None)
    ui_keys = {
        "ha_metadata", "category", "subcategory", "contributor", "contributors",
        "notes", "device_class", "popup_message", "state_can_id", "action_can_id",
    }
    for cmd in runtime.get("commands", []):
        for k in ui_keys:
            cmd.pop(k, None)
        for opt in cmd.get("options", []):
            opt.pop("popup", None)
    for auto in runtime.get("automations", []):
        for k in ("name", "description", "category", "ha_icon", "contributor", "contributors"):
            auto.pop(k, None)
    return runtime


def main():
    parser = argparse.ArgumentParser(description="Optimize and validate catalog/can_do_catalog.json")
    parser.add_argument(
        "input", type=Path, nargs="?", default=Path("catalog/can_do_catalog.json"),
        help="Path to input can_do_catalog.json (default: catalog/can_do_catalog.json)"
    )
    parser.add_argument("-o", "--output", type=Path, default=None, help="Output path (defaults to in-place)")
    parser.add_argument("--shrink-linear", action="store_true", help="Strip linear_scale option arrays")
    parser.add_argument("--esp32", type=Path, default=None, help="Output minified ESP32 runtime JSON")
    parser.add_argument(
        "--check", action="store_true",
        help="CI mode: validate input file without writing; exit 1 on schema errors"
    )
    args = parser.parse_args()

    raw_text = args.input.read_text(encoding="utf-8")
    data = json.loads(raw_text)

    if args.check:
        errors, warnings = validate_catalog(data)
        for w in warnings:
            print(f"[WARN]  {w}")
        for e in errors:
            print(f"[ERROR] {e}")
        if errors:
            print(f"\n[!] Validation FAILED with {len(errors)} error(s) and {len(warnings)} warning(s).")
            sys.exit(1)
        print(f"[+] Validation PASSED (0 errors, {len(warnings)} warnings).")
        sys.exit(0)

    cleaned = optimize_catalog(data, shrink_linear=args.shrink_linear)
    errors, warnings = validate_catalog(cleaned)

    for w in warnings:
        print(f"[WARN]  {w}")
    if errors:
        for e in errors:
            print(f"[ERROR] {e}")
        print(f"\n[!] Cleaned output still has {len(errors)} validation error(s)!")
        sys.exit(1)

    out_path = args.output or args.input
    cleaned_text = json.dumps(cleaned, indent=2, ensure_ascii=False)
    out_path.write_text(cleaned_text + "\n", encoding="utf-8")
    print(f"[+] Cleaned & Validated Catalog Saved: {out_path} ({len(cleaned_text):,} bytes)")

    if args.esp32:
        esp_data = strip_for_esp32(cleaned)
        esp_text = json.dumps(esp_data, separators=(",", ":"), ensure_ascii=False)
        args.esp32.write_text(esp_text, encoding="utf-8")
        print(f"[+] ESP32 Runtime Saved: {args.esp32} ({len(esp_text):,} bytes)")


if __name__ == "__main__":
    main()
