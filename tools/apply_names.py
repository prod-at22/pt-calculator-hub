"""Apply tools/names.json to data/data.json: package names (no operator), TO = operator name.

    python3 tools/apply_names.py --by product            # records one history version
merge_dests.py calls apply() after every import so a re-import keeps these names.
"""
import argparse, datetime, json, os

HERE = os.path.dirname(__file__)


def apply(data):
    names = json.load(open(os.path.join(HERE, "names.json")))
    changes = []
    for d in data["destinations"]:
        n = names.get(d["code"])
        if not n:
            continue
        for key, field, ids in (("packages", "label", n.get("packages", {})), ("variants", "label", n.get("variants", {}))):
            for item in d[key]:
                new = ids.get(item["id"])
                if new and item.get(field) != new:
                    changes.append({"path": ["destinations", d["code"], key, item["id"], field], "from": item.get(field), "to": new,
                                    "label": "%s › %s %s name" % (d["name"], "Package" if key == "packages" else "TO", item["id"])})
                    item[field] = new
        for pid, extra in n.get("alsoVariants", {}).items():
            p = next((x for x in d["packages"] if x["id"] == pid), None)
            if p is not None and p.get("alsoVariants") != extra:
                changes.append({"path": ["destinations", d["code"], "packages", pid, "alsoVariants"], "from": p.get("alsoVariants"), "to": extra,
                                "label": "%s › Package %s TO choices" % (d["name"], pid)})
                p["alsoVariants"] = extra
    return changes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--by", default="product")
    a = ap.parse_args()
    dp, hp = os.path.join(HERE, "..", "data", "data.json"), os.path.join(HERE, "..", "data", "history.json")
    data, hist = json.load(open(dp)), json.load(open(hp))
    ch = apply(data)
    if not ch:
        print("names already applied"); return
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    data.update(version=data["version"] + 1, updatedAt=now, updatedBy=a.by)
    hist["entries"].append({"v": data["version"], "at": now, "by": a.by, "note": "Package = package name; Tour operator = operator name", "changes": ch})
    for p, o in ((dp, data), (hp, hist)):
        open(p, "w").write(json.dumps(o, indent=1, ensure_ascii=False) + "\n")
    print("v%d: %d names changed" % (data["version"], len(ch)))


if __name__ == "__main__":
    main()
