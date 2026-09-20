"""Climate platform for CAN Do integration (Cabin Target Temperatures & HVAC telemetry)."""

import logging
from typing import Any, Callable, Dict, List, Optional

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .catalog_loader import get_d_index
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do climate entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: List[ClimateEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "climate":
            entities.append(CanDoClimateEntity(coordinator, cmd, hass))

    async_add_entities(entities)


class CanDoClimateEntity(CanDoEntity, ClimateEntity):
    """Climate entity controlling vehicle cabin set temperatures and reporting HVAC telemetry."""

    _attr_supported_features = ClimateEntityFeature.TARGET_TEMPERATURE
    _attr_hvac_modes = [HVACMode.AUTO, HVACMode.HEAT_COOL, HVACMode.OFF]

    def __init__(
        self, coordinator: CanDoDataCoordinator, command: Dict[str, Any], hass: HomeAssistant
    ) -> None:
        """Initialize climate entity."""
        super().__init__(coordinator, command)
        self.hass = hass
        self._hvac_mode: HVACMode = HVACMode.AUTO
        self._aux_unsubs: List[Callable[[], None]] = []

        net = command.get("network", {})
        self.action_can_id = net.get("action_can_id", "0x4A0")
        self.action_byte = net.get("action_byte", "D2")
        self.state_byte = net.get("state_byte", "D2")

        # Dynamically adapt to Home Assistant's configured temperature unit
        is_fahrenheit = hass.config.units.temperature_unit == UnitOfTemperature.FAHRENHEIT
        if is_fahrenheit:
            self._attr_temperature_unit = UnitOfTemperature.FAHRENHEIT
            self._attr_min_temp = 62.0
            self._attr_max_temp = 82.0
            self._attr_target_temperature_step = 1.0
            self._target_temp: float = 70.0
        else:
            self._attr_temperature_unit = UnitOfTemperature.CELSIUS
            self._attr_min_temp = 17.0
            self._attr_max_temp = 27.0
            self._attr_target_temperature_step = 0.5
            self._target_temp: float = 21.0

    async def async_added_to_hass(self) -> None:
        """Register CAN state listener and auxiliary telemetry listeners."""
        await super().async_added_to_hass()
        # Listen to ambient temperature (0x226) and climate status (0x31B, 0x541, 0x418, 0x496)
        for aux_id in ("0x226", "0x31b", "0x541", "0x418", "0x496"):
            if not self.state_can_id or aux_id != self.state_can_id.lower():
                unsub = self.coordinator.register_listener(aux_id, self._handle_can_update)
                self._aux_unsubs.append(unsub)

    async def async_will_remove_from_hass(self) -> None:
        """Unregister auxiliary telemetry listeners."""
        for unsub in self._aux_unsubs:
            unsub()
        self._aux_unsubs.clear()
        await super().async_will_remove_from_hass()

    @property
    def hvac_mode(self) -> HVACMode:
        """Return current HVAC mode."""
        return self._hvac_mode

    @property
    def hvac_action(self) -> Optional[HVACAction]:
        """Return the running HVAC action (heating, cooling, fan, off)."""
        if self._hvac_mode == HVACMode.OFF:
            return HVACAction.OFF

        # Check blower fan speed from 0x31B Byte D4 low nibble
        p_31b = self.coordinator.get_can_payload("0x31b")
        if p_31b and len(p_31b) >= 4:
            fan_raw = p_31b[3] & 0x0F
            if fan_raw == 0:
                return HVACAction.OFF

        curr = self.current_temperature
        targ = self.target_temperature
        if curr is not None and targ is not None:
            diff = targ - curr
            threshold = 2.0 if self.temperature_unit == UnitOfTemperature.FAHRENHEIT else 1.0
            if diff > threshold:
                return HVACAction.HEATING
            elif diff < -threshold:
                return HVACAction.COOLING

        return HVACAction.HEATING if self._hvac_mode == HVACMode.HEAT_COOL else HVACAction.IDLE

    @property
    def current_temperature(self) -> Optional[float]:
        """Return current outdoor ambient temperature from CAN ID 0x226 Byte D4 ([B3])."""
        payload = self.coordinator.get_can_payload("0x226")
        if payload and len(payload) >= 4:
            raw = payload[3]
            if 0 < raw < 255:
                temp_c = float(raw - 40)
                if self.temperature_unit == UnitOfTemperature.FAHRENHEIT:
                    return round(temp_c * 1.8 + 32, 1)
                return round(temp_c, 1)
        return None

    @property
    def target_temperature(self) -> Optional[float]:
        """Return the target temperature."""
        if not self.state_can_id:
            return self._target_temp

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return self._target_temp

        idx = get_d_index(self.state_byte)
        if 0 <= idx < len(payload):
            raw = payload[idx]
            if 0x06 <= raw <= 0x1A:
                if self.temperature_unit == UnitOfTemperature.FAHRENHEIT:
                    self._target_temp = float(62 + (raw - 0x06))
                else:
                    self._target_temp = round(17.0 + (raw - 0x06) * 0.5, 1)

        return self._target_temp

    @property
    def extra_state_attributes(self) -> Dict[str, Any]:
        """Return rich climate telemetry attributes."""
        attrs: Dict[str, Any] = {}

        # 1. HVAC Blower Fan Speed & Airflow (0x31B Byte D4)
        p_31b = self.coordinator.get_can_payload("0x31b")
        if p_31b and len(p_31b) >= 4:
            fan_raw = p_31b[3] & 0x0F
            if fan_raw == 0:
                attrs["fan_speed"] = "Off"
                attrs["fan_speed_level"] = 0
            elif 2 <= fan_raw <= 9:
                level = fan_raw - 1
                attrs["fan_speed"] = f"Speed {level}"
                attrs["fan_speed_level"] = level

            airflow_raw = p_31b[3] & 0xF0
            airflow_names = {
                0x00: "Auto",
                0x10: "Body / Face Vents",
                0x20: "Body & Legs",
                0x30: "Legs / Floor Vents",
                0x40: "Legs & Defog",
            }
            attrs["airflow_direction"] = airflow_names.get(airflow_raw, f"0x{airflow_raw:02X}")

        if p_31b and len(p_31b) >= 5:
            attrs["air_recirculation"] = bool(p_31b[4] & 0x40)

        # 2. Rear Defroster (0x541 Byte D1)
        p_541 = self.coordinator.get_can_payload("0x541")
        if p_541 and len(p_541) >= 1:
            attrs["rear_defrost"] = bool(p_541[0] & 0x01)

        # 3. Heated Steering Wheel (0x418 Byte D1)
        p_418 = self.coordinator.get_can_payload("0x418")
        if p_418 and len(p_418) >= 1:
            wheel_val = p_418[0] & 0x03
            attrs["heated_steering_wheel"] = ["Off", "Low", "High"][wheel_val] if wheel_val < 3 else "Unknown"

        # 4. Seat Comfort (0x496 Byte D1)
        p_496 = self.coordinator.get_can_payload("0x496")
        if p_496 and len(p_496) >= 1:
            d_raw = p_496[0]
            seat_map = {
                0x16: "Off",
                0x0E: "Low Heat",
                0x0A: "Medium Heat",
                0x02: "High Heat",
                0x14: "Low Cool",
                0x12: "Medium Cool",
                0x10: "High Cool",
            }
            if d_raw in seat_map:
                attrs["driver_seat_comfort"] = seat_map[d_raw]

        return attrs

    async def async_set_temperature(self, **kwargs: Any) -> None:
        """Set new target temperature on vehicle CAN bus."""
        temp = kwargs.get("temperature")
        if temp is None:
            return

        temp = max(self._attr_min_temp, min(self._attr_max_temp, float(temp)))

        if self.temperature_unit == UnitOfTemperature.FAHRENHEIT:
            raw_val = 0x06 + int(round(temp - 62.0))
        else:
            raw_val = 0x06 + int(round((temp - 17.0) * 2.0))

        raw_val = max(0x06, min(0x1A, raw_val))

        data = [0] * 8
        if self.command.get("id") == "climate_dual_cabin_temp":
            data[1] = raw_val  # D2 Driver
            data[7] = raw_val  # D8 Passenger
        else:
            idx = get_d_index(self.action_byte)
            if 0 <= idx < 8:
                data[idx] = raw_val

        hex_payload = "".join(f"{b:02X}" for b in data)
        steps = [{"payload": hex_payload, "repeat": 2, "delay_ms": 20}]

        _LOGGER.info(
            "Setting %s target temp to %.1f %s (raw 0x%02X on %s)",
            self.name,
            temp,
            self.temperature_unit,
            raw_val,
            self.action_can_id,
        )
        await self.coordinator.async_send_action(self.action_can_id, 20, steps)

        self._target_temp = temp
        self.async_write_ha_state()

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        """Set new HVAC mode."""
        self._hvac_mode = hvac_mode
        self.async_write_ha_state()

