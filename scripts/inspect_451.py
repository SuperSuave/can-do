import csv
from collections import Counter

csv_path = r"G:\Other computers\Dell Laptop\Logs\Climate Bar\ev6_heatSW.csv"

def inspect_451():
    counts_451 = Counter()
    counts_418 = Counter()
    counts_637 = Counter()
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        for row in reader:
            if len(row) < 14:
                continue
            cid = row[1].lstrip('0').upper()
            d_str = ' '.join(b.upper() for b in row[6:14])
            if cid == '451':
                counts_451[d_str] += 1
            elif cid == '418':
                counts_418[d_str] += 1
            elif cid == '637':
                counts_637[d_str] += 1

    print("Unique 0x451 payloads:")
    for payload, cnt in counts_451.most_common():
        print(f"  {cnt:5d}x: {payload}")

    print("\nUnique 0x637 payloads:")
    for payload, cnt in counts_637.most_common():
        print(f"  {cnt:5d}x: {payload}")

    print("\nUnique 0x418 payloads (summary by D2 low nibble):")
    d2_counts = Counter()
    for payload, cnt in counts_418.items():
        bytes_ = payload.split()
        d2 = bytes_[1]
        d2_counts[f"D2={d2} (low={d2[1]})"] += cnt
    for k, cnt in sorted(d2_counts.items()):
        print(f"  {cnt:5d}x: {k}")

if __name__ == '__main__':
    inspect_451()

