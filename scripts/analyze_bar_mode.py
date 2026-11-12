import csv
from collections import Counter

csv_path = r"G:\Other computers\Dell Laptop\Logs\Climate Bar\ev6_barMode.csv"

def analyze_bar_mode():
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        print("Header:", header)
        
        last_d4 = None
        for row in reader:
            if len(row) < 14:
                continue
            cid = row[1].lstrip('0').upper()
            if cid == '652':
                ts = float(row[0]) / 1e6
                d = [b.upper() for b in row[6:14]]
                d4 = d[3]
                if d4 != last_d4:
                    print(f"t={ts:8.3f}s | 0x652 | {' '.join(d)} | D4: {last_d4} -> {d4}")
                    last_d4 = d4

if __name__ == '__main__':
    analyze_bar_mode()

