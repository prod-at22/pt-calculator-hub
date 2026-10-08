"""What a catalog reads from the PT R&D Costing Hub's data/data.json instead of its own file.

Package prices come from the Costing tab (Catalog Price column). The catalog keeps only the table's shape:

    prices.columns          labels / ages (Adult, Child With Bed, Child No Bed — or one "Price Per Couple")
    prices.rows[i].pax      the pax band as printed ("2 - 3"); its price = the Costing price at the band's first pax
    prices.rows[i].na       pax types this band does not offer (printed "-"), e.g. ["cwb", "cnb"]
    prices.infant           text with {price} where the Costing infant price goes ("{price} per pax"); FOC when 0

A catalog with no Costing package (data/catalogs/index.json package = null) keeps literal rows[i].amounts.

Add-ons come from the Add On tab: every destination add-on ticked for the catalog (`catalogs` = {slug: position}),
grouped by `category` in the order of the catalog's `addon_groups` ([{title, notes?}]), sorted by position; each prints its name,
includes / excludes / duration and `price_lines` (the catalog's price text). A catalog of a code that is not
a hub destination keeps a literal `addons` list.
Same rules as resolvePrices() / catalogAddons() in app.js.
"""
import json, os, re

TYPES = ("adult", "cwb", "cnb")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("PT_DATA", os.path.join(HERE, "..", "data", "data.json"))


def rm(v):
    return "RM{:,}".format(int(round(float(v))))


def band_start(label):
    if re.search(r"night|hotel|villa|star", label, re.I):
        return None
    m = re.search(r"\d+", label)
    return int(m.group(0)) if m else None


def is_couple(prices):
    cols = prices.get("columns") or []
    return len(cols) == 1 and re.search(r"couple", cols[0].get("label", ""), re.I) is not None


def package_for(slug, index, data):
    ix = index.get(slug) or {}
    if not ix.get("package"):
        return None
    d = next((x for x in data["destinations"] if x["code"] == ix.get("code")), None)
    return next((p for p in d["packages"] if p["id"] == ix["package"]), None) if d else None


def resolve(cat, pkg):
    """Return a copy of cat["prices"] with amounts / infant filled from the Costing package."""
    pr = json.loads(json.dumps(cat.get("prices") or {}))
    if pkg is None or not pr.get("rows"):
        return pr
    P = pkg["pricing"]
    couple = is_couple(pr)
    for row in pr["rows"]:
        if "amounts" in row:          # literal (should not happen for a linked catalog)
            continue
        if couple:
            v = P["adult"].get("2")
            row["amounts"] = [rm(2 * float(v)) if v is not None else "-"]
            continue
        p = band_start(row.get("pax", ""))
        na = set(row.get("na") or [])
        out = []
        for k in TYPES[:len(pr.get("columns") or [])]:
            v = P[k].get(str(p)) if p is not None else None
            out.append("-" if k in na or v is None else rm(v))
        row["amounts"] = out
    inf = pr.get("infant")
    if isinstance(inf, str) and "{price}" in inf:
        v = float(P.get("infant") or 0)
        pr["infant"] = inf.replace("{price}", "FOC" if v == 0 else rm(v))
    return pr


def load_hub(catalogs_dir):
    data = json.load(open(DATA))
    index = json.load(open(os.path.join(catalogs_dir, "index.json")))
    return data, index


ADDON_TEXT = ("includes", "excludes", "duration")


def addons(cat, slug, data, code):
    """The catalog's add-on groups [{title, entries, notes?}], from the hub's Add On tab."""
    if "addons" in cat:               # literal (catalog of a code that is not a hub destination)
        return cat["addons"]
    d = next((x for x in data["destinations"] if x["code"] == code), None)
    if d is None:
        return []
    mine = sorted((a for a in d.get("addons") or [] if slug in (a.get("catalogs") or {})), key=lambda a: a["catalogs"][slug])
    groups = [dict(g) for g in cat.get("addon_groups") or []]
    titles = [g["title"] for g in groups]
    for a in mine:
        if a.get("category") not in titles:
            titles.append(a.get("category")); groups.append({"title": a.get("category")})
    out = []
    for g in groups:
        entries = []
        for a in mine:
            if a.get("category") != g["title"]:
                continue
            e = {"name": a["label"]}
            for k in ADDON_TEXT:
                if a.get(k):
                    e[k] = a[k]
            lines = a.get("price_lines")
            if not lines and isinstance(a.get("selling"), (int, float)):
                lines = [rm(a["selling"]) + ("/" + a["per"] if a.get("per") else "")]
            e["price_lines"] = lines or []
            entries.append(e)
        if entries:
            out.append({"title": g["title"], "entries": entries, **({"notes": g["notes"]} if g.get("notes") else {})})
    return out
