#!/usr/bin/env python3
"""Flags for the hub: cross-check the catalogs (data/catalogs/*.json) against the hub's own numbers
(data/data.json) and write data/flags.json. The hub is the source of truth; no R&D workbook is read.

Each flag: {code, package, severity (high|medium|low), area, title, detail, fix}
  high   = a customer-facing price or a cost is wrong / missing
  medium = catalog and hub disagree on coverage, or a decision is needed
  low    = housekeeping

    NODE_PATH=<dir with jsdom> python3 tools/flags.py        (runs tools/margins.js itself)
"""
import argparse, datetime, glob, json, os, re, subprocess, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "catalog-build"))
import hub_prices  # noqa: E402  same price rules as the catalog build

ROOT = os.path.join(os.path.dirname(__file__), "..")
CATALOG = os.path.join(ROOT, "data", "catalogs")

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
    ap = argparse.ArgumentParser(); ap.add_argument("--margins", help="margins.json from tools/margins.js (default: run it)"); a = ap.parse_args()
    data = json.load(open(os.path.join(ROOT, "data", "data.json")))
    by = {d["code"]: d for d in data["destinations"]}
    if a.margins:
        margins = json.load(open(a.margins))
    else:
        margins = json.loads(subprocess.run(["node", os.path.join(ROOT, "tools", "margins.js")], capture_output=True, text=True, check=True).stdout)

    # ---------- 1. catalog vs hub ----------
    seen_pkg = set()
    for f in sorted(glob.glob(os.path.join(CATALOG, "*.json"))):
        slug = os.path.basename(f)[:-5]
        if slug not in MAP:
            continue
        cat = json.load(open(f)); title = ("%s %s" % (cat.get("title", slug), cat.get("duration") or "")).replace("PRIVATE TOUR", "PT").strip()
        code, pid = MAP[slug]
        if code not in by or pid is None:
            flag(code, "high", "Coverage", "%s has no costing in the hub" % title,
                 "Catalog %s (%s) exists but the hub has no package for it, so cost and margin are unknown." % (cat.get("version", ""), cat.get("updated", "")),
                 "Add the package and its TO rates in the hub.", package=title)
            continue
        d = by[code]; pkg = next(p for p in d["packages"] if p["id"] == pid); seen_pkg.add((code, pid))
        linked = any("amounts" not in r for r in (cat.get("prices") or {}).get("rows") or [])
        pr = hub_prices.resolve(cat, pkg)   # a linked catalog's prices ARE the hub's: only coverage can be wrong
        cols = [c.get("label", "") for c in pr.get("columns", [])]
        couple = len(cols) == 1 and re.search(r"couple", cols[0], re.I)
        diffs = {k: [] for k in TYPES}; missing = {k: [] for k in TYPES}; extra_child = []; uneven = []
        for row in pr.get("rows", []):
            amts = row.get("amounts", [])
            if couple:
                v = money(amts[0]); mine = pkg["pricing"]["adult"].get("2")
                if v is not None and mine is not None and abs(v - 2 * mine) > 1:
                    flag(code, "high", "Price", "%s: couple price differs" % title,
                         "Catalog %s per couple vs hub %s × 2 = %s (row \"%s\")." % (rm(v), rm(mine), rm(2 * mine), row.get("pax")),
                         "Set the hub adult price (2 pax) to %s, or re-issue the catalog." % rm(v / 2), package=title)
                continue
            ps = pax_list(row.get("pax", ""))
            if not ps:
                continue
            # the catalog prints one price per band (the band's first pax): the hub should not vary inside it
            for k in TYPES:
                vals = {pkg["pricing"][k].get(str(p)) for p in ps if p <= 30} - {None}
                if len(vals) > 1:
                    uneven.append("%s %s pax (%s)" % (k.upper(), row.get("pax"), " / ".join(rm(v) for v in sorted(vals))))
            na = set(row.get("na") or [])
            for k, amt in zip(TYPES, amts):
                v = money(amt)
                for p in ps:
                    if p > 30:
                        continue
                    mine = pkg["pricing"][k].get(str(p))
                    if linked and v is None and k not in na:   # the band prints a price, the Costing has none
                        missing[k].append(p); continue
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
                lines.append("%s pax %s — e.g. %d pax catalog %s vs hub %s (gap %s)" %
                             (k.upper(), ranges([p for p, _, _ in diffs[k]]), ex[0], rm(ex[1]), rm(ex[2]), ", ".join("%+d" % g for g in gaps[:4])))
        if lines:
            flag(code, "high", "Price", "%s: hub price ≠ catalog" % title, " · ".join(lines) + ".",
                 "Decide which is right. Catalog right → change the catalog price on the Costing tab (Edit costs). Hub right → re-issue the catalog.",
                 package=title)
        miss = sorted({p for k in TYPES for p in missing[k]})
        if miss:
            flag(code, "medium", "Coverage", "%s: catalog prices pax the hub does not" % title,
                 "Pax %s printed in the catalog (%s) but not priced in the hub." % (ranges(miss), "/".join(k.upper() for k in TYPES if missing[k])),
                 "Add those pax to the package in the hub (price and TO cost).", package=title)
        if extra_child:
            flag(code, "low", "Price", "%s: hub has child prices the catalog does not offer" % title,
                 "Catalog prints \"-\" for %s; the hub still prices them." % ", ".join(sorted({k.upper() for k, _ in extra_child})),
                 "Remove those prices in the hub or add them to the catalog.", package=title)
        if uneven:
            flag(code, "medium", "Price", "%s: hub price changes inside a catalog pax band" % title,
                 "The catalog prints one price per band (its first pax); the hub has different prices inside: " + "; ".join(uneven[:6]) + ("…" if len(uneven) > 6 else "") + ".",
                 "Use one catalog price for every pax in the band on the Costing tab, or split the band in the catalog.", package=title)
        inf = None if linked else money(pr.get("infant"))
        if inf is not None and abs(inf - float(pkg["pricing"].get("infant") or 0)) > 0.5:
            flag(code, "medium", "Price", "%s: infant price differs" % title,
                 "Catalog %s (\"%s\") vs hub %s." % (rm(inf), pr.get("infant"), rm(float(pkg["pricing"].get("infant") or 0))),
                 "Set the infant price in the hub to %s." % rm(inf), package=title)

    # ---------- 2. hub packages with no catalog ----------
    for d in data["destinations"]:
        extra = [p["label"] for p in d["packages"] if (d["code"], p["id"]) not in seen_pkg]
        if extra:
            flag(d["code"], "low", "Coverage", "%s: %d package(s) without their own catalog" % (d["name"], len(extra)),
                 "; ".join(extra) + ". Usually a hotel-tier upgrade, season or self-tour variant of a catalog package.",
                 "If sold, add it to a catalog (or note it as an upgrade of the base package); otherwise remove it from the hub.")

    # ---------- 3. margins & missing cost (the page's own numbers) ----------
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
                     "Pax %s have a selling price but no TO cost." % ranges(nocost),
                     "Add the TO rate for those pax in the hub (Edit costs), or stop quoting those pax counts.", package=label)
            for k, ps in childbad.items():
                flag(code, "high", "Margin", "%s · %s: %s selling below cost" % (d["name"], label, k.upper()),
                     "Pax %s." % ranges(ps), "Check the %s cost rule (%% of adult) and the %s catalog price." % (k.upper(), k.upper()), package=label)

    # ---------- 4. add-ons ----------
    for d in data["destinations"]:
        nc = [a_["label"] for a_ in d.get("addons", []) if a_.get("cost") is None and a_.get("selling")]
        if nc:
            flag(d["code"], "low", "Add-ons", "%s: %d add-on(s) without cost" % (d["name"], len(nc)),
                 "; ".join(nc[:6]) + (" …" if len(nc) > 6 else ""), "Fill the cost on the Add-ons tab.")
        for a_ in d.get("addons", []):
            c, s = a_.get("cost"), a_.get("selling")
            if isinstance(c, (int, float)) and isinstance(s, (int, float)) and c and s and (c < 0) != (s < 0):
                flag(d["code"], "medium", "Add-ons", "%s: add-on \"%s\" cost and selling have opposite signs" % (d["name"], a_["label"]),
                     "Cost %s, selling %s → margin %s." % (rm(c), rm(s), rm(s - c)), "Use the same sign for a deduction (e.g. both negative).")

    # ---------- 5. FX: one rate per currency ----------
    same = {}
    for d in data["destinations"]:
        for f in d.get("fx", []):
            if f["id"] == "MYR":
                continue
            m = re.search(r"\b([A-Z]{3})\b", f.get("label", "")); cur = m.group(1) if m else f["id"]
            same.setdefault(cur, {}).setdefault(round(float(f["value"]), 8), set()).add(d["code"])
    for cur, vals in sorted(same.items()):
        if len(vals) > 1:
            flag("ALL", "medium", "FX", "%s → MYR differs between destinations" % cur,
                 "; ".join("%s = %s" % (v, ", ".join(sorted(c))) for v, c in sorted(vals.items())) + ".",
                 "Agree one FX rate per currency (and supplier) and set it on each destination page (Edit costs).")

    # ---------- 6. Project PT sheet housekeeping ----------
    flag("ISTBUR", "low", "Sheet", "Project PT sheet: ISTBUR and ISTCAP catalog names swapped",
         "Row ISTBUR shows \"PT ISTANBUL CAPPADOCIA 6D5N\"; row ISTCAP shows \"PT ISTANBUL BURSA 5D4N\".", "Swap the two Catalog cells in the Project PT Overview tab.")
    for code in ("BKK", "SUBB", "MLE", "PHU", "KBV"):
        if code in by:
            flag(code, "low", "Sheet", "%s: New PO is blank in the Project PT sheet" % by[code]["name"],
                 "The hub shows PO %s." % by[code]["po"], "Fill New PO in the Project PT sheet (and change it on the page).")

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
