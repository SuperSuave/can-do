"""Notify platform for CAN Do integration (Instrument Cluster Notifications)."""

import logging
from typing import Any

from homeassistant.components.notify import NotifyEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .catalog_loader import get_vehicle_definition
from .const import DOMAIN, VERSION
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


def _is_text_notify_command(cmd: dict[str, Any]) -> bool:
    """Return True only for catalog notify commands backed by the track_popup text transport."""
    if (cmd.get("ha_metadata") or {}).get("domain") != "notify":
        return False
    net_type = (cmd.get("network") or {}).get("type")
    return cmd.get("type") == "track_popup" or net_type == "track_popup"


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do notify entities from a config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]

    entities: list[NotifyEntity] = []

    # 1. Add notify entities defined in the catalog
    for cmd in coordinator.commands:
        if _is_text_notify_command(cmd):
            entities.append(CanDoNotifyEntity(coordinator, cmd))

    # 2. Always ensure the master cluster notification entity exists
    if not any(isinstance(e, CanDoClusterMasterNotifyEntity) for e in entities):
        entities.append(CanDoClusterMasterNotifyEntity(coordinator))

    async_add_entities(entities)


class CanDoNotifyEntity(CanDoEntity, NotifyEntity):
    """Catalog-defined notification entity sending text to instrument cluster OSD."""

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
        """Initialize notify entity."""
        super().__init__(coordinator, command)

    async def async_send_message(self, message: str, title: str | None = None, **kwargs: Any) -> None:
        """Send a notification message to the vehicle's instrument cluster."""
        data = kwargs.get("data") or {}
        level = data.get("level", "info")
        hold_ms = data.get("hold_ms")

        full_msg = f"{title}: {message}" if title else message
        _LOGGER.info(
            "Sending cluster notification '%s' (level=%s) via entity %s",
            full_msg,
            level,
            self.entity_id_str,
        )
        await self.coordinator.async_send_notification(full_msg, level=level, hold_ms=hold_ms)


class CanDoClusterMasterNotifyEntity(NotifyEntity):
    """General Instrument Cluster Notification entity mapped to notify.can_do."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_icon = "mdi:car-speed-limiter"

    def __init__(self, coordinator: CanDoDataCoordinator) -> None:
        """Initialize master notify entity."""
        self.coordinator = coordinator
        self._attr_name = "Cluster Notification"
        self._attr_unique_id = f"{coordinator.device_id}_cluster_notify"

    @property
    def device_info(self) -> Any:
        """Return device information."""
        parent_id = self.coordinator.effective_device_id
        v_def = get_vehicle_definition(self.coordinator.vehicle_id)
        if v_def:
            make = v_def.get("make", "")
            model = v_def.get("model", "")
            v_name = f"{make} {model}".strip() or self.coordinator.vehicle_id.upper()
        else:
            v_name = self.coordinator.vehicle_id.upper()

        return DeviceInfo(
            identifiers={(DOMAIN, parent_id)},
            name=f"CAN Do {v_name} ({parent_id})",
            manufacturer="CAN Do",
            model=self.coordinator.vehicle_id,
            sw_version=VERSION,
        )

    async def async_send_message(self, message: str, title: str | None = None, **kwargs: Any) -> None:
        """Send a notification message to the vehicle's instrument cluster."""
        data = kwargs.get("data") or {}
        level = data.get("level", "info")
        hold_ms = data.get("hold_ms")

        full_msg = f"{title}: {message}" if title else message
        _LOGGER.info("Cluster Master Notify: %s (level=%s)", full_msg, level)
        await self.coordinator.async_send_notification(full_msg, level=level, hold_ms=hold_ms)
