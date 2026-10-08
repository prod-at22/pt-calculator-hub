"""Seoul-Jeju (SELJJU), Jeju (JJU) and Jeju-Udo (JJUO): package cost = ATK CR 2026, one line per pax.

Rates are the ATK CR 2026 Korea table in KRW per pax (contracts/<code>/…ATK_CR_2026_Korea_KRW.xlsx,
via tools/korea_cr.py), converted on the page at KRW × 0.0030. Child: extra bed 75%, no bed 50%, infant FOC (same CR).
Add-ons and the Jeju Self Tour (not in the CR) are left as they are. Seoul is tools/build_sel.py.

    python3 tools/build_korea_cr.py --by product

Run only when the ATK CR xlsx changes; it rewrites SELJJU, JJU and JJUO in data/data.json.
"""
import argparse, datetime, json, os, sys

sys.path.insert(0, os.path.dirname(__file__))
import korea_cr

# code: (variant id, label, CR row in the KRW table, row description)
CR = {
    "SELJJU": ("ATK-STD", "ATK · Seoul-Jeju Standard (CR 2026)", "PT 6D5N Seoul-Jeju Standard", "NO Meal · Seoul 3★ Migliore / Jeju Parkside"),
    "JJU": ("ATK-PT", "ATK · Jeju 4D3N (CR 2026)", "PT&GT JEJU 4D3N", "NO Meal · 3★ Parkside (50,000 KRW/pax/N)"),
    "JJUO": ("ATK-STD", "ATK · Jeju-Udo 5D4N (CR 2026)", "PT&GT-BSC, STD JEJU UDO 5D4N", "Full board · 3★ Parkside (50,000 KRW/pax/N)"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--by", default="product")
    a = ap.parse_args()
    data = json.load(open("data/data.json"))
    hist = json.load(open("data/history.json"))
    summary = []
    for code, (vid, label, row, desc) in CR.items():
        d = next(x for x in data["destinations"] if x["code"] == code)
        rfile, rows = korea_cr.load(code)
        rates, sgl = rows[row]
        d["fx"] = [f for f in d["fx"] if f["id"] != "KRW"] + [
            {"id": "KRW", "label": "KRW → MYR", "value": korea_cr.FX, "locked": True, "source": "PO, 5 Oct 2026 (ATK CR in KRW × 0.0030)"}]
        tid = f"CR-{code}"
        d["tables"] = [t for t in d["tables"] if not t["id"].startswith(vid + "__") and t["id"] != tid] + [
            {"id": tid, "label": f"ATK CR 2026 · {code} (KRW)", "group": "ATK contract rate", "fx": "KRW",
             "values": {str(p): v for p, v in zip(range(2, 2 + len(rates)), rates)}}]
        old = next(v for v in d["variants"] if v["id"] == vid)
        d["variants"] = [{"id": vid, "label": label, "supplier": "ATK", "paxMin": 2, "paxMax": 1 + len(rates),
                          "hotel": old.get("hotel", ""), "notes": f"ATK CR 2026 row: {row} · {desc} · KRW × {korea_cr.FX} · SGL sppl {sgl:,.0f} KRW · {rfile}",
                          "components": [{"key": "cr", "label": "ATK contract rate", "per": "pax", "expr": f"T['{tid}']"}]}
                         if v["id"] == vid else v for v in d["variants"]]
        for p in d["packages"]:
            if any(x["variant"] == vid for x in p["assign"]):   # CR: extra bed 75%, no bed 50%, infant FOC
                p["rules"]["cwbCost"] = {"type": "pct", "value": 0.75}
                p["rules"]["cnbCost"] = {"type": "pct", "value": 0.5}
                p["rules"]["infantCost"] = {"type": "flat", "value": 0}
        d["source"] = "ATK CR 2026 Korea" + (" · Self Tour: " + d["source"] if len(d["variants"]) > 1 else "")
        d["note"] = "Package cost = ATK CR 2026 per pax in KRW × 0.0030, 2–25 pax. CR seasonal discount/upcharge is not applied here."
        summary.append(f"{d['name']}: cost = ATK CR 2026 ({row}) in KRW × {korea_cr.FX}, 2–25 pax, one line")
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    data["version"] += 1; data["updatedAt"] = now; data["updatedBy"] = a.by
    hist["entries"].append({"v": data["version"], "at": now, "by": a.by, "rebase": True, "changes": [],
                            "note": "Seoul-Jeju, Jeju, Jeju-Udo costed from ATK CR 2026 (rebuilt: SELJJU JJU JJUO)",
                            "summary": summary})
    for f, o in (("data/data.json", data), ("data/history.json", hist)):
        open(f, "w").write(json.dumps(o, indent=1, ensure_ascii=False) + "\n")
    print("rebuilt SELJJU JJU JJUO, v", data["version"])


if __name__ == "__main__":
    main()
