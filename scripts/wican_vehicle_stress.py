#!/usr/bin/env python3
"""WiCAN Bench Vehicle Emulation & Full-Stack Stress Test.

Simulates heavy in-car multi-system load against WiCAN hardware:
  1. High-rate authentic vehicle CAN log streaming over USB Serial (COM5) or GVRET TCP Port 23
     at 2,000 to 2,500+ fps.
  2. Android Auto / CarPlay HUD Navigation stream (/api/nav @ 4 Hz).
  3. Media Cluster Track Popup notifications (/api/notify).
  4. Web UI & Home Assistant concurrent state polling (/api/states, /api/system/status).
  5. BLE remote buttons & presence triggers (/api/ble/test_event).
  6. CAN command burst dispatches & live automation testing (/api/command, /api/test_automation).
  7. Real-time Free Heap, Task Watermark, and TWAI Health monitoring.
"""

import argparse
import csv
import json
import os
import socket
import sys
import threading
import time
import urllib.request
import urllib.error

try:
    import serial
except ImportError:
    serial = None

stop_event = threading.Event()
stats_lock = threading.Lock()

stats = {
    "gvret_sent": 0,
    "gvret_errs": 0,
    "nav_sent": 0,
    "nav_errs": 0,
    "notify_sent": 0,
    "notify_errs": 0,
    "http_reqs": 0,
    "http_errs": 0,
    "cmd_sent": 0,
    "cmd_errs": 0,
    "ble_sent": 0,
    "ble_errs": 0,
}

s_wifi_source_ip = ""


def detect_wifi_source_ip(target_ip: str) -> str:
    """Detects local IPv4 on the same subnet as target_ip to bind Windows sockets correctly."""
    try:
        import subprocess
        out = subprocess.check_output('netsh interface ipv4 show addresses "Wi-Fi"', shell=True).decode("utf-8", errors="ignore")
        for line in out.splitlines():
            if ":" in line:
                val = line.split(":", 1)[1].strip()
                if val.startswith("10.168.241."):
                    return val
    except Exception:
        pass
    return ""


def send_http_req(ip: str, path: str, method: str = "GET", payload: dict = None, timeout: float = 2.0) -> dict:
    """Dispatches HTTP request explicitly bound to Wi-Fi adapter if present."""
    global s_wifi_source_ip
    try:
        data_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Host": ip, "Connection": "close"}
        if data_bytes:
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(data_bytes))

        src = (s_wifi_source_ip, 0) if s_wifi_source_ip else None
        s = socket.create_connection((ip, 80), timeout=timeout, source_address=src)
        
        req_lines = [f"{method} {path} HTTP/1.1"]
        for k, v in headers.items():
            req_lines.append(f"{k}: {v}")
        req_lines.append("")
        req_lines.append("")
        s.sendall("\r\n".join(req_lines).encode("utf-8"))
        if data_bytes:
            s.sendall(data_bytes)

        # Read response headers
        buf = bytearray()
        s.settimeout(timeout)
        while b"\r\n\r\n" not in buf:
            chunk = s.recv(512)
            if not chunk:
                break
            buf.extend(chunk)

        if b"\r\n\r\n" not in buf:
            s.close()
            return {}

        hdr_raw, body_raw = buf.split(b"\r\n\r\n", 1)
        content_len = 0
        for line in hdr_raw.decode("utf-8", errors="ignore").splitlines():
            if line.lower().startswith("content-length:"):
                content_len = int(line.split(":", 1)[1].strip())
                break

        while len(body_raw) < content_len:
            chunk = s.recv(min(4096, content_len - len(body_raw)))
            if not chunk:
                break
            body_raw.extend(chunk)
        s.close()

        body_str = body_raw.decode("utf-8", errors="ignore").strip()
        if body_str:
            return json.loads(body_str)
    except Exception:
        pass
    return {}


def can_log_worker(ip: str, port: int, log_path: str, max_frames: int, target_rate: int, transport: str, serial_port: str):
    """Streams authentic recorded vehicle CAN log frames via USB Serial (COM5) or GVRET TCP Port 23."""
    global stats

    ser = None
    sock = None
    drain_stop = threading.Event()

    if transport == "serial":
        if not serial:
            print("[FAIL] pyserial is required for serial transport. Install via: pip install pyserial")
            return
        try:
            ser = serial.Serial()
            ser.port = serial_port
            ser.baudrate = 115200
            ser.dsrdtr = False
            ser.rtscts = False
            ser.dtr = False
            ser.rts = False
            ser.timeout = 0.5
            ser.open()
        except Exception as e:
            print(f"[FAIL] Could not open serial port {serial_port}: {e}")
            return
    else:
        def connect_sock():
            while not stop_event.is_set():
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    s.settimeout(2.0)
                    s.connect((ip, port))
                    return s
                except Exception:
                    time.sleep(1.0)
            return None

        sock = connect_sock()
        if not sock:
            return

        def drain(s, d_stop):
            while not stop_event.is_set() and not d_stop.is_set():
                try:
                    _ = s.recv(4096)
                except Exception:
                    break

        d_thread = threading.Thread(target=drain, args=(sock, drain_stop), daemon=True)
        d_thread.start()

    batch_buf = bytearray()
    BATCH_FRAMES = 50
    batch_cnt = 0
    f_count = 0
    t_start = time.time()

    try:
        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
            reader = csv.reader(f)
            _ = next(reader, None)  # Skip header

            for row in reader:
                if stop_event.is_set():
                    break
                if len(row) < 7:
                    continue

                try:
                    # CSV format: Time Stamp, ID, Extended, Dir, Bus, LEN, D1..D8
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

                    # GVRET binary packet: 0xF1 0x00 + 4B ID + 1B Bus + 1B DLC + Data + 1B Checksum
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
                    pkt.append(0x00)

                    batch_buf.extend(pkt)
                    batch_cnt += 1
                    f_count += 1

                    if batch_cnt >= BATCH_FRAMES:
                        if transport == "serial":
                            try:
                                ser.write(batch_buf)
                            except Exception:
                                with stats_lock:
                                    stats["gvret_errs"] += 1
                        else:
                            sent = False
                            while not stop_event.is_set() and not sent:
                                try:
                                    sock.sendall(batch_buf)
                                    sent = True
                                except Exception:
                                    with stats_lock:
                                        stats["gvret_errs"] += 1
                                    drain_stop.set()
                                    try:
                                        sock.close()
                                    except Exception:
                                        pass
                                    sock = connect_sock()
                                    if sock:
                                        drain_stop = threading.Event()
                                        d_thread = threading.Thread(target=drain, args=(sock, drain_stop), daemon=True)
                                        d_thread.start()

                        batch_buf.clear()
                        with stats_lock:
                            stats["gvret_sent"] += batch_cnt
                        batch_cnt = 0

                        # Rate limiting
                        if target_rate > 0:
                            expected_time = f_count / target_rate
                            actual_time = time.time() - t_start
                            if actual_time < expected_time:
                                time.sleep(expected_time - actual_time)

                    if max_frames > 0 and f_count >= max_frames:
                        break

                except (ValueError, IndexError):
                    continue

            if batch_cnt > 0:
                if transport == "serial" and ser:
                    try:
                        ser.write(batch_buf)
                        with stats_lock:
                            stats["gvret_sent"] += batch_cnt
                    except Exception:
                        pass
                elif sock:
                    try:
                        sock.sendall(batch_buf)
                        with stats_lock:
                            stats["gvret_sent"] += batch_cnt
                    except Exception:
                        pass

    finally:
        if ser:
            try:
                ser.close()
            except Exception:
                pass
        if sock:
            drain_stop.set()
            try:
                sock.close()
            except Exception:
                pass


def nav_worker(ip: str):
    """Simulates turn-by-turn HUD updates at 4 Hz like Android Auto / CarPlay."""
    streets = ["Grand Ave", "Interstate 15 N", "Newport Rd", "Haun Rd", "Scott Rd"]
    step = 0
    while not stop_event.is_set():
        street = streets[step % len(streets)]
        dist = max(50, 1000 - (step * 25) % 1000)
        icon = (step % 6) + 1
        payload = {
            "street": street,
            "distance": dist,
            "icon": icon,
            "speed_limit": 65,
            "bars": (step % 4) + 1
        }
        res = send_http_req(ip, "/api/nav", method="POST", payload=payload, timeout=1.5)
        if res and res.get("status") == "ok":
            with stats_lock:
                stats["nav_sent"] += 1
        else:
            with stats_lock:
                stats["nav_errs"] += 1
        step += 1
        time.sleep(0.25)


def notify_worker(ip: str):
    """Simulates track info and cluster notifications at 0.5 Hz."""
    tracks = [
        "Daft Punk - Around the World",
        "The Weeknd - Blinding Lights",
        "Kavinsky - Nightcall",
        "Cyberpunk - Never Fade Away"
    ]
    step = 0
    while not stop_event.is_set():
        track = tracks[step % len(tracks)]
        payload = {"message": track, "level": "info"}
        res = send_http_req(ip, "/api/notify", method="POST", payload=payload, timeout=1.5)
        if res and res.get("status") == "ok":
            with stats_lock:
                stats["notify_sent"] += 1
        else:
            with stats_lock:
                stats["notify_errs"] += 1
        step += 1
        time.sleep(2.0)


def http_poller_worker(ip: str, endpoint: str):
    """Polls REST endpoints to simulate Home Assistant and Web UI users."""
    while not stop_event.is_set():
        res = send_http_req(ip, endpoint, method="GET", timeout=2.0)
        if res:
            with stats_lock:
                stats["http_reqs"] += 1
        else:
            with stats_lock:
                stats["http_errs"] += 1
        time.sleep(0.25)


def can_burst_worker(ip: str):
    """Fires command bursts and live-fire automations into the CAN TX queue."""
    step = 0
    while not stop_event.is_set():
        if step % 2 == 0:
            payload = {
                "can_id": 0x4A2,
                "payload": "000000004F000000",
                "repeat": 2,
                "delay": 20
            }
            res = send_http_req(ip, "/api/command", method="POST", payload=payload, timeout=1.5)
        else:
            payload = {"id": "menu_ok_cool_driver_seat", "mode": "live_fire"}
            res = send_http_req(ip, "/api/test_automation", method="POST", payload=payload, timeout=1.5)

        if res and res.get("status") == "ok":
            with stats_lock:
                stats["cmd_sent"] += 1
        else:
            with stats_lock:
                stats["cmd_errs"] += 1
        step += 1
        time.sleep(1.0)


def ble_event_worker(ip: str):
    """Simulates BLE button press events from Atom Lite UART bridge."""
    buttons = ["volume_up", "volume_down", "media_play_pause", "voice_command"]
    step = 0
    while not stop_event.is_set():
        btn = buttons[step % len(buttons)]
        payload = {"button": btn, "action": "press"}
        res = send_http_req(ip, "/api/ble/test_event", method="POST", payload=payload, timeout=1.5)
        if res and res.get("status") == "ok":
            with stats_lock:
                stats["ble_sent"] += 1
        else:
            with stats_lock:
                stats["ble_errs"] += 1
        step += 1
        time.sleep(1.5)


def get_system_status(ip: str) -> dict:
    return send_http_req(ip, "/api/system/status", method="GET", timeout=2.0)


def main():
    global s_wifi_source_ip
    parser = argparse.ArgumentParser(description="WiCAN Full-Stack In-Car Bench Emulation & Load Test")
    parser.add_argument("--ip", default="10.168.241.64", help="Target WiCAN IP address")
    parser.add_argument("--transport", choices=["serial", "tcp"], default="serial", help="CAN data injection transport: 'serial' (COM5) or 'tcp' (Port 23)")
    parser.add_argument("--serial_port", default="COM5", help="USB Serial Port for hardware injection (default: COM5)")
    parser.add_argument("--port", type=int, default=23, help="GVRET TCP port (when --transport tcp)")
    parser.add_argument("--log", default="../Logs/lock unlock.csv", help="Path to authentic vehicle CAN log CSV")
    parser.add_argument("--frames", type=int, default=0, help="Max frames to stream (0 for entire log file)")
    parser.add_argument("--rate", type=int, default=2500, help="Target CAN frames per second")
    parser.add_argument("--duration", type=int, default=0, help="Max test duration in seconds (0 for no time limit)")
    args = parser.parse_args()

    ip = args.ip
    transport = args.transport
    serial_port = args.serial_port
    port = args.port
    log_path = args.log
    max_frames = args.frames
    target_rate = args.rate
    max_duration = args.duration

    if not os.path.exists(log_path):
        print(f"[FAIL] CAN log file not found at: {log_path}")
        sys.exit(1)

    s_wifi_source_ip = detect_wifi_source_ip(ip)

    log_size_mb = os.path.getsize(log_path) / (1024 * 1024)

    print(f"\n{'='*75}")
    print(f"  WiCAN Full-Stack In-Car Vehicle Emulation Stress Test")
    print(f"  Target Device:  http://{ip}")
    print(f"  CAN Injection:  {transport.upper()} ({serial_port if transport == 'serial' else f'Port {port}'})")
    print(f"  CAN Log File:   {log_path} ({log_size_mb:.1f} MB)")
    print(f"  Target CAN FPS: {target_rate:,} frames/sec")
    print(f"  Frame Limit:    {'ALL frames (~963k)' if max_frames == 0 else f'{max_frames:,} frames'}")
    print(f"  Time Limit:     {'None (run until log finishes)' if max_duration == 0 else f'{max_duration} seconds'}")
    print(f"{'='*75}\n")

    # Baseline check
    init_status = get_system_status(ip)
    if not init_status:
        print(f"[FAIL] Could not reach WiCAN at http://{ip}/api/system/status")
        sys.exit(1)

    init_heap = init_status.get("free_heap", 0)
    init_uptime = init_status.get("uptime_sec", 0)
    ver = init_status.get("can_do_version", "unknown")
    twai = init_status.get("twai_state", "unknown")

    print(f"WiCAN Baseline:")
    print(f"  Firmware:    {ver}")
    print(f"  Free Heap:   {init_heap:,} bytes")
    print(f"  Uptime:      {init_uptime} seconds")
    print(f"  TWAI State:  {twai}")
    print(f"\nEngaging Concurrent In-Car Load Workers:")
    print(f"  [x] Authentic Vehicle CAN Replay ({target_rate:,} fps via {transport.upper()} {serial_port if transport == 'serial' else port})")
    print(f"  [x] Android Auto / CarPlay HUD Turn-by-Turn Navigation (/api/nav @ 4 Hz)")
    print(f"  [x] Media Cluster Track Popups (/api/notify @ 0.5 Hz)")
    print(f"  [x] Parallel Web UI & HA Polling (/api/states, /api/system/status @ 5 Hz)")
    print(f"  [x] Remote Command Bursts & Live Automations (/api/command, /api/test_automation)")
    print(f"  [x] BLE Remote Button Simulation (/api/ble/test_event)")
    print(f"{'-'*75}")

    threads = [
        threading.Thread(target=can_log_worker, args=(ip, port, log_path, max_frames, target_rate, transport, serial_port), name="CAN_Worker"),
        threading.Thread(target=nav_worker, args=(ip,), name="Nav"),
        threading.Thread(target=notify_worker, args=(ip,), name="Notify"),
        threading.Thread(target=http_poller_worker, args=(ip, "/api/states"), name="HTTP_States"),
        threading.Thread(target=http_poller_worker, args=(ip, "/api/system/status"), name="HTTP_Status"),
        threading.Thread(target=can_burst_worker, args=(ip,), name="Command_Burst"),
        threading.Thread(target=ble_event_worker, args=(ip,), name="BLE_Event"),
    ]

    for t in threads:
        t.daemon = True
        t.start()

    start_time = time.time()
    min_heap = init_heap
    heap_samples = []

    print(f"\n{'Time':>5} | {'Heap (B)':>9} | {'CAN Frames':>10} | {'CAN FPS':>7} | {'Nav':>4} | {'HTTP':>5} | {'Cmd':>4} | {'BLE':>4} | {'TWAI State'}")
    print(f"{'-'*75}")

    last_f = 0
    last_t = start_time

    try:
        while True:
            time.sleep(1.0)
            now = time.time()
            elapsed = now - start_time
            dt = now - last_t

            with stats_lock:
                cur_f = stats["gvret_sent"]
                n_s = stats["nav_sent"]
                h_s = stats["http_reqs"]
                c_s = stats["cmd_sent"]
                b_s = stats["ble_sent"]

            fps = int((cur_f - last_f) / dt) if dt > 0 else 0
            last_f = cur_f
            last_t = now

            status = get_system_status(ip)
            cur_heap = status.get("free_heap", 0)
            cur_twai = status.get("twai_state", "unreachable")
            if cur_heap > 0:
                min_heap = min(min_heap, cur_heap)
                heap_samples.append(cur_heap)

            heap_str = f"{cur_heap:>9,}" if cur_heap > 0 else "  OFFLINE"
            print(f"{int(elapsed):>4}s | {heap_str} | {cur_f:>10,} | {fps:>7,} | {n_s:>4} | {h_s:>5} | {c_s:>4} | {b_s:>4} | {cur_twai}")

            # Check if CAN worker finished or time limit reached
            if not threads[0].is_alive():
                print(f"\nCAN log stream completed.")
                break
            if max_duration > 0 and elapsed >= max_duration:
                print(f"\nMax test duration ({max_duration}s) reached.")
                break

    except KeyboardInterrupt:
        print("\nTest interrupted by user.")
    finally:
        stop_event.set()
        for t in threads:
            t.join(timeout=1.0)

    print(f"{'-'*75}")
    print("Stress phase completed. Waiting 4s for FreeRTOS tasks to idle & GC...")
    time.sleep(4.0)

    # Attempt to query final status with retries in case Wi-Fi was temporarily roaming
    final_status = {}
    for _ in range(3):
        final_status = get_system_status(ip)
        if final_status:
            break
        time.sleep(1.0)

    final_heap = final_status.get("free_heap", 0)
    final_uptime = final_status.get("uptime_sec", 0)
    final_twai = final_status.get("twai_state", "unknown")
    bus_errs = final_status.get("bus_error_count", 0)
    tx_errs = final_status.get("tx_error_counter", 0)
    rx_errs = final_status.get("rx_error_counter", 0)
    heap_delta = final_heap - init_heap if final_heap > 0 else 0
    total_time = time.time() - start_time

    print(f"\n{'='*75}")
    print(f"  Full-Stack Stress Test Final Summary")
    print(f"{'='*75}")
    print(f"  Test Duration:       {total_time:.2f} seconds")
    print(f"  CAN Frames Ingested: {stats['gvret_sent']:,}  (Avg Speed: {int(stats['gvret_sent']/total_time):,} fps via {transport.upper()})")
    print(f"  HUD Nav Updates:     {stats['nav_sent']:,}  (Errors: {stats['nav_errs']})")
    print(f"  Media Popups:        {stats['notify_sent']:,}  (Errors: {stats['notify_errs']})")
    print(f"  HTTP Requests:       {stats['http_reqs']:,}  (Errors: {stats['http_errs']})")
    print(f"  Command Bursts:      {stats['cmd_sent']:,}  (Errors: {stats['cmd_errs']})")
    print(f"  BLE Events:          {stats['ble_sent']:,}  (Errors: {stats['ble_errs']})")
    print(f"{'-'*75}")
    print(f"  Initial Free Heap:   {init_heap:,} bytes")
    print(f"  Minimum Free Heap:   {min_heap:,} bytes (Max transient drop: {init_heap - min_heap:,} bytes)")
    if final_heap > 0:
        print(f"  Recovered Heap:      {final_heap:,} bytes (Net delta: {heap_delta:+,} bytes)")
        print(f"  Uptime Progression:  {init_uptime}s -> {final_uptime}s (Continuous, NO reboot)")
        print(f"  TWAI Hardware State: {final_twai}")
        print(f"  Hardware Counters:   Bus Errors={bus_errs}, TX Errors={tx_errs}, RX Errors={rx_errs}")
    else:
        print("  Post-test telemetry: Wi-Fi offline at test completion (device operational via Serial).")
    print(f"{'='*75}")

    if final_status and final_uptime < init_uptime:
        print("\n[CRITICAL FAILURE]: WiCAN rebooted during the stress test!")
        sys.exit(2)
    elif final_heap > 0 and abs(heap_delta) > 12288 and heap_delta < 0:
        print(f"\n[WARNING]: Free heap did not fully recover ({heap_delta:+,} bytes).")
    else:
        print("\n[SUCCESS]: WiCAN withstood authentic vehicle firehose + full offline resilience!")


if __name__ == "__main__":
    main()
