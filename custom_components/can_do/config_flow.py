"""Config flow for CAN Do integration."""

import logging
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import config_validation as cv, selector
from homeassistant.helpers.service_info.mqtt import MqttServiceInfo
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

try:
    from homeassistant.config_entries import ConfigFlowResult
except ImportError:
    from homeassistant.data_entry_flow import FlowResult as ConfigFlowResult  # type: ignore[no-redef]

from .catalog_loader import async_get_vehicles
from .const import (
    ALL_CATEGORIES,
    CONF_BASE_TOPIC,
    CONF_DEVICE_ID,
    CONF_ENABLED_CATEGORIES,
    CONF_FILTER_ACTIVE_IDS,
    CONF_VEHICLE_ID,
    DEFAULT_BASE_TOPIC,
    DEFAULT_DEVICE_ID,
    DEFAULT_FILTER_ACTIVE_IDS,
    DEFAULT_VEHICLE_ID,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


class CanDoConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for CAN Do."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialize the config flow."""
        self._discovered_device: dict[str, str] = {}

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial setup step."""
        errors: dict[str, str] = {}

        vehicles = await async_get_vehicles(self.hass)
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

    async def async_step_mqtt(
        self, discovery_info: MqttServiceInfo
    ) -> ConfigFlowResult:
        """Handle MQTT discovery (e.g. cando/+/status)."""
        # Expected topic format: <base_topic>/<device_id>/status
        topic_parts = discovery_info.topic.strip("/").split("/")
        if len(topic_parts) < 3 or topic_parts[-1] != "status":
            return self.async_abort(reason="invalid_discovery_info")

        base_topic = topic_parts[0]
        device_id = topic_parts[1]

        await self.async_set_unique_id(device_id)
        self._abort_if_unique_id_configured()

        self._discovered_device = {
            CONF_DEVICE_ID: device_id,
            CONF_BASE_TOPIC: base_topic,
        }
        self.context["title_placeholders"] = {"device_id": device_id}
        return await self.async_step_discovery_confirm()

    async def async_step_zeroconf(
        self, discovery_info: ZeroconfServiceInfo
    ) -> ConfigFlowResult:
        """Handle Zeroconf / mDNS discovery."""
        hostname = getattr(discovery_info, "hostname", "") or ""
        device_id = hostname.rstrip(".").removesuffix(".local")
        if not device_id:
            name = getattr(discovery_info, "name", "")
            device_id = name.split(".")[0] if name else DEFAULT_DEVICE_ID

        await self.async_set_unique_id(device_id)
        self._abort_if_unique_id_configured()

        self._discovered_device = {
            CONF_DEVICE_ID: device_id,
            CONF_BASE_TOPIC: DEFAULT_BASE_TOPIC,
        }
        self.context["title_placeholders"] = {"device_id": device_id}
        return await self.async_step_discovery_confirm()

    async def async_step_discovery_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm discovery and select vehicle profile."""
        errors: dict[str, str] = {}
        device_id = self._discovered_device.get(CONF_DEVICE_ID, DEFAULT_DEVICE_ID)
        base_topic = self._discovered_device.get(CONF_BASE_TOPIC, DEFAULT_BASE_TOPIC)

        vehicles = await async_get_vehicles(self.hass)
        vehicle_map = {vid: label for vid, label in vehicles}
        if DEFAULT_VEHICLE_ID not in vehicle_map and vehicles:
            default_vid = vehicles[0][0]
        else:
            default_vid = DEFAULT_VEHICLE_ID

        if user_input is not None:
            entry_data = {
                CONF_DEVICE_ID: device_id,
                CONF_BASE_TOPIC: user_input.get(CONF_BASE_TOPIC, base_topic).strip(),
                CONF_VEHICLE_ID: user_input[CONF_VEHICLE_ID],
            }
            title = f"CAN Do ({device_id})"
            return self.async_create_entry(title=title, data=entry_data)

        schema = vol.Schema(
            {
                vol.Required(CONF_VEHICLE_ID, default=default_vid): vol.In(vehicle_map),
                vol.Optional(CONF_BASE_TOPIC, default=base_topic): str,
            }
        )

        return self.async_show_form(
            step_id="discovery_confirm",
            data_schema=schema,
            description_placeholders={"device_id": device_id},
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry) -> config_entries.OptionsFlow:
        """Get the options flow for this handler."""
        return CanDoOptionsFlow()


class CanDoOptionsFlow(config_entries.OptionsFlow):
    """Handle CAN Do options."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage the options."""
        vehicles = await async_get_vehicles(self.hass)
        vehicle_map = {vid: label for vid, label in vehicles}

        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current_vehicle = self.config_entry.options.get(
            CONF_VEHICLE_ID,
            self.config_entry.data.get(CONF_VEHICLE_ID, DEFAULT_VEHICLE_ID),
        )
        current_base = self.config_entry.options.get(
            CONF_BASE_TOPIC,
            self.config_entry.data.get(CONF_BASE_TOPIC, DEFAULT_BASE_TOPIC),
        )
        current_filter_active = self.config_entry.options.get(
            CONF_FILTER_ACTIVE_IDS,
            self.config_entry.data.get(CONF_FILTER_ACTIVE_IDS, DEFAULT_FILTER_ACTIVE_IDS),
        )
        current_categories = self.config_entry.options.get(
            CONF_ENABLED_CATEGORIES,
            ALL_CATEGORIES,
        )

        vehicle_options = [
            {"value": vid, "label": label}
            for vid, label in vehicle_map.items()
        ]
        category_options = [
            {"value": cat, "label": cat}
            for cat in ALL_CATEGORIES
        ]

        schema = vol.Schema(
            {
                vol.Required(CONF_VEHICLE_ID, default=current_vehicle): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=vehicle_options,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Required(CONF_FILTER_ACTIVE_IDS, default=current_filter_active): selector.BooleanSelector(),
                vol.Optional(CONF_ENABLED_CATEGORIES, default=current_categories): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=category_options,
                        multiple=True,
                        mode=selector.SelectSelectorMode.LIST,
                    )
                ),
                vol.Optional(CONF_BASE_TOPIC, default=current_base): selector.TextSelector(),
            }
        )

        return self.async_show_form(step_id="init", data_schema=schema)
