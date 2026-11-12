import csv
from collections import defaultdict

csv_path = r"G:\Other computers\Dell Laptop\Logs\Climate Bar\ev6_heatSW.csv"

def analyze_changes():
    rows = []
    unique_ids = set()
    press_indices = []
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        
        prev_448_d4 = None
        for i, row in enumerate(reader):
            if len(row) < 14:
                continue
            ts = float(row[0])
            can_id = row[1].lstrip('0').upper()
            unique_ids.add(can_id)
            d = [b.upper() for b in row[6:14]]
            rows.append((ts, can_id, d))
            
            if can_id == '448':
                d4 = d[3]
                if d4 == '40' and prev_448_d4 != '40':
                    press_indices.append(len(rows) - 1)
                prev_448_d4 = d4

    print(f"Total rows: {len(rows)}")
    print(f"Total time: {(rows[-1][0] - rows[0][0])/1e6:.2f} seconds")
    print(f"Found {len(press_indices)} target press events.")

    # Let's see the press timestamps in seconds
    for p_num, p_idx in enumerate(press_indices):
        p_ts, p_id, p_d = rows[p_idx]
        print(f"  Press #{p_num+1:02d}: t={p_ts/1e6:6.3f}s (row {p_idx}) data={p_d}")

    # First, let's find which CAN IDs change state *anywhere* in the entire log
    # And specifically, which ones change state around these press times!
    print("\n--- Scanning for IDs that change value in the entire log ---")
    id_histories = defaultdict(list)
    for i, (ts, can_id, d) in enumerate(rows):
        payload_tuple = tuple(d)
        if not id_histories[can_id] or id_histories[can_id][-1][1] != payload_tuple:
            id_histories[can_id].append((ts, payload_tuple, i))

    changing_ids = {cid: hist for cid, hist in id_histories.items() if len(hist) > 1}
    print(f"Total changing CAN IDs: {len(changing_ids)} out of {len(unique_ids)}")

    candidates = []
    for cid, hist in changing_ids.items():
        if len(hist) < 300:
            candidates.append((cid, len(hist), hist))

    candidates.sort(key=lambda x: x[1])
    print(f"\nCandidates with < 300 transitions ({len(candidates)} IDs):")
    for cid, count, hist in candidates:
        print(f"  ID 0x{cid}: {count} transitions")
        if count <= 40:
            for ts, payload, row_i in hist[:15]:
                print(f"     t={ts/1e6:6.3f}s: {' '.join(payload)}")
            if count > 15:
                print(f"     ... ({count - 15} more)")

if __name__ == '__main__':
    analyze_changes()
