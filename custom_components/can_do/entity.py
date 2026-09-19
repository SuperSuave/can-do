"""Base entity class for CAN Do integration."""

from typing import Any, Callable, Dict, Optional

from homeassistant.helpers.entity import DeviceInfo, Entity

from .const import DOMAIN
from .coordinator import CanDoDataCoordinator


class CanDoEntity(Entity):
    """Base entity for CAN Do integration."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize base CAN Do entity."""
        self.coordinator = coordinator
        self.command = command
        self.entity_id_str: str = command["id"]

        meta = command.get("ha_metadata", {})
        self._attr_name = meta.get("name", self.entity_id_str)
        self._attr_icon = meta.get("icon")
        self._attr_unique_id = f"{coordinator.device_id}_{self.entity_id_str}"

        net = command.get("network", {})
        self.state_can_id: Optional[str] = net.get("state_can_id")
        self._unsub_listener: Optional[Callable[[], None]] = None

    @property
    def device_info(self) -> DeviceInfo:
        """Return device information to group all entities together."""
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.device_id)},
            name=f"CAN Do ({self.coordinator.device_id})",
            manufacturer="CAN Do",
            model=self.coordinator.vehicle_id,
            sw_version="1.0.0",
        )

    @property
    def available(self) -> bool:
        """Return True if the ESP32 edge device is online."""
        return self.coordinator.available

    async def async_added_to_hass(self) -> None:
        """Register CAN state listener when entity is added to Home Assistant."""
        await super().async_added_to_hass()
        if self.state_can_id:
            self._unsub_listener = self.coordinator.register_listener(
                self.state_can_id, self._handle_can_update
            )
            # Perform initial update from cache
            self._handle_can_update()

    async def async_will_remove_from_hass(self) -> None:
        """Unregister CAN state listener when entity is removed."""
        if self._unsub_listener:
            self._unsub_listener()
            self._unsub_listener = None
        await super().async_will_remove_from_hass()

    def _handle_can_update(self) -> None:
        """Handle updated CAN state from coordinator."""
        self.async_write_ha_state()
