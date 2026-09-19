"""Sensor platform for CAN Do integration with linear scaling & counter filtering."""

import logging
from typing import Any, Dict, List, Optional

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfSpeed, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .catalog_loader import check_match, get_d_index, parse_hex_val
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do sensor entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: List[SensorEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "sensor":
            entities.append(CanDoSensorEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoSensorEntity(CanDoEntity, SensorEntity):
    """Sensor entity decoding vehicle telemetry and status from CAN."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize sensor entity."""
        super().__init__(coordinator, command)
        self._last_native_val: Any = None

        net = command.get("network", {})
        unit = net.get("unit", "")
        cid = self.entity_id_str.lower()

        # Infer Device Class & Units
        if "speed" in cid or unit in ("km/h", "kph", "mph"):
            self._attr_device_class = SensorDeviceClass.SPEED
            self._attr_state_class = SensorStateClass.MEASUREMENT
            self._attr_native_unit_of_measurement = UnitOfSpeed.MILES_PER_HOUR if "mph" in unit else UnitOfSpeed.KILOMETERS_PER_HOUR
        elif "temp" in cid or unit in ("°F", "°C", "C", "F"):
            self._attr_device_class = SensorDeviceClass.TEMPERATURE
            self._attr_state_class = SensorStateClass.MEASUREMENT
            self._attr_native_unit_of_measurement = UnitOfTemperature.FAHRENHEIT if "f" in unit.lower() else UnitOfTemperature.CELSIUS
        elif "odometer" in cid or unit in ("km", "mi"):
            self._attr_device_class = SensorDeviceClass.DISTANCE
            self._attr_state_class = SensorStateClass.TOTAL_INCREASING
            self._attr_native_unit_of_measurement = "km"

    @property
    def native_value(self) -> Any:
        """Return the current sensor state with human-interpreted values."""
        if not self.state_can_id:
            return None

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return self._last_native_val

        net = self.command.get("network", {})
        cid = self.entity_id_str.lower()

        # 1. Specialized Numeric Decoders
        # 1A. Cluster Vehicle Road Speed (0x1AC Byte D1 = kph)
        if "cluster_vehicle_speed" in cid or (self.state_can_id.lower() == "0x1ac" and "speed" in cid):
            if len(payload) >= 1:
                return int(payload[0])

        # 1B. Wheel Speeds (0x0A2: 4 x 16-bit little-endian unsigned, factor 0.03125 kph)
        if "wheel_speeds" in cid or self.state_can_id.lower() == "0x0a2":
            if len(payload) >= 2:
                w1 = (payload[0] | (payload[1] << 8)) * 0.03125
                return round(w1, 1)

        # 1C. Climate Target Temperatures (0x380 Byte D2=Driver, D3=Passenger)
        if "temp" in cid and self.state_can_id.lower() == "0x380":
            state_byte = net.get("state_byte", "D2")
            idx = get_d_index(state_byte)
            if 0 <= idx < len(payload):
                raw = payload[idx]
                if 0x06 <= raw <= 0x1A:
                    # 0x06 = 17.0°C / 62°F, each step is 0.5°C / 1°F
                    if self._attr_native_unit_of_measurement == UnitOfTemperature.FAHRENHEIT:
                        return 62 + (raw - 0x06)
                    return round(17.0 + (raw - 0x06) * 0.5, 1)

        # 1D. HV Battery Module Temperatures (0x152: Byte D1=Min, D2=Max signed deg C)
        if "battery_temp" in cid or cid == "hv_battery_temperatures":
            if len(payload) >= 1:
                raw = payload[0]
                return raw if raw < 128 else raw - 256

        # 1E. Generic Linear Scale
        if self.command.get("type") == "linear_scale" or "min" in net:
            state_byte = net.get("state_byte", "D1")
            idx = get_d_index(state_byte)
            if 0 <= idx < len(payload):
                raw = payload[idx]
                min_val = net.get("min", 0)
                max_val = net.get("max", 255)
                raw_min = parse_hex_val(net.get("raw_min", 0))[0]
                raw_max = parse_hex_val(net.get("raw_max", 255))[0]
                if raw_max > raw_min:
                    scaled = min_val + ((raw - raw_min) / (raw_max - raw_min)) * (max_val - min_val)
                    return round(scaled, 1)
                return raw

        # 2. Discrete Options Match
        for opt in self.command.get("options", []):
            match_spec = opt.get("match")
            if match_spec and check_match(payload, match_spec, opt.get("mask")):
                return opt.get("label")

            evaluate = opt.get("evaluate")
            if evaluate:
                byte_str = evaluate.get("byte", "")
                op = evaluate.get("operator", "")
                val, _ = parse_hex_val(evaluate.get("value", 0))
                idx = get_d_index(byte_str)
                if 0 <= idx < len(payload):
                    actual = payload[idx]
                    if op == "greater_than" and actual > val:
                        return opt.get("label")
                    elif op == "less_than" and actual < val:
                        return opt.get("label")
                    elif op in ("equal", "eq") and actual == val:
                        return opt.get("label")

        # 3. Command-Level Binary Match
        if "match" in self.command:
            if check_match(payload, self.command["match"], self.command.get("mask")):
                return "Active"
            return "Inactive"

        # 4. Fallback: Return last known value or None (NEVER raw hex string)
        return self._last_native_val

    def _handle_can_update(self) -> None:
        """Handle updated CAN state only when the decoded value changes."""
        new_val = self.native_value
        if new_val is not None and new_val != self._last_native_val:
            self._last_native_val = new_val
            self.async_write_ha_state()

    @property
    def extra_state_attributes(self) -> Dict[str, Any]:
        """Return raw CAN telemetry bytes as state attributes for debugging."""
        attrs: Dict[str, Any] = {}
        if self.state_can_id:
            payload = self.coordinator.get_can_payload(self.state_can_id)
            if payload:
                attrs["raw_hex"] = "".join(f"{b:02X}" for b in payload)
                for i, b in enumerate(payload):
                    attrs[f"D{i+1}"] = f"0x{b:02X}"
        return attrs
