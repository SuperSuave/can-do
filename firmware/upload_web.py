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

def upload_file(ip, local_path, remote_path, retries=3):
    url = f"http://{ip}/api/upload"
    with open(local_path, "rb") as f:
        data = f.read()
    
    print(f"Uploading {os.path.basename(local_path):<30} -> {remote_path} ({len(data):,} bytes)...", end="", flush=True)
    
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=data, headers={"X-File-Path": remote_path}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                # Verify file was written completely and matches expected length
                if len(data) > 0 and remote_path.startswith("/spiffs/www/") and remote_path.endswith(".gz"):
                    check_uri = remote_path[len("/spiffs/www"):]
                    try:
                        with urllib.request.urlopen(f"http://{ip}{check_uri}", timeout=10) as chk:
                            actual_len = len(chk.read())
                            if actual_len != len(data):
                                if attempt < retries:
                                    print(f" [Length mismatch: got {actual_len}, expected {len(data)}. Retrying {attempt}/{retries}...]", end="", flush=True)
                                    time.sleep(1)
                                    continue
                                else:
                                    print(f" [FAILED: Truncated upload ({actual_len}/{len(data)} bytes)]")
                                    return False
                    except Exception:
                        pass
                print(" [OK]")
                return True
        except urllib.error.HTTPError as e:
            if attempt < retries:
                print(f" [HTTP {e.code}, retrying {attempt}/{retries}...]", end="", flush=True)
                time.sleep(1)
            else:
                print(f" [FAILED: HTTP {e.code}]")
                return False
        except Exception as e:
            if attempt < retries:
                print(f" [{e}, retrying {attempt}/{retries}...]", end="", flush=True)
                time.sleep(1)
            else:
                print(f" [FAILED: {e}]")
                return False
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
        "/spiffs/www/index-04GDQn5C.js.gz",
        "/spiffs/www/index-04GDQn5C.js",
        "/spiffs/www/index-B0w8EwUT.js.gz",
        "/spiffs/www/index-B0w8EwUT.js",
        "/spiffs/www/index-B7bsdCst.js.gz",
        "/spiffs/www/index-B7bsdCst.js",
        "/spiffs/www/index-B9ECd2O2.js.gz",
        "/spiffs/www/index-B9ECd2O2.js",
        "/spiffs/www/index-BAgEIVix.js.gz",
        "/spiffs/www/index-BAgEIVix.js",
        "/spiffs/www/index-BBflTC1q.js.gz",
        "/spiffs/www/index-BBflTC1q.js",
        "/spiffs/www/index-BDIarFNb.js.gz",
        "/spiffs/www/index-BDIarFNb.js",
        "/spiffs/www/index-BGcT_BwK.js.gz",
        "/spiffs/www/index-BGcT_BwK.js",
        "/spiffs/www/index-BLMva-xK.js.gz",
        "/spiffs/www/index-BLMva-xK.js",
        "/spiffs/www/index-BMWC-3Sr.js.gz",
        "/spiffs/www/index-BMWC-3Sr.js",
        "/spiffs/www/index-BNa0XSA6.js.gz",
        "/spiffs/www/index-BNa0XSA6.js",
        "/spiffs/www/index-BPCGQk78.js.gz",
        "/spiffs/www/index-BPCGQk78.js",
        "/spiffs/www/index-BVgnqqbu.css.gz",
        "/spiffs/www/index-BVgnqqbu.css",
        "/spiffs/www/index-BY8F-wbv.css.gz",
        "/spiffs/www/index-BY8F-wbv.css",
        "/spiffs/www/index-BgIqk_xU.js.gz",
        "/spiffs/www/index-BgIqk_xU.js",
        "/spiffs/www/index-BkNqwj_Q.js.gz",
        "/spiffs/www/index-BkNqwj_Q.js",
        "/spiffs/www/index-BqdXgvAX.js.gz",
        "/spiffs/www/index-BqdXgvAX.js",
        "/spiffs/www/index-BuOrMC8Z.js.gz",
        "/spiffs/www/index-BuOrMC8Z.js",
        "/spiffs/www/index-BuWRRioK.js.gz",
        "/spiffs/www/index-BuWRRioK.js",
        "/spiffs/www/index-C8Pkag04.js.gz",
        "/spiffs/www/index-C8Pkag04.js",
        "/spiffs/www/index-C93d997e.js.gz",
        "/spiffs/www/index-C93d997e.js",
        "/spiffs/www/index-CDZWBcEi.js.gz",
        "/spiffs/www/index-CDZWBcEi.js",
        "/spiffs/www/index-CFly5NGV.css.gz",
        "/spiffs/www/index-CFly5NGV.css",
        "/spiffs/www/index-CGbV3uLW.js.gz",
        "/spiffs/www/index-CGbV3uLW.js",
        "/spiffs/www/index-CK4keu3j.js.gz",
        "/spiffs/www/index-CK4keu3j.js",
        "/spiffs/www/index-CY47egVP.js.gz",
        "/spiffs/www/index-CY47egVP.js",
        "/spiffs/www/index-CZ0xaRKM.js.gz",
        "/spiffs/www/index-CZ0xaRKM.js",
        "/spiffs/www/index-C_RZwNho.css.gz",
        "/spiffs/www/index-C_RZwNho.css",
        "/spiffs/www/index-Cf5MvB5E.css.gz",
        "/spiffs/www/index-Cf5MvB5E.css",
        "/spiffs/www/index-CgV9alWL.js.gz",
        "/spiffs/www/index-CgV9alWL.js",
        "/spiffs/www/index-ChJGMwUB.css.gz",
        "/spiffs/www/index-ChJGMwUB.css",
        "/spiffs/www/index-CokkbONd.js.gz",
        "/spiffs/www/index-CokkbONd.js",
        "/spiffs/www/index-Cr2Znrty.js.gz",
        "/spiffs/www/index-Cr2Znrty.js",
        "/spiffs/www/index-CywiyZjG.js.gz",
        "/spiffs/www/index-CywiyZjG.js",
        "/spiffs/www/index-D2EcMD8j.css.gz",
        "/spiffs/www/index-D2EcMD8j.css",
        "/spiffs/www/index-D3k7EHD5.css.gz",
        "/spiffs/www/index-D3k7EHD5.css",
        "/spiffs/www/index-D6FC3_T5.js.gz",
        "/spiffs/www/index-D6FC3_T5.js",
        "/spiffs/www/index-DMXi79xD.js.gz",
        "/spiffs/www/index-DMXi79xD.js",
        "/spiffs/www/index-D_W5n0C3.js.gz",
        "/spiffs/www/index-D_W5n0C3.js",
        "/spiffs/www/index-D_i94GEM.js.gz",
        "/spiffs/www/index-D_i94GEM.js",
        "/spiffs/www/index-DzOlfj10.js.gz",
        "/spiffs/www/index-DzOlfj10.js",
        "/spiffs/www/index-E8IOPc6j.js.gz",
        "/spiffs/www/index-E8IOPc6j.js",
        "/spiffs/www/index-F2wQvwRQ.css.gz",
        "/spiffs/www/index-F2wQvwRQ.css",
        "/spiffs/www/index-F58v9HOj.css.gz",
        "/spiffs/www/index-F58v9HOj.css",
        "/spiffs/www/index-FDgATgnS.js.gz",
        "/spiffs/www/index-FDgATgnS.js",
        "/spiffs/www/index-GAeK8n2d.js.gz",
        "/spiffs/www/index-GAeK8n2d.js",
        "/spiffs/www/index-LLOBmZc8.js.gz",
        "/spiffs/www/index-LLOBmZc8.js",
        "/spiffs/www/index-P08GyVse.js.gz",
        "/spiffs/www/index-P08GyVse.js",
        "/spiffs/www/index-WATm7HiE.js.gz",
        "/spiffs/www/index-WATm7HiE.js",
        "/spiffs/www/index-amNGAhHU.js.gz",
        "/spiffs/www/index-amNGAhHU.js",
        "/spiffs/www/index-dmwge4lj.js.gz",
        "/spiffs/www/index-dmwge4lj.js",
        "/spiffs/www/index-of4sRFFA.css.gz",
        "/spiffs/www/index-of4sRFFA.css",
        "/spiffs/www/index-pcFwKUiK.js.gz",
        "/spiffs/www/index-pcFwKUiK.js",
        "/spiffs/www/index-slPHn74a.js.gz",
        "/spiffs/www/index-slPHn74a.js",
        "/spiffs/www/index-uQb2UU3p.css.gz",
        "/spiffs/www/index-uQb2UU3p.css",
        "/spiffs/www/index-xYBoX6bs.js.gz",
        "/spiffs/www/index-xYBoX6bs.js",
        "/spiffs/www/catalog/can_do_catalog.json.gz",
        "/spiffs/www/can_do_catalog.json.gz",
        "/spiffs/www/can_do_catalog.json",
        "/spiffs/www/test.txt",
        "/spiffs/www/test_size.bin",
        "/spiffs/test.txt",
    ]

    # Dynamically detect whatever hashed assets the device is currently running or in git
    try:
        import subprocess, re
        git_out = subprocess.check_output(
            ["git", "log", "--name-only", "--pretty=format:", "-n", "30", "--", "firmware/data/www/index-*"],
            cwd=script_dir, text=True, stderr=subprocess.DEVNULL
        )
        for m in re.findall(r'index-[a-zA-Z0-9_\-]+\.(?:js|css)', git_out):
            historic_stale.append(f"/spiffs/www/{m}.gz")
            historic_stale.append(f"/spiffs/www/{m}")
    except Exception:
        pass

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
    stale_to_clean = [s for s in set(historic_stale) if s not in current_files]
    print(f"Cleaning {len(stale_to_clean)} stale asset candidates...", flush=True)
    for stale in stale_to_clean:
        truncate_remote_file(ip, stale)
    print("Done cleaning stale assets.\n", flush=True)

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
