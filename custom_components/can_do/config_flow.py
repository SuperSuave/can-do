"""Config flow for CAN Do integration."""

import logging
from typing import Any, Dict, Optional

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult

from .catalog_loader import get_vehicles
from .const import (
    CONF_BASE_TOPIC,
    CONF_DEVICE_ID,
    CONF_VEHICLE_ID,
    DEFAULT_BASE_TOPIC,
    DEFAULT_DEVICE_ID,
    DEFAULT_VEHICLE_ID,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


class CanDoConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for CAN Do."""

    VERSION = 1

    async def async_step_user(
        self, user_input: Optional[Dict[str, Any]] = None
    ) -> FlowResult:
        """Handle the initial setup step."""
        errors: Dict[str, str] = {}

        vehicles = get_vehicles()
        vehicle_map = {vid: label for vid, label in vehicles}
        if DEFAULT_VEHICLE_ID not in vehicle_map and vehicles:
            default_vid = vehicles[0][0]
        else:
            default_vid = DEFAULT_VEHICLE_ID

        if user_input is not None:
            device_id = user_input[CONF_DEVICE_ID].strip()
            await self.async_set_unique_id(device_id)
            self._abort_if_unique_id_configured()

            title = f"CAN Do ({device_id})"
            return self.async_create_entry(title=title, data=user_input)

        schema = vol.Schema(
            {
                vol.Required(CONF_DEVICE_ID, default=DEFAULT_DEVICE_ID): str,
                vol.Required(CONF_VEHICLE_ID, default=default_vid): vol.In(vehicle_map),
                vol.Optional(CONF_BASE_TOPIC, default=DEFAULT_BASE_TOPIC): str,
            }
        )

        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry) -> config_entries.OptionsFlow:
        """Get the options flow for this handler."""
        return CanDoOptionsFlow(config_entry)


class CanDoOptionsFlow(config_entries.OptionsFlow):
    """Handle CAN Do options."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """Initialize options flow."""
        self.config_entry = config_entry

    async def async_step_init(
        self, user_input: Optional[Dict[str, Any]] = None
    ) -> FlowResult:
        """Manage the options."""
        vehicles = get_vehicles()
        vehicle_map = {vid: label for vid, label in vehicles}

        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current_vehicle = self.config_entry.data.get(CONF_VEHICLE_ID, DEFAULT_VEHICLE_ID)
        current_base = self.config_entry.data.get(CONF_BASE_TOPIC, DEFAULT_BASE_TOPIC)

        schema = vol.Schema(
            {
                vol.Required(CONF_VEHICLE_ID, default=current_vehicle): vol.In(vehicle_map),
                vol.Optional(CONF_BASE_TOPIC, default=current_base): str,
            }
        )

        return self.async_show_form(step_id="init", data_schema=schema)
