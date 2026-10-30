if(IDF_VERSION_MAJOR GREATER_EQUAL 6)
    set(MQTT_COMPONENT "espressif__mqtt")
    set(CJSON_COMPONENT "espressif__cjson")
    set(EXTRA_COMPONENTS "esp_driver_gpio")
else()
    set(MQTT_COMPONENT "mqtt")
    set(CJSON_COMPONENT "json")
    set(EXTRA_COMPONENTS "")
endif()

idf_component_register(
    SRCS 
        "main.cpp"
        "core/parser.cpp"
        "core/can_engine.cpp"
        "net/api.cpp"
        "net/config_server.c"
        "net/gvret_server.cpp"
        "net/mqtt_mgr.cpp"
        "net/network_mgr.cpp"
        "net/uart_bridge.cpp"
        "net/usb_can.cpp"
        "platform/persistent_settings.c"
        "platform/power_mgr.cpp"
        "platform/timezone_mgr.cpp"
        "platform/vbat_sensor.cpp"
        "protocols/hsm.c"
        "protocols/isotp_tx.c"
        "protocols/uds_engine.cpp"
        "protocols/utf8_utf16_converter.c"
        "subsystems/ambient_anim.cpp"
        "subsystems/beep.c"
        "subsystems/hud_nav.c"
        "subsystems/precondition.c"
        "subsystems/remote_climate.cpp"
        "subsystems/track_popup.c"
    INCLUDE_DIRS 
        "."
        "core"
        "subsystems"
        "net"
        "protocols"
        "platform"
    REQUIRES 
        "nvs_flash"
        "esp_http_server"
        "app_update"
        "driver"
        ${MQTT_COMPONENT}
        "esp_wifi"
        "esp_event"
        "esp_netif"
        "esp_timer"
        "esp_partition"
        "lwip"
        ${CJSON_COMPONENT}
        "joltwallet__littlefs"
        "espressif__mdns"
        "esp_adc"
        "esp_http_client"
        ${EXTRA_COMPONENTS}
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
