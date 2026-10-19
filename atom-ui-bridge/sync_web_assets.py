import os
import shutil
import gzip

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FRONTEND_DIST = os.path.join(REPO_ROOT, "frontend", "dist")
ATOM_DATA = os.path.join(os.path.dirname(__file__), "data")

def sync():
    if not os.path.exists(FRONTEND_DIST):
        print("Frontend dist directory not found!")
        return

    # Clean destination directory
    if os.path.exists(ATOM_DATA):
        shutil.rmtree(ATOM_DATA, ignore_errors=True)
    os.makedirs(ATOM_DATA, exist_ok=True)

    for root, dirs, files in os.walk(FRONTEND_DIST):
        for f in files:
            if f.endswith(".map") or f.endswith(".gz.gz"):
                continue
            if "catalog" in f or "catalog" in root:
                continue

            rel = os.path.relpath(os.path.join(root, f), FRONTEND_DIST)
            src_path = os.path.join(root, f)
            dst_path = os.path.join(ATOM_DATA, rel)
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)

            with open(src_path, "rb") as fin:
                raw = fin.read()

            if f.endswith(".gz"):
                with open(dst_path, "wb") as fg:
                    fg.write(raw)
            else:
                if f == ".nojekyll":
                    with open(dst_path, "wb") as fu:
                        fu.write(raw)
                    continue

                gz_dist = src_path + ".gz"
                if os.path.exists(gz_dist):
                    if f in ["index.html", "logo.svg", "frontend_manifest.json"]:
                        with open(dst_path, "wb") as fu:
                            fu.write(raw)
                else:
                    if f in ["logo.svg", "frontend_manifest.json"]:
                        with open(dst_path, "wb") as fu:
                            fu.write(raw)
                    else:
                        gz_path = dst_path + ".gz"
                        with gzip.open(gz_path, "wb", compresslevel=9) as fg:
                            fg.write(raw)
                        if f == "index.html" or len(raw) < 1024:
                            with open(dst_path, "wb") as fu:
                                fu.write(raw)

    # Also bundle can_do_catalog.json and can_do_catalog.json.gz into Atom Lite data
    cat_src = os.path.join(REPO_ROOT, "catalog", "can_do_catalog.json")
    if os.path.exists(cat_src):
        atom_cat_dir = os.path.join(ATOM_DATA, "catalog")
        os.makedirs(atom_cat_dir, exist_ok=True)
        atom_cat_dst_gz = os.path.join(atom_cat_dir, "can_do_catalog.json.gz")
        atom_cat_dst = os.path.join(atom_cat_dir, "can_do_catalog.json")
        with open(cat_src, "rb") as f_in:
            cat_raw = f_in.read()
        with gzip.open(atom_cat_dst_gz, "wb", compresslevel=9) as f_out:
            f_out.write(cat_raw)
        with open(atom_cat_dst, "wb") as f_out:
            f_out.write(cat_raw)

    atom_bytes = sum(os.path.getsize(os.path.join(r, f)) for r, d, fs in os.walk(ATOM_DATA) for f in fs)
    print(f"Sync complete! Atom Lite LittleFS: {atom_bytes / 1024:.1f} KB (Partition: 2048 KB)")

if __name__ == "__main__":
    sync()

