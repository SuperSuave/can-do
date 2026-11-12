import csv
from collections import defaultdict

csv_path = r"G:\Other computers\Dell Laptop\Logs\Climate Bar\ev6_barMode.csv"

def find_mode_state():
    # We know the transitions happened at:
    # t=4289.5 (to Media)
    # t=4294.5 (to Climate)
    # t=197.5 (to Media)
    # t=206.4 (to Climate)
    # t=212.9 (to Media)
    # t=220.7 (to Climate)
    # t=228.3 (to Media)
    # t=235.9 (to Climate)
    # t=243.0 (to Media)
    # t=251.9 (to Climate)
    # t=260.0 (to Media)
    # t=267.4 (to Climate)
    
    # Let's collect all CAN frames across the log
    # and find any CAN ID that toggles between Media periods and Climate periods!
    
    intervals = [
        # (start, end, mode)
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
    
    # Sample CAN frames during media vs during climate
    samples_media = defaultdict(set)
    samples_climate = defaultdict(set)
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        next(reader)
        for row in reader:
            if len(row) < 14:
                continue
            ts = float(row[0]) / 1e6
            cid = row[1].lstrip('0').upper()
            d_str = ' '.join(b.upper() for b in row[6:14])
            
            for s_start, s_end, mode in intervals:
                if s_start <= ts <= s_end:
                    if mode == "media":
                        samples_media[cid].add(d_str)
                    else:
                        samples_climate[cid].add(d_str)
                    break

    print("Checking which CAN IDs correlate perfectly with Media vs Climate modes:")
    for cid in sorted(samples_media.keys()):
        m_set = samples_media[cid]
        c_set = samples_climate[cid]
        # If the set of payloads in media is disjoint from climate, or has very few distinct payloads:
        if m_set and c_set and len(m_set) <= 5 and len(c_set) <= 5:
            if not (m_set & c_set):
                print(f"Candidate state frame: 0x{cid}")
                print(f"  Media ({len(m_set)} payloads): {list(m_set)}")
                print(f"  Climate ({len(c_set)} payloads): {list(c_set)}")

if __name__ == '__main__':
    find_mode_state()

