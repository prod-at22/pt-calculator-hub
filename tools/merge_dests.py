#!/usr/bin/env python3
"""Merge destinations produced by extract_rd.py into the LIVE data/data.json.

Always run this on the data.json pulled from the GitHub repo (git pull first), never on a
fresh build, so edits saved from the page are kept. Destinations listed in --keep are left
untouched; every other extracted destination is added or replaced (keeping its PO if one
was already set on the page). The change is recorded as one new version.

    python3 tools/merge_dests.py --dests <work>/dest --keep HND JBDO SEL SELJJU JJU JJUO --by product \
        --note "Added destinations from the R&D files"
"""
import argparse, datetime, glob, json, os

import apply_names

ROOT = os.path.join(os.path.dirname(__file__), "..")
# Project PT sheet order
ORDER = ["SEL", "SELJJU", "JJU", "JJUO", "TUR", "ISTBUR", "ISTCAP", "HND", "KIX", "OSK", "CTS", "DPS", "LOP", "JOG",
         "ACEH", "ACEHSBG", "LTOBA", "PDG", "JBDO", "SUBB", "DLMNHCM", "PQC", "HNSH", "DADH", "MEL", "PER", "NSNZ",
         "MLE", "KMGDLS", "PEK", "BKK", "PHU", "KBV", "SWS", "KKK", "SEM", "PHT"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dests", required=True)
    ap.add_argument("--keep", nargs="*", default=[])
    ap.add_argument("--by", required=True)
    ap.add_argument("--note", required=True)
    a = ap.parse_args()
    dp, hp = os.path.join(ROOT, "data", "data.json"), os.path.join(ROOT, "data", "history.json")
    data, hist = json.load(open(dp)), json.load(open(hp))
    cur = {d["code"]: d for d in data["destinations"]}
    added, replaced = [], []
    for f in sorted(glob.glob(os.path.join(a.dests, "*.json"))):
        d = json.load(open(f))
        if d["code"] in a.keep:
            continue
        if d["code"] in cur:
            if cur[d["code"]].get("po"):
                d["po"] = cur[d["code"]]["po"]
            replaced.append(d["code"])
        else:
            added.append(d["code"])
        cur[d["code"]] = d
    # catalog (package) names per destination, from the Project PT sheet — shown on the hub
    cats = json.load(open(os.path.join(os.path.dirname(__file__), "catalogs.json")))
    for code, d in cur.items():
        if code in cats:
            d["catalogs"] = cats[code]
    data["destinations"] = sorted(cur.values(), key=lambda d: ORDER.index(d["code"]) if d["code"] in ORDER else 999)
    apply_names.apply(data)   # package / operator display names (tools/names.json)
    now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    data.update(version=data["version"] + 1, updatedAt=now, updatedBy=a.by)
    # A re-import replaces whole destinations; older versions cannot be rebuilt cell by cell past it.
    hist["entries"].append({"v": data["version"], "at": now, "by": a.by, "rebase": True,
                            "note": "%s (added: %s; rebuilt: %s)" % (a.note, ", ".join(added) or "—", ", ".join(replaced) or "—"),
                            "changes": []})
    for path, obj in ((dp, data), (hp, hist)):
        with open(path, "w") as fh:
            json.dump(obj, fh, indent=1, ensure_ascii=False); fh.write("\n")
    print("v%d: %d destinations · added %d · rebuilt %s" % (data["version"], len(data["destinations"]), len(added), replaced))


if __name__ == "__main__":
    main()
