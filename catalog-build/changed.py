#!/usr/bin/env python3
"""Which catalogs must be rebuilt between two hub commits?

A catalog's page depends on its own file (data/catalogs/<slug>.json) AND on data/data.json (Costing prices,
Add On items). This resolves every catalog at both commits exactly the way build.py does (hub_data.py) and
prints the slugs whose result differs, plus "ALL" when catalog-build/ itself changed and "-slug" for a
catalog that was removed. Used by catalog-pt-public's mirror.yml.

    python3 catalog-build/changed.py <old-sha> <new-sha>      (run inside a full clone of the hub)
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hub_data  # noqa: E402


def show(ref, path):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def resolved(ref):
    data, index = json.loads(show(ref, "data/data.json") or '{"destinations": []}'), json.loads(show(ref, "data/catalogs/index.json") or "{}")
    names = subprocess.run(["git", "ls-tree", "--name-only", f"{ref}:data/catalogs"], capture_output=True, text=True).stdout.split()
    out = {}
    for fn in names:
        if not fn.endswith(".json") or fn == "index.json":
            continue
        slug = fn[:-5]
        c = json.loads(show(ref, f"data/catalogs/{fn}"))
        pkg = hub_data.package_for(slug, index, data)
        c["prices"] = hub_data.resolve(c, pkg)
        c["addons"] = hub_data.addons(c, slug, data, (index.get(slug) or {}).get("code") or c.get("code"))
        for k in ("addon_groups", "hub_version", "price_version"):
            c.pop(k, None)
        out[slug] = json.dumps(c, sort_keys=True)
    return out


def main(old, new):
    if subprocess.run(["git", "cat-file", "-e", f"{old}^{{commit}}"], capture_output=True).returncode != 0:
        print("ALL"); return
    if subprocess.run(["git", "diff", "--quiet", old, new, "--", "catalog-build"]).returncode != 0:
        print("ALL"); return
    a, b = resolved(old), resolved(new)
    print(" ".join(sorted(s for s in b if a.get(s) != b[s]) + ["-" + s for s in sorted(set(a) - set(b))]))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
