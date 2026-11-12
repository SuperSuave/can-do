import csv

csv_path = r"G:\Other computers\Dell Laptop\Logs\Climate Bar\ev6_heatSW.csv"

def inspect_all_418():
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)
        
        last_d2 = None
        for row in reader:
            if len(row) < 14:
                continue
            cid = row[1].lstrip('0').upper()
            if cid == '418':
                ts = float(row[0]) / 1e6
                d = [b.upper() for b in row[6:14]]
                d2 = d[1]
                # Print when D2 low nibble or value changes
                counter = int(d2, 16) >> 4
                state_bits = int(d2, 16) & 0x0F
                if last_d2 is None or (state_bits != (int(last_d2, 16) & 0x0F)):
                    print(f"t={ts:6.3f}s | Raw D1-D8: {' '.join(d)} | D2={d2} (Counter={counter:X}, StateBits={state_bits:04b} / 0x{state_bits:02X})")
                last_d2 = d2

if __name__ == '__main__':
    inspect_all_418()

