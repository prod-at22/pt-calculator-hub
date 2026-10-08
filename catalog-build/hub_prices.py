"""Package prices for a catalog come from the PT R&D Costing Hub's Costing tab (Catalog Price column,
data/data.json), never from the catalog file. The catalog keeps only the table's shape:

    prices.columns          labels / ages (Adult, Child With Bed, Child No Bed — or one "Price Per Couple")
    prices.rows[i].pax      the pax band as printed ("2 - 3"); its price = the Costing price at the band's first pax
    prices.rows[i].na       pax types this band does not offer (printed "-"), e.g. ["cwb", "cnb"]
    prices.infant           text with {price} where the Costing infant price goes ("{price} per pax"); FOC when 0

A catalog with no Costing package (data/catalogs/index.json package = null) keeps literal rows[i].amounts.
Same rules as resolvePrices() in app.js.
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
