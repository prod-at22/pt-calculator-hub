"use strict";
/* ============================================================ config
   REPO is the GitHub repository this page saves to. Viewing needs nothing;
   saving needs a username/password whose entry in data/users.json unlocks
   the repo token (see README). */
const REPO = { owner: "prod-at22", name: "pt-calculator-hub", branch: "main" };
const ROOT = window.PT_ROOT || "";          // "../" on /<code>/ pages
const PAGE_DEST = window.PT_DEST || null;   // destination code, null on the hub
const PAGE_VIEW = window.PT_VIEW || null;   // "flags" on /flags/
const PATHS = { data: "data/data.json", history: "data/history.json", users: "data/users.json", flags: "data/flags.json", catalogs: "data/catalogs/", kb: "data/kb/" };
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
const SEL = { dest: null, pkg: new URLSearchParams(location.search).get("pkg"), variant: "auto", pax: 2, paxTab: "adult", showCalc: false, showRef: false, addonQty: {}, opt: {}, tab: (location.hash || "#costing").slice(1), flagSev: { high: true, medium: true, low: false }, flagArea: "", flagPO: "", flagQ: "" };
const TABS = [["costing", "Costing"], ["itinerary", "Itinerary"], ["surcharge", "Surcharge"], ["accommodation", "Accommodation"], ["addons", "Add On"], ["expect", "What to Expect"], ["policy", "Policy"], ["kbinfo", "Info KB"], ["kbcalc", "Simple Calculator"], ["contracts", "TO Contract Rate"], ["flags", "Flags"], ["history", "History"]];
// each catalog section comes from its own tab: price = Costing, itinerary + includes/excludes = Itinerary, …
const CAT_TABS = ["itinerary", "surcharge", "expect", "policy"];
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
  for (const c of list) { if (c.path[0] === "catalogs" || c.path[0] === "kb") continue; const v = reverse ? c.from : c.to; setPath(obj, c.path, v == null ? undefined : clone(v)); }   // null / undefined = field absent; catalog edits live in data/catalogs/
  return obj;
}
// Human label for a change path, resolved against a snapshot.
function describe(snap, path) {
  if (path[0] === "catalogs") return "Catalog " + path[1] + " › " + path.slice(2).map(x => typeof x === "number" ? "#" + (x + 1) : x).join(" › ");
  if (path[0] === "kb") return "KB " + path[1] + " › " + path.slice(2).map(x => typeof x === "number" ? "#" + (x + 1) : x).join(" › ");
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
// One row of the Costing tab: cost / catalog / selling / margin for each pax type.
const sellDisc = () => { const v = (shown().settings || {}).sellingDiscount; return v === undefined || v === null || v === "" ? 200 : +v; };
function priceRow(d, pkg, variantId, pax, opts) {
  const v = d.variants.find(x => x.id === variantId);
  const O = optsFor(d, opts);
  const cost = variantCost(d, v, pax, O);
  const adultCost = cost ? cost.total : NaN, r = pkg.rules;
  // Selling = Catalog Price (+ tier / option upgrade) − RM200 for every package (settings.sellingDiscount);
  // the infant flat price has no upgrade and no discount. rules.discountTier2 (from the old import) is not used.
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
  const terms = (SEL.hubQ || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const r of document.querySelectorAll(".hub .row")) {
    const hit = terms.every(t => r.dataset.search.includes(t));
    r.style.display = hit ? "" : "none"; if (hit) shown++;
  }
  const e = $("#hubEmpty"); if (e) e.style.display = shown ? "none" : "block";
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
// Hub: one row per catalog package (Project PT sheet), styled like PT Catalog House —
// route + tier badge, duration, code · PO, last update (version + who in the tooltip).
const TIER_WORDS = /\b(basic|standard|std|classic|premium|honeymoon|self tour|self drive|combo island|water villa)\b/gi;
function tierOf(name) {
  const u = String(name).toUpperCase();
  if (/HONEYMOON/.test(u)) return "Honeymoon" + (/PREMIUM/.test(u) ? " Premium" : /STANDARD|STD/.test(u) ? " Standard" : "");
  if (/WATER VILLA/.test(u)) return "Water Villa";
  if (/COMBO/.test(u)) return "Combo Island";
  if (/^ST\b|SELF/.test(u)) return "Self Tour";
  if (/PREMIUM/.test(u)) return "Premium";
  if (/BASIC/.test(u)) return "Basic";
  return "Standard";
}
// Catalogs whose route or duration cannot be read from the package match (several routes
// under one code, or no duration in the catalog name). Same names as PT Catalog House.
const CATALOG_ROUTE = {
  "PT HANOI-SAPA 4D3N 2026": ["Hanoi - Sapa", "4D3N"],
  "PT HANOI-SAPA 5D4N 2026": ["Hanoi - Sapa - Halong Bay", "5D4N"],
  "PT SURABAYA-MALANG (3 STAR) 4D3N 2026": ["Surabaya - Malang", "4D3N"],
  "PT NEW ZEALAND NORTH & SOUTH 2026": ["New Zealand North & South", "10D9N"],
  "ST NEW ZEALAND NORTH & SOUTH (APARTMENT) 2026": ["New Zealand North & South (Apartment)", "9D8N"],
  "ST NEW ZEALAND NORTH & SOUTH (3 STAR) 2026": ["New Zealand North & South (3★)", "9D8N"],
  "ST NEW ZEALAND NORTH ONLY 2026": ["New Zealand North Island", "6D5N"],
  "PT Switzerland 2026": ["Switzerland", "7D6N"],
  "PT TURKI BASIC 8D7N": ["Turki Klasik", "8D7N"],
  "PT TURKI CLASSIC STD 8D7N": ["Turki Klasik", "8D7N"],
};
function routeOf(d, pkg) {
  if (!pkg) return d.name;
  const r = pkg.label.split(" · ")[0].replace(/\b\d+D\d+N\b/g, "").replace(TIER_WORDS, "").replace(/\s+/g, " ").trim();
  return r || d.name;
}
function renderHub() {
  $("#controls").style.display = "none"; $("#kpis").innerHTML = "";
  document.body.classList.add("hubpage");
  const iso = e => e ? new Date(e.at).toISOString().slice(0, 10) : "";
  const rows = shown().destinations.flatMap(d => (d.catalogs && d.catalogs.length ? d.catalogs : d.packages.map(p => p.label)).map(name => {
    const pkg = matchPkg(d, name), href = `${ROOT}${d.code.toLowerCase()}/${pkg ? "?pkg=" + encodeURIComponent(pkg.id) : ""}`;
    const fix = CATALOG_ROUTE[name] || [];
    const route = fix[0] || routeOf(d, pkg), tier = tierOf(name), dur = fix[1] || (String(name).match(/\d+D\d+N/i) || (pkg && pkg.label.match(/\d+D\d+N/)) || [""])[0].toUpperCase();
    const e = lastUpdate(d, pkg ? pkg.id : null), saved = e && e.changes && e.changes.length ? `v${e.v} · ${e.by}` : "";
    return { route, tier, sortKey: (route + " " + tier + " " + dur).toLowerCase(), html: `<a class="row" href="${href}" title="${esc(name)}" data-search="${esc([route, d.name, tier, dur, name, d.code, d.po || ""].join(" ").toLowerCase())}"><span class="dest">${esc(route)}<span class="tier">${esc(tier)}</span></span><span class="dur">${esc(dur)}</span><span class="po">${esc(d.code)} · ${esc(d.po || "—")}</span><span class="upd"${saved ? ` title="${esc(saved)}"` : ""}>${e ? "updated " + iso(e) : ""}</span></a>` };
  })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const src = shown();
  $("#grid").innerHTML = `<div class="hub">
    <header class="hubhead"><h1>PT R&amp;D Costing Hub</h1><img src="${ROOT}arba-logo.png" alt="ARBA Travel"></header>
    <input id="hubSearch" class="filter" type="search" placeholder="Filter by destination, tier, code or PO…" value="${esc(SEL.hubQ || "")}" autocomplete="off" aria-label="Filter packages">
    ${rows.map(r => r.html).join("")}
    <p class="empty" id="hubEmpty">No package matches.</p>
    <footer class="hubfoot">${rows.length} packages · ${VIEW ? `viewing v${VIEW.v}` : `v${src.version}`} · <a href="${ROOT}flags/">Flags</a> · <a href="#" data-hub="history">History</a> · ${SESSION ? `${esc(SESSION.u)} · <a href="#" data-hub="logout">Log out</a>` : `<a href="#" data-hub="login">Log in to edit</a>`}</footer>
  </div>`;
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
// FX chips: the rate each foreign-currency cost is multiplied by. Editable in Edit costs;
// changing it recalculates every cost that uses it.
function fxChips(d) {
  const fx = (d.fx || []).filter(f => f.id !== "MYR");
  if (!fx.length) return `<span class="fx">MYR direct</span>`;
  return fx.map(f => `<span class="fx" title="FX used for every ${esc(f.label.replace(" → MYR", ""))} cost on this page.${EDIT ? "" : " Log in and Edit costs to change it."}">${esc(f.label.replace(" → MYR", ""))} <b>${ed(["destinations", d.code, "fx", f.id, "value"], f.value, { display: esc(String(+f.value)) })}</b></span>`).join("");
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
  if (T === "costing") $("#grid").innerHTML = costingSummary(d, pkg) + rateRef(d, pkg) + (EDIT && !VIEW ? toRatesCard(d, pkg) : "") + costingByPax(d, pkg, pax) + (EDIT && !VIEW ? catalogTab(d, pkg, "price") : "");
  else if (CAT_TABS.includes(T)) $("#grid").innerHTML = catalogTab(d, pkg, T);
  else if (T === "accommodation") $("#grid").innerHTML = accommodationCard(d);
  else if (T === "kbinfo") { $("#grid").innerHTML = kbInfoTab(d); kbFilter(); }
  else if (T === "kbcalc") { $("#grid").innerHTML = kbCalcTab(d); kbFrameReady(); }
  else if (T === "contracts") $("#grid").innerHTML = contractCard(d);
  else if (T === "addons") $("#grid").innerHTML = addonCard(d, pkg) || `<div class="card full"><div class="empty">No add-ons for ${esc(d.name)} yet.</div></div>`;
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
// Flags: cross-check of the catalogs and the hub's own numbers (tools/flags.py → data/flags.json)
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
      <a href="${ROOT}">← All packages</a><h1>Flags <span class="sub muted small">catalog × hub · checked ${esc(fmtDate(FLAGS.generatedAt))} (data v${FLAGS.dataVersion || "?"})</span></h1>
      <div class="filters">${["high", "medium", "low"].map(s => `<button class="tab${SEL.flagSev[s] ? " on" : ""}" data-sev="${s}">${SEV[s]} ${cnt(s)}</button>`).join("")}
        <select id="flagArea"><option value="">All areas</option>${areas.map(a => `<option${a === SEL.flagArea ? " selected" : ""}>${esc(a)}</option>`).join("")}</select>
        <select id="flagPO"><option value="">All POs</option>${pos.map(p => `<option${p === SEL.flagPO ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
        <input id="flagQ" type="search" placeholder="Search…" value="${esc(SEL.flagQ)}"></div>
      <div class="small muted">${list.length} shown. High = a price or cost is wrong or missing · Medium = needs a decision or the catalog and hub disagree on coverage · Low = housekeeping.</div></div></div>` + flagList(list, true);
}
const onLabel = (d, keys) => keys.map(k => { for (const v of d.variants) { const c = v.components.find(x => x.key === k); if (c) return c.label; } return k; }).join(" + ");
// Component columns for a package: union of components across the TOs it uses, in order.
function pkgComponents(d, pkg) {
  const ids = [...new Set([...pkg.assign.map(a => a.variant), ...(SEL.variant !== "auto" ? [SEL.variant] : [])])];
  const out = [];
  for (const id of ids) { const v = d.variants.find(x => x.id === id); if (v) for (const c of v.components) if (!out.some(o => o.key === c.key)) out.push({ key: c.key, label: c.label }); }
  return out;
}
// Same layout as the old R&D sheet: one block per TO (title + header), component columns are
// GROUP totals in RM, then Cost/Pax = sum ÷ pax, Selling, Margin RM / %, Total Gross = margin × pax.
// "Selling (Catalog − RM200)" — selling is the catalog price minus settings.sellingDiscount
const sellLabel = () => "Selling Price";
// "Show calculation": a rate-built component's formula at this pax with the actual rates, e.g.
// 2*R.hndQ at Qayyum FX → "¥22,000 × 2 × 0.026". band(pax, …) is resolved to the band used at this pax.
// Table-based components (T[…]) and plain RM lines get none.
const CUR = { JPY: "¥", KRW: "₩", USD: "US$", EUR: "€" };
function calcText(d, expr, pax, codes) {
  if (!/\bR\.\w/.test(expr) || /\bT\[/.test(expr)) return "";
  const R = Object.fromEntries(d.rates.map(r => [r.id, r]));
  const fxOf = r => r.fx === "MYR" ? null : d.fx.find(x => x.id === r.fx);
  const cur = r => { const f = fxOf(r); if (!f) return "RM"; const m = /\b(JPY|KRW|USD|EUR|THB|IDR|AUD|NZD|CNY|RMB|VND|TRY|CHF|SGD)\b/.exec(f.label); return m ? (CUR[m[1]] || m[1] + " ") : ""; };
  let e = expr.replace(/band\(pax,((?:\[[^\]]+\],?)+)\)/g, (_, pairs) => {
    for (const m of pairs.matchAll(/\[(\d+),([^\]]+)\]/g)) if (pax <= +m[1]) return /\+/.test(m[2]) ? `(${m[2]})` : m[2];   // a plain product needs no brackets
    return "NaN";
  });
  const ids = [...new Set([...e.matchAll(/R\.(\w+)/g)].map(m => m[1]))].filter(id => R[id]);
  const fxs = [...new Set(ids.map(id => (fxOf(R[id]) || { id: "MYR" }).id))];
  const one = fxs.length === 1 ? fxOf(R[ids[0]]) : null;   // one foreign FX → multiply once at the end
  const fmt = v => (+v).toLocaleString("en-MY", { maximumFractionDigits: 6 });
  const fxTxt = f => codes ? codes.fx[f.id] : fmt(f.value);
  e = e.replace(/\bN\b/g, fmt(+d.nights)).replace(/\bpax\b/g, `${pax} pax`)   // before the codes: "N" can be a code
    .replace(/R\.(\w+)/g, (m, id) => { const r = R[id]; if (!r) return m; const f = fxOf(r), t = codes ? codes.r[id] : cur(r) + fmt(r.value);
      return f && !one && fxs.length > 1 ? `{${t}*${fxTxt(f)}}` : t; })
    .replace(/\*/g, " × ").replace(/\+/g, " + ").replace(/\s+/g, " ").trim()
    .replace(/^(\d+) × (.+)$/, "$2 × $1").replace(/\{([^}]+)\}/g, "($1)");
  if (one) e = (/ \+ /.test(e.replace(/\([^()]*\)/g, "")) ? `(${e})` : e) + ` × ${fxTxt(one)}`;
  return e;
}
const hasCalc = (d, pkg) => pkg.assign.some(a => { const v = d.variants.find(x => x.id === a.variant); return v && v.components.some(c => calcText(d, c.expr, 2)); });
// Letter codes for the rates (then the FX) a rate-built package uses, in order of use: A, B, … Z, AA, …
function rateCodes(d, pkg) {
  const R = Object.fromEntries(d.rates.map(r => [r.id, r])), rIds = [], fIds = [], codes = { r: {}, fx: {}, pax: {}, rIds, fIds };
  for (const a of pkg.assign) { const v = d.variants.find(x => x.id === a.variant); if (!v) continue;
    for (const c of v.components) { if (!calcText(d, c.expr, 2)) continue;
      // a rate inside band(pax, …) applies to part of this TO's pax range only, e.g. "8–9 pax"
      for (const b of c.expr.matchAll(/band\(pax,((?:\[[^\]]+\],?)+)\)/g)) { let lo = 1;
        for (const m of b[1].matchAll(/\[(\d+),([^\]]+)\]/g)) { const x = Math.max(lo, a.from), y = Math.min(+m[1], a.to); lo = +m[1] + 1;
          if (x <= y) for (const r of m[2].matchAll(/R\.(\w+)/g)) codes.pax[r[1]] = x === y ? `${x} pax` : y >= a.to && +m[1] >= 999 ? `${x}+ pax` : `${x}–${y} pax`; } }
      for (const m of c.expr.matchAll(/R\.(\w+)/g)) { const r = R[m[1]]; if (!r || rIds.includes(r.id)) continue; rIds.push(r.id);
        if (r.fx !== "MYR" && !fIds.includes(r.fx)) fIds.push(r.fx); } } }
  const L = i => (i >= 26 ? L(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + i % 26);
  rIds.forEach((id, i) => codes.r[id] = L(i)); fIds.forEach((id, i) => codes.fx[id] = L(rIds.length + i));
  return codes;
}
// "Rate reference": the table the letter codes in Show calculation point to.
function rateRef(d, pkg) {
  if (!SEL.showRef || !hasCalc(d, pkg)) return "";   // hidden until Show rate reference is on
  const codes = rateCodes(d, pkg), R = Object.fromEntries(d.rates.map(r => [r.id, r]));
  const cap = s => s.split("/").map(w => w.length <= 4 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("/");   // WIF, ATK stay upper case; Qayyum/Ucop
  const sym = r => { if (r.fx === "MYR") return "RM"; const f = d.fx.find(x => x.id === r.fx), m = /\b(JPY|KRW|USD|EUR|THB|IDR|AUD|NZD|CNY|RMB|VND|TRY|CHF|SGD)\b/.exec(f ? f.label : ""); return m ? (CUR[m[1]] || m[1] + " ") : ""; };
  const split = lbl => { const m = /^(.*?)\s*\(([^,)]+)(?:,\s*([^)]*))?\)\s*$/.exec(lbl); return m ? [m[1], m[2], m[3] || ""] : [lbl, "", ""]; };
  // one column per code: code / item / supplier / rate; the FX columns come last
  const cols = codes.rIds.map(id => { const r = R[id], [item, sup, note] = split(r.label || id);
      return { code: codes.r[id], item: item + (codes.pax[id] && !/\bpax\b/i.test(item) ? " · " + codes.pax[id] : ""), sup: sup === "COMMON" ? "All" : cap(sup), rate: sym(r) + (+r.value).toLocaleString("en-MY"), note }; })
    .concat(codes.fIds.map((id, i) => { const f = d.fx.find(x => x.id === id) || { label: id, value: "" };
      return { code: codes.fx[id], item: "FX " + f.label.replace(/\s*→\s*MYR/, " → RM"), sup: "", rate: String(f.value), note: f.source || "", fx: true, first: i === 0 }; }));
  const row = (lbl, k) => `<tr><th>${lbl}</th>${cols.map(c => `<td class="${c.first ? "rr-fx" : ""}"${k === "rate" && c.note ? ` title="${esc(c.note)}"` : ""}>${esc(c[k])}</td>`).join("")}</tr>`;
  return `<div class="card full" id="rateRef"><h2>Rate reference <span class="sub">${esc(pkg.label)} · codes used in Show calculation · hover a rate for its note</span></h2>
    <div class="scroll"><table class="ref"><thead><tr><th></th>${cols.map(c => `<th class="rr-code${c.first ? " rr-fx" : ""}">${c.code}</th>`).join("")}</tr></thead>
    <tbody>${row("Item", "item")}${row("Supplier", "sup")}${row("Rate", "rate")}</tbody></table></div></div>`;
}
function costingByPax(d, pkg, pax) {
  const k = SEL.paxTab, DP = ["destinations", d.code];
  const paxList = Object.keys(pkg.pricing.adult).map(Number).sort((a, b) => a - b);
  const int = v => num(v) ? Math.round(v).toLocaleString("en-MY") : '<span class="missing">—</span>';
  const ruleTxt = rule => rule.type === "pct" ? `${n2(rule.value * 100, 1)}% of ${rule.on && rule.on.length ? esc(onLabel(d, rule.on)) + " + rest in full" : "adult cost"}` : rule.type === "minus" ? `adult cost − RM${n2(rule.value)}` : `flat RM${n2(rule.value)}`;
  const isAdult = k === "adult", canRef = hasCalc(d, pkg), canCalc = isAdult && canRef, calc = canCalc && SEL.showCalc, codes = calc ? rateCodes(d, pkg) : null;
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
          const vc = calc && bl.v.components.find(o => o.key === c.key), f = vc ? calcText(d, vc.expr, p, codes) : "";
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
    <span class="right tabs">${canRef ? `<button class="tab calcbtn${SEL.showRef ? " on" : ""}" data-ref="1" title="Rates and FX behind the codes A, B, …">${SEL.showRef ? "Hide" : "Show"} rate reference</button>` : ""}${canCalc ? `<button class="tab calcbtn${calc ? " on" : ""}" data-calc="1" title="Show how each component is calculated from the TO rates">Show calculation</button>` : ""}${["adult", "cwb", "cnb"].map(t => `<button class="tab${t === k ? " on" : ""}" data-tab="${t}">${t.toUpperCase()}</button>`).join("")}</span></h2>
    <div class="scroll" style="max-height:640px;overflow-y:auto"><table class="rd">${body}</table></div>
    <div class="note">${isAdult ? "Component columns are for the whole group. Cost/Pax = sum of components ÷ pax. Margin = Selling − Cost/Pax. Total Gross = Margin × pax." : "Cost/Pax comes from the adult cost by the rule above. Margin = Selling − Cost/Pax."} Selling Price = Catalog Price − RM${n2(sellDisc())}.${up ? ` * Catalog includes the upgrade +RM${n2(up)}; when editing, the cell holds the base price.` : ""} ${canCalc ? (calc ? "Each component shows its formula at that pax; A, B, … are the codes in Rate reference. " : "Show calculation shows each component as rates × FX. ") : ""}Hover a component for exact RM. Click a row to highlight it.</div></div>`;
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
// TO rates editor (Costing tab, Edit costs only): every TO cost the page uses — the hub is the source, no R&D sheet.
// Rate-by-rate destinations (Tokyo, Osaka, Tokyo-Osaka): one list of supplier rates × FX.
// Every other destination: per TO, one per-pax table per cost component (T['…'] in its formula).
function toRatesCard(d, pkg) {
  const DP = ["destinations", d.code];
  const vs = SEL.variant !== "auto" ? d.variants.filter(v => v.id === SEL.variant) : pkgVariants(d, pkg);
  const fxLbl = id => id === "MYR" ? "RM" : ((d.fx.find(f => f.id === id) || {}).label || id).replace(" → MYR", "");
  const hint = "Edit TO rates: costs, selling and margin below recalculate as you type";
  const out = [];
  const usedR = new Set(vs.flatMap(v => v.components.flatMap(c => [...String(c.expr).matchAll(/R\.(\w+)/g)].map(m => m[1]))));
  const rates = (d.rates || []).filter(r => usedR.has(r.id));
  if (rates.length) {
    const groups = [...new Set(rates.map(r => r.group || ""))];
    out.push(`<div class="card full"><h2>TO rates · ${esc(d.name)} <span class="sub">${rates.length} rates · ${esc(hint)}</span></h2><div class="scroll"><table class="rd torates">
      <thead><tr><th class="l">Rate</th><th class="l">Unit</th><th>Rate</th><th class="l">FX</th><th>RM</th></tr></thead><tbody>
      ${groups.map(g => `${g ? `<tr class="cat"><td colspan="5">${esc(g)}</td></tr>` : ""}${rates.filter(r => (r.group || "") === g).map(r => {
        const fx = fxOf(d, r.fx);
        return `<tr><td class="l wrap">${esc(r.label)}</td><td class="l muted small">${esc(r.unit || "")}</td><td>${ed([...DP, "rates", r.id, "value"], r.value, { display: n2(+r.value) })}</td><td class="l muted small">${esc(fxLbl(r.fx))}${r.fx === "MYR" ? "" : " × " + esc(String(fx))}</td><td>${rm((+r.value) * fx, 2)}</td></tr>`;
      }).join("")}`).join("")}</tbody></table></div></div>`);
  }
  for (const v of vs) {
    const cols = v.components.map(c => ({ c, t: (d.tables || []).find(t => String(c.expr).includes("T['" + t.id + "']")) })).filter(x => x.t);
    if (!cols.length) continue;
    const paxs = [...new Set(cols.flatMap(x => Object.keys(x.t.values).map(Number)))].sort((a, b) => a - b);
    out.push(`<div class="card full"><h2>TO rates · ${esc(v.label)} <span class="sub">${esc(v.supplier || "")} · ${v.paxMin}–${v.paxMax} pax · ${esc(hint)}</span></h2><div class="scroll"><table class="rd torates">
      <thead><tr><th>Pax</th>${cols.map(x => `<th title="${esc(x.t.label)}">${esc(x.c.label)}<div class="muted small">${esc(x.t.unit || fxLbl(x.t.fx))}</div></th>`).join("")}</tr></thead><tbody>
      ${paxs.map(p => `<tr><td class="c"><b>${p}</b></td>${cols.map(x => { const val = x.t.values[String(p)]; return `<td>${ed([...DP, "tables", x.t.id, "values", String(p)], val, { display: val === undefined || val === null || val === "" ? '<span class="muted">—</span>' : n2(+val) })}</td>`; }).join("")}</tr>`).join("")}
      </tbody></table></div></div>`);
  }
  return out.join("");
}
// Add On: the destination's add-ons (cost / selling / margin). The "In catalog" tick puts an add-on into the
// selected package's customer catalog (a.catalogs = {slug: position}); the catalog prints its name, includes /
// excludes / duration and price text (price_lines), grouped by category in the catalog's addon_groups order.
function addonCard(d, pkg) {
  const list = d.addons || [], DP = ["destinations", d.code], E = EDIT && !VIEW;
  if (!list.length) return "";
  const slugs = (pkg && catalogSlugs(pkg, d)) || [];
  const t = addonTotals(d), tm = t.sell - t.cost;
  const cats = [...new Set(list.map(a => a.category || "Other"))];
  const lineTxt = a => (a || []).join("\n");
  const inCat = a => slugs.some(sl => a.catalogs && sl in a.catalogs);
  const catText = a => {
    if (E && inCat(a)) return `<div class="ao-cat">${["includes", "excludes", "duration"].map(k => `<label>${k.charAt(0).toUpperCase() + k.slice(1)}${ed([...DP, "addons", a.id, k], a[k] || "", { text: true })}</label>`).join("")}
      <label>Catalog price text<textarea class="ed" data-path="${esc(JSON.stringify([...DP, "addons", a.id, "price_lines"]))}" data-kind="lines" rows="${Math.max(1, (a.price_lines || []).length)}">${esc(lineTxt(a.price_lines))}</textarea></label></div>`;
    const bits = [a.includes && "Includes: " + a.includes, a.excludes && "Excludes: " + a.excludes, a.duration && "Duration: " + a.duration].filter(Boolean);
    return bits.length || (a.price_lines || []).length ? `<div class="muted small">${bits.map(esc).join("<br>")}${(a.price_lines || []).length ? `<div class="ao-price">${a.price_lines.map(esc).join(" · ")}</div>` : ""}</div>` : "";
  };
  const tick = (a, sl) => `<td class="c"><input type="checkbox" class="aotick" data-tick="${esc(JSON.stringify({ code: d.code, id: a.id, slug: sl }))}"${a.catalogs && sl in a.catalogs ? " checked" : ""}${E ? "" : " disabled"} title="${esc(sl)}"></td>`;
  const row = a => {
    const c = num(a.cost) ? a.cost : NaN, sv = num(a.selling) ? a.selling : NaN, m = sv - c, p = num(m) && sv ? m / Math.abs(sv) : NaN;
    const q = +SEL.addonQty[a.id] || 0;
    return `<tr${q ? ' class="cur"' : ""}>${slugs.map(sl => tick(a, sl)).join("")}<td class="l" style="white-space:normal;min-width:240px">${E ? ed([...DP, "addons", a.id, "label"], a.label, { text: true }) : esc(a.label)}${a.notes ? `<div class="muted small">${esc(a.notes)}</div>` : ""}${catText(a)}</td><td class="l muted small">${esc(a.per || "")}</td>
      <td>${ed([...DP, "addons", a.id, "cost"], a.cost, { display: num(a.cost) ? rm(a.cost, 2) : '<span class="pill bad" title="No cost yet — add it in Edit costs">cost?</span>' })}</td>
      <td>${ed([...DP, "addons", a.id, "selling"], a.selling, { display: rm(sv, 2) })}</td>
      <td class="${marginClass(p)}">${rm(m, 2)}</td><td>${marginPill(p)}</td>
      <td><input type="number" min="0" max="999" class="aq" data-addon="${esc(a.id)}" value="${q || ""}" placeholder="0"></td>${E ? `<td><button class="btn danger ao-del" data-act="delAddon" data-id="${esc(a.id)}" title="Delete this add-on">Delete</button></td>` : ""}</tr>`;
  };
  const nTick = sl => list.filter(a => a.catalogs && sl in a.catalogs).length;
  const head = slugs.map(sl => `<th class="c" title="${esc(sl)}">In catalog<div class="muted small">${esc(sl)}</div></th>`).join("");
  const cols = 7 + slugs.length + (E ? 1 : 0);
  // per catalog: group order + group notes (addon_groups), edited in place
  const groups = slugs.map(sl => {
    const c0 = CAT.docs[sl]; if (!c0) return "";
    const c = E ? (CAT.edit[sl] ||= clone(c0)) : c0, gs = c.addon_groups || [];
    if (!gs.length && !E) return "";
    const cp = path => esc(JSON.stringify([sl, ...path]));
    return `<div class="cd-note"><b>${esc(sl)}</b> — catalog groups (order as printed)${gs.map((g, i) => E
      ? `<div class="ao-grp"><input class="ed txt cat" data-cpath="${cp(["addon_groups", i, "title"])}" value="${esc(g.title)}"><textarea class="ed cat" data-cpath="${cp(["addon_groups", i, "notes"])}" data-ckind="lines" rows="1" placeholder="group notes (one per line)">${esc(catLines(g.notes))}</textarea></div>`
      : `<div>${i + 1}. ${esc(g.title)}${g.notes && g.notes.length ? ` <span class="muted">— ${g.notes.map(esc).join(" · ")}</span>` : ""}</div>`).join("")}
      <div class="muted small">A ticked add-on prints under the group with the same name as its category; a new category is added at the end.</div></div>`;
  }).join("");
  const addForm = E ? `<div class="body ao-add"><b>Add item</b>
      <label>Category<input id="aoCat" list="aoCats" placeholder="e.g. Activity" value="${esc(SEL.aoCat || "")}"><datalist id="aoCats">${cats.map(c => `<option value="${esc(c)}">`).join("")}</datalist></label>
      <label class="grow">Item<input id="aoLabel" placeholder="e.g. Kecak Dance Uluwatu"></label>
      <label>Per<input id="aoPer" placeholder="pax / trip / couple"></label>
      <label>Cost (RM)<input id="aoCost" type="number" step="any"></label>
      <label>Selling (RM)<input id="aoSell" type="number" step="any"></label>
      ${slugs.map(sl => `<label class="ck"><input type="checkbox" class="aoAddTick" value="${esc(sl)}" checked> In catalog ${esc(sl)}</label>`).join("")}
      <button class="btn primary" data-act="addAddon">Add</button></div>` : "";
  return `<div class="card full" id="addons"><h2>Add On <span class="sub">${list.length} items${slugs.map(sl => ` · ${nTick(sl)} in ${esc(sl)}`).join("")} · tick = include in the catalog${E ? "" : " (Edit costs to change)"} · qty totals the selected add-ons (not saved)</span></h2>
    <div class="scroll" style="max-height:620px;overflow-y:auto"><table><thead><tr>${head}<th>Item</th><th class="l">Per</th><th>Cost</th><th>Selling</th><th>Margin</th><th>%</th><th>Qty</th>${E ? "<th></th>" : ""}</tr></thead><tbody>
    ${cats.map(cat => `<tr class="cat"><td colspan="${cols}">${esc(cat)}</td></tr>` + list.filter(a => (a.category || "Other") === cat).map(row).join("")).join("")}
    ${t.n ? `<tr class="total">${slugs.map(() => "<td></td>").join("")}<td>Selected (${t.n})</td><td></td><td>${rm(t.cost, 2)}</td><td>${rm(t.sell, 2)}</td><td>${rm(tm, 2)}</td><td>${marginPill(t.sell ? tm / t.sell : NaN)}</td><td></td>${E ? "<td></td>" : ""}</tr>` : ""}
    </tbody></table></div>${groups ? `<div class="body">${groups}</div>` : ""}</div>`.replace('<div class="scroll" style="max-height:620px', addForm + '<div class="scroll" style="max-height:620px');
}
// TO Contract Rate: the TO's contract / rate card files (PDF, Excel, image), kept in the repo
// under contracts/<code>/ and listed in the destination's `contracts`.
const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
/* ============================================================ catalog details
   The catalog content (itinerary, includes / excludes, add-ons, notes …) lives in data/catalogs/<slug>.json,
   same schema as Catalog PT, which mirrors it to catalog-pt-public. index.json links slug → package. */
const CAT = { index: null, docs: {}, edit: {}, err: null };   // edit[slug] = unsaved catalog content edits (Itinerary / Surcharge / … tabs)
function loadCatalog(path, set) {
  fetchJson(PATHS.catalogs + path).then(set).catch(e => { CAT.err = e.message; }).then(() => { if (PAGE_DEST) render(); });
}
// Catalog content (data/catalogs/<slug>.json) is shown and edited section by section on its own tab:
// Itinerary (header, hotels, itinerary, includes / excludes), Surcharge, What to Expect, Policy (notes,
// deposit), Costing (price table layout; the amounts are the Catalog Price column) and Add On (ticks).
// Read-only normally; in Edit costs every field is an input (lists: one item per line, sub-item "  - ").
const catLines = a => (a || []).map(it => typeof it === "string" ? it : [it.text, ...(it.sub || []).map(x => "  - " + x)].join("\n")).join("\n");
function catParseLines(t) {
  const out = [];
  for (const raw of String(t).split("\n")) {
    if (!raw.trim()) continue;
    const m = /^\s+[-•]\s*(.*)$/.exec(raw);
    if (m && out.length) { let prev = out[out.length - 1]; if (typeof prev === "string") prev = out[out.length - 1] = { text: prev, sub: [] }; (prev.sub ||= []).push(m[1].trim()); }
    else out.push(raw.trim());
  }
  return out;
}
function catalogSlugs(pkg, d) {
  if (!CAT.index) { if (!CAT.err) loadCatalog("index.json", x => { CAT.index = x; }); return null; }
  return Object.keys(CAT.index).filter(sl => CAT.index[sl].code === d.code && CAT.index[sl].package === pkg.id);
}
function catalogTab(d, pkg, which) {
  const slugs = catalogSlugs(pkg, d);
  if (!slugs) return `<div class="card full"><div class="empty">${CAT.err ? esc(CAT.err) : "Loading catalog…"}</div></div>`;
  if (!slugs.length) return which === "price" ? "" : `<div class="card full"><div class="empty">${esc(pkg.label)} has no published catalog.</div></div>`;
  return slugs.map(sl => {
    const c = CAT.docs[sl];
    if (!c) { if (!CAT.err) loadCatalog(sl + ".json", x => { CAT.docs[sl] = x; }); return `<div class="card full"><div class="empty">${CAT.err ? esc(CAT.err) : "Loading " + esc(sl) + "…"}</div></div>`; }
    return catalogPart(c, CAT.index[sl], which);
  }).join("");
}
function catalogPart(c0, ix, which) {
  const sl = c0.slug, E = EDIT && !VIEW;
  const c = E ? (CAT.edit[sl] ||= clone(c0)) : c0;
  const cp = path => esc(JSON.stringify([sl, ...path]));
  const ci = (path, v, ph = "") => E ? `<input class="ed txt cat" data-cpath="${cp(path)}" value="${esc(v ?? "")}" placeholder="${esc(ph)}">` : esc(v ?? "");
  const ct = (path, a, rows) => `<textarea class="ed cat" data-cpath="${cp(path)}" data-ckind="lines" rows="${rows || Math.min(14, Math.max(3, (a || []).length + 1))}">${esc(catLines(a))}</textarea>`;
  const li = it => typeof it === "string" ? `<li>${esc(it)}</li>` : `<li>${esc(it.text)}${it.sub && it.sub.length ? `<ul>${it.sub.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</li>`;
  const ul = (a, path) => E && path ? ct(path, a) : a && a.length ? `<ul class="cd-list">${a.map(li).join("")}</ul>` : '<div class="muted">—</div>';
  const sec = (title, body, sub) => body ? `<section class="cd-sec"><h3>${title}${sub ? ` <span class="muted">${esc(sub)}</span>` : ""}</h3>${body}</section>` : "";
  const notes = (n, path) => E && path ? `<div class="cd-note">${ct(path, n, 2)}</div>` : n && n.length ? `<div class="cd-note">${n.map(esc).join("<br>")}</div>` : "";
  let body = "", title = "";
  if (which === "price") {
    const P = resolvePrices(c, ix), literal = !catPackage(ix);
    title = "Catalog price table";
    body = P.rows && P.rows.length ? sec("Package Price", `<div class="scroll"><table class="cd-t"><thead><tr><th class="l">${ci(["prices", "pax_label"], P.pax_label || (E ? "" : "No. of Pax"), "No. of Pax")}</th>${P.columns.map((x, i) => `<th>${ci(["prices", "columns", i, "label"], x.label)}${x.age || E ? `<span class="cd-age">${ci(["prices", "columns", i, "age"], x.age, "age")}</span>` : ""}</th>`).join("")}</tr></thead>
      <tbody>${P.rows.map((r, ri) => `<tr><td class="l">${ci(["prices", "rows", ri, "pax"], r.pax)}</td>${r.amounts.map((v, ai) => `<td class="num">${E && literal ? ci(["prices", "rows", ri, "amounts", ai], v) : esc(v || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="cd-note">Infant: ${E ? ci(["prices", "infant"], (c.prices || {}).infant, "e.g. {price} per pax — {price} = Costing infant price, FOC when 0") : esc(P.infant || "—")}</div>${notes(P.notes, ["prices", "notes"])}`,
      literal ? "as printed (no Costing package yet)" : "amounts = the Catalog Price column above; edit pax bands, column labels and the infant line here") : "";
  } else if (which === "itinerary") {
    title = c.title;
    const head = E ? `<div class="cd-edit-head">${[["title", "Title"], ["duration", "Duration"], ["route", "Route"], ["basis", "Package basis"], ["valid_until", "Valid until"], ["version", "Version"]].map(([k, l]) => `<label>${l}${ci([k], c[k])}</label>`).join("")}</div>
      ${(c.highlights || []).length ? `<div class="cd-chips">${c.highlights.map((h, i) => ci(["highlights", i, "label"], h.label)).join(" ")}</div>` : ""}`
      : `${(c.highlights || []).length ? `<div class="cd-chips">${c.highlights.map(h => `<span class="pill">${esc(h.label)}</span>`).join("")}</div>` : ""}`;
    const HA = catHotels(c, sl, ix.code).acc;
    const acc = HA && HA.length ? `<div class="cd-acc">${HA.map(a => `<div><span class="muted">${esc(a.city || "")}</span>${a.stars ? ` · ${"★".repeat(a.stars)}` : ""}<br>${esc(a.name)}${a.similar ? ' <span class="muted">or similar</span>' : ""}</div>`).join("")}</div>${E ? '<div class="cd-note">Hotel: tab <a href="#accommodation" data-tabmain="accommodation">Accommodation</a></div>' : ""}` : "";
    const itins = c.itineraries ? c.itineraries.map((x, i) => ({ label: x.label, days: x.days || [], base: ["itineraries", i, "days"] })) : [{ label: null, days: c.itinerary || [], base: ["itinerary"] }];
    const itin = it => `<div class="scroll"><table class="cd-t cd-itin"><thead><tr><th class="l">Day</th><th class="l">Activities</th><th class="l">Transport</th><th class="l">Meal</th><th class="l">Hotel</th></tr></thead>
      <tbody>${it.days.map((x, di) => { const p = k => [...it.base, di, k]; return `<tr><td class="l cd-day">${esc(x.day)}</td><td class="l"><b>${ci(p("title"), x.title, "title")}</b>${ul(x.activities, p("activities"))}</td><td class="l">${E ? ci(p("transport"), x.transport) : esc(x.transport || "—")}</td><td class="l">${E ? ci(p("meals"), x.meals) : esc(x.meals || "—")}</td><td class="l">${E ? ci(p("hotel"), x.hotel) : esc(x.hotel || "—")}</td></tr>`; }).join("")}</tbody></table></div>
      ${E ? `<div class="cd-note"><button class="btn" data-catact="addday" data-cpath="${cp(it.base)}">+ Day</button> ${it.days.length ? `<button class="btn danger" data-catact="delday" data-cpath="${cp(it.base)}">− Last day</button>` : ""}</div>` : ""}`;
    const incl = (c.price_blocks || []).map((b, bi) => `${b.label ? `<div class="cd-lbl">${esc(b.label)}</div>` : ""}<div class="cd-two"><div><h4>Includes</h4>${ul(b.includes, ["price_blocks", bi, "includes"])}</div><div><h4>Excludes</h4>${ul(b.excludes, ["price_blocks", bi, "excludes"])}</div></div>`).join("");
    body = head + sec("Accommodation", acc) + itins.map(it => sec("Travel Itinerary" + (it.label ? " (" + esc(it.label) + ")" : ""), itin(it))).join("") + sec("Price Includes / Excludes", incl);
  } else if (which === "surcharge") {
    const S = { ...(c.surcharge || {}), rows: catHotels(c, sl, ix.code).rows };
    title = S.title || "Surcharge";
    const sur = (S.rows && S.rows.length ? `<div class="scroll"><table class="cd-t"><thead><tr><th class="l" colspan="2">Accommodation</th>${S.columns.map((x, i) => `<th>${ci(["surcharge", "columns", i, "label"], x.label)}${x.period || E ? `<span class="cd-age">${ci(["surcharge", "columns", i, "period"], x.period, "period")}</span>` : ""}</th>`).join("")}</tr></thead>
      <tbody>${S.rows.map(r => `<tr><td class="l">${esc(r.type || "")}</td><td class="l">${esc(r.name || "")}${r.similar ? ' <span class="muted">or similar</span>' : ""}</td>${(r.amounts || []).map(v => `<td>${esc(v || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${E ? '<div class="cd-note">Baris hotel: tab <a href="#accommodation" data-tabmain="accommodation">Accommodation</a></div>' : ""}` : "")
      + (S.seasons && S.seasons.length ? `<div class="scroll"><table class="cd-t"><thead><tr><th class="l">Season</th><th class="l">Travel dates</th><th class="l">Surcharge</th></tr></thead>
      <tbody>${S.seasons.map((x, i) => `<tr><td class="l"><b>${ci(["surcharge", "seasons", i, "label"], x.label)}</b></td><td class="l">${ci(["surcharge", "seasons", i, "period"], x.period)}</td><td class="l">${ci(["surcharge", "seasons", i, "rate"], x.rate)}</td></tr>`).join("")}</tbody></table></div>` : "") + notes(S.notes, S.title || S.rows || S.seasons ? ["surcharge", "notes"] : null);
    body = (E && (S.title || S.rows || S.seasons) ? `<label class="cd-edit-head">Title${ci(["surcharge", "title"], S.title)}</label>` : "") + (sur || '<div class="empty">No surcharge in this catalog.</div>');
  } else if (which === "expect") {
    title = "What to Expect";
    body = c.expect && c.expect.length ? `<div class="cd-acc">${c.expect.map((e, i) => `<div><b>${ci(["expect", i, "title"], e.title)}</b>${e.tag && !E ? ` <span class="pill">${esc(e.tag)}</span>` : ""}<br><span class="muted">${E ? `<textarea class="ed cat" data-cpath="${cp(["expect", i, "body"])}" rows="2">${esc(e.body || "")}</textarea>` : esc(e.body)}</span></div>`).join("")}</div>` : '<div class="empty">No "What to Expect" in this catalog.</div>';
  } else if (which === "policy") {
    title = "Policy";
    const imp = (c.notes || []).map((n, i) => `${n.title || E ? `<h4>${ci(["notes", i, "title"], n.title, "title")}</h4>` : ""}${ul(n.entries, ["notes", i, "entries"])}`).join("");
    const dep = (c.deposit || []).map((x, i) => `<div><b>${ci(["deposit", i, "figure"], x.figure)}</b> ${ci(["deposit", i, "text"], x.text)}</div>`).join("");
    body = sec("Important Notes", imp) + sec("Deposit & Full Payment", dep);
  }
  if (!body) return "";
  const meta = which === "itinerary" && !E ? [c.duration, c.route, c.basis, c.valid_until ? "valid until " + c.valid_until : "", c.version, c.updated ? "updated " + c.updated : ""].filter(Boolean).map(esc).join(" · ") : esc(sl);
  return `<div class="card full cd" id="cat-${esc(sl)}${which === "itinerary" ? "" : "-" + which}"><h2>${esc(title)} <span class="sub">${meta}</span>
      <span class="right"><a class="btn" href="${esc(ix.url)}" target="_blank" rel="noopener">Public page</a><a class="btn" href="${esc(ix.url.replace(/\.html$/, ".pdf"))}" target="_blank" rel="noopener">PDF</a></span></h2>
    <div class="body">${body}
      ${E ? `<div class="cd-note">Saved with <b>Save</b> (one version, with the costs). The public catalog and PDF rebuild about 10–15 minutes after saving.</div>` : ""}</div></div>`;
}
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
/* ============================================================ Accommodation
   One hotel list per destination (data.json destinations[].hotels). Each hotel is ticked per catalog as
   {"acc": position} (the catalog's Accommodation section) and/or {"sur": position, "amounts": [...]} (a row of the
   catalog's Surcharge table, one amount per surcharge column). catalog-build/hub_data.py hotels() prints the same.
   The KB's hotel cards (data/kb/<slug>.json) are edited on the same tab. */
const HOTEL_ACC = ["city", "name", "stars", "similar"], HOTEL_SUR = ["type", "name", "similar"];
function catHotels(c, sl, code, data = DATA) {
  const d = data.destinations.find(x => x.code === code), acc0 = c.accommodation, rows0 = (c.surcharge || {}).rows;
  if (!d || !d.hotels) return { acc: acc0, rows: rows0 };
  const t = d.hotels.map(h => [h, (h.catalogs || {})[sl] || {}]);
  const pick = (h, ks) => Object.fromEntries(ks.filter(k => k in h).map(k => [k, h[k]]));
  const acc = t.filter(x => "acc" in x[1]).sort((a, b) => a[1].acc - b[1].acc).map(([h]) => pick(h, HOTEL_ACC));
  const rows = t.filter(x => "sur" in x[1]).sort((a, b) => a[1].sur - b[1].sur).map(([h, k]) => ({ ...pick(h, HOTEL_SUR), amounts: [...(k.amounts || [])] }));
  return { acc: acc.length ? acc : acc0, rows: rows.length ? rows : rows0 };
}
function destSlugs(d) { return CAT.index ? Object.keys(CAT.index).filter(sl => CAT.index[sl].code === d.code) : null; }
// KB hotel cards link hotels by id; the card name is made from the hotels (same rule as kb-build/build.py hotel_cards)
function kbHotelName(card, H) {
  if (!card.hotels) return card.name || "";
  const hs = card.hotels.map(id => H[id]).filter(Boolean);
  let names = [...new Set(hs.map(h => h.name).filter(Boolean))].join(" / ");
  const extra = card.extra || "";
  if (hs.some(h => h.similar) && !/setara|similar/i.test(names + extra)) names += " (atau setaraf)";
  return [names, extra].filter(Boolean).join(" / ");
}
function kbHotelCards(sl, p, list, codes, E) {
  const all = DATA.destinations.filter(d => codes.includes(d.code)).flatMap(d => (d.hotels || []).map(h => ({ ...h, code: d.code })));
  const H = Object.fromEntries(all.map(h => [h.id, h]));
  if (!E) return list.length ? `<div class="cd-acc">${list.map(h => `<div><span class="muted">${esc(kbTxt(h.tier || ""))}</span><br><b>${esc(kbTxt(kbHotelName(h, H)))}</b>${h.note ? `<div class="small">${esc(kbTxt(h.note))}</div>` : ""}${h.hotels ? "" : ' <span class="pill grey" title="Teks sendiri, tidak dipaut ke senarai hotel">teks</span>'}</div>`).join("")}</div>` : '<div class="empty">Tiada kad hotel dalam KB.</div>';
  const kp = path => esc(JSON.stringify([sl, ...p, ...path]));
  const inp = (path, v, ph) => `<input class="ed txt kbed" data-kpath="${kp(path)}" value="${esc(v ?? "")}" placeholder="${esc(ph)}">`;
  return list.map((c, i) => `<fieldset class="kb-fs"><legend>#${i + 1} ${esc(kbTxt(c.tier || ""))} <button class="btn danger" data-kact="del" data-kpath="${kp([i])}">Buang kad</button></legend>
      <label class="kb-f">Kategori${inp([i, "tier"], c.tier, "cth. 4★ — Banda Aceh")}</label>
      ${c.hotels ? `<label class="kb-f wide">Teks tambahan (selepas nama hotel)${inp([i, "extra"], c.extra, "cth. homestay")}</label>
        <div class="kb-f wide">Hotel dalam kad (dari senarai Accommodation di atas):<div class="h-pick">${all.map(h => `<label class="ck"><input type="checkbox" class="khotel" data-khotel="${esc(JSON.stringify({ sl, path: [...p, i, "hotels"], id: h.id }))}"${c.hotels.includes(h.id) ? " checked" : ""}> ${esc(h.name || h.id)}${codes.length > 1 ? ` <span class="muted small">${esc(h.code)}</span>` : ""}</label>`).join("")}</div>
        <div class="small">Nama dalam KB: <b>${esc(kbTxt(kbHotelName(c, H)))}</b></div></div>`
      : `<label class="kb-f wide">Nama (teks sendiri)${inp([i, "name"], c.name, "")}</label>`}
      <label class="kb-f wide">Nota TC<textarea class="ed kbed" data-kpath="${kp([i, "note"])}" rows="2">${esc(c.note || "")}</textarea></label></fieldset>`).join("")
    + `<button class="btn" data-kact="add" data-kpath="${esc(JSON.stringify([sl, ...p]))}">+ Tambah kad</button>`;
}
function accommodationCard(d) {
  const slugs = destSlugs(d);
  if (!slugs) { if (!CAT.err) loadCatalog("index.json", x => { CAT.index = x; }); return `<div class="card full"><div class="empty">${CAT.err ? esc(CAT.err) : "Loading…"}</div></div>`; }
  for (const sl of slugs) if (!CAT.docs[sl] && !CAT.err) loadCatalog(sl + ".json", x => { CAT.docs[sl] = x; });
  const E = EDIT && !VIEW, DP = ["destinations", d.code], H = d.hotels || [];
  const cols = sl => ((CAT.docs[sl] || {}).surcharge || {}).columns || [];
  const fld = (h, k, ph) => E ? `<input class="ed txt" data-path="${esc(JSON.stringify([...DP, "hotels", h.id, k]))}" data-kind="text" value="${esc(h[k] ?? "")}" placeholder="${esc(ph)}">` : esc(h[k] ?? "");
  const tick = (h, sl, kind) => `<input type="checkbox" class="htick" data-htick="${esc(JSON.stringify({ code: d.code, id: h.id, slug: sl, kind }))}"${((h.catalogs || {})[sl] || {})[kind] !== undefined ? " checked" : ""}${E ? "" : " disabled"} title="${kind === "acc" ? "Accommodation" : "Surcharge"} · ${esc(sl)}">`;
  const cell = (h, sl) => {
    const t = (h.catalogs || {})[sl] || {}, n = cols(sl).length;
    const am = "sur" in t ? `<div class="h-am">${Array.from({ length: Math.max(n, (t.amounts || []).length) }, (_, i) => E
      ? `<input class="ed txt" data-path="${esc(JSON.stringify([...DP, "hotels", h.id, "catalogs", sl, "amounts", i]))}" data-kind="text" value="${esc((t.amounts || [])[i] ?? "")}" placeholder="${esc((cols(sl)[i] || {}).label || "")}">`
      : `<span title="${esc((cols(sl)[i] || {}).label || "")}">${esc((t.amounts || [])[i] ?? "—")}</span>`).join("")}</div>` : "";
    return `<td class="l"><label class="ck">${tick(h, sl, "acc")} Acc</label> <label class="ck">${tick(h, sl, "sur")} Surcharge</label>${am}</td>`;
  };
  const kx = kbDoc(d.code), kv = kx && kbView(kx.kb), kcards = kv && kv.hotels ? getPath(kx.kb, kv.hotels) || [] : [];
  const inKb = h => kcards.filter(c => (c.hotels || []).includes(h.id)).map(c => kbTxt(c.tier || "")).join(" · ");
  const row = h => `<tr><td class="l">${fld(h, "city", "bandar")}</td><td class="l">${fld(h, "type", "jenis (cth. 4 Star Hotel)")}</td><td class="l" style="min-width:220px">${fld(h, "name", "nama hotel")}</td>
      <td class="c">${E ? `<input class="ed" type="number" min="0" max="5" data-path="${esc(JSON.stringify([...DP, "hotels", h.id, "stars"]))}" data-kind="num" value="${esc(h.stars ?? "")}">` : h.stars ? "★".repeat(h.stars) : ""}</td>
      <td class="c">${E ? `<input type="checkbox" class="hsim" data-hsim="${esc(JSON.stringify({ code: d.code, id: h.id }))}"${h.similar ? " checked" : ""}>` : h.similar ? "✓" : ""}</td>
      ${slugs.map(sl => cell(h, sl)).join("")}<td class="l small">${esc(inKb(h)) || '<span class="muted">—</span>'}</td>${E ? `<td><button class="btn danger" data-act="delHotel" data-id="${esc(h.id)}">Delete</button></td>` : ""}</tr>`;
  const head = slugs.map(sl => `<th class="l">${esc(sl)}${cols(sl).length ? `<div class="muted small">surcharge: ${cols(sl).map(c => esc(c.label)).join(" · ")}</div>` : ""}</th>`).join("");
  const hotelsCard = `<div class="card full" id="hotels"><h2>Accommodation <span class="sub">${H.length} hotel · satu senarai untuk katalog customer &amp; KB · Acc = bahagian Accommodation katalog · Surcharge = baris jadual surcharge hotel${E ? "" : " (Edit costs untuk ubah)"}</span></h2>
    ${E ? `<div class="body"><button class="btn" data-act="addHotel">+ Tambah hotel</button></div>` : ""}
    ${H.length ? `<div class="scroll"><table class="zebra"><thead><tr><th class="l">Bandar</th><th class="l">Jenis</th><th class="l">Hotel</th><th>★</th><th>or similar</th>${head}<th class="l">Kad KB</th>${E ? "<th></th>" : ""}</tr></thead><tbody>${H.map(row).join("")}</tbody></table></div>` : `<div class="empty">Tiada hotel lagi untuk ${esc(d.name)}.</div>`}
    <div class="note">Katalog customer mencetak hotel yang ditanda, ikut susunan tanda. Lajur "Hotel" dalam itinerary harian kekal di tab Itinerary; tarikh &amp; kadar musim peak kekal di tab Surcharge.</div></div>`;
  // the KB's hotel cards (PT KB House), same tab
  const x = kbDoc(d.code); let kbCard = "";
  if (x) {
    const V = kbView(x.kb), p = V.hotels, list = p ? getPath(x.kb, p) || [] : [];
    kbCard = `<div class="card full kb" id="kb-hotels"><h2>Kad hotel KB · ${esc(x.ix.name)} <span class="sub">${list.length} kad · tab Accommodation dalam KB${E ? "" : " (Edit costs untuk ubah)"}</span></h2><div class="body">
      ${p ? kbHotelCards(x.sl, p, list, x.ix.codes || [], E) : ""}</div></div>`;
  }
  return hotelsCard + kbCard;
}
/* ============================================================ KB House (Info KB · Simple Calculator)
   Every PT KB House page (prod-at22.github.io/pt-kb-house/<slug>/) is built from data/kb/<slug>.json by
   kb-build/build.py (pt-kb-house's mirror.yml): `content` = what the KB shows (packages, attractions with
   Muslim-friendly info, hotels, tab blocks, FAQ), `calc` = the Simple Calculator config. index.json links a
   KB to the destination codes it covers. Images stay in pt-kb-house ("@asset:<key>" here). Edited in Edit
   costs like the catalogs; Save writes the file in the same commit and starts pt-kb-house's mirror. */
const KB = { index: null, docs: {}, edit: {}, err: null, q: "" };
function loadKb(path, set) {
  fetchJson(PATHS.kb + path).then(set).catch(e => { KB.err = e.message; }).then(() => { if (PAGE_DEST) render(); });
}
function kbSlugFor(code) {
  if (!KB.index) { if (!KB.err) loadKb("index.json", x => { KB.index = x; }); return undefined; }
  return Object.keys(KB.index).find(sl => (KB.index[sl].codes || []).includes(code)) || null;
}
function kbDoc(code) {   // undefined = loading, null = no KB, else {sl, kb (edit copy in Edit costs), ix}
  const sl = kbSlugFor(code);
  if (!sl) return sl;
  if (!KB.docs[sl]) { if (!KB.err) loadKb(sl + ".json", x => { KB.docs[sl] = x; }); return undefined; }
  const E = EDIT && !VIEW;
  return { sl, kb: E ? (KB.edit[sl] ||= clone(KB.docs[sl])) : KB.docs[sl], ix: KB.index[sl] };
}
// The two page kinds keep their content under different names; one view for both.
function kbView(kb) {
  const c = kb.content || {};
  if (kb.kind === "bespoke") {
    const blocks = {};
    for (const k of Object.keys(c)) if (/_HTML$/.test(k) && typeof c[k] === "string") blocks[k.replace(/_HTML$/, "").toLowerCase()] = ["content", k];
    return { meta: null, packages: c.PKG ? ["content", "PKG"] : null, itin: c.ITIN ? ["content", "ITIN"] : null, attractions: c.ATTR ? ["content", "ATTR"] : null,
      hotels: c.HOTELS ? ["content", "HOTELS"] : null, acts: c.ITINSUGG_ACTS ? ["content", "ITINSUGG_ACTS"] : c.ACTS ? ["content", "ACTS"] : null,
      blocks, faq: ["snapshot"], marketing: null, extra: ["SNOTE", "SEASON_TXT", "PRICES"].filter(k => k in c).map(k => ["content", k]) };
  }
  const blocks = {};
  for (const k of Object.keys(c.blocks || {})) blocks[k] = ["content", "blocks", k];
  return { meta: ["content", "meta"], packages: ["content", "packages"], itin: ["content", "itineraries"], attractions: ["content", "attractions"], hotels: ["content", "hotels"],
    acts: (c.actGroups || []).length ? ["content", "actGroups"] : null, blocks, faq: ["content", "snapshot"], marketing: c.meta && c.meta.marketing ? ["content", "meta", "marketing"] : null, extra: [] };
}
const KBL = { n: "Nama", t: "Jenis / tajuk", tag: "Tag", sub: "Ringkasan", short: "Ringkas", intro: "Pengenalan", hi: "Highlights", best: "Masa terbaik", muslim: "Muslim-friendly",
  map: "Google Maps", inc: "Termasuk", exc: "Tidak termasuk", note: "Nota", tier: "Kategori", name: "Nama", d: "Hari", m: "Makan", a: "Aktiviti", city: "Bandar", items: "Item",
  emoji: "Emoji", anchors: "Anchor attractions", usp: "USP", season: "Musim", expect: "What to expect", heroTitle: "Hero", heroLead: "Hero (ayat)", docTitle: "Tajuk halaman",
  statusText: "Last updated", kicker: "Kicker", brandTag: "Brand tag", overviewTitle: "Tajuk overview", searchPlaceholder: "Placeholder carian", miniSearchPlaceholder: "Placeholder carian kecil", footerHtml: "Footer" };
const KB_BLOCK = { compare: "Perbezaan Pakej", pricing: "Harga & Pakej", custom: "Simple Customisation", surcharge: "Surcharge", transport: "Transportation & Guide", stay: "Accommodation",
  food: "Halal & Makanan", prayer: "Solat", flight: "Flight & Airport", flight_reco: "Flight & Airport", weather: "Cuaca & Musim", tips: "Shopping & Tips", visa: "Visa & Passport",
  freegift: "Free Gift (Promo)", polisi: "Polisi & Payment", trippix: "Trip Pix", triplepas: "Triple Pass", cmp: "Perbandingan", itinsugg: "Itinerary Suggestions", wheelchair: "Wheelchair & Baby" };
const KB_SKIP_BLOCK = new Set(["calc", "map"]);   // the calculator shell and the travel map are part of the page (cosmetic)
const isAsset = v => typeof v === "string" && (/^@asset:/.test(v) || /^data:/.test(v));
const kbTxt = v => typeof v === "string" ? v.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&[a-z]+;/g, "") : "";
const kbHtml = h => String(h || "").replace(/<img\b[^>]*src=["']?(?:@asset:|data:)[^>]*>/gi, "").replace(/<script\b[\s\S]*?<\/script>/gi, "");
// FAQ / snapshot markdown → collapsible sections (headings, bullets, tables, **bold**)
function kbMd(md) {
  const inl = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const body = lines => {
    let h = "", list = false, tbl = [];
    const flush = () => { if (list) { h += "</ul>"; list = false; } if (tbl.length) { const rows = tbl.filter(r => !/^\s*\|[\s\-|:]+\|\s*$/.test(r)).map(r => r.trim().replace(/^\||\|$/g, "").split("|").map(x => x.trim()));
      h += `<div class="scroll"><table class="cd-t">${rows.map((r, i) => `<tr>${r.map(x => i ? `<td class="l">${inl(x)}</td>` : `<th class="l">${inl(x)}</th>`).join("")}</tr>`).join("")}</table></div>`; tbl = []; } };
    for (const ln of lines) {
      if (/^\s*\|/.test(ln)) { if (list) { h += "</ul>"; list = false; } tbl.push(ln); continue; }
      const m = /^\s*[-*]\s+(.*)$/.exec(ln);
      if (m) { if (tbl.length) flush(); if (!list) { h += "<ul>"; list = true; } h += `<li>${inl(m[1])}</li>`; continue; }
      flush(); if (ln.trim()) h += `<p>${inl(ln)}</p>`;
    }
    flush(); return h;
  };
  const secs = []; let cur = { t: "", lines: [] };
  for (const ln of String(md || "").replace(/\\([#\-*>|&<~.\\`_])/g, "$1").split(/\r?\n/)) {
    const m = /^#{1,4}\s+(.*)$/.exec(ln);
    if (m) { if (cur.t || cur.lines.some(x => x.trim())) secs.push(cur); cur = { t: m[1], lines: [] }; } else cur.lines.push(ln);
  }
  if (cur.t || cur.lines.some(x => x.trim())) secs.push(cur);
  return secs.map(s => `<details class="kb-faq" data-kbtext="${esc((s.t + " " + s.lines.join(" ")).toLowerCase())}"><summary>${esc(s.t || "Nota")}</summary><div class="kb-md">${body(s.lines)}</div></details>`).join("");
}
// Prices, itinerary and includes / excludes of a catalog-linked KB package are not stored in the KB: the KB page
// is built from the Costing tab (Catalog Price) and the Itinerary tab (data/catalogs/<slug>.json).
const kbLinks = kb => ((kb.map || {}).packages) || [];
function kbCat(sl) {   // the catalog doc, loading it (and index.json) when needed
  if (!CAT.index) { if (!CAT.err) loadCatalog("index.json", x => { CAT.index = x; }); return null; }
  if (!CAT.docs[sl]) { if (!CAT.err) loadCatalog(sl + ".json", x => { CAT.docs[sl] = x; }); return null; }
  return CAT.docs[sl];
}
function kbAdult(sl) {
  const ix = CAT.index && CAT.index[sl], pk = ix && catPackage(ix), out = {};
  if (pk) for (const [k, v] of Object.entries(pk.pricing.adult || {})) { if (num(v) && v) out[+k] = +v; }
  return out;
}
function kbFill(t, links) {   // {{dari:N}} {{2pax:N}} {{pasangan:N}} → price of package N from Costing
  return String(t || "").replace(/\{\{(dari|2pax|pasangan):(\d+)\}\}/g, (m, k, i) => {
    const ln = links[+i]; if (!ln) return m;
    const A = kbAdult(ln.catalog), ks = Object.keys(A).map(Number); if (!ks.length) return m;
    const v = k === "dari" ? Math.min(...Object.values(A)) : k === "2pax" ? A[Math.min(...ks)] : 2 * A[Math.min(...ks)];
    return "RM" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  });
}
// Edit costs: a generic field editor over the KB file (strings, lists, nested items). Images are not edited here.
function kbEditor(sl, path, v, key) {
  const kp = esc(JSON.stringify([sl, ...path])), lbl = key == null ? "" : esc(KBL[key] || String(key));
  if (v === null) return `<div class="kb-f muted small">${lbl} dari katalog (tab Itinerary)</div>`;
  if (isAsset(v) || key === "img" || key === "imgs") return `<div class="kb-f muted small">${lbl}: gambar (urus di pt-kb-house)</div>`;
  if (typeof v === "string") {
    const long = v.length > 90 || /[\n<]/.test(v);
    return `<label class="kb-f${long ? " wide" : ""}">${lbl}${long ? `<textarea class="ed kbed" data-kpath="${kp}" rows="${Math.min(18, Math.max(2, Math.ceil(v.length / 110) + (v.match(/\n/g) || []).length))}">${esc(v)}</textarea>` : `<input class="ed txt kbed" data-kpath="${kp}" value="${esc(v)}">`}</label>`;
  }
  if (typeof v === "number") return `<label class="kb-f">${lbl}<input class="ed kbed" type="number" step="any" data-kpath="${kp}" data-kkind="num" value="${v}"></label>`;
  if (Array.isArray(v) && v.every(x => typeof x === "string"))
    return `<label class="kb-f wide">${lbl} <span class="muted small">(satu baris satu item)</span><textarea class="ed kbed" data-kpath="${kp}" data-kkind="lines" rows="${Math.min(14, Math.max(2, v.length + 1))}">${esc(v.join("\n"))}</textarea></label>`;
  if (Array.isArray(v) && v.every(x => Array.isArray(x) && x.every(y => typeof y === "string")))
    return `<label class="kb-f wide">${lbl} <span class="muted small">(satu baris satu item, lajur dipisah " | ")</span><textarea class="ed kbed" data-kpath="${kp}" data-kkind="pairs" rows="${Math.min(14, v.length + 1)}">${esc(v.map(x => x.join(" | ")).join("\n"))}</textarea></label>`;
  if (Array.isArray(v)) return `<fieldset class="kb-fs"><legend>${lbl} <span class="muted small">${v.length} item</span></legend>${v.map((x, i) => `<fieldset class="kb-fs"><legend>#${i + 1} ${esc(kbTxt((x && (x.n || x.name || x.t || x.tier || x.city)) || ""))} <button class="btn danger" data-kact="del" data-kpath="${esc(JSON.stringify([sl, ...path, i]))}">Buang</button></legend>${kbEditor(sl, [...path, i], x, null)}</fieldset>`).join("")}
    <button class="btn" data-kact="add" data-kpath="${kp}">+ Tambah</button></fieldset>`;
  if (v && typeof v === "object") return (key == null ? "" : `<fieldset class="kb-fs"><legend>${lbl}</legend>`) + Object.keys(v).map(k => kbEditor(sl, [...path, k], v[k], k)).join("") + (key == null ? "" : "</fieldset>");
  return `<div class="kb-f muted small">${lbl}: ${esc(showVal(v))}</div>`;
}
function kbInfoTab(d) {
  const x = kbDoc(d.code);
  if (x === undefined) return `<div class="card full"><div class="empty">${KB.err ? esc(KB.err) : "Loading KB…"}</div></div>`;
  if (!x) return `<div class="card full"><div class="empty">${esc(d.name)} has no PT KB House page.</div></div>`;
  const { sl, kb, ix } = x, V = kbView(kb), E = EDIT && !VIEW, g = p => p ? getPath(kb, p) : null;
  const head = `<div class="card full kb"><h2>Info KB · ${esc(ix.name)} <span class="sub">${esc(kbTxt((g(V.meta) || {}).statusText || ""))}${(ix.codes || []).length > 1 ? " · covers " + ix.codes.map(esc).join(", ") : ""}</span>
      <span class="right"><a class="btn" href="${esc(ix.url)}" target="_blank" rel="noopener">Buka KB</a></span></h2>
    <div class="body small muted">Kandungan PT KB House (Bahasa Melayu) — sumbernya hub ini (<code>data/kb/${esc(sl)}.json</code>). ${E ? "Edit di sini, kemudian <b>Save</b>: KB dibina semula oleh mirror pt-kb-house (~1–2 min). Gambar dan reka bentuk halaman kekal di pt-kb-house." : "Log in → Edit costs untuk ubah."}</div>
    ${E ? "" : `<div class="body"><input id="kbq" class="kb-q" placeholder="Cari dalam KB: halal, surau, cuaca, visa…" value="${esc(KB.q)}"></div>`}</div>`;
  const card = (id, title, sub, inner) => inner ? `<div class="card full kb" id="kb-${id}"><h2>${title} <span class="sub">${sub || ""}</span></h2><div class="body">${inner}</div></div>` : "";
  const names = (g(V.packages) || []).map(p => kbTxt(p.n)), links = kbLinks(kb);
  if (E) {
    const ed = (id, title, p) => p && g(p) != null ? card(id, title, "", kbEditor(sl, p, g(p), null)) : "";
    return head + ed("attr", "Attractions & Muslim-friendly", V.attractions) + (V.faq && typeof g(V.faq) === "string" ? card("faq", "FAQ / Important Notes", "markdown: # tajuk, - item, | jadual |", kbEditor(sl, V.faq, g(V.faq), null)) : "")
      + (V.packages ? card("pkg", "Kad pakej KB", "nama, pengenalan &amp; nota sahaja — harga, itinerary, termasuk / tidak termasuk dari tab Costing &amp; Itinerary. Harga dalam teks: {{dari:N}} · {{2pax:N}} · {{pasangan:N}} (N = pakej, mula 0)", kbEditor(sl, V.packages, g(V.packages), null)) : "")
      + (V.itin && (g(V.itin) || []).some(x => x) ? card("itin", "Itinerari pakej tanpa katalog", "pakej lain ikut tab Itinerary", (g(V.itin) || []).map((x, i) => x ? `<h3>${esc(names[i] || "#" + (i + 1))}</h3>` + kbEditor(sl, [...V.itin, i], x, null) : "").join("")) : "") + ed("acts", "Aktiviti", V.acts)
      + card("blocks", "Tab KB (HTML)", "satu blok satu tab dalam KB", Object.entries(V.blocks).filter(([k]) => !KB_SKIP_BLOCK.has(k)).map(([k, p]) => `<h3>${esc(KB_BLOCK[k] || k)}${k === "pricing" ? ' <span class="muted small">— nota TC sahaja; jadual harga dijana dari Costing</span>' : ""}</h3>${kbEditor(sl, p, g(p), null)}`).join(""))
      + ed("mkt", "Marketing", V.marketing) + (V.meta ? card("meta", "Hero & halaman", "", kbEditor(sl, V.meta, Object.fromEntries(Object.entries(g(V.meta)).filter(([k]) => k !== "marketing")), null)) : "")
      + V.extra.map(p => ed("x-" + p[1], p[1], p)).join("");
  }
  const A = g(V.attractions) || [];
  const attr = A.map(a => `<div class="kb-attr" data-kbtext="${esc(kbTxt([a.n, a.t, a.short, a.intro, (a.hi || []).join(" "), a.best, a.muslim].join(" ")).toLowerCase())}">
      <b>${esc(kbTxt(a.n))}</b> ${a.t ? `<span class="pill">${esc(kbTxt(a.t))}</span>` : ""}<div class="muted small">${esc(kbTxt(a.short || ""))}</div>
      ${a.intro ? `<p>${esc(kbTxt(a.intro))}</p>` : ""}${(a.hi || []).length ? `<ul>${a.hi.map(h => `<li>${esc(kbTxt(h))}</li>`).join("")}</ul>` : ""}
      ${a.best ? `<div class="small"><b>Masa terbaik:</b> ${esc(kbTxt(a.best))}</div>` : ""}${a.muslim ? `<div class="kb-muslim"><b>Muslim-friendly:</b> ${esc(kbTxt(a.muslim))}</div>` : ""}
      ${a.map ? `<a class="small" href="${esc(a.map)}" target="_blank" rel="noopener">Google Maps ↗</a>` : ""}</div>`).join("");
  const faq = typeof g(V.faq) === "string" ? kbMd(g(V.faq)) : "";
  const P = g(V.packages) || [];
  const bl = Object.entries(V.blocks).filter(([k]) => !KB_SKIP_BLOCK.has(k)).map(([k, p]) => `<details class="kb-faq" data-kbtext="${esc(kbTxt(g(p)).toLowerCase())}"><summary>${esc(KB_BLOCK[k] || k)}</summary><div class="kb-html">${kbHtml(g(p))}</div></details>`).join("");
  const M = g(V.marketing);
  const mk = M ? `${(M.anchors || []).length ? `<div class="cd-chips">${M.anchors.map(a => `<span class="pill">${esc(kbTxt(a))}</span>`).join("")}</div>` : ""}${M.usp ? `<p>${esc(kbTxt(M.usp))}</p>` : ""}
      ${(M.season || []).length ? `<div class="scroll"><table class="cd-t">${M.season.map(s => `<tr>${(Array.isArray(s) ? s : [s]).map(x => `<td class="l">${esc(kbTxt(x))}</td>`).join("")}</tr>`).join("")}</table></div>` : ""}
      ${(M.expect || []).length ? `<ul>${M.expect.map(x => `<li>${esc(kbTxt(x))}</li>`).join("")}</ul>` : ""}` : "";
  const own = P.map((p, i) => links[i] ? "" : `<div class="kb-link"><div class="small"><b>${esc(kbTxt(p.n))}</b> — tiada katalog (data KB sendiri)</div>
      <div class="cd-two">${(p.inc || []).length ? `<div><h4>Termasuk</h4><ul>${p.inc.map(i => `<li>${esc(kbTxt(i))}</li>`).join("")}</ul></div>` : ""}${(p.exc || []).length ? `<div><h4>Tidak termasuk</h4><ul>${p.exc.map(i => `<li>${esc(kbTxt(i))}</li>`).join("")}</ul></div>` : ""}</div></div>`).join("");
  const ownCard = own ? card("own", "Pakej tanpa katalog", "data KB sendiri — pakej lain: harga di tab Costing, itinerary &amp; termasuk / tidak termasuk di tab Itinerary", own) : "";
  return head + card("attr", "Attractions & Muslim-friendly", `${A.length} tempat`, attr ? `<div class="kb-grid">${attr}</div>` : "")
    + card("faq", "FAQ / Important Notes", "klik tajuk untuk buka", faq) + ownCard + card("blocks", "Tab KB", "Transport, Hotel, Halal, Solat, Flight, Visa, Free Gift …", bl)
    + card("mkt", "Marketing", "", mk);
}
// Simple Calculator: the KB's own calculator (same page TCs use), plus the price tiers it quotes from.
function kbCalcTab(d) {
  const x = kbDoc(d.code);
  if (x === undefined) return `<div class="card full"><div class="empty">${KB.err ? esc(KB.err) : "Loading KB…"}</div></div>`;
  if (!x) return `<div class="card full"><div class="empty">${esc(d.name)} has no Simple Calculator (no PT KB House page).</div></div>`;
  const { sl, kb, ix } = x, E = EDIT && !VIEW, links = (kb.map || {}).variants || {}, cal = kb.calc || {};
  const pkgName = l => { const dd = DATA.destinations.find(y => y.code === l.code), p = dd && dd.packages.find(y => y.id === l.package); return (dd ? dd.name + " · " : l.code + " · ") + (p ? p.label : l.package); };
  const fromCosting = (cal.variants || []).filter(v => links[v.id]);
  const tiers = (cal.variants || []).filter(v => !links[v.id]).map(v => {
    const l = null;
    return `<tr><td class="l"><b>${esc(kbTxt(v.name))}</b><div class="muted small">${l ? "Harga dari Costing: " + esc(pkgName(l)) : "KB sahaja (tiada pakej Costing)"}</div></td>
      <td class="l small">${(v.tiers || []).map(t => `${t.from === t.to ? t.from : t.from + "–" + (t.to >= 999 ? "+" : t.to)} pax: <b>${typeof t.a === "number" ? n2(t.a) : esc(String(t.a))}</b>${typeof t.c === "number" && t.c ? " / " + n2(t.c) : ""}${typeof t.n === "number" && t.n ? " / " + n2(t.n) : ""}`).join("<br>")}</td></tr>`;
  }).join("");
  const frame = `<iframe class="kb-calc" id="kbCalcFrame" data-slug="${esc(sl)}" src="${esc(ix.url)}?calc=1#calc" title="Simple Calculator ${esc(ix.name)}"></iframe>`;
  return `<div class="card full kb"><h2>Simple Calculator · ${esc(ix.name)} <span class="sub">${(cal.variants || []).length} pakej · deposit RM${esc(String(cal.deposit ?? "—"))}</span>
      <span class="right"><a class="btn" href="${esc(ix.url)}" target="_blank" rel="noopener">Buka KB</a></span></h2>
    <div class="body small muted">Kalkulator quotation yang sama seperti dalam KB (versi live). Harga tier pakej yang dipaut ke Costing ikut Catalog Price hub; nombor lain (malam/hari tambahan, transport, peak, add-on) dalam config di bawah.${E ? " Ubah config, kemudian <b>Save</b> — KB dan kalkulator dibina semula (~1–2 min)." : ""}</div>
    ${E ? "" : `<div class="body">${frame}</div>`}</div>
    <div class="card full kb" id="kb-tiers"><h2>Harga pakej kalkulator</h2><div class="body small">${fromCosting.length ? `<div>Harga dari tab <a href="#costing" data-tabmain="costing">Costing</a> (Catalog Price): ${fromCosting.map(v => `<b>${esc(kbTxt(v.name))}</b> ← ${esc(pkgName(links[v.id]))}`).join(" · ")}</div>` : ""}</div>
    ${tiers ? `<h3 class="body">Pakej KB sahaja (tiada pakej Costing) — adult / CWB / CNB per pax</h3><div class="scroll"><table class="zebra"><tbody>${tiers}</tbody></table></div>` : ""}</div>
    ${E ? `<div class="card full kb" id="kb-calc-edit"><h2>Config kalkulator (JSON) <span class="sub">${esc(sl)}/calc-config.json</span></h2><div class="body">
      <div class="small muted">Sama seperti calc-config.json KB. Mesti JSON yang sah; JSON rosak tidak diterima. Harga tier pakej yang dipaut ke Costing ditulis semula dari Costing semasa build.</div>
      <textarea class="ed kbed mono" data-kpath="${esc(JSON.stringify([sl, "calc"]))}" data-kkind="json" rows="30">${esc(JSON.stringify(cal, null, 1))}</textarea></div></div>` : ""}`;
}
// The calculator page is on the same site (prod-at22.github.io): open its Simple Calculator tab once loaded.
function kbFrameReady() {
  const f = document.getElementById("kbCalcFrame");
  if (!f || f.dataset.hooked) return; f.dataset.hooked = "1";
  f.addEventListener("load", () => { try { const w = f.contentWindow; if (typeof w.showTopic === "function") w.showTopic("calc"); } catch (_) { } });
}
function kbFilter() {
  const q = KB.q.trim().toLowerCase();
  document.querySelectorAll("[data-kbtext]").forEach(el => { const hit = !q || el.dataset.kbtext.includes(q); el.style.display = hit ? "" : "none"; if (el.tagName === "DETAILS") el.open = !!q && hit; });
}
const isKbPath = p => p[0] === "kb";
const kbPending = () => Object.keys(KB.edit).flatMap(sl => KB.docs[sl] ? diff(KB.docs[sl], KB.edit[sl]).map(c => ({ ...c, path: ["kb", sl, ...c.path] })) : []);
const kbCodesOf = sl => (KB.index && KB.index[sl] && KB.index[sl].codes) || [];
async function kbFiles(kbChanges, head, token) {
  const slugs = [...new Set(kbChanges.map(c => c.path[1]))], files = [], docs = {}, summary = [];
  for (const sl of slugs) {
    const doc = await GH.readJson(PATHS.kb + sl + ".json", head, token), mine = kbChanges.filter(c => c.path[1] === sl).map(c => ({ ...c, path: c.path.slice(2) }));
    const clash = mine.filter(c => JSON.stringify(getPath(doc, c.path)) !== JSON.stringify(c.from));
    if (clash.length) throw new Error(`Someone else changed KB ${sl} (${clash.slice(0, 2).map(c => c.path.join(" › ")).join("; ")}). Reload and re-apply.`);
    for (const c of mine) setPath(doc, c.path, c.to == null ? undefined : clone(c.to));
    docs[sl] = doc; files.push({ path: PATHS.kb + sl + ".json", content: JSON.stringify(doc, null, 1) + "\n" });
    summary.push(`KB ${sl}: ${mine.length} change${mine.length > 1 ? "s" : ""}`);
  }
  return { files, docs, summary };
}
// PT KB House (pt-kb-house) is rebuilt by its own mirror workflow; a save starts it at once.
// Needs the token to have Actions: write on pt-kb-house.
const KB_MIRROR = { repo: "prod-at22/pt-kb-house", workflow: "mirror.yml", branch: "main" };
async function startKbMirror(token) {
  try { await GH.req("POST", `/repos/${KB_MIRROR.repo}/actions/workflows/${KB_MIRROR.workflow}/dispatches`, { ref: KB_MIRROR.branch }, token); return true; }
  catch (e) { return false; }
}
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
const touchesChange = c => c.path[1] === PAGE_DEST || (c.path[0] === "kb" && kbCodesOf(c.path[1]).includes(PAGE_DEST));
const touchesDest = e => !PAGE_DEST || !(e.changes || []).length || e.changes.some(touchesChange);
function histEntry(e) {
  const src = DATA;
  if (PAGE_DEST && e.changes) e = { ...e, changes: e.changes.filter(touchesChange) };
  return `<div class="e"><div class="h"><span class="pill nav">v${e.v}</span><b>${esc(e.by)}</b><span class="muted small">${esc(fmtDate(e.at))}</span>
    <span class="small">${esc(e.note || "")}</span>
    <span style="margin-left:auto">${e.v === DATA.version ? '<span class="pill ok">current</span>' : e.v < lastRebase() ? '<span class="pill grey" title="Before a bulk import; versions before it cannot be rebuilt">before re-import</span>' : `<button class="btn" data-view="${e.v}">View v${e.v}</button>`}</span></div>
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
// Catalog content edits are tracked as paths ["catalogs", slug, …] next to the data changes.
const isCatPath = p => p[0] === "catalogs";
const catPending = () => Object.keys(CAT.edit).flatMap(sl => CAT.docs[sl] ? diff(CAT.docs[sl], CAT.edit[sl]).map(c => ({ ...c, path: ["catalogs", sl, ...c.path] })) : []);
const pendingChanges = () => [...(BASE && DATA ? diff(stripMeta(BASE), stripMeta(DATA)) : []), ...catPending(), ...kbPending()];
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

// Catalogs (data/catalogs/<slug>.json) carry no package prices: the price table is read from the Costing
// tab's Catalog Price column (resolvePrices here, catalog-build/hub_prices.py for the public page / PDF).
// On save, one commit carries: the catalog content edits, and for every catalog whose Costing prices or
// Add On items changed a new hub_version (so catalog-pt-public rebuilds it, ~10–15 min).
const catRmTxt = v => "RM" + Math.round(v).toLocaleString("en-US");
function catBandStart(label) {
  if (/night|hotel|villa|star/i.test(label)) return null;
  const n = String(label).match(/\d+/); return n ? +n[0] : null;
}
function catPackage(ix, data = DATA) {
  const d = ix && ix.package ? data.destinations.find(x => x.code === ix.code) : null;
  return d ? d.packages.find(p => p.id === ix.package) || null : null;
}
function resolvePrices(c, ix, data = DATA) {
  const pr = clone(c.prices || {}), pkg = catPackage(ix, data);
  if (!pkg || !pr.rows) return pr;
  const P = pkg.pricing, n = (pr.columns || []).length, couple = n === 1 && /couple/i.test(pr.columns[0].label || "");
  for (const row of pr.rows) {
    if (row.amounts) continue;   // literal (catalog without a Costing package)
    if (couple) { const v = P.adult["2"]; row.amounts = [v == null ? "-" : catRmTxt(2 * v)]; continue; }
    const p = catBandStart(row.pax || ""), na = new Set(row.na || []);
    row.amounts = ["adult", "cwb", "cnb"].slice(0, n).map(k => { const v = p == null ? undefined : P[k][String(p)]; return na.has(k) || v == null || v === "" ? "-" : catRmTxt(+v); });
  }
  if (typeof pr.infant === "string" && pr.infant.includes("{price}")) { const v = +P.infant || 0; pr.infant = pr.infant.replace("{price}", v === 0 ? "FOC" : catRmTxt(v)); }
  return pr;
}
async function catalogFiles(dataChanges, catChanges, next, head, token) {
  const priced = new Set(dataChanges.filter(c => c.path[0] === "destinations" && c.path[2] === "packages" && c.path[4] === "pricing").map(c => c.path[1] + "|" + c.path[3]));
  const addonDest = new Set(dataChanges.filter(c => c.path[0] === "destinations" && (c.path[2] === "addons" || c.path[2] === "hotels")).map(c => c.path[1]));
  const slugsEdited = [...new Set(catChanges.map(c => c.path[1]))];
  if (!priced.size && !addonDest.size && !slugsEdited.length) return { files: [], summary: [], docs: {} };
  const idx = await GH.readJson(PATHS.catalogs + "index.json", head, token);
  const today = new Date().toISOString().slice(0, 10), docs = {}, summary = [];
  const get = async sl => docs[sl] || (docs[sl] = await GH.readJson(PATHS.catalogs + sl + ".json", head, token));
  for (const sl of slugsEdited) {
    const cat = await get(sl), mine = catChanges.filter(c => c.path[1] === sl).map(c => ({ ...c, path: c.path.slice(2) }));
    const clash = mine.filter(c => JSON.stringify(getPath(cat, c.path)) !== JSON.stringify(c.from));
    if (clash.length) throw new Error(`Someone else changed catalog ${sl} (${clash.slice(0, 2).map(c => c.path.join(" › ")).join("; ")}). Reload and re-apply.`);
    for (const c of mine) setPath(cat, c.path, c.to == null ? undefined : clone(c.to));
    summary.push(`Catalog ${sl} content: ${mine.length} change${mine.length > 1 ? "s" : ""}`);
  }
  for (const [sl, m] of Object.entries(idx)) {
    const p = priced.has(m.code + "|" + m.package), ao = addonDest.has(m.code);
    if (!p && !ao) continue;
    const cat = await get(sl); cat.hub_version = next.version;
    summary.push(`Catalog ${sl}: ${[p && "prices", ao && "add-ons"].filter(Boolean).join(" + ")} from v${next.version}`);
  }
  const files = [];
  for (const [sl, cat] of Object.entries(docs)) {
    cat.updated = today; if (idx[sl]) { idx[sl].updated = today; idx[sl].title = cat.title; idx[sl].duration = cat.duration; idx[sl].version = cat.version; }
    files.push({ path: PATHS.catalogs + sl + ".json", content: JSON.stringify(cat, null, 2) + "\n" });
  }
  files.push({ path: PATHS.catalogs + "index.json", content: JSON.stringify(idx, null, 1) + "\n" });
  return { files, summary, docs };
}
// PT Catalog House (catalog-pt-public) is rebuilt by its mirror workflow; a save starts it at once instead of
// waiting for GitHub's (rare) schedule. Needs the token to have Actions: write on catalog-pt-public.
const MIRROR = { repo: "prod-at22/catalog-pt-public", workflow: "mirror.yml", branch: "main" };
async function startCatalogMirror(token) {
  try { await GH.req("POST", `/repos/${MIRROR.repo}/actions/workflows/${MIRROR.workflow}/dispatches`, { ref: MIRROR.branch }, token); return true; }
  catch (e) { return false; }
}
async function saveChanges(note) {
  const changes = pendingChanges();
  if (!changes.length) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await GH.head(SESSION.token);
    const remote = await GH.readJson(PATHS.data, head, SESSION.token);
    const rhist = await GH.readJson(PATHS.history, head, SESSION.token);
    const dataChanges = changes.filter(c => !isCatPath(c.path) && !isKbPath(c.path)), catChanges = changes.filter(c => isCatPath(c.path)), kbChanges = changes.filter(c => isKbPath(c.path));
    if (remote.version !== BASE.version) {
      // someone saved in between: replay our edits on top if they touched different cells
      const clash = dataChanges.filter(c => JSON.stringify(getPath(remote, c.path)) !== JSON.stringify(c.from));
      if (clash.length) throw new Error(`Another user saved v${remote.version} and changed the same cells (${clash.map(c => describe(remote, c.path)).slice(0, 3).join("; ")}). Reload and re-apply.`);
    }
    const next = applyChanges(clone(remote), dataChanges);
    next.version = remote.version + 1;
    next.updatedAt = new Date().toISOString();
    next.updatedBy = SESSION.u;
    const cat = await catalogFiles(dataChanges, catChanges, next, head, SESSION.token);
    const kbf = await kbFiles(kbChanges, head, SESSION.token);
    const entry = { v: next.version, at: next.updatedAt, by: SESSION.u, note, changes: changes.map(c => ({ ...c, label: describe(remote, c.path) })), ...(cat.summary.length ? { catalogs: cat.summary } : {}), ...(kbf.summary.length ? { kb: kbf.summary } : {}) };
    rhist.entries.push(entry);
    try {
      await GH.commit([{ path: PATHS.data, content: pretty(next) }, { path: PATHS.history, content: pretty(rhist) }, ...cat.files, ...kbf.files],
        `v${next.version} · ${SESSION.u}: ${note}`.slice(0, 200), head, SESSION.token);
    } catch (e) {
      if (e.status === 422 || e.status === 409) continue; // lost the race → retry on new head
      throw e;
    }
    BASE = next; DATA = clone(next); HISTORY = rhist;
    for (const [sl, doc] of Object.entries(cat.docs)) { CAT.docs[sl] = doc; delete CAT.edit[sl]; }
    CAT.edit = {}; if (cat.files.length) CAT.index = null;
    for (const [sl, doc] of Object.entries(kbf.docs)) KB.docs[sl] = doc;
    KB.edit = {};
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
  // Hub footer links stand in for the (hidden) top-bar buttons.
  if (t.dataset.hub) { e.preventDefault(); const b = document.getElementById({ history: "btnHistory", login: "btnLogin", logout: "btnLogout" }[t.dataset.hub]); if (b) b.click(); return; }
  if (t.dataset.href && t.tagName === "TR") { location.href = t.dataset.href; return; }
  if (t.matches("[data-close]")) return closeModal();
  if (t.id === "btnLogin") return openLogin();
  if (t.id === "doLogin") return doLogin();
  if (t.id === "doSetup") return doSetup();
  if (t.id === "btnLogout") { if (pendingChanges().length && !confirm("Discard unsaved changes?")) return; SESSION = null; EDIT = false; DATA = clone(BASE); CAT.edit = {}; KB.edit = {}; return render(); }
  if (t.id === "btnEdit") { EDIT = !EDIT; VIEW = null; return render(); }
  if (t.id === "btnAcct") return openAccount();
  if ((t.id === "btnHistory" || t.dataset.act === "history") && PAGE_DEST) { SEL.tab = "history"; history.replaceState(null, "", "#history"); return render(); }
  if (t.id === "btnHistory" || t.dataset.act === "history") return openHistory();
  if (t.id === "btnSave" || t.dataset.act === "review") return openReview();
  if (t.dataset.act === "discard") { if (confirm("Discard all unsaved changes?")) { DATA = clone(BASE); CAT.edit = {}; KB.edit = {}; render(); } return; }
  if (t.dataset.kact) {
    e.preventDefault();
    const [sl, ...path] = JSON.parse(t.dataset.kpath), doc = KB.edit[sl] ||= clone(KB.docs[sl]);
    const blank = v => typeof v === "string" ? "" : typeof v === "number" ? 0 : Array.isArray(v) ? [] : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)])) : v;
    if (t.dataset.kact === "add") { const arr = getPath(doc, path); arr.push(arr.length ? blank(arr[arr.length - 1]) : ""); }
    if (t.dataset.kact === "del") { const arr = getPath(doc, path.slice(0, -1)), i = path[path.length - 1]; if (confirm("Buang item #" + (i + 1) + "?")) arr.splice(i, 1); }
    return render();
  }
  if (t.dataset.catact) {
    const [sl, ...path] = JSON.parse(t.dataset.cpath), doc = CAT.edit[sl] ||= clone(CAT.docs[sl]), days = getPath(doc, path);
    if (t.dataset.catact === "addday") days.push({ day: days.length + 1, title: "", activities: [], transport: "", meals: "", hotel: "" });
    if (t.dataset.catact === "delday" && days.length && confirm("Remove day " + days.length + "?")) days.pop();
    return render();
  }
  if (t.dataset.act === "addHotel" || t.dataset.act === "delHotel") {
    const d = DATA.destinations.find(x => x.code === PAGE_DEST);
    if (t.dataset.act === "addHotel") {
      d.hotels = d.hotels || [];
      const n = 1 + Math.max(0, ...d.hotels.map(h => +(/-h(\d+)$/.exec(h.id) || [0, 0])[1]));
      d.hotels.push({ id: d.code.toLowerCase() + "-h" + String(n).padStart(2, "0"), name: "", catalogs: {} });
    } else {
      const h = d.hotels.find(x => x.id === t.dataset.id), used = Object.keys(h.catalogs || {});
      if (!confirm("Delete " + (h.name || "this hotel") + "?" + (used.length ? " It is printed in: " + used.join(", ") + "." : ""))) return;
      d.hotels = d.hotels.filter(x => x !== h);
    }
    return render();
  }
  if (t.dataset.act === "addAddon") {
    const d = DATA.destinations.find(x => x.code === PAGE_DEST), v = id => $("#" + id).value.trim();
    const label = v("aoLabel"), category = v("aoCat") || "Other";
    if (!label) return toast("Item name is required");
    const n = id => (+(String(id).match(/-n(\d+)$/) || [])[1]) || 0;
    const id = d.code.toLowerCase() + "-n" + String(1 + Math.max(0, ...(d.addons || []).map(a => n(a.id)))).padStart(3, "0");
    const num_ = id => v(id) === "" ? null : Number(v(id));
    const a = { id, category, label, per: v("aoPer"), cost: num_("aoCost"), selling: num_("aoSell"), notes: null, price_lines: [] };
    if ([a.cost, a.selling].some(x => x !== null && !isFinite(x))) return toast("Cost / selling must be numbers");
    const cats = {};
    for (const cb of document.querySelectorAll(".aoAddTick")) if (cb.checked) cats[cb.value] = 1 + Math.max(0, ...(d.addons || []).map(x => (x.catalogs || {})[cb.value] || 0));
    if (Object.keys(cats).length) { a.catalogs = cats; if (a.selling !== null) a.price_lines = [catRmTxt(a.selling) + (a.per ? "/" + a.per : "")]; }
    (d.addons ||= []).push(a); SEL.aoCat = category;
    toast(`Added "${label}" — press Save to keep it`); return render();
  }
  if (t.dataset.act === "delAddon") {
    const d = DATA.destinations.find(x => x.code === PAGE_DEST), a = (d.addons || []).find(x => x.id === t.dataset.id);
    if (!a) return;
    const inCats = Object.keys(a.catalogs || {});
    if (!confirm(`Delete "${a.label}"?` + (inCats.length ? `\n\nIt is printed in ${inCats.length} catalog${inCats.length > 1 ? "s" : ""} (${inCats.join(", ")}) and will be removed from ${inCats.length > 1 ? "them" : "it"}.` : "") + "\n\nNothing is saved until you press Save.")) return;
    d.addons = d.addons.filter(x => x.id !== a.id); delete SEL.addonQty[a.id];
    toast(`Deleted "${a.label}" — press Save to keep it, or Discard to undo`); return render();
  }
  if (t.dataset.act === "viewCurrent") { VIEW = null; return render(); }
  if (t.dataset.act === "restore") {
    const snap = VIEW.data, v = VIEW.v;
    DATA = clone(BASE);
    for (const c of diff(stripMeta(BASE), stripMeta(snap))) setPath(DATA, c.path, c.to === undefined ? undefined : clone(c.to));   // undefined = field not in that version
    VIEW = null; EDIT = true; render(); openReview("Restore to v" + v); return;
  }
  if (t.dataset.view) { const v = +t.dataset.view; VIEW = { v, data: snapshotAt(v) }; EDIT = false; closeModal(); render(); window.scrollTo(0, 0); return; }
  if (t.dataset.ref) { SEL.showRef = !SEL.showRef; return render(); }
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
    try {
      const v = await saveChanges(note); closeModal(); EDIT = false; render();
      const started = await startCatalogMirror(SESSION.token), kbStarted = await startKbMirror(SESSION.token);
      toast("Saved as v" + v + " — the live page updates in about a minute. " + (started ? "PT Catalog House rebuilds the affected catalogs in about 3–5 minutes."
        : "PT Catalog House could not be started from here (the token needs Actions: write on catalog-pt-public); it updates at the next scheduled mirror.") + (kbStarted ? " PT KB House rebuilds in about 1–2 minutes." : " PT KB House could not be started from here (the token needs Actions: write on pt-kb-house)."), 7000);
    }
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
  if (e.target.id === "kbq") { KB.q = e.target.value; kbFilter(); }
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
  if (t.dataset && t.dataset.htick) {   // Accommodation: tick a hotel for a catalog's Accommodation / Surcharge table
    const { code, id, slug, kind } = JSON.parse(t.dataset.htick), d = DATA.destinations.find(x => x.code === code), h = d.hotels.find(x => x.id === id);
    const cur = { ...((h.catalogs || {})[slug] || {}) };
    if (t.checked) {
      cur[kind] = 1 + Math.max(0, ...d.hotels.map(x => ((x.catalogs || {})[slug] || {})[kind] || 0));
      if (kind === "sur") cur.amounts = cur.amounts || (((CAT.docs[slug] || {}).surcharge || {}).columns || []).map(() => "-");
    } else { delete cur[kind]; if (kind === "sur") delete cur.amounts; }
    const all = { ...(h.catalogs || {}) };
    if (Object.keys(cur).length) all[slug] = cur; else delete all[slug];
    h.catalogs = all;
    return render();
  }
  if (t.dataset && t.dataset.khotel) {
    const { sl, path, id } = JSON.parse(t.dataset.khotel), doc = KB.edit[sl] ||= clone(KB.docs[sl]), arr = getPath(doc, path);
    const i = arr.indexOf(id); if (t.checked && i < 0) arr.push(id); if (!t.checked && i >= 0) arr.splice(i, 1);
    return render();
  }
  if (t.dataset && t.dataset.hsim) {
    const { code, id } = JSON.parse(t.dataset.hsim), h = DATA.destinations.find(x => x.code === code).hotels.find(x => x.id === id);
    if (t.checked) h.similar = true; else delete h.similar;
    return render();
  }
  if (t.dataset && t.dataset.tick) {
    const { code, id, slug } = JSON.parse(t.dataset.tick), d = DATA.destinations.find(x => x.code === code), a = d.addons.find(x => x.id === id);
    const cur = { ...(a.catalogs || {}) };
    if (t.checked) cur[slug] = 1 + Math.max(0, ...d.addons.map(x => (x.catalogs || {})[slug] || 0));
    else delete cur[slug];
    if (Object.keys(cur).length) a.catalogs = cur; else delete a.catalogs;
    return render();
  }
  if (t.dataset && t.dataset.kpath && t.dataset.kact === undefined) {
    const [sl, ...path] = JSON.parse(t.dataset.kpath), doc = KB.edit[sl] ||= clone(KB.docs[sl]), k = t.dataset.kkind;
    let v = t.value;
    if (k === "num") { v = Number(v); if (t.value.trim() === "" || !isFinite(v)) return toast("Not a number"); }
    if (k === "lines") v = String(v).split("\n").map(x => x.trim()).filter(Boolean);
    if (k === "pairs") v = String(v).split("\n").filter(x => x.trim()).map(x => x.split("|").map(y => y.trim()));
    if (k === "json") { try { v = JSON.parse(v); } catch (err) { return toast("JSON tidak sah — tidak diterima: " + err.message, 6000); } if (!v || !Array.isArray(v.variants) || !v.variants.every(x => x && x.id && Array.isArray(x.tiers))) return toast("Config mesti ada variants[] dengan id dan tiers — tidak diterima", 6000); }
    setPath(doc, path, v);
    setTimeout(() => {
      const nx = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.kpath : null;
      render();
      if (nx) { const el = [...document.querySelectorAll("[data-kpath]")].find(x => x.dataset.kpath === nx && x.dataset.kact === undefined); if (el) el.focus(); }
    }, 0);
    return;
  }
  if (t.dataset && t.dataset.cpath && t.dataset.catact === undefined) {
    const [sl, ...path] = JSON.parse(t.dataset.cpath), doc = CAT.edit[sl] ||= clone(CAT.docs[sl]);
    setPath(doc, path, t.dataset.ckind === "lines" ? catParseLines(t.value) : t.value);
    setTimeout(() => {
      const nx = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.cpath : null;
      render();
      if (nx) { const el = [...document.querySelectorAll("[data-cpath]")].find(x => x.dataset.cpath === nx && x.dataset.catact === undefined); if (el) el.focus(); }
    }, 0);
    return;
  }
  if (t.dataset && t.dataset.path) {
    const path = JSON.parse(t.dataset.path);
    let v = t.value;
    if (t.dataset.kind === "num") { if (v.trim() === "") return; v = Number(v); if (!isFinite(v)) return toast("Not a number"); }
    if (t.dataset.kind === "lines") v = String(v).split("\n").map(x => x.trim()).filter(Boolean);
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

if (SEL.tab === "catalog") SEL.tab = "itinerary";
window.addEventListener("hashchange", () => { const h = location.hash.slice(1) === "catalog" ? "itinerary" : location.hash.slice(1); if (TABS.some(t => t[0] === h) && h !== SEL.tab) { SEL.tab = h; render(); } });
window.PTCALC = { priceRow, variantCost, diff, applyChanges, snapshotAt, describe, get DATA() { return DATA; }, get BASE() { return BASE; }, GH, SEL, render, saveChanges, set SESSION(s) { SESSION = s; }, set EDIT(v) { EDIT = v; }, get HISTORY() { return HISTORY; }, unlock, wrapVault, aesEnc, setUsers(u) { USERS = u; } };
load().catch(() => { });
