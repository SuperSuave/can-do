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
    INCLUDE_DIRS "."
    REQUIRES 
        "nvs_flash"
        "esp_http_server"
        "esp_ota_ops"
        "driver"
        "mqtt"
        "esp_wifi"
        "cjson"
        "littlefs"
)

# Automated LittleFS staging
set(CATALOG_DIR "${CMAKE_SOURCE_DIR}/../catalog")
set(DASHBOARD_DIR "${CMAKE_SOURCE_DIR}/embedded-dashboard")
set(STAGING_DIR "${CMAKE_BINARY_DIR}/fs_staging")
set(AUTOMATIONS_FILE "${CMAKE_SOURCE_DIR}/automations.json")

file(MAKE_DIRECTORY ${STAGING_DIR}/catalog)
file(MAKE_DIRECTORY ${STAGING_DIR}/www)

add_custom_target(copy_fs_files ALL
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CATALOG_DIR} ${STAGING_DIR}/catalog
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${DASHBOARD_DIR} ${STAGING_DIR}/www
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${AUTOMATIONS_FILE} ${STAGING_DIR}/automations.json
    COMMENT "Staging catalog, embedded dashboard, and automations for LittleFS packaging..."
)

littlefs_create_partition_image(storage ${STAGING_DIR} FLASH_IN_PROJECT)
add_dependencies(storage_bin copy_fs_files)
