"""Constants for the CAN Do integration."""

DOMAIN = "can_do"
VERSION = "2026.9.8"

CONF_DEVICE_ID = "device_id"
CONF_VEHICLE_ID = "vehicle_id"
CONF_BASE_TOPIC = "base_topic"

DEFAULT_BASE_TOPIC = "cando"
DEFAULT_DEVICE_ID = "auto"
DEFAULT_VEHICLE_ID = "ev6_gtline"

PLATFORMS = [
    "notify",
    "switch",
    "button",
    "select",
    "sensor",
    "binary_sensor",
    "event",
    "lock",
    "climate",
    "number",
    "light",
]

ATTR_CAN_ID = "can_id"
ATTR_PAYLOAD = "payload"
ATTR_LEVEL = "level"
