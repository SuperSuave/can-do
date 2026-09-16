idf_component_register(
    SRCS 
        "main.cpp"
        "parser.cpp"
        "can_engine.cpp"
        "api.cpp"
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
set(FRONTEND_DIR "${CMAKE_SOURCE_DIR}/../frontend")
set(STAGING_DIR "${CMAKE_BINARY_DIR}/fs_staging")

file(MAKE_DIRECTORY ${STAGING_DIR}/catalog)
file(MAKE_DIRECTORY ${STAGING_DIR}/www)

add_custom_target(copy_fs_files ALL
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CATALOG_DIR} ${STAGING_DIR}/catalog
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${FRONTEND_DIR} ${STAGING_DIR}/www
    COMMENT "Staging catalog and frontend for LittleFS packaging..."
)

littlefs_create_partition_image(storage ${STAGING_DIR} FLASH_IN_PROJECT)
add_dependencies(storage_bin copy_fs_files)
