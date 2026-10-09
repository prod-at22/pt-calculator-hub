// Tests for the PT costing calculator. The hub is the source of truth: these check the engine,
// rules and UI against fixed numbers, not against any R&D workbook.
//   node tests/test_calc.js        (needs jsdom: npm i jsdom)
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log("  FAIL", msg); } };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- mock GitHub repo
function mockRepo(files, validTokens) {
  let n = 0; const commits = {}, trees = {}, blobs = {};
  const root = "c0"; trees.t0 = { ...files }; commits[root] = { tree: "t0", parents: [] };
  const repo = { head: root, commits, trees, log: [] };
  repo.files = sha => trees[commits[sha].tree];
  repo.handle = (method, url, body, auth) => {
    const tok = (auth || "").replace("Bearer ", "");
    if (!validTokens.includes(tok)) return [401, { message: "Bad credentials" }];
    const u = new URL(url), p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    if (method === "GET" && p === "/git/ref/heads/main") return [200, { object: { sha: repo.head } }];
    if (method === "GET" && p.startsWith("/contents/")) {
      const f = repo.files(u.searchParams.get("ref"))[p.slice(10)];
      return f === undefined ? [404, { message: "Not Found" }] : [200, { content: Buffer.from(f).toString("base64") }];
    }
    if (method === "GET" && p.startsWith("/git/commits/")) return [200, { tree: { sha: commits[p.slice(13)].tree } }];
    if (method === "POST" && p === "/git/trees") {
      const t = "t" + (++n); trees[t] = { ...trees[body.base_tree] };
      for (const f of body.tree) { if ("sha" in f) { if (f.sha === null) delete trees[t][f.path]; else trees[t][f.path] = blobs[f.sha]; } else trees[t][f.path] = f.content; }
      return [201, { sha: t }];
    }
    if (method === "POST" && p === "/git/blobs") { const b = "b" + (++n); blobs[b] = Buffer.from(body.content, "base64").toString("latin1"); return [201, { sha: b }]; }
    if (method === "POST" && p === "/git/commits") { const c = "c" + (++n); commits[c] = { tree: body.tree, parents: body.parents, message: body.message }; return [201, { sha: c }]; }
    if (method === "PATCH" && p === "/git/refs/heads/main") {
      if (commits[body.sha].parents[0] !== repo.head) return [422, { message: "Update is not a fast forward" }];
      repo.head = body.sha; repo.log.push(commits[body.sha].message); return [200, {}];
    }
    if (method === "POST" && /^\/repos\/prod-at22\/catalog-pt-public\/actions\/workflows\/mirror\.yml\/dispatches$/.test(u.pathname)) { repo.dispatches = (repo.dispatches || 0) + 1; return [204, null]; }
    if (method === "POST" && /^\/repos\/prod-at22\/pt-kb-house\/actions\/workflows\/mirror\.yml\/dispatches$/.test(u.pathname)) { repo.kbDispatches = (repo.kbDispatches || 0) + 1; return [204, null]; }
    return [404, { message: "no route " + method + " " + p }];
  };
  return repo;
}

// page = "" (hub) or "hnd/" etc. app.js / app.css are inlined because jsdom does not fetch them.
async function boot(repo, page = "hnd/", query = "") {
  const html = fs.readFileSync(path.join(ROOT, page, "index.html"), "utf8")
    .replace(/<script src="[^"]*app\.js[^"]*"><\/script>/, () => "<script>" + fs.readFileSync(path.join(ROOT, "app.js"), "utf8") + "</script>")
    .replace(/<link rel="stylesheet"[^>]*>/, "");
  const errors = [];
  const dom = new JSDOM(html, {
    url: "https://prod-at22.github.io/pt-calculator-hub/" + page + query, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, "crypto", { value: globalThis.crypto });
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      w.confirm = () => true; w.scrollTo = () => { };
      w.fetch = async (url, opt = {}) => {
        const mk = (status, j) => ({ ok: status < 300, status, text: async () => JSON.stringify(j), json: async () => j });
        if (String(url).startsWith("https://api.github.com")) {
          const [s, j] = repo.handle(opt.method || "GET", url, opt.body ? JSON.parse(opt.body) : null, (opt.headers || {}).Authorization);
          return mk(s, j);
        }
        // GitHub Pages serves the current head of the repo
        const rel = new URL(String(url), w.location.href).pathname.replace("/pt-calculator-hub/", "");
        const f = repo.files(repo.head)[rel];
        return f === undefined ? mk(404, {}) : { ok: true, status: 200, json: async () => JSON.parse(f) };
      };
      w.addEventListener("error", e => errors.push(e.message));
      const ce = w.console.error; w.console.error = (...a) => { errors.push(a.join(" ")); };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.PTCALC?.DATA; i++) await tick(20);
  return { w, doc: w.document, errors };
}
const byCode = (data, c) => data.destinations.find(d => d.code === c);
const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await tick(25); } return false; }
function fire(w, el, type) { el.dispatchEvent(new w.Event(type, { bubbles: true })); }
function setVal(w, el, v) { el.value = v; fire(w, el, "change"); }
const click = (w, el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const tab = async (w, doc, name) => { click(w, doc.querySelector(`[data-tabmain="${name}"]`)); await tick(5); };

(async () => {
  const files = {};
  for (const f of ["data.json", "history.json", "users.json", "flags.json"]) files["data/" + f] = fs.readFileSync(path.join(ROOT, "data", f), "utf8");
  for (const f of fs.readdirSync(path.join(ROOT, "data", "catalogs"))) files["data/catalogs/" + f] = fs.readFileSync(path.join(ROOT, "data", "catalogs", f), "utf8");
  for (const f of fs.readdirSync(path.join(ROOT, "data", "kb"))) files["data/kb/" + f] = fs.readFileSync(path.join(ROOT, "data", "kb", f), "utf8");
  const repo = mockRepo(files, ["tok-valid", "tok-new"]);
  const { w, doc, errors } = await boot(repo);
  const P = w.PTCALC, D = P.DATA;
  const HND = () => byCode(P.DATA, "HND");
  const V0 = D.version;   // versions below are relative to the data we start from

  console.log("1. FX belongs to the hub: changing it recalculates the costs that use it");
  {
    const h = byCode(D, "HND"), pk = h.packages.find(p => p.id === "basic"), vid = pk.assign[0].variant, f = h.fx.find(x => x.id === "WIF");
    const c0 = P.priceRow(h, pk, vid, 2).adult.cost, v0 = f.value;
    f.value = v0 * 1.1; const c1 = P.priceRow(h, pk, vid, 2).adult.cost; f.value = v0;
    ok(isFinite(c0) && c1 > c0 && near(P.priceRow(h, pk, vid, 2).adult.cost, c0), `Tokyo Basic 2 pax: WIF FX +10% raises cost ${c0} → ${c1}, restored after`);
  }

  console.log("1b. TO rates editor (Costing tab, Edit costs): per-pax cost tables");
  {
    const dp = await boot(repo, "dps/");
    ok(!dp.doc.querySelector("table.torates"), "TO rates editor hidden when not editing");
    dp.w.PTCALC.EDIT = true; dp.w.PTCALC.render(); await tick(5);
    const tbl = dp.doc.querySelector("table.torates");
    ok(tbl && tbl.querySelectorAll("tbody tr").length >= 10 && tbl.textContent.includes("Transport") && tbl.querySelector("input.ed"), "Bali: one editable row per pax, a column per component (Transport …)");
    dp.w.PTCALC.EDIT = false;
    ok(dp.errors.length === 0, "Bali TO Rates errors: " + dp.errors.join("|"));
    const h = byCode(D, "DPS"), pk = h.packages[0], vid = pk.assign[0].variant, v = h.variants.find(x => x.id === vid);
    const tid = /T\['([^']+)'\]/.exec(v.components[0].expr)[1], t = h.tables.find(x => x.id === tid), v0 = t.values["2"];
    const c0 = P.priceRow(h, pk, vid, 2).adult.cost; t.values["2"] = v0 + 100; const c1 = P.priceRow(h, pk, vid, 2).adult.cost; t.values["2"] = v0;
    ok(near(c1 - c0, 100 * (h.fx.find(f => f.id === t.fx) || { value: 1 }).value, 0.01) || near(c1 - c0, 100 / 2, 0.01), `editing a table cell changes the cost (${c0} → ${c1})`);
  }

  console.log("1d. Seoul Basic / Standard = ATK contract rate; add-ons from the Korea ProdReq");
  {
    const s = byCode(D, "SEL"), b = s.packages.find(p => p.id === "atk-bsc"), st = s.packages.find(p => p.id === "atk-std");
    const r = (pk, v, p) => P.priceRow(s, pk, v, p);
    ok(s.fx.find(f => f.id === "KRW").value === 0.003, "KRW FX 0.0030");
    ok(near(r(b, "ATK-BSC", 2).adult.cost, 858261 * 0.003) && near(r(b, "ATK-BSC", 10).adult.cost, 581256 * 0.003) && near(r(b, "ATK-BSC", 25).adult.cost, 442351 * 0.003), "Basic = CR KRW × 0.0030 (2/10/25 pax)");
    ok(near(r(st, "ATK-STD", 2).adult.cost, 1224774 * 0.003) && near(r(st, "ATK-STD", 42).adult.cost, 420726 * 0.003), "Standard = CR KRW × 0.0030 (2/42 pax)");
    ok(!isFinite(r(b, "ATK-BSC", 26).adult.cost), "Basic 26+ pax: not in the CR → no cost");
    ok(s.variants.filter(v => v.id !== "ATK-ST").every(v => v.components.length === 1), "one cost line (not broken down)");
    const sp = await boot(repo, "sel/", "?pkg=atk-bsc");
    const sh = [...sp.doc.querySelectorAll("#costPax tr.blk-head th")].map(x => x.textContent);
    ok(!sh.includes("Source"), "costing table has no Source column");
    ok(sh[1] === "Cost/Pax" && sp.doc.querySelector('#costPax tr[data-pax="2"]').children[1].textContent.trim() === "2,575", "Seoul costing: no breakdown column, Cost/Pax = 858,261 KRW × 0.0030");
    ok(near(r(b, "ATK-BSC", 2).cnb.cost, 858261 * 0.003 * 0.5) && r(b, "ATK-BSC", 2).infant.cost === 0, "CNB 50%, infant FOC");
    ok(s.contracts.length === 3 && s.contracts.every(c => /ATK_CR_2026_Korea/.test(c.file) && fs.existsSync(path.join(ROOT, c.file))), "SEL TO Contract Rate = ATK CR 2026 (KRW xlsx + rates + terms) only");
    const ev = s.addons.find(x => x.label === "Everland ticket");
    ok(ev && near(ev.cost, 40700 * 0.003, 0.01) && ev.selling === 140, "Everland add-on: cost 40,700 KRW × 0.0030, selling RM140");
    ok(s.addons.find(x => x.label === "K-ETA").cost === 27 && s.addons.find(x => x.label.startsWith("Hanbok")).cost === null, "K-ETA cost RM27; Hanbok has no cost rate (null)");
  }

  console.log("1e. Seoul-Jeju, Jeju, Jeju-Udo = ATK CR 2026");
  {
    const chk = (code, vid, exp) => { const d = byCode(D, code), pk = d.packages.find(p => p.assign.some(x => x.variant === vid));
      return Object.entries(exp).every(([p, c]) => near(P.priceRow(d, pk, vid, +p).adult.cost, c)) && !isFinite(P.priceRow(d, pk, vid, 26).adult.cost)
        && d.variants.find(v => v.id === vid).components.length === 1; };
    ok(chk("SELJJU", "ATK-STD", { 2: 1769500 * 0.003, 9: 1138111 * 0.003, 25: 865000 * 0.003 }), "SELJJU = CR KRW × 0.0030, none at 26");
    ok(chk("JJU", "ATK-PT", { 2: 943000 * 0.003, 9: 521889 * 0.003, 25: 353000 * 0.003 }), "JJU = CR KRW × 0.0030");
    ok(chk("JJUO", "ATK-STD", { 2: 1442257 * 0.003, 10: 783357 * 0.003, 25: 571827 * 0.003 }), "JJUO = CR KRW × 0.0030");
    ok(byCode(D, "JJU").variants.find(v => v.id === "ATK-ST").components.length > 1, "Jeju Self Tour keeps its component breakdown");
  }

  console.log("1f. Turkey / Istanbul: no 4★ (not in the MyTrip CR or catalog)");
  ok(["TUR", "ISTBUR", "ISTCAP"].every(c => !byCode(D, c).variants.some(v => /4\s*-?\s*STAR|4S$/i.test(v.id)) && !byCode(D, c).packages.some(p => /4/.test(p.id))), "TUR / ISTBUR / ISTCAP have only 3★ packages");

  console.log("1g. Tokyo Qayyum (Standard 2–7) from ProdReq Jepun");
  {
    const h = byCode(D, "HND"), st = h.packages.find(p => p.id === "standard"), c = p => P.priceRow(h, st, "QAYYUM-STD", p).adult.cost;
    // (2 × ¥22,000 + ¥81,000 + 3 × ¥76,000) × FX ÷ pax + apartment RM300 × 4 + Iyashi ¥500 × FX (ProdReq rates, Qayyum FX 0.026)
    const q = p => (353000 * 0.026) / p + 250 * 4 + 500 * 0.029;   // apartment RM250 × 4 nights; Iyashi is a common rate on the WIF FX
    ok([2, 4, 7].every(p => near(c(p), q(p), 0.01)), `Qayyum cost 2/4/7 pax at FX 0.026: ${c(2)} / ${c(4)} / ${c(7)}`);
  }

  console.log("1h. Tokyo / Osaka accommodation RM250 per pax per night");
  ok(byCode(D, "HND").rates.find(r => r.id === "apt").value === 250 && ["OSK", "KIX"].every(c => byCode(D, c).tables.filter(t => /__Accomm$/.test(t.id)).every(t => Object.values(t.values).every(v => v === (c === "OSK" ? 1000 : 1500)))), "HND apartment 250; OSK 4 × 250; KIX 6 × 250");

  console.log("1i. Package = package name, TO = operator name (tools/names.json)");
  {
    const names = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "names.json"), "utf8"));
    let n = 0;
    for (const d of D.destinations) { const m = names[d.code]; if (!m) continue;
      for (const p of d.packages) { ok(p.label === m.packages[p.id], `${d.code} package ${p.id} named "${p.label}"`); n++; }
      for (const v of d.variants) { ok(v.label === m.variants[v.id], `${d.code} TO ${v.id} named "${v.label}"`); n++; } }
    ok(n > 200, "names checked: " + n);
    ok(!byCode(D, "TUR").packages.some(p => /mytrip/i.test(p.label)) && byCode(D, "TUR").variants.every(v => v.label === "MyTrip"), "Turki: no operator in package names; TO = MyTrip");
  }

  console.log("1c. Jakarta - Bandung: new CTRANS rate (v5)");
  {
    const j = byCode(D, "JBDO"), pk = j.packages[0];
    const c = (vid, p) => P.priceRow(j, pk, vid, p).adult.cost;
    ok(c("CTRANS", 2) === 936 && c("CTRANS", 5) === 684 && c("CTRANS", 10) === 635, "2/5/10 pax = 936/684/635");
    ok(c("CTRANS-HIACE", 5) === 757, "5 pax Hiace = 757");
    ok(!j.variants.some(v => v.components.some(x => /whoosh/i.test(x.label))), "no Whoosh component");
    ok([11, 15, 19].every(p => c("CTRANS", p) === 635) && !isFinite(c("CTRANS", 20)), "10–19 pax = RM635 (PO 9 Oct, v34); 20 pax has no TO rate (missing, not RM0)");
    const sp = p => P.priceRow(j, pk, "CTRANS", p);
    ok([[2, 1487], [4, 1227], [6, 1187], [10, 1147], [19, 1147]].every(([p, a]) => sp(p).adult.catalog === a), "catalog = Catalog PT v8 (2/4/6/10/19 pax = 1,487/1,227/1,187/1,147/1,147)");
    ok(sp(2).cwb.catalog === 1387 && sp(2).cnb.catalog === 1187 && sp(2).adult.selling === 1287, "2 pax CWB 1,387 · CNB 1,187 · selling 1,287 (catalog − 200)");
    ok(Object.keys(pk.pricing.adult).map(Number).every(p => p >= 2 && p <= 19), "JBDO priced 2–19 pax only");
  }

  console.log("2. selling / margin rules");
  {
    const sel = D.destinations.find(x => x.code === "SEL"), b = sel.packages.find(p => p.id === "atk-bsc");
    const r = P.priceRow(sel, b, "ATK-BSC", 2);
    ok(r.adult.catalog === 3497 && r.adult.selling === 3297, "Seoul Basic 2 pax adult catalog 3497, selling 3297 (− RM200)");
    ok(near(r.cwb.cost, r.adult.cost * 0.75), "Seoul CWB cost = 75% adult (CR extra bed)");
    ok(near(r.cnb.cost, r.adult.cost * 0.5), "Seoul CNB cost = 50% adult");
    ok(r.infant.selling === 200 && r.infant.cost === 0, "Seoul infant RM200, cost 0");
    ok(near(r.adult.margin, 3297 - r.adult.cost) && near(r.adult.pct, r.adult.margin / 3297), "Seoul margin & % on the selling price");
    const hnd = D.destinations.find(x => x.code === "HND"), s = hnd.packages.find(p => p.id === "standard");
    const r6 = P.priceRow(hnd, s, "QAYYUM-STD", 6), r8 = P.priceRow(hnd, s, "WIF-STD", 8);
    ok(r6.adult.catalog === 3797 && r6.adult.selling === 3597, "Tokyo Std 6 pax catalog 3797, selling 3597 (− RM200)");
    ok(r8.adult.catalog === 3897, "Tokyo Std 8 pax catalog 3897");
    ok(near(r6.cnb.cost, r6.adult.cost - 1200), "Tokyo CNB cost = adult − 1200");
    ok(near(r6.cwb.cost, r6.adult.cost), "Tokyo CWB cost = 100% adult");
    ok(r6.infant.selling === 200, "Tokyo infant RM200 with no tier-2 discount");
    ok(P.priceRow(hnd, s, "QAYYUM-STD", 8).cost === null, "Qayyum does not cover 8 pax");
  }

  console.log("3. UI: destination / package / auto TO by pax");
  {
    ok(doc.querySelector("#controls").textContent.includes("Tokyo"), "/hnd/ page is locked to Tokyo");
    ok(doc.querySelector("#costPax") && doc.querySelector(".tabm.on").dataset.tabmain === "costing", "Costing tab opens by default");
    ok(doc.querySelector(".fxbox").textContent.includes("0.029") && doc.querySelector(".fxbox").textContent.includes("0.026"), "FX chips: WIF 0.029, Qayyum 0.026");
    ok([...doc.querySelectorAll(".tabm")].map(x => x.dataset.tabmain).join() === "costing,itinerary,surcharge,accommodation,addons,expect,policy,kbinfo,kbcalc,contracts,flags,history", "tabs: Costing, Itinerary, Surcharge, Accommodation, Add On, What to Expect, Policy, Info KB, Simple Calculator, TO Contract Rate, Flags, History");
    // each catalog section on its own tab (data/catalogs/<slug>.json for the selected package)
    setVal(w, doc.querySelector("#selPkg"), "standard"); await tick(5);
    await tab(w, doc, "itinerary"); await until(() => doc.querySelector("#cat-tokyo-standard"));
    const cd = doc.querySelector("#cat-tokyo-standard"), cdt = cd ? cd.textContent : "";
    ok(cd && cdt.includes("PRIVATE TOUR TOKYO STANDARD") && cdt.includes("Iyashi No Sato") && cdt.includes("Tipping Fee") && cdt.includes("Return flight ticket") && cdt.includes("Section L Apartment"), "Itinerary tab: title, hotels, includes, excludes");
    ok(cd && cd.querySelectorAll(".cd-itin tbody tr").length === 5 && cdt.includes("Kawaguchiko Mosque"), "Itinerary tab: 5-day itinerary");
    ok(cd && cd.querySelector('a[href$="tokyo-standard.pdf"]'), "links the public PDF");
    await tab(w, doc, "surcharge"); ok(doc.querySelector("#grid").textContent.includes("Peak Season"), "Surcharge tab");
    await tab(w, doc, "expect"); ok(doc.querySelector("#cat-tokyo-standard-expect"), "What to Expect tab");
    await tab(w, doc, "policy"); { const t = doc.querySelector("#grid").textContent; ok(t.includes("Important Notes") && t.includes("Deposit"), "Policy tab: important notes + deposit"); }
    await tab(w, doc, "addons"); { const tk = [...doc.querySelectorAll("input.aotick")]; ok(tk.length > 5 && tk.some(x => x.checked) && tk.every(x => x.disabled) && doc.querySelector("#grid").textContent.includes("Fuji Day Tour"), "Add On tab: catalog add-ons ticked for tokyo-standard (read-only when not editing)"); }
    await tab(w, doc, "itinerary");
    setVal(w, doc.querySelector("#selPkg"), "selftour"); await tick(5);
    ok(doc.querySelector("#grid").textContent.includes("has no published catalog"), "Self Tour: no catalog");
    location_hash_ok: { const old = await boot(repo, "hnd/", "#catalog"); ok(old.doc.querySelector(".tabm.on").dataset.tabmain === "itinerary", "old #catalog link opens Itinerary"); }
    setVal(w, doc.querySelector("#selPkg"), "basic"); await tick(5);
    await tab(w, doc, "costing");
    ok(doc.querySelector('[data-tabmain="contracts"]').textContent === "TO Contract Rate", "tab named TO Contract Rate");
    setVal(w, doc.querySelector("#selPkg"), "standard"); await tick(5);
    const rowAt = p => doc.querySelector(`#costPax tr[data-pax="${p}"]`);
    click(w, rowAt(6)); await tick(5);
    ok(doc.querySelector("#selVar").options[0].textContent.includes("Qayyum") && rowAt(6).classList.contains("cur"), "click 6 pax row → Qayyum, row highlighted");
    click(w, rowAt(8)); await tick(5);
    ok(doc.querySelector("#selVar").options[0].textContent === "Auto: WIF (8 pax)", "8 pax → WIF (Standard 8+)");
    ok([...doc.querySelector("#selVar").options].map(o => o.value).join() === "auto,QAYYUM-STD,WIF-STD", "TO box lists only this package's operators");
    ok(doc.querySelector("#selPkg").selectedOptions[0].textContent === "Tokyo Standard 5D4N", "Package box shows the package name");
    ok(rowAt(8).querySelector("td.sp").textContent.includes("3,697"), "8 pax selling 3,697 shown (catalog 3,897 − 200)");
    const sm = doc.querySelector(".summary").textContent;
    ok(!sm.includes("No TO cost") && !sm.includes("Catalog → Selling") && sm.includes("Margin range"), "summary has no 'No TO cost' / 'Catalog → Selling'");
    const rws = [...doc.querySelectorAll("#costPax tr[data-pax]")];
    ok(rws[0].classList.contains("alt") === false && rws[1].classList.contains("alt"), "costing rows alternate grey / white");
    const mg = rws.map(r => r.querySelector("td.mg"));
    ok(mg.every(td => { const v = parseFloat(td.textContent.replace(/[^\d.\-−]/g, "").replace("−", "-")); return !isFinite(v) || (v > 0 ? td.classList.contains("m-ok") : v < 0 ? td.classList.contains("m-bad") : !/m-(ok|bad)/.test(td.className)); }), "margin green when positive, red when negative");
    ok(P.priceRow(HND(), HND().packages[1], "WIF-STD", 8).adult.pct > 0 && w.eval("marginClass(0.01)") === "m-ok" && w.eval("marginClass(-0.01)") === "m-bad", "marginClass: + green, − red");
    click(w, rowAt(2)); await tick(5);
  }

  console.log("4. first-time setup, login, wrong password");
  {
    click(w, doc.querySelector("#btnLogin")); await tick(5);
    ok(doc.querySelector("#sTok"), "no users → setup form");
    doc.querySelector("#sTok").value = "tok-valid"; doc.querySelector("#sU").value = "ezie";
    doc.querySelector("#sP").value = "short"; doc.querySelector("#sP2").value = "short";
    click(w, doc.querySelector("#doSetup")); await tick(5);
    ok(doc.querySelector(".err-t").textContent.includes("10 characters"), "short password rejected");
    doc.querySelector("#sP").value = "correct-horse-1"; doc.querySelector("#sP2").value = "correct-horse-1";
    click(w, doc.querySelector("#doSetup"));
    ok(await until(() => !doc.querySelector("#sTok")), "setup completes");
    const users = JSON.parse(repo.files(repo.head)["data/users.json"]);
    ok(users.users.length === 1 && users.users[0].role === "admin", "users.json has admin");
    ok(!repo.files(repo.head)["data/users.json"].includes("tok-valid"), "token is not stored in plain text");
    click(w, doc.querySelector("#btnLogout")); await tick(5);
    click(w, doc.querySelector("#btnLogin")); await tick(5);
    doc.querySelector("#lu").value = "ezie"; doc.querySelector("#lp").value = "wrong-password";
    click(w, doc.querySelector("#doLogin"));
    ok(await until(() => doc.querySelector(".err-t")?.textContent.includes("Wrong")), "wrong password refused");
    doc.querySelector("#lp").value = "correct-horse-1"; doc.querySelector("#doLogin").disabled = false;
    click(w, doc.querySelector("#doLogin"));
    ok(await until(() => doc.querySelector("#btnEdit")), "correct password logs in");
  }

  console.log("5. add editor, editor login");
  {
    click(w, doc.querySelector("#btnAcct")); await tick(5);
    doc.querySelector("#nu").value = "aiman"; doc.querySelector("#np").value = "aiman-pass-2026"; doc.querySelector("#nr").value = "editor";
    click(w, doc.querySelector("#doAdd"));
    ok(await until(() => JSON.parse(repo.files(repo.head)["data/users.json"]).users.length === 2), "editor added");
    click(w, doc.querySelector("[data-close]")); click(w, doc.querySelector("#btnLogout")); await tick(5);
    click(w, doc.querySelector("#btnLogin")); await tick(5);
    doc.querySelector("#lu").value = "aiman"; doc.querySelector("#lp").value = "aiman-pass-2026";
    click(w, doc.querySelector("#doLogin"));
    ok(await until(() => doc.querySelector("#btnEdit")), "editor logs in with own password");
  }

  console.log("6. edit → save v2 → history → view v1 → restore v3");
  let before;
  {
    await tab(w, doc, "costing");
    setVal(w, doc.querySelector("#selPkg"), "basic"); await tick(5);
    const CAT = ["destinations", "HND", "packages", "basic", "pricing", "adult", "2"];
    before = HND().packages[0].pricing.adult["2"];
    ok(![...doc.querySelectorAll("input.ed")].some(x => x.dataset.path.includes('"fx"')), "FX is read-only when not editing");
    click(w, doc.querySelector("#btnEdit")); await tick(5);
    ok([...doc.querySelectorAll("input.ed")].some(x => x.dataset.path === JSON.stringify(["destinations", "HND", "fx", "WIF", "value"])), "FX is editable in Edit costs (the hub owns FX)");
    ok([...doc.querySelectorAll("table.torates input.ed")].some(x => x.dataset.path === JSON.stringify(["destinations", "HND", "rates", "hnd7", "value"])), "Edit costs: Tokyo supplier rates are editable on the Costing tab (Haneda 7-seater)");
    const inp = [...doc.querySelectorAll("input.ed")].find(x => x.dataset.path === JSON.stringify(CAT));
    ok(inp, "Basic 2 pax catalog price is editable in the costing table");
    setVal(w, inp, String(before + 100)); await tick(10);
    ok(near(P.priceRow(HND(), HND().packages[0], "WIF-BSC", 2).adult.catalog, before + 100), "catalog +100 recalculates");
    ok(doc.querySelector("#btnSave")?.textContent.includes("(1)"), "save button shows 1 change");
    click(w, doc.querySelector("#btnSave")); await tick(5);
    click(w, doc.querySelector("#doSave")); await tick(5);
    ok(doc.querySelector(".err-t").textContent.includes("note"), "note is required");
    doc.querySelector("#saveNote").value = "Basic catalog 2027";
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => P.BASE.version === V0 + 1), "saved as V0+1");
    const remote = JSON.parse(repo.files(repo.head)["data/data.json"]);
    ok(remote.version === V0 + 1 && remote.updatedBy === "aiman", "repo data.json V0+1 by aiman");
    ok(byCode(remote,'HND').packages[0].pricing.adult["2"] === before + 100, "repo has new catalog price");
    const hist = JSON.parse(repo.files(repo.head)["data/history.json"]);
    const e = hist.entries.find(x => x.v === V0 + 1);
    ok(e && e.by === "aiman" && e.changes.length === 1 && e.changes[0].from === before && e.changes[0].label.includes("@2 pax"), "history entry V0+1 with readable label");
    ok(repo.log.at(-1).startsWith(`v${V0 + 1} · aiman: Basic catalog`), "one commit with version message");
    ok(await until(() => repo.dispatches >= 1), "save starts the PT Catalog House mirror (workflow_dispatch on catalog-pt-public)");
    // the catalog has no prices of its own: a price save stamps price_version so catalog-pt-public rebuilds it
    const catNow = JSON.parse(repo.files(repo.head)["data/catalogs/tokyo-basic.json"]), cat0 = JSON.parse(files["data/catalogs/tokyo-basic.json"]);
    ok(catNow.hub_version === V0 + 1 && !catNow.prices.rows.some(r => "amounts" in r), "catalog tokyo-basic: hub_version V0+1, still no amounts in the file");
    ok(JSON.stringify({ ...catNow, hub_version: null, updated: null }) === JSON.stringify({ ...cat0, hub_version: null, updated: null }), "nothing else changed in the catalog");
    ok(JSON.parse(repo.files(repo.head)["data/catalogs/index.json"])["tokyo-basic"].updated === catNow.updated, "catalog + index.json updated in the same commit");
    ok(e.catalogs && e.catalogs[0].includes("tokyo-basic"), "history entry lists the catalog rebuild: " + (e.catalogs || []).join("; "));
    click(w, doc.querySelector("#btnHistory")); await tick(5);
    ok(doc.querySelector(".tabm.on").dataset.tabmain === "history" && doc.querySelector("#grid").textContent.includes("Basic catalog 2027") && doc.querySelector("#grid").textContent.includes("Added destinations"), "History button opens the History tab with the notes");
    const snap = P.snapshotAt(V0);
    ok(byCode(snap,"HND").packages[0].pricing.adult["2"] === before, "V0 rebuilt from change log");
    // newest version listed on this page's History (V0 itself may not touch HND)
    const VV = Math.max(...[...doc.querySelectorAll("[data-view]")].map(x => +x.dataset.view).filter(v => v <= V0));
    click(w, doc.querySelector(`[data-view="${VV}"]`)); await tick(5);
    ok(doc.querySelector("#banners").textContent.includes(`Read-only: version ${VV}`), "viewing older version banner");
    click(w, doc.querySelector('[data-act="restore"]')); await tick(5);
    ok(doc.querySelector("#saveNote").value === `Restore to v${VV}`, "restore pre-fills note");
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => P.BASE.version === V0 + 2), "restore saved as V0+2 " + (doc.querySelector(".err-t") || {}).textContent);
    ok(HND().packages[0].pricing.adult["2"] === before, "catalog back to V0");
  }

  console.log("7. concurrent saves");
  {
    // someone else saves v4 changing the Qayyum FX
    const other = JSON.parse(repo.files(repo.head)["data/data.json"]);
    byCode(other,'HND').fx.find(f => f.id === "QAYYUM").value = 0.026; other.version = V0 + 3;
    const oh = JSON.parse(repo.files(repo.head)["data/history.json"]);
    oh.entries.push({ v: V0 + 3, at: new Date().toISOString(), by: "ezie", note: "fx", changes: [{ path: ["destinations", "HND", "fx", "QAYYUM", "value"], from: 0.0259, to: 0.026 }] });
    let [, t] = repo.handle("POST", "https://api.github.com/repos/x/y/git/trees", { base_tree: repo.commits[repo.head].tree, tree: [{ path: "data/data.json", content: JSON.stringify(other) }, { path: "data/history.json", content: JSON.stringify(oh) }] }, "Bearer tok-valid");
    let [, c] = repo.handle("POST", "https://api.github.com/repos/x/y/git/commits", { tree: t.sha, parents: [repo.head], message: "other" }, "Bearer tok-valid");
    repo.handle("PATCH", "https://api.github.com/repos/x/y/git/refs/heads/main", { sha: c.sha }, "Bearer tok-valid");
    // we (still on v3) edit a different cell
    await tab(w, doc, "costing");
    click(w, doc.querySelector("#btnEdit")); await tick(5);
    const inp = [...doc.querySelectorAll("input.ed")].find(x => x.dataset.path === JSON.stringify(["destinations", "HND", "packages", "basic", "pricing", "adult", "3"]));
    setVal(w, inp, "5111"); await tick(10);
    click(w, doc.querySelector("#btnSave")); await tick(5);
    doc.querySelector("#saveNote").value = "ropeway price";
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => P.BASE.version === V0 + 4), "different cell → replayed on top, saved V0+4");
    const r5 = JSON.parse(repo.files(repo.head)["data/data.json"]);
    ok(byCode(r5,'HND').fx.find(f => f.id === "QAYYUM").value === 0.026 && byCode(r5,'HND').packages[0].pricing.adult["3"] === 5111, "both users' edits kept");
    // same cell clash
    const o2 = JSON.parse(JSON.stringify(r5)); byCode(o2,'HND').packages[0].pricing.adult["3"] = 5222; o2.version = V0 + 5;
    [, t] = repo.handle("POST", "https://api.github.com/repos/x/y/git/trees", { base_tree: repo.commits[repo.head].tree, tree: [{ path: "data/data.json", content: JSON.stringify(o2) }] }, "Bearer tok-valid");
    [, c] = repo.handle("POST", "https://api.github.com/repos/x/y/git/commits", { tree: t.sha, parents: [repo.head], message: "other 2" }, "Bearer tok-valid");
    repo.handle("PATCH", "https://api.github.com/repos/x/y/git/refs/heads/main", { sha: c.sha }, "Bearer tok-valid");
    await tab(w, doc, "costing");
    click(w, doc.querySelector("#btnEdit")); await tick(5);
    const inp2 = [...doc.querySelectorAll("input.ed")].find(x => x.dataset.path === JSON.stringify(["destinations", "HND", "packages", "basic", "pricing", "adult", "3"]));
    setVal(w, inp2, "5333"); await tick(10);
    click(w, doc.querySelector("#btnSave")); await tick(5);
    doc.querySelector("#saveNote").value = "clash";
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => doc.querySelector(".err-t")?.textContent.includes("same cells")), "same-cell clash is refused, not overwritten");
    ok(byCode(JSON.parse(repo.files(repo.head)["data/data.json"]),"HND").packages[0].pricing.adult["3"] === 5222, "other user's value untouched");
    click(w, doc.querySelector("[data-close]"));
  }

  console.log("8. editor cannot see admin tools; formulas admin-only");
  {
    click(w, doc.querySelector("#btnAcct")); await tick(5);
    ok(!doc.querySelector("#doAdd"), "editor has no Add user");
    click(w, doc.querySelector("[data-close]"));
    ok(!doc.querySelector('[data-tabmain="rates"]') && !doc.querySelector('[data-tabmain="quote"]'), "no Rates & FX or Quote tab");
  }

  console.log("8a. TO Contract Rate: upload, list, remove");
  {
    if (doc.querySelector('[data-act="discard"]')) { click(w, doc.querySelector('[data-act="discard"]')); await tick(5); }   // drop the clash edit from 7.
    await tab(w, doc, "contracts");
    const n0 = (HND().contracts || []).length;
    ok(doc.querySelector("#crFile") && doc.querySelectorAll("#contracts tbody tr").length === n0, "upload form + existing files listed when logged in");
    const pdf = "%PDF-1.4 rate card \u00ff test";
    const f = new w.File([Buffer.from(pdf, "latin1")], "WIF Rate Card 2027.pdf", { type: "application/pdf" });
    Object.defineProperty(doc.querySelector("#crFile"), "files", { value: [f], configurable: true });
    doc.querySelector("#crNote").value = "WIF 2027";
    const v0 = JSON.parse(repo.files(repo.head)["data/data.json"]).version;   // 7. left a newer remote version
    click(w, doc.querySelector("#doUpload"));
    ok(await until(() => P.BASE.version === v0 + 1), "upload saved as a new version");
    const files = repo.files(repo.head), all = byCode(JSON.parse(files["data/data.json"]), "HND").contracts, cr = all.filter(c => c.by === "aiman");
    ok(all.length === n0 + 1 && cr.length === 1 && cr[0].name === "WIF Rate Card 2027.pdf" && cr[0].note === "WIF 2027" && cr[0].by === "aiman" && /^contracts\/hnd\/\w+-WIF_Rate_Card_2027\.pdf$/.test(cr[0].file), "data.json lists the file: " + JSON.stringify(cr));
    ok(files[cr[0].file] === pdf, "file bytes committed to the repo");
    ok(repo.log.at(-1).includes("Uploaded WIF Rate Card 2027.pdf"), "commit message names the file");
    const link = [...doc.querySelectorAll("#contracts tbody a")].find(a => a.textContent === cr[0].name);
    ok(link && link.getAttribute("href") === "../" + cr[0].file && doc.querySelector("#contracts").textContent.includes("WIF 2027"), "file listed with link and note");
    const h = JSON.parse(files["data/history.json"]).entries.at(-1);
    ok(h.summary[0].includes("TO Contract Rate: Uploaded") && h.changes[0].path.join() === "destinations,HND,contracts", "history entry for the upload");
    click(w, doc.querySelector(`[data-delcr="${cr[0].id}"]`));
    ok(await until(() => P.BASE.version === v0 + 2), "remove saved as a new version");
    const f2 = repo.files(repo.head);
    ok(byCode(JSON.parse(f2["data/data.json"]), "HND").contracts.length === n0 && f2[cr[0].file] === undefined, "file and list entry removed");
    click(w, doc.querySelector("#btnLogout")); await tick(5);
    ok(!doc.querySelector("#crFile") && doc.querySelector("#contracts").textContent.includes("Log in to upload"), "logged out: no upload form");
  }

  console.log("8b. costing by pax (R&D layout): components ÷ pax = Cost/Pax, + Margin = Selling, Margin × pax = Total Gross");
  {
    await tab(w, doc, "costing");
    setVal(w, doc.querySelector("#selPkg"), "standard"); setVal(w, doc.querySelector("#selVar"), "auto"); await tick(5);
    click(w, doc.querySelector('#costPax [data-tab="adult"]')); await tick(5);
    ok(doc.querySelector(".summary") && doc.querySelector(".summary").textContent.includes("Lowest margin"), "costing summary strip");
    const titles = [...doc.querySelectorAll("#costPax tr.blk-title")].map(t => t.textContent);
    ok(titles.length === 2 && titles[0].includes("Qayyum") && titles[1].includes("/ WIF"), "one block per TO: " + titles.join(" | "));
    const heads = [...doc.querySelectorAll("#costPax tr.blk-head")].map(h => [...h.children].map(t => t.textContent));
    ok(heads[0].some(h => h.startsWith("Airport Haneda")) && heads[0].includes("Cost/Pax") && heads[0].includes("Total Gross"), "header names: " + heads[0].join("|"));
    ok(!doc.querySelector("#costPax .hint") && !doc.querySelector("#costPax .calc"), "no rate formulas until Show calculation is on");
    ok(!doc.querySelector("#rateRef"), "Rate reference hidden by default");
    click(w, doc.querySelector('#costPax [data-calc]')); await tick(5);
    ok(!doc.querySelector("#rateRef"), "Show calculation alone does not open Rate reference");
    click(w, doc.querySelector('#costPax [data-ref]')); await tick(5);
    ok(doc.querySelector('#costPax [data-ref]').textContent === "Hide rate reference", "button reads Hide rate reference when open");
    const rr = [...doc.querySelectorAll("#rateRef tr")].map(r => [...r.children].map(x => x.textContent)), col = c => rr.map(r => r[rr[0].indexOf(c)]);
    ok(col("A").slice(1).join("|") === "Haneda 7-seater|Qayyum|¥22,000" && col("B")[3] === "¥81,000" && col("E")[3] === "RM250", "Rate reference (horizontal) A/B/E: " + JSON.stringify([col("A"), col("B"), col("E")]));
    ok(col("R")[1].startsWith("FX Qayyum") && col("R")[3] === "0.026" && col("S")[3] === "0.029", "Rate reference FX codes R (Qayyum 0.026), S (WIF 0.029): " + JSON.stringify([col("R"), col("S")]));
    ok(col("H")[1] === "Fuji Tour · 8–9 pax" && col("J")[1] === "Fuji Tour · 10+ pax", "band rates show their pax range: " + col("H")[1] + " / " + col("J")[1]);
    const calcRow = tr => [...tr.querySelectorAll(".calc")].map(x => x.textContent.replace(/ = [\d,]+$/, ""));
    const rows = [...doc.querySelectorAll("#costPax tr[data-pax]")], q2 = rows.find(r => r.dataset.pax === "2");
    ok(calcRow(q2).join("|") === "A × 2 × R|(B + C × 3) × R|D × 2 pax × S|E × 4 × 2 pax", "Qayyum 2 pax calculation: " + calcRow(q2).join("|"));
    ok(q2.children[1].textContent.endsWith("= 1,144"), "airport cell = formula = RM1,144: " + q2.children[1].textContent);
    const wBlk = [...doc.querySelectorAll("#costPax tr.blk-title")][1], w1 = (() => { let r = wBlk.nextElementSibling.nextElementSibling; return r; })();
    const wp = +w1.dataset.pax, wa = calcRow(w1)[0];
    ok(wa === (wp <= 9 ? "F" : "G") + " × 2 × S", "WIF block airport uses the band at its pax (" + wp + "): " + wa);
    const g = calcRow(w1).find(x => x.includes("L + M"));
    ok(g === "((L + M + N + O) + (P + M + N + O) × 4) × S", "guide formula keeps code N (not nights): " + g);
    click(w, doc.querySelector('#costPax [data-calc]')); await tick(5);
    ok(!doc.querySelector("#costPax .calc") && doc.querySelector("#rateRef"), "Show calculation off: formulas gone, Rate reference stays");
    click(w, doc.querySelector('#costPax [data-ref]')); await tick(5);
    ok(!doc.querySelector("#rateRef"), "Hide rate reference");
    ok(heads[0].indexOf("Catalog Price") === heads[0].indexOf("Selling Price") - 1, "Catalog Price sits right before 'Selling Price'");
    ok(!heads[0].some(h => h.startsWith("WIF service charge")) && heads[1].some(h => h.startsWith("WIF service charge")), "WIF-only columns blank in the Qayyum block");
    const n = t => { const v = t.replace(/[^\d.\-−]/g, "").replace("−", "-"); return v === "" ? 0 : parseFloat(v); };
    let checked = 0;
    for (const tr of doc.querySelectorAll("#costPax tr[data-pax]")) {
      const td = [...tr.children].map(x => x.textContent.trim()), p = +td[0];
      const nComp = heads[0].indexOf("Cost/Pax") - 1;
      const sum = td.slice(1, 1 + nComp).reduce((a, x) => a + n(x), 0);
      const catEl = tr.children[2 + nComp], catIn = catEl.querySelector("input");
      const cost = n(td[1 + nComp]), cat = catIn ? +catIn.value : n(td[2 + nComp]), sell = n(td[3 + nComp]), m = n(td[4 + nComp]), gross = n(td[6 + nComp]);
      ok(Math.abs(cat - 200 - sell) <= 1, `pax ${p}: catalog ${cat} − 200 = selling ${sell}`);
      ok(Math.abs(sum / p - cost) <= 0.5 + nComp * 0.5 / p, `pax ${p}: ${sum}/${p} ≈ ${cost}`);
      ok(Math.abs(cost + m - sell) <= 1, `pax ${p}: ${cost} + ${m} = ${sell}`);
      ok(Math.abs(m * p - gross) <= p, `pax ${p}: ${m} × ${p} ≈ ${gross}`);
      checked++;
    }
    ok(checked >= 29, "rows 2–30 present (" + checked + ")");
    const r2 = [...doc.querySelectorAll("#costPax tr[data-pax]")].find(r => r.dataset.pax === "2");
    const qfx = HND().fx.find(f => f.id === "QAYYUM").value, qrate = HND().rates.find(r => r.id === "hndQ").value;
    ok(r2.children[1].textContent.trim() === Math.round(2 * qrate * qfx).toLocaleString("en-MY"), `Qayyum 2 pax airport = 2 × ¥${qrate} × ${qfx}, got ` + r2.children[1].textContent.trim());
    click(w, doc.querySelector('#costPax [data-tab="cnb"]')); await tick(5);
    ok(doc.querySelector("#costPax").textContent.includes("adult cost − RM1,200"), "CNB tab shows its cost rule");
  }

  console.log("8c. add-ons");
  {
    const hnd = HND(), a = hnd.addons.find(x => x.label.startsWith("Disneyland/Disneysea (2 pax)"));
    ok(a && a.cost === 754 && a.selling === 800, "Disneyland 2 pax add-on transcribed");
    await tab(w, doc, "addons");
    const q = doc.querySelector(`input.aq[data-addon="${a.id}"]`); setVal(w, q, "2"); await tick(5);
    ok(doc.querySelector("#addons .total").textContent.includes("RM1,600.00") && doc.querySelector("#addons .total").textContent.includes("RM92.00"), "2 × Disneyland = RM1,600 selling, RM92 margin");
    setVal(w, doc.querySelector(`input.aq[data-addon="${a.id}"]`), "0"); await tick(5);
    const sel = byCode(P.DATA, "SEL");
    ok(sel.addons.length > 40 && sel.addons.some(x => x.cost === null) && !sel.addons.some(x => x.cost === 0), "Seoul add-ons keep missing cost as null, not 0");
    const aceh = byCode(P.DATA, "ACEH"), ap = aceh.packages[0], ar = P.priceRow(aceh, ap, ap.assign[0].variant, 2);
    const ground = ar.cost.comps.find(c => c.key === "ground-cost").perPax;
    ok(near(ar.cwb.cost, ar.adult.cost - ground + 0.75 * ground), "Aceh CWB cost = 75% of Ground + tipping in full");
  }

  console.log("8d. hub and other destination pages");
  {
    const hub = await boot(repo, "");
    const links = [...hub.doc.querySelectorAll("#grid a")].map(a => a.getAttribute("href"));
    ok(["sel/?pkg=atk-bsc", "sel/?pkg=atk-std", "seljju/?pkg=atk-std", "hnd/?pkg=basic", "hnd/?pkg=standard", "kbv/?pkg=honeymoon", "aceh/"].every(l => links.includes(l)), "hub links per catalog package: " + links.slice(0, 12).join(","));
    const hubRows = [...hub.doc.querySelectorAll("#grid .row")];
    const nCat = P.DATA.destinations.reduce((s, d) => s + (d.catalogs || []).length, 0);
    ok(hubRows.length === nCat && nCat >= 60, `hub: one row per catalog package (${nCat}), got ${hubRows.length}`);
    const names = hubRows.map(r => r.title + " " + r.children[0].textContent + " " + r.children[2].textContent);
    ok(!names.some(n => /ASONANGGROE|ATK-|WIF-|KTT-|MLE-|Bahrun|Legend-|IBRAHIM/i.test(n)), "hub shows package names, no TO names");
    ok(names.some(n => n.includes("PT ISTANBUL BURSA 5D4N") && n.includes("ISTBUR ·")), "Istanbul Bursa listed under ISTBUR");
    const srch = hub.doc.querySelector("#hubSearch"); srch.value = "maldives"; srch.dispatchEvent(new hub.w.Event("input", { bubbles: true }));
    const vis = hubRows.filter(r => r.style.display !== "none");
    ok(vis.length === byCode(P.DATA, "MLE").catalogs.length, "hub search 'maldives' shows only Maldives packages (" + vis.length + ")");
    srch.value = ""; srch.dispatchEvent(new hub.w.Event("input", { bubbles: true }));
    ok(hubRows.every(r => r.children.length === 4 && r.querySelector(".tier") && / · \S/.test(r.children[2].textContent) && /updated \d{4}-\d{2}-\d{2}/.test(r.children[3].textContent)), "hub rows = route + tier | duration | code · PO | updated date");
    const hndStd = hubRows.find(r => r.title.includes("TOKYO STANDARD"));
    ok(/v\d+ · /.test(hndStd.children[3].title), "Tokyo Standard last update shows the saved version: " + hndStd.children[3].title);
    const deep = await boot(repo, "sel/", "?pkg=atk-std");
    ok(deep.doc.querySelector("#selPkg").value === "atk-std", "sel/?pkg=atk-std opens Seoul Standard");
    ok(/PO\s*Aiman/.test(deep.doc.querySelector("#controls").textContent), "Seoul page shows PO Aiman");
    // Osaka / Tokyo-Osaka are rate by rate too (tools/build_jp_rates.py): codes + Rate reference
    for (const [path, pkg, want] of [["osk/", "ucop-std-wif-std", "A × 2 × J|B × J|C × 4 × 2 pax"], ["kix/", "qay-ucop-std-wif-std", "(A + B) × O|C × O|D × 2 pax|E × 2 pax × P|F × 6 × 2 pax"]]) {
      const pg = await boot(repo, path, "?pkg=" + pkg), $c = s => pg.doc.querySelector("#costPax " + s);
      click(pg.w, $c("[data-ref]")); await tick(5); click(pg.w, $c("[data-calc]")); await tick(5);
      const r2 = pg.doc.querySelector('#costPax tr[data-pax="2"]'), got = [...r2.querySelectorAll(".calc")].map(x => x.textContent.replace(/ = [\d,]+$/, "")).join("|");
      ok(got === want, path + " 2 pax calculation: " + got);
      ok(pg.doc.querySelectorAll("#rateRef thead th.rr-code").length >= 10, path + " Rate reference columns");
      ok(pg.errors.length === 0, path + " errors: " + pg.errors.join("|"));
    }
    const hubPO = [...hub.doc.querySelectorAll("#grid .row")].map(r => r.children[2].textContent.split(" · ")[1].trim());
    const poCount = n => P.DATA.destinations.filter(d => d.po === n).reduce((s, d) => s + d.catalogs.length, 0);
    ok(["Aiman", "Thania", "Fyka", "Acap"].every(n => hubPO.filter(x => x === n).length === poCount(n)), "hub PO column matches each destination's PO");
    ok(hub.doc.querySelector("#controls").style.display === "none", "hub has no calculator controls");
    ok(hub.errors.length === 0, "hub errors: " + hub.errors.join("|"));
    const sj = await boot(repo, "seljju/", "#quote");   // old #quote link falls back to Costing
    ok(sj.doc.querySelector("#controls").textContent.includes("Seoul - Jeju"), "/seljju/ shows Seoul - Jeju");
    ok(sj.doc.querySelector(".tabm.on").dataset.tabmain === "costing" && sj.doc.querySelector('#costPax tr[data-pax="2"] td.sp').textContent.includes("5,997"), "Seoul-Jeju 2 pax selling 5,997 (catalog 6,197 − 200, v29); #quote opens Costing");
    const kb = await boot(repo, "kbv/", "?pkg=standard#quote");
    const hotelSel = kb.doc.querySelector("#opt_hotel");
    ok(hotelSel && hotelSel.options.length === byCode(P.DATA, "KBV").options[0].choices.length, "Krabi has a hotel selector");
    const before4 = kb.doc.querySelector("#costPax").textContent;
    const fourStar = byCode(P.DATA, "KBV").options[0].choices.find(c => c.star === "4★");
    hotelSel.value = fourStar.id; hotelSel.dispatchEvent(new kb.w.Event("change", { bubbles: true })); await tick(5);
    ok(kb.doc.querySelector("#controls").textContent.includes("catalog +RM250") && kb.doc.querySelector("#costPax").textContent !== before4, "4★ hotel adds RM250 to the Standard catalog and changes the costing");
    const seasonSel = kb.doc.querySelector("#opt_season"); seasonSel.value = "High"; seasonSel.dispatchEvent(new kb.w.Event("change", { bubbles: true })); await tick(5);
    ok(kb.doc.querySelector("#opt_season").value === "High" && kb.errors.length === 0, "season selector works " + kb.errors.join("|"));
    const fp = await boot(repo, "flags/");
    const nF = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "flags.json"), "utf8")).flags;
    ok(fp.doc.querySelectorAll(".flags tbody tr").length === nF.filter(f => f.severity !== "low").length, "flags page: high + medium shown by default");
    click(fp.w, fp.doc.querySelector('[data-sev="low"]')); await tick(5);
    ok(fp.doc.querySelectorAll(".flags tbody tr").length === nF.length && fp.errors.length === 0, "flags page: all " + nF.length + " with Low on");
    const jb = await boot(repo, "jbdo/", "#flags");
    ok(jb.doc.querySelector("#grid") && !jb.doc.querySelector("#grid").textContent.includes("price but no cost"), "JBDO Flags tab: no more 'price but no cost' (11–19 pax costed)");
    ok(jb.doc.querySelector(".fxbox").textContent.includes("MYR direct"), "MYR-direct destination says so");
    await tab(jb.w, jb.doc, "costing");
    const jh = [...jb.doc.querySelectorAll("#costPax tr.blk-head th")].map(t => t.textContent);
    ok(!jh.includes("Tipping") && !jh.includes("Ground Cost") && jh[1] === "Cost/Pax", "JBDO: RM0 Tipping hidden; Ground Cost is the only line, so it is Cost/Pax: " + jh.join("|"));
    ok(![...jb.doc.querySelectorAll("#costPax tr[data-pax] td")].some(td => td.textContent.trim() === "0"), "no RM0 component cells shown");
    for (const tb of ["costing", "contracts", "addons", "flags", "history"]) { await tab(jb.w, jb.doc, tb); ok(jb.errors.length === 0 && (jb.doc.querySelector("#grid").textContent.length > 20 || (tb === "flags" && jb.doc.querySelector("#grid").textContent.includes("No flags"))), "JBDO tab " + tb + " renders"); }
    for (const code of ["mle", "phu", "cts", "aceh", "kix"]) {
      const pg = await boot(repo, code + "/");
      ok(pg.doc.querySelector("#costPax") && pg.errors.length === 0, `/${code}/ renders without errors ` + pg.errors.join("|"));
    }
    ok(sj.errors.length === 0, "seljju errors: " + sj.errors.join("|"));
    fs.mkdirSync(path.join(ROOT, "zzz"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "zzz", "index.html"), fs.readFileSync(path.join(ROOT, "hnd", "index.html"), "utf8").replace('"HND"', '"ZZZ"'));
    const bad = await boot(repo, "zzz/");
    fs.rmSync(path.join(ROOT, "zzz"), { recursive: true });
    ok(bad.doc.querySelector("#grid").textContent.includes("No destination with code ZZZ"), "unknown code shows a message");
  }

  console.log("8e. catalog sections: Costing price table, Itinerary editable, Add On tick — saved into data/catalogs/<slug>.json");
  {
    const V = P.BASE.version;
    await tab(w, doc, "costing"); setVal(w, doc.querySelector("#selPkg"), "standard"); await tick(5);
    await tab(w, doc, "itinerary"); await until(() => doc.querySelector("#cat-tokyo-standard"));
    const pkg = HND().packages.find(p => p.id === "standard");
    if (!doc.querySelector("#btnEdit")) {
      click(w, doc.querySelector("#btnLogin")); await tick(5);
      doc.querySelector("#lu").value = "aiman"; doc.querySelector("#lp").value = "aiman-pass-2026";
      click(w, doc.querySelector("#doLogin"));
    }
    ok(await until(() => doc.querySelector("#btnEdit")), "editor logged in");
    if (!/Stop/.test(doc.querySelector("#btnEdit").textContent)) { click(w, doc.querySelector("#btnEdit")); await tick(5); }
    await tab(w, doc, "costing"); await until(() => doc.querySelector("#cat-tokyo-standard-price"));
    const first = doc.querySelector("#cat-tokyo-standard-price .cd-t tbody tr td.num");
    ok(first && first.textContent === "RM" + (+pkg.pricing.adult["2"]).toLocaleString("en-US"), "Costing (Edit): catalog price table = Catalog Price column (2 pax adult): " + (first && first.textContent));
    await tab(w, doc, "itinerary");
    const cpath = (...p) => JSON.stringify(["tokyo-standard", ...p]);
    const titleIn = [...doc.querySelectorAll("input.ed.cat")].find(x => x.dataset.cpath === cpath("itinerary", 0, "title"));
    ok(titleIn && [...doc.querySelectorAll("input.ed.cat, textarea.ed.cat")].length > 20, "header, hotels, itinerary, includes/excludes are editable");
    setVal(w, titleIn, "KUL - HND (edited)"); await tick(10);
    const acts = [...doc.querySelectorAll("textarea.ed.cat")].find(x => x.dataset.cpath === cpath("itinerary", 0, "activities"));
    setVal(w, acts, acts.value + "\nWelcome dinner\n  - halal"); await tick(10);
    await tab(w, doc, "addons");
    const fuji = HND().addons.find(a => a.catalogs && "tokyo-standard" in a.catalogs && /Fuji Day Tour/.test(a.label)), nIn = HND().addons.filter(a => a.catalogs && "tokyo-standard" in a.catalogs).length;
    const tk = [...doc.querySelectorAll("input.aotick")].find(x => JSON.parse(x.dataset.tick).id === fuji.id);
    ok(tk && tk.checked && !tk.disabled, "Add On (Edit): tick enabled for " + fuji.label);
    tk.checked = false; fire(w, tk, "change"); await tick(10);
    ok(!(fuji.catalogs || {})["tokyo-standard"] && HND().addons.filter(a => a.catalogs && "tokyo-standard" in a.catalogs).length === nIn - 1, "untick removes it from the catalog");
    ok(doc.querySelector("#aoLabel") && doc.querySelector('[data-act="addAddon"]'), "Add On (Edit): Add item form");
    doc.querySelector("#aoCat").value = "Add On Activity"; doc.querySelector("#aoLabel").value = "Shibuya Sky Observatory";
    doc.querySelector("#aoPer").value = "pax"; doc.querySelector("#aoCost").value = "120"; doc.querySelector("#aoSell").value = "150";
    click(w, doc.querySelector('[data-act="addAddon"]')); await tick(10);
    const added = HND().addons.find(a => a.label === "Shibuya Sky Observatory");
    ok(added && /^hnd-n\d{3}$/.test(added.id) && added.cost === 120 && added.selling === 150 && added.per === "pax" && added.category === "Add On Activity", "new item added with cost / selling / per / category: " + JSON.stringify(added));
    ok(added && added.catalogs && added.catalogs["tokyo-standard"] > 0 && JSON.stringify(added.price_lines) === JSON.stringify(["RM150/pax"]), "new item ticked for tokyo-standard, catalog price text RM150/pax");
    ok([...doc.querySelectorAll("#addons input.ed")].some(x => x.value === "Shibuya Sky Observatory"), "new item listed (editable)");
    ok(doc.querySelector("#btnSave") && doc.querySelector("#btnSave").textContent.includes("(4)"), "Save counts 2 catalog edits + 1 add-on tick + 1 new item: " + (doc.querySelector("#btnSave") || {}).textContent);
    click(w, doc.querySelector("#btnSave")); await tick(5);
    doc.querySelector("#saveNote").value = "Tokyo Std itinerary";
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => P.BASE.version === V + 1), "saved as one version");
    const cat = JSON.parse(repo.files(repo.head)["data/catalogs/tokyo-standard.json"]);
    ok(cat.itinerary[0].title === "KUL - HND (edited)" && JSON.stringify(cat.itinerary[0].activities.at(-1)) === JSON.stringify({ text: "Welcome dinner", sub: ["halal"] }), "catalog file has the edits (sub-item from '  - ')");
    ok(!cat.prices.rows.some(r => "amounts" in r) && !("addons" in cat) && cat.hub_version === V + 1, "no prices / add-ons written into the catalog; hub_version stamped for the add-on change");
    const rem = JSON.parse(repo.files(repo.head)["data/data.json"]), fujiNow = byCode(rem, "HND").addons.find(a => a.id === fuji.id);
    ok(!(fujiNow.catalogs || {})["tokyo-standard"], "repo data.json: Fuji Day Tour no longer ticked for tokyo-standard");
    ok(byCode(rem, "HND").addons.some(a => a.label === "Shibuya Sky Observatory" && a.catalogs && a.catalogs["tokyo-standard"]), "repo data.json: new item saved, ticked for tokyo-standard");
    const e = JSON.parse(repo.files(repo.head)["data/history.json"]).entries.find(x => x.v === V + 1);
    ok(e && e.changes.filter(c => c.path[0] === "catalogs" && c.path[1] === "tokyo-standard").length === 2 && e.changes.some(c => c.path[2] === "addons"), "history lists the 2 catalog edits + the add-on changes");
    ok(JSON.parse(repo.files(repo.head)["data/data.json"]).version === V + 1, "data.json version bumped with it");
    ok(!doc.querySelector("#btnSave"), "nothing pending after save");
    click(w, doc.querySelector("#btnEdit")); await tick(5);
  }

  console.log("8g. Info KB + Simple Calculator tabs: PT KB House content from data/kb/<slug>.json, edited and saved like the catalogs");
  {
    const V = P.BASE.version, kb0 = JSON.parse(files["data/kb/jepun.json"]), clone0 = o => JSON.parse(JSON.stringify(o));
    if (doc.querySelector("#btnEdit") && doc.querySelector("#btnEdit").textContent.includes("Stop")) { click(w, doc.querySelector("#btnEdit")); await tick(5); }
    await tab(w, doc, "kbinfo"); await until(() => doc.querySelector("#kb-attr"));
    const g = doc.querySelector("#grid"), t = g.textContent, a0 = kb0.content.attractions[0];
    ok(doc.querySelector('[data-tabmain="kbinfo"]').textContent === "Info KB" && doc.querySelector('[data-tabmain="kbcalc"]').textContent === "Simple Calculator", "tabs named Info KB and Simple Calculator");
    ok(t.includes(a0.n) && t.includes("Muslim-friendly") && g.querySelectorAll(".kb-attr").length >= kb0.content.attractions.length, "Info KB (HND → jepun KB): attractions with Muslim-friendly info");
    ok(g.querySelectorAll("#kb-faq details.kb-faq").length > 3 && g.querySelectorAll("#kb-blocks details").length > 3, "Info KB: FAQ sections and KB tab blocks (transport, flight, free gift …)");
    ok(!g.querySelector('[data-kbtext] img[src^="@asset"]') && !g.innerHTML.includes("@asset:"), "no unresolved KB image tokens in the hub page");
    ok(await until(() => doc.querySelector("#kb-linked") && doc.querySelector("#kb-linked").textContent.includes("tokyo-standard") && doc.querySelector("#kb-linked .cd-itin")), "Info KB: price, itinerary and includes / excludes come from the catalogs (Costing + Itinerary tabs), read-only");
    ok(!kb0.content.packages.some((p, i) => kb0.map.packages[i] && ("inc" in p || "exc" in p)) && kb0.content.itineraries.every((x, i) => !kb0.map.packages[i] || x === null), "the KB file keeps no copy of a linked package's itinerary / includes / excludes");
    const q = doc.querySelector("#kbq"); q.value = "halal"; q.dispatchEvent(new w.Event("input", { bubbles: true })); await tick(5);
    const items = [...g.querySelectorAll("[data-kbtext]")];
    ok(items.some(x => x.style.display === "none") && items.some(x => x.style.display !== "none"), "Info KB search filters the attractions / FAQ");
    q.value = ""; q.dispatchEvent(new w.Event("input", { bubbles: true }));
    await tab(w, doc, "kbcalc"); await until(() => doc.querySelector("#kb-tiers"));
    const fr = doc.querySelector("#kbCalcFrame");
    ok(fr && fr.getAttribute("src").startsWith("https://prod-at22.github.io/pt-kb-house/jepun/"), "Simple Calculator tab embeds the KB's calculator");
    ok(doc.querySelectorAll("#kb-tiers tbody tr").length === kb0.calc.variants.length, "Simple Calculator: one tier row per calculator package (" + kb0.calc.variants.length + ")");
    click(w, doc.querySelector("#btnEdit")); await tick(5);
    await tab(w, doc, "kbinfo"); await until(() => doc.querySelector("#kb-attr .kbed"));
    const mp = JSON.stringify(["jepun", "content", "attractions", 0, "muslim"]), mi = [...doc.querySelectorAll(".kbed")].find(x => x.dataset.kpath === mp);
    ok(mi, "Edit costs: attraction Muslim-friendly text is editable");
    mi.value = "Surau di stesen (diuji)"; fire(w, mi, "change"); await tick(10);
    await tab(w, doc, "kbcalc"); await until(() => doc.querySelector("#kb-calc-edit textarea"));
    let ta = doc.querySelector("#kb-calc-edit textarea"); ta.value = "{ broken"; fire(w, ta, "change"); await tick(10);
    ok(doc.querySelector("#btnSave").textContent.includes("(1)"), "broken calculator JSON is not accepted");
    ta = doc.querySelector("#kb-calc-edit textarea"); const cfg = clone0(kb0.calc); cfg.deposit = 600; ta.value = JSON.stringify(cfg); fire(w, ta, "change"); await tick(10);
    ok(doc.querySelector("#btnSave").textContent.includes("(2)"), "Save counts the 2 KB edits: " + doc.querySelector("#btnSave").textContent);
    click(w, doc.querySelector("#btnSave")); await tick(5);
    doc.querySelector("#saveNote").value = "KB Jepun: surau + deposit";
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => P.BASE.version === V + 1), "saved as one version");
    const kb1 = JSON.parse(repo.files(repo.head)["data/kb/jepun.json"]);
    ok(kb1.content.attractions[0].muslim === "Surau di stesen (diuji)" && kb1.calc.deposit === 600, "data/kb/jepun.json has both edits");
    ok(JSON.stringify({ ...kb1, calc: { ...kb1.calc, deposit: kb0.calc.deposit } }).length === JSON.stringify(kb0).length - kb0.content.attractions[0].muslim.length + "Surau di stesen (diuji)".length, "nothing else changed in the KB file");
    const e = JSON.parse(repo.files(repo.head)["data/history.json"]).entries.find(x => x.v === V + 1);
    ok(e && e.kb && e.kb[0].includes("jepun") && e.changes.every(c => c.path[0] === "kb" && c.label.startsWith("KB jepun")), "history entry lists the KB changes: " + (e && (e.kb || []).join("; ")));
    ok(JSON.parse(repo.files(repo.head)["data/data.json"]).version === V + 1, "data.json version bumped with it");
    ok(await until(() => repo.kbDispatches >= 1), "save starts the PT KB House mirror (workflow_dispatch on pt-kb-house)");
    await tab(w, doc, "history"); ok(doc.querySelector("#grid").textContent.includes("KB Jepun: surau + deposit"), "Tokyo History shows the KB change (jepun covers HND)");
    if (doc.querySelector("#btnEdit") && doc.querySelector("#btnEdit").textContent.includes("Stop")) { click(w, doc.querySelector("#btnEdit")); await tick(5); }
    const ac = await boot(repo, "aceh/", "#kbinfo"); await until(() => ac.doc.querySelector("#kb-attr"));
    ok(ac.doc.querySelector("#grid").textContent.includes("Masjid Raya Baiturrahman") && ac.errors.length === 0, "bespoke KB (aceh) shows in Info KB");
  }

  console.log("8h. Accommodation tab: one hotel list per destination; catalogs (Accommodation + Surcharge rows) and the KB read it");
  {
    const pg = await boot(repo, "dps/", "#accommodation"); await until(() => pg.doc.querySelector("#hotels tbody tr"));
    const P2 = pg.w.PTCALC, D2 = () => P2.DATA.destinations.find(d => d.code === "DPS"), V = P2.BASE.version;
    const cat0 = JSON.parse(repo.files(repo.head)["data/catalogs/bali-standard.json"]);
    ok(!("rows" in (cat0.surcharge || {})) && !("accommodation" in cat0), "catalog file keeps no hotel rows (they live in the Accommodation tab)");
    ok(pg.doc.querySelectorAll("#hotels tbody tr").length === D2().hotels.length && D2().hotels.some(h => (h.catalogs || {})["bali-standard"] && h.catalogs["bali-standard"].sur), "Accommodation tab lists DPS hotels, ticked for bali-standard Surcharge");
    ok(await until(() => pg.doc.querySelector("#kb-hotels") && pg.doc.querySelector("#kb-hotels").textContent.includes("Favehotel")), "KB hotel cards (Bali KB) shown on the same tab");
    await tab(pg.w, pg.doc, "surcharge"); await until(() => pg.doc.querySelector("#grid").textContent.includes("Favehotel Kartika Plaza"));
    ok(pg.doc.querySelector("#grid").textContent.includes("RM40/pax/night"), "Surcharge tab: hotel rows (and amounts) from the Accommodation tab");
    P2.EDIT = true; P2.render(); await tab(pg.w, pg.doc, "accommodation"); await until(() => pg.doc.querySelector("#hotels input.ed"));
    P2.SESSION = { u: "aiman", role: "editor", token: "tok-valid" };
    const h0 = D2().hotels.find(h => (h.catalogs || {})["bali-standard"] && h.catalogs["bali-standard"].sur === 1);
    const nameIn = [...pg.doc.querySelectorAll("#hotels input.ed")].find(x => x.dataset.path === JSON.stringify(["destinations", "DPS", "hotels", h0.id, "name"]));
    nameIn.value = "Favehotel Kartika Plaza (diuji)"; fire(pg.w, nameIn, "change"); await tick(10);
    ok(pg.doc.querySelector("#kb-hotels").textContent.includes("Favehotel Kartika Plaza (diuji)"), "the KB hotel card takes the hotel name from the Accommodation list (one source)");
    ok(pg.doc.querySelectorAll("#kb-hotels input.khotel").length > 3 && [...pg.doc.querySelectorAll("#hotels tbody tr")].some(r => r.textContent.includes("3 bintang")), "Edit costs: KB cards pick hotels from the list; the list shows which KB card uses each hotel");
    click(pg.w, pg.doc.querySelector('[data-act="addHotel"]')); await tick(10);
    const nh = D2().hotels.at(-1);
    ok(nh && /^dps-h\d+$/.test(nh.id) && pg.doc.querySelectorAll("#hotels tbody tr").length === D2().hotels.length, "+ Tambah hotel adds a row");
    const ni = [...pg.doc.querySelectorAll("#hotels input.ed")].find(x => x.dataset.path === JSON.stringify(["destinations", "DPS", "hotels", nh.id, "name"]));
    ni.value = "Hotel Baru Kuta"; fire(pg.w, ni, "change"); await tick(10);
    const tk = [...pg.doc.querySelectorAll("input.htick")].find(x => JSON.parse(x.dataset.htick).id === nh.id && JSON.parse(x.dataset.htick).slug === "bali-standard" && JSON.parse(x.dataset.htick).kind === "sur");
    tk.checked = true; fire(pg.w, tk, "change"); await tick(10);
    ok(D2().hotels.at(-1).catalogs["bali-standard"].sur > 1 && D2().hotels.at(-1).catalogs["bali-standard"].amounts.length === 2, "tick Surcharge for bali-standard: last position, one amount per surcharge column");
    click(pg.w, pg.doc.querySelector("#btnSave")); await tick(5);
    pg.doc.querySelector("#saveNote").value = "Bali hotel diuji";
    click(pg.w, pg.doc.querySelector("#doSave"));
    ok(await until(() => P2.BASE.version === V + 1), "saved as one version");
    const rem = JSON.parse(repo.files(repo.head)["data/data.json"]), hd = rem.destinations.find(d => d.code === "DPS").hotels;
    ok(hd.find(h => h.id === h0.id).name === "Favehotel Kartika Plaza (diuji)" && hd.some(h => h.name === "Hotel Baru Kuta"), "data.json has the hotel edits");
    const cat1 = JSON.parse(repo.files(repo.head)["data/catalogs/bali-standard.json"]);
    ok(cat1.hub_version === V + 1 && !("rows" in (cat1.surcharge || {})), "bali-standard: hub_version stamped (catalog rebuilds), still no hotel rows in the file");
    ok(pg.errors.length === 0, "accommodation errors: " + pg.errors.join("|"));
  }

  console.log("8f. Add On: delete an item (Edit costs), warns when it is in a catalog");
  {
    const pg = await boot(repo, "hnd/", "?pkg=standard#addons");
    await until(() => pg.doc.querySelector("input.aotick"));
    ok(!pg.doc.querySelector('[data-act="delAddon"]'), "no Delete button when not editing");
    pg.w.PTCALC.EDIT = true; pg.w.PTCALC.render(); await tick(5);
    const H2 = () => pg.w.PTCALC.DATA.destinations.find(d => d.code === "HND");
    const victim = H2().addons.find(a => a.catalogs && a.catalogs["tokyo-standard"]), n0 = H2().addons.length;
    let asked = ""; pg.w.confirm = m => { asked = m; return true; };
    click(pg.w, [...pg.doc.querySelectorAll('[data-act="delAddon"]')].find(b => b.dataset.id === victim.id)); await tick(10);
    ok(!H2().addons.some(a => a.id === victim.id) && H2().addons.length === n0 - 1, "item removed from the destination's add-ons");
    ok(asked.includes(victim.label) && asked.includes("tokyo-standard"), "confirm names the item and the catalog it is printed in");
    const ch = pg.w.PTCALC.diff(pg.w.PTCALC.BASE, pg.w.PTCALC.DATA);
    ok(ch.some(c => c.path[1] === "HND" && c.path[2] === "addons"), "the delete is a pending change (saved with Save)");
    pg.w.confirm = () => false;
    const keep = H2().addons[0]; click(pg.w, [...pg.doc.querySelectorAll('[data-act="delAddon"]')].find(b => b.dataset.id === keep.id)); await tick(5);
    ok(H2().addons.some(a => a.id === keep.id), "Cancel keeps the item");
    ok(pg.errors.length === 0, "delete errors: " + pg.errors.join("|"));
  }

  console.log("9. no runtime errors");
  ok(errors.length === 0, "errors: " + errors.join(" | "));

  console.log(`\n${fail ? "FAILED" : "ALL PASSED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
