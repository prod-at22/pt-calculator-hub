"""Seoul-Jeju (SELJJU), Jeju (JJU) and Jeju-Udo (JJUO): package cost = ATK CR 2026, one line per pax.

Rates (RM per pax, from 2 pax) are read off the ATK CR 2026 Korea rate table in
contracts/<code>/…ATK_CR_2026_Korea_rates.webp. Child: extra bed 75%, no bed 50%, infant FOC (same CR).
Add-ons and the Jeju Self Tour (not in the CR) are left as they are. Seoul is tools/build_sel.py.

    python3 tools/build_korea_cr.py --by product

Keep SELJJU JJU JJUO in --keep on every R&D re-import (tools/merge_dests.py).
"""
import argparse, datetime, json

# code: (variant id, label, CR row, RM per pax from 2 pax, SGL supplement)
CR = {
    "SELJJU": ("ATK-STD", "ATK · Seoul-Jeju Standard (CR 2026)", "PT 6D5N Seoul-Jeju Standard · NO Meal · Seoul 3★ Migliore / Jeju Parkside",
               [5381, 4223, 3644, 3296, 3232, 3043, 2901, 3461, 3305, 3178, 3072, 3060, 2977, 2906, 2844, 2971,
                2912, 2859, 2811, 2768, 2729, 2693, 2661, 2630], 1156),
    "JJU": ("ATK-PT", "ATK · Jeju 4D3N (CR 2026)", "PT&GT JEJU 4D3N · NO Meal · 3★ Parkside (50,000 KRW/pax/N)",
            [2868, 2158, 1803, 1590, 1448, 1443, 1355, 1587, 1502, 1433, 1375, 1378, 1332, 1292, 1258, 1231,
             1204, 1179, 1157, 1137, 1119, 1103, 1087, 1073], 608),
    "JJUO": ("ATK-STD", "ATK · Jeju-Udo 5D4N (CR 2026)", "PT&GT-BSC, STD JEJU UDO 5D4N · Full board · 3★ Parkside (50,000 KRW/pax/N)",
             [4386, 3324, 2793, 2474, 2262, 2110, 1996, 1908, 2382, 2275, 2185, 2109, 2044, 1988, 1939, 1993,
              1949, 1909, 1874, 1842, 1812, 1786, 1761, 1739], 487),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--by", default="product")
    a = ap.parse_args()
    data = json.load(open("data/data.json"))
    hist = json.load(open("data/history.json"))
    summary = []
    for code, (vid, label, row, rates, sgl) in CR.items():
        d = next(x for x in data["destinations"] if x["code"] == code)
        rfile = next((c["file"] for c in d.get("contracts", []) if "rates" in c["file"]), "")
        tid = f"CR-{code}"
        d["tables"] = [t for t in d["tables"] if not t["id"].startswith(vid + "__") and t["id"] != tid] + [
            {"id": tid, "label": f"ATK CR 2026 · {code}", "group": "ATK contract rate", "fx": "MYR",
             "values": {str(p): v for p, v in zip(range(2, 2 + len(rates)), rates)}}]
        old = next(v for v in d["variants"] if v["id"] == vid)
        d["variants"] = [{"id": vid, "label": label, "supplier": "ATK", "paxMin": 2, "paxMax": 1 + len(rates),
                          "hotel": old.get("hotel", ""), "notes": f"ATK CR 2026 row: {row} · SGL sppl RM{sgl} · {rfile}",
                          "components": [{"key": "cr", "label": "ATK contract rate", "per": "pax", "expr": f"T['{tid}']"}]}
                         if v["id"] == vid else v for v in d["variants"]]
        for p in d["packages"]:
            if any(x["variant"] == vid for x in p["assign"]):   # CR: extra bed 75%, no bed 50%, infant FOC
                p["rules"]["cwbCost"] = {"type": "pct", "value": 0.75}
                p["rules"]["cnbCost"] = {"type": "pct", "value": 0.5}
                p["rules"]["infantCost"] = {"type": "flat", "value": 0}
        d["source"] = "ATK CR 2026 Korea" + (" · Self Tour: " + d["source"] if len(d["variants"]) > 1 else "")
        d["note"] = "Package cost = ATK CR 2026 per pax (RM), 2–25 pax. CR seasonal discount/upcharge is not applied here."
        summary.append(f"{d['name']}: cost = ATK CR 2026 ({row.split(' · ')[0]}), 2–25 pax, one line")
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
