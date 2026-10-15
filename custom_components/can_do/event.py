"""Event platform for CAN Do integration (Steering wheel & console button events)."""

import logging
from typing import Any

from homeassistant.components.event import EventEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .catalog_loader import check_match
from .const import DOMAIN
from .coordinator import CanDoDataCoordinator
from .entity import CanDoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up CAN Do event entities from config entry."""
    coordinator: CanDoDataCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[EventEntity] = []

    for cmd in coordinator.commands:
        if cmd.get("ha_metadata", {}).get("domain") == "event":
            entities.append(CanDoEventEntity(coordinator, cmd))

    # Add BLE remote button & combo chord event entity
    entities.append(CanDoBleButtonEventEntity(coordinator))

    async_add_entities(entities)


class CanDoBleButtonEventEntity(EventEntity):
    """Event entity for BLE remote button presses and multi-button combo chords."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "Bluetooth Remote Button / Combo"
    _attr_icon = "mdi:remote"
    _attr_event_types = ["press", "release", "hold", "combo"]

    def __init__(self, coordinator: CanDoDataCoordinator) -> None:
        """Initialize BLE button event entity."""
        self.coordinator = coordinator
        self._attr_unique_id = f"{coordinator.device_id}_ble_button_event"
        self._unsub = None

    @property
    def available(self) -> bool:
        """Return True so entity stays active."""
        return True

    @property
    def device_info(self):
        """Link to parent CAN Do Bridge device."""
        from homeassistant.helpers.entity import DeviceInfo
        from .const import VERSION
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.device_id)},
            name=f"CAN Do Bridge ({self.coordinator.device_id})",
            manufacturer="CAN Do",
            model="ESP32 Bridge",
            sw_version=VERSION,
        )

    async def async_added_to_hass(self) -> None:
        """Register listener when added to hass."""
        await super().async_added_to_hass()
        self._unsub = self.coordinator.register_ble_button_listener(self._handle_ble_button)

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe listener on remove."""
        if self._unsub:
            self._unsub()
        await super().async_will_remove_from_hass()

    def _handle_ble_button(self) -> None:
        """Fire event when coordinator receives a BLE button or combo chord."""
        last = self.coordinator.last_ble_button
        if not last:
            return
        action = str(last.get("action", "press")).lower()
        combo = str(last.get("combo", ""))
        event_type = "combo" if ("+" in combo or "combo" in action) else (action if action in self._attr_event_types else "press")
        self._trigger_event(
            event_type,
            {
                "button": last.get("button", ""),
                "combo": combo,
                "address": last.get("address", ""),
                "action": action,
            },
        )
        self.async_write_ha_state()



class CanDoEventEntity(CanDoEntity, EventEntity):
    """Event entity representing steering wheel and physical button press events."""

    _attr_event_types = ["press"]

    def __init__(self, coordinator: CanDoDataCoordinator, command: dict[str, Any]) -> None:
        """Initialize event entity."""
        super().__init__(coordinator, command)
        self._last_matched: bool = False

    def _handle_can_update(self) -> None:
        """Evaluate if incoming CAN frame triggers the event."""
        if not self.state_can_id:
            return

        payload = self.coordinator.get_can_payload(self.state_can_id)
        if not payload:
            return

        is_now_match = False
        if "match" in self.command:
            is_now_match = check_match(payload, self.command["match"], self.command.get("mask"))
        elif self.command.get("options"):
            first_opt = self.command["options"][0]
            match_spec = first_opt.get("match") or first_opt.get("payload")
            if match_spec:
                is_now_match = check_match(payload, match_spec, first_opt.get("mask"))

        # Fire event on rising edge transition (unmatched -> matched)
        if is_now_match and not self._last_matched:
            _LOGGER.debug("Button event fired for '%s'", self.name)
            self._trigger_event("press")
            self.async_write_ha_state()

        self._last_matched = is_now_match
