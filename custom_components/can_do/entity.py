import re
from typing import Any, Callable, Dict, Optional

from homeassistant.helpers.entity import DeviceInfo, Entity

from .catalog_loader import get_vehicle_definition
from .const import DOMAIN, VERSION
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
        self._unsub_listeners: list[Callable[[], None]] = []
        self._last_state_snapshot: Any = object()
        self._last_available: Optional[bool] = None

    @property
    def device_info(self) -> DeviceInfo:
        """Return device information to group entities by subsystem child devices."""
        parent_id = self.coordinator.device_id
        category = self.command.get("category", "")

        # If entity belongs to Bridge/Gateway or has no category, attach to parent Bridge device
        if not category or category in ("Bridge & Automations", "Bridge", "Gateway"):
            return DeviceInfo(
                identifiers={(DOMAIN, parent_id)},
                name=f"CAN Do Bridge ({parent_id})",
                manufacturer="CAN Do",
                model="ESP32 Bridge",
                sw_version=VERSION,
            )

        # Vehicle Subsystem Child Device
        v_def = get_vehicle_definition(self.coordinator.vehicle_id)
        if v_def:
            make = v_def.get("make", "")
            model = v_def.get("model", "")
            vehicle_name = f"{make} {model}".strip() or self.coordinator.vehicle_id.upper()
        else:
            vehicle_name = self.coordinator.vehicle_id.upper()

        cat_slug = re.sub(
            r"[^a-z0-9_]+", "", category.lower().replace("&", "and").replace(",", "").replace(" ", "_")
        ).strip("_")

        return DeviceInfo(
            identifiers={(DOMAIN, f"{parent_id}_{cat_slug}")},
            name=f"{vehicle_name} {category}",
            manufacturer="CAN Do",
            model=self.coordinator.vehicle_id,
            sw_version=VERSION,
            via_device=(DOMAIN, parent_id),
        )

    @property
    def available(self) -> bool:
        """Return True if the ESP32 edge device is online."""
        return self.coordinator.available

    async def async_added_to_hass(self) -> None:
        """Register CAN state listener when entity is added to Home Assistant."""
        await super().async_added_to_hass()
        listen_ids = set()
        if self.state_can_id:
            listen_ids.add(self.state_can_id.lower())
        listen_ids.add(self.entity_id_str.lower())

        cid = self.entity_id_str.lower()
        if "12v" in cid or "aux" in cid:
            listen_ids.update(["vbat", "cond_aux_12v_battery", "0x1cf"])

        if "bms" in cid:
            bms_alias_map = {
                "bms_display_soc": ["bms_soc", "0x7ec"],
                "bms_soc": ["bms_display_soc", "0x7ec"],
                "bms_hv_voltage": ["bms_hv_v", "0x7ec"],
                "bms_hv_v": ["bms_hv_voltage", "0x7ec"],
                "bms_hv_current": ["bms_hv_a", "0x7ec"],
                "bms_hv_a": ["bms_hv_current", "0x7ec"],
                "bms_hv_power_kw": ["bms_hv_kw", "0x7ec"],
                "bms_hv_kw": ["bms_hv_power_kw", "0x7ec"],
                "bms_cell_delta_mv": ["0x7ec"],
            }
            if cid in bms_alias_map:
                listen_ids.update(bms_alias_map[cid])

        for target_id in listen_ids:
            unsub = self.coordinator.register_listener(target_id, self._handle_can_update)
            self._unsub_listeners.append(unsub)

        # Perform initial update from cache
        self._handle_can_update()

    async def async_will_remove_from_hass(self) -> None:
        """Unregister CAN state listener when entity is removed."""
        for unsub in self._unsub_listeners:
            unsub()
        self._unsub_listeners.clear()
        await super().async_will_remove_from_hass()

    def _handle_can_update(self) -> None:
        """Handle updated CAN state from coordinator with intelligent change gating."""
        current_state = self._get_state_snapshot()
        current_avail = self.available

        # Only notify Home Assistant if the actual computed state or availability changed
        if current_avail != self._last_available or current_state != self._last_state_snapshot:
            self._last_available = current_avail
            self._last_state_snapshot = current_state
            self.async_write_ha_state()

    def _get_state_snapshot(self) -> Any:
        """Capture the current state of this entity to detect real changes."""
        # 1. Binary sensor
        if hasattr(self, "is_on"):
            try:
                return self.is_on
            except Exception:
                pass
        # 2. Numeric / text sensor
        if hasattr(self, "native_value"):
            try:
                return self.native_value
            except Exception:
                pass
        # 3. Climate entity
        if hasattr(self, "target_temperature"):
            try:
                return (
                    getattr(self, "target_temperature", None),
                    getattr(self, "current_temperature", None),
                    getattr(self, "hvac_action", None),
                    getattr(self, "hvac_mode", None),
                )
            except Exception:
                pass
        # 4. Switch entity
        if hasattr(self, "_is_on"):
            return getattr(self, "_is_on", None)
        return None
