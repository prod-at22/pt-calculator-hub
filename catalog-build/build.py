#!/usr/bin/env python3
"""Build the Private Tour catalog site.

Reads one JSON per package from catalogs/, renders it through
templates/catalog.html.j2, writes the result into site/, and prints that
page to site/<slug>.pdf so Download PDF hands over the catalog the page is
actually showing. Mirrors how the Group Tour catalog is
laid out: site/ IS the GitHub Pages repo — a flat directory of index.html
plus a <slug>.html / <slug>.pdf pair per package, with no build step, no
external assets and no server needed. Opening site/index.html off disk gives
you exactly what the published site does.

Pages are self-contained by design, not by accident: the stylesheet, the
icons and both logos are inlined into every page. It means a catalog can be
mailed as a single file, or opened from a phone with no signal, and still
render — which is the situation a TC is usually in.

    python3 catalog-build/build.py              # build everything into catalog-build/site/
    python3 catalog-build/build.py seoul-basic  # build one, plus the index

Lives in the PT R&D Costing Hub repo and reads its data/catalogs/ directly — the hub is the source of
truth. CI (.github/workflows/catalogs.yml) runs this on every push that touches data/catalogs/ or
catalog-build/ and pushes site/ to prod-at22/catalog-pt-public. PT_SITE overrides the output folder.
"""
import base64
import contextlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from markupsafe import Markup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hub_data  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
CATALOGS = os.environ.get("PT_CATALOGS", os.path.join(ROOT, "..", "data", "catalogs"))
TEMPLATES = os.path.join(ROOT, "templates")
ASSETS = os.path.join(ROOT, "assets")
ICONS = os.path.join(ASSETS, "icons")
SITE = os.environ.get("PT_SITE", os.path.join(ROOT, "site"))

# Where the original Canva catalog PDFs live. The build no longer copies
# these — each page's Download PDF is the page itself, printed — but the
# path is kept so `source_pdf` in a catalog JSON stays resolvable as a
# record of what the content was transcribed from. Overridable via
# PT_PDF_ROOT for a checkout with no Drive mount.
PDF_ROOT = os.environ.get(
    "PT_PDF_ROOT", os.path.join(os.path.dirname(ROOT), "Project PT ")
)

# How long to let one page's print run before giving up on it.
PDF_TIMEOUT = 90


def load_icons():
    with open(os.path.join(ICONS, "index.json")) as fh:
        index = json.load(fh)
    bodies = {}
    for name, filename in index["by_name"].items():
        with open(os.path.join(ICONS, filename)) as fh:
            bodies[name] = fh.read().strip()
    return index, bodies


def make_icon_filter(index, bodies):
    """Resolve an icon reference to inline SVG.

    A catalog can name an icon three ways, in order of preference: the
    semantic name this project defines ("hotel"), an alias for one
    ("accommodation"), or the label text the Group Tour site used it with
    ("Lots of Walking"). The third exists so a PT catalog reusing a GT
    "What to Expect" tile verbatim gets the same glyph without anyone having
    to look up which one it was.
    """
    missing = set()

    def icon(ref):
        if not ref:
            return Markup("")
        key = str(ref).strip()
        name = (
            key if key in bodies
            else index["aliases"].get(key.lower())
            or index["by_label"].get(key.lower())
        )
        if name not in bodies:
            missing.add(key)
            return Markup("")
        return Markup(
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" '
            'viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + bodies[name]
            + "</svg>"
        )

    icon.missing = missing
    return icon


def data_uri(path):
    with open(path) as fh:
        return fh.read().strip()


def search_blob(c):
    """Everything the index filter should match a row on."""
    parts = [
        c.get("destination", ""), c.get("tier", ""), c.get("tier_code", ""),
        c.get("code", ""), c.get("country", ""), c.get("duration", ""),
        c.get("title", ""), c.get("slug", ""),
    ]
    return " ".join(p for p in parts if p).lower()


def sort_key(c):
    """Alphabetical by destination like the GT index, then by tier.

    Tiers sort in package order rather than alphabetically, so a destination
    reads Basic → Standard → Premium down the page instead of Basic →
    Premium → Standard, which is how the printed catalogs are ordered and
    how a TC steps a customer up.
    """
    rank = {
        "BSC": 0, "STD": 1, "PRE": 2,
        "HNYSTD": 3, "HNYPRE": 4, "WV": 5, "WVC": 6,
    }
    return (
        c.get("destination", "").lower(),
        rank.get(c.get("tier_code", ""), 9),
        c.get("duration", ""),
    )


# Templates run under StrictUndefined so a typo'd field name fails the build
# instead of rendering as a blank. The trade-off is that a genuinely absent
# optional section would fail too, so every optional top-level field is filled
# in here with the empty value that makes its section disappear. Anything not
# on this list is required, and its absence is meant to be an error.
OPTIONAL_FIELDS = {
    "country": "", "code": "", "tier": "", "tier_code": "",
    "duration": "", "route": "", "basis": "", "valid_until": "",
    "version": "", "kb_url": "", "hero_note": "",
    "po": "", "ops": "", "source_pdf": "",
    "highlights": [], "price_blocks": [], "accommodation": [],
    "itinerary": [], "addons": [], "expect": [], "notes": [], "deposit": [],
    "prices": None, "surcharge": None,
}


# Jinja resolves foo.bar as an attribute before falling back to a key, so a
# field named after a dict method silently hands the template the method
# instead of the data — "values" yields dict.values and the loop over it dies
# with a type error a long way from the cause. Catch it at load time and name
# the offending file, rather than leaving it for whoever transcribes the next
# catalog to rediscover.
RESERVED_KEYS = {
    "items", "values", "keys", "get", "pop", "copy", "update", "clear",
    "setdefault", "popitem",
}


def check_reserved(node, path, problems):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in RESERVED_KEYS:
                problems.append(
                    f"reserved key {key!r} at {path or '<root>'} — "
                    f"Jinja reads it as a dict method; rename it"
                )
            check_reserved(value, f"{path}.{key}" if path else key, problems)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            check_reserved(value, f"{path}[{i}]", problems)


def normalise(c):
    for field, empty in OPTIONAL_FIELDS.items():
        if field not in c:
            c[field] = [] if isinstance(empty, list) else empty
    return c


def load_catalogs(only=None):
    catalogs, problems = [], []
    # prices (Costing tab) and add-ons (Add On tab) are not in the catalog file: they come from data.json (hub_data.py)
    hdata, hindex = hub_data.load_hub(CATALOGS)
    for fn in sorted(os.listdir(CATALOGS)):
        if not fn.endswith(".json") or fn.startswith("_") or fn == "index.json":   # index.json = hub's slug → package map
            continue
        slug = fn[:-5]
        if only and slug not in only:
            continue
        with open(os.path.join(CATALOGS, fn)) as fh:
            try:
                c = json.load(fh)
            except json.JSONDecodeError as exc:
                problems.append(f"{fn}: invalid JSON — {exc}")
                continue
        c.setdefault("slug", slug)
        if c["slug"] != slug:
            problems.append(f"{fn}: slug {c['slug']!r} does not match filename")
        for required in ("destination", "title", "updated"):
            if not c.get(required):
                problems.append(f"{fn}: missing required field {required!r}")
        reserved = []
        check_reserved(c, "", reserved)
        problems.extend(f"{fn}: {r}" for r in reserved)
        pkg = hub_data.package_for(slug, hindex, hdata)
        c["prices"] = hub_data.resolve(c, pkg)
        c["addons"] = hub_data.addons(c, slug, hdata, (hindex.get(slug) or {}).get("code") or c.get("code"))
        c.pop("addon_groups", None)
        for row in (c.get("prices") or {}).get("rows") or []:
            if "amounts" not in row:
                problems.append(f"{fn}: price row {row.get('pax')!r} has no amounts and no Costing package to read them from")
        normalise(c)
        c["pdf"] = c["slug"] + ".pdf"
        c.setdefault("pdf_download_name", pdf_download_name(c))
        c["search"] = search_blob(c)
        catalogs.append(c)
    return catalogs, problems


def pdf_download_name(c):
    """Match the Group Tour download convention: readable name, then date.

    GT saves as e.g. "GT Turki 9D7N v1_030926.pdf" — prefix, destination,
    duration, version, then DDMMYY. Same here with a PT prefix and the tier,
    so a TC with both sites' downloads in one folder can tell them apart.
    """
    # Self Tour packages (no driver-guide) carry "ST" instead of "PT".
    bits = [c.get("product") or "PT", c.get("destination", "")]
    if c.get("tier"):
        bits.append(c["tier"])
    if c.get("duration"):
        bits.append(c["duration"])
    if c.get("version"):
        bits.append(c["version"])
    stamp = ""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(c.get("updated", "")))
    if m:
        stamp = "_" + m.group(3) + m.group(2) + m.group(1)[2:]
    return " ".join(b for b in bits if b) + stamp + ".pdf"


def find_chrome():
    for path in (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ):
        if os.path.exists(path) and os.access(path, os.X_OK):
            return path
    # Linux (CI): the real Chrome first — /usr/bin/chromium on Ubuntu is a snap wrapper that hangs headless
    return (os.environ.get("PT_CHROME") or shutil.which("google-chrome-stable") or shutil.which("google-chrome")
            or shutil.which("chromium-browser") or shutil.which("chromium"))



@contextlib.contextmanager
def _throwaway_dir(prefix):
    """A temp folder whose cleanup can't fail the build (Python 3.9 has no
    ignore_cleanup_errors): Chrome may still be writing into it when stopped."""
    path = tempfile.mkdtemp(prefix=prefix)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)

def render_pdf(c, chrome):
    """Print the generated page to PDF — NOT a copy of the Canva original.

    The Download PDF button has to hand over the catalog the page is showing.
    Shipping the old Canva export instead means a TC reads the new prices on
    screen, downloads the file to send to a customer, and sends the previous
    version's prices — the one failure this whole migration exists to stop.

    So the PDF is the page itself, printed. That is also what the Group Tour
    site serves (its PDFs are Chromium/Skia output at A4, not the Canva
    files), and it is why the stylesheet carries a full @media print block:
    cards that refuse to split mid-box, itinerary and price tables that
    repeat their header across pages, and print-color-adjust on the parts
    that stop being readable in greyscale.

    `source_pdf` stays in the catalog JSON, but purely as provenance — a
    record of which Canva export the content was transcribed from.
    """
    if not chrome:
        return "no Chrome/Chromium found to render the PDF"

    page = os.path.join(SITE, c["slug"] + ".html")
    dest = os.path.join(SITE, c["pdf"])
    if not os.path.exists(page):
        return f"page not built: {c['slug']}.html"

    if os.path.exists(dest):
        os.remove(dest)

    # Chrome can still be writing into its throwaway profile when it is
    # stopped, so the cleanup sometimes finds a non-empty folder; that must
    # not fail a build whose PDF is already written.
    with _throwaway_dir("pt-pdf-") as profile:
        # A throwaway profile keeps this off the user's own Chrome, which is
        # very likely running: sharing a user-data-dir with a live instance
        # makes the headless run bail out instead of printing.
        proc = subprocess.Popen(
            [
                chrome,
                "--headless",
                "--disable-gpu",
                # CI runners (Linux, root-less container) cannot start Chrome's sandbox
                *(["--no-sandbox"] if sys.platform.startswith("linux") else []),
                f"--user-data-dir={profile}",
                "--no-first-run",
                "--no-default-browser-check",
                "--no-pdf-header-footer",
                f"--print-to-pdf={dest}",
                pathlib.Path(page).as_uri(),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # Chrome writes the PDF and then just sits there — every headless
        # mode on this build does, so waiting for the process to exit means
        # waiting forever. Watch the output file instead: once it exists and
        # has stopped growing, the print is finished and Chrome can go.
        deadline = time.time() + PDF_TIMEOUT
        last_size, stable_since = -1, None
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            size = os.path.getsize(dest) if os.path.exists(dest) else 0
            if size > 0 and size == last_size:
                if stable_since is None:
                    stable_since = time.time()
                elif time.time() - stable_since >= 1.0:
                    break
            else:
                stable_since = None
            last_size = size
            time.sleep(0.25)

        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)

    if not os.path.exists(dest) or os.path.getsize(dest) == 0:
        return "PDF render produced no output"
    with open(dest, "rb") as fh:
        if fh.read(5) != b"%PDF-":
            return "PDF render produced a file that is not a PDF"
    return None


def main(argv):
    only = set(a for a in argv if not a.startswith("--")) or None
    os.makedirs(SITE, exist_ok=True)

    index_json, bodies = load_icons()
    icon = make_icon_filter(index_json, bodies)

    env = Environment(
        loader=FileSystemLoader(TEMPLATES),
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
        autoescape=True,
    )
    # A surcharge period strings several date ranges together with "|", "·"
    # or ", " (whichever the source catalog used); split them so each range
    # prints on its own line instead of one run-on line.
    env.filters["periods"] = lambda s: [p for p in re.split(r"\s*[|·]\s*|,\s+(?=\d)", s or "") if p.strip()]
    # An add-on price line such as "RM85/pax for Adult (12 years old and
    # above)" prints its figure bold and its qualifier small underneath; a
    # line that is only a qualifier ("(Pickup & Drop Off ...)", "*Transport
    # capacity ...") prints small on its own.
    def price_parts(line):
        line = (line or "").strip()
        if line.startswith(("(", "*")):
            return ("", line)
        m = re.match(r"^(.*?\S)\s*(\([^()]*\))$", line)
        return (m.group(1), m.group(2)) if m else (line, "")
    env.filters["price_parts"] = price_parts
    page_tpl = env.get_template("catalog.html.j2")
    index_tpl = env.get_template("index.html.j2")

    styles = open(os.path.join(TEMPLATES, "styles.css")).read()
    logo_white = data_uri(os.path.join(ASSETS, "logo-white.b64"))
    logo_dark = data_uri(os.path.join(ASSETS, "logo-dark.b64"))

    catalogs, problems = load_catalogs(only)
    if not catalogs:
        print("no catalogs to build" + (f" matching {sorted(only)}" if only else ""))
        return 1

    # A structural problem (reserved key, missing required field) will crash
    # the render anyway, and at a line number that points at the template
    # rather than at the catalog that caused it. Stop here and say which file.
    if problems:
        for p in problems:
            print(f"  ! {p}")
        print(f"{len(problems)} problem(s); nothing written")
        return 1

    chrome = find_chrome()
    print(f"  chrome: {chrome}")
    if not chrome:
        print("  ! no Chrome/Chromium found — pages will build, PDFs will not")

    warnings = []
    # Two catalogs may share a title and differ only in duration — Danang,
    # Phu Quoc and Yunnan 3 Wilayah each ship a shorter and a longer version
    # under the same name. The index row carries the duration so they are
    # told apart there, but the page heading, the browser tab and the
    # downloaded PDF's filename would all be identical.
    everything_titles, _ = load_catalogs(None)
    by_title = {}
    for t in everything_titles:
        by_title.setdefault(t["title"], []).append(t)
    shared_titles = {t for t, v in by_title.items() if len(v) > 1}

    for c in catalogs:
        if c["title"] in shared_titles and c.get("duration"):
            c["title"] = f"{c['title']} ({c['duration']})"
            c["pdf_download_name"] = pdf_download_name(c)
        html = page_tpl.render(
            c=c, styles=styles, icon=icon,
            logo_white=logo_white, logo_dark=logo_dark,
        )
        out = os.path.join(SITE, c["slug"] + ".html")
        with open(out, "w") as fh:
            fh.write(html)
        note = render_pdf(c, chrome)
        if note:
            warnings.append(f"{c['slug']}: {note}")
        size = os.path.getsize(os.path.join(SITE, c["pdf"])) / 1024 if not note else 0
        print(f"  {c['slug']}.html  {len(html) / 1024:6.1f} KB"
              f"   -> {c['pdf']}  {size:6.1f} KB")

    # The index always lists every catalog, even when this run rebuilt one
    # page — otherwise building a single slug would silently drop the rest
    # of the site off the listing.
    everything, _ = load_catalogs(None)
    everything.sort(key=sort_key)
    with open(os.path.join(SITE, "index.html"), "w") as fh:
        fh.write(index_tpl.render(catalogs=everything, logo_dark=logo_dark))
    print(f"  index.html    {len(everything)} catalogs")

    if icon.missing:
        warnings.append("unresolved icons: " + ", ".join(sorted(icon.missing)))
    for w in warnings:
        print(f"  ! {w}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
