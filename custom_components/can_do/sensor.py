"""Sensor platform for CAN Do integration with linear scaling & counter filtering."""

import logging
from typing import Any, Dict, List, Optional

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    PERCENTAGE,
    UnitOfElectricPotential,
    UnitOfLength,
    UnitOfSpeed,
    UnitOfTemperature,
)
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
            self._attr_native_unit_of_measurement = UnitOfLength.KILOMETERS if "km" in unit.lower() else UnitOfLength.MILES
        elif "soc" in cid or unit == "%":
            self._attr_device_class = SensorDeviceClass.BATTERY
            self._attr_state_class = SensorStateClass.MEASUREMENT
            self._attr_native_unit_of_measurement = PERCENTAGE
        elif "voltage" in cid or (("battery" in cid or "12v" in cid) and unit in ("v", "V")):
            self._attr_device_class = SensorDeviceClass.VOLTAGE
            self._attr_state_class = SensorStateClass.MEASUREMENT
            self._attr_native_unit_of_measurement = UnitOfElectricPotential.VOLT

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

        # 1D. Outdoor Ambient Temperature (0x226: Byte D4 = deg C + 40, [B3])
        if "ambient_temp" in cid or cid == "cond_ambient_temperature" or (self.state_can_id.lower() == "0x226" and "temp" in cid):
            if len(payload) >= 4:
                raw = payload[3]
                if 0 < raw < 255:
                    temp_c = float(raw - 40)
                    if self._attr_native_unit_of_measurement == UnitOfTemperature.FAHRENHEIT:
                        return round(temp_c * 1.8 + 32, 1)
                    return round(temp_c, 1)

        # 1E. HV Battery Module Temperatures (0x152: Byte D1=Min, D2=Max signed deg C)
        if "battery_temp" in cid or cid == "hv_battery_temperatures" or (self.state_can_id.lower() == "0x152" and "temp" in cid):
            if len(payload) >= 1:
                raw = payload[0]
                temp_c = float(raw if raw < 128 else raw - 256)
                if self._attr_native_unit_of_measurement == UnitOfTemperature.FAHRENHEIT:
                    return round(temp_c * 1.8 + 32, 1)
                return temp_c

        # 1F. High Voltage Battery SOC (0x2FC: Byte D8 = factor 0.5 %, [B7])
        if "soc" in cid or cid == "cond_hv_battery_soc" or (self.state_can_id.lower() == "0x2fc" and "soc" in cid):
            if len(payload) >= 8:
                raw = payload[7]
                return round(raw * 0.5, 1)

        # 1G. Vehicle Odometer (0x227: 24-bit Little Endian across D2-D4 in 0.1 km units)
        if "odometer" in cid or cid == "vehicle_odometer" or self.state_can_id.lower() == "0x227":
            # In E-GMP 0x227: D1 is counter/sub-status (0x9F).
            # Cumulative odometer is 24-bit Little Endian across D2-D4 (payload[1..3]) in tenths of a kilometer (0.1 km).
            # Example: raw 871417 = 87,141.7 km = 54,147.3 miles.
            if len(payload) >= 4:
                raw_val = payload[1] | (payload[2] << 8) | (payload[3] << 16)
            elif len(payload) >= 3:
                raw_val = payload[1] | (payload[2] << 8)
            else:
                raw_val = 0

            if raw_val > 0:
                km_val = raw_val * 0.1
                if self._attr_native_unit_of_measurement == UnitOfLength.MILES:
                    return round(km_val * 0.621371192, 1)
                return round(km_val, 1)

        # 1H. 12V Auxiliary Battery Voltage (0x1CF: Byte D6 = factor 0.1 V)
        if "12v" in cid or "aux" in cid or cid == "cond_aux_12v_battery" or (self.state_can_id and self.state_can_id.lower() == "0x1cf"):
            state_byte = net.get("state_byte", "D6")
            idx = get_d_index(state_byte)
            factor = float(net.get("factor", 0.1))
            if 0 <= idx < len(payload):
                val = round(payload[idx] * factor, 1)
                if 8.0 <= val <= 16.5:
                    return val
            for alt_idx in (5, 4):
                if alt_idx < len(payload):
                    val = round(payload[alt_idx] * 0.1, 1)
                    if 8.0 <= val <= 16.5:
                        return val

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
        if new_val is not None:
            self._last_native_val = new_val
        super()._handle_can_update()

    @property
    def extra_state_attributes(self) -> Dict[str, Any]:
        """Return raw CAN telemetry bytes and decoded thresholds as state attributes."""
        attrs: Dict[str, Any] = {}
        if self.state_can_id:
            payload = self.coordinator.get_can_payload(self.state_can_id)
            if payload:
                attrs["raw_hex"] = "".join(f"{b:02X}" for b in payload)
                for i, b in enumerate(payload):
                    attrs[f"D{i+1}"] = f"0x{b:02X}"

                # Add human-friendly thresholds for ambient temperature
                if self.state_can_id.lower() == "0x226" and len(payload) >= 4:
                    raw = payload[3]
                    if raw <= 40:
                        attrs["threshold"] = "Freezing (<= 0°C / 32°F)"
                    elif raw < 55:
                        attrs["threshold"] = "Cold (< 15°C / 59°F)"
                    elif raw > 65:
                        attrs["threshold"] = "Warm (> 25°C / 77°F)"
                    else:
                        attrs["threshold"] = "Comfortable (15-25°C / 59-77°F)"
        return attrs
