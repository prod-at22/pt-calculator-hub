#!/usr/bin/env python3
"""Generic R&D workbook -> calculator destination extractor.

The R&D Costing tabs compute catalog / selling / margin with formulas that differ per
destination (IF chains on the TO name, LEFT/RIGHT/SEARCH tests, per-TO child rules,
tier-upgrade cells). Instead of re-implementing each one, we let the workbook compute
itself: for every TO we write its name into Costing!C2 ("PILIH TO"), recalculate the
copy with LibreOffice, and read the Costing rows. Those numbers are the R&D sheet's own.

Cost components come from the CR tab (recalculated values) and must add up to the
Costing tab's adult Cost_Per_Pax for every pax; if they do not, the destination falls
back to one "Total cost" component and the mismatch is reported.

    python3 tools/extract_rd.py --work <dir> [--only CODE ...]   # writes <dir>/dest/<CODE>.json
"""
import argparse, json, os, re, shutil, subprocess, sys
import openpyxl

RD_ROOT = os.path.expanduser("~/Downloads/PT DESTINASI R&D REFORMAT")
SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice"

# folder -> (code, display name, duration)
DESTS = {
    "ACEH PT(update catalog)": ("ACEH", "Aceh", "4D3N"),
    "ACEH SABANG (update catalog)": ("ACEHSBG", "Aceh - Sabang", "5D4N"),
    "BALI": ("DPS", "Bali", "4D3N"),
    "BANGKOK": ("BKK", "Bangkok", "4D3N"),
    "BEIJING": ("PEK", "Beijing", "5D4N"),
    "DALAT MUINE HCM": ("DLMNHCM", "HCM - Dalat - Muine", "4D3N / 5D4N"),
    "DANANG HOI AN": ("DADH", "Danang - Hoi An", "4D3N / 5D4N"),
    "HANOI SAPA HALONG": ("HNSH", "Hanoi - Sapa - Halong Bay", "4D3N / 5D4N"),
    "HOKKAIDO SAPPORO": ("CTS", "Hokkaido", "5D4N"),
    "ISTANBUL BURSA": ("ISTBUR", "Istanbul - Bursa", "5D4N"),
    "ISTANBUL CAPPADOCIA": ("ISTCAP", "Istanbul - Cappadocia", "6D5N"),
    "JAKARTA BANDUNG": ("JBDO", "Jakarta - Bandung", "4D3N"),
    "JEJU": ("JJU", "Jeju", "4D3N"),
    "JEJU UDO": ("JJUO", "Jeju - Udo", "5D4N"),
    "JOGJAKARTA": ("JOG", "Jogjakarta", "4D3N"),
    "KK KUNDASANG": ("KKK", "KK Kundasang", "3D2N / 4D3N"),
    "KRABI": ("KBV", "Krabi", "4D3N"),
    "LOMBOK": ("LOP", "Lombok", "4D3N"),
    "MALDIVES": ("MLE", "Maldives", "4D3N"),
    "MEDAN LAKE TOBA": ("LTOBA", "Medan - Lake Toba", "4D3N"),
    "MELBOURNE": ("MEL", "Melbourne", "5D4N"),
    "NEW ZEALAND": ("NSNZ", "New Zealand", "6D5N – 10D9N"),
    "OSAKA": ("OSK", "Osaka", "5D4N"),
    "PADANG BUKITTINGGI": ("PDG", "Padang - Bukittinggi", "4D3N"),
    "PERHENTIAN": ("PHT", "Perhentian", "3D2N"),
    "PERTH": ("PER", "Perth", "5D4N / 6D5N"),
    "PHU QUOC": ("PQC", "Phu Quoc", "4D3N / 5D4N"),
    "PHUKET": ("PHU", "Phuket", "4D3N"),
    "SEMPORNA": ("SEM", "Semporna", "3D2N / 4D3N"),
    "SEOUL": ("SEL", "Seoul", "5D4N"),
    "SEOUL JEJU": ("SELJJU", "Seoul - Jeju", "6D5N"),
    "SURABAYA BROMO MALANG": ("SUBB", "Surabaya - Bromo - Malang", "4D3N"),
    "SWITZERLAND": ("SWS", "Switzerland", "7D6N"),
    "TOKYO OSAKA": ("KIX", "Tokyo - Kyoto - Osaka", "7D6N"),
    "TURKEY": ("TUR", "Turki Klasik", "8D7N"),
    "YUNNAN 4 WILAYAH": ("KMGDLS", "Yunnan 4 Wilayah", "7D6N"),
}
# Project PT sheet, "New PO" where filled, else "Current PO" (merged cells inherit).
PO = {"SEL": "Aiman", "SELJJU": "Aiman", "JJU": "Aiman", "JJUO": "Aiman", "TUR": "Acap", "ISTBUR": "Acap",
      "ISTCAP": "Acap", "HND": "Thania", "KIX": "Thania", "OSK": "Thania", "CTS": "Thania", "DPS": "Fyka",
      "LOP": "Aiman", "JOG": "Aiman", "ACEH": "Fyka", "ACEHSBG": "Fyka", "LTOBA": "Fyka", "PDG": "Fyka",
      "JBDO": "Aiman", "SUBB": "Noora", "DLMNHCM": "Aiman", "PQC": "Aiman", "HNSH": "Aiman", "DADH": "Aiman",
      "MEL": "Acap", "PER": "Acap", "NSNZ": "Acap", "MLE": "Ezie", "KMGDLS": "Mirul", "PEK": "Fyka",
      "BKK": "Noora", "PHU": "Ezie", "KBV": "Ezie", "SWS": "Thania", "KKK": "Fyka", "SEM": "Fyka", "PHT": "Fyka"}
COUNTRY = {"SEL": "Korea", "SELJJU": "Korea", "JJU": "Korea", "JJUO": "Korea", "TUR": "Turki", "ISTBUR": "Turki",
           "ISTCAP": "Turki", "KIX": "Jepun", "OSK": "Jepun", "CTS": "Jepun", "DPS": "Indonesia", "LOP": "Indonesia",
           "JOG": "Indonesia", "ACEH": "Indonesia", "ACEHSBG": "Indonesia", "LTOBA": "Indonesia", "PDG": "Indonesia",
           "JBDO": "Indonesia", "SUBB": "Indonesia", "DLMNHCM": "Vietnam", "PQC": "Vietnam", "HNSH": "Vietnam",
           "DADH": "Vietnam", "MEL": "Australia", "PER": "Australia", "NSNZ": "New Zealand", "MLE": "Maldives",
           "KMGDLS": "China", "PEK": "China", "BKK": "Thailand", "PHU": "Thailand", "KBV": "Thailand",
           "SWS": "Switzerland", "KKK": "Domestik", "SEM": "Domestik", "PHT": "Domestik"}

def phuket_selectors(to):
    """KTT-{Ibis|Marina} {Standard|Budget …} {LowSeason|HighSeason JanApr|HighSeason NovDec} → J2/J3/J4."""
    m = re.match(r"KTT-(Ibis|Marina) (.+) (LowSeason|HighSeason JanApr|HighSeason NovDec)$", to)
    if not m:
        return None
    return {"J2": "4★ Marina" if m.group(1) == "Marina" else "3★ Ibis", "J3": m.group(2),
            "J4": {"LowSeason": "Low Season", "HighSeason JanApr": "High Season JanApr", "HighSeason NovDec": "High Season NovDec"}[m.group(3)]}


SELECTORS = {"PHU": phuket_selectors}
NOTES_EXTRA = []

num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)


def pick_file(folder):
    d = os.path.join(RD_ROOT, folder)
    fs = [f for f in os.listdir(d) if f.endswith(".xlsx") and not re.search(r"_v\d+\.xlsx$|asal|ATK-OPS", f, re.I)
          and re.search(r"reformat|betulkan|format 1", f, re.I)]
    return os.path.join(d, max(fs, key=lambda f: os.path.getmtime(os.path.join(d, f)))) if fs else None


def sheet(wb, name):
    for s in wb.sheetnames:
        if s.strip() == name:
            return wb[s]
    return None


def cr_layout(ws):
    for r in range(1, 15):
        vals = [str(c.value or "").strip() for c in ws[r]]
        if "Pax" in vals and any(v.startswith("TO") for v in vals):
            return r, vals
    for r in range(1, 15):  # one row per TO, same cost for every pax (Maldives)
        vals = [str(c.value or "").strip() for c in ws[r]]
        if vals and vals[0] == "TO_Name":
            return r, ["Pax"] + vals
    return None, None


def recalc(paths, outdir, profile):
    os.makedirs(outdir, exist_ok=True)
    for i in range(0, len(paths), 40):
        subprocess.run([SOFFICE, "-env:UserInstallation=file://" + profile, "--headless", "--calc",
                        "--convert-to", "xlsx", "--outdir", outdir] + paths[i:i + 40],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def costing_rows(ws):
    """Read Costing sections -> {adult|cwb|cnb: {pax: (cost, catalog, selling)}, infant: (cost, catalog, selling)}"""
    out, sec = {}, None
    for row in ws.iter_rows(min_row=4, values_only=True):
        a = row[0]
        if isinstance(a, str):
            u = a.upper()
            if "PAX" == u.strip() or u.strip().startswith("PAX"):
                continue
            if "CWB" in u or "WITH BED" in u: sec = "cwb"
            elif "CNB" in u or "NO BED" in u: sec = "cnb"
            elif "INFANT" in u: sec = "infant"
            elif "ADULT" in u: sec = "adult"
            elif u.strip() == "ANY" and sec == "infant":
                out["infant"] = tuple(row[2:5])
            continue
        if num(a) and sec in ("adult", "cwb", "cnb"):
            out.setdefault(sec, {})[int(a)] = tuple(row[2:5])
    return out


def components(hdr, to_rows):
    """Split CR columns into components. Returns ([(col, "pax"|"group")], ok, why).

    Walk the numeric columns between TO_Name and Total_Cost left to right:
    - a column equal to the per-pax sum of the columns kept so far is a subtotal → skip
      (Korea "Ground_Cost", Japan "Ground (MYR)" = Cost/Pax);
    - a column equal to that raw sum ÷ pax is a Cost/Pax → the columns before it are
      group totals (Japan, Bali, Perth, Lombok);
    - anything else is a component in RM per pax.
    The kept components must then add up to Total_Cost on every row."""
    ti = next(i for i, h in enumerate(hdr) if h.startswith("TO"))
    tot = total_col(hdr)
    if tot is None:
        return None, False, "no Total column"
    rows = [r for r in to_rows if num(r[tot])]
    if not rows:
        return None, False, "no Total_Cost values"
    cand = [i for i in range(ti + 1, tot) if hdr[i] and all(num(r[i]) or r[i] in (None, "") for r in rows)]
    v = lambda r, i: r[i] if num(r[i]) else 0
    comps = []
    for i in cand:
        if comps:
            pp = lambda r: sum(v(r, j) / r[0] if b == "group" else v(r, j) for j, b in comps)
            raw = lambda r: sum(v(r, j) for j, _ in comps)
            if all(abs(v(r, i) - pp(r)) < 0.6 for r in rows):
                continue
            if all(abs(v(r, i) - raw(r) / r[0]) < 0.6 for r in rows):
                comps = [(j, "group") for j, _ in comps]
                continue
        comps.append((i, "pax"))
    check = lambda cs: all(abs(sum(v(r, j) / r[0] if b == "group" else v(r, j) for j, b in cs) - r[tot]) < 0.6 for r in rows)
    ok = check(comps)
    if not ok:  # group totals with per-pax tipping / K-ETA next to them (Hokkaido)
        alt = [(j, "pax" if re.search(r"tip|k-eta|keta", hdr[j], re.I) else "group") for j, _ in comps]
        if check(alt):
            comps, ok = alt, True
        else:  # group costs shared over a capped head-count, e.g. ÷ MIN(pax,10) in Hokkaido
            div = {}
            for r in rows:
                g = sum(v(r, j) for j, b in alt if b == "group"); pp = sum(v(r, j) for j, b in alt if b == "pax")
                d = g / (r[tot] - pp) if r[tot] - pp else 0
                if d <= 0 or abs(d - round(d)) > 0.01 or round(d) > r[0]:
                    div = None; break
                div[r[0]] = round(d)
            if div:
                comps, ok = [(j, b if b == "pax" else ("div", div)) for j, b in alt], True
                cap = max(div.values())
                if cap < max(div):
                    NOTES_EXTRA.append("Group costs are shared over at most %d pax in the R&D (÷ MIN(pax,%d))." % (cap, cap))
    return comps, ok, "" if ok else "components do not add up to Total_Cost"


def total_col(hdr):
    t = next((i for i, h in enumerate(hdr) if re.match(r"total", h, re.I)), None)
    if t is None:  # Hokkaido: last "Cost/Pax" column is the total
        cp = [i for i, h in enumerate(hdr) if re.match(r"cost/pax", h, re.I)]
        t = cp[-1] if cp else None
    return t


def nice(label):
    """CR header → display label: 'Ground_Cost (MYR)' → 'Ground Cost'."""
    return re.sub(r"\s*\((MYR|RM)\)", "", label).replace("_", " ").strip()


def slug(s):
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")[:40] or "x"


def extract(folder, work, notes):
    code, name, duration = DESTS[folder]
    src = pick_file(folder)
    if not src:
        notes.append("%s: no R&D file" % code); return None
    wf = openpyxl.load_workbook(src)
    cr_f, cs_f = sheet(wf, "CR"), sheet(wf, "Costing")
    if cr_f is None or cs_f is None:
        notes.append("%s: no CR / Costing tab" % code); return None
    if isinstance(cs_f["C2"].value, str) and cs_f["C2"].value.startswith("=") and code not in SELECTORS:
        notes.append("%s: Costing picks the TO with extra selectors (C2 is a formula) — needs a manual mapping" % code)
        return None
    # recalculated CR values
    base = os.path.join(work, "base", code + ".xlsx"); os.makedirs(os.path.dirname(base), exist_ok=True)
    shutil.copy(src, base)
    return {"code": code, "name": name, "duration": duration, "src": src, "base": base}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    work = os.path.abspath(a.work); profile = os.path.join(work, "lo-profile")
    notes, jobs = [], []
    for folder, (code, _, _) in DESTS.items():
        if a.only and code not in a.only:
            continue
        j = extract(folder, work, notes)
        if j: jobs.append(j)
    # 1) recalc base copies, find TOs
    recalc([j["base"] for j in jobs], os.path.join(work, "base_out"), profile)
    percopy = []
    for j in jobs:
        wv = openpyxl.load_workbook(os.path.join(work, "base_out", j["code"] + ".xlsx"), data_only=True)
        cr = sheet(wv, "CR"); hr, hdr = cr_layout(cr)
        if not hr:
            notes.append("%s: CR header row not found" % j["code"]); j["skip"] = True; continue
        rows, titles, cur = {}, {}, None
        flat = hdr[1] == "TO_Name" and hdr[0] == "Pax" and str(cr.cell(hr, 1).value).strip() == "TO_Name"
        for row in cr.iter_rows(min_row=hr + 1, values_only=True):
            if flat:
                if isinstance(row[0], str) and row[0].strip() and any(num(x) for x in row[1:]):
                    for p in range(1, 41):
                        rows.setdefault(row[0], []).append((p,) + tuple(row))
                    titles.setdefault(row[0], row[0])
                continue
            if isinstance(row[0], str) and row[0].strip():
                cur = row[0].strip()
            elif num(row[0]) and row[1]:
                rows.setdefault(row[1], []).append(row)
                titles.setdefault(row[1], cur)
        j.update(hr=hr, hdr=hdr, rows=rows, titles=titles)
        # one copy per TO with Costing!C2 = TO
        for to in rows:
            wb = openpyxl.load_workbook(j["base"])
            if j["code"] in SELECTORS:
                sel = SELECTORS[j["code"]](to)
                if not sel:
                    notes.append("%s %s: cannot map TO to selectors" % (j["code"], to)); continue
                for cell, val in sel.items():
                    sheet(wb, "Costing")[cell].value = val
            else:
                sheet(wb, "Costing")["C2"].value = to
            p = os.path.join(work, "per", "%s__%s.xlsx" % (j["code"], slug(to)))
            os.makedirs(os.path.dirname(p), exist_ok=True); wb.save(p)
            percopy.append(p); j.setdefault("copies", {})[to] = p
    recalc(percopy, os.path.join(work, "per_out"), profile)
    os.makedirs(os.path.join(work, "dest"), exist_ok=True)
    for j in jobs:
        if j.get("skip"):
            continue
        try:
            out = build_dest(j, work, notes)
        except Exception as e:  # report and carry on with the other destinations
            notes.append("%s: extraction failed (%s: %s)" % (j["code"], type(e).__name__, e)); out = None
        if out:
            json.dump(out, open(os.path.join(work, "dest", j["code"] + ".json"), "w"), indent=1, ensure_ascii=False)
    json.dump(notes, open(os.path.join(work, "notes.json"), "w"), indent=1, ensure_ascii=False)
    for n in notes:
        print("NOTE", n)


def build_dest(j, work, notes):
    code, hdr = j["code"], j["hdr"]
    NOTES_EXTRA.clear()
    variants, tables, packages, ok_all = [], [], [], True
    per = {}
    for to, rows in j["rows"].items():
        p = os.path.join(work, "per_out", os.path.basename(j["copies"][to]))
        if not os.path.exists(p):
            notes.append("%s %s: recalculation failed" % (code, to)); continue
        cs = sheet(openpyxl.load_workbook(p, data_only=True), "Costing")
        if code in SELECTORS and cs["C2"].value != to:
            notes.append("%s %s: selectors resolved to %r" % (code, to, cs["C2"].value)); continue
        per[to] = {"rows": costing_rows(cs), "r3": [c.value for c in cs[3]][:8], "r2": [c.value for c in cs[2]][:8]}
    if total_col(hdr) is None:
        notes.append("%s: CR has no Total_Cost column (headers: %s)" % (code, ", ".join(h for h in hdr if h)))
        return None
    hi = {h: i for i, h in enumerate(hdr)}
    hotel_i = next((i for i, h in enumerate(hdr) if h.lower().startswith("hotel")), None)
    note_i = hi.get("Notes")
    compvals = {}
    for to, rows in j["rows"].items():
        if to not in per:
            continue
        adult = per[to]["rows"].get("adult", {})
        comps, ok, why = components(hdr, rows)
        vid = slug(to)
        # cost truth = Costing adult Cost_Per_Pax; pax covered = numeric cost there
        cost_truth = {p: v[0] for p, v in adult.items() if num(v[0])}
        crow = {int(r[0]): r for r in rows}
        tot_i = total_col(hdr)
        if ok:
            bad = [p for p, c in cost_truth.items() if p in crow and abs(crow[p][tot_i] - c) > 0.6]
            if bad:
                ok, why = False, "CR Total_Cost differs from Costing cost at pax %s" % bad[:5]
        cvals = []
        if ok and comps:
            for jcol, basis in comps:
                label = hdr[jcol]
                tid = "%s__%s" % (vid, slug(label))
                vals = {}
                for p, r in crow.items():
                    v = r[jcol] or 0
                    if isinstance(basis, tuple):  # shared over a capped head-count
                        if p not in basis[1]: continue
                        vals[str(p)] = round(v / basis[1][p], 4)
                    else:
                        vals[str(p)] = round(v / p if basis == "group" else v, 4)
                tables.append({"id": tid, "label": "%s · %s" % (to, nice(label)), "unit": "MYR/pax", "fx": "MYR",
                               "group": to, "values": vals})
                compvals.setdefault(to, {})[slug(label).lower()] = {int(p): x for p, x in vals.items()}
                cvals.append({"key": slug(label).lower(), "label": nice(label), "per": "pax", "expr": "T['%s']" % tid})
        else:
            ok_all = False
            notes.append("%s %s: %s → single 'Total cost' component" % (code, to, why))
            tid = "%s__total" % vid
            src = cost_truth or {p: r[tot_i] for p, r in crow.items()}
            tables.append({"id": tid, "label": "%s · Total cost" % to, "unit": "MYR/pax", "fx": "MYR", "group": to,
                           "values": {str(p): round(v, 4) for p, v in src.items() if num(v)}})
            cvals.append({"key": "total", "label": "Total cost", "per": "pax", "expr": "T['%s']" % tid})
        paxes = sorted(p for p in crow if num(crow[p][tot_i]))
        variants.append({"id": vid, "label": to, "supplier": (j["titles"].get(to) or to)[:80],
                         "paxMin": paxes[0], "paxMax": paxes[-1],
                         "hotel": next((str(r[hotel_i]) for r in rows if hotel_i is not None and r[hotel_i]), ""),
                         "notes": next((str(r[note_i]) for r in rows if note_i is not None and r[note_i]), ""),
                         "components": cvals})
    # packages: one per TO; TOs priced on disjoint pax ranges with the same tier word are merged
    def priced(to):
        return sorted(p for p, v in per[to]["rows"].get("adult", {}).items() if num(v[1]))
    def tier(to):
        m = re.search(r"\b(STD|STANDARD|BSC|BASIC)\b", to.upper())
        return {"STANDARD": "STD", "BASIC": "BSC"}.get(m.group(1), m.group(1)) if m else None
    tos = [t for t in j["rows"] if t in per and priced(t)]
    used = set()
    for t in tos:
        if t in used:
            continue
        group = [t]
        for u in tos:
            if u != t and u not in used and tier(u) and tier(u) == tier(t) and not set(priced(u)) & set(priced(t)) \
                    and all(not set(priced(u)) & set(priced(g)) for g in group):
                group.append(u)
        used.update(group)
        group.sort(key=lambda g: priced(g)[0])
        pricing = {"adult": {}, "cwb": {}, "cnb": {}, "source": {}, "infant": 0}
        assign, costs = [], {}
        for g in group:
            pr = per[g]["rows"]; ps = priced(g)
            assign.append({"from": ps[0], "to": ps[-1], "variant": slug(g)})
            for k in ("adult", "cwb", "cnb"):
                for p, v in pr.get(k, {}).items():
                    if p in ps and num(v[1]):
                        pricing[k][str(p)] = v[1]
                        pricing["source"].setdefault(k, {})[str(p)] = "rd"
                        costs.setdefault(k, {})[p] = v
            inf = pr.get("infant")
            if inf and num(inf[1]):
                pricing["infant"] = inf[1]
        r2, r3 = per[group[0]]["r2"], per[group[0]]["r3"]
        disc = r2[5] if num(r2[5]) else 0
        upgrade = r3[7] if num(r3[7]) else 0
        # Costing catalog already includes the tier upgrade: store base catalog = catalog − upgrade
        for k in ("adult", "cwb", "cnb"):
            for p in list(pricing[k]):
                pricing[k][p] = round(pricing[k][p] - upgrade, 2)
        rules = {"discountTier2": disc, "tierUpgrade": upgrade}
        # selling check: R&D selling must equal catalog − discount (+upgrade); else discount is 0 for this package
        a = costs.get("adult", {})
        if a:
            p0 = min(a); c, cat, sell = a[p0]
            if num(sell) and num(cat) and abs((cat - disc) - sell) > 0.5:
                rules["discountTier2"] = round(cat - sell, 2)
                if abs(cat - sell) > 0.5 and disc and abs(cat - sell - disc) > 0.5:
                    notes.append("%s %s: selling ≠ catalog − tier-2 discount; used catalog − selling = %s" % (code, group[0], cat - sell))
        # child cost rules derived from the Costing numbers
        for k, lbl in (("cwb", "cwbCost"), ("cnb", "cnbCost")):
            rules[lbl] = derive_rule(a, costs.get(k, {}), r3, k) or derive_partial(a, costs.get(k, {}), compvals.get(group[0], {}))
            if rules[lbl] is None:
                rules[lbl] = rule_from_header(r3, k)
                if not costs.get(k):
                    # no CWB/CNB price in the R&D (honeymoon packages): leave it empty, never invent one
                    notes.append("%s %s: no %s price in the R&D (left empty)" % (code, group[0], k.upper()))
        inf = per[group[0]]["rows"].get("infant")
        rules["infantCost"] = {"type": "flat", "value": inf[0] if inf and num(inf[0]) else 0}
        label = group[0] if len(group) == 1 else " + ".join(group)
        packages.append({"id": slug(label).lower(), "label": label, "catalog": None, "assign": assign,
                         "pricing": pricing, "rules": rules})
    if not packages:
        notes.append("%s: no priced package found" % code); return None
    verify(code, packages, variants, tables, per, notes)
    # R&D numbers per TO, for tests/test_calc.js
    truth = {to: {k: {str(p): list(v) for p, v in per[to]["rows"].get(k, {}).items()} for k in ("adult", "cwb", "cnb")}
             for to in per}
    os.makedirs(os.path.join(work, "truth"), exist_ok=True)
    json.dump({"code": code, "variants": {slug(to): to for to in per}, "rows": truth},
              open(os.path.join(work, "truth", code + ".json"), "w"), default=str)
    wb = openpyxl.load_workbook(j["src"])
    sys.path.insert(0, os.path.dirname(__file__))
    from build_data import addons
    return {"code": code, "name": j["name"], "country": COUNTRY.get(code, ""), "duration": j["duration"], "nights": 0,
            "po": PO.get(code, ""), "source": os.path.relpath(j["src"], RD_ROOT),
            "note": " ".join(([] if ok_all else ["Some TOs could not be split into components; they show one Total cost line."]) + NOTES_EXTRA),
            "fx": [{"id": "MYR", "label": "MYR", "value": 1, "locked": True}], "rates": [], "tables": tables,
            "variants": variants, "packages": packages, "addons": addons(wb, code)}


def verify(code, packages, variants, tables, per, notes):
    """Recompute cost / selling the way the page does and compare with the R&D Costing numbers."""
    T = {t["id"]: t["values"] for t in tables}
    vmap = {v["id"]: v for v in variants}
    def cost(vid, p):
        v = vmap.get(vid)
        if not v: return None
        tot = 0
        for c in v["components"]:
            tid = re.search(r"T\['(.+)'\]", c["expr"]).group(1)
            x = T[tid].get(str(p))
            if x is None: return None
            tot += x
        return tot
    def rule(r, a, vid=None, p=None):
        if r["type"] == "pct" and r.get("on"):
            on = sum(T[re.search(r"T\['(.+)'\]", c["expr"]).group(1)].get(str(p), 0)
                     for c in vmap[vid]["components"] if c["key"] in r["on"])
            return a - on + on * r["value"]
        return a * r["value"] if r["type"] == "pct" else a - r["value"] if r["type"] == "minus" else r["value"]
    checked = bad = 0
    nocost = {}
    for pk in packages:
        r = pk["rules"]
        for asg in pk["assign"]:
            to = vmap[asg["variant"]]["label"]
            for k in ("adult", "cwb", "cnb"):
                for p, (c_rd, cat_rd, sell_rd) in per[to]["rows"].get(k, {}).items():
                    if not (asg["from"] <= p <= asg["to"]) or not num(sell_rd):
                        continue
                    a = cost(asg["variant"], p)
                    c = a if k == "adult" else (rule(r[k + "Cost"], a, asg["variant"], p) if a is not None else None)
                    base = pk["pricing"][k].get(str(p))
                    sell = None if base is None else base + r["tierUpgrade"] - r["discountTier2"]
                    if c is None and (not num(c_rd) or c_rd == 0):
                        nocost.setdefault(to, []).append(p) if k == "adult" else None
                        continue
                    checked += 1
                    if c is None or not num(c_rd) or abs(c - c_rd) > 0.6 or sell is None or abs(sell - sell_rd) > 0.6:
                        bad += 1
                        if bad <= 3:
                            notes.append("%s %s %s pax %d: page cost %s / selling %s vs R&D %s / %s" % (code, to, k, p, c, sell, c_rd, sell_rd))
    for to, ps in nocost.items():
        notes.append("%s %s: R&D has a catalog price but no cost for pax %d–%d (R&D shows cost 0); page shows it as missing" % (code, to, min(ps), max(ps)))
    notes.append("%s: verified %d rows against R&D Costing, %d mismatches" % (code, checked, bad))


def derive_rule(adult, child, r3, k):
    pairs = [(adult[p][0], child[p][0]) for p in child if p in adult and num(adult[p][0]) and num(child[p][0])]
    if len(pairs) < 2:
        return None
    ratios = [c / a for a, c in pairs if a]
    diffs = [a - c for a, c in pairs]
    if max(ratios) - min(ratios) < 1e-6:
        return {"type": "pct", "value": round(ratios[0], 6)}
    if max(diffs) - min(diffs) < 0.01:
        return {"type": "minus", "value": round(diffs[0], 2)}
    return None


def derive_partial(adult, child, comps):
    """Child cost = v × one component + the other components in full (Aceh, Beijing: % of Ground only)."""
    pax = [p for p in child if p in adult and num(adult[p][0]) and num(child[p][0])]
    if len(pax) < 2:
        return None
    for key, vals in comps.items():
        xs = [(adult[p][0], child[p][0], vals.get(p)) for p in pax]
        if any(c is None or c == 0 for _, _, c in xs):
            continue
        ratios = [(ch - (a - c)) / c for a, ch, c in xs]
        if max(ratios) - min(ratios) < 1e-4:
            return {"type": "pct", "value": round(ratios[0], 6), "on": [key]}
    return None


def rule_from_header(r3, k):
    lab, val = (r3[0], r3[1]) if k == "cwb" else (r3[2], r3[3])
    val = val if num(val) else 1
    if lab and re.search(r"deduct", str(lab), re.I):
        return {"type": "minus", "value": val}
    return {"type": "pct", "value": val}


if __name__ == "__main__":
    main()
