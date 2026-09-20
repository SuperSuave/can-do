#!/usr/bin/env python3
"""
CAN Do Web Assets OTA Uploader
Uploads compressed web assets and catalog directly to the ESP32 LittleFS partition over Wi-Fi.
Usage: python upload_web.py [DEVICE_IP]
"""

import os
import sys
import gzip
import urllib.request
import urllib.error
import time

DEFAULT_IP = "192.168.107.50"

def truncate_remote_file(ip, remote_path):
    url = f"http://{ip}/api/upload"
    req = urllib.request.Request(url, data=b"", headers={"X-File-Path": remote_path}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5):
            return True
    except Exception:
        return False

def upload_file(ip, local_path, remote_path):
    url = f"http://{ip}/api/upload"
    with open(local_path, "rb") as f:
        data = f.read()
    
    print(f"Uploading {os.path.basename(local_path):<30} -> {remote_path} ({len(data):,} bytes)...", end="", flush=True)
    req = urllib.request.Request(url, data=data, headers={"X-File-Path": remote_path}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            # Verify file was written and is not 0-bytes
            if len(data) > 0 and remote_path.startswith("/spiffs/www/"):
                check_uri = remote_path[len("/spiffs/www"):]
                try:
                    with urllib.request.urlopen(f"http://{ip}{check_uri}", timeout=5) as chk:
                        actual_len = len(chk.read())
                        if actual_len == 0:
                            print(f" [FAILED: Flash storage full (0 bytes written)]")
                            return False
                except Exception:
                    pass
            print(" [OK]")
            return True
    except urllib.error.HTTPError as e:
        print(f" [FAILED: HTTP {e.code}]")
        return False
    except Exception as e:
        print(f" [FAILED: {e}]")
        return False

def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_IP
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, "data")
    www_dir = os.path.join(data_dir, "www")

    print(f"Target Device: http://{ip}")
    print(f"Source Folder: {www_dir}\n")

    # 0. Clean up known stale hashed assets from previous builds to prevent LittleFS exhaustion
    historic_stale = [
        "/spiffs/www/index-DzOlfj10.js.gz",
        "/spiffs/www/index-uQb2UU3p.css.gz",
        "/spiffs/www/index-BNa0XSA6.js.gz",
        "/spiffs/www/index-BLMva-xK.js.gz",
        "/spiffs/www/index-BgIqk_xU.js.gz",
        "/spiffs/www/index-CgV9alWL.js.gz",
        "/spiffs/www/index-xYBoX6bs.js.gz",
        "/spiffs/www/index-of4sRFFA.css.gz",
        "/spiffs/www/index-F2wQvwRQ.css.gz",
        "/spiffs/www/index-C93d997e.js.gz",
        "/spiffs/www/index-B7bsdCst.js.gz",
        "/spiffs/www/index-B0w8EwUT.js.gz",
        "/spiffs/www/catalog/can_do_catalog.json.gz",
        "/spiffs/www/can_do_catalog.json.gz",
        "/spiffs/www/can_do_catalog.json",
        "/spiffs/www/test.txt",
        "/spiffs/www/test_size.bin",
        "/spiffs/test.txt",
    ]

    # Dynamically detect whatever hashed assets the device is currently running
    try:
        import re
        with urllib.request.urlopen(f"http://{ip}/index.html", timeout=4) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            for m in re.findall(r'index-[a-zA-Z0-9_\-]+\.(?:js|css)', raw.decode("utf-8", errors="ignore")):
                historic_stale.append(f"/spiffs/www/{m}.gz")
                historic_stale.append(f"/spiffs/www/{m}")
    except Exception:
        pass

    current_files = {f"/spiffs/www/{f}" for f in os.listdir(www_dir)}
    for stale in set(historic_stale):
        if stale not in current_files:
            truncate_remote_file(ip, stale)

    # 1. Upload www assets
    for fname in sorted(os.listdir(www_dir)):
        local_file = os.path.join(www_dir, fname)
        if os.path.isfile(local_file) and not fname.startswith("."):
            remote_path = f"/spiffs/www/{fname}"
            upload_file(ip, local_file, remote_path)

    # 2. Overwrite uncompressed /spiffs/www/index.html for legacy fallback
    idx_gz = os.path.join(www_dir, "index.html.gz")
    if os.path.isfile(idx_gz):
        raw_html = gzip.decompress(open(idx_gz, "rb").read())
        print(f"Syncing legacy fallback index.html ({len(raw_html)} bytes)...", end="", flush=True)
        req = urllib.request.Request(f"http://{ip}/api/upload", data=raw_html, headers={"X-File-Path": "/spiffs/www/index.html"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15):
                print(" [OK]")
        except Exception as e:
            print(f" [FAILED: {e}]")

    # 3. Upload catalog.json (triggers reboot)
    cat_file = os.path.join(script_dir, "..", "catalog", "can_do_catalog.json")
    if not os.path.isfile(cat_file):
        cat_file = os.path.join(data_dir, "catalog.json")
    if os.path.isfile(cat_file):
        print("\nUploading catalog.json (device will reboot on completion)...")
        upload_file(ip, cat_file, "/spiffs/catalog.json")

    print("\nWeb deployment complete! Visit: http://" + ip)

if __name__ == "__main__":
    main()
