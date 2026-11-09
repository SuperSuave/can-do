#pragma once

#include "driver/twai.h"
#include "can.h"
#include "esp_err.h"
#include <cstdint>

// Starts the TCP Port 23 GVRET background server
esp_err_t gvret_server_init(uint16_t port = 23);

// Enqueues an incoming frame to be streamed to connected GVRET / SavvyCAN clients
void gvret_enqueue_frame(const twai_message_t* msg, uint8_t bus = 0);
void gvret_enqueue_fd_frame(const can_fd_frame_t* msg);

// Returns active GVRET client count
int gvret_get_client_count(void);
