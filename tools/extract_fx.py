#!/usr/bin/env python3
"""Read the exchange rates each R&D workbook uses and store them, LOCKED, in data.json.

FX lives in the R&D sheet (CR / Raw Costing header cells such as "FX Rate (THB → MYR): 0.131").
The calculator shows it but never edits it: costs were converted with that rate, so changing it
on the page would silently disagree with the sheet. To change FX, change the R&D sheet and
re-import.

    python3 tools/extract_fx.py --work <dir>    # uses <dir>/base_out (recalculated copies from extract_rd.py)
    -> <dir>/fx.json  {CODE: [{"id","label","currency","supplier","value","source"}]}
"""
import argparse, glob, json, os, re
import openpyxl

CUR = [("JPY", r"JPY|YEN|¥(?!.*₩)"), ("KRW", r"KRW|₩|WON"), ("THB", r"THB|BAHT"), ("IDR", r"IDR|RUPIAH"),
       ("USD", r"USD"), ("EUR", r"EUR"), ("RMB", r"RMB|CNY"), ("AUD", r"AUD"), ("NZD", r"NZD"), ("CHF", r"CHF")]
SUPPLIERS = r"WIF|QAYYUM|UCOP|ATK|KTT"


def scan(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    out = []
    for sn in wb.sheetnames:
        if sn.strip() not in ("CR", "Raw Costing"):
            continue
        ws = wb[sn]
        for row in ws.iter_rows(min_row=1, max_row=8):
            for c in row:
                v = c.value
                if not (isinstance(v, str) and re.search(r"\bFX\b|Exchange|→\s*(MYR|RM)|->\s*MYR", v, re.I)):
                    continue
                val = next((x.value for x in row[c.column:c.column + 2] if isinstance(x.value, (int, float))), None)
                if not val or not (0 < val < 50):  # a rate to MYR, not a price in the label's currency
                    continue
                cur = next((k for k, rx in CUR if re.search(rx, v, re.I)), None)
                if not cur:
                    continue
                sup = re.findall(SUPPLIERS, v.upper())
                label = "%s%s → MYR" % (cur, " (" + "/".join(dict.fromkeys(sup)) + ")" if sup else "")
                out.append({"currency": cur, "supplier": "/".join(dict.fromkeys(sup)), "value": val, "label": label,
                            "source": "%s!%s" % (sn.strip(), c.coordinate)})
    seen, uniq = set(), []
    for f in out:
        k = (f["currency"], f["supplier"], round(f["value"], 10))
        if k not in seen:
            seen.add(k); uniq.append(f)
    for f in uniq:
        f["id"] = "%s%s" % (f["currency"], "-" + f["supplier"] if f["supplier"] else "")
    return uniq


def from_data():
    """The locked FX already in data.json (incl. PO overrides such as Qayyum 0.026), one entry per
    supplier, so crosscheck.py can run without re-importing the R&D."""
    d = json.load(open(os.path.join(os.path.dirname(__file__), "..", "data", "data.json")))
    res = {}
    for dest in d["destinations"]:
        out = []
        for f in dest.get("fx", []):
            cur = next((k for k, rx in CUR if re.search(rx, f["label"], re.I)), None)
            if not cur or f["id"] == "MYR":
                continue
            for sup in dict.fromkeys(re.findall(SUPPLIERS, f["label"].upper())) or [""]:
                out.append({"id": f["id"], "currency": cur, "supplier": sup, "value": f["value"],
                            "label": f["label"], "source": f.get("source", "")})
        res[dest["code"]] = out
    return res


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--work", required=True)
    ap.add_argument("--from-data", action="store_true", help="read the locked FX in data/data.json instead of the R&D")
    a = ap.parse_args()
    if a.from_data:
        res = from_data()
        json.dump(res, open(os.path.join(a.work, "fx.json"), "w"), indent=1, ensure_ascii=False)
        for k, v in res.items():
            print("%-8s %s" % (k, ", ".join("%s=%s" % (f["label"], f["value"]) for f in v) or "MYR direct"))
        return
    res = {}
    for p in sorted(glob.glob(os.path.join(a.work, "base_out", "*.xlsx"))):
        res[os.path.basename(p)[:-5]] = scan(p)
    json.dump(res, open(os.path.join(a.work, "fx.json"), "w"), indent=1, ensure_ascii=False)
    for k, v in res.items():
        print("%-8s %s" % (k, ", ".join("%s=%s (%s)" % (f["label"], f["value"], f["source"]) for f in v) or "MYR direct"))


if __name__ == "__main__":
    main()
