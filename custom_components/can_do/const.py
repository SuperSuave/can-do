"""Constants for the CAN Do integration."""

DOMAIN = "can_do"
VERSION = "2026.11.6-b002"

CONF_DEVICE_ID = "device_id"
CONF_VEHICLE_ID = "vehicle_id"
CONF_BASE_TOPIC = "base_topic"
CONF_FILTER_ACTIVE_IDS = "filter_active_ids"
CONF_ENABLED_CATEGORIES = "enabled_categories"

DEFAULT_BASE_TOPIC = "cando"
DEFAULT_DEVICE_ID = "auto"
DEFAULT_VEHICLE_ID = "ev6_gtline"
DEFAULT_FILTER_ACTIVE_IDS = False

CATEGORY_DOORS = "Doors, Access & Security"
CATEGORY_POWERTRAIN = "Powertrain & Performance"
CATEGORY_HIGH_VOLTAGE = "High Voltage & Charging"
CATEGORY_CLIMATE = "Climate & Comfort"
CATEGORY_COCKPIT = "Cockpit & Controls"
CATEGORY_TELEMATICS = "Vehicle State & Telematics"

ALL_CATEGORIES = [
    CATEGORY_DOORS,
    CATEGORY_POWERTRAIN,
    CATEGORY_HIGH_VOLTAGE,
    CATEGORY_CLIMATE,
    CATEGORY_COCKPIT,
    CATEGORY_TELEMATICS,
]

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
    "cover",
]

ATTR_CAN_ID = "can_id"
ATTR_PAYLOAD = "payload"
ATTR_LEVEL = "level"
