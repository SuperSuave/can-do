import csv

csv_path = r"G:\Other computers\Dell Laptop\Logs\Climate Bar\ev6_heatSW.csv"

def print_targeted():
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        
        # Track 0x451, 0x418, 0x637, 0x448
        for row in reader:
            if len(row) < 14:
                continue
            ts = float(row[0]) / 1e6
            cid = row[1].lstrip('0').upper()
            d = [b.upper() for b in row[6:14]]
            
            # Filter to relevant time window: e.g. 7.0s to 12.0s
            if 7.5 <= ts <= 11.5:
                if cid in ('448', '451', '418', '637'):
                    print(f"t={ts:6.3f}s | ID=0x{cid:3s} | {' '.join(d)}")

if __name__ == '__main__':
    print_targeted()

