"""Read the ATK CR 2026 Korea rate table in KRW (contracts/<code>/…ATK_CR_2026_Korea_KRW.xlsx).

load(code) → {row name: (KRW per pax list from 2 pax, SGL supplement KRW)}; row name = first two lines of
the Package cell, e.g. "PT 5D4N -BSC F&E Day x 2", "PT&GT JEJU 4D3N". Costing converts at FX (KRW → MYR) on the destination page.
"""
import glob
import openpyxl

FX = 0.0030


def load(code):
    path = sorted(glob.glob(f"contracts/{code.lower()}/*ATK_CR_2026_Korea_KRW.xlsx"))[-1]
    ws = openpyxl.load_workbook(path, data_only=True).active
    head = [c.value for c in ws[1]]
    paxcol = {int(v): i for i, v in enumerate(head) if isinstance(v, (int, float))}
    sglcol = head.index("SGL Sppl")
    out = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        name = row[1]
        if not isinstance(name, str) or not name.strip():
            continue
        rates = []
        for p in sorted(paxcol):
            v = row[paxcol[p]]
            if not isinstance(v, (int, float)):
                break
            rates.append(float(v))
        out[" ".join(x.strip() for x in name.strip().split("\n")[:2])] = (rates, float(row[sglcol]) if isinstance(row[sglcol], (int, float)) else None)
    return path, out
