import csv
import sys
from collections import defaultdict

csv_path = r"G:\Other computers\Dell Laptop\Logs\Climate Bar\ev6_heatSW.csv"

def analyze():
    # 1. Find occurrences of 0x448 with D4 == '40'
    target_timestamps = []
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        print("Header:", header)
        # Header: Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8
        
        row_idx = 0
        prev_d4 = None
        for row in reader:
            row_idx += 1
            if len(row) < 14:
                continue
            ts, can_id = row[0], row[1].lstrip('0')
            if can_id.upper() == '448':
                d4 = row[9].upper()
                if d4 == '40' and prev_d4 != '40':
                    target_timestamps.append((float(ts), row_idx, row))
                prev_d4 = d4

    print(f"Found {len(target_timestamps)} press events where 0x448 D4 transitioned to 40:")
    for ts, idx, row in target_timestamps:
        print(f"  Row {idx}: Time={ts}, Data={row[6:14]}")

if __name__ == '__main__':
    analyze()

