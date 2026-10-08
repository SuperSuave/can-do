"""Cover platform for CAN Do integration."""

import logging
from typing import Any

from homeassistant.components.cover import (
    CoverDeviceClass,
    CoverEntity,
    CoverEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .can_utils import build_action_steps
from .catalog_loader import check_match
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do cover entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[CoverEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "cover":
            entities.append(CanDoCoverEntity(coordinator, cmd))

    async_add_entities(entities)


class CanDoCoverEntity(CanDoEntity, CoverEntity):
    """Cover entity representing power tailgate / trunk."""

    _attr_device_class = CoverDeviceClass.DOOR
    _attr_supported_features = (
        CoverEntityFeature.OPEN | CoverEntityFeature.CLOSE
    )

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
        """Initialize cover entity."""
        super().__init__(coordinator, command)

    @property
    def is_closed(self) -> bool | None:
        """Return True if the cover is closed."""
        if not self.state_can_id:
            return None

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return None

        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            match_spec = opt.get("match") or opt.get("payload")
            if not match_spec:
                continue

            if "closed" in label and check_match(payload, match_spec, opt.get("mask")):
                return True
            elif ("open" in label or "opening" in label) and check_match(payload, match_spec, opt.get("mask")):
                return False

        return None

    @property
    def is_opening(self) -> bool | None:
        """Return True if cover is opening."""
        if not self.state_can_id:
            return None
        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return None
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if "opening" in label:
                match_spec = opt.get("match") or opt.get("payload")
                if match_spec and check_match(payload, match_spec, opt.get("mask")):
                    return True
        return False

    @property
    def is_closing(self) -> bool | None:
        """Return True if cover is closing."""
        if not self.state_can_id:
            return None
        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return None
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if "closing" in label:
                match_spec = opt.get("match") or opt.get("payload")
                if match_spec and check_match(payload, match_spec, opt.get("mask")):
                    return True
        return False

    async def async_open_cover(self, **kwargs: Any) -> None:
        """Open the tailgate / cover."""
        target_opt = None
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if "open" in label and "opening" not in label and opt.get("payload"):
                target_opt = opt
                break
            elif "open" in label and opt.get("payload"):
                target_opt = opt

        if not target_opt:
            _LOGGER.warning("No open action payload found for %s", self.entity_id)
            return

        steps = build_action_steps(
            self.action_can_id or self.state_can_id,
            target_opt.get("payload", {}),
            target_opt.get("mask"),
            self.command.get("network", {}).get("bus", 0),
        )
        for can_id, payload in steps:
            await self.coordinator.async_send_can_command(can_id, payload)

    async def async_close_cover(self, **kwargs: Any) -> None:
        """Close the tailgate / cover."""
        target_opt = None
        for opt in self.command.get("options", []):
            label = opt.get("label", "").lower()
            if "close" in label and "closing" not in label and opt.get("payload"):
                target_opt = opt
                break
            elif "close" in label and opt.get("payload"):
                target_opt = opt

        if not target_opt:
            _LOGGER.warning("No close action payload found for %s", self.entity_id)
            return

        steps = build_action_steps(
            self.action_can_id or self.state_can_id,
            target_opt.get("payload", {}),
            target_opt.get("mask"),
            self.command.get("network", {}).get("bus", 0),
        )
        for can_id, payload in steps:
            await self.coordinator.async_send_can_command(can_id, payload)
