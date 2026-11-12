import csv

csv_path = r"G:\Other computers\Dell Laptop\Logs\Climate Bar\ev6_heatSW.csv"

with open(csv_path) as f:
    r = csv.reader(f)
    next(r)
    for row in r:
        if len(row) < 14:
            continue
        ts = float(row[0]) / 1e6
        if 6.4 <= ts <= 6.8:
            cid = row[1].lstrip('0').upper()
            if cid in ('448', '451', '418', '637'):
                print(f"t={ts:.3f} | {cid} | {' '.join(row[6:14])}")

