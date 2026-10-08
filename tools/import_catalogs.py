#!/usr/bin/env python3
"""Catalog content for the Catalog Details tab and for catalog-pt-public: data/catalogs/<slug>.json.

The hub is the source of truth; Catalog PT (Drive "Catalog PT (new)") mirrors data/catalogs/ — its
build.py pulls these files byte for byte before building catalog-pt-public. Edit catalogs HERE.

    python3 tools/import_catalogs.py                 # rebuild data/catalogs/index.json after editing a catalog
    python3 tools/import_catalogs.py --from-drive    # the one-off reverse import (8 Oct 2026); overwrites
                                                     # data/catalogs/ with Catalog PT's copy — not for normal use

index.json = {slug: {code, package, title, duration, version, updated, url}} — which calculator package each
catalog belongs to (MAP in crosscheck.py); the destination page's Catalog Details tab reads it.
"""
import argparse, glob, json, os, shutil, sys

sys.path.insert(0, os.path.dirname(__file__))
from crosscheck import MAP   # catalog slug -> (destination code, calculator package id)

ROOT = os.path.join(os.path.dirname(__file__), "..")
DRIVE = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-product@arbatravel.com/My Drive/Catalog PT (new)/catalogs")
OUT = os.path.join(ROOT, "data", "catalogs")


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--from-drive", action="store_true"); a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    if a.from_drive:
        for f in sorted(glob.glob(os.path.join(DRIVE, "*.json"))):
            assert json.load(open(f))["slug"] == os.path.basename(f)[:-5], f
            shutil.copyfile(f, os.path.join(OUT, os.path.basename(f)))   # byte for byte, so the mirror has no diff
    slugs = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(OUT, "*.json")) if not f.endswith("index.json"))
    data = json.load(open(os.path.join(ROOT, "data", "data.json")))
    pkgs = {(d["code"], p["id"]) for d in data["destinations"] for p in d["packages"]}
    index, loose = {}, []
    for slug in slugs:
        c = json.load(open(os.path.join(OUT, slug + ".json")))
        assert c["slug"] == slug, slug
        code, pid = MAP.get(slug, (c.get("code"), None))
        if pid and (code, pid) not in pkgs:
            raise SystemExit("MAP points %s at %s/%s, which is not a calculator package" % (slug, code, pid))
        if not pid:
            loose.append(slug)
        index[slug] = {"code": code, "package": pid, "title": c["title"], "duration": c.get("duration", ""),
                       "version": c.get("version", ""), "updated": c.get("updated", ""),
                       "url": "https://prod-at22.github.io/catalog-pt-public/%s.html" % slug}
    open(os.path.join(OUT, "index.json"), "w").write(json.dumps(index, indent=1, ensure_ascii=False) + "\n")
    print("%s%d catalogs in data/catalogs/ · index.json written" % ("imported from Drive · " if a.from_drive else "", len(slugs)))
    print("no calculator package: " + ", ".join(loose))


if __name__ == "__main__":
    main()
