/*
 * Adapted from L1Z3/wicant-i-precondition:
 * https://github.com/L1Z3/wicant-i-precondition
 *
 * Original authors: L1Z3, Tyler Harvey (@tylerharvey), and contributors
 * Upstream base: meatpiHQ/wican-fw (https://github.com/meatpiHQ/wican-fw)
 * License: GPL-3.0
 *
 * Modified and maintained in sync for CAN Do (https://github.com/SuperSuave/can-do).
 */

#ifndef WICAN_BEEP_H
#define WICAN_BEEP_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Initialize once after configuration is loaded, before callers start queuing
// sounds. A dedicated worker owns playback; no tick or popup is required.
void beep_init(void);

// Queue 1..255 head-unit beeps without waiting for playback. Safe to call from
// tasks; requests play in FIFO order without interleaving. Returns false if
// uninitialized, count is zero, or the queue is full. CAN delivery is best effort.
// Timing is configured by BEEP_INTERVAL_MS in beep.c.
bool beep_play(uint8_t count);

#ifdef __cplusplus
}
#endif

#endif
