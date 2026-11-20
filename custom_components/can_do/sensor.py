"""Sensor platform for CAN Do integration with linear scaling & counter filtering."""

import logging
import re
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    PERCENTAGE,
    UnitOfElectricCurrent,
    UnitOfElectricPotential,
    UnitOfLength,
    UnitOfPower,
    UnitOfSpeed,
    UnitOfTemperature,
)

try:
    from homeassistant.const import UnitOfPressure
except ImportError:  # pragma: no cover - minimal unit-test stubs
    UnitOfPressure = None  # type: ignore[assignment]

try:
    from homeassistant.const import UnitOfTime
except ImportError:  # pragma: no cover - minimal unit-test stubs
    UnitOfTime = None  # type: ignore[assignment]

from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .can_utils import decode_outdoor_temperature_c, option_matches, resolve_effective_mask
from .catalog_loader import (
    DEFAULT_ENDIANNESS,
    check_match,
    decode_can_uint,
    get_d_index,
    parse_hex_val,
    parse_state_byte_spec,
)
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)

_UNIT_MINUTES = getattr(UnitOfTime, "MINUTES", "min") if UnitOfTime is not None else "min"
_UNIT_SECONDS = getattr(UnitOfTime, "SECONDS", "s") if UnitOfTime is not None else "s"
_UNIT_HOURS = getattr(UnitOfTime, "HOURS", "h") if UnitOfTime is not None else "h"
_UNIT_BAR = getattr(UnitOfPressure, "BAR", "bar") if UnitOfPressure is not None else "bar"
_UNIT_PSI = getattr(UnitOfPressure, "PSI", "psi") if UnitOfPressure is not None else "psi"
_UNIT_KPA = getattr(UnitOfPressure, "KPA", "kPa") if UnitOfPressure is not None else "kPa"
_UNIT_WATT = getattr(UnitOfPower, "WATT", "W")

_DEVICE_CLASS_MAP: dict[str, Any] = {
    "speed": getattr(SensorDeviceClass, "SPEED", "speed"),
    "temperature": getattr(SensorDeviceClass, "TEMPERATURE", "temperature"),
    "distance": getattr(SensorDeviceClass, "DISTANCE", "distance"),
    "duration": getattr(SensorDeviceClass, "DURATION", "duration"),
    "pressure": getattr(SensorDeviceClass, "PRESSURE", "pressure"),
    "power": getattr(SensorDeviceClass, "POWER", "power"),
    "current": getattr(SensorDeviceClass, "CURRENT", "current"),
    "voltage": getattr(SensorDeviceClass, "VOLTAGE", "voltage"),
    "battery": getattr(SensorDeviceClass, "BATTERY", "battery"),
    "signal_strength": getattr(SensorDeviceClass, "SIGNAL_STRENGTH", "signal_strength"),
    "energy": getattr(SensorDeviceClass, "ENERGY", "energy"),
    "frequency": getattr(SensorDeviceClass, "FREQUENCY", "frequency"),
    "enum": getattr(SensorDeviceClass, "ENUM", "enum"),
}

_STATE_CLASS_MAP: dict[str, Any] = {
    "measurement": getattr(SensorStateClass, "MEASUREMENT", "measurement"),
    "total": getattr(SensorStateClass, "TOTAL", "total"),
    "total_increasing": getattr(SensorStateClass, "TOTAL_INCREASING", "total_increasing"),
}


def _resolve_unit_and_device_class(unit_str: str) -> tuple[Any, Any]:
    """Map a unit string from ha_metadata or network.unit to (HA unit, inferred device_class)."""
    u = unit_str.strip()
    ul = u.lower()
    if ul in ("km/h", "kph"):
        return UnitOfSpeed.KILOMETERS_PER_HOUR, _DEVICE_CLASS_MAP["speed"]
    if ul == "mph":
        return UnitOfSpeed.MILES_PER_HOUR, _DEVICE_CLASS_MAP["speed"]
    if ul in ("°c", "c"):
        return UnitOfTemperature.CELSIUS, _DEVICE_CLASS_MAP["temperature"]
    if ul in ("°f", "f"):
        return UnitOfTemperature.FAHRENHEIT, _DEVICE_CLASS_MAP["temperature"]
    if ul == "km":
        return UnitOfLength.KILOMETERS, _DEVICE_CLASS_MAP["distance"]
    if ul == "mi":
        return UnitOfLength.MILES, _DEVICE_CLASS_MAP["distance"]
    if ul in ("min", "mins", "minute", "minutes"):
        return _UNIT_MINUTES, _DEVICE_CLASS_MAP["duration"]
    if ul in ("s", "sec", "second", "seconds"):
        return _UNIT_SECONDS, _DEVICE_CLASS_MAP["duration"]
    if ul in ("h", "hr", "hour", "hours"):
        return _UNIT_HOURS, _DEVICE_CLASS_MAP["duration"]
    if ul == "bar":
        return _UNIT_BAR, _DEVICE_CLASS_MAP["pressure"]
    if ul == "psi":
        return _UNIT_PSI, _DEVICE_CLASS_MAP["pressure"]
    if ul == "kpa":
        return _UNIT_KPA, _DEVICE_CLASS_MAP["pressure"]
    if ul == "kw":
        return UnitOfPower.KILO_WATT, _DEVICE_CLASS_MAP["power"]
    if ul == "w":
        return _UNIT_WATT, _DEVICE_CLASS_MAP["power"]
    if ul == "a":
        return UnitOfElectricCurrent.AMPERE, _DEVICE_CLASS_MAP["current"]
    if ul == "mv":
        return UnitOfElectricPotential.MILLIVOLT, _DEVICE_CLASS_MAP["voltage"]
    if ul == "v":
        return UnitOfElectricPotential.VOLT, _DEVICE_CLASS_MAP["voltage"]
    if ul == "%":
        return PERCENTAGE, _DEVICE_CLASS_MAP["battery"]
    return u, None


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do sensor entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[SensorEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "sensor":
            entities.append(CanDoSensorEntity(coordinator, cmd))

    # Add BLE Last Button and RSSI Sensors
    entities.append(CanDoBleLastButtonSensor(coordinator))
    entities.append(CanDoBleBeaconRssiSensor(coordinator))
    entities.append(CanDoBleDeviceRssiSensor(coordinator))

    async_add_entities(entities)


class CanDoBleLastButtonSensor(SensorEntity):
    """Sensor displaying last Bluetooth remote button or chord pressed."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "Last Bluetooth Button Pressed"
    _attr_icon = "mdi:gesture-tap-button"

    def __init__(self, coordinator: CanDoDataCoordinator) -> None:
        """Initialize last button sensor."""
        self.coordinator = coordinator
        self._attr_unique_id = f"{coordinator.device_id}_ble_last_button"
        self._unsub = None

    @property
    def available(self) -> bool:
        """Return True so entity stays active."""
        return True

    @property
    def device_info(self):
        """Link to parent CAN Do Bridge device."""
        from homeassistant.helpers.device_registry import DeviceInfo
        from .const import VERSION
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.effective_device_id)},
            name=f"CAN Do Bridge ({self.coordinator.effective_device_id})",
            manufacturer="CAN Do",
            model="ESP32 Bridge",
            sw_version=VERSION,
        )

    @property
    def native_value(self) -> str | None:
        """Return formatted button / combo state."""
        last = self.coordinator.last_ble_button
        if not last:
            return "None"
        btn = last.get("combo") or last.get("button") or "Unknown"
        action = last.get("action", "press")
        return f"{btn} ({action})"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return button details."""
        last = self.coordinator.last_ble_button or {}
        return {
            "button": last.get("button", ""),
            "combo": last.get("combo", ""),
            "action": last.get("action", ""),
            "address": last.get("address", ""),
        }

    async def async_added_to_hass(self) -> None:
        """Register listener when added to hass."""
        await super().async_added_to_hass()
        self._unsub = self.coordinator.register_ble_button_listener(self.async_write_ha_state)

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe listener on remove."""
        if self._unsub:
            self._unsub()
        await super().async_will_remove_from_hass()


class CanDoBleBeaconRssiSensor(SensorEntity):
    """Sensor reporting active BLE beacon signal strength."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "BLE Beacon RSSI"
    _attr_icon = "mdi:signal-distance-variant"
    _attr_device_class = SensorDeviceClass.SIGNAL_STRENGTH
    _attr_native_unit_of_measurement = "dBm"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: CanDoDataCoordinator) -> None:
        """Initialize BLE beacon RSSI sensor."""
        self.coordinator = coordinator
        self._attr_unique_id = f"{coordinator.device_id}_ble_beacon_rssi"
        self._unsub = None

    @property
    def available(self) -> bool:
        """Return True so entity stays active."""
        return True

    @property
    def device_info(self):
        """Link to parent CAN Do Bridge device."""
        from homeassistant.helpers.device_registry import DeviceInfo
        from .const import VERSION
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.effective_device_id)},
            name=f"CAN Do Bridge ({self.coordinator.effective_device_id})",
            manufacturer="CAN Do",
            model="ESP32 Bridge",
            sw_version=VERSION,
        )

    @property
    def native_value(self) -> int | None:
        """Return RSSI integer value."""
        last = self.coordinator.last_ble_beacon
        if not last or "rssi" not in last or last["rssi"] == 0:
            return None
        return int(last["rssi"])

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return beacon details."""
        last = self.coordinator.last_ble_beacon or {}
        return {
            "uuid": last.get("uuid", ""),
            "mac": last.get("mac", ""),
            "name": last.get("name", ""),
        }

    async def async_added_to_hass(self) -> None:
        """Register listener when added to hass."""
        await super().async_added_to_hass()
        self._unsub = self.coordinator.register_ble_beacon_listener(self.async_write_ha_state)

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe listener on remove."""
        if self._unsub:
            self._unsub()
        await super().async_will_remove_from_hass()


class CanDoBleDeviceRssiSensor(SensorEntity):
    """Sensor reporting active BLE device signal strength."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "BLE Device RSSI"
    _attr_icon = "mdi:signal-distance-variant"
    _attr_device_class = SensorDeviceClass.SIGNAL_STRENGTH
    _attr_native_unit_of_measurement = "dBm"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: CanDoDataCoordinator) -> None:
        """Initialize BLE device RSSI sensor."""
        self.coordinator = coordinator
        self._attr_unique_id = f"{coordinator.device_id}_ble_device_rssi"
        self._unsub = None

    @property
    def available(self) -> bool:
        """Return True so entity stays active."""
        return True

    @property
    def device_info(self):
        """Link to parent CAN Do Bridge device."""
        from homeassistant.helpers.device_registry import DeviceInfo
        from .const import VERSION
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.effective_device_id)},
            name=f"CAN Do Bridge ({self.coordinator.effective_device_id})",
            manufacturer="CAN Do",
            model="ESP32 Bridge",
            sw_version=VERSION,
        )

    @property
    def native_value(self) -> int | None:
        """Return RSSI integer value."""
        last = self.coordinator.last_ble_device
        if not last or "rssi" not in last or last["rssi"] == 0:
            return None
        return int(last["rssi"])

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return device details."""
        last = self.coordinator.last_ble_device or {}
        return {
            "address": last.get("address", ""),
            "name": last.get("name", ""),
        }

    async def async_added_to_hass(self) -> None:
        """Register listener when added to hass."""
        await super().async_added_to_hass()
        self._unsub = self.coordinator.register_ble_device_listener(self.async_write_ha_state)

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe listener on remove."""
        if self._unsub:
            self._unsub()
        await super().async_will_remove_from_hass()



class CanDoSensorEntity(CanDoEntity, SensorEntity):
    """Sensor entity decoding vehicle telemetry and status from CAN."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
        """Initialize sensor entity."""
        super().__init__(coordinator, command)
        self._last_native_val: Any = None

        ha_meta = command.get("ha_metadata") or {}
        net = command.get("network") or {}
        options = command.get("options") or []
        cid = self.entity_id_str.lower()

        meta_dc_raw = ha_meta.get("device_class")
        meta_sc_raw = ha_meta.get("state_class")
        meta_unit_raw = ha_meta.get("unit_of_measurement")
        net_unit_raw = net.get("unit")

        meta_dc = str(meta_dc_raw).strip().lower() if meta_dc_raw not in (None, "") else ""
        meta_sc = str(meta_sc_raw).strip().lower() if meta_sc_raw not in (None, "") else ""
        raw_unit = (
            str(meta_unit_raw).strip()
            if meta_unit_raw not in (None, "")
            else (str(net_unit_raw).strip() if net_unit_raw not in (None, "") else "")
        )

        # Entities with discrete text options and no declared numeric metadata/unit
        # (or explicit enum device_class) must never receive numeric state_class or units.
        has_text_options = any(
            isinstance(opt, dict) and bool(opt.get("label")) for opt in options
        )
        has_declared_numeric_meta = bool(
            raw_unit or (meta_dc and meta_dc != "enum") or meta_sc
        )
        is_discrete_text_sensor = meta_dc == "enum" or (
            has_text_options and not has_declared_numeric_meta
        )

        if meta_dc == "enum":
            self._attr_device_class = _DEVICE_CLASS_MAP["enum"]
        elif not is_discrete_text_sensor:
            resolved_unit: Any = None
            inferred_dc: Any = None
            if raw_unit:
                resolved_unit, inferred_dc = _resolve_unit_and_device_class(raw_unit)

            resolved_dc: Any = (
                _DEVICE_CLASS_MAP.get(meta_dc, meta_dc) if meta_dc else inferred_dc
            )
            resolved_sc: Any = (
                _STATE_CLASS_MAP.get(meta_sc, meta_sc) if meta_sc else None
            )

            # Only fall back to ID heuristics when neither ha_metadata nor network.unit declared anything
            if resolved_dc is None and resolved_unit is None and resolved_sc is None:
                if "cluster_vehicle_speed" in cid or "wheel_speeds" in cid:
                    resolved_dc = _DEVICE_CLASS_MAP["speed"]
                    resolved_sc = SensorStateClass.MEASUREMENT
                    resolved_unit = UnitOfSpeed.KILOMETERS_PER_HOUR
                elif "temp" in cid:
                    resolved_dc = _DEVICE_CLASS_MAP["temperature"]
                    resolved_sc = SensorStateClass.MEASUREMENT
                    resolved_unit = UnitOfTemperature.CELSIUS
                elif "odometer" in cid:
                    resolved_dc = _DEVICE_CLASS_MAP["distance"]
                    resolved_sc = SensorStateClass.TOTAL_INCREASING
                    resolved_unit = UnitOfLength.KILOMETERS
                elif "power" in cid:
                    resolved_dc = _DEVICE_CLASS_MAP["power"]
                    resolved_sc = SensorStateClass.MEASUREMENT
                    resolved_unit = UnitOfPower.KILO_WATT
                elif "current" in cid:
                    resolved_dc = _DEVICE_CLASS_MAP["current"]
                    resolved_sc = SensorStateClass.MEASUREMENT
                    resolved_unit = UnitOfElectricCurrent.AMPERE
                elif "delta" in cid:
                    resolved_dc = _DEVICE_CLASS_MAP["voltage"]
                    resolved_sc = SensorStateClass.MEASUREMENT
                    resolved_unit = UnitOfElectricPotential.MILLIVOLT
                elif "soc" in cid:
                    resolved_dc = _DEVICE_CLASS_MAP["battery"]
                    resolved_sc = SensorStateClass.MEASUREMENT
                    resolved_unit = PERCENTAGE
                elif "voltage" in cid:
                    resolved_dc = _DEVICE_CLASS_MAP["voltage"]
                    resolved_sc = SensorStateClass.MEASUREMENT
                    resolved_unit = UnitOfElectricPotential.VOLT

            if resolved_sc is None and (resolved_unit is not None or resolved_dc is not None):
                if resolved_dc == _DEVICE_CLASS_MAP["distance"] and "odometer" in cid:
                    resolved_sc = SensorStateClass.TOTAL_INCREASING
                else:
                    resolved_sc = SensorStateClass.MEASUREMENT

            if resolved_dc is not None:
                self._attr_device_class = resolved_dc
            if resolved_sc is not None:
                self._attr_state_class = resolved_sc
            if resolved_unit is not None:
                self._attr_native_unit_of_measurement = resolved_unit

    def _match_discrete_options(self, payload: list[int]) -> str | None:
        """Match raw CAN payload against catalog option conditions or evaluate rules."""
        for opt in self.command.get("options", []):
            if option_matches(payload, opt, self.command):
                return opt.get("label")

            evaluate = opt.get("evaluate")
            if evaluate:
                byte_str = evaluate.get("byte", "")
                op = str(evaluate.get("operator", "")).strip().lower()
                val, _ = parse_hex_val(evaluate.get("value", 0))
                eval_len = evaluate.get("byte_length", 1)
                eval_endian = evaluate.get("endianness", DEFAULT_ENDIANNESS)
                idx = get_d_index(byte_str)
                actual = decode_can_uint(
                    payload,
                    idx,
                    eval_len,
                    eval_endian,
                    mask=evaluate.get("mask"),
                )
                if actual is not None:
                    if (
                        (op in ("greater_than", ">") and actual > val)
                        or (op in ("less_than", "<") and actual < val)
                        or (op in ("greater_than_or_equal", ">=") and actual >= val)
                        or (op in ("less_than_or_equal", "<=") and actual <= val)
                        or (op in ("equal", "eq", "==", "=") and actual == val)
                        or (op in ("not_equal", "!=") and actual != val)
                    ):
                        return opt.get("label")
        return None

    @property
    def native_value(self) -> Any:
        """Return the current sensor state with human-interpreted values."""
        direct_entity_val = self.coordinator.get_can_state(self.entity_id_str)
        cid = self.entity_id_str.lower()
        is_outdoor_temp = (
            cid in ("outdoor_temperature", "cond_ambient_temperature", "ambient_temperature")
            or "ambient_temp" in cid
            or (bool(self.state_can_id) and self.state_can_id.lower() in ("0x31c", "0x226") and "temp" in cid)
        )
        if is_outdoor_temp:
            temp_c: float | None = None
            if isinstance(direct_entity_val, (int, float)) and not isinstance(direct_entity_val, bool):
                val = float(direct_entity_val)
                if -40.0 <= val <= 60.0:
                    temp_c = val
            elif isinstance(direct_entity_val, str):
                m = re.search(r"[-+]?\d*\.?\d+", direct_entity_val)
                if m:
                    try:
                        val = float(m.group(0))
                        if -40.0 <= val <= 60.0:
                            temp_c = val
                    except ValueError:
                        pass
            if temp_c is None:
                temp_c = decode_outdoor_temperature_c(
                    self.coordinator.get_can_payload("0x31c"),
                    self.coordinator.get_can_payload("0x227"),
                    self.coordinator.get_can_payload("0x226"),
                )
            if temp_c is not None:
                if getattr(self, "_attr_native_unit_of_measurement", None) == UnitOfTemperature.FAHRENHEIT:
                    return round(temp_c * 1.8 + 32.0, 1)
                return round(temp_c, 1)
            return self._last_native_val

        if isinstance(direct_entity_val, (int, float)) and not isinstance(direct_entity_val, bool):
            return round(float(direct_entity_val), 2)

        if "bms" in cid:
            bms_aliases = {
                "bms_display_soc": "bms_soc",
                "bms_soc": "bms_display_soc",
                "bms_hv_voltage": "bms_hv_v",
                "bms_hv_v": "bms_hv_voltage",
                "bms_hv_current": "bms_hv_a",
                "bms_hv_a": "bms_hv_current",
                "bms_hv_power_kw": "bms_hv_kw",
                "bms_hv_kw": "bms_hv_power_kw",
            }
            alias = bms_aliases.get(cid)
            if alias:
                alias_val = self.coordinator.get_can_state(alias)
                if isinstance(alias_val, (int, float)) and not isinstance(alias_val, bool):
                    return round(float(alias_val), 2)
                if direct_entity_val is None:
                    direct_entity_val = alias_val

        if "12v" in cid or "aux" in cid:
            for aux_key in ("cond_aux_12v_battery", "vbat"):
                aux_val = self.coordinator.get_can_state(aux_key)
                if isinstance(aux_val, (int, float)) and not isinstance(aux_val, bool):
                    val = round(float(aux_val), 1)
                    if 8.0 <= val <= 16.5:
                        return val

        payload = None
        if self.state_can_id and self.state_can_id.lower() == "0x7ec" and cid.startswith("bms_"):
            payload = direct_entity_val
        else:
            if self.state_can_id:
                payload = self.coordinator.get_can_payload(self.state_can_id)
            if payload is None:
                payload = direct_entity_val

        if payload is None and ("12v" in cid or "aux" in cid):
            payload = self.coordinator.get_can_payload("0x1cf")

        if not payload and payload != 0:
            return self._last_native_val

        net = self.command.get("network", {})

        # 0. Direct numeric float or int payload (UDS telemetry or hardware ADC)
        if isinstance(payload, (int, float)):
            return round(float(payload), 2)

        # 0A. Direct decoded string telemetry from WiCAN (e.g. "13.4 V", "50%", "88735", "0 km/h")
        if isinstance(payload, str):
            p_lower = payload.strip().lower()
            if cid == "cond_charging":
                if p_lower in ("charging", "active"):
                    return "Charging In Progress"
                if p_lower in ("inactive", "not charging", "disconnected"):
                    return "Not Charging / Disconnected"

            for opt in self.command.get("options", []):
                opt_label = opt.get("label", "")
                ol_lower = opt_label.lower()
                if ol_lower == p_lower or (p_lower in ol_lower and len(p_lower) >= 4):
                    return opt_label
            import re
            m = re.search(r"[-+]?\d*\.?\d+", payload)
            if m:
                try:
                    num_val = float(m.group(0))
                    return int(num_val) if num_val.is_integer() else round(num_val, 2)
                except ValueError:
                    pass
            return payload

        # 1. Specialized Numeric Decoders
        # 1A. V2L Minimum Discharge Limit (0x151 Byte D7: factor 0.5 %)
        if cid == "v2l_minimum_charge_limit" or ("v2l" in cid and "limit" in cid) or (self.state_can_id and self.state_can_id.lower() == "0x151"):
            if isinstance(payload, list):
                for idx in (6, 7):
                    if idx < len(payload):
                        raw = payload[idx]
                        if 0x20 <= raw <= 0xB0:
                            return round(raw * 0.5)

        # 1B. Cluster Vehicle Road Speed (0x1AC Byte D1 = kph)
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
                    if getattr(self, "_attr_native_unit_of_measurement", None) == UnitOfTemperature.FAHRENHEIT:
                        return 62 + (raw - 0x06)
                    return round(17.0 + (raw - 0x06) * 0.5, 1)

        # 1E. HV Battery Module Temperatures (0x152: Byte D1=Min, D2=Max signed deg C)
        if "battery_temp" in cid or cid == "hv_battery_temperatures" or (self.state_can_id.lower() == "0x152" and "temp" in cid):
            if len(payload) >= 1:
                raw = payload[0]
                temp_c = float(raw if raw < 128 else raw - 256)
                if getattr(self, "_attr_native_unit_of_measurement", None) == UnitOfTemperature.FAHRENHEIT:
                    return round(temp_c * 1.8 + 32, 1)
                return temp_c

        # 1E2. BMS Cell Extremes Voltage (0x5D6: Byte D1 = Max Cell * 0.02V, D3 = Min Cell * 0.02V)
        if cid == "bms_cell_extremes_voltage" or (self.state_can_id and self.state_can_id.lower() == "0x5d6"):
            if isinstance(payload, list) and len(payload) >= 1 and payload[0] > 0:
                return round(payload[0] * 0.02, 2)

        # 1E3. BMS Module Extremes Temperature (0x5D7: Byte D1 = Max - 40C, D2 = Min - 40C)
        if cid == "bms_module_extremes_temp" or (self.state_can_id and self.state_can_id.lower() == "0x5d7"):
            if isinstance(payload, list) and len(payload) >= 1 and 0 < payload[0] < 255:
                temp_c = float(payload[0] - 40)
                if getattr(self, "_attr_native_unit_of_measurement", None) == UnitOfTemperature.FAHRENHEIT:
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
                if getattr(self, "_attr_native_unit_of_measurement", None) == UnitOfLength.MILES:
                    return round(km_val * 0.621371192, 1)
                return round(km_val, 1)

        # 1H. 12V Auxiliary Battery Voltage (MeatPi WiCAN Hardware ADC float or CAN frame fallback)
        if "12v" in cid or "aux" in cid or cid == "cond_aux_12v_battery" or (self.state_can_id and self.state_can_id.lower() in ("vbat", "0x1cf")):
            if isinstance(payload, (int, float)):
                val = round(float(payload), 1)
                if 8.0 <= val <= 16.5:
                    return val
            state_byte = net.get("state_byte", "D6")
            idx = get_d_index(state_byte)
            factor = float(net.get("factor", 0.1))
            if isinstance(payload, list) and 0 <= idx < len(payload):
                val = round(payload[idx] * factor, 1)
                if 8.0 <= val <= 16.5:
                    return val
            if isinstance(payload, list):
                for alt_idx in (5, 4):
                    if alt_idx < len(payload):
                        val = round(payload[alt_idx] * 0.1, 1)
                        if 8.0 <= val <= 16.5:
                            return val
        # 1I. Live EV Charging Power (0x30E: Byte D7 = integer in kW, 0-255 kW)
        if "charging_power" in cid or (self.state_can_id and self.state_can_id.lower() == "0x30e"):
            state_byte = net.get("state_byte", "D7")
            idx = get_d_index(state_byte)
            if isinstance(payload, list) and 0 <= idx < len(payload):
                return int(payload[idx])

        # 1J. Charge & Discharge Remaining Times (Minutes, 16-bit unsigned, 0xFFFF = inactive)
        is_remaining_time_ac = "remaining_charge_time_ac" in cid or (
            self.state_can_id and self.state_can_id.lower() == "0x327"
        )
        is_remaining_time_dc = "remaining_charge_time_dc" in cid or (
            self.state_can_id and self.state_can_id.lower() == "0x25c"
        )
        is_remaining_time_120v = "remaining_charge_time_120v" in cid or (
            self.state_can_id and self.state_can_id.lower() in ("0x328", "0x4e2")
        )
        is_v2l_remaining_time = "v2l_discharge_remaining_time" in cid or (
            self.state_can_id and self.state_can_id.lower() == "0x324"
        )
        if (
            is_remaining_time_ac
            or is_remaining_time_dc
            or is_remaining_time_120v
            or is_v2l_remaining_time
        ):
            if isinstance(payload, list):
                start_idx, byte_len, endianness = parse_state_byte_spec(net)
                if start_idx >= 0 and byte_len == 2:
                    raw = decode_can_uint(payload, start_idx, byte_len, endianness)
                    if raw is not None:
                        return 0 if raw == 0xFFFF else raw
                    return self._last_native_val

                # Legacy fallback when catalog still uses "D1-D2" range syntax
                scid_l = self.state_can_id.lower() if self.state_can_id else ""
                fallback_idx = -1
                if is_remaining_time_ac:
                    fallback_idx = 1 if scid_l == "0x597" else 0
                elif is_remaining_time_dc:
                    fallback_idx = 3 if scid_l == "0x597" else 2
                elif is_remaining_time_120v:
                    fallback_idx = 2 if scid_l == "0x4e2" else 0
                elif is_v2l_remaining_time:
                    fallback_idx = 6
                raw = decode_can_uint(payload, fallback_idx, 2, DEFAULT_ENDIANNESS)
                if raw is not None:
                    return 0 if raw == 0xFFFF else raw
                return self._last_native_val

        # 1K. Discrete Options (prioritized when numeric unit/multi-byte spec is absent) vs Generic Numeric/Linear Scale
        start_idx, byte_len, endianness = parse_state_byte_spec(net)
        has_numeric_unit = bool(
            net.get("unit") or (self.command.get("ha_metadata") or {}).get("unit_of_measurement")
        )
        if self.command.get("options") and not has_numeric_unit and byte_len < 2:
            opt_label = self._match_discrete_options(payload)
            if opt_label is not None:
                return opt_label

        if (
            self.command.get("type") == "linear_scale"
            or "min" in net
            or (byte_len == 2 and "state_byte" in net)
        ):
            raw = decode_can_uint(
                payload,
                start_idx,
                byte_len,
                endianness,
                mask=net.get("state_mask"),
            )
            if raw is not None:
                if "factor" in net or "offset" in net:
                    factor = float(net.get("factor", 1))
                    offset = float(net.get("offset", 0))
                    val = raw * factor + offset
                    if factor == 1.0 and offset == 0.0:
                        return int(raw)
                    return round(val, 2)
                if self.command.get("type") == "linear_scale" or "min" in net:
                    default_max = 65535 if byte_len == 2 else 255
                    min_val = net.get("min", 0)
                    max_val = net.get("max", default_max)
                    raw_min = parse_hex_val(net.get("raw_min", 0))[0]
                    raw_max = parse_hex_val(net.get("raw_max", default_max))[0]
                    if raw_max > raw_min:
                        scaled = min_val + ((raw - raw_min) / (raw_max - raw_min)) * (max_val - min_val)
                        return round(scaled, 1)
                return raw
            if byte_len == 2:
                return self._last_native_val

        # 2. Discrete Options Match
        opt_label = self._match_discrete_options(payload)
        if opt_label is not None:
            return opt_label

        # 3. Command-Level Binary Match
        if "match" in self.command:
            if check_match(payload, self.command["match"], resolve_effective_mask(self.command)):
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
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return raw CAN telemetry bytes and decoded thresholds as state attributes."""
        attrs: dict[str, Any] = {}
        cid = self.entity_id_str.lower()
        is_outdoor_temp = (
            cid in ("outdoor_temperature", "cond_ambient_temperature", "ambient_temperature")
            or "ambient_temp" in cid
            or (bool(self.state_can_id) and self.state_can_id.lower() in ("0x31c", "0x226") and "temp" in cid)
        )
        if is_outdoor_temp:
            temp_c = decode_outdoor_temperature_c(
                self.coordinator.get_can_payload("0x31c"),
                self.coordinator.get_can_payload("0x227"),
                self.coordinator.get_can_payload("0x226"),
            )
            if temp_c is not None:
                if temp_c <= 0.0:
                    attrs["threshold"] = "Freezing (<= 0°C / 32°F)"
                elif temp_c < 15.0:
                    attrs["threshold"] = "Cold (< 15°C / 59°F)"
                elif temp_c > 25.0:
                    attrs["threshold"] = "Warm (> 25°C / 77°F)"
                else:
                    attrs["threshold"] = "Comfortable (15-25°C / 59-77°F)"

        if self.state_can_id:
            payload = self.coordinator.get_can_payload(self.state_can_id)
            if isinstance(payload, list):
                attrs["raw_hex"] = "".join(f"{b:02X}" for b in payload)
                for i, b in enumerate(payload):
                    attrs[f"D{i+1}"] = f"0x{b:02X}"

                if self.state_can_id.lower() == "0x5d6" and len(payload) >= 3:
                    if payload[0] > 0:
                        attrs["max_cell_voltage_v"] = round(payload[0] * 0.02, 2)
                    if payload[2] > 0:
                        attrs["min_cell_voltage_v"] = round(payload[2] * 0.02, 2)
                elif self.state_can_id.lower() == "0x5d7" and len(payload) >= 2:
                    if 0 < payload[0] < 255:
                        attrs["max_module_temp_c"] = payload[0] - 40
                    if 0 < payload[1] < 255:
                        attrs["min_module_temp_c"] = payload[1] - 40
        return attrs
