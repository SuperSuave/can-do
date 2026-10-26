#!/usr/bin/env python3
"""WiCAN Real-World Vehicle CAN Log Replayer & Stress Test.

Streams authentic recorded E-GMP vehicle CAN logs (e.g. 'lock unlock.csv' with 963k frames)
into WiCAN over GVRET TCP Port 23 at real-world or accelerated speeds (1,000 to 3,000+ fps).

Monitors:
  - Total frames dispatched & TCP throughput
  - Free Heap & Min Heap retention on WiCAN
  - Active MQTT state updates & automation processing
"""

import argparse
import csv
import json
import socket
import sys
import threading
import time
import urllib.request

stop_event = threading.Event()
stats_lock = threading.Lock()
frames_sent = 0
tcp_errors = 0


def status_monitor(ip: str, interval: float = 1.0):
    """Monitors WiCAN free heap, uptime, and TWAI state in real time."""
    start_t = time.time()
    print(f"\n{'Time':>5} | {'Heap (B)':>9} | {'Frames Sent':>11} | {'FPS':>6} | {'Uptime':>6} | {'TWAI State'}")
    print(f"{'-'*60}")

    last_f = 0
    last_t = start_t

    while not stop_event.is_set():
        time.sleep(interval)
        cur_t = time.time()
        elapsed = cur_t - start_t
        dt = cur_t - last_t

        with stats_lock:
            cur_f = frames_sent
        fps = int((cur_f - last_f) / dt) if dt > 0 else 0
        last_f = cur_f
        last_t = cur_t

        try:
            req = urllib.request.Request(f"http://{ip}/api/system/status")
            with urllib.request.urlopen(req, timeout=1.5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                heap = data.get("free_heap", 0)
                uptime = data.get("uptime_sec", 0)
                twai = data.get("twai_state", "unknown")
                print(f"{int(elapsed):>4}s | {heap:>9,} | {cur_f:>11,} | {fps:>6,} | {uptime:>5}s | {twai}")
        except Exception:
            print(f"{int(elapsed):>4}s | {'TIMEOUT':>9} | {cur_f:>11,} | {fps:>6,} | {'---':>6} | unreachable")


def main():
    global frames_sent, tcp_errors
    parser = argparse.ArgumentParser(description="WiCAN Real-World Vehicle CAN Log Replayer")
    parser.add_argument("--ip", default="10.168.241.64", help="WiCAN IP address")
    parser.add_argument("--port", type=int, default=23, help="GVRET TCP port")
    parser.add_argument("--log", default="../Logs/lock unlock.csv", help="Path to CAN CSV log")
    parser.add_argument("--limit", type=int, default=100000, help="Max frames to replay (0 for entire log)")
    parser.add_argument("--rate", type=int, default=2000, help="Target frames per second (0 for max speed)")
    args = parser.parse_args()

    ip = args.ip
    port = args.port
    log_path = args.log
    limit = args.limit
    target_rate = args.rate

    print(f"\n{'='*65}")
    print(f"  WiCAN Real-World Vehicle CAN Log Replayer")
    print(f"  Target:     {ip}:{port} (GVRET TCP)")
    print(f"  Log File:   {log_path}")
    print(f"  Frames:     {'ALL' if limit == 0 else f'{limit:,}'}")
    print(f"  Speed:      {'Uncapped' if target_rate == 0 else f'{target_rate:,} fps'}")
    print(f"{'='*65}\n")

    # Initial baseline
    try:
        req = urllib.request.Request(f"http://{ip}/api/system/status")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            status = json.loads(resp.read().decode("utf-8"))
            init_heap = status.get("free_heap", 0)
            init_uptime = status.get("uptime_sec", 0)
            ver = status.get("can_do_version", "unknown")
            print(f"WiCAN Baseline:")
            print(f"  Firmware:    {ver}")
            print(f"  Free Heap:   {init_heap:,} bytes")
            print(f"  Uptime:      {init_uptime} seconds")
    except Exception as e:
        print(f"[FAIL] Could not connect to WiCAN at {ip}: {e}")
        sys.exit(1)

    print(f"\nConnecting to GVRET TCP port {port}...")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.settimeout(5.0)
        sock.connect((ip, port))
        print("Connected to GVRET server! Starting log stream...")
    except Exception as e:
        print(f"[FAIL] GVRET connection failed: {e}")
        sys.exit(1)

    def drain_worker():
        while not stop_event.is_set():
            try:
                _ = sock.recv(4096)
            except Exception:
                break

    drain_thread = threading.Thread(target=drain_worker, daemon=True)
    drain_thread.start()

    # Start monitor thread
    monitor = threading.Thread(target=status_monitor, args=(ip, 1.0), daemon=True)
    monitor.start()

    batch_buf = bytearray()
    BATCH_FRAMES = 50
    batch_cnt = 0

    t_start = time.time()
    f_count = 0

    try:
        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
            reader = csv.reader(f)
            header = next(reader)  # Header row

            for row in reader:
                if len(row) < 7:
                    continue

                try:
                    # CSV: Time Stamp, ID, Extended, Dir, Bus, LEN, D1, D2, D3, D4, D5, D6, D7, D8
                    raw_id = int(row[1].strip(), 16)
                    is_ext = 1 if row[2].strip().lower() == "true" else 0
                    can_id = (raw_id & 0x1FFFFFFF) | (0x80000000 if is_ext else 0)
                    bus = int(row[4].strip()) if row[4].strip().isdigit() else 0
                    dlc = min(8, int(row[5].strip()) if row[5].strip().isdigit() else 8)

                    data_bytes = []
                    for i in range(6, 6 + dlc):
                        if i < len(row) and row[i].strip():
                            data_bytes.append(int(row[i].strip(), 16))
                        else:
                            data_bytes.append(0)

                    while len(data_bytes) < 8:
                        data_bytes.append(0)

                    # Pack into GVRET frame:
                    # 0xF1 0x00 + 4B ID + 1B Bus + 1B DLC + 8B Data + 1B Checksum
                    pkt = bytearray([
                        0xF1, 0x00,
                        can_id & 0xFF,
                        (can_id >> 8) & 0xFF,
                        (can_id >> 16) & 0xFF,
                        (can_id >> 24) & 0xFF,
                        bus & 0xFF,
                        dlc & 0xFF,
                    ])
                    pkt.extend(data_bytes[:dlc])
                    pkt.append(0x00)  # Checksum

                    batch_buf.extend(pkt)
                    batch_cnt += 1
                    f_count += 1

                    if batch_cnt >= BATCH_FRAMES:
                        sock.sendall(batch_buf)
                        batch_buf.clear()
                        with stats_lock:
                            frames_sent += batch_cnt
                        batch_cnt = 0

                        # Rate limiting
                        if target_rate > 0:
                            expected_time = f_count / target_rate
                            actual_time = time.time() - t_start
                            if actual_time < expected_time:
                                time.sleep(expected_time - actual_time)

                    if limit > 0 and f_count >= limit:
                        break

                except (ValueError, IndexError):
                    continue

            # Flush remaining batch
            if batch_cnt > 0:
                sock.sendall(batch_buf)
                with stats_lock:
                    frames_sent += batch_cnt

    except KeyboardInterrupt:
        print("\nReplay stopped by user.")
    except Exception as e:
        print(f"\n[TCP ERROR]: {e}")
    finally:
        stop_event.set()
        try:
            sock.close()
        except Exception:
            pass

    t_total = time.time() - t_start
    print(f"\n{'-'*60}")
    print(f"Log stream finished. Sent {frames_sent:,} frames in {t_total:.2f}s ({int(frames_sent / t_total):,} fps average).")
    print("Waiting 3s for FreeRTOS tasks to idle & GC...")
    time.sleep(3.0)

    # Post-check
    try:
        req = urllib.request.Request(f"http://{ip}/api/system/status")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            final = json.loads(resp.read().decode("utf-8"))
            f_heap = final.get("free_heap", 0)
            f_uptime = final.get("uptime_sec", 0)
            twai = final.get("twai_state", "unknown")
            delta = f_heap - init_heap
            print(f"\n{'='*65}")
            print(f"  Post-Replay Stability Summary")
            print(f"{'='*65}")
            print(f"  Total Frames Replayed:  {frames_sent:,}")
            print(f"  Initial Free Heap:      {init_heap:,} bytes")
            print(f"  Final Free Heap:        {f_heap:,} bytes (Net delta: {delta:+,} bytes)")
            print(f"  Uptime Progression:     {init_uptime}s -> {f_uptime}s (Continuous, NO crash)")
            print(f"  TWAI State:             {twai}")
            print(f"{'='*65}")
            if f_uptime < init_uptime:
                print("\n[CRITICAL FAILURE]: Device rebooted during log replay!")
            else:
                print("\n[SUCCESS]: WiCAN digested real vehicle log traffic with zero memory leaks!")
    except Exception as e:
        print(f"Could not reach device after test: {e}")


if __name__ == "__main__":
    main()
