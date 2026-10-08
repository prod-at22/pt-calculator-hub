#!/usr/bin/env python3
"""One-off reverse import: Catalog PT (the catalog-pt-public source) -> data/catalogs/<slug>.json.

Catalog PT renders catalogs/<slug>.json into https://prod-at22.github.io/catalog-pt-public/. From now on
the costing hub holds that content and Catalog PT mirrors it, so the files are copied unchanged (same
schema, same file names) — Catalog PT's build.py can read data/catalogs/ directly.

    python3 tools/import_catalogs.py            # copies every catalog + writes data/catalogs/index.json

index.json = {slug: {code, package, title, duration, version, updated, url}} — which calculator package each
catalog belongs to (from MAP in crosscheck.py); the destination page's Catalog Details tab reads it.
"""
import glob, json, os, shutil, sys

sys.path.insert(0, os.path.dirname(__file__))
from crosscheck import MAP   # catalog slug -> (destination code, calculator package id)

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-product@arbatravel.com/My Drive/Catalog PT (new)/catalogs")
OUT = os.path.join(ROOT, "data", "catalogs")


def main():
    os.makedirs(OUT, exist_ok=True)
    slugs = []
    for f in sorted(glob.glob(os.path.join(SRC, "*.json"))):
        c = json.load(open(f))
        assert c["slug"] == os.path.basename(f)[:-5], f
        shutil.copyfile(f, os.path.join(OUT, c["slug"] + ".json"))   # byte for byte, so the mirror has no diff
        slugs.append(c["slug"])
    data = json.load(open(os.path.join(ROOT, "data", "data.json")))
    pkgs = {(d["code"], p["id"]) for d in data["destinations"] for p in d["packages"]}
    index, loose = {}, []
    for slug in slugs:
        c = json.load(open(os.path.join(OUT, slug + ".json")))
        code, pid = MAP.get(slug, (c.get("code"), None))
        if pid and (code, pid) not in pkgs:
            raise SystemExit("MAP points %s at %s/%s, which is not a calculator package" % (slug, code, pid))
        if not pid:
            loose.append(slug)
        index[slug] = {"code": code, "package": pid, "title": c["title"], "duration": c.get("duration", ""),
                       "version": c.get("version", ""), "updated": c.get("updated", ""),
                       "url": "https://prod-at22.github.io/catalog-pt-public/%s.html" % slug}
    open(os.path.join(OUT, "index.json"), "w").write(json.dumps(index, indent=1, ensure_ascii=False) + "\n")
    print("copied %d catalogs to data/catalogs/ (+ index.json)" % len(slugs))
    print("no calculator package: " + ", ".join(loose))

if __name__ == "__main__":
    main()
