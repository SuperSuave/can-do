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
        "vbat_sensor.cpp"
        "uds_engine.cpp"
        "power_mgr.cpp"
    INCLUDE_DIRS "."
    REQUIRES 
        "nvs_flash"
        "esp_http_server"
        "app_update"
        "driver"
        "espressif__mqtt"
        "esp_wifi"
        "esp_event"
        "esp_netif"
        "esp_timer"
        "esp_partition"
        "lwip"
        "espressif__cjson"
        "joltwallet__littlefs"
        "espressif__mdns"
        "bt"
        "esp_adc"
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error=cpp -Wno-cpp -Wno-deprecated-declarations)

# --- LittleFS 3-Tier Architecture Staging ---
# Target the shared data folder that Vite builds into
set(FS_DIR "${CMAKE_CURRENT_LIST_DIR}/../data")

# Create the data directory if it doesn't exist yet
file(MAKE_DIRECTORY "${FS_DIR}/www")

# Always stage canonical catalog from catalog/can_do_catalog.json
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/../../catalog/can_do_catalog.json")
    file(COPY "${CMAKE_CURRENT_LIST_DIR}/../../catalog/can_do_catalog.json" DESTINATION "${FS_DIR}")
    if(EXISTS "${FS_DIR}/can_do_catalog.json")
        file(RENAME "${FS_DIR}/can_do_catalog.json" "${FS_DIR}/catalog.json")
    endif()
endif()

# Package the data folder (containing catalog.json, automations.json, and the www folder)
littlefs_create_partition_image(storage "${FS_DIR}" FLASH_IN_PROJECT)
