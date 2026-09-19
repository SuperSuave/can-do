idf_component_register(
    SRCS 
        "main.cpp"
        "parser.cpp"
        "can_engine.cpp"
        "api.cpp"
        "track_popup.c"
        "isotp_tx.c"
        "hsm.c"
        "utf8_utf16_converter.c"
        "precondition.c"
        "persistent_settings.c"
        "config_server.c"
        "network_mgr.cpp"
        "gvret_server.cpp"
        "mqtt_mgr.cpp"
        "ble_mgr.cpp"
    INCLUDE_DIRS "."
    REQUIRES 
        "nvs_flash"
        "esp_http_server"
        "app_update"
        "driver"
        "mqtt"
        "esp_wifi"
        "esp_event"
        "esp_netif"
        "esp_timer"
        "esp_partition"
        "lwip"
        "json"
        "littlefs"
        "mdns"
        "bt"
)

# --- LittleFS 3-Tier Architecture Staging ---
# Target the shared data folder that Vite builds into
set(FS_DIR "${CMAKE_CURRENT_LIST_DIR}/../data")

# Create the data directory if it doesn't exist yet
file(MAKE_DIRECTORY "${FS_DIR}/www")

# Package the data folder (containing catalog.json, automations.json, and the www folder)
littlefs_create_partition_image(storage "${FS_DIR}" FLASH_IN_PROJECT)
