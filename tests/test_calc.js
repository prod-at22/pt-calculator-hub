// Tests for the PT costing calculator.
//   node tests/test_calc.js [truth.json]
// Needs jsdom (npm i jsdom). truth.json = per-TO, per-pax costs read from the
// R&D workbooks after a LibreOffice recalculation (see README "Verifying").
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = path.join(__dirname, "..");
const TRUTH = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : null;

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log("  FAIL", msg); } };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- mock GitHub repo
function mockRepo(files, validTokens) {
  let n = 0; const commits = {}, trees = {};
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
      for (const f of body.tree) trees[t][f.path] = f.content; return [201, { sha: t }];
    }
    if (method === "POST" && p === "/git/commits") { const c = "c" + (++n); commits[c] = { tree: body.tree, parents: body.parents, message: body.message }; return [201, { sha: c }]; }
    if (method === "PATCH" && p === "/git/refs/heads/main") {
      if (commits[body.sha].parents[0] !== repo.head) return [422, { message: "Update is not a fast forward" }];
      repo.head = body.sha; repo.log.push(commits[body.sha].message); return [200, {}];
    }
    return [404, { message: "no route " + method + " " + p }];
  };
  return repo;
}

async function boot(repo) {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const errors = [];
  const dom = new JSDOM(html, {
    url: "https://prod-at22.github.io/pt-calculator-hub/", runScripts: "dangerously", pretendToBeVisual: true,
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
        const rel = String(url).split("?")[0];
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
const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await tick(25); } return false; }
function fire(w, el, type) { el.dispatchEvent(new w.Event(type, { bubbles: true })); }
function setVal(w, el, v) { el.value = v; fire(w, el, "change"); }
const click = (w, el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

(async () => {
  const files = {};
  for (const f of ["data.json", "history.json", "users.json"]) files["data/" + f] = fs.readFileSync(path.join(ROOT, "data", f), "utf8");
  const repo = mockRepo(files, ["tok-valid", "tok-new"]);
  const { w, doc, errors } = await boot(repo);
  const P = w.PTCALC, D = P.DATA;

  console.log("1. costs match the R&D CR tab");
  if (TRUTH) {
    let checked = 0;
    for (const [code, tos] of Object.entries(TRUTH)) {
      const d = D.destinations.find(x => x.code === code);
      for (const [to, rows] of Object.entries(tos)) {
        const v = d.variants.find(x => x.id === to);
        ok(v, `${code} variant ${to} exists`);
        for (const [pax, t] of Object.entries(rows)) {
          const c = P.variantCost(d, v, +pax);
          ok(c && near(c.total, t.total), `${code} ${to} pax ${pax}: total ${c && c.total} vs R&D ${t.total}`);
          for (const [k, val] of Object.entries(t.comps)) {
            const comp = c && c.comps.find(x => x.key === k);
            const got = comp ? comp.group : 0;
            const exp = code === "SEL" ? val * +pax : (val || 0);   // SEL CR columns are per pax; HND are group totals
            ok(near(got, exp), `${code} ${to} pax ${pax} ${k}: ${got} vs ${exp}`);
          }
          checked++;
        }
      }
    }
    console.log("   checked", checked, "TO × pax rows");
  } else console.log("   (skipped: pass truth.json)");

  console.log("2. selling / margin rules");
  {
    const sel = D.destinations.find(x => x.code === "SEL"), b = sel.packages.find(p => p.id === "basic");
    const r = P.priceRow(sel, b, "ATK-PT-BSC", 2);
    ok(r.adult.catalog === 3497 && r.adult.selling === 3497, "Seoul Basic 2 pax adult catalog/selling 3497");
    ok(near(r.cwb.cost, r.adult.cost * 0.75), "Seoul CWB cost = 75% adult");
    ok(near(r.cnb.cost, r.adult.cost * 0.5), "Seoul CNB cost = 50% adult");
    ok(r.infant.selling === 200 && r.infant.cost === 0, "Seoul infant RM200, cost 0");
    ok(near(r.adult.margin, 3497 - r.adult.cost) && near(r.adult.pct, r.adult.margin / 3497), "Seoul margin & %");
    const hnd = D.destinations.find(x => x.code === "HND"), s = hnd.packages.find(p => p.id === "standard");
    const r6 = P.priceRow(hnd, s, "QAYYUM-STD", 6), r8 = P.priceRow(hnd, s, "WIF-STD", 8);
    ok(r6.adult.catalog === 3797 && r6.adult.selling === 3597, "Tokyo Std 6 pax catalog 3797, selling 3597 (tier-2 −200)");
    ok(r8.adult.catalog === 3897, "Tokyo Std 8 pax catalog 3897");
    ok(near(r6.cnb.cost, r6.adult.cost - 1200), "Tokyo CNB cost = adult − 1200");
    ok(near(r6.cwb.cost, r6.adult.cost), "Tokyo CWB cost = 100% adult");
    ok(r6.infant.selling === 200, "Tokyo infant RM200 with no tier-2 discount");
    ok(P.priceRow(hnd, s, "QAYYUM-STD", 8).cost === null, "Qayyum does not cover 8 pax");
  }

  console.log("3. UI: destination / package / auto TO by pax");
  {
    setVal(w, doc.querySelector("#selDest"), "HND"); await tick(5);
    setVal(w, doc.querySelector("#selPkg"), "standard"); await tick(5);
    setVal(w, doc.querySelector("#pax_adult"), "6"); await tick(5);
    ok(doc.querySelector("#selVar").options[0].textContent.includes("QAYYUM-STD"), "6 pax → Qayyum");
    setVal(w, doc.querySelector("#pax_adult"), "8"); await tick(5);
    ok(doc.querySelector("#selVar").options[0].textContent.includes("WIF-STD"), "8 pax → WIF-STD");
    ok(doc.querySelector("#kpis").textContent.includes("RM3,697"), "8 pax selling RM3,697 shown (3897 − 200)");
    setVal(w, doc.querySelector("#pax_cwb"), "2"); setVal(w, doc.querySelector("#pax_infant"), "1"); await tick(5);
    ok(doc.querySelector("#selVar").options[0].textContent.includes("WIF-STD"), "8 adult + 2 CWB = band 10 → WIF-STD");
    const rows = doc.querySelectorAll("#grid table")[1].querySelectorAll("tbody tr");
    ok(rows.length === 5, "selling table has 4 pax types + total");
    ok(doc.querySelectorAll("tr[data-variant]").length >= 2, "TO comparison lists more than one TO at 10 pax");
    click(w, doc.querySelector('tr[data-variant="WIF-BSC"]')); await tick(5);
    ok(doc.querySelector("#selVar").value === "WIF-BSC", "clicking comparison row switches TO");
    setVal(w, doc.querySelector("#selVar"), "auto");
    setVal(w, doc.querySelector("#pax_adult"), "50"); setVal(w, doc.querySelector("#pax_cwb"), "0"); setVal(w, doc.querySelector("#pax_infant"), "0"); await tick(5);
    ok(doc.querySelector("#grid").textContent.includes("No tour operator covers 50 pax"), "50 pax shows a gap, not RM0");
    setVal(w, doc.querySelector("#pax_adult"), "2"); await tick(5);
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
    setVal(w, doc.querySelector("#selDest"), "HND"); setVal(w, doc.querySelector("#selPkg"), "basic"); setVal(w, doc.querySelector("#pax_adult"), "2"); await tick(5);
    before = P.priceRow(P.DATA.destinations[1], P.DATA.destinations[1].packages[0], "WIF-BSC", 2).adult.cost;
    click(w, doc.querySelector("#btnEdit")); await tick(5);
    const inp = [...doc.querySelectorAll("input.ed")].find(x => x.dataset.path === JSON.stringify(["destinations", "HND", "rates", "hnd7", "value"]));
    ok(inp, "Haneda 7-seater rate is editable");
    setVal(w, inp, "18000"); await tick(10);
    const after = P.priceRow(P.DATA.destinations[1], P.DATA.destinations[1].packages[0], "WIF-BSC", 2).adult.cost;
    ok(near(after - before, 2 * 1000 * 0.029 / 2), "cost/pax rises by 2×¥1000×0.029÷2 pax");
    ok(doc.querySelector("#btnSave")?.textContent.includes("(1)"), "save button shows 1 change");
    click(w, doc.querySelector("#btnSave")); await tick(5);
    click(w, doc.querySelector("#doSave")); await tick(5);
    ok(doc.querySelector(".err-t").textContent.includes("note"), "note is required");
    doc.querySelector("#saveNote").value = "WIF 2027 airport rate";
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => P.BASE.version === 2), "saved as v2");
    const remote = JSON.parse(repo.files(repo.head)["data/data.json"]);
    ok(remote.version === 2 && remote.updatedBy === "aiman", "repo data.json v2 by aiman");
    ok(remote.destinations[1].rates.find(r => r.id === "hnd7").value === 18000, "repo has new rate");
    const hist = JSON.parse(repo.files(repo.head)["data/history.json"]);
    const e = hist.entries.find(x => x.v === 2);
    ok(e && e.by === "aiman" && e.changes.length === 1 && e.changes[0].from === 17000 && e.changes[0].label.includes("Haneda 7-seater"), "history entry v2 with readable label");
    ok(repo.log.at(-1).startsWith("v2 · aiman: WIF 2027"), "one commit with version message");
    ok(doc.querySelector("#histCard").textContent.includes("WIF 2027 airport rate"), "history card shows note");
    const snap = P.snapshotAt(1);
    ok(snap.destinations[1].rates.find(r => r.id === "hnd7").value === 17000, "v1 rebuilt from change log");
    click(w, doc.querySelector('[data-view="1"]')); await tick(5);
    ok(doc.querySelector("#banners").textContent.includes("Read-only: version 1"), "viewing v1 banner");
    click(w, doc.querySelector('[data-act="restore"]')); await tick(5);
    ok(doc.querySelector("#saveNote").value === "Restore to v1", "restore pre-fills note");
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => P.BASE.version === 3), "restore saved as v3");
    ok(near(P.priceRow(P.DATA.destinations[1], P.DATA.destinations[1].packages[0], "WIF-BSC", 2).adult.cost, before), "cost back to v1");
  }

  console.log("7. concurrent saves");
  {
    // someone else saves v4 changing the Qayyum FX
    const other = JSON.parse(repo.files(repo.head)["data/data.json"]);
    other.destinations[1].fx.find(f => f.id === "QAYYUM").value = 0.026; other.version = 4;
    const oh = JSON.parse(repo.files(repo.head)["data/history.json"]);
    oh.entries.push({ v: 4, at: new Date().toISOString(), by: "ezie", note: "fx", changes: [{ path: ["destinations", "HND", "fx", "QAYYUM", "value"], from: 0.0259, to: 0.026 }] });
    let [, t] = repo.handle("POST", "https://api.github.com/repos/x/y/git/trees", { base_tree: repo.commits[repo.head].tree, tree: [{ path: "data/data.json", content: JSON.stringify(other) }, { path: "data/history.json", content: JSON.stringify(oh) }] }, "Bearer tok-valid");
    let [, c] = repo.handle("POST", "https://api.github.com/repos/x/y/git/commits", { tree: t.sha, parents: [repo.head], message: "v4 other" }, "Bearer tok-valid");
    repo.handle("PATCH", "https://api.github.com/repos/x/y/git/refs/heads/main", { sha: c.sha }, "Bearer tok-valid");
    // we (still on v3) edit a different cell
    click(w, doc.querySelector("#btnEdit")); await tick(5);
    const inp = [...doc.querySelectorAll("input.ed")].find(x => x.dataset.path === JSON.stringify(["destinations", "HND", "rates", "kachi", "value"]));
    setVal(w, inp, "1100"); await tick(10);
    click(w, doc.querySelector("#btnSave")); await tick(5);
    doc.querySelector("#saveNote").value = "ropeway price";
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => P.BASE.version === 5), "different cell → replayed on top, saved v5");
    const r5 = JSON.parse(repo.files(repo.head)["data/data.json"]);
    ok(r5.destinations[1].fx.find(f => f.id === "QAYYUM").value === 0.026 && r5.destinations[1].rates.find(r => r.id === "kachi").value === 1100, "both users' edits kept");
    // same cell clash
    const o2 = JSON.parse(JSON.stringify(r5)); o2.destinations[1].rates.find(r => r.id === "kachi").value = 1200; o2.version = 6;
    [, t] = repo.handle("POST", "https://api.github.com/repos/x/y/git/trees", { base_tree: repo.commits[repo.head].tree, tree: [{ path: "data/data.json", content: JSON.stringify(o2) }] }, "Bearer tok-valid");
    [, c] = repo.handle("POST", "https://api.github.com/repos/x/y/git/commits", { tree: t.sha, parents: [repo.head], message: "v6 other" }, "Bearer tok-valid");
    repo.handle("PATCH", "https://api.github.com/repos/x/y/git/refs/heads/main", { sha: c.sha }, "Bearer tok-valid");
    click(w, doc.querySelector("#btnEdit")); await tick(5);
    const inp2 = [...doc.querySelectorAll("input.ed")].find(x => x.dataset.path === JSON.stringify(["destinations", "HND", "rates", "kachi", "value"]));
    setVal(w, inp2, "1300"); await tick(10);
    click(w, doc.querySelector("#btnSave")); await tick(5);
    doc.querySelector("#saveNote").value = "clash";
    click(w, doc.querySelector("#doSave"));
    ok(await until(() => doc.querySelector(".err-t")?.textContent.includes("same cells")), "same-cell clash is refused, not overwritten");
    ok(JSON.parse(repo.files(repo.head)["data/data.json"]).destinations[1].rates.find(r => r.id === "kachi").value === 1200, "other user's value untouched");
    click(w, doc.querySelector("[data-close]"));
  }

  console.log("8. editor cannot see admin tools; formulas admin-only");
  {
    click(w, doc.querySelector("#btnAcct")); await tick(5);
    ok(!doc.querySelector("#doAdd"), "editor has no Add user");
    click(w, doc.querySelector("[data-close]"));
    ok(![...doc.querySelectorAll("input.ed")].some(x => x.dataset.path.includes('"expr"')), "editor cannot edit formulas");
  }

  console.log("9. no runtime errors");
  ok(errors.length === 0, "errors: " + errors.join(" | "));

  console.log(`\n${fail ? "FAILED" : "ALL PASSED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
