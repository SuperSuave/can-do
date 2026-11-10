#!/usr/bin/env python3
"""
CAN Do Firmware OTA Flasher
Usage: python flash_ota.py <IP> <firmware.bin>
"""
import sys
import os
import time
import http.client
import urllib.request
import urllib.error

def flash_firmware(ip, bin_path):
    if not os.path.isfile(bin_path):
        print(f"Error: binary file {bin_path} not found")
        return False
        
    file_size = os.path.getsize(bin_path)
    print(f"Flashing {bin_path} ({file_size:,} bytes) to http://{ip}/api/ota ...")
    
    url = f"http://{ip}/api/ota"
    with open(bin_path, "rb") as f:
        data = f.read()

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(data)),
            "Connection": "close"
        },
        method="POST"
    )
    
    start_t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            dur = time.time() - start_t
            print(f"OTA Response (in {dur:.1f}s): {resp.status} - {body}")
            return resp.status == 200
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode('utf-8', errors='ignore')}")
        return False
    except (http.client.RemoteDisconnected, ConnectionResetError) as e:
        # Device may close the socket right as it begins rebooting
        dur = time.time() - start_t
        print(f"Connection closed after {dur:.1f}s (device likely rebooting): {e}")
        return True
    except Exception as e:
        dur = time.time() - start_t
        print(f"OTA failed after {dur:.1f}s: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python flash_ota.py <IP> <binary_path>")
        sys.exit(1)
    ip = sys.argv[1]
    bin_path = sys.argv[2]
    sys.exit(0 if flash_firmware(ip, bin_path) else 1)

