#!/usr/bin/env python3
"""Build the PT KB House pages (prod-at22/pt-kb-house) from the PT R&D Costing Hub.

The hub is the source of every KB's content and Simple Calculator numbers: data/kb/<slug>.json holds
  kind      "template" (26 KBs: content = the page's kbdata) or "bespoke" (aceh, korea: content = the
            constants the page reads from its kbdata block, plus the FAQ markdown in `snapshot`)
  content   everything the KB page shows (packages, itineraries, attractions + Muslim-friendly info,
            hotels, tab blocks, FAQ ...)
  calc      the Simple Calculator config (written to <slug>/calc-config.json and the page's CALC_CFG)
  map       variants: {calculator variant id: {code, package}} — those variants' price tiers come from
            the Costing package (data/data.json pricing = Catalog Price), so the hub's price always wins;
            a variant with no Costing package keeps its own tiers in `calc` (KB-only)
Cosmetics stay in pt-kb-house: the page itself (layout, CSS, engine, travel map, logo) and the images,
which the hub refers to as "@asset:<key>" and which live in <slug>/assets.json next to the page.

    python3 kb-build/build.py <pt-kb-house dir> [slug ...]      (no slug = every KB in data/kb/)

Only the data blocks of <slug>/index.html are rewritten, so the KB's look and engine never change.
Run by pt-kb-house's mirror.yml after every hub save (like catalog-pt-public's mirror).
"""
import json, os, re, sys

HUB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KBDIR = os.path.join(HUB, "data", "kb")
ASSET = re.compile(r"@asset:([0-9a-f]{12})")
KBDATA = re.compile(r'(<script type="application/json" id="kbdata">)(.*?)(</script>)', re.S)
SNAPSHOT = re.compile(r'(<script type="text/markdown" id="snapshot">)(.*?)(</script>)', re.S)


def script_json(obj):
    """JSON for inside a <script>: compact, UTF-8, and never closes the script early."""
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return re.sub(r"</(script)", r"<\\/\1", s, flags=re.I).replace("<!--", "<\\!--")


def detoken(obj, assets, slug):
    if isinstance(obj, str):
        def put(m):
            if m.group(1) not in assets:
                raise SystemExit(f"{slug}: image @asset:{m.group(1)} missing from {slug}/assets.json")
            return assets[m.group(1)]
        return ASSET.sub(put, obj) if "@asset:" in obj else obj
    if isinstance(obj, list):
        return [detoken(x, assets, slug) for x in obj]
    if isinstance(obj, dict):
        return {k: detoken(v, assets, slug) for k, v in obj.items()}
    return obj


def num(v):
    return int(v) if isinstance(v, float) and v.is_integer() else v


def hub_tiers(pkg, old):
    """Calculator tiers from the Costing package: Catalog Price per pax (+ tierUpgrade, as priceRow does)
    for every pax the KB calculator covers. The KB's own pax bands are kept; a band splits only where the
    hub's price changes inside it. A pax the package has no price for keeps the KB's own price. A child
    price the package does not have keeps the KB's (0 = not sold), or follows the adult price when the KB
    priced the child like an adult (honeymoon = per couple)."""
    P, up = pkg["pricing"], (pkg.get("rules") or {}).get("tierUpgrade") or 0
    def at(k, pax):
        v = P.get(k)
        v = v.get(str(pax)) if isinstance(v, dict) else None
        return v if isinstance(v, (int, float)) and v else None
    def kb(pax):
        for t in old:
            if t["from"] <= pax <= t["to"]:
                return t
    starts = {t["from"] for t in old}
    lo = min(t["from"] for t in old)
    last = max([int(x) for x in P.get("adult", {}) if at("adult", int(x)) is not None] or [lo])
    top = max(last, max(t["from"] for t in old))     # open-ended KB bands (to 99999) stop the walk here
    rows = []
    for pax in range(lo, top + 1):
        t = kb(pax)
        if t is None:
            continue
        a = at("adult", pax)
        if a is None:
            r = {k: t[k] for k in "acn"}
        else:
            A = num(a + up)
            def child(k, hk):
                v = at(hk, pax)
                if v is not None:
                    return num(v + up)
                return A if t[k] == t["a"] else t[k]
            r = {"a": A, "c": child("c", "cwb"), "n": child("n", "cnb")}
        if rows and rows[-1]["to"] == pax - 1 and pax not in starts and all(rows[-1][k] == r[k] for k in "acn"):
            rows[-1]["to"] = pax
        else:
            rows.append({"from": pax, "to": pax, **r})
    for t in old:                                    # pax above the hub's last priced pax keep the KB's price
        if t["to"] > top:
            r = {**t, "from": max(t["from"], top + 1)}
            if rows and rows[-1]["to"] == r["from"] - 1 and r["from"] not in starts and all(rows[-1][k] == r[k] for k in "acn"):
                rows[-1]["to"] = r["to"]
            else:
                rows.append(r)
    return rows


def calc_from_hub(kb, data):
    """The KB's calc config with every variant linked to a Costing package priced from the hub."""
    links = (kb.get("map") or {}).get("variants") or {}
    if not links:
        return kb["calc"]
    pk = {(d["code"], p["id"]): p for d in data["destinations"] for p in d["packages"]}
    calc = json.loads(json.dumps(kb["calc"]))
    for v in calc["variants"]:
        ln = links.get(v["id"])
        if ln:
            if (ln["code"], ln["package"]) not in pk:
                raise SystemExit(f"{kb['slug']}: variant {v['id']} -> unknown package {ln['code']}/{ln['package']}")
            v["tiers"] = hub_tiers(pk[(ln["code"], ln["package"])], v["tiers"])
    return calc


def one(m, html, what, slug):
    if len(m) != 1:
        raise SystemExit(f"{slug}: expected one {what} block in index.html, found {len(m)}")
    return m[0]


def build(site, slug, data):
    kb = json.load(open(os.path.join(KBDIR, slug + ".json"), encoding="utf-8"))
    calc = calc_from_hub(kb, data)
    page = os.path.join(site, slug, "index.html")
    html = open(page, encoding="utf-8").read()
    ap = os.path.join(site, slug, "assets.json")
    assets = json.load(open(ap, encoding="utf-8")) if os.path.exists(ap) else {}
    new = html
    m = one(list(KBDATA.finditer(new)), new, "kbdata", slug)
    new = new[:m.start(2)] + script_json(detoken(kb["content"], assets, slug)) + new[m.end(2):]
    if kb["kind"] == "bespoke":
        m = one(list(SNAPSHOT.finditer(new)), new, "snapshot", slug)
        new = new[:m.start(2)] + kb["snapshot"] + new[m.end(2):]
    i = new.find("var CALC_CFG=")
    if i < 0 or new.find("var CALC_CFG=", i + 1) >= 0:
        raise SystemExit(f"{slug}: expected one 'var CALC_CFG=' in index.html")
    j = i + len("var CALC_CFG=")
    _, end = json.JSONDecoder().raw_decode(new, j)
    new = new[:j] + script_json(calc) + new[end:]
    cfg = json.dumps(calc, indent=1, ensure_ascii=False) + "\n"
    cp = os.path.join(site, slug, "calc-config.json")
    old_cfg = open(cp, encoding="utf-8").read() if os.path.exists(cp) else None
    changed = []
    if new != html:
        open(page, "w", encoding="utf-8").write(new); changed.append("index.html")
    if cfg != old_cfg:
        open(cp, "w", encoding="utf-8").write(cfg); changed.append("calc-config.json")
    return changed


def main(argv):
    if not argv:
        raise SystemExit(__doc__)
    site, slugs = argv[0], argv[1:] or sorted(f[:-5] for f in os.listdir(KBDIR) if f.endswith(".json") and f != "index.json")
    data = json.load(open(os.path.join(HUB, "data", "data.json"), encoding="utf-8"))
    for slug in slugs:
        ch = build(site, slug, data)
        print(f"{slug}: {', '.join(ch) if ch else 'unchanged'}")


if __name__ == "__main__":
    main(sys.argv[1:])
