#!/usr/bin/env python3
"""Build the PT KB House pages (prod-at22/pt-kb-house) from the PT R&D Costing Hub.

The hub is the source of every KB's content and Simple Calculator numbers: data/kb/<slug>.json holds
  kind      "template" (26 KBs: content = the page's kbdata) or "bespoke" (aceh, korea: content = the
            constants the page reads from its kbdata block, plus the FAQ markdown in `snapshot`)
  content   everything the KB page shows (packages, itineraries, attractions + Muslim-friendly info,
            hotels, tab blocks, FAQ ...)
  calc      the Simple Calculator config (written to <slug>/calc-config.json and the page's CALC_CFG)
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


def one(m, html, what, slug):
    if len(m) != 1:
        raise SystemExit(f"{slug}: expected one {what} block in index.html, found {len(m)}")
    return m[0]


def build(site, slug):
    kb = json.load(open(os.path.join(KBDIR, slug + ".json"), encoding="utf-8"))
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
    new = new[:j] + script_json(kb["calc"]) + new[end:]
    cfg = json.dumps(kb["calc"], indent=1, ensure_ascii=False) + "\n"
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
    site, slugs = argv[0], argv[1:] or sorted(f[:-5] for f in os.listdir(KBDIR) if f.endswith(".json"))
    for slug in slugs:
        ch = build(site, slug)
        print(f"{slug}: {', '.join(ch) if ch else 'unchanged'}")


if __name__ == "__main__":
    main(sys.argv[1:])
