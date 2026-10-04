// Dump the calculator's own numbers (cost / selling per package, TO, pax, pax type) for
// tools/crosscheck.py, using the page's engine so it matches what POs see.
//   node tools/margins.js > /tmp/margins.json        (needs jsdom)
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "hnd", "index.html"), "utf8")
  .replace(/<script src="[^"]*app\.js"><\/script>/, () => "<script>" + fs.readFileSync(path.join(ROOT, "app.js"), "utf8") + "</script>")
  .replace(/<link rel="stylesheet"[^>]*>/, "");
const dom = new JSDOM(html, {
  url: "https://x/pt-calculator-hub/hnd/", runScripts: "dangerously", beforeParse(w) {
    w.fetch = async u => {
      const f = path.join(ROOT, new URL(String(u), w.location.href).pathname.replace("/pt-calculator-hub/", ""));
      return fs.existsSync(f) ? { ok: true, json: async () => JSON.parse(fs.readFileSync(f, "utf8")) } : { ok: false, status: 404 };
    };
  },
});
(async () => {
  const w = dom.window;
  for (let i = 0; i < 200 && !(w.PTCALC && w.PTCALC.DATA); i++) await new Promise(r => setTimeout(r, 20));
  const P = w.PTCALC, out = {};
  for (const d of P.DATA.destinations) {
    out[d.code] = {};
    for (const pkg of d.packages) {
      const rows = {};
      for (const p of Object.keys(pkg.pricing.adult).map(Number)) {
        const vid = (pkg.assign.find(a => p >= a.from && p <= a.to) || {}).variant;
        const r = P.priceRow(d, pkg, vid, p);
        rows[p] = { to: vid, adult: [r.adult.cost, r.adult.selling], cwb: [r.cwb.cost, r.cwb.selling], cnb: [r.cnb.cost, r.cnb.selling] };
      }
      out[d.code][pkg.id] = { label: pkg.label, rows };
    }
  }
  process.stdout.write(JSON.stringify(out, (k, v) => (typeof v === "number" && !isFinite(v) ? null : v)));
  process.exit(0);
})();
