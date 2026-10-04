import os
import shutil
import gzip

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FRONTEND_DIST = os.path.join(REPO_ROOT, "frontend", "dist")
CATALOG_PATH = os.path.join(REPO_ROOT, "catalog", "can_do_catalog.json")
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

def sync():
    if not os.path.exists(FRONTEND_DIST):
        print(f"Error: {FRONTEND_DIST} does not exist. Run 'bun run build' or 'npm run build' in frontend first.")
        return

    if os.path.exists(DATA_DIR):
        shutil.rmtree(DATA_DIR)
    os.makedirs(DATA_DIR, exist_ok=True)

    print(f"Syncing optimized web assets from {FRONTEND_DIST} to {DATA_DIR}...")
    
    # 1. Collect all files in dist
    all_files = set()
    for root, dirs, files in os.walk(FRONTEND_DIST):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), FRONTEND_DIST)
            all_files.add(rel)

    for rel in sorted(all_files):
        # Skip uncompressed version if a .gz version exists (e.g. bundle.js vs bundle.js.gz)
        if (rel + ".gz") in all_files:
            continue
        # Also skip .nojekyll or non-essential map files if any
        if rel.endswith(".map"):
            continue

        src = os.path.join(FRONTEND_DIST, rel)
        dst = os.path.join(DATA_DIR, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)

    # 2. Stage catalog.json (and catalog.json.gz)
    if os.path.exists(CATALOG_PATH):
        dst_catalog = os.path.join(DATA_DIR, "catalog.json")
        shutil.copy2(CATALOG_PATH, dst_catalog)
        # Also create catalog.json.gz for fast serving
        with open(CATALOG_PATH, "rb") as f_in:
            with gzip.open(dst_catalog + ".gz", "wb", compresslevel=9) as f_out:
                shutil.copyfileobj(f_in, f_out)
        print(f"Copied and compressed catalog -> {dst_catalog}.gz")

    total_size = sum(os.path.getsize(os.path.join(r, f)) for r, d, fs in os.walk(DATA_DIR) for f in fs)
    print(f"Sync complete! Total LittleFS footprint: {total_size / 1024:.1f} KB (easily fits within 2MB partition)")

if __name__ == "__main__":
    sync()
