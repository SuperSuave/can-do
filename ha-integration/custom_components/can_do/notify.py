"""Notify platform for CAN Do integration (Instrument Cluster Notifications)."""

import logging
from typing import Any, Dict, List, Optional

from homeassistant.components.notify import NotifyEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do notify entities from a config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]

    entities: List[NotifyEntity] = []

    # 1. Add notify entities defined in the catalog
    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "notify":
            entities.append(CanDoNotifyEntity(coordinator, cmd))

    # 2. Always ensure a default cluster notification entity exists
    if not any(isinstance(e, CanDoClusterMasterNotifyEntity) for e in entities):
        entities.append(CanDoClusterMasterNotifyEntity(coordinator))

    async_add_entities(entities)


class CanDoNotifyEntity(CanDoEntity, NotifyEntity):
    """Catalog-defined notification entity sending text to instrument cluster OSD."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: Dict[str, Any]) -> None:
        """Initialize notify entity."""
        super().__init__(coordinator, command)

    async def async_send_message(self, message: str, title: Optional[str] = None, **kwargs: Any) -> None:
        """Send a notification message to the vehicle's instrument cluster."""
        data = kwargs.get("data") or {}
        level = data.get("level", "info")

        # Allow title prefix if provided
        full_msg = f"{title}: {message}" if title else message
        _LOGGER.info(
            "Sending cluster notification '%s' (level=%s) via entity %s",
            full_msg,
            level,
            self.entity_id_str,
        )
        await self.coordinator.async_send_notification(full_msg, level=level)


class CanDoClusterMasterNotifyEntity(NotifyEntity):
    """General Instrument Cluster Notification entity."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_icon = "mdi:car-speed-limiter"

    def __init__(self, coordinator: CanDoDataCoordinator) -> None:
        """Initialize master notify entity."""
        self.coordinator = coordinator
        self._attr_name = "Instrument Cluster Notification"
        self._attr_unique_id = f"{coordinator.device_id}_cluster_notify"

    @property
    def device_info(self) -> Any:
        """Return device information."""
        from homeassistant.helpers.entity import DeviceInfo
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.device_id)},
            name=f"CAN Do ({self.coordinator.device_id})",
            manufacturer="CAN Do",
            model=self.coordinator.vehicle_id,
            sw_version="1.0.0",
        )

    @property
    def available(self) -> bool:
        """Return True if device is online."""
        return self.coordinator.available

    async def async_send_message(self, message: str, title: Optional[str] = None, **kwargs: Any) -> None:
        """Send a notification message to the vehicle's instrument cluster."""
        data = kwargs.get("data") or {}
        level = data.get("level", "info")

        full_msg = f"{title}: {message}" if title else message
        _LOGGER.info("Cluster Master Notify: %s (level=%s)", full_msg, level)
        await self.coordinator.async_send_notification(full_msg, level=level)
