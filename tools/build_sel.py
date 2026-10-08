"""Seoul (SEL): package cost = ATK contract rate; add-ons costed from the Korea ProdReq.

Package (Basic / Standard): one line per pax, KRW × FX 0.0030, read from the ATK CR 2026 Korea table in KRW
  (contracts/sel/…ATK_CR_2026_Korea_KRW.xlsx, rows "PT 5D4N -BSC" and "PT 5D4N Seoul Standard"; tools/korea_cr.py).
  Basic 2–25 pax, Standard 2–42 pax.
  Child: extra bed 75%, no bed 50% of adult rate; infant FOC (same CR).
Add-ons: ~/.claude/skills/prodreqkorea/references/prodreq.md §7–§8 — selling as listed, cost from the
  ProdReq cost column or its KRW rate × FX (the same 0.0030 as the CR). No rate in the ProdReq → cost left empty (shown as cost?).
Self Tour (ATK-ST) is not in the CR or the ProdReq; it keeps the costs already in the hub.

    python3 tools/build_sel.py --by product

Run only when the ATK CR xlsx changes; it rewrites SEL in data/data.json.
"""
import argparse, datetime, json, os, sys

sys.path.insert(0, os.path.dirname(__file__))
import korea_cr

FX = korea_cr.FX   # KRW → MYR for the CR and for add-on costs quoted in KRW
CR_FILE, _ROWS = korea_cr.load("SEL")
CR = {"BSC": _ROWS["PT 5D4N -BSC F&E Day x 2"], "STD": _ROWS["PT 5D4N Seoul Standard"]}   # (KRW list from 2 pax, SGL KRW)
K = lambda krw: round(krw * FX, 2)
ADDONS = [  # category, label, cost RM (None = no rate), selling RM, per, notes
    ("Visa", "K-ETA", 27, 35, "pax", "ProdReq §8.1 (complimentary 1x in the package)"),
    ("Insurance", "TripCare 360 Individual (1–5 days)", 40.50, 64.00, "policy", "ProdReq §8.2 · Etiqa Area 2"),
    ("Insurance", "TripCare 360 Individual (6–10 days)", 58.87, 88.50, "policy", "ProdReq §8.2"),
    ("Insurance", "TripCare 360 Couple (1–5 days)", 77.25, 113.00, "policy", "ProdReq §8.2"),
    ("Insurance", "TripCare 360 Couple (6–10 days)", 122.87, 160.50, "policy", "ProdReq §8.2"),
    ("Insurance", "TripCare 360 Family (1–5 days)", 100.12, 143.50, "policy", "ProdReq §8.2"),
    ("Insurance", "TripCare 360 Family (6–10 days)", 153.62, 201.50, "policy", "ProdReq §8.2"),
    ("Insurance", "TripCare 360 Senior (1–5 days)", 141.62, 185.50, "policy", "ProdReq §8.2"),
    ("Insurance", "TripCare 360 Senior (6–10 days)", 201.62, 265.50, "policy", "ProdReq §8.2"),
    ("Connectivity", "Pocket Wifi 3GB (4G) RoamingMan", 40, 70, "day", "ProdReq §8.3"),
    ("Connectivity", "Pocket Wifi 10GB (5G)", 65, 120, "day", "ProdReq §8.3"),
    ("Connectivity", "Luggage Tracker — Silver", 14.5, 20, "unit", "ProdReq §8.3"),
    ("Connectivity", "Luggage Tracker — Gold", 29, 40, "unit", "ProdReq §8.3"),
    ("Connectivity", "Luggage Tracker — Platinum", 44, 55, "unit", "ProdReq §8.3"),
    ("Connectivity", "Luggage Tracker — Diamond", 58, 70, "unit", "ProdReq §8.3"),
    ("Activity", "Hanbok Rental @ Gyeongbok Palace", None, 80, "pax", "ProdReq §8.4 · no cost rate in the ProdReq"),
    ("Activity", "Everland ticket", K(40700), 140, "pax", "ProdReq §8.4 · cost Everland FIT 40,700 KRW"),
    ("Activity", "Lotte World Seoul ticket", K(30000), 100, "pax", "ProdReq §8.4 · cost 30,000 KRW"),
    ("Activity", "Snowyland (Vivaldi entrance)", K(35000), 150, "pax", "ProdReq §8.4 · cost 35,000 KRW"),
    ("Flight & guide", "Domestic flight Seoul↔Jeju", K(110000), 300, "pax/way", "ProdReq §8.5 · cost 110,000 KRW; 15kg + 7kg"),
    ("Flight & guide", "Airport transfer Hotel/ICN ↔ Gimpo (1–6 pax)", K(99000), 360, "way", "ProdReq §8.5 · cost Gimpo Starex 99,000 KRW"),
    ("Flight & guide", "Airport transfer Hotel/ICN ↔ Gimpo (7–9 pax)", None, 700, "way", "ProdReq §8.5 · no 7–9 pax Gimpo rate"),
    ("Flight & guide", "Korean tour guide only (F&E day)", K(300000 + 15000), 1297, "day", "ProdReq §8.5 · cost guide 300,000 + meal 15,000 KRW"),
    ("Flight & guide", "Malay student guide (F&E day)", None, 797, "day", "ProdReq §8.5 · no cost rate"),
    ("Day tour", "Airport transfer (1–6 pax)", K(110000), 797, "transport", "ProdReq §8.6 · cost ICN Starex 110,000 KRW"),
    ("Day tour", "Airport transfer (7–10 pax)", K(220000), 1497, "transport", "ProdReq §8.6 · cost Starex + luggage vehicle 220,000 KRW"),
    ("Day tour", "Driving guide Seoul (1–8 pax)", K(350000), 1200, "transport", "ProdReq §8.6 · cost 350,000 KRW"),
    ("Day tour", "Driving guide outskirt — Nami (1–8 pax)", K(400000), 1400, "transport", "ProdReq §8.6 · cost 400,000 KRW"),
    ("Day tour", "Driving guide outskirt — Everland (1–8 pax)", K(400000), 1400, "transport", "ProdReq §8.6 · cost 400,000 KRW"),
    ("Day tour", "Driving guide outskirt — Vivaldi / Elysian / Eobi (1–8 pax)", K(450000), 1400, "transport", "ProdReq §8.6 · cost Gangwon 450,000 KRW"),
    ("Day tour", "Driving outskirt Busan–Seoul (Solati 10–13 pax)", None, 3787, "transport", "ProdReq §8.6 · no Solati Busan–Seoul rate"),
    ("Day tour", "Driver only — Seoul", None, 1697, "transport", "ProdReq §8.6 · vehicle not stated"),
    ("Day tour", "Driver only — Nami", None, 1797, "transport", "ProdReq §8.6 · vehicle not stated"),
    ("Day tour", "Driver only — Everland", None, 1797, "transport", "ProdReq §8.6 · vehicle not stated"),
    ("Day tour", "Driver only — Vivaldi", None, 1997, "transport", "ProdReq §8.6 · vehicle not stated"),
    ("Swap (Standard)", "Everland swap into D2/D3/D4", None, 160, "pax", "ProdReq §10 · cost depends on pax"),
    ("Swap (Standard)", "Vivaldi Ski Park swap (2 pax)", None, 290, "pax", "ProdReq §10"),
    ("Swap (Standard)", "Vivaldi Ski Park swap (3+ pax)", None, 240, "pax", "ProdReq §10"),
    ("Hotel & meals", "Add 1 night 3★ (normal)", K(90000), 250, "pax/night", "ProdReq §7 · cost hotel 90,000 KRW"),
    ("Hotel & meals", "Add 1 night 4★ (normal)", None, 400, "pax/night", "ProdReq §7 · no 4★ cost rate"),
    ("Hotel & meals", "4★ upgrade (Migliore Myeongdong)", None, 100, "pax/night", "ProdReq §6"),
    ("Hotel & meals", "Ski resort overnight", None, 500, "pax/night", "ProdReq §6"),
    ("Hotel & meals", "Single supplement — Basic", K(CR["BSC"][1]), 1000, "pax", f"Selling ProdReq §4 · cost ATK CR 2026 SGL sppl {CR['BSC'][1]:,.0f} KRW"),
    ("Hotel & meals", "Single supplement — Standard", K(CR["STD"][1]), 1000, "pax", f"Selling ProdReq §4 · cost ATK CR 2026 SGL sppl {CR['STD'][1]:,.0f} KRW"),
    ("Hotel & meals", "Add breakfast", None, 40, "meal", "ProdReq §7"),
    ("Hotel & meals", "Add lunch (normal)", K(15000), 50, "meal", "ProdReq §7 · cost 15,000 KRW"),
    ("Hotel & meals", "Add dinner (normal)", K(15000), 50, "meal", "ProdReq §7 · cost 15,000 KRW"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--by", default="product")
    a = ap.parse_args()
    data = json.load(open("data/data.json"))
    hist = json.load(open("data/history.json"))
    d = next(x for x in data["destinations"] if x["code"] == "SEL")
    d["fx"] = [f for f in d["fx"] if f["id"] != "KRW"] + [
        {"id": "KRW", "label": "KRW → MYR", "value": FX, "locked": True, "source": "PO, 5 Oct 2026 (ATK CR in KRW × 0.0030)"}]
    d["rates"] = []
    d["nights"] = 4
    d["source"] = "ATK CR 2026 Korea · add-ons: ProdReq Korea · Self Tour: hub"
    d["note"] = ("Basic / Standard cost = ATK CR 2026 per pax in KRW × 0.0030. CR seasonal discount/upcharge for BSC & STD "
                 "(Jan −RM200, Feb −RM200, 21–31 Dec +RM200) is not applied here.")
    tables = [t for t in d["tables"] if t["id"].startswith("ATK-ST__")]
    variants = []
    for code, label in (("BSC", "ATK · Basic (contract rate)"), ("STD", "ATK · Standard (contract rate)")):
        tid, (krw, sgl) = f"CR-{code}", CR[code]
        pmax = 1 + len(krw)
        tables.append({"id": tid, "label": f"ATK contract rate · {code} (KRW)", "group": "ATK contract rate", "fx": "KRW",
                       "values": {str(p): v for p, v in zip(range(2, 2 + len(krw)), krw)}})
        variants.append({"id": f"ATK-{code}", "label": label, "supplier": "ATK", "paxMin": 2, "paxMax": pmax,
                         "hotel": "3★ hotel outskirt (budget 60,000 KRW/pax/night)", "notes": f"ATK CR 2026 in KRW × {FX} · SGL sppl {sgl:,.0f} KRW · {CR_FILE}",
                         "components": [{"key": "cr", "label": "ATK contract rate", "per": "pax", "expr": f"T['{tid}']"}]})
    variants.append(next(v for v in d["variants"] if v["id"] == "ATK-ST"))
    d["tables"], d["variants"] = tables, variants
    for p in d["packages"]:
        p["label"] = {"atk-bsc": "Seoul Basic 5D4N", "atk-std": "Seoul Standard 5D4N", "atk-st": "Seoul Self Tour 5D4N"}[p["id"]]
        if p["id"] in ("atk-bsc", "atk-std"):   # CR: extra bed 75%, no bed 50%, infant FOC
            p["rules"]["cwbCost"] = {"type": "pct", "value": 0.75}
            p["rules"]["cnbCost"] = {"type": "pct", "value": 0.5}
            p["rules"]["infantCost"] = {"type": "flat", "value": 0}
    d["addons"] = [{"id": f"sel-p{i:02d}", "category": c, "label": l, "cost": cost, "selling": sell, "per": per, "notes": n}
                   for i, (c, l, cost, sell, per, n) in enumerate(ADDONS, 1)]
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    data["version"] += 1; data["updatedAt"] = now; data["updatedBy"] = a.by
    hist["entries"].append({"v": data["version"], "at": now, "by": a.by, "rebase": True, "changes": [],
                            "note": "Seoul cost = ATK CR 2026; add-ons from the Korea ProdReq (rebuilt: SEL)",
                            "summary": ["Seoul Basic (2–25 pax) / Standard (2–42 pax): cost = ATK CR 2026 per pax in KRW × 0.0030, one line",
                                        "Child cost per CR: extra bed 75%, no bed 50%, infant FOC",
                                        f"Add-ons: {len(ADDONS)} items from ProdReq §7–§8 (cost from ProdReq, KRW × {FX})"]})
    for f, o in (("data/data.json", data), ("data/history.json", hist)):
        open(f, "w").write(json.dumps(o, indent=1, ensure_ascii=False) + "\n")
    print("SEL rebuilt, v", data["version"])


if __name__ == "__main__":
    main()
