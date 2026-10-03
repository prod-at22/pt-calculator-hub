#!/usr/bin/env python3
"""Write the hub page (index.html) and one page per destination (<code>/index.html).

Every page is the same shell around app.js / app.css; only PT_DEST and PT_ROOT differ.
Run after adding a destination to data/data.json:  python3 tools/make_pages.py
"""
import json, os, shutil

ROOT = os.path.join(os.path.dirname(__file__), "..")
SHELL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="{root}app.css">
</head>
<body>
<header class="top"><div class="in">
  <div class="brand"><a href="{root}" style="color:#fff">ARBA · PT Costing</a> <small>{sub}</small></div>
  <span class="chip" id="verChip">loading…</span>
  <button class="btn" id="btnHistory">History</button>
  <span id="authArea"></span>
</div></header>
<main class="wrap">
  <div id="banners"></div>
  <section class="controls" id="controls"></section>
  <section class="kpis" id="kpis"></section>
  <section class="grid" id="grid"></section>
</main>
<div id="modalRoot"></div>
<script>window.PT_DEST = {dest}; window.PT_ROOT = "{root}";</script>
<script src="{root}app.js"></script>
</body>
</html>
"""


def main():
    data = json.load(open(os.path.join(ROOT, "data", "data.json")))
    open(os.path.join(ROOT, "index.html"), "w").write(
        SHELL.format(title="PT Costing Hub", sub="hub", dest="null", root=""))
    codes = []
    for d in data["destinations"]:
        code = d["code"].lower()
        os.makedirs(os.path.join(ROOT, code), exist_ok=True)
        open(os.path.join(ROOT, code, "index.html"), "w").write(
            SHELL.format(title="%s PT Costing" % d["code"], sub=d["name"], dest=json.dumps(d["code"]), root="../"))
        codes.append(code)
    print("wrote index.html +", ", ".join("%s/" % c for c in codes))


if __name__ == "__main__":
    main()
