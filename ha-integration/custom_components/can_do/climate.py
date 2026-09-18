"""Climate platform for CAN Do integration (Cabin Target Temperatures)."""

import logging
from typing import Any, Dict, List, Optional

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
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
            entities.append(CanDoClimateEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoClimateEntity(CanDoEntity, ClimateEntity):
    """Climate entity controlling vehicle cabin set temperatures."""

    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_supported_features = ClimateEntityFeature.TARGET_TEMPERATURE
    _attr_hvac_modes = [HVACMode.AUTO, HVACMode.HEAT_COOL, HVACMode.OFF]
    _attr_min_temp = 17.0
    _attr_max_temp = 27.5
    _attr_target_temperature_step = 0.5

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize climate entity."""
        super().__init__(coordinator, command)
        self._target_temp: float = 21.0
        self._hvac_mode: HVACMode = HVACMode.AUTO

        net = command.get("network", {})
        self.action_can_id = net.get("action_can_id", "0x4A0")
        self.action_byte = net.get("action_byte", "D2")
        self.state_byte = net.get("state_byte", "D2")

    @property
    def hvac_mode(self) -> HVACMode:
        """Return current HVAC mode."""
        return self._hvac_mode

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
                self._target_temp = 17.0 + (raw - 0x06) * 0.5

        return self._target_temp

    async def async_set_temperature(self, **kwargs: Any) -> None:
        """Set new target temperature on vehicle CAN bus."""
        temp = kwargs.get("temperature")
        if temp is None:
            return

        temp = max(self._attr_min_temp, min(self._attr_max_temp, float(temp)))
        raw_val = 0x06 + int(round((temp - 17.0) * 2.0))
        raw_val = max(0x06, min(0x1A, raw_val))

        idx = get_d_index(self.action_byte)
        data = [0] * 8
        if 0 <= idx < 8:
            data[idx] = raw_val

        hex_payload = "".join(f"{b:02X}" for b in data)
        steps = [{"payload": hex_payload, "repeat": 2, "delay_ms": 20}]

        _LOGGER.info(
            "Setting %s target temp to %.1f C (raw 0x%02X on %s)",
            self.name,
            temp,
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
