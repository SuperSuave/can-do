import csv
from collections import defaultdict

csv_path = r"G:\Other computers\Dell Laptop\Logs\Climate Bar\ev6_barMode.csv"

def find_mode_byte():
    intervals = [
        (199.2, 206.3, "media"),
        (208.0, 212.8, "climate"),
        (214.2, 220.6, "media"),
        (222.1, 228.3, "climate"),
        (229.8, 235.8, "media"),
        (237.4, 242.9, "climate"),
        (244.5, 251.8, "media"),
        (253.3, 260.0, "climate"),
        (261.6, 267.3, "media"),
    ]
    
    # Track values per (cid, byte_index)
    media_vals = defaultdict(set)
    climate_vals = defaultdict(set)
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        next(reader)
        for row in reader:
            if len(row) < 14:
                continue
            ts = float(row[0]) / 1e6
            cid = row[1].lstrip('0').upper()
            d = [int(b, 16) for b in row[6:14]]
            
            for s_start, s_end, mode in intervals:
                if s_start <= ts <= s_end:
                    for b_idx, val in enumerate(d):
                        key = (cid, b_idx)
                        if mode == "media":
                            media_vals[key].add(val)
                        else:
                            climate_vals[key].add(val)
                    break

    print("Checking for (CAN_ID, Byte) that strictly separates Media vs Climate:")
    for (cid, b_idx) in sorted(media_vals.keys()):
        m_set = media_vals[(cid, b_idx)]
        c_set = climate_vals[(cid, b_idx)]
        # Check if disjoint
        if m_set and c_set and not (m_set & c_set):
            print(f"ID 0x{cid} Byte D{b_idx+1}:")
            print(f"  Media: {[hex(x) for x in sorted(m_set)]}")
            print(f"  Climate: {[hex(x) for x in sorted(c_set)]}")

if __name__ == '__main__':
    find_mode_byte()

