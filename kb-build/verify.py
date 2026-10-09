#!/usr/bin/env python3
"""Check that the built PT KB House pages say exactly what the hub says.

    python3 kb-build/verify.py <pt-kb-house dir> [slug ...]

Run by pt-kb-house's mirror.yml after build.py and before the commit: any problem stops the mirror, so a
wrong page is never published. Each check reads the built page itself (index.html + calc-config.json) and
compares it with the hub sources directly, not with build.py's own output:

  page        one kbdata block, one CALC_CFG, CALC_CFG == calc-config.json, no unresolved @asset: / {{…}}
  prices      every Costing-linked calculator tier = Catalog Price (+ tierUpgrade) for each pax it covers;
              every catalog price-table amount appears in the KB's Harga & Pakej tab
  catalog     a linked package's itinerary (days, titles) and includes / excludes = the catalog's
  hotels      the KB's Accommodation tab lists every catalog hotel from the Accommodation list (no KB hotel cards)
  tabs        the KB's Surcharge tab has every catalog hotel row and season, Simple Customisation every catalog
              add-on, Polisi every deposit line (Surcharge, Accommodation, Add On, Policy tabs)
  dropdown    the calculator's package list = calc variants, in order
  rebuild     building again changes nothing (the page is up to date with the hub)
"""
import html as htmlmod, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402

KBDIR = build.KBDIR


def page_parts(site, slug):
    h = open(os.path.join(site, slug, "index.html"), encoding="utf-8").read()
    blocks = build.KBDATA.findall(h)
    content = json.loads(blocks[0][1]) if len(blocks) == 1 else None
    i = h.find("var CALC_CFG=")
    calc = json.JSONDecoder().raw_decode(h, i + len("var CALC_CFG="))[0] if i >= 0 else None
    cfg = json.load(open(os.path.join(site, slug, "calc-config.json"), encoding="utf-8"))
    return h, blocks, content, calc, cfg


def text(s):
    return re.sub(r"\s+", " ", htmlmod.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def check(site, slug, data, hub):
    errs = []
    kb = json.load(open(os.path.join(KBDIR, slug + ".json"), encoding="utf-8"))
    h, blocks, content, calc, cfg = page_parts(site, slug)
    # page
    if len(blocks) != 1:
        return [f"{len(blocks)} kbdata blocks"]
    if h.count("var CALC_CFG=") != 1:
        errs.append("CALC_CFG missing or repeated")
    if calc != cfg:
        errs.append("CALC_CFG in index.html differs from calc-config.json")
    blob = json.dumps(content, ensure_ascii=False) + json.dumps(cfg, ensure_ascii=False)
    for tok in ("@asset:", "{{"):
        if tok in blob:
            errs.append(f"unresolved {tok} in the page")
    # prices: calculator tiers
    pk = {(d["code"], p["id"]): p for d in data["destinations"] for p in d["packages"]}
    for vid, ln in ((kb.get("map") or {}).get("variants") or {}).items():
        v = next((x for x in cfg["variants"] if x["id"] == vid), None)
        if v is None:
            errs.append(f"calculator package {vid} missing"); continue
        P, up = pk[(ln["code"], ln["package"])]["pricing"], (pk[(ln["code"], ln["package"])].get("rules") or {}).get("tierUpgrade") or 0
        for t in v["tiers"]:
            for pax in range(t["from"], min(t["to"], 60) + 1):
                a = (P.get("adult") or {}).get(str(pax))
                if isinstance(a, (int, float)) and a and abs(float(t["a"]) - (a + up)) > 0.01:
                    errs.append(f"{vid} {pax} pax adult {t['a']} ≠ Costing {a + up}")
                for k, hk in (("c", "cwb"), ("n", "cnb")):
                    c = (P.get(hk) or {}).get(str(pax))
                    if isinstance(c, (int, float)) and c and isinstance(t[k], (int, float)) and abs(float(t[k]) - (c + up)) > 0.01:
                        errs.append(f"{vid} {pax} pax {hk} {t[k]} ≠ Costing {c + up}")
        if ln.get("capAtHub"):
            last = max(int(x) for x, y in (P.get("adult") or {}).items() if isinstance(y, (int, float)) and y)
            if max(t["to"] for t in v["tiers"]) > last:
                errs.append(f"{vid} goes past {last} pax (stops at the hub's last price)")
    # prices + catalog content of linked packages
    bespoke = kb["kind"] == "bespoke"
    P_, I_ = (content.get("PKG"), content.get("ITIN")) if bespoke else (content.get("packages"), content.get("itineraries"))
    pricing = text(content.get("PRICING_HTML") if bespoke else (content.get("blocks") or {}).get("pricing"))
    for i, ln in enumerate((kb.get("map") or {}).get("packages") or []):
        if not ln:
            continue
        cat = hub.cat(ln["catalog"])
        pb = (cat.get("price_blocks") or [{}])[0]
        if P_[i].get("inc") != build.cat_items(pb.get("includes")) or P_[i].get("exc") != build.cat_items(pb.get("excludes")):
            errs.append(f"package {i}: includes / excludes ≠ catalog {ln['catalog']}")
        want = build.cat_days(cat, ln.get("itinerary"))
        if [(d["d"], d["t"]) for d in I_[i] or []] != [(d["d"], d["t"]) for d in want]:
            errs.append(f"package {i}: itinerary ≠ catalog {ln['catalog']}")
        pr = hub.prices(ln["catalog"])
        if bespoke and "PRICES" in content:
            rows = content["PRICES"][i]["rows"] if i < len(content["PRICES"]) else []
            want_rows = [[r.get("pax", "")] + [re.sub(r"^RM\s?", "", a or "-") for a in r.get("amounts") or []] for r in pr.get("rows") or []]
            if rows != want_rows:
                errs.append(f"package {i}: price rows ≠ Costing ({ln['catalog']})")
        else:
            for r in pr.get("rows") or []:
                for a in r.get("amounts") or []:
                    if a and a != "-" and a not in pricing:
                        errs.append(f"price {a} ({ln['catalog']} {r.get('pax')}) missing from Harga & Pakej")
    # tabs made from the hub: Surcharge (+ hotel rows), catalog add-ons, Policy
    B = content if bespoke else (content.get("blocks") or {})
    bk = (lambda b: b.upper() + "_HTML") if bespoke else (lambda b: b)
    links = [l for l in (kb.get("map") or {}).get("packages") or [] if l]
    for slug in dict.fromkeys(l["catalog"] for l in links):
        cat = json.loads(json.dumps(hub.cat(slug))); code = (hub.index.get(slug) or {}).get("code") or cat.get("code")
        build.hub_data.apply_hotels(cat, slug, data, code)
        if bk("surcharge") in B:
            sur = text(B[bk("surcharge")])
            for r in (cat.get("surcharge") or {}).get("rows") or []:
                if text(r.get("name")) not in sur:
                    errs.append(f"Surcharge tab: hotel row {r.get('name')!r} ({slug}) missing")
            for x in (cat.get("surcharge") or {}).get("seasons") or []:
                if text(x.get("period")) not in sur:
                    errs.append(f"Surcharge tab: season {x.get('label')!r} ({slug}) missing")
        if bk("custom") in B:
            cus = text(B[bk("custom")])
            for g in build.hub_data.addons(cat, slug, data, code):
                for e in g["entries"]:
                    if text(e["name"]) not in cus:
                        errs.append(f"Customisation tab: catalog add-on {e['name']!r} missing")
        if bk("polisi") in B:
            pol = text(B[bk("polisi")])
            for d in cat.get("deposit") or []:
                if text(d.get("figure")) not in pol:
                    errs.append(f"Polisi tab: deposit {d.get('figure')!r} ({slug}) missing")
    # hotels: the Accommodation tab shows each package's hotels from the hub's Accommodation list (no KB hotel cards)
    if (content.get("HOTELS") if bespoke else content.get("hotels")):
        errs.append("KB hotel cards still in the content (the Accommodation tab comes from the hub's Accommodation list)")
    stay = text(content.get("ACC_HTML") if bespoke else (content.get("blocks") or {}).get("stay"))
    for slug in dict.fromkeys(l["catalog"] for l in links):
        cat = json.loads(json.dumps(hub.cat(slug))); code = (hub.index.get(slug) or {}).get("code") or cat.get("code")
        build.hub_data.apply_hotels(cat, slug, data, code)
        for h in cat.get("accommodation") or (cat.get("surcharge") or {}).get("rows") or []:
            if h.get("name") and text(h["name"]) not in stay:
                errs.append(f"Accommodation tab: hotel {h['name']!r} ({slug}) missing")
    # dropdown (template KBs)
    m = build.PKGSEL.search((content.get("blocks") or {}).get("calc") or "") if not bespoke else None
    if m and "<option" in m.group(2):
        names = re.findall(r"<option value='(\d+)'>(.*?)</option>", m.group(2))
        if [(int(a), b) for a, b in names] != [(i, v["name"]) for i, v in enumerate(cfg["variants"])]:
            errs.append("calculator package list ≠ calc variants")
    return errs


def main(argv):
    if not argv:
        raise SystemExit(__doc__)
    site, slugs = argv[0], argv[1:] or sorted(f[:-5] for f in os.listdir(KBDIR) if f.endswith(".json") and f != "index.json")
    data = json.load(open(os.path.join(build.HUB, "data", "data.json"), encoding="utf-8"))
    hub = build.Hub(data)
    bad = 0
    for slug in slugs:
        try:
            errs = check(site, slug, data, hub)
        except Exception as e:   # a page so broken it cannot be read is a failure, not a crash
            errs = [f"cannot read the page: {type(e).__name__}: {e}"]
        # rebuild: the page must already be what build.py writes
        before = {f: open(os.path.join(site, slug, f), encoding="utf-8").read() for f in ("index.html", "calc-config.json")}
        changed = build.build(site, slug, data, hub)
        if changed:
            errs.append("not up to date with the hub: " + ", ".join(changed))
            for f, s in before.items():
                open(os.path.join(site, slug, f), "w", encoding="utf-8").write(s)
        print(f"{slug}: {'OK' if not errs else 'FAIL'}")
        for e in errs[:20]:
            print("   -", e)
        bad += bool(errs)
    print(f"\n{len(slugs) - bad}/{len(slugs)} KB OK")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
