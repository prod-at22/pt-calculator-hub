"use strict";
/* ============================================================ config
   REPO is the GitHub repository this page saves to. Viewing needs nothing;
   saving needs a username/password whose entry in data/users.json unlocks
   the repo token (see README). */
const REPO = { owner: "prod-at22", name: "pt-calculator-hub", branch: "main" };
const ROOT = window.PT_ROOT || "";          // "../" on /<code>/ pages
const PAGE_DEST = window.PT_DEST || null;   // destination code, null on the hub
const PAGE_VIEW = window.PT_VIEW || null;   // "flags" on /flags/
const PATHS = { data: "data/data.json", history: "data/history.json", users: "data/users.json", flags: "data/flags.json" };
const KDF_ITER = 310000;
const IDLE_LOGOUT_MS = 30 * 60 * 1000;

/* ============================================================ state */
let DATA = null;      // working copy (may contain unsaved edits)
let BASE = null;      // last loaded / saved version
let HISTORY = { entries: [] };
let USERS = { users: [] };
let FLAGS = { flags: [] };
let SESSION = null;   // {u, role, token, key}
let EDIT = false;
let VIEW = null;      // {v, data} when viewing an older version
const SEL = { dest: null, pkg: new URLSearchParams(location.search).get("pkg"), variant: "auto", pax: 2, paxTab: "adult", showCalc: false, addonQty: {}, opt: {}, tab: (location.hash || "#costing").slice(1), flagSev: { high: true, medium: true, low: false }, flagArea: "", flagPO: "", flagQ: "" };
const TABS = [["costing", "Costing"], ["contracts", "TO Contract Rate"], ["addons", "Add-ons"], ["flags", "Flags"], ["history", "History"]];
const CONTRACT_MAX_MB = 25;   // per file; stored in the repo under contracts/<code>/
let lastActivity = Date.now();

/* ============================================================ utils */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const num = v => (typeof v === "number" && isFinite(v));
function rm(v, d = 0) {
  if (!num(v)) return '<span class="missing" title="No rate / price for this pax">—</span>';
  return (v < 0 ? "−" : "") + "RM" + Math.abs(v).toLocaleString("en-MY", { minimumFractionDigits: d, maximumFractionDigits: d });
}
const n2 = (v, d = 2) => num(v) ? v.toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: d }) : "—";
const pct = v => num(v) ? (v * 100).toFixed(1) + "%" : "—";
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function toast(msg, ms = 2600) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
const shown = () => (VIEW ? VIEW.data : DATA);

/* ============================================================ path / diff
   Arrays of objects are addressed by their id/code/key, so a change recorded
   as ["destinations","HND","rates","hnd7","value"] still lands on the right
   item if another editor reordered or added items. */
const keyOf = it => (it && typeof it === "object" && !Array.isArray(it)) ? (it.id ?? it.code ?? it.key ?? null) : null;
function step(cur, seg) {
  if (cur == null) return undefined;
  if (Array.isArray(cur)) return typeof seg === "number" ? cur[seg] : cur.find(x => keyOf(x) === seg);
  return cur[seg];
}
function getPath(obj, path) { return path.reduce(step, obj); }
function setPath(obj, path, val) {
  const parent = getPath(obj, path.slice(0, -1));
  if (parent == null) throw new Error("Path not found: " + path.join(" › "));
  const last = path[path.length - 1];
  if (val === undefined) { delete parent[last]; return; }
  parent[last] = val;
}
function keyedArray(a) { return a.length > 0 && a.every(x => keyOf(x) != null); }
function diff(a, b, path = [], out = []) {
  if (a === b) return out;
  const oa = a && typeof a === "object", ob = b && typeof b === "object";
  if (oa && ob && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) {
      if (keyedArray(a) && keyedArray(b)) {
        const ids = [...new Set([...a.map(keyOf), ...b.map(keyOf)])];
        for (const id of ids) {
          const x = a.find(i => keyOf(i) === id), y = b.find(i => keyOf(i) === id);
          if (x && y) diff(x, y, [...path, id], out);
          else out.push({ path: path, from: clone(a), to: clone(b) }); // structural: record whole array
        }
        return dedupe(out);
      }
      if (a.length !== b.length) { out.push({ path, from: clone(a), to: clone(b) }); return out; }
      a.forEach((x, i) => diff(x, b[i], [...path, i], out));
      return out;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], [...path, k], out);
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, from: a === undefined ? undefined : clone(a), to: b === undefined ? undefined : clone(b) });
  return out;
}
function dedupe(out) {
  const seen = new Set();
  return out.filter(c => { const k = JSON.stringify(c.path); if (seen.has(k)) return false; seen.add(k); return true; })
    .filter((c, _, all) => !all.some(o => o !== c && o.path.length < c.path.length && JSON.stringify(c.path.slice(0, o.path.length)) === JSON.stringify(o.path)));
}
function applyChanges(obj, changes, reverse = false) {
  const list = reverse ? [...changes].reverse() : changes;
  for (const c of list) { const v = reverse ? c.from : c.to; setPath(obj, c.path, v == null ? undefined : clone(v)); }   // null / undefined = field absent
  return obj;
}
// Human label for a change path, resolved against a snapshot.
function describe(snap, path) {
  const parts = []; let cur = snap;
  const LBL = { value: "", rates: "Rate", fx: "FX", tables: "Table", packages: "", variants: "TO", pricing: "", rules: "Rule",
    adult: "Adult catalog", cwb: "CWB catalog", cnb: "CNB catalog", infant: "Infant price", discountTier2: "Discount tier 2",
    tierUpgrade: "Tier upgrade", cwbCost: "CWB cost", cnbCost: "CNB cost", infantCost: "Infant cost", type: "type",
    components: "Component", expr: "formula", values: "", settings: "Settings", marginWarnPct: "Margin warn %", marginDangerPct: "Margin danger %", sellingDiscount: "Selling discount (RM)",
    destinations: "", nights: "Nights", po: "PO", assign: "TO assignment", contracts: "TO Contract Rate" };
  for (let i = 0; i < path.length; i++) {
    const seg = path[i], prev = path[i - 1];
    cur = step(cur, seg);
    if (prev === "destinations") parts.push(cur?.name ?? seg);
    else if (["rates", "fx", "tables", "packages", "variants", "components"].includes(prev)) parts.push((LBL[prev] ? LBL[prev] + " " : "") + (cur?.label ?? seg));
    else if (["adult", "cwb", "cnb"].includes(prev) || prev === "values") parts.push("@" + seg + " pax");
    else if (LBL[seg] !== undefined) { if (LBL[seg]) parts.push(LBL[seg]); }
    else parts.push(String(seg));
  }
  return parts.join(" › ");
}
const showVal = v => v === undefined ? "∅" : (typeof v === "object" ? "[list]" : (typeof v === "number" ? n2(v, 4) : String(v)));

/* ============================================================ engine */
const exprCache = new Map();
const EXPR_OK = /^[\w\s.+\-*/(),\[\]'"<>=?:!&|%]*$/;
function compile(expr) {
  if (exprCache.has(expr)) return exprCache.get(expr);
  if (!EXPR_OK.test(expr) || /\b(window|document|globalThis|Function|constructor|prototype|fetch|import|eval)\b/.test(expr))
    throw new Error("Formula has characters or words that are not allowed: " + expr);
  const f = new Function("R", "T", "N", "O", "pax", "band", "min", "max", "ceil", "floor", "round", '"use strict";return (' + expr + ");");
  exprCache.set(expr, f); return f;
}
function band(pax, ...pairs) { for (const [mx, v] of pairs) if (pax <= mx) return v; return NaN; }
const fxOf = (d, id) => { const f = d.fx.find(x => x.id === id); return f ? +f.value : NaN; };
function rateProxy(d) {
  const o = {}; for (const r of d.rates) o[r.id] = (+r.value) * fxOf(d, r.fx);
  return new Proxy(o, { get: (t, k) => (k in t ? t[k] : NaN) });
}
function tableProxy(d, pax) {
  const o = {}; for (const t of d.tables) { const v = t.values[String(pax)]; o[t.id] = (v === undefined || v === null || v === "") ? NaN : (+v) * fxOf(d, t.fx); }
  return new Proxy(o, { get: (t, k) => (k in t ? t[k] : NaN) });
}
// Destination options (Krabi: hotel, season): the selected choice ids, defaulting to the first.
function optsFor(d, given) {
  const sel = given || SEL.opt[d.code] || {}, o = {};
  for (const op of d.options || []) o[op.id] = op.choices.some(c => c.id === sel[op.id]) ? sel[op.id] : op.choices[0].id;
  return o;
}
// Catalog upgrade from the selected choices (Krabi: 4★ hotel +RM250, Honeymoon +RM298 …)
function optionUpgrade(d, pkg, O) {
  let up = 0;
  for (const op of d.options || []) { const c = op.choices.find(x => x.id === O[op.id]); if (c && c.upgrade) up += +(c.upgrade[pkg.id] || 0); }
  return up;
}
function variantCost(d, v, pax, opts) {
  if (!v || pax < v.paxMin || pax > v.paxMax) return null;
  const R = rateProxy(d), T = tableProxy(d, pax), N = +d.nights, O = optsFor(d, opts);
  const comps = v.components.map(c => {
    let val, err = null;
    try { val = +compile(c.expr)(R, T, N, O, pax, band, Math.min, Math.max, Math.ceil, Math.floor, Math.round); }
    catch (e) { val = NaN; err = e.message; }
    const group = c.per === "group" ? val : val * pax;
    return { ...c, group, perPax: group / pax, err };
  });
  const total = comps.reduce((s, c) => s + c.perPax, 0);
  return { comps, total: num(total) ? total : NaN, ok: comps.every(c => num(c.perPax)) };
}
const assignedVariantId = (pkg, pax) => (pkg.assign.find(a => pax >= a.from && pax <= a.to) || {}).variant;
// rule.on = component keys the % applies to; the other components are charged in full
// (Aceh, Beijing: CWB = 75% × Ground + tipping/activities).
function applyRule(rule, base, cost) {
  if (rule && rule.type === "pct" && rule.on && rule.on.length) {
    if (!cost || !num(base)) return NaN;
    const on = cost.comps.filter(c => rule.on.includes(c.key)).reduce((s, c) => s + c.perPax, 0);
    return base - on + on * +rule.value;
  }
  if (!rule || !num(base)) return NaN;
  const v = +rule.value;
  return rule.type === "pct" ? base * v : rule.type === "minus" ? base - v : v;
}
const priceAt = (pkg, k, pax) => { const v = pkg.pricing[k]?.[String(pax)]; return v === undefined || v === null || v === "" ? NaN : +v; };
// One row of the R&D Costing tab: cost / catalog / selling / margin for each pax type.
const sellDisc = () => { const v = (shown().settings || {}).sellingDiscount; return v === undefined || v === null || v === "" ? 200 : +v; };
function priceRow(d, pkg, variantId, pax, opts) {
  const v = d.variants.find(x => x.id === variantId);
  const O = optsFor(d, opts);
  const cost = variantCost(d, v, pax, O);
  const adultCost = cost ? cost.total : NaN, r = pkg.rules;
  // Selling = Catalog Price (+ tier / option upgrade) − RM200 for every package (settings.sellingDiscount);
  // the infant flat price has no upgrade and no discount. The R&D's own rules.discountTier2 is not used.
  const up = (+r.tierUpgrade || 0) + optionUpgrade(d, pkg, O), disc = sellDisc();
  const mk = (costV, catV, infant) => {
    const catalog = num(catV) ? catV + (infant ? 0 : up) : NaN;
    const selling = num(catalog) ? catalog - (infant ? 0 : disc) : NaN;
    const margin = selling - costV;
    return { cost: costV, catalog, selling, margin: num(margin) ? margin : NaN, pct: num(margin) && selling ? margin / selling : NaN };
  };
  return {
    pax, variant: v, cost,
    adult: mk(adultCost, priceAt(pkg, "adult", pax)),
    cwb: mk(applyRule(r.cwbCost, adultCost, cost), priceAt(pkg, "cwb", pax)),
    cnb: mk(applyRule(r.cnbCost, adultCost, cost), priceAt(pkg, "cnb", pax)),
    infant: mk(applyRule(r.infantCost, adultCost, cost), +pkg.pricing.infant, true),
  };
}
// Margin colour: green when positive, red when negative.
function marginClass(p) {
  if (!num(p) || Math.abs(p) < 1e-9) return "";
  return p > 0 ? "m-ok" : "m-bad";
}
function marginPill(p) {
  const c = marginClass(p); if (!num(p)) return '<span class="pill grey">—</span>';
  return `<span class="pill ${c === "m-ok" ? "ok" : c === "m-bad" ? "bad" : "grey"}">${pct(p)}</span>`;
}

/* ============================================================ selection helpers */
const curDest = () => shown().destinations.find(d => d.code === SEL.dest) || shown().destinations[0];
const curPkg = d => d.packages.find(p => p.id === SEL.pkg) || d.packages[0];
const bandPax = () => SEL.pax;   // the highlighted row on the Costing tab
const activeVariantId = (pkg, pax) => SEL.variant === "auto" ? assignedVariantId(pkg, pax) : SEL.variant;

/* ============================================================ editable cell */
function ed(path, value, opts = {}) {
  if (!EDIT || VIEW) return opts.display ?? esc(showVal(value));
  const p = esc(JSON.stringify(path));
  const changed = BASE && JSON.stringify(getPath(BASE, path)) !== JSON.stringify(value) ? " chg" : "";
  const title = changed ? ` title="was ${esc(showVal(getPath(BASE, path)))}"` : "";
  if (opts.options) {
    return `<select class="ed${changed}" data-path="${p}"${title}>${opts.options.map(o => `<option value="${esc(o[0])}"${o[0] === value ? " selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
  }
  const t = opts.text ? "text" : "number";
  return `<input class="ed${opts.text ? " txt" : ""}${changed}" type="${t}" ${t === "number" ? 'step="any"' : ""} data-path="${p}" data-kind="${opts.text ? "text" : "num"}" value="${esc(value ?? "")}"${title}>`;
}

/* ============================================================ render */
function render() {
  if (!DATA) return;
  renderTop(); renderBanners();
  if (PAGE_VIEW === "flags") return renderFlagsPage();
  if (!PAGE_DEST) return renderHub();
  const d = shown().destinations.find(x => x.code === PAGE_DEST);
  if (!d) {
    $("#controls").style.display = "none"; $("#kpis").innerHTML = "";
    $("#grid").innerHTML = `<div class="card full"><div class="empty">No destination with code <b>${esc(PAGE_DEST)}</b>${VIEW ? " in v" + VIEW.v : ""}. <a href="${ROOT}">See all destinations</a></div></div>`;
    return;
  }
  SEL.dest = d.code;
  const pkg = curPkg(d); SEL.pkg = pkg.id;
  if (!TABS.some(t => t[0] === SEL.tab)) SEL.tab = "costing";
  renderControls(d, pkg); renderMain(d, pkg);
}
// Hub: one row per package — name (links to its page), PO, last update.
// Last update = newest saved change to that package or to its destination's shared costs
// (rates, FX, TOs, add-ons); before any save it is the import date.
function lastUpdate(d, pkgId) {
  const hit = c => c.path[1] === d.code && (pkgId == null || c.path[2] !== "packages" || c.path[3] === pkgId);
  const reimport = e => e.rebase && new RegExp("(added|rebuilt): [^)]*\\b" + d.code + "\\b").test(e.note || "");
  const es = HISTORY.entries.filter(e => (e.changes || []).some(hit) || reimport(e)).sort((a, b) => b.v - a.v);
  return es[0] || [...HISTORY.entries].sort((a, b) => a.v - b.v)[0] || null;
}
function filterHub() {
  const q = (SEL.hubQ || "").trim().toLowerCase();
  for (const tr of document.querySelectorAll(".hub tbody tr")) tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? "" : "none";
}
// Best package on the destination page for a catalog name, by tier / duration words.
const TIER = { BSC: "BASIC", BASIC: "BASIC", BUDGET: "BASIC", STD: "STANDARD", STANDARD: "STANDARD", CLASSIC: "STANDARD", HNY: "HONEYMOON", HONEYMOON: "HONEYMOON", PREM: "PREMIUM", PREMIUM: "PREMIUM", ST: "SELF", SELF: "SELF", COMBO: "COMBO", WATER: "WATER" };
function words(t) {
  const w = new Set();
  for (const x of String(t).toUpperCase().split(/[^A-Z0-9★]+/)) { if (TIER[x]) w.add(TIER[x]); if (/^\d+D\d+N$/.test(x)) w.add(x); }
  return w;
}
function matchPkg(d, name) {
  if (d.packages.length === 1) return d.packages[0];
  const cw = words(name); let best = null, score = 0, tie = false;
  for (const p of d.packages) {
    const pw = words(p.label + " " + p.id); let sc = 0;
    for (const x of cw) if (pw.has(x)) sc++;
    if (sc > score) { best = p; score = sc; tie = false; } else if (sc === score && sc > 0) tie = true;
  }
  return score && !tie ? best : null;
}
// Hub: one row per catalog package (Project PT sheet) — package name, PO, last update.
function renderHub() {
  $("#controls").style.display = "none"; $("#kpis").innerHTML = "";
  const fmt = e => e ? esc(new Date(e.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })) + (e.changes && e.changes.length ? ` <span class="muted small">v${e.v} · ${esc(e.by)}</span>` : "") : "—";
  const rows = shown().destinations.flatMap(d => (d.catalogs && d.catalogs.length ? d.catalogs : d.packages.map(p => p.label)).map(name => {
    const pkg = matchPkg(d, name), href = `${ROOT}${d.code.toLowerCase()}/${pkg ? "?pkg=" + encodeURIComponent(pkg.id) : ""}`;
    return `<tr class="click" data-href="${href}"><td><a href="${href}">${esc(name)}</a> <span class="pill nav">${esc(d.code)}</span></td><td class="l">${esc(d.po || "—")}</td><td class="l">${fmt(lastUpdate(d, pkg ? pkg.id : null))}</td></tr>`;
  })).join("");
  $("#grid").innerHTML = `<div class="card full hub"><div class="body"><input id="hubSearch" type="search" placeholder="Search package, code or PO…" value="${esc(SEL.hubQ || "")}" autocomplete="off"></div>
    <div class="scroll"><table><thead><tr><th>Package</th><th class="l">PO</th><th class="l">Last update</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  filterHub();
}
function renderTop() {
  const src = shown();
  const nHigh = FLAGS.flags.filter(f => f.severity === "high").length;
  if (!$("#flagsLink")) $("#btnHistory").insertAdjacentHTML("beforebegin", `<a class="btn" id="flagsLink" href="${ROOT}flags/">Flags</a>`);
  $("#flagsLink").innerHTML = `Flags${FLAGS.flags.length ? ` <span class="pill bad">${nHigh}</span>` : ""}`;
  $("#verChip").innerHTML = VIEW ? `Viewing v${VIEW.v}` : `v${src.version} · ${esc(fmtDate(src.updatedAt))} · ${esc(src.updatedBy)}`;
  const n = pendingChanges().length;
  $("#authArea").innerHTML = SESSION
    ? `<span class="chip">● ${esc(SESSION.u)} (${esc(SESSION.role)})</span>
       <button class="btn" id="btnEdit">${EDIT ? "Stop editing" : "Edit costs"}</button>
       ${n ? `<button class="btn save" id="btnSave">Save v${BASE.version + 1} (${n})</button>` : ""}
       <button class="btn" id="btnAcct">Account</button>
       <button class="btn" id="btnLogout">Log out</button>`
    : `<button class="btn" id="btnLogin">Log in to edit</button>`;
}
function renderBanners() {
  const out = [];
  if (VIEW) out.push(`<div class="banner old"><b>Read-only: version ${VIEW.v}</b><span class="small">Rebuilt from the change log. Current is v${DATA.version}.</span>
    <span style="margin-left:auto;display:flex;gap:6px"><button class="btn" data-act="viewCurrent">Back to current</button>
    ${SESSION ? `<button class="btn primary" data-act="restore">Restore as v${DATA.version + 1}…</button>` : ""}</span></div>`);
  if (EDIT && !VIEW) {
    const n = pendingChanges().length;
    out.push(`<div class="banner edit"><b>Editing</b><span class="small">Yellow cells are editable. Changed cells turn orange. Nothing is saved until you press Save.</span>
      <span style="margin-left:auto;display:flex;gap:6px">${n ? `<button class="btn" data-act="review">Review ${n} change${n > 1 ? "s" : ""}</button><button class="btn danger" data-act="discard">Discard</button>` : ""}</span></div>`);
  }
  if (window.__loadError) out.push(`<div class="banner err">${esc(window.__loadError)}</div>`);
  $("#banners").innerHTML = out.join("");
}
// FX chips: the rates the R&D used, read-only (change them in the R&D sheet, then re-import).
function fxChips(d) {
  const fx = (d.fx || []).filter(f => f.id !== "MYR");
  if (!fx.length) return `<span class="fx"><span class="lock">🔒</span> MYR direct</span>`;
  return fx.map(f => `<span class="fx" title="Locked — from ${esc(f.source || "the R&D sheet")}. Change FX in the R&D sheet, then re-import."><span class="lock">🔒</span> ${esc(f.label.replace(" → MYR", ""))} <b>${esc(String(+f.value))}</b></span>`).join("");
}
const flagsFor = code => FLAGS.flags.filter(f => f.code === code || (f.code === "ALL" && new RegExp("\\b" + code + "\\b").test(f.detail)));
// TOs offered for a package: the ones its pax bands assign, plus its extra choices (Krabi Day-3 options).
const pkgVariants = (d, pkg) => { const ids = new Set([...pkg.assign.map(a => a.variant), ...(pkg.alsoVariants || [])]); return d.variants.filter(v => ids.has(v.id)); };
function renderControls(d, pkg) {
  $("#controls").style.display = "";
  const pax = bandPax(), autoId = assignedVariantId(pkg, pax);
  const e = lastUpdate(d, pkg.id);
  const fl = flagsFor(d.code), nh = fl.filter(f => f.severity === "high").length;
  $("#controls").innerHTML = `
    <div class="dest-top">
      <div class="dest-head"><a href="${ROOT}">← All packages</a><h1>${esc(d.name)} <span class="pill nav">${esc(d.code)}</span></h1>
        <span class="muted small">PO ${ed(["destinations", d.code, "po"], d.po || "", { text: true, display: "<b>" + esc(d.po || "—") + "</b>" })}${e ? ` · updated ${esc(new Date(e.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}${e.v > 1 ? " by " + esc(e.by) : ""}` : ""}</span></div>
      <div class="fxbox">${fxChips(d)}</div>
    </div>
    <div class="sel-row">
      <label>Package<select id="selPkg">${d.packages.map(p => `<option value="${p.id}"${p.id === pkg.id ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
      ${(d.options || []).map(op => { const O = optsFor(d), c = op.choices.find(x => x.id === O[op.id]), up = c && c.upgrade ? +(c.upgrade[pkg.id] || 0) : 0;
        return `<label>${esc(op.label)}${up ? ` <span class="pill warn">catalog +RM${up}</span>` : ""}<select id="opt_${esc(op.id)}">${op.choices.map(ch => `<option value="${esc(ch.id)}"${ch.id === O[op.id] ? " selected" : ""}>${esc(ch.label)}</option>`).join("")}</select></label>`; }).join("")}
      <label>Tour operator<select id="selVar">
        <option value="auto"${SEL.variant === "auto" ? " selected" : ""}>Auto${autoId ? ": " + esc((d.variants.find(v => v.id === autoId) || {}).label || autoId) + " (" + pax + " pax)" : " by pax"}</option>
        ${pkgVariants(d, pkg).map(v => `<option value="${v.id}"${SEL.variant === v.id ? " selected" : ""}>${esc(v.label)} (${v.paxMin}–${v.paxMax} pax)</option>`).join("")}
      </select></label>
    </div>
    <nav class="tabsbar">${TABS.map(([id, l]) => `<button class="tabm${SEL.tab === id ? " on" : ""}" data-tabmain="${id}">${l}${id === "flags" && fl.length ? ` <span class="pill ${nh ? "bad" : "warn"}">${fl.length}</span>` : ""}</button>`).join("")}</nav>`;
}
function renderMain(d, pkg) {
  const pax = bandPax();
  $("#kpis").innerHTML = "";
  const T = SEL.tab;
  if (T === "costing") $("#grid").innerHTML = costingSummary(d, pkg) + costingByPax(d, pkg, pax);
  else if (T === "contracts") $("#grid").innerHTML = contractCard(d);
  else if (T === "addons") $("#grid").innerHTML = addonCard(d) || `<div class="card full"><div class="empty">No add-ons in the R&D for ${esc(d.name)}.</div></div>`;
  else if (T === "flags") $("#grid").innerHTML = flagList(flagsFor(d.code), false);
  else if (T === "history") {
    const es = [...HISTORY.entries].filter(touchesDest).sort((a, b) => b.v - a.v);
    $("#grid").innerHTML = `<div class="card full"><h2>History · ${esc(d.name)} <span class="sub">${es.length} version${es.length === 1 ? "" : "s"}</span></h2><div class="hist">${es.map(histEntry).join("") || '<div class="empty">No changes yet.</div>'}</div></div>`;
  }
}
// One line above the costing table: what a PO checks first.
function costingSummary(d, pkg) {
  const rows = Object.keys(pkg.pricing.adult).map(Number).sort((a, b) => a - b).map(p => ({ p, r: priceRow(d, pkg, activeVariantId(pkg, p), p).adult }));
  const ok = rows.filter(x => num(x.r.pct));
  if (!ok.length) return "";
  const lo = ok.reduce((a, b) => (b.r.pct < a.r.pct ? b : a)), hi = ok.reduce((a, b) => (b.r.pct > a.r.pct ? b : a));
  return `<div class="summary">
    <div><span class="l">Margin range</span><b><span class="${marginClass(lo.r.pct)}">${pct(lo.r.pct)}</span> – <span class="${marginClass(hi.r.pct)}">${pct(hi.r.pct)}</span></b></div>
    <div><span class="l">Lowest margin</span><b class="${marginClass(lo.r.pct)}">${rm(lo.r.margin)} at ${lo.p} pax</b></div>
  </div>`;
}
// Flags: cross-check of catalog, R&D sheet and calculator (tools/crosscheck.py → data/flags.json)
const SEV = { high: "High", medium: "Medium", low: "Low" };
function flagList(list, withDest) {
  if (!list.length) return `<div class="card full"><div class="empty">No flags.</div></div>`;
  const byName = c => (DATA.destinations.find(d => d.code === c) || {}).name || (c === "ALL" ? "All destinations" : c);
  return `<div class="card full flags"><div class="scroll"><table><thead><tr><th class="l">Severity</th>${withDest ? '<th class="l">Destination</th>' : ""}<th class="l">Area</th><th class="l">Issue</th><th class="l">Suggested fix</th></tr></thead><tbody>
    ${list.map(f => `<tr class="sev-${f.severity}"><td class="l"><span class="pill ${f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "grey"}">${SEV[f.severity]}</span></td>
      ${withDest ? `<td class="l">${f.code === "ALL" || !DATA.destinations.some(d => d.code === f.code) ? esc(byName(f.code)) : `<a href="${ROOT}${f.code.toLowerCase()}/#flags">${esc(byName(f.code))}</a>`} <span class="pill nav">${esc(f.code)}</span></td>` : ""}
      <td class="l muted">${esc(f.area)}</td><td class="l wrap"><b>${esc(f.title)}</b><div class="small muted">${esc(f.detail)}</div></td><td class="l wrap small">${esc(f.fix)}</td></tr>`).join("")}
  </tbody></table></div></div>`;
}
function renderFlagsPage() {
  $("#controls").style.display = "none"; $("#kpis").innerHTML = "";
  const po = c => (DATA.destinations.find(d => d.code === c) || {}).po || "";
  const areas = [...new Set(FLAGS.flags.map(f => f.area))].sort(), pos = [...new Set(DATA.destinations.map(d => d.po).filter(Boolean))].sort();
  const q = SEL.flagQ.trim().toLowerCase();
  const list = FLAGS.flags.filter(f => SEL.flagSev[f.severity] && (!SEL.flagArea || f.area === SEL.flagArea) && (!SEL.flagPO || po(f.code) === SEL.flagPO || f.code === "ALL")
    && (!q || (f.code + " " + f.title + " " + f.detail).toLowerCase().includes(q)));
  const cnt = s => FLAGS.flags.filter(f => f.severity === s).length;
  $("#grid").innerHTML = `<div class="card full"><div class="body flagbar">
      <a href="${ROOT}">← All packages</a><h1>Flags <span class="sub muted small">catalog × R&amp;D × calculator · checked ${esc(fmtDate(FLAGS.generatedAt))} (data v${FLAGS.dataVersion || "?"})</span></h1>
      <div class="filters">${["high", "medium", "low"].map(s => `<button class="tab${SEL.flagSev[s] ? " on" : ""}" data-sev="${s}">${SEV[s]} ${cnt(s)}</button>`).join("")}
        <select id="flagArea"><option value="">All areas</option>${areas.map(a => `<option${a === SEL.flagArea ? " selected" : ""}>${esc(a)}</option>`).join("")}</select>
        <select id="flagPO"><option value="">All POs</option>${pos.map(p => `<option${p === SEL.flagPO ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
        <input id="flagQ" type="search" placeholder="Search…" value="${esc(SEL.flagQ)}"></div>
      <div class="small muted">${list.length} shown. High = a price or cost is wrong or missing · Medium = needs a decision or the R&D and catalog disagree on coverage · Low = housekeeping.</div></div></div>` + flagList(list, true);
}
const onLabel = (d, keys) => keys.map(k => { for (const v of d.variants) { const c = v.components.find(x => x.key === k); if (c) return c.label; } return k; }).join(" + ");
// Component columns for a package: union of components across the TOs it uses, in order.
function pkgComponents(d, pkg) {
  const ids = [...new Set([...pkg.assign.map(a => a.variant), ...(SEL.variant !== "auto" ? [SEL.variant] : [])])];
  const out = [];
  for (const id of ids) { const v = d.variants.find(x => x.id === id); if (v) for (const c of v.components) if (!out.some(o => o.key === c.key)) out.push({ key: c.key, label: c.label }); }
  return out;
}
// Same layout as the R&D sheet: one block per TO (title + header), component columns are
// GROUP totals in RM, then Cost/Pax = sum ÷ pax, Selling, Margin RM / %, Total Gross = margin × pax.
// "Selling (Catalog − RM200)" — selling is the catalog price minus the R&D tier-2 discount
const sellLabel = () => "Selling Price";
// "Show calculation": a rate-built component's formula at this pax with the actual rates, e.g.
// 2*R.hndQ at Qayyum FX → "¥22,000 × 2 × 0.026". band(pax, …) is resolved to the band used at this pax.
// Table-based components (T[…]) and plain RM lines get none.
const CUR = { JPY: "¥", KRW: "₩", USD: "US$", EUR: "€" };
function calcText(d, expr, pax) {
  if (!/\bR\.\w/.test(expr) || /\bT\[/.test(expr)) return "";
  const R = Object.fromEntries(d.rates.map(r => [r.id, r]));
  const fxOf = r => r.fx === "MYR" ? null : d.fx.find(x => x.id === r.fx);
  const cur = r => { const f = fxOf(r); if (!f) return "RM"; const m = /\b(JPY|KRW|USD|EUR|THB|IDR|AUD|NZD|CNY|RMB|VND|TRY|CHF|SGD)\b/.exec(f.label); return m ? (CUR[m[1]] || m[1] + " ") : ""; };
  let e = expr.replace(/band\(pax,((?:\[[^\]]+\],?)+)\)/g, (_, pairs) => {
    for (const m of pairs.matchAll(/\[(\d+),([^\]]+)\]/g)) if (pax <= +m[1]) return /[+*]/.test(m[2]) ? `(${m[2]})` : m[2];
    return "NaN";
  });
  const ids = [...new Set([...e.matchAll(/R\.(\w+)/g)].map(m => m[1]))].filter(id => R[id]);
  const fxs = [...new Set(ids.map(id => (fxOf(R[id]) || { id: "MYR" }).id))];
  const one = fxs.length === 1 ? fxOf(R[ids[0]]) : null;   // one foreign FX → multiply once at the end
  const fmt = v => (+v).toLocaleString("en-MY", { maximumFractionDigits: 6 });
  e = e.replace(/R\.(\w+)/g, (m, id) => { const r = R[id]; if (!r) return m; const f = fxOf(r), t = cur(r) + fmt(r.value);
      return f && !one && fxs.length > 1 ? `{${t}*${fmt(f.value)}}` : t; })
    .replace(/\bN\b/g, fmt(+d.nights)).replace(/\bpax\b/g, `${pax} pax`)
    .replace(/\*/g, " × ").replace(/\+/g, " + ").replace(/\s+/g, " ").trim()
    .replace(/^(\d+) × (.+)$/, "$2 × $1").replace(/\{([^}]+)\}/g, "($1)");
  if (one) e = (/ \+ /.test(e.replace(/\([^()]*\)/g, "")) ? `(${e})` : e) + ` × ${fmt(one.value)}`;
  return e;
}
const hasCalc = (d, pkg) => pkg.assign.some(a => { const v = d.variants.find(x => x.id === a.variant); return v && v.components.some(c => calcText(d, c.expr, 2)); });
function costingByPax(d, pkg, pax) {
  const k = SEL.paxTab, DP = ["destinations", d.code];
  const paxList = Object.keys(pkg.pricing.adult).map(Number).sort((a, b) => a - b);
  const int = v => num(v) ? Math.round(v).toLocaleString("en-MY") : '<span class="missing">—</span>';
  const ruleTxt = rule => rule.type === "pct" ? `${n2(rule.value * 100, 1)}% of ${rule.on && rule.on.length ? esc(onLabel(d, rule.on)) + " + rest in full" : "adult cost"}` : rule.type === "minus" ? `adult cost − RM${n2(rule.value)}` : `flat RM${n2(rule.value)}`;
  const isAdult = k === "adult", canCalc = isAdult && hasCalc(d, pkg), calc = canCalc && SEL.showCalc;
  const up = (+pkg.rules.tierUpgrade || 0) + optionUpgrade(d, pkg, optsFor(d));
  // consecutive pax rows with the same TO form one block
  const blocks = [];
  for (const p of paxList) {
    const pr = priceRow(d, pkg, activeVariantId(pkg, p), p), id = pr.variant ? pr.variant.id : "—";
    if (!blocks.length || blocks[blocks.length - 1].id !== id) blocks.push({ id, v: pr.variant, rows: [] });
    blocks[blocks.length - 1].rows.push(pr);
  }
  // a component that is RM0 (or missing) at every pax gets no column, e.g. no tipping
  const nz = v => num(v) && Math.round(v) !== 0;
  const nonZero = pkgComponents(d, pkg).filter(c => blocks.some(bl => bl.rows.some(pr => pr.cost && pr.cost.comps.some(o => o.key === c.key && nz(o.group)))));
  // a single cost line (e.g. Seoul: the TO contract rate) is Cost/Pax itself — no breakdown column
  const comps = nonZero.length === 1 ? [] : nonZero;
  const nCols = isAdult ? 1 + comps.length + 7 : 1 + 1 + 6;
  const body = blocks.map(bl => {
    const has = new Set(bl.v ? bl.v.components.map(c => c.key) : []);
    const toLbl = bl.v ? bl.v.label : "no TO";
    const title = `<tr class="blk-title"><td colspan="${nCols}">${esc(pkg.label.toUpperCase())}${toLbl.toUpperCase() === pkg.label.toUpperCase() ? "" : " / " + esc(toLbl)}${isAdult ? "" : ` <span class="muted">· ${k.toUpperCase()} cost = ${esc(ruleTxt(pkg.rules[k + "Cost"]))}</span>`}</td></tr>`;
    const head = `<tr class="blk-head"><th>${isAdult ? "Adult" : k.toUpperCase() + " · pax"}</th>${isAdult
      ? comps.map(c => { const vc = bl.v && bl.v.components.find(o => o.key === c.key); return `<th>${vc ? esc(vc.label) : ""}</th>`; }).join("")
      : `<th>Adult cost/pax</th>`}<th>Cost/Pax</th><th class="cp">Catalog Price</th><th class="sp">${esc(sellLabel(pkg))}</th><th class="mg">Margin</th><th class="mg">%</th>${isAdult ? `<th>Total Gross</th>` : ""}</tr>`;
    const rows = bl.rows.map((pr, i) => {
      const p = pr.pax, x = pr[k];
      const cells = isAdult
        ? comps.map(c => { if (!has.has(c.key)) return "<td></td>"; const cc = pr.cost && pr.cost.comps.find(o => o.key === c.key); if (cc && num(cc.group) && !nz(cc.group)) return "<td></td>";
          const vc = calc && bl.v.components.find(o => o.key === c.key), f = vc ? calcText(d, vc.expr, p) : "";
          return `<td title="RM${cc ? n2(cc.group, 2) : "—"} group · RM${cc ? n2(cc.perPax, 2) : "—"} per pax">${f ? `<span class="calc">${esc(f)} = ${int(cc && cc.group)}</span>` : int(cc && cc.group)}</td>`; }).join("")
        : `<td class="muted">${int(pr.adult.cost)}</td>`;
      return `<tr class="click${i % 2 ? " alt" : ""}${p === pax ? " cur" : ""}" data-pax="${p}"><td class="c"><b>${p}</b></td>${cells}
        <td><b>${int(x.cost)}</b></td>
        <td class="cp"${up ? ` title="Includes upgrade +RM${n2(up)}"` : ""}>${ed([...DP, "packages", pkg.id, "pricing", k, String(p)], pkg.pricing[k][String(p)], { display: int(x.catalog) + (up ? '<span class="muted small"> *</span>' : "") })}</td>
        <td class="sp"><b>${int(x.selling)}</b></td><td class="mg ${marginClass(x.pct)}"><b>${int(x.margin)}</b></td><td class="mg ${marginClass(x.pct)}">${num(x.pct) ? Math.round(x.pct * 100) + "%" : "—"}</td>
        ${isAdult ? `<td class="${marginClass(x.pct)}"><b>${int(x.margin * p)}</b></td>` : ""}</tr>`;
    }).join("");
    return title + head + rows;
  }).join("");
  return `<div class="card full" id="costPax"><h2>Costing by pax <span class="sub">${esc(pkg.label)} · RM</span>
    <span class="right tabs">${canCalc ? `<button class="tab calcbtn${calc ? " on" : ""}" data-calc="1" title="Show how each component is calculated from the TO rates">Show calculation</button>` : ""}${["adult", "cwb", "cnb"].map(t => `<button class="tab${t === k ? " on" : ""}" data-tab="${t}">${t.toUpperCase()}</button>`).join("")}</span></h2>
    <div class="scroll" style="max-height:640px;overflow-y:auto"><table class="rd">${body}</table></div>
    <div class="note">${isAdult ? "Component columns are for the whole group. Cost/Pax = sum of components ÷ pax. Margin = Selling − Cost/Pax. Total Gross = Margin × pax." : "Cost/Pax comes from the adult cost by the rule above. Margin = Selling − Cost/Pax."} Selling Price = Catalog Price − RM${n2(sellDisc())}.${up ? ` * Catalog includes the upgrade +RM${n2(up)}; when editing, the cell holds the base price.` : ""} ${canCalc ? (calc ? "Each component shows its rates × FX at that pax. " : "Show calculation shows each component as rates × FX. ") : ""}Hover a component for exact RM. Click a row to highlight it.</div></div>`;
}
function addonTotals(d) {
  let sell = 0, cost = 0, n = 0, missing = 0;
  for (const a of d.addons || []) {
    const q = +SEL.addonQty[a.id] || 0; if (!q) continue;
    n++; sell += q * (+a.selling || 0);
    if (num(a.cost)) cost += q * a.cost; else missing++;
  }
  return { sell, cost, n, missing };
}
function addonCard(d) {
  const list = d.addons || [], DP = ["destinations", d.code];
  if (!list.length) return "";
  const t = addonTotals(d), tm = t.sell - t.cost;
  const cats = [...new Set(list.map(a => a.category || "Other"))];
  const row = a => {
    const c = num(a.cost) ? a.cost : NaN, sv = num(a.selling) ? a.selling : NaN, m = sv - c, p = num(m) && sv ? m / Math.abs(sv) : NaN;
    const q = +SEL.addonQty[a.id] || 0;
    return `<tr${q ? ' class="cur"' : ""}><td style="white-space:normal;min-width:200px">${esc(a.label)}${a.notes ? `<div class="muted small">${esc(a.notes)}</div>` : ""}</td><td class="l muted small">${esc(a.per || "")}</td>
      <td>${ed([...DP, "addons", a.id, "cost"], a.cost, { display: num(a.cost) ? rm(a.cost, 2) : '<span class="pill bad" title="No cost in the R&D sheet">cost?</span>' })}</td>
      <td>${ed([...DP, "addons", a.id, "selling"], a.selling, { display: rm(sv, 2) })}</td>
      <td class="${marginClass(p)}">${rm(m, 2)}</td><td>${marginPill(p)}</td>
      <td><input type="number" min="0" max="999" class="aq" data-addon="${esc(a.id)}" value="${q || ""}" placeholder="0"></td></tr>`;
  };
  return `<div class="card full" id="addons"><h2>Add-ons <span class="sub">${list.length} items · enter a qty to total the selected add-ons (not saved)</span></h2>
    <div class="scroll" style="max-height:520px;overflow-y:auto"><table><thead><tr><th>Item</th><th class="l">Per</th><th>Cost</th><th>Selling</th><th>Margin</th><th>%</th><th>Qty</th></tr></thead><tbody>
    ${cats.map(cat => `<tr class="cat"><td colspan="7">${esc(cat)}</td></tr>` + list.filter(a => (a.category || "Other") === cat).map(row).join("")).join("")}
    ${t.n ? `<tr class="total"><td>Selected (${t.n})</td><td></td><td>${rm(t.cost, 2)}</td><td>${rm(t.sell, 2)}</td><td>${rm(tm, 2)}</td><td>${marginPill(t.sell ? tm / t.sell : NaN)}</td><td></td></tr>` : ""}
    </tbody></table></div></div>`;
}
// TO Contract Rate: the TO's contract / rate card files (PDF, Excel, image), kept in the repo
// under contracts/<code>/ and listed in the destination's `contracts`.
const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
function contractCard(d) {
  const list = [...(d.contracts || [])].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const canEdit = SESSION && !VIEW;
  const upload = canEdit ? `<div class="body upl">
      <label>File<input type="file" id="crFile" accept=".pdf,.xlsx,.xls,.csv,.doc,.docx,.jpg,.jpeg,.png"></label>
      <label>Tour operator<select id="crTo">${d.variants.map(v => `<option value="${esc(v.label)}">${esc(v.label)}</option>`).join("")}<option value="">Other / all</option></select></label>
      <label class="grow">Note<input type="text" id="crNote" placeholder="e.g. CTRANS rate card Jan–Dec 2027"></label>
      <button class="btn primary" id="doUpload">Upload</button></div>`
    : `<div class="body small muted">${VIEW ? "Viewing an old version." : `Log in to upload a contract rate file (max ${CONTRACT_MAX_MB} MB).`}</div>`;
  return `<div class="card full" id="contracts"><h2>TO Contract Rate <span class="sub">${esc(d.name)} · ${list.length} file${list.length === 1 ? "" : "s"}</span></h2>
    ${upload}
    ${list.length ? `<div class="scroll"><table class="zebra"><thead><tr><th class="l">File</th><th class="l">Tour operator</th><th class="l">Note</th><th>Size</th><th class="l">Uploaded</th>${canEdit ? "<th></th>" : ""}</tr></thead><tbody>
    ${list.map(c => `<tr><td class="l"><a href="${ROOT}${esc(c.file)}" target="_blank" rel="noopener">${esc(c.name)}</a></td><td class="l">${esc(c.to || "—")}</td><td class="l wrap">${esc(c.note || "")}</td><td>${fmtSize(c.size || 0)}</td>
      <td class="l">${esc(new Date(c.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))} <span class="muted small">${esc(c.by || "")}</span></td>
      ${canEdit ? `<td><button class="btn danger" data-delcr="${esc(c.id)}">Remove</button></td>` : ""}</tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">No contract rate file yet for ${esc(d.name)}.</div>`}
    <div class="note">Anyone with the page link can open these files. A new file shows on the live page in about a minute.</div></div>`;
}
// Add (file) or remove (removeId) a contract file: one commit with the file, data.json and history.json.
async function saveContract(code, { file, to, note, removeId }) {
  if (pendingChanges().length) throw new Error("Save or discard your cost edits first.");
  let blobSha = null, add = null;
  if (file) {
    const safe = file.name.replace(/[^\w.\-]+/g, "_") || "file";
    const id = Date.now().toString(36);
    add = { id, name: file.name, file: `contracts/${code.toLowerCase()}/${id}-${safe}`, to, note, size: file.size, at: new Date().toISOString(), by: SESSION.u };
    blobSha = await GH.blob(await file.arrayBuffer(), SESSION.token);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await GH.head(SESSION.token);
    const remote = await GH.readJson(PATHS.data, head, SESSION.token);
    const rhist = await GH.readJson(PATHS.history, head, SESSION.token);
    const dest = remote.destinations.find(x => x.code === code);
    const from = dest.contracts ? clone(dest.contracts) : undefined;
    const gone = removeId ? (dest.contracts || []).find(c => c.id === removeId) : null;
    if (removeId && !gone) throw new Error("That file was already removed — reload the page.");
    dest.contracts = removeId ? dest.contracts.filter(c => c.id !== removeId) : [...(dest.contracts || []), add];
    const next = { ...remote, version: remote.version + 1, updatedAt: new Date().toISOString(), updatedBy: SESSION.u };
    const what = gone ? `Removed ${gone.name}` : `Uploaded ${add.name}${to ? " (" + to + ")" : ""}`;
    rhist.entries.push({ v: next.version, at: next.updatedAt, by: SESSION.u, note: note || what, summary: [`${dest.name} › TO Contract Rate: ${what}`],
      changes: [{ path: ["destinations", code, "contracts"], from, to: clone(dest.contracts), label: `${dest.name} › TO Contract Rate` }] });
    try {
      await GH.commit([{ path: PATHS.data, content: pretty(next) }, { path: PATHS.history, content: pretty(rhist) },
        gone ? { path: gone.file, sha: null } : { path: add.file, sha: blobSha }],
        `v${next.version} · ${SESSION.u}: ${what}`.slice(0, 200), head, SESSION.token);
    } catch (e) {
      if (e.status === 422 || e.status === 409) continue;
      throw e;
    }
    BASE = next; DATA = clone(next); HISTORY = rhist;
    return next.version;
  }
  throw new Error("Could not save after 3 attempts — reload the page.");
}
const touchesDest = e => !PAGE_DEST || !(e.changes || []).length || e.changes.some(c => c.path[1] === PAGE_DEST);
function histEntry(e) {
  const src = DATA;
  if (PAGE_DEST && e.changes) e = { ...e, changes: e.changes.filter(c => c.path[1] === PAGE_DEST) };
  return `<div class="e"><div class="h"><span class="pill nav">v${e.v}</span><b>${esc(e.by)}</b><span class="muted small">${esc(fmtDate(e.at))}</span>
    <span class="small">${esc(e.note || "")}</span>
    <span style="margin-left:auto">${e.v === DATA.version ? '<span class="pill ok">current</span>' : e.v < lastRebase() ? '<span class="pill grey" title="Before a re-import from the R&D files; open the R&D workbook history instead">before re-import</span>' : `<button class="btn" data-view="${e.v}">View v${e.v}</button>`}</span></div>
    ${e.summary && e.summary.length ? `<ul>${e.summary.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : e.changes && e.changes.length ? `<ul>${e.changes.slice(0, 12).map(c => `<li>${esc(c.label || describe(src, c.path))}: <span class="from">${esc(showVal(c.from))}</span> → <span class="to">${esc(showVal(c.to))}</span></li>`).join("")}${e.changes.length > 12 ? `<li class="muted">+ ${e.changes.length - 12} more</li>` : ""}</ul>` : ""}</div>`;
}

/* ============================================================ versions */
// A re-import (history entry with rebase:true) replaces whole destinations, so versions
// before it cannot be rebuilt from the change log.
const lastRebase = () => Math.max(0, ...HISTORY.entries.filter(e => e.rebase).map(e => e.v));
function snapshotAt(v) {
  const snap = clone(DATA === BASE ? DATA : BASE);
  for (const e of [...HISTORY.entries].sort((a, b) => b.v - a.v)) {
    if (e.v <= v) break;
    applyChanges(snap, e.changes || [], true);
  }
  snap.version = v;
  const e = HISTORY.entries.find(x => x.v === v);
  if (e) { snap.updatedAt = e.at; snap.updatedBy = e.by; }
  return snap;
}
const pendingChanges = () => (BASE && DATA ? diff(stripMeta(BASE), stripMeta(DATA)) : []);
function stripMeta(o) { const c = { ...o }; delete c.version; delete c.updatedAt; delete c.updatedBy; return c; }

/* ============================================================ crypto (login)
   users.json holds, per user, a random vault key wrapped with a key derived
   from that user's password (PBKDF2 → AES-GCM). The vault key decrypts the
   GitHub token stored once in users.json. Wrong password = cannot unwrap =
   cannot save. */
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function b64big(buf) {   // b64() spreads the whole array into one call, too big for PDFs
  const u = new Uint8Array(buf); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
async function pwKey(pw, salt, iter) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function aesEnc(key, bytes) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes); return { iv: b64(iv), ct: b64(ct) }; }
async function aesDec(key, o) { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, key, unb64(o.ct))); }
async function wrapVault(vaultRaw, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await pwKey(pw, salt, KDF_ITER);
  return { salt: b64(salt), iter: KDF_ITER, ...(await aesEnc(k, vaultRaw)) };
}
async function unlock(user, pw) {
  const k = await pwKey(pw, unb64(user.salt), user.iter);
  const vaultRaw = await aesDec(k, user);           // throws on wrong password
  const vk = await crypto.subtle.importKey("raw", vaultRaw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const token = dec.decode(await aesDec(vk, USERS.vault));
  return { vaultRaw, token };
}
const userNameOk = u => /^[a-z0-9._-]{2,32}$/.test(u);
const passwordOk = p => p.length >= 10;

/* ============================================================ GitHub */
const GH = {
  api: "https://api.github.com",
  async req(method, path, body, token) {
    const r = await fetch(this.api + path, { method, headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) { }
    if (!r.ok) { const e = new Error((j && j.message) || ("GitHub " + r.status)); e.status = r.status; throw e; }
    return j;
  },
  repoPath() { return `/repos/${REPO.owner}/${REPO.name}`; },
  async head(token) { const ref = await this.req("GET", this.repoPath() + "/git/ref/heads/" + REPO.branch, null, token); return ref.object.sha; },
  async readJson(path, ref, token) {
    const j = await this.req("GET", this.repoPath() + "/contents/" + path + "?ref=" + ref, null, token);
    const bytes = unb64(j.content.replace(/\n/g, ""));
    return JSON.parse(dec.decode(bytes));
  },
  async blob(bytes, token) { return (await this.req("POST", this.repoPath() + "/git/blobs", { content: b64big(bytes), encoding: "base64" }, token)).sha; },
  // One commit that writes several files; fails (409/422) if someone pushed first.
  async commit(files, message, parentSha, token) {
    const parent = await this.req("GET", this.repoPath() + "/git/commits/" + parentSha, null, token);
    // a file is {path, content} (text), {path, sha} (uploaded blob) or {path, sha: null} (delete)
    const tree = await this.req("POST", this.repoPath() + "/git/trees", { base_tree: parent.tree.sha, tree: files.map(f => ({ path: f.path, mode: "100644", type: "blob", ...("sha" in f ? { sha: f.sha } : { content: f.content }) })) }, token);
    const c = await this.req("POST", this.repoPath() + "/git/commits", { message, tree: tree.sha, parents: [parentSha] }, token);
    await this.req("PATCH", this.repoPath() + "/git/refs/heads/" + REPO.branch, { sha: c.sha, force: false }, token);
    return c.sha;
  },
};
const pretty = o => JSON.stringify(o, null, 1) + "\n";

async function saveChanges(note) {
  const changes = pendingChanges();
  if (!changes.length) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await GH.head(SESSION.token);
    const remote = await GH.readJson(PATHS.data, head, SESSION.token);
    const rhist = await GH.readJson(PATHS.history, head, SESSION.token);
    if (remote.version !== BASE.version) {
      // someone saved in between: replay our edits on top if they touched different cells
      const clash = changes.filter(c => JSON.stringify(getPath(remote, c.path)) !== JSON.stringify(c.from));
      if (clash.length) throw new Error(`Another user saved v${remote.version} and changed the same cells (${clash.map(c => describe(remote, c.path)).slice(0, 3).join("; ")}). Reload and re-apply.`);
    }
    const next = applyChanges(clone(remote), changes);
    next.version = remote.version + 1;
    next.updatedAt = new Date().toISOString();
    next.updatedBy = SESSION.u;
    const entry = { v: next.version, at: next.updatedAt, by: SESSION.u, note, changes: changes.map(c => ({ ...c, label: describe(remote, c.path) })) };
    rhist.entries.push(entry);
    try {
      await GH.commit([{ path: PATHS.data, content: pretty(next) }, { path: PATHS.history, content: pretty(rhist) }],
        `v${next.version} · ${SESSION.u}: ${note}`.slice(0, 200), head, SESSION.token);
    } catch (e) {
      if (e.status === 422 || e.status === 409) continue; // lost the race → retry on new head
      throw e;
    }
    BASE = next; DATA = clone(next); HISTORY = rhist;
    return next.version;
  }
  throw new Error("Could not save after 3 attempts — reload the page.");
}
async function saveUsers(nextUsers, message) {
  const head = await GH.head(SESSION.token);
  await GH.commit([{ path: PATHS.users, content: pretty(nextUsers) }], message, head, SESSION.token);
  USERS = nextUsers;
}

/* ============================================================ load */
async function fetchJson(path) {
  const r = await fetch(ROOT + path + "?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(path + " → HTTP " + r.status);
  return r.json();
}
async function load() {
  try {
    const [d, h, u, fl] = await Promise.all([fetchJson(PATHS.data), fetchJson(PATHS.history).catch(() => ({ entries: [] })), fetchJson(PATHS.users).catch(() => ({ users: [] })), fetchJson(PATHS.flags).catch(() => ({ flags: [] }))]);
    DATA = d; BASE = clone(d); HISTORY = h; USERS = u; FLAGS = fl;
    if (!SEL.dest) { SEL.dest = DATA.destinations[0].code; }
    window.__loadError = null;
  } catch (e) {
    window.__loadError = "Could not load cost data: " + e.message + (location.protocol === "file:" ? " — open this page through a web server (GitHub Pages or `python3 -m http.server`), not as a file." : "");
    $("#banners").innerHTML = `<div class="banner err">${esc(window.__loadError)}</div>`;
    throw e;
  }
  render();
}

/* ============================================================ modals */
function modal(title, bodyHtml, buttons, wide) {
  $("#modalRoot").innerHTML = `<div class="modal-bg"><div class="modal${wide ? " wide" : ""}" role="dialog" aria-modal="true"><h3>${esc(title)}<button class="x" data-close aria-label="Close">×</button></h3>
    <div class="mb">${bodyHtml}</div>${buttons ? `<div class="mf">${buttons}</div>` : ""}</div></div>`;
  const first = $("#modalRoot input, #modalRoot textarea"); if (first) first.focus();
}
const closeModal = () => { $("#modalRoot").innerHTML = ""; };
const mErr = msg => { const e = $("#modalRoot .err-t"); if (e) e.textContent = msg; };

function openLogin() {
  if (!USERS.users || !USERS.users.length) return openSetup();
  modal("Log in to edit costs", `
    <label>Username<input id="lu" autocomplete="username"></label>
    <label>Password<input id="lp" type="password" autocomplete="current-password"></label>
    <div class="err-t"></div><div class="small muted">Accounts are created by an admin. Viewing needs no login.</div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="doLogin">Log in</button>`);
}
async function doLogin() {
  const u = $("#lu").value.trim().toLowerCase(), p = $("#lp").value;
  const rec = USERS.users.find(x => x.u === u);
  $("#doLogin").disabled = true; mErr("Checking…");
  try {
    if (!rec) throw new Error("bad");
    const { vaultRaw, token } = await unlock(rec, p);
    SESSION = { u, role: rec.role, token, vaultRaw };
    lastActivity = Date.now();
    closeModal(); render(); toast("Logged in as " + u);
    GH.head(token).catch(e => toast("Logged in, but GitHub rejected the token (" + e.message + "). Ask an admin to rotate it.", 6000));
  } catch (e) { mErr("Wrong username or password."); $("#doLogin").disabled = false; }
}
function openSetup() {
  modal("First-time setup (admin)", `
    <div class="small">No accounts exist yet. This creates the first <b>admin</b> account and stores the repo token encrypted under the account password. Paste the token yourself; it never leaves this browser unencrypted.</div>
    <label>Repository<input id="sRepo" value="${esc(REPO.owner + "/" + REPO.name)}" disabled></label>
    <label>GitHub fine-grained token (Contents: read &amp; write on this repo only)<input id="sTok" type="password" autocomplete="off"></label>
    <label>Admin username<input id="sU" placeholder="e.g. ezie"></label>
    <label>Password (min 10 characters)<input id="sP" type="password" autocomplete="new-password"></label>
    <label>Repeat password<input id="sP2" type="password" autocomplete="new-password"></label><div class="err-t"></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="doSetup">Create admin</button>`);
}
async function doSetup() {
  const tok = $("#sTok").value.trim(), u = $("#sU").value.trim().toLowerCase(), p = $("#sP").value;
  if (!userNameOk(u)) return mErr("Username: 2–32 chars, lowercase letters, digits, . _ -");
  if (!passwordOk(p)) return mErr("Password must be at least 10 characters.");
  if (p !== $("#sP2").value) return mErr("Passwords do not match.");
  mErr("Checking token…");
  try {
    await GH.head(tok);
    const vaultRaw = crypto.getRandomValues(new Uint8Array(32));
    const vk = await crypto.subtle.importKey("raw", vaultRaw, "AES-GCM", false, ["encrypt"]);
    const next = { repo: REPO.owner + "/" + REPO.name, vault: await aesEnc(vk, enc.encode(tok)), users: [{ u, role: "admin", ...(await wrapVault(vaultRaw, p)), created: new Date().toISOString(), by: u }] };
    SESSION = { u, role: "admin", token: tok, vaultRaw };
    await saveUsers(next, `users: setup, admin ${u}`);
    closeModal(); render(); toast("Admin " + u + " created");
  } catch (e) { SESSION = null; mErr("Setup failed: " + e.message); }
}
function openAccount() {
  const isAdmin = SESSION.role === "admin";
  modal("Account", `
    <b>Change my password</b>
    <label>New password (min 10)<input id="cp1" type="password" autocomplete="new-password"></label>
    <label>Repeat<input id="cp2" type="password" autocomplete="new-password"></label>
    <div><button class="btn" id="doChpw">Change password</button></div>
    ${isAdmin ? `<hr style="border:0;border-top:1px solid var(--line);width:100%">
    <b>Users</b>
    <table><tbody>${USERS.users.map(x => `<tr><td>${esc(x.u)}</td><td class="l">${esc(x.role)}</td><td class="l muted small">added ${esc(fmtDate(x.created))} by ${esc(x.by || "")}</td><td>${x.u === SESSION.u ? "" : `<button class="btn danger" data-deluser="${esc(x.u)}">Remove</button>`}</td></tr>`).join("")}</tbody></table>
    <b>Add user</b>
    <div style="display:grid;grid-template-columns:1fr 1fr 110px;gap:8px">
      <input id="nu" placeholder="username"><input id="np" type="password" placeholder="temp password (min 10)" autocomplete="new-password">
      <select id="nr"><option value="editor">editor</option><option value="admin">admin</option></select></div>
    <div><button class="btn primary" id="doAdd">Add user</button></div>
    <hr style="border:0;border-top:1px solid var(--line);width:100%">
    <b>Replace GitHub token</b><div class="small muted">Use when the token expires. All users keep their passwords.</div>
    <input id="nt" type="password" placeholder="new fine-grained token" autocomplete="off">
    <div><button class="btn" id="doTok">Replace token</button></div>` : ""}
    <div class="err-t"></div>`, `<button class="btn" data-close>Close</button>`, isAdmin);
}
async function acct(fn, okMsg) { mErr("Saving…"); try { await fn(); mErr(""); toast(okMsg); openAccount(); } catch (e) { mErr(e.message); } }

/* ============================================================ events */
document.addEventListener("click", async e => {
  lastActivity = Date.now();
  const t = e.target.closest("button, tr[data-pax], tr[data-href], [data-close], a");
  if (!t) return;
  if (t.dataset.href && t.tagName === "TR") { location.href = t.dataset.href; return; }
  if (t.matches("[data-close]")) return closeModal();
  if (t.id === "btnLogin") return openLogin();
  if (t.id === "doLogin") return doLogin();
  if (t.id === "doSetup") return doSetup();
  if (t.id === "btnLogout") { if (pendingChanges().length && !confirm("Discard unsaved changes?")) return; SESSION = null; EDIT = false; DATA = clone(BASE); return render(); }
  if (t.id === "btnEdit") { EDIT = !EDIT; VIEW = null; return render(); }
  if (t.id === "btnAcct") return openAccount();
  if ((t.id === "btnHistory" || t.dataset.act === "history") && PAGE_DEST) { SEL.tab = "history"; history.replaceState(null, "", "#history"); return render(); }
  if (t.id === "btnHistory" || t.dataset.act === "history") return openHistory();
  if (t.id === "btnSave" || t.dataset.act === "review") return openReview();
  if (t.dataset.act === "discard") { if (confirm("Discard all unsaved changes?")) { DATA = clone(BASE); render(); } return; }
  if (t.dataset.act === "viewCurrent") { VIEW = null; return render(); }
  if (t.dataset.act === "restore") {
    const snap = VIEW.data, v = VIEW.v;
    DATA = clone(BASE);
    for (const c of diff(stripMeta(BASE), stripMeta(snap))) setPath(DATA, c.path, c.to === undefined ? undefined : clone(c.to));   // undefined = field not in that version
    VIEW = null; EDIT = true; render(); openReview("Restore to v" + v); return;
  }
  if (t.dataset.view) { const v = +t.dataset.view; VIEW = { v, data: snapshotAt(v) }; EDIT = false; closeModal(); render(); window.scrollTo(0, 0); return; }
  if (t.dataset.calc) { SEL.showCalc = !SEL.showCalc; return render(); }
  if (t.dataset.tab) { SEL.paxTab = t.dataset.tab; return render(); }
  if (t.dataset.tabmain) { SEL.tab = t.dataset.tabmain; history.replaceState(null, "", "#" + SEL.tab); return render(); }
  if (t.dataset.sev) { SEL.flagSev[t.dataset.sev] = !SEL.flagSev[t.dataset.sev]; return render(); }
  if (t.dataset.pax) { SEL.pax = +t.dataset.pax; return render(); }
  if (t.id === "doUpload") {
    const f = $("#crFile").files[0];
    if (!f) return toast("Choose a file first");
    if (f.size > CONTRACT_MAX_MB * 1048576) return toast(`File is ${fmtSize(f.size)} — max ${CONTRACT_MAX_MB} MB`, 5000);
    t.disabled = true; t.textContent = "Uploading…";
    try { const v = await saveContract(SEL.dest, { file: f, to: $("#crTo").value, note: $("#crNote").value.trim() }); render(); toast(`Uploaded as v${v} — the file opens on the live page in about a minute`, 5000); }
    catch (err) { toast(err.message, 6000); t.disabled = false; t.textContent = "Upload"; }
    return;
  }
  if (t.dataset.delcr) {
    const c = (curDest().contracts || []).find(x => x.id === t.dataset.delcr);
    if (!c || !confirm(`Remove ${c.name}? It stays in the repo history.`)) return;
    t.disabled = true;
    try { const v = await saveContract(SEL.dest, { removeId: c.id }); render(); toast(`Removed (v${v})`); }
    catch (err) { toast(err.message, 6000); t.disabled = false; }
    return;
  }
  if (t.id === "doSave") {
    const note = $("#saveNote").value.trim();
    if (note.length < 3) return mErr("Write a short note: what changed and why (e.g. 'ATK 2027 rate card').");
    t.disabled = true; mErr("Saving to GitHub…");
    try { const v = await saveChanges(note); closeModal(); EDIT = false; render(); toast("Saved as v" + v + " — the live page updates in about a minute"); }
    catch (err) { mErr(err.message); t.disabled = false; }
    return;
  }
  if (t.id === "doChpw") {
    const p = $("#cp1").value; if (!passwordOk(p)) return mErr("Password must be at least 10 characters."); if (p !== $("#cp2").value) return mErr("Passwords do not match.");
    return acct(async () => { const next = clone(USERS); Object.assign(next.users.find(x => x.u === SESSION.u), await wrapVault(SESSION.vaultRaw, p)); await saveUsers(next, `users: ${SESSION.u} changed password`); }, "Password changed");
  }
  if (t.id === "doAdd") {
    const u = $("#nu").value.trim().toLowerCase(), p = $("#np").value, role = $("#nr").value;
    if (!userNameOk(u)) return mErr("Username: 2–32 chars, lowercase letters, digits, . _ -");
    if (USERS.users.some(x => x.u === u)) return mErr("That username already exists.");
    if (!passwordOk(p)) return mErr("Password must be at least 10 characters.");
    return acct(async () => { const next = clone(USERS); next.users.push({ u, role, ...(await wrapVault(SESSION.vaultRaw, p)), created: new Date().toISOString(), by: SESSION.u }); await saveUsers(next, `users: ${SESSION.u} added ${u} (${role})`); }, "User " + u + " added");
  }
  if (t.dataset.deluser) {
    const u = t.dataset.deluser; if (!confirm(`Remove ${u}? They will no longer be able to log in. If you think they copied the token, also replace the token.`)) return;
    return acct(async () => { const next = clone(USERS); next.users = next.users.filter(x => x.u !== u); await saveUsers(next, `users: ${SESSION.u} removed ${u}`); }, "User " + u + " removed");
  }
  if (t.id === "doTok") {
    const tok = $("#nt").value.trim(); if (!tok) return mErr("Paste the new token.");
    return acct(async () => { await GH.head(tok); const vk = await crypto.subtle.importKey("raw", SESSION.vaultRaw, "AES-GCM", false, ["encrypt"]); const next = clone(USERS); next.vault = await aesEnc(vk, enc.encode(tok)); SESSION.token = tok; await saveUsers(next, `users: ${SESSION.u} replaced token`); }, "Token replaced");
  }
});
function openReview(defaultNote = "") {
  const ch = pendingChanges();
  if (!ch.length) return toast("No changes to save");
  modal(`Save as version ${BASE.version + 1}`, `
    <div class="scroll" style="max-height:340px;overflow:auto"><table><thead><tr><th>What</th><th>Was</th><th>Now</th></tr></thead><tbody>
    ${ch.map(c => `<tr><td class="l" style="white-space:normal">${esc(describe(BASE, c.path))}</td><td class="from">${esc(showVal(c.from))}</td><td class="to">${esc(showVal(c.to))}</td></tr>`).join("")}
    </tbody></table></div>
    <label>Note for the history log (required)<textarea id="saveNote" rows="2" placeholder="e.g. Qayyum 2027 rates received 1 Oct">${esc(defaultNote)}</textarea></label>
    <div class="small muted">Saving as <b>${esc(SESSION ? SESSION.u : "?")}</b>. Creates one commit in ${esc(REPO.owner + "/" + REPO.name)}.</div><div class="err-t"></div>`,
    `<button class="btn" data-close>Keep editing</button><button class="btn primary" id="doSave">Save v${BASE.version + 1}</button>`, true);
  if (!SESSION) mErr("Log in first.");
}
function openHistory() {
  const es = [...HISTORY.entries].filter(touchesDest).sort((a, b) => b.v - a.v);
  modal(`All versions${PAGE_DEST ? " touching " + PAGE_DEST : ""} (${es.length})`, `<div class="hist" style="margin:-14px -16px">${es.map(histEntry).join("")}</div>`, `<button class="btn" data-close>Close</button>`, true);
}
document.addEventListener("keydown", e => {
  lastActivity = Date.now();
  if (e.key === "Escape") closeModal();
  if (e.key === "Enter" && $("#lp") && document.activeElement && ["lu", "lp"].includes(document.activeElement.id)) doLogin();
});
document.addEventListener("input", e => {
  if (e.target.id === "hubSearch") { SEL.hubQ = e.target.value; filterHub(); }
  if (e.target.id === "flagQ") { SEL.flagQ = e.target.value; render(); const i = $("#flagQ"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset && t.dataset.addon) { SEL.addonQty[t.dataset.addon] = Math.max(0, parseInt(t.value || "0", 10) || 0); return render(); }
  if (t.id && t.id.startsWith("opt_")) { (SEL.opt[SEL.dest] ||= {})[t.id.slice(4)] = t.value; return render(); }
  if (t.id === "flagArea") { SEL.flagArea = t.value; return render(); }
  if (t.id === "flagPO") { SEL.flagPO = t.value; return render(); }
  if (t.id === "selPkg") { SEL.pkg = t.value; SEL.variant = "auto"; return render(); }
  if (t.id === "selVar") { SEL.variant = t.value; return render(); }
  if (t.dataset && t.dataset.path) {
    const path = JSON.parse(t.dataset.path);
    let v = t.value;
    if (t.dataset.kind === "num") { if (v.trim() === "") return; v = Number(v); if (!isFinite(v)) return toast("Not a number"); }
    if (t.dataset.kind === "text" && path[path.length - 1] === "expr") { try { compile(v); } catch (err) { toast(err.message, 5000); return; } }
    setPath(DATA, path, v);
    // keep the focus where the user tabbed to after we re-render
    setTimeout(() => {
      const nextPath = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.path : null;
      render();
      if (nextPath) { const el = [...document.querySelectorAll("[data-path]")].find(x => x.dataset.path === nextPath); if (el) el.focus(); }
    }, 0);
  }
});
window.addEventListener("beforeunload", e => { if (pendingChanges().length) { e.preventDefault(); e.returnValue = ""; } });
setInterval(() => { if (SESSION && Date.now() - lastActivity > IDLE_LOGOUT_MS) { SESSION = null; EDIT = false; render(); toast("Logged out after 30 minutes idle", 5000); } }, 60000);

window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (TABS.some(t => t[0] === h) && h !== SEL.tab) { SEL.tab = h; render(); } });
window.PTCALC = { priceRow, variantCost, diff, applyChanges, snapshotAt, describe, get DATA() { return DATA; }, get BASE() { return BASE; }, GH, SEL, render, saveChanges, set SESSION(s) { SESSION = s; }, set EDIT(v) { EDIT = v; }, get HISTORY() { return HISTORY; }, unlock, wrapVault, aesEnc, setUsers(u) { USERS = u; } };
load().catch(() => { });
