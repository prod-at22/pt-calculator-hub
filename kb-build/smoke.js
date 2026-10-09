// Open every built PT KB House page the way a browser does (jsdom) and check it works:
// no JavaScript error, the Simple Calculator renders a price, every package card opens with its itinerary,
// and the Harga & Pakej tab shows its tables. Run by pt-kb-house's mirror.yml after verify.py.
//   NODE_PATH=<dir with jsdom> node kb-build/smoke.js <pt-kb-house dir> [slug ...]
const fs = require("fs"), path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const site = process.argv[2];
const slugs = process.argv.slice(3).length ? process.argv.slice(3)
  : fs.readdirSync(site).filter(s => fs.existsSync(path.join(site, s, "index.html")) && fs.existsSync(path.join(site, s, "calc-config.json"))).sort();
const tick = ms => new Promise(r => setTimeout(r, ms));

async function one(slug) {
  const dir = path.join(site, slug), errs = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errs.push(String(e.message || e).slice(0, 160)));
  vc.on("error", (...a) => errs.push(a.join(" ").slice(0, 160)));
  const dom = new JSDOM(fs.readFileSync(path.join(dir, "index.html"), "utf8"), {
    runScripts: "dangerously", pretendToBeVisual: true, url: `https://prod-at22.github.io/pt-kb-house/${slug}/`, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = u => {
        const p = path.join(dir, String(u).split("?")[0]);
        return Promise.resolve(fs.existsSync(p)
          ? { ok: true, status: 200, json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, "utf8"))), text: () => Promise.resolve(fs.readFileSync(p, "utf8")) }
          : { ok: false, status: 404, json: () => Promise.reject(new Error("404")), text: () => Promise.resolve("") });
      };
      w.scrollTo = () => { }; w.matchMedia = () => ({ matches: false, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { } });
    },
  });
  await tick(800);
  const w = dom.window, d = w.document, problems = [];
  const calc = d.querySelector('.block[data-topic="calc"]');
  if (!calc || !/RM\s?[\d,]+/.test(calc.textContent)) problems.push("Simple Calculator shows no price");
  if (d.querySelector(".calcwarn")) problems.push("calculator rejected calc-config.json (fell back to the embedded config): " + d.querySelector(".calcwarn").textContent.slice(0, 120));
  const kb = JSON.parse(d.getElementById("kbdata").textContent);
  const pk = kb.packages || kb.PKG || [], it = kb.itineraries || kb.ITIN || [];
  if (typeof w.showPackage === "function" && pk.length) {
    for (let i = 0; i < pk.length; i++) {
      try { w.showPackage(i); } catch (e) { problems.push(`package ${i}: ${e.message}`); continue; }
      await tick(10);
      const b = d.body.cloneNode(true); b.querySelectorAll("script,style,template").forEach(e => e.remove());
      const t = b.textContent.replace(/\s+/g, " "), days = (it[i] || []).length;
      if (days && !(it[i] || []).every(x => !x.t || t.includes(x.t.replace(/&amp;/g, "&").replace(/\s+/g, " ").slice(0, 20)))) problems.push(`package ${i}: itinerary not shown`);
      if ((pk[i].inc || []).length && !t.includes(String(pk[i].inc[0]).replace(/&amp;/g, "&").replace(/\s+/g, " ").slice(0, 20))) problems.push(`package ${i}: includes not shown`);
    }
  }
  const pr = d.querySelector('.block[data-topic="pricing"]');
  if (pr && kb.blocks && kb.blocks.pricing && !pr.querySelector("table")) problems.push("Harga & Pakej has no table");
  dom.window.close();
  return [...errs.map(e => "JS error: " + e), ...problems];
}

(async () => {
  let bad = 0;
  for (const s of slugs) {
    const p = await one(s);
    console.log(`${s}: ${p.length ? "FAIL" : "OK"}`); p.slice(0, 10).forEach(x => console.log("   - " + x));
    if (p.length) bad++;
  }
  console.log(`\n${slugs.length - bad}/${slugs.length} KB OK`);
  process.exit(bad ? 1 : 0);
})();
