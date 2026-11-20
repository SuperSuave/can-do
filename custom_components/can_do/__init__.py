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

_SERVICES = (
    "set_hud_nav",
    "clear_hud_nav",
    "set_audio_dsp",
    "start_remote_climate",
    "stop_remote_climate",
    "notify",
)


def _get_target_coordinators(hass: HomeAssistant, call: Any) -> list[CanDoDataCoordinator]:
    """Return coordinators matching optional device_id, or all coordinators."""
    coordinators = [
        (entry_id, coord)
        for entry_id, coord in hass.data.get(DOMAIN, {}).items()
        if isinstance(coord, CanDoDataCoordinator)
    ]
    raw_target = call.data.get("device_id")
    if not raw_target and isinstance(call.data.get("data"), dict):
        raw_target = call.data["data"].get("device_id")
    if raw_target is None or str(raw_target).strip() == "":
        return [coord for _, coord in coordinators]

    target = str(raw_target).strip()
    return [
        coord
        for entry_id, coord in coordinators
        if target in (coord.active_device_id, coord.device_id, coord.effective_device_id, entry_id)
    ]


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Set up the CAN Do component."""
    hass.data.setdefault(DOMAIN, {})
    await hass.async_add_executor_job(load_catalog)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up CAN Do from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    await hass.async_add_executor_job(load_catalog)

    entry_data = {**entry.data, **entry.options}
    coordinator = CanDoDataCoordinator(hass, entry_data)
    await coordinator.async_start()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    # Register the main CAN Do device in the HA device registry
    from homeassistant.helpers import device_registry as dr
    dev_reg = dr.async_get(hass)
    dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, coordinator.effective_device_id)},
        name=f"CAN Do Bridge ({coordinator.effective_device_id})",
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
        direction = call.data.get("direction")
        lanes = call.data.get("lanes")
        lane_directions = call.data.get("lane_directions")
        lane_recommended = call.data.get("lane_recommended")
        platform = call.data.get("platform")
        for coord in _get_target_coordinators(hass, call):
            await coord.async_send_hud_nav(
                icon=icon,
                distance_meters=distance,
                bars=bars,
                street=street,
                speed_limit_kph=speed_limit,
                camera_alert=camera_alert,
                direction=direction,
                lanes=lanes,
                lane_directions=lane_directions,
                lane_recommended=lane_recommended,
                platform=platform,
            )

    async def async_handle_clear_hud_nav(call: Any) -> None:
        """Handle can_do.clear_hud_nav service call."""
        for coord in _get_target_coordinators(hass, call):
            await coord.async_clear_hud_nav()

    async def async_handle_set_audio_dsp(call: Any) -> None:
        """Handle can_do.set_audio_dsp service call."""
        data = call.data
        for coord in _get_target_coordinators(hass, call):
            await coord.async_send_audio_dsp(
                volume=data.get("volume"),
                fader=data.get("fader"),
                balance=data.get("balance"),
                bass=data.get("bass"),
                midrange=data.get("midrange"),
                treble=data.get("treble"),
                quiet_mode=data.get("quiet_mode"),
                kids_mode=data.get("kids_mode"),
                master_mute=data.get("master_mute"),
                surround=data.get("surround"),
                sdvc=data.get("sdvc"),
                can_id=data.get("can_id"),
            )

    hass.services.async_register(DOMAIN, "set_hud_nav", async_handle_set_hud_nav)
    hass.services.async_register(DOMAIN, "clear_hud_nav", async_handle_clear_hud_nav)
    hass.services.async_register(DOMAIN, "set_audio_dsp", async_handle_set_audio_dsp)

    # Register Remote Climate & Notification services
    async def async_handle_start_remote_climate(call: Any) -> None:
        """Handle can_do.start_remote_climate service call."""
        data = call.data
        temp = data.get("temperature", 22.0)
        defrost = data.get("defrost", False)
        duration_min = data.get("duration_minutes", 15)
        duration_sec = int(duration_min * 60)
        for coord in _get_target_coordinators(hass, call):
            await coord.async_send_remote_climate(
                action="start",
                target_temp=float(temp),
                defrost=bool(defrost),
                duration_sec=duration_sec,
            )

    async def async_handle_stop_remote_climate(call: Any) -> None:
        """Handle can_do.stop_remote_climate service call."""
        for coord in _get_target_coordinators(hass, call):
            await coord.async_send_remote_climate(action="stop")

    async def async_handle_notify(call: Any) -> None:
        """Handle can_do.notify service call."""
        message = call.data.get("message", "")
        title = call.data.get("title")
        data = call.data.get("data") or {}
        level = data.get("level", call.data.get("level", "info"))
        hold_ms = data.get("hold_ms", call.data.get("hold_ms"))
        full_msg = f"{title}: {message}" if title else message
        _LOGGER.info("Cluster notify service called: '%s' (level=%s)", full_msg, level)
        for coord in _get_target_coordinators(hass, call):
            await coord.async_send_notification(full_msg, level=level, hold_ms=hold_ms)

    hass.services.async_register(DOMAIN, "start_remote_climate", async_handle_start_remote_climate)
    hass.services.async_register(DOMAIN, "stop_remote_climate", async_handle_stop_remote_climate)
    hass.services.async_register(DOMAIN, "notify", async_handle_notify)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    return True


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload entry when options are updated."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        coordinator: CanDoDataCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_stop()
        if not hass.data[DOMAIN]:
            for service_name in _SERVICES:
                hass.services.async_remove(DOMAIN, service_name)

    return unload_ok
