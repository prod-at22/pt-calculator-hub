"""Rebuild Seoul (SEL) Basic / Standard costing rate by rate from the Korea ProdReq (KRW).

Source: ~/.claude/skills/prodreqkorea/references/prodreq.md (PT SEL ProdReq.md on Drive):
  §5.0 ATK charge, §5.1 hotel, §5.2 airport, §5.3 day transport, §5.4 driving guide,
  §5.6 tour guide (9+ pax), §5.8 entrances, §8.1 K-ETA, §4 child cost.
Catalog prices, add-ons and the Self Tour (ATK-ST, not in the ProdReq) are left as they are.

    python3 tools/build_sel_krw.py --by product     # writes data/data.json + a history entry

Keep SEL in --keep on every R&D re-import (tools/merge_dests.py), or the R&D costs come back.
"""
import argparse, datetime, json

FX = 0.00274   # ProdReq §3 reference (Jul 2026); the ProdReq says refresh live per quote
NIGHTS = 4

RATES = [  # id, label, KRW (MYR for K-ETA), unit, group
    ("atk", "ATK / TO charge", 75000, "KRW/pax", "1. ATK"),
    ("hotel3", "3★ hotel with breakfast", 90000, "KRW/pax/night", "2. Hotel"),
    ("icnStarex", "ICN Starex (1–6 pax)", 110000, "KRW/way", "3. Airport transfer"),
    ("lugSeoul", "Luggage vehicle Seoul (7–10 pax)", 110000, "KRW/way", "3. Airport transfer"),
    ("icnSolati", "Seoul Solati 15-seater (11–13 pax)", 250000, "KRW/way", "3. Airport transfer"),
    ("icnMini", "Seoul 25-seater minibus (11–16 pax)", 308000, "KRW/way", "3. Airport transfer"),
    ("icnBus", "Seoul 45-seater bus (17–42 pax)", 440000, "KRW/way", "3. Airport transfer"),
    ("dgSeoul", "Driving guide Seoul (1–8 pax)", 350000, "KRW/day", "4. Driving guide"),
    ("dgNami", "Driving guide Gyeonggi / Nami (1–8 pax)", 400000, "KRW/day", "4. Driving guide"),
    ("solSeoul", "Solati Seoul (10–13 pax)", 440000, "KRW/day", "5. Day transport (9+ pax)"),
    ("solGyeonggi", "Solati Gyeonggi / Paju (10–13 pax)", 495000, "KRW/day", "5. Day transport (9+ pax)"),
    ("miniSeoul", "25-seater Seoul (11–16 pax)", 440000, "KRW/day", "5. Day transport (9+ pax)"),
    ("miniNami", "25-seater Suwon / Nami (11–16 pax)", 550000, "KRW/day", "5. Day transport (9+ pax)"),
    ("busSeoul", "45-seater Seoul (17–42 pax)", 550000, "KRW/day", "5. Day transport (9+ pax)"),
    ("busGyeonggi", "45-seater Gyeonggi / Paju (17–42 pax)", 660000, "KRW/day", "5. Day transport (9+ pax)"),
    ("tg", "Korean tour guide (9+ pax)", 300000, "KRW/day", "6. Tour guide (9+ pax)"),
    ("tgMeal", "Tour guide meal", 15000, "KRW/day", "6. Tour guide (9+ pax)"),
    ("nami", "Nami Island", 16000, "KRW/pax", "7. Entrance"),
    ("gyeongbok", "Gyeongbok Palace", 3000, "KRW/pax", "7. Entrance"),
    ("namsanCable", "Seoul Tower cable car", 15000, "KRW/pax", "7. Entrance"),
    ("keta", "K-ETA (complimentary to guest)", 27, "MYR/pax", "8. Other"),
]

AIRPORT = "2*band(pax,[6,R.icnStarex],[10,R.icnStarex+R.lugSeoul],[13,R.icnSolati],[16,R.icnMini],[42,R.icnBus])"


def transport(seoul_days):
    # D1 Nami + Seoul days. 1–8 pax: driving guide. 9 pax: no vehicle rate in the ProdReq (Solati starts at 10).
    return (f"band(pax,[8,R.dgNami+{seoul_days}*R.dgSeoul],[9,NaN],[13,R.solGyeonggi+{seoul_days}*R.solSeoul],"
            f"[16,R.miniNami+{seoul_days}*R.miniSeoul],[42,R.busGyeonggi+{seoul_days}*R.busSeoul])")


def variant(vid, label, days, entrance_ids, notes):
    ent = "+".join("R." + e for e in entrance_ids)
    return {"id": vid, "label": label, "supplier": "ATK", "paxMin": 2, "paxMax": 30,
            "hotel": "3★ Designers Cheongnyangni / Travelodge Myeongdong or similar", "notes": notes,
            "components": [
                {"key": "airport", "label": "Airport transfer ICN ×2", "per": "group", "expr": AIRPORT},
                {"key": "transport", "label": f"Transport + guide ×{days} days", "per": "group", "expr": transport(days - 1)},
                {"key": "guide", "label": f"Tour guide + meal ×{days} days (9+ pax)", "per": "group", "expr": f"pax>=9?{days}*(R.tg+R.tgMeal):0"},
                {"key": "hotel", "label": "Hotel 3★ ×N nights", "per": "group", "expr": "R.hotel3*N*pax"},
                {"key": "entrance", "label": "Entrance", "per": "group", "expr": f"({ent})*pax"},
                {"key": "atk", "label": "ATK / TO charge", "per": "group", "expr": "R.atk*pax"},
                {"key": "keta", "label": "K-ETA", "per": "group", "expr": "R.keta*pax"},
            ]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--by", default="product")
    a = ap.parse_args()
    data = json.load(open("data/data.json"))
    hist = json.load(open("data/history.json"))
    d = next(x for x in data["destinations"] if x["code"] == "SEL")
    d["fx"] = [f for f in d["fx"] if f["id"] != "KRW"] + [
        {"id": "KRW", "label": "KRW → MYR", "value": FX, "locked": True, "source": "ProdReq Korea §3 (Jul 2026 reference)"}]
    d["rates"] = [{"id": i, "label": l, "value": v, "fx": "MYR" if u.startswith("MYR") else "KRW", "unit": u, "group": g}
                  for i, l, v, u, g in RATES]
    d["nights"] = NIGHTS
    d["source"] = "ProdReq Korea (KRW) · Self Tour: SEOUL/PT_SEL_RD_reformatted.xlsx"
    d["note"] = ("Basic / Standard costed rate by rate from the Korea ProdReq (KRW). 9 pax has no vehicle rate in the "
                 "ProdReq (driving guide stops at 8, Solati starts at 10), so it shows no cost. Self Tour is still the R&D sheet.")
    bsc = variant("ATK-BSC", "ATK · Basic (driving guide D1–D2)", 2, ["nami", "gyeongbok"],
                  "D1 Nami (Gyeonggi rate), D2 Seoul city. 9+ pax: separate vehicle + tour guide.")
    std = variant("ATK-STD", "ATK · Standard (driving guide D1–D4)", 4, ["nami", "gyeongbok", "namsanCable"],
                  "D1 Nami (Gyeonggi rate), D2–D4 Seoul. 9+ pax: separate vehicle + tour guide.")
    st = next(v for v in d["variants"] if v["id"] == "ATK-ST")
    d["variants"] = [bsc, std, st]
    keep = {"ATK-ST"}
    d["tables"] = [t for t in d["tables"] if t["id"].split("__")[0] in keep]
    for p in d["packages"]:
        if p["id"] == "atk-bsc": p["label"] = "Seoul Basic 5D4N"
        if p["id"] == "atk-std": p["label"] = "Seoul Standard 5D4N"
        if p["id"] == "atk-st": p["label"] = "Seoul Self Tour 5D4N"
        if p["id"] in ("atk-bsc", "atk-std"):   # ProdReq §4: CWB 100%, CNB 50% of adult cost, infant FOC
            p["rules"]["cwbCost"] = {"type": "pct", "value": 1}
            p["rules"]["cnbCost"] = {"type": "pct", "value": 0.5}
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    data["version"] += 1; data["updatedAt"] = now; data["updatedBy"] = a.by
    hist["entries"].append({"v": data["version"], "at": now, "by": a.by, "rebase": True, "changes": [],
                            "note": "Seoul Basic/Standard costed from the Korea ProdReq in KRW (rebuilt: SEL)",
                            "summary": ["Seoul: Basic & Standard rebuilt rate by rate from ProdReq Korea (KRW, FX 0.00274)",
                                        "Hotel 90,000/pax/night, airport ICN by pax band (+luggage vehicle 7–10), driving guide 1–8 pax, "
                                        "vehicle + tour guide 10+ pax, entrances, ATK 75,000/pax, K-ETA RM27",
                                        "CWB cost 100%, CNB 50% of adult cost; ATK buffer removed; Self Tour unchanged (R&D)"]})
    for f, o in (("data/data.json", data), ("data/history.json", hist)):
        open(f, "w").write(json.dumps(o, indent=1, ensure_ascii=False) + "\n")
    print("SEL rebuilt, v", data["version"])


if __name__ == "__main__":
    main()
