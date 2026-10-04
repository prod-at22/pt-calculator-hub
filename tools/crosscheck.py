#!/usr/bin/env python3
"""Cross-check catalog (Catalog PT site JSON = transcribed Canva PDF), R&D workbook and the
calculator (data/data.json) for every destination, and write data/flags.json for the hub.

Each flag: {code, package, severity (high|medium|low), area, title, detail, fix}
  high   = a customer-facing price or a cost is wrong / missing
  medium = R&D and catalog disagree on coverage, or a decision is needed
  low    = housekeeping

    node tools/margins.js > <work>/margins.json
    python3 tools/crosscheck.py --fx <work>/fx.json --margins <work>/margins.json
"""
import argparse, datetime, glob, json, os, re, sys

sys.path.insert(0, os.path.dirname(__file__))
from extract_rd import DESTS, RD_ROOT, pick_file

ROOT = os.path.join(os.path.dirname(__file__), "..")
DRIVE = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-product@arbatravel.com/My Drive")
CATALOG = os.path.join(DRIVE, "Catalog PT (new)", "catalogs")

# catalog slug -> (destination code, calculator package id); None = no calculator package
MAP = {
    "aceh": ("ACEH", "asonanggroe-3-star"), "aceh-sabang": ("ACEHSBG", "asonanggroe-3-star"),
    "bali-standard": ("DPS", "alfian-std-3s"), "bali-honeymoon-standard": ("DPS", "alfian-hny-std"),
    "bali-honeymoon-premium": ("DPS", "alfian-hny-prem"), "bangkok-standard": ("BKK", "chiwanon-almas-3-star"),
    "beijing": ("PEK", "tourdechina"), "danang-hoi-an-4d3n": ("DADH", "bismillah-4d3n"),
    "danang-hoi-an-5d4n": ("DADH", "bismillah-5d4n"), "hanoi-sapa": ("HNSH", "ibrahim-4d3n"),
    "hanoi-sapa-halong": ("HNSH", "ibrahim-5d4n"), "hcm-dalat-muine-4d3n": ("DLMNHCM", "ibrahim-4d3n"),
    "hcm-dalat-muine": ("DLMNHCM", "ibrahim-5d4n"), "ho-chi-minh": ("HCM", None),
    "hokkaido-sapporo": ("CTS", "wif-cts"), "istanbul-bursa": ("ISTBUR", "mytrip-3s"),
    "istanbul-cappadocia": ("ISTCAP", "mytrip-pt-3star"), "jakarta-bandung": ("JBDO", "ctrans"),
    "jeju": ("JJU", "atk-pt"), "jeju-udo": ("JJUO", "atk-std"), "jogjakarta": ("JOG", "pak-jamal-3-star"),
    "krabi-basic": ("KBV", "budget"), "krabi-standard": ("KBV", "standard"), "krabi-honeymoon": ("KBV", "honeymoon"),
    "lombok": ("LOP", "pak-anang-3s"), "maldives-basic": ("MLE", "mle-basic-low"), "maldives-standard": ("MLE", None),
    "maldives-combo": ("MLE", "mle-combo-low"), "maldives-water-villa": ("MLE", "mle-water-low"),
    "medan-lake-toba": ("LTOBA", "emiya"), "melbourne-basic": ("MEL", "wae-basic"),
    "melbourne-standard": ("MEL", "wae-standard"), "nz-north-south": ("NSNZ", "arba-to-10d9n-n-s"),
    "nz-south-only": ("NSNZ", "arba-to-8d7n-south"), "nz-north-only": ("NSNZ", "arba-to-6d5n-north-st"),
    "nz-north-south-apartment": ("NSNZ", "arba-to-9d8n-apt"), "nz-north-south-standard": ("NSNZ", "arba-to-9d8n-std"),
    "osaka-basic": ("OSK", "wif-basic"), "osaka-standard": ("OSK", "ucop-std-wif-std"),
    "padang-bukittinggi": ("PDG", "herman"), "perhentian-basic": ("PHT", "shari-la"), "perhentian-standard": ("PHT", "mimpi"),
    "perth-standard": ("PER", "k-n-std"), "perth-premium": ("PER", "k-n-premium"),
    "phu-quoc-4d3n": ("PQC", "ibrahim-4d3n"), "phu-quoc-5d4n": ("PQC", "ibrahim-5d4n"),
    "phuket-basic": ("PHU", "ktt-ibis-budget-phi-phi-lowseason"), "phuket-standard": ("PHU", "ktt-ibis-standard-lowseason"),
    "sabah-kk-kundasang-3d2n": ("KKK", "bahrun-3d-hotel"), "sabah-kk-kundasang-4d3n": ("KKK", "bahrun-4d-hotel"),
    "semporna-basic": ("SEM", "legend-3d-1s"), "semporna-standard": ("SEM", "legend-4d-1s"),
    "seoul-basic": ("SEL", "atk-bsc"), "seoul-standard": ("SEL", "atk-std"), "seoul-jeju": ("SELJJU", "atk-std"),
    "surabaya-bromo-malang": ("SUBB", "pak-jamal-s-b-m"), "surabaya-malang": ("SUBB", "pak-jamal-s-m"),
    "switzerland-standard": ("SWS", "musafir-arbato-pt"), "switzerland-self-tour": ("SWS", "musafir-arbato-st"),
    "tokyo-basic": ("HND", "basic"), "tokyo-standard": ("HND", "standard"),
    "tokyo-osaka-basic": ("KIX", "wif-bsc"), "tokyo-osaka-standard": ("KIX", "qay-ucop-std-wif-std"),
    "turki-klasik-basic": ("TUR", "mytrip-bsc-3star"), "turki-klasik-std": ("TUR", "mytrip-std-3star"),
    "yunnan-4-wilayah": ("KMGDLS", "tourdechina"), "yunnan-3-wilayah-6d5n": ("KMGDL", None),
}
TYPES = ("adult", "cwb", "cnb")
# known context from the R&D reformat notes (PT DESTINASI R&D REFORMAT/CLAUDE.md)
CONTEXT = {"CTS": "Likely cause: the Hokkaido R&D excludes the hotel (sold as an add-on RM1,200–2,000) while the catalog price includes it"}
flags = []


def flag(code, sev, area, title, detail="", fix="", package=None):
    flags.append({"code": code, "package": package, "severity": sev, "area": area, "title": title, "detail": detail, "fix": fix})


def money(s):
    if s is None:
        return None
    s = str(s).strip()
    if re.search(r"FOC|free", s, re.I):
        return 0.0
    m = re.search(r"RM\s*([\d,]+(?:\.\d+)?)", s)
    return float(m.group(1).replace(",", "")) if m else None


def pax_list(label):
    nums = [int(n) for n in re.findall(r"\d+", label)]
    if not nums or re.search(r"night|hotel|villa", label, re.I):
        return None
    return list(range(nums[0], nums[-1] + 1)) if len(nums) > 1 else nums


def ranges(ps):
    ps = sorted(ps); out = []
    for p in ps:
        if out and p == out[-1][1] + 1:
            out[-1][1] = p
        else:
            out.append([p, p])
    return ", ".join(("%d" % a if a == b else "%d–%d" % (a, b)) for a, b in out)


def rm(v):
    return "RM%s" % format(round(v), ",") if v is not None else "—"


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--fx", required=True); ap.add_argument("--margins", required=True); a = ap.parse_args()
    a_margins = a.margins
    data = json.load(open(os.path.join(ROOT, "data", "data.json")))
    hist = json.load(open(os.path.join(ROOT, "data", "history.json")))
    fx = json.load(open(a.fx))
    by = {d["code"]: d for d in data["destinations"]}
    truth = {}
    for f in glob.glob(os.path.join(ROOT, "tests", "truth", "*.json")):
        t = json.load(open(f)); truth[t["code"]] = t
    rd_file = {code: pick_file(folder) for folder, (code, _, _) in DESTS.items()}
    edited = {c["path"][1] for e in hist["entries"] if not e.get("rebase") for c in e.get("changes", []) if len(c["path"]) > 1}

    # ---------- 1. catalog vs calculator (= R&D) ----------
    seen_pkg = set(); stale = {}
    for f in sorted(glob.glob(os.path.join(CATALOG, "*.json"))):
        slug = os.path.basename(f)[:-5]
        cat = json.load(open(f)); title = "%s %s" % (cat.get("title", slug), cat.get("duration") or "")
        title = title.replace("PRIVATE TOUR", "PT").strip()
        if slug not in MAP:
            continue
        code, pid = MAP[slug]
        if code not in by or pid is None:
            flag(code, "high", "Coverage", "%s has no calculator package" % title,
                 "Catalog %s (%s) exists but there is no R&D costing for it, so cost and margin are unknown." % (cat.get("version", ""), cat.get("updated", "")),
                 "Add a TO rate card for this package to the R&D sheet (CR + Costing), then re-import.", package=title)
            continue
        d = by[code]; pkg = next(p for p in d["packages"] if p["id"] == pid); seen_pkg.add((code, pid))
        pr = cat.get("prices") or {}
        cols = [c.get("label", "") for c in pr.get("columns", [])]
        couple = len(cols) == 1 and re.search(r"couple", cols[0], re.I)
        diffs = {k: [] for k in TYPES}; missing = {k: [] for k in TYPES}; extra_child = []
        for row in pr.get("rows", []):
            amts = row.get("amounts", [])
            if couple:
                v = money(amts[0]); mine = pkg["pricing"]["adult"].get("2")
                if v is not None and mine is not None and abs(v - 2 * mine) > 1:
                    flag(code, "high", "Price", "%s: couple price differs" % title,
                         "Catalog %s per couple vs R&D %s × 2 = %s (row \"%s\")." % (rm(v), rm(mine), rm(2 * mine), row.get("pax")),
                         "Correct the R&D Costing adult price (2 pax) to %s, or the catalog." % rm(v / 2), package=title)
                continue
            ps = pax_list(row.get("pax", ""))
            if not ps:
                continue
            for k, amt in zip(TYPES, amts):
                v = money(amt)
                for p in ps:
                    if p > 30:
                        continue
                    mine = pkg["pricing"][k].get(str(p))
                    if v is None:  # catalog prints "-"
                        if mine is not None and k != "adult":
                            extra_child.append((k, p))
                        continue
                    if mine is None:
                        missing[k].append(p)
                    elif abs(v - mine) > 0.5:
                        diffs[k].append((p, v, mine))
        lines = []
        for k in TYPES:
            if diffs[k]:
                gaps = sorted({round(v - m) for _, v, m in diffs[k]})
                ex = diffs[k][0]
                lines.append("%s pax %s — e.g. %d pax catalog %s vs R&D %s (gap %s)" %
                             (k.upper(), ranges([p for p, _, _ in diffs[k]]), ex[0], rm(ex[1]), rm(ex[2]), ", ".join("%+d" % g for g in gaps[:4])))
        if lines:
            if code in CONTEXT:
                lines.append(CONTEXT[code])
            flag(code, "high", "Price", "%s: R&D price ≠ catalog" % title, " · ".join(lines) + ".",
                 "Decide which is right. Catalog right → update the R&D Costing prices and re-import. R&D right → re-issue the catalog.",
                 package=title)
        miss = sorted({p for k in TYPES for p in missing[k]})
        if miss:
            flag(code, "medium", "Coverage", "%s: catalog prices pax the R&D does not" % title,
                 "Pax %s printed in the catalog (%s) but not priced in the R&D Costing tab." % (ranges(miss), "/".join(k.upper() for k in TYPES if missing[k])),
                 "Add those pax rows to the R&D Costing and CR (TO cost), then re-import.", package=title)
        if extra_child:
            flag(code, "low", "Price", "%s: R&D has child prices the catalog does not offer" % title,
                 "Catalog prints \"-\" for %s; the R&D still prices them." % ", ".join(sorted({k.upper() for k, _ in extra_child})),
                 "Remove those prices from the R&D or add them to the catalog.", package=title)
        inf = money(pr.get("infant"))
        if inf is not None and abs(inf - float(pkg["pricing"].get("infant") or 0)) > 0.5:
            flag(code, "medium", "Price", "%s: infant price differs" % title,
                 "Catalog %s (\"%s\") vs calculator/R&D %s." % (rm(inf), pr.get("infant"), rm(float(pkg["pricing"].get("infant") or 0))),
                 "Set the R&D Costing INFANT price to %s." % rm(inf), package=title)
        # stale R&D
        upd = cat.get("updated"); src = rd_file.get(code)
        if upd and src and os.path.exists(src):
            mtime = datetime.date.fromtimestamp(os.path.getmtime(src))
            if datetime.date.fromisoformat(upd) > mtime:
                stale.setdefault(code, {"src": src, "mtime": mtime, "cats": []})["cats"].append("%s (%s, %s)" % (title, cat.get("version", ""), upd))

    for code, st in stale.items():
        flag(code, "medium", "Sync", "%s: catalog updated after the R&D was last saved" % by[code]["name"],
             "R&D %s last saved %s; newer catalog: %s." % (os.path.basename(st["src"]), st["mtime"], "; ".join(st["cats"])),
             "Check the newer catalog against the R&D (prices, pax bands, inclusions) and update the R&D.")

    # ---------- 2. calculator packages with no catalog ----------
    for d in data["destinations"]:
        extra = [p["label"] for p in d["packages"] if (d["code"], p["id"]) not in seen_pkg]
        if extra:
            flag(d["code"], "low", "Coverage", "%s: %d R&D package(s) without their own catalog" % (d["name"], len(extra)),
                 "; ".join(extra) + ". Usually a hotel-tier upgrade, season or self-tour variant of a catalog package.",
                 "If sold, add it to a catalog (or note it as an upgrade of the base package); otherwise remove it from the R&D.")

    # ---------- 3. margins & missing cost (calculator numbers = what POs see) ----------
    margins = json.load(open(a_margins))
    for code, pkgs in margins.items():
        d = by[code]
        for pid, pk in pkgs.items():
            label = pk["label"]; neg, low, nocost, childbad = [], [], [], {}
            for p, r in pk["rows"].items():
                p = int(p)
                if p > 30:
                    continue
                c, sell = r["adult"]
                if sell is None:
                    continue
                if c is None:
                    nocost.append(p); continue
                m = (sell - c) / sell if sell else 0
                if m < 0: neg.append((p, m))
                elif m < 0.10: low.append((p, m))
                for k in ("cwb", "cnb"):
                    cc, ss = r[k]
                    if cc is not None and ss is not None and ss < cc:
                        childbad.setdefault(k, []).append(p)
            if neg:
                flag(code, "high", "Margin", "%s · %s: selling below cost" % (d["name"], label),
                     "Negative adult margin at pax %s (worst %.0f%%)." % (ranges([p for p, _ in neg]), 100 * min(m for _, m in neg)),
                     "Raise the price for those pax or renegotiate the TO rate.", package=label)
            if low:
                flag(code, "medium", "Margin", "%s · %s: adult margin under 10%%" % (d["name"], label),
                     "Pax %s (lowest %.1f%%)." % (ranges([p for p, _ in low]), 100 * min(m for _, m in low)),
                     "Review the price for these pax or the TO rate.", package=label)
            if nocost:
                flag(code, "high" if any(p <= 15 for p in nocost) else "medium", "Cost", "%s · %s: price but no cost" % (d["name"], label),
                     "Pax %s have a selling price but no TO cost (the R&D shows RM0 cost / 100%% margin there)." % ranges(nocost),
                     "Get the TO rate for those pax and add it to the R&D CR, or stop quoting those pax counts.", package=label)
            for k, ps in childbad.items():
                flag(code, "high", "Margin", "%s · %s: %s selling below cost" % (d["name"], label, k.upper()),
                     "Pax %s." % ranges(ps), "Check the %s cost rule (%% of adult) and the %s catalog price." % (k.upper(), k.upper()), package=label)

    # ---------- 4. selling = catalog − discount ----------
    disc = {}
    for d in data["destinations"]:
        for p in d["packages"]:
            if float(p["rules"].get("discountTier2") or 0):
                disc.setdefault(d["code"], set()).add(float(p["rules"]["discountTier2"]))
    if disc:
        flag("ALL", "medium", "Rule", "Selling = catalog − tier-2 discount in %d destinations" % len(disc),
             "R&D Costing F2 \"Discount Tier 2\" lowers every selling price below the catalog (margin is on the discounted price): " +
             ", ".join("%s −RM%s" % (c, "/".join("%g" % v for v in sorted(vals))) for c, vals in sorted(disc.items())) +
             ". No discount: " + ", ".join(sorted(set(by) - set(disc))) + ". The R&D reformat convention says selling = catalog.",
             "Decide one policy: F2 = 0 everywhere (margin on catalog price), or keep RM200 everywhere and write it into the convention.")

    # ---------- 5. add-ons ----------
    for d in data["destinations"]:
        nc = [a["label"] for a in d.get("addons", []) if a.get("cost") is None and a.get("selling")]
        if nc:
            flag(d["code"], "low", "Add-ons", "%s: %d add-on(s) without cost" % (d["name"], len(nc)),
                 "; ".join(nc[:6]) + (" …" if len(nc) > 6 else ""), "Fill Cost_RM in the R&D Add-Ons tab.")
        for a_ in d.get("addons", []):
            c, s = a_.get("cost"), a_.get("selling")
            if isinstance(c, (int, float)) and isinstance(s, (int, float)) and c and s and (c < 0) != (s < 0):
                flag(d["code"], "medium", "Add-ons", "%s: add-on \"%s\" cost and selling have opposite signs" % (d["name"], a_["label"]),
                     "Cost %s, selling %s → margin %s." % (rm(c), rm(s), rm(s - c)), "Use the same sign for a deduction (e.g. both negative).")

    # ---------- 6. FX ----------
    same = {}
    for code, lst in fx.items():
        for f in lst:
            same.setdefault((f["currency"], f["supplier"] or ""), {}).setdefault(round(f["value"], 8), []).append(code)
    for (cur, sup), vals in same.items():
        if len(vals) > 1:
            det = "; ".join("%s = %s" % (v, ", ".join(sorted(c))) for v, c in sorted(vals.items()))
            flag("ALL", "medium", "FX", "%s%s → MYR differs between destinations" % (cur, " (" + sup + ")" if sup else ""),
                 det + ".", "Agree one FX rate per currency (and supplier) and update every R&D sheet that uses it; then re-import.")

    # ---------- 7. data housekeeping ----------
    if "JBDO" in by:
        flag("JBDO", "high", "Sync", "Jakarta - Bandung: calculator has the new CTRANS rate, the R&D does not",
             "Calculator v5: fullboard rate incl. Whoosh 2–10 pax (2 pax RM936 … 10 pax RM635; 5 pax Hiace RM757). The R&D CR still has the old Ground cost + Whoosh column (2 pax RM1,090) and pax up to 40.",
             "Update the R&D CR (remove the Whoosh column, new rates 2–10) before any re-import, or the re-import will bring back the old cost. Ask CTRANS for 11+ pax.")
    flag("ISTBUR", "low", "Sheet", "Project PT sheet: ISTBUR and ISTCAP catalog names swapped",
         "Row ISTBUR shows \"PT ISTANBUL CAPPADOCIA 6D5N\"; row ISTCAP shows \"PT ISTANBUL BURSA 5D4N\".", "Swap the two Catalog cells in the Project PT Overview tab.")
    flag("KMGDL", "medium", "Coverage", "Yunnan 3 Wilayah has no R&D file",
         "The catalog and the Project PT sheet list it; the R&D folder YUNNAN 3 WILAYAH is empty.", "Add PT_KMGDL_RD_reformatted.xlsx (Tourdechina rate) so it can be costed.")
    for code in ("BKK", "SUBB", "MLE", "PHU", "KBV"):
        if code in by:
            flag(code, "low", "Sheet", "%s: New PO is blank in the Project PT sheet" % by[code]["name"],
                 "The calculator shows Current PO (%s)." % by[code]["po"], "Fill New PO in the Project PT sheet (and change it on the page).")
    for name in ("PT_SEL_RD_reformatted.xlsx", "PT_SLJJ_RD_reformatted.xlsx"):
        p = os.path.join(DRIVE, name)
        if os.path.exists(p):
            flag("SEL" if "SEL_" in name else "SELJJU", "low", "Sync", "Older R&D copy in My Drive: %s" % name,
                 "My Drive root has an older copy than Downloads/PT DESTINASI R&D REFORMAT.", "Delete or replace the My Drive copy so nobody edits the old file.")

    # one Margin flag per destination: the worst severity, one line per package
    merged, rest = {}, []
    for f in flags:
        if f["area"] != "Margin":
            rest.append(f); continue
        m = merged.setdefault(f["code"], {"code": f["code"], "package": None, "severity": "low", "area": "Margin", "lines": [], "fix": set()})
        m["severity"] = min(m["severity"], f["severity"], key=lambda x: ["high", "medium", "low"].index(x))
        m["lines"].append("%s — %s %s" % (f["package"], f["title"].split(": ", 1)[1], f["detail"].rstrip(".")))
        m["fix"].add(f["fix"])
    for code, m in merged.items():
        n = len(m["lines"])
        rest.append({"code": code, "package": None, "severity": m["severity"], "area": "Margin",
                     "title": "%s: margin problems in %d package/TO line%s" % (by[code]["name"] if code in by else code, n, "s" if n > 1 else ""),
                     "detail": " · ".join(m.pop("lines")) + ".", "fix": " ".join(sorted(m["fix"]))})
    flags[:] = rest
    order = {"high": 0, "medium": 1, "low": 2}
    flags.sort(key=lambda f: (order[f["severity"]], f["code"], f["area"]))
    for i, f in enumerate(flags, 1):
        f["id"] = i
    out = {"generatedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "dataVersion": data["version"], "flags": flags}
    json.dump(out, open(os.path.join(ROOT, "data", "flags.json"), "w"), indent=1, ensure_ascii=False)
    from collections import Counter
    print("flags:", len(flags), dict(Counter(f["severity"] for f in flags)), dict(Counter(f["area"] for f in flags)))


if __name__ == "__main__":
    main()
