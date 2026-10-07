"""CAN Do Home Assistant Integration.

Bi-directional vehicle CAN bridge and automation hub running purely over MQTT.
"""

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .catalog_loader import load_catalog
from .const import DOMAIN, PLATFORMS, VERSION
from .coordinator import CanDoDataCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Set up the CAN Do component."""
    hass.data.setdefault(DOMAIN, {})
    await hass.async_add_executor_job(load_catalog)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up CAN Do from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    await hass.async_add_executor_job(load_catalog)

    coordinator = CanDoDataCoordinator(hass, entry.data)
    await coordinator.async_start()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    # Register the parent ESP32 Bridge device in the HA device registry
    from homeassistant.helpers import device_registry as dr
    dev_reg = dr.async_get(hass)
    dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, coordinator.device_id)},
        name=f"CAN Do Bridge ({coordinator.device_id})",
        manufacturer="CAN Do",
        model="ESP32 Bridge",
        sw_version=VERSION,
    )

    # Register HUD navigation services
    async def async_handle_set_hud_nav(call: Any) -> None:
        """Handle can_do.set_hud_nav service call."""
        icon = call.data.get("icon", 1)
        distance = call.data.get("distance", 0)
        bars = call.data.get("bars", 0)
        street = call.data.get("street")
        speed_limit = call.data.get("speed_limit", 0)
        camera_alert = call.data.get("camera_alert", False)
        for coord in hass.data[DOMAIN].values():
            if isinstance(coord, CanDoDataCoordinator):
                await coord.async_send_hud_nav(
                    icon=icon,
                    distance_meters=distance,
                    bars=bars,
                    street=street,
                    speed_limit_kph=speed_limit,
                    camera_alert=camera_alert,
                )

    async def async_handle_clear_hud_nav(call: Any) -> None:
        """Handle can_do.clear_hud_nav service call."""
        for coord in hass.data[DOMAIN].values():
            if isinstance(coord, CanDoDataCoordinator):
                await coord.async_clear_hud_nav()

    hass.services.async_register(DOMAIN, "set_hud_nav", async_handle_set_hud_nav)
    hass.services.async_register(DOMAIN, "clear_hud_nav", async_handle_clear_hud_nav)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        coordinator: CanDoDataCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_stop()

    return unload_ok
