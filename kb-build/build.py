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
            a variant with no Costing package keeps its own tiers in `calc` (KB-only); "capAtHub": true =
            the calculator stops at the package's last priced pax (PO 9 Oct: Aceh stops at 30 pax)
Cosmetics stay in pt-kb-house: the page itself (layout, CSS, engine, travel map, logo) and the images,
which the hub refers to as "@asset:<key>" and which live in <slug>/assets.json next to the page.

    python3 kb-build/build.py <pt-kb-house dir> [slug ...]      (no slug = every KB in data/kb/)

Only the data blocks of <slug>/index.html are rewritten, so the KB's look and engine never change.
Run by pt-kb-house's mirror.yml after every hub save (like catalog-pt-public's mirror).
"""
import html as htmlmod, json, os, re, sys

HUB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HUB, "catalog-build"))
import hub_data  # noqa: E402  (same price rules as the customer catalog)
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


def hub_tiers(pkg, old, cap=False):
    """Calculator tiers from the Costing package: Catalog Price per pax (+ tierUpgrade, as priceRow does)
    for every pax the KB calculator covers. The KB's own pax bands are kept; a band splits only where the
    hub's price changes inside it. A pax the package has no price for keeps the KB's own price. A child
    price the package does not have keeps the KB's (0 = not sold), or follows the adult price when the KB
    priced the child like an adult (honeymoon = per couple). cap = the calculator stops at the hub's last
    priced pax (above it the KB says "melebihi N pax, sahkan kadar dengan operator")."""
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
    top = last if cap else max(last, max(t["from"] for t in old))   # open-ended KB bands (to 99999) stop the walk here
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
        if t["to"] > top and not cap:
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
            v["tiers"] = hub_tiers(pk[(ln["code"], ln["package"])], v["tiers"], ln.get("capAtHub", False))
    return calc



# ---------------------------------------------------------------- one source of truth
# A KB package linked to a catalog (map.packages[i] = {catalog, itinerary?}) takes its price table, itinerary
# and includes / excludes from the hub: Catalog Price (Costing tab) + data/catalogs/<slug>.json (Itinerary
# tab). The KB file keeps only what the catalog does not have.
def cat_items(a):
    out = []
    for it in a or []:
        if isinstance(it, str):
            out.append(it)
        else:
            out.append(it.get("text", "") + (" — " + "; ".join(it["sub"]) if it.get("sub") else ""))
    return out


def cat_days(cat, opt):
    days = cat["itineraries"][opt]["days"] if opt is not None and cat.get("itineraries") else cat.get("itinerary") or []
    return [{"d": d.get("day"), "t": d.get("title", ""), "m": d.get("meals") or "-", "a": cat_items(d.get("activities"))} for d in days]


def money(v):
    return "RM " + f"{float(v):,.0f}" if float(v).is_integer() else "RM " + f"{float(v):,.2f}"


class Hub:
    def __init__(self, data):
        self.data = data
        self.index = json.load(open(os.path.join(HUB, "data", "catalogs", "index.json"), encoding="utf-8"))
        self.cats = {}

    def cat(self, slug):
        if slug not in self.cats:
            self.cats[slug] = json.load(open(os.path.join(HUB, "data", "catalogs", slug + ".json"), encoding="utf-8"))
        return self.cats[slug]

    def pkg(self, slug):
        return hub_data.package_for(slug, self.index, self.data)

    def prices(self, slug):
        return hub_data.resolve(self.cat(slug), self.pkg(slug))

    def adult(self, slug):
        """{pax: adult catalog price} as printed (Costing Catalog Price, or the catalog's own amounts)."""
        pk = self.pkg(slug)
        if pk:
            return {int(k): float(v) for k, v in pk["pricing"].get("adult", {}).items() if isinstance(v, (int, float)) and v}
        out = {}
        for r in self.cat(slug).get("prices", {}).get("rows", []):
            n = re.findall(r"\d+", r.get("pax", "")); a = (r.get("amounts") or [None])[0]
            if n and a and re.search(r"\d", a):
                out[int(n[0])] = float(re.sub(r"[^\d.]", "", a))
        return out


def price_table(hub, slug):
    c, P = hub.cat(slug), hub.prices(slug)
    cols = P.get("columns") or []
    head = "".join(f"<th>{htmlmod.escape(x.get('label', ''))}" + (f"<br><small>{htmlmod.escape(x['age'])}</small>" if x.get("age") else "") + "</th>" for x in cols)
    rows = "".join("<tr><td class='it'>" + htmlmod.escape(r.get("pax", "")) + "</td>" + "".join(
        f"<td{' class=add' if i == 0 else ''}>{htmlmod.escape(a or '-')}</td>" for i, a in enumerate(r.get("amounts") or [])) + "</tr>" for r in P.get("rows") or [])
    note = [f"Infant: {htmlmod.escape(P['infant'])}" if P.get("infant") else "", htmlmod.escape(c.get("basis") or ""),
            f"Sah sehingga {htmlmod.escape(c['valid_until'])}" if c.get("valid_until") else ""] + [htmlmod.escape(n) for n in P.get("notes") or []]
    url = (hub.index.get(slug) or {}).get("url", "")
    link = " · <a href='" + url + "' target='_blank' rel='noopener'>Katalog customer ↗</a>" if url else ""
    return (f"<div class='custblk'><h3>{htmlmod.escape(c.get('title', slug))} · {htmlmod.escape(c.get('duration', ''))}</h3>"
            f"<table class='ctbl'><thead><tr><th>{htmlmod.escape(P.get('pax_label') or 'Bil. pax')}</th>{head}</tr></thead><tbody>{rows}</tbody></table>"
            "<p class='custnote'>" + " · ".join(x for x in note if x) + link + "</p></div>")


def kbonly_table(name, tiers):
    if len(tiers) == 1 and tiers[0]["from"] == tiers[0]["to"] == 2 and isinstance(tiers[0]["a"], (int, float)):   # per couple
        return (f"<div class='custblk'><h3>{name}</h3><table class='ctbl'><thead><tr><th>Pakej</th><th>Harga per pasangan</th></tr></thead>"
                f"<tbody><tr><td class='it'>{name}</td><td class=add>{money(2 * tiers[0]['a'])}</td></tr></tbody></table>"
                "<p class='custnote'>Tiada katalog customer — harga KB (Simple Calculator).</p></div>")
    rows = "".join(f"<tr><td class='it'>{t['from'] if t['from'] == t['to'] else str(t['from']) + '–' + (str(t['to']) if t['to'] < 999 else '+')}</td>"
                   + "".join(f"<td{' class=add' if i == 0 else ''}>{money(t[k]) if isinstance(t[k], (int, float)) and t[k] > 0 else '-'}</td>" for i, k in enumerate("acn")) + "</tr>"
                   for t in tiers)
    return (f"<div class='custblk'><h3>{name}</h3><table class='ctbl'><thead><tr><th>Bil. pax</th><th>Adult</th><th>Child With Bed</th><th>Child No Bed</th></tr></thead>"
            f"<tbody>{rows}</tbody></table><p class='custnote'>Tiada katalog customer — harga KB (Simple Calculator).</p></div>")


def pricing_html(hub, kb, calc, links, names):
    seen, parts = set(), []
    for i, ln in enumerate(links):
        if ln and ln["catalog"] not in seen:
            seen.add(ln["catalog"]); parts.append(price_table(hub, ln["catalog"]))
        elif not ln:
            vid = (kb["map"].get("kbonly") or {}).get(str(i))
            v = next((x for x in calc["variants"] if x["id"] == vid), None)
            if v:
                parts.append(kbonly_table(names[i], v["tiers"]))
    return ("<h2>Harga &amp; Pakej</h2><p class='ssub'>Harga katalog per pax dari PT R&amp;D Costing Hub — sama seperti katalog customer. "
            "Itinerary, termasuk &amp; tidak termasuk ikut tab Itinerary hub.</p>" + "".join(parts))




def _esc(x):
    return htmlmod.escape(str(x or ""))


def _cat_codes(hub, slug):
    cat = hub.cat(slug)
    return (hub.index.get(slug) or {}).get("code") or cat.get("code")


def _dedupe(parts):
    """[(title, body)] → one block per distinct body, titles joined."""
    out = {}
    for t, b in parts:
        if b:
            out.setdefault(b, []).append(t)
    return [(" · ".join(dict.fromkeys(ts)), b) for b, ts in out.items()]


def surcharge_html(hub, links):
    """KB Surcharge tab from the hub's Surcharge tab (+ hotel rows from the Accommodation tab), as the catalog prints it."""
    parts = []
    for slug in dict.fromkeys(l["catalog"] for l in links if l):
        cat = json.loads(json.dumps(hub.cat(slug)))
        hub_data.apply_hotels(cat, slug, hub.data, _cat_codes(hub, slug))
        S = cat.get("surcharge") or {}
        cols, rows, seas, notes = S.get("columns") or [], S.get("rows") or [], S.get("seasons") or [], S.get("notes") or []
        body = ""
        if rows:
            head = "".join(f"<th>{_esc(c.get('label'))}" + (f"<br><small>{_esc(c['period'])}</small>" if c.get("period") else "") + "</th>" for c in cols)
            body += ("<table class='ctbl'><thead><tr><th>Jenis</th><th>Hotel</th>" + head + "</tr></thead><tbody>"
                     + "".join(f"<tr><td class='it'>{_esc(r.get('type'))}</td><td>{_esc(r.get('name'))}{' <small>or similar</small>' if r.get('similar') else ''}</td>"
                               + "".join(f"<td{' class=add' if i == 0 else ''}>{_esc(a or '-')}</td>" for i, a in enumerate(r.get('amounts') or [])) + "</tr>" for r in rows)
                     + "</tbody></table>")
        if seas:
            body += ("<table class='ctbl'><thead><tr><th>Musim</th><th>Tarikh perjalanan</th><th>Surcaj</th></tr></thead><tbody>"
                     + "".join(f"<tr><td class='it'>{_esc(x.get('label'))}</td><td>{_esc(x.get('period'))}</td><td class=add>{_esc(x.get('rate'))}</td></tr>" for x in seas)
                     + "</tbody></table>")
        if notes:
            body += "<p class='custnote'>" + " · ".join(_esc(n) for n in notes) + "</p>"
        parts.append((f"{_esc(cat.get('title'))} · {_esc(cat.get('duration'))}", body))
    blocks = _dedupe(parts)
    if not blocks:
        return ""
    return ("<p class='ssub'>Surcaj ikut katalog customer — dari tab Surcharge &amp; Accommodation PT R&amp;D Costing Hub.</p>"
            + "".join(f"<div class='custblk'><h3>{t}</h3>{b}</div>" for t, b in blocks))


def addons_html(hub, links):
    """Catalog add-ons (the hub's Add On tab, ticked for this KB's catalogs), one row per item."""
    seen, rows = set(), []
    for slug in dict.fromkeys(l["catalog"] for l in links if l):
        for g in hub_data.addons(hub.cat(slug), slug, hub.data, _cat_codes(hub, slug)):
            for e in g["entries"]:
                if e["name"] in seen:
                    continue
                seen.add(e["name"])
                note = " · ".join(_esc(x) for x in (e.get("includes"), e.get("duration")) if x)
                rows.append(f"<tr><td class='it'>{_esc(e['name'])}</td><td class=add>{'<br>'.join(_esc(x) for x in e.get('price_lines') or [])}</td><td>{note}</td></tr>")
    if not rows:
        return ""
    return ("<div class='custblk'><h3>Add-on katalog</h3><table class='ctbl'><thead><tr><th>Add-on</th><th>Harga</th><th>Nota</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table><p class='custnote'>Dari tab Add On PT R&amp;D Costing Hub (sama seperti katalog customer).</p></div>")


def policy_html(hub, links):
    """KB Polisi tab from the hub's Policy tab (catalog Important Notes + Deposit & Full Payment)."""
    parts = []
    for slug in dict.fromkeys(l["catalog"] for l in links if l):
        cat = hub.cat(slug)
        body = "".join((f"<h4>{_esc(n['title'])}</h4>" if n.get("title") else "") + "<ul>" + "".join(f"<li>{_esc(x if isinstance(x, str) else x.get('text'))}</li>" for x in n.get("entries") or []) + "</ul>" for n in cat.get("notes") or [])
        if cat.get("deposit"):
            body += "<ul>" + "".join(f"<li><b>{_esc(d.get('figure'))}</b> {_esc(d.get('text'))}</li>" for d in cat["deposit"]) + "</ul>"
        parts.append((f"{_esc(cat.get('title'))} · {_esc(cat.get('duration'))}", body))
    return "".join(f"<div class='custblk'><h3>{t}</h3>{b}</div>" for t, b in _dedupe(parts))


def _after_heading(h, insert):
    """Put generated HTML right after the block's own heading section (the part before the first custblk)."""
    m = re.search(r"<div class=['\"]custblk['\"]", h or "")
    return (h[:m.start()] + insert + h[m.start():]) if m else (h or "") + insert

TOKEN = re.compile(r"\{\{(dari|2pax|pasangan):(\d+)\}\}")


def fill_tokens(obj, hub, links, slug):
    def val(kind, i):
        ln = links[i] if i < len(links) else None
        if not ln:
            raise SystemExit(f"{slug}: {{{{{kind}:{i}}}}} — package {i} has no catalog")
        A = hub.adult(ln["catalog"])
        if not A:
            raise SystemExit(f"{slug}: no price for {ln['catalog']}")
        v = min(A.values()) if kind == "dari" else A.get(min(A)) if kind == "2pax" else 2 * A.get(min(A))
        return "RM" + (f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}")
    if isinstance(obj, str):
        return TOKEN.sub(lambda m: val(m.group(1), int(m.group(2))), obj) if "{{" in obj else obj
    if isinstance(obj, list):
        return [fill_tokens(x, hub, links, slug) for x in obj]
    if isinstance(obj, dict):
        return {k: fill_tokens(v, hub, links, slug) for k, v in obj.items()}
    return obj


def hotel_cards(cards, hub):
    """KB hotel cards name their hotels by id (Accommodation tab, data.json destinations[].hotels): the card's
    name is the hotels' names, then the card's own extra text."""
    H = {h["id"]: h for d in hub.data["destinations"] for h in d.get("hotels") or []}
    out = []
    for card in cards or []:
        if "hotels" not in card:
            out.append(card); continue
        hs = [H[i] for i in card["hotels"] if i in H]
        names = " / ".join(dict.fromkeys(h["name"] for h in hs if h.get("name")))
        extra = card.get("extra") or ""
        if any(h.get("similar") for h in hs) and not re.search(r"(?i)setara|similar", names + extra):
            names += " (atau setaraf)"
        c = {k: v for k, v in card.items() if k not in ("hotels", "extra")}
        c["name"] = " / ".join(x for x in (names, extra) if x)
        out.append(c)
    return out


def content_from_hub(kb, calc, hub):
    """The KB content with every catalog-linked part filled from the hub."""
    c = json.loads(json.dumps(kb["content"]))
    hk = "HOTELS" if kb["kind"] == "bespoke" else "hotels"
    if hk in c:
        c[hk] = hotel_cards(c[hk], hub)
    links = (kb.get("map") or {}).get("packages")
    if not links:
        return c
    bespoke = kb["kind"] == "bespoke"
    P, I = (c["PKG"], c["ITIN"]) if bespoke else (c["packages"], c["itineraries"])
    for i, ln in enumerate(links):
        if not ln:
            continue
        cat = hub.cat(ln["catalog"])
        pb = (cat.get("price_blocks") or [{}])[0]
        P[i]["inc"], P[i]["exc"] = cat_items(pb.get("includes")), cat_items(pb.get("excludes"))
        I[i] = cat_days(cat, ln.get("itinerary"))
    names = [htmlmod.unescape(p.get("n", "")) for p in P]
    if bespoke and "PRICES" in c:                      # korea: structured price rows
        for i, ln in enumerate(links):
            if ln and i < len(c["PRICES"]):
                pr = hub.prices(ln["catalog"])
                c["PRICES"][i]["rows"] = [[r.get("pax", "")] + [re.sub(r"^RM\s?", "", a or "-") for a in (r.get("amounts") or [])] for r in pr.get("rows") or []]
    elif bespoke:
        c["PRICING_HTML"] = pricing_html(hub, kb, calc, links, names) + (c.get("PRICING_HTML") or "")
    else:
        c["blocks"]["pricing"] = pricing_html(hub, kb, calc, links, names) + (c["blocks"].get("pricing") or "")
    B, key = (c, lambda b: b.upper() + "_HTML") if bespoke else (c["blocks"], lambda b: b)
    if key("surcharge") in B:      # Surcharge tab: the catalog's, then the KB's own notes (Surcharge lain, Travel Date 2027 …)
        B[key("surcharge")] = "<h2>Surcharge</h2>" + _after_heading(B[key("surcharge")] or "", surcharge_html(hub, links))
    if key("custom") in B:         # Simple Customisation: catalog add-ons from the Add On tab + the KB's rate card
        B[key("custom")] = _after_heading(B[key("custom")], addons_html(hub, links))
    if key("polisi") in B:         # Polisi & Payment: the Policy tab
        B[key("polisi")] = "<h2>Polisi &amp; Payment</h2>" + policy_html(hub, links) + (B[key("polisi")] or "")
    return fill_tokens(c, hub, links, kb["slug"])

PKGSEL = re.compile(r"(<select[^>]*id='c_pkg'[^>]*>)(.*?)(</select>)", re.S)


def sync_pkg_select(content, calc):
    """The calculator's package dropdown (blocks.calc) lists calc.variants by index; keep it in step."""
    h = (content.get("blocks") or {}).get("calc")
    m = PKGSEL.search(h or "")
    if not m or "<option" not in m.group(2):
        return content
    opts = "".join(f"<option value='{i}'>{v['name']}</option>" for i, v in enumerate(calc["variants"]))
    if opts == m.group(2):
        return content
    content = {**content, "blocks": {**content["blocks"], "calc": h[:m.start(2)] + opts + h[m.end(2):]}}
    return content


def one(m, html, what, slug):
    if len(m) != 1:
        raise SystemExit(f"{slug}: expected one {what} block in index.html, found {len(m)}")
    return m[0]


def build(site, slug, data, hub):
    kb = json.load(open(os.path.join(KBDIR, slug + ".json"), encoding="utf-8"))
    calc = calc_from_hub(kb, data)
    kb = {**kb, "content": content_from_hub(kb, calc, hub)}
    page = os.path.join(site, slug, "index.html")
    html = open(page, encoding="utf-8").read()
    ap = os.path.join(site, slug, "assets.json")
    assets = json.load(open(ap, encoding="utf-8")) if os.path.exists(ap) else {}
    new = html
    m = one(list(KBDATA.finditer(new)), new, "kbdata", slug)
    content = sync_pkg_select(kb["content"], calc) if kb["kind"] == "template" else kb["content"]
    new = new[:m.start(2)] + script_json(detoken(content, assets, slug)) + new[m.end(2):]
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
    hub = Hub(data)
    for slug in slugs:
        ch = build(site, slug, data, hub)
        print(f"{slug}: {', '.join(ch) if ch else 'unchanged'}")


if __name__ == "__main__":
    main(sys.argv[1:])
