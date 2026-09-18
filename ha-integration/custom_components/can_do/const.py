"""Constants for the CAN Do integration."""

DOMAIN = "can_do"

CONF_DEVICE_ID = "device_id"
CONF_VEHICLE_ID = "vehicle_id"
CONF_BASE_TOPIC = "base_topic"

DEFAULT_BASE_TOPIC = "cando"
DEFAULT_DEVICE_ID = "can-do-c2f4"
DEFAULT_VEHICLE_ID = "hi5_limited"

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
