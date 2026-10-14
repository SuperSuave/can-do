"""Climate platform for CAN Do integration (Cabin Target Temperatures & HVAC telemetry)."""

import logging
from collections.abc import Callable
from typing import Any

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

from .can_utils import build_action_steps
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
    entities: list[ClimateEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "climate":
            entities.append(CanDoClimateEntity(coordinator, cmd, hass))

    async_add_entities(entities)


class CanDoClimateEntity(CanDoEntity, ClimateEntity):
    """Climate entity controlling vehicle cabin set temperatures and reporting HVAC telemetry."""

    _attr_supported_features = ClimateEntityFeature.TARGET_TEMPERATURE
    _attr_hvac_modes = [HVACMode.AUTO, HVACMode.HEAT_COOL, HVACMode.OFF]

    def __init__(
        self, coordinator: CanDoDataCoordinator, command: dict[str, Any], hass: HomeAssistant
    ) -> None:
        """Initialize climate entity."""
        super().__init__(coordinator, command)
        self.hass = hass
        self._hvac_mode: HVACMode = HVACMode.OFF
        self._aux_unsubs: list[Callable[[], None]] = []

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
            self._attr_max_temp = 27.5
            self._attr_target_temperature_step = 0.5
            self._target_temp: float = 21.0

    async def async_added_to_hass(self) -> None:
        """Register CAN state listener and auxiliary telemetry listeners."""
        await super().async_added_to_hass()
        # Listen to ambient temp (0x226), climate telemetry (0x31B, 0x541, 0x418, 0x496, 0x587),
        # VCU HVAC/contactor status (0x2AD, 0x2AE), DATC blower (0x384), and TMU (0x39B).
        for aux_id in ("0x226", "0x31b", "0x541", "0x418", "0x496", "0x587", "0x2ad", "0x2ae", "0x384", "0x39b"):
            if not self.state_can_id or aux_id != self.state_can_id.lower():
                unsub = self.coordinator.register_listener(aux_id, self._handle_can_update)
                self._aux_unsubs.append(unsub)

    async def async_will_remove_from_hass(self) -> None:
        """Unregister auxiliary telemetry listeners."""
        for unsub in self._aux_unsubs:
            unsub()
        self._aux_unsubs.clear()
        await super().async_will_remove_from_hass()

    def _is_hvac_active(self) -> bool:
        """Determine if the vehicle HVAC system or remote climate is actively running."""
        # 1. Check Blower Fan Speed from 0x31B Byte D4 low nibble
        p_31b = self.coordinator.get_can_payload("0x31b")
        if p_31b and len(p_31b) >= 4:
            fan_raw = p_31b[3] & 0x0F
            if fan_raw > 0:
                return True

        # 2. Check DATC Blower Fan Speed (0x384 / DATC_07_200ms)
        p_384 = self.coordinator.get_can_payload("0x384")
        if p_384 and len(p_384) >= 1:
            fan_raw = p_384[0] & 0x0F
            if fan_raw > 0:
                return True

        # 3. Check VCU Aircon Controller Status (0x02AD / VCU_04_100ms_3 Byte D1 bits 2-3)
        p_2ad = self.coordinator.get_can_payload("0x2ad")
        if p_2ad and len(p_2ad) >= 1:
            if ((p_2ad[0] >> 2) & 0x03) != 0:
                return True

        # 4. Check VCU High-Voltage Contactors Closed (0x02AE / VCU_04_100ms_4 Byte D5 bits 6-7)
        p_2ae = self.coordinator.get_can_payload("0x2ae")
        if p_2ae and len(p_2ae) >= 5:
            if ((p_2ae[4] >> 6) & 0x03) != 0:
                return True

        # 5. Check Remote Climate TMU active frame (0x39B / TMU_01_200ms Byte D1 bit 4)
        p_39b = self.coordinator.get_can_payload("0x39b")
        if p_39b and len(p_39b) >= 1:
            if (p_39b[0] & 0x10) != 0:
                return True

        # 6. Check Remote Climate Telematics frame (0x587)
        p_587 = self.coordinator.get_can_payload("0x587")
        if p_587 and len(p_587) >= 2:
            if (p_587[0] & 0x03) > 0 or (p_587[1] & 0x03) > 0:
                return True

        return False

    @property
    def hvac_mode(self) -> HVACMode:
        """Return current HVAC mode (reports OFF when vehicle climate is inactive)."""
        if not self._is_hvac_active():
            return HVACMode.OFF
        return self._hvac_mode if self._hvac_mode != HVACMode.OFF else HVACMode.AUTO

    @property
    def hvac_action(self) -> HVACAction | None:
        """Return the running HVAC action (heating, cooling, fan, off)."""
        if self.hvac_mode == HVACMode.OFF:
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

        return HVACAction.HEATING if self.hvac_mode == HVACMode.HEAT_COOL else HVACAction.IDLE

    @property
    def current_temperature(self) -> float | None:
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
    def target_temperature(self) -> float | None:
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
                    self._target_temp = 27.5 if raw == 0x1A else round(17.0 + (raw - 0x06) * 0.5, 1)

        return self._target_temp

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return rich climate telemetry attributes."""
        attrs: dict[str, Any] = {}

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
            attrs["heated_steering_wheel"] = ["Off", "On"][wheel_val] if wheel_val < 2 else "Unknown"

        # 4. Seat Comfort (0x496 Byte D1)
        p_496 = self.coordinator.get_can_payload("0x496")
        if p_496 and len(p_496) >= 1:
            d_raw = p_496[0]
            seat_map = {
                0x16: "Off",
                0x36: "Low Heat",
                0x4E: "Medium Heat",
                0x46: "High Heat",
                0x1E: "Low Cool",
                0x26: "Medium Cool",
                0x2E: "High Cool",
            }
            if d_raw in seat_map:
                attrs["driver_seat_comfort"] = seat_map[d_raw]


        p_475 = self.coordinator.get_can_payload("0x475")
        if p_475 and len(p_475) >= 1:
            d_raw = p_475[0]
            seat_map = {
                0x16: "Off",
                0x36: "Low Heat",
                0x4E: "Medium Heat",
                0x46: "High Heat",
                0x1E: "Low Cool",
                0x26: "Medium Cool",
                0x2E: "High Cool",
            }
            if d_raw in seat_map:
                attrs["passenger_seat_comfort"] = seat_map[d_raw]

        p_438 = self.coordinator.get_can_payload("0x438")
        if p_438 and len(p_438) >= 1:
            d_raw = p_438[0]
            seat_map = {
                0x11: "Off",
                0x31: "Low Heat",
                0x41: "High Heat",
            }
            if d_raw in seat_map:
                attrs["rear_left_seat_comfort"] = seat_map[d_raw]

        p_453 = self.coordinator.get_can_payload("0x453")
        if p_453 and len(p_453) >= 1:
            d_raw = p_453[0]
            seat_map = {
                0x11: "Off",
                0x31: "Low Heat",
                0x41: "High Heat",
            }
            if d_raw in seat_map:
                attrs["rear_right_seat_comfort"] = seat_map[d_raw]

        return attrs

    async def async_set_temperature(self, **kwargs: Any) -> None:
        """Set new target temperature on vehicle CAN bus."""
        temp = kwargs.get("temperature")
        if temp is None:
            return

        temp = max(self._attr_min_temp, min(self._attr_max_temp, float(temp)))
        self._target_temp = temp

        # Calculate Celsius target for E-GMP TMU frame
        temp_c = temp
        if self.temperature_unit == UnitOfTemperature.FAHRENHEIT:
            temp_c = round((temp - 32.0) / 1.8, 1)

        # 1. Update/trigger the background remote climate task
        if self._is_hvac_active() or self._hvac_mode != HVACMode.OFF:
            await self.coordinator.async_send_remote_climate(action="start", target_temp=temp_c)

        # 2. Also send direct touchscreen CAN action (when vehicle is awake)
        if self.temperature_unit == UnitOfTemperature.FAHRENHEIT:
            raw_val = 0x06 + round(temp - 62.0)
        else:
            raw_val = 0x1A if temp >= 27.5 else 0x06 + round((temp - 17.0) * 2.0)

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

        self._hvac_mode = HVACMode.AUTO
        self.async_write_ha_state()

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        """Set new HVAC mode."""
        self._hvac_mode = hvac_mode
        if hvac_mode == HVACMode.OFF:
            # Stop the remote climate background loop on ESP32
            await self.coordinator.async_send_remote_climate(action="stop")

            # Find option with label containing "off"
            target_opt = None
            for opt in self.command.get("options", []):
                if "off" in opt.get("label", "").lower():
                    target_opt = opt
                    break
            if target_opt:
                steps = build_action_steps(self.command, target_opt)
                if steps:
                    await self.coordinator.async_send_action(self.action_can_id, 20, steps)
        elif hvac_mode in (HVACMode.AUTO, HVACMode.HEAT_COOL):
            temp_c = self._target_temp
            if self.temperature_unit == UnitOfTemperature.FAHRENHEIT:
                temp_c = round((self._target_temp - 32.0) / 1.8, 1)
            await self.coordinator.async_send_remote_climate(action="start", target_temp=temp_c)
            await self.async_set_temperature(temperature=self._target_temp)

        self.async_write_ha_state()
