"use strict";
/* ============================================================ config
   REPO is the GitHub repository this page saves to. Viewing needs nothing;
   saving needs a username/password whose entry in data/users.json unlocks
   the repo token (see README). */
const REPO = { owner: "prod-at22", name: "pt-calculator-hub", branch: "main" };
const ROOT = window.PT_ROOT || "";          // "../" on /<code>/ pages
const PAGE_DEST = window.PT_DEST || null;   // destination code, null on the hub
const PATHS = { data: "data/data.json", history: "data/history.json", users: "data/users.json" };
const KDF_ITER = 310000;
const IDLE_LOGOUT_MS = 30 * 60 * 1000;

/* ============================================================ state */
let DATA = null;      // working copy (may contain unsaved edits)
let BASE = null;      // last loaded / saved version
let HISTORY = { entries: [] };
let USERS = { users: [] };
let SESSION = null;   // {u, role, token, key}
let EDIT = false;
let VIEW = null;      // {v, data} when viewing an older version
const SEL = { dest: null, pkg: new URLSearchParams(location.search).get("pkg"), variant: "auto", adult: 2, cwb: 0, cnb: 0, infant: 0, bandOverride: "", paxTab: "adult", addonQty: {} };
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
  for (const c of list) setPath(obj, c.path, clone(reverse ? c.from : c.to) ?? undefined);
  return obj;
}
// Human label for a change path, resolved against a snapshot.
function describe(snap, path) {
  const parts = []; let cur = snap;
  const LBL = { value: "", rates: "Rate", fx: "FX", tables: "Table", packages: "", variants: "TO", pricing: "", rules: "Rule",
    adult: "Adult catalog", cwb: "CWB catalog", cnb: "CNB catalog", infant: "Infant price", discountTier2: "Discount tier 2",
    tierUpgrade: "Tier upgrade", cwbCost: "CWB cost", cnbCost: "CNB cost", infantCost: "Infant cost", type: "type",
    components: "Component", expr: "formula", values: "", settings: "Settings", marginWarnPct: "Margin warn %", marginDangerPct: "Margin danger %",
    destinations: "", nights: "Nights", po: "PO", assign: "TO assignment" };
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
  const f = new Function("R", "T", "N", "pax", "band", "min", "max", "ceil", "floor", "round", '"use strict";return (' + expr + ");");
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
function variantCost(d, v, pax) {
  if (!v || pax < v.paxMin || pax > v.paxMax) return null;
  const R = rateProxy(d), T = tableProxy(d, pax), N = +d.nights;
  const comps = v.components.map(c => {
    let val, err = null;
    try { val = +compile(c.expr)(R, T, N, pax, band, Math.min, Math.max, Math.ceil, Math.floor, Math.round); }
    catch (e) { val = NaN; err = e.message; }
    const group = c.per === "group" ? val : val * pax;
    return { ...c, group, perPax: group / pax, err };
  });
  const total = comps.reduce((s, c) => s + c.perPax, 0);
  return { comps, total: num(total) ? total : NaN, ok: comps.every(c => num(c.perPax)) };
}
const assignedVariantId = (pkg, pax) => (pkg.assign.find(a => pax >= a.from && pax <= a.to) || {}).variant;
function applyRule(rule, base) {
  if (!rule || !num(base)) return NaN;
  const v = +rule.value;
  return rule.type === "pct" ? base * v : rule.type === "minus" ? base - v : v;
}
const priceAt = (pkg, k, pax) => { const v = pkg.pricing[k]?.[String(pax)]; return v === undefined || v === null || v === "" ? NaN : +v; };
// One row of the R&D Costing tab: cost / catalog / selling / margin for each pax type.
function priceRow(d, pkg, variantId, pax) {
  const v = d.variants.find(x => x.id === variantId);
  const cost = variantCost(d, v, pax);
  const adultCost = cost ? cost.total : NaN, r = pkg.rules;
  const up = +r.tierUpgrade || 0, disc = +r.discountTier2 || 0;
  const mk = (costV, catV, noDisc) => {
    const catalog = num(catV) ? catV + (noDisc ? 0 : up) : NaN;
    const selling = num(catalog) ? catalog - (noDisc ? 0 : disc) : NaN;
    const margin = selling - costV;
    return { cost: costV, catalog, selling, margin: num(margin) ? margin : NaN, pct: num(margin) && selling ? margin / selling : NaN };
  };
  return {
    pax, variant: v, cost,
    adult: mk(adultCost, priceAt(pkg, "adult", pax)),
    cwb: mk(applyRule(r.cwbCost, adultCost), priceAt(pkg, "cwb", pax)),
    cnb: mk(applyRule(r.cnbCost, adultCost), priceAt(pkg, "cnb", pax)),
    infant: mk(applyRule(r.infantCost, adultCost), +pkg.pricing.infant, true),
  };
}
function marginClass(p) {
  const s = shown().settings || {};
  if (!num(p)) return "";
  return p < (s.marginDangerPct ?? .05) ? "m-bad" : p < (s.marginWarnPct ?? .15) ? "m-warn" : "m-ok";
}
function marginPill(p) {
  const c = marginClass(p); if (!c) return '<span class="pill grey">—</span>';
  return `<span class="pill ${c === "m-ok" ? "ok" : c === "m-warn" ? "warn" : "bad"}">${pct(p)}</span>`;
}

/* ============================================================ selection helpers */
const curDest = () => shown().destinations.find(d => d.code === SEL.dest) || shown().destinations[0];
const curPkg = d => d.packages.find(p => p.id === SEL.pkg) || d.packages[0];
const bandPax = () => SEL.bandOverride !== "" && +SEL.bandOverride > 0 ? +SEL.bandOverride : (SEL.adult + SEL.cwb + SEL.cnb);
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
  if (!PAGE_DEST) return renderHub();
  const d = shown().destinations.find(x => x.code === PAGE_DEST);
  if (!d) {
    $("#controls").style.display = "none"; $("#kpis").innerHTML = "";
    $("#grid").innerHTML = `<div class="card full"><div class="empty">No destination with code <b>${esc(PAGE_DEST)}</b>${VIEW ? " in v" + VIEW.v : ""}. <a href="${ROOT}">See all destinations</a></div></div>`;
    return;
  }
  SEL.dest = d.code;
  const pkg = curPkg(d); SEL.pkg = pkg.id;
  renderControls(d, pkg); renderMain(d, pkg);
}
// Hub: one row per package — name (links to its page), PO, last update.
// Last update = newest saved change to that package or to its destination's shared costs
// (rates, FX, TOs, add-ons); before any save it is the import date.
function lastUpdate(d, pkgId) {
  const hit = c => c.path[1] === d.code && (c.path[2] !== "packages" || c.path[3] === pkgId);
  const es = HISTORY.entries.filter(e => (e.changes || []).some(hit)).sort((a, b) => b.v - a.v);
  return es[0] || [...HISTORY.entries].sort((a, b) => a.v - b.v)[0] || null;
}
function renderHub() {
  $("#controls").style.display = "none"; $("#kpis").innerHTML = "";
  const rows = shown().destinations.flatMap(d => d.packages.map(pkg => {
    const e = lastUpdate(d, pkg.id), href = `${ROOT}${d.code.toLowerCase()}/?pkg=${encodeURIComponent(pkg.id)}`;
    return `<tr class="click" data-href="${href}"><td><a href="${href}">${esc(pkg.label)}</a> <span class="pill nav">${esc(d.code)}</span></td><td class="l">${esc(d.po || "—")}</td>
      <td class="l">${e ? esc(new Date(e.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })) + (e.v > 1 ? ` <span class="muted small">v${e.v} · ${esc(e.by)}</span>` : ' <span class="muted small">import</span>') : "—"}</td></tr>`;
  })).join("");
  $("#grid").innerHTML = `<div class="card full hub"><div class="scroll"><table><thead><tr><th>Package</th><th class="l">PO</th><th class="l">Last update</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function renderTop() {
  const src = shown();
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
function renderControls(d, pkg) {
  $("#controls").style.display = "";
  const pax = bandPax();
  const variants = d.variants;
  const autoId = assignedVariantId(pkg, pax);
  $("#controls").innerHTML = `
    <div style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--ink-soft)">Destination
      <div style="font-size:16px;color:var(--ink)">${esc(d.name)} <span class="pill nav">${esc(d.code)}</span></div>
      <span>PO: ${ed(["destinations", d.code, "po"], d.po || "", { text: true, display: esc(d.po || "—") })}</span>
      <a href="${ROOT}" style="font-weight:600">← All destinations</a></div>
    <label class="wide">Package<select id="selPkg">${d.packages.map(p => `<option value="${p.id}"${p.id === pkg.id ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
    <label class="wide">Tour operator<select id="selVar">
      <option value="auto"${SEL.variant === "auto" ? " selected" : ""}>Auto by pax → ${esc(autoId || "none")}</option>
      ${variants.map(v => `<option value="${v.id}"${SEL.variant === v.id ? " selected" : ""}>${esc(v.label)} [${v.paxMin}–${v.paxMax}]</option>`).join("")}
    </select></label>
    <div class="wide" style="font-size:12px;font-weight:600;color:var(--ink-soft);display:flex;flex-direction:column;gap:4px">Pax<div class="paxrow">
      ${[["adult", "Adult"], ["cwb", "CWB"], ["cnb", "CNB"], ["infant", "Infant"]].map(([k, l]) => `<span><input type="number" min="0" max="99" id="pax_${k}" value="${SEL[k]}" aria-label="${l}">${l}</span>`).join("")}
    </div></div>
    <label>Pricing band (pax)<input type="number" min="1" id="bandOv" placeholder="${SEL.adult + SEL.cwb + SEL.cnb} (auto)" value="${SEL.bandOverride}"></label>`;
}
function renderMain(d, pkg) {
  const pax = bandPax();
  const vid = activeVariantId(pkg, pax);
  const row = priceRow(d, pkg, vid, pax);
  const v = row.variant;
  // ---- KPIs (group quote)
  const lines = ["adult", "cwb", "cnb", "infant"].map(k => ({ k, q: SEL[k], r: row[k] })).filter(x => x.q > 0);
  const tot = lines.reduce((s, x) => ({ sell: s.sell + x.q * x.r.selling, cost: s.cost + x.q * x.r.cost }), { sell: 0, cost: 0 });
  const ao = addonTotals(d);
  tot.sell += ao.sell; tot.cost += ao.cost;
  const tm = tot.sell - tot.cost, tp = tot.sell ? tm / tot.sell : NaN;
  $("#kpis").innerHTML = `
    <div class="kpi"><div class="l">Selling / adult</div><div class="v">${rm(row.adult.selling)}</div><div class="s">Catalog ${rm(row.adult.catalog)}${+pkg.rules.discountTier2 ? ` − tier-2 ${rm(+pkg.rules.discountTier2)}` : ""}</div></div>
    <div class="kpi"><div class="l">Cost / adult</div><div class="v">${rm(row.adult.cost, 2)}</div><div class="s">${esc(v ? v.label : "No TO for " + pax + " pax")}</div></div>
    <div class="kpi"><div class="l">Margin / adult</div><div class="v ${marginClass(row.adult.pct)}">${rm(row.adult.margin)}</div><div class="s">${pct(row.adult.pct)} of selling</div></div>
    <div class="kpi"><div class="l">Group total (${lines.reduce((s, x) => s + x.q, 0)} pax${ao.n ? " + " + ao.n + " add-on" + (ao.n > 1 ? "s" : "") : ""})</div><div class="v">${rm(tot.sell)}</div><div class="s">Cost ${rm(tot.cost)} · Margin <b class="${marginClass(tp)}">${rm(tm)} (${pct(tp)})</b>${ao.missing ? `<br><span class="m-bad">${ao.missing} add-on(s) without cost — margin overstated</span>` : ""}</div></div>`;

  const cards = [];
  // ---- cost breakdown
  cards.push(`<div class="card"><h2>Cost breakdown <span class="sub">${esc(v ? v.label : "—")} · ${pax} pax</span></h2>
    ${!v ? `<div class="empty">No tour operator covers ${pax} pax for this package.</div>` : !row.cost ? `<div class="empty">${esc(v.label)} only covers ${v.paxMin}–${v.paxMax} pax.</div>` : `
    <div class="scroll"><table><thead><tr><th>Component</th><th class="l">How it's costed</th><th>Group</th><th>Per pax</th></tr></thead><tbody>
    ${row.cost.comps.map(c => `<tr><td>${esc(c.label)}${c.err ? ` <span class="pill bad" title="${esc(c.err)}">formula error</span>` : ""}</td><td class="expr">${esc(c.expr)}${c.per === "pax" ? " <i>per pax</i>" : ""}</td><td>${rm(c.group, 2)}</td><td>${rm(c.perPax, 2)}</td></tr>`).join("")}
    <tr class="total"><td>Total cost</td><td></td><td>${rm(row.cost.total * pax, 2)}</td><td>${rm(row.cost.total, 2)}</td></tr>
    </tbody></table></div>`}
    ${v ? `<div class="note"><b>Hotel:</b> ${esc(v.hotel || "—")}<br><b>TO note:</b> ${esc(v.notes || "—")}</div>` : ""}
    ${d.note ? `<div class="note">${esc(d.note)}</div>` : ""}
  </div>`);
  // ---- selling & margin per pax type
  const types = [["adult", "Adult"], ["cwb", "Child with bed"], ["cnb", "Child no bed"], ["infant", "Infant"]];
  const r = pkg.rules, P = ["packages", pkg.id, "rules"], DP = ["destinations", d.code];
  const ruleTxt = (rule, key) => EDIT && !VIEW
    ? `${ed([...DP, ...P, key, "type"], rule.type, { options: [["pct", "% of adult cost"], ["minus", "adult cost − RM"], ["flat", "flat RM"]] })} ${ed([...DP, ...P, key, "value"], rule.value)}`
    : rule.type === "pct" ? `${n2(rule.value * 100, 1)}% of adult cost` : rule.type === "minus" ? `adult cost − RM${n2(rule.value)}` : `flat RM${n2(rule.value)}`;
  cards.push(`<div class="card"><h2>Selling price &amp; margin <span class="sub">${esc(pkg.label)} · band ${pax} pax</span>
    ${pkg.catalog ? `<span class="right"><a class="pill nav" href="${esc(pkg.catalog.url)}" target="_blank" rel="noopener">Catalog ${esc(pkg.catalog.version || "")} ↗</a></span>` : `<span class="right"><span class="pill grey" title="No published catalog — prices from R&D sheet">R&amp;D price only</span></span>`}</h2>
    <div class="scroll"><table><thead><tr><th>Pax type</th><th>Qty</th><th>Cost/pax</th><th>Catalog</th><th>Selling/pax</th><th>Margin/pax</th><th>Margin %</th><th>Line selling</th><th>Line margin</th></tr></thead><tbody>
    ${types.map(([k, lbl]) => { const x = row[k]; const q = SEL[k];
      return `<tr${q ? "" : ' style="color:var(--muted)"'}><td>${lbl}</td><td>${q}</td><td>${rm(x.cost, 2)}</td><td>${rm(x.catalog)}</td><td>${rm(x.selling)}</td><td class="${marginClass(x.pct)}">${rm(x.margin)}</td><td>${marginPill(x.pct)}</td><td>${q ? rm(q * x.selling) : ""}</td><td class="${marginClass(x.pct)}">${q ? rm(q * x.margin) : ""}</td></tr>`; }).join("")}
    <tr class="total"><td>Total</td><td>${lines.reduce((s, x) => s + x.q, 0)}</td><td></td><td></td><td></td><td></td><td>${marginPill(tp)}</td><td>${rm(tot.sell)}</td><td class="${marginClass(tp)}">${rm(tm)}</td></tr>
    </tbody></table></div>
    <div class="note">
      <b>Rules</b> · CWB cost: ${ruleTxt(r.cwbCost, "cwbCost")} · CNB cost: ${ruleTxt(r.cnbCost, "cnbCost")} · Infant cost: ${ruleTxt(r.infantCost, "infantCost")}<br>
      Selling = catalog + tier upgrade ${ed([...DP, ...P, "tierUpgrade"], r.tierUpgrade, { display: "RM" + n2(r.tierUpgrade) })} − discount tier 2 ${ed([...DP, ...P, "discountTier2"], r.discountTier2, { display: "RM" + n2(r.discountTier2) })} · Infant price ${ed([...DP, "packages", pkg.id, "pricing", "infant"], pkg.pricing.infant, { display: "RM" + n2(pkg.pricing.infant) })} flat
    </div></div>`);
  // ---- TO comparison
  const cmp = d.variants.map(x => ({ x, c: variantCost(d, x, pax) })).filter(o => o.c);
  cards.push(`<div class="card"><h2>Tour operator comparison <span class="sub">adult, ${pax} pax, against ${esc(pkg.label)} selling ${rm(row.adult.selling)}</span></h2>
    ${cmp.length ? `<div class="scroll"><table><thead><tr><th>Tour operator</th><th>Cost/pax</th><th>Δ vs in use</th><th>Margin/pax</th><th>Margin %</th><th></th></tr></thead><tbody>
    ${cmp.map(({ x, c }) => { const m = row.adult.selling - c.total; const p = row.adult.selling ? m / row.adult.selling : NaN; const inUse = v && x.id === v.id;
      const dl = row.cost ? c.total - row.cost.total : NaN;
      return `<tr class="click${inUse ? " cur" : ""}" data-variant="${esc(x.id)}"><td>${esc(x.label)}${x.id === assignedVariantId(pkg, pax) ? ' <span class="pill nav">package default</span>' : ""}</td><td>${rm(c.total, 2)}</td><td>${inUse ? "—" : (num(dl) ? (dl > 0 ? "+" : "") + rm(dl, 2) : "—")}</td><td class="${marginClass(p)}">${rm(m)}</td><td>${marginPill(p)}</td><td>${inUse ? '<span class="pill ok">in use</span>' : '<span class="muted small">click to use</span>'}</td></tr>`; }).join("")}
    </tbody></table></div><div class="note">Compares each TO's cost with this package's selling price. A TO built for a different tier (e.g. Self Tour) is not a like-for-like product.</div>` : `<div class="empty">No TO has a rate for ${pax} pax.</div>`}
  </div>`);
  // ---- costing by pax: A+B+C+D = Cost, + Margin = Selling
  cards.push(costingByPax(d, pkg, pax));
  cards.push(addonCard(d));
  // ---- rate card
  cards.push(rateCard(d));
  cards.push(historyCard());
  $("#grid").innerHTML = cards.join("");
}
// Component columns for a package: union of components across the TOs it uses, in order.
function pkgComponents(d, pkg) {
  const ids = [...new Set([...pkg.assign.map(a => a.variant), ...(SEL.variant !== "auto" ? [SEL.variant] : [])])];
  const out = [];
  for (const id of ids) { const v = d.variants.find(x => x.id === id); if (v) for (const c of v.components) if (!out.some(o => o.key === c.key)) out.push({ key: c.key, label: c.label }); }
  return out;
}
// Same layout as the R&D sheet: one block per TO (title + header), component columns are
// GROUP totals in RM, then Cost/Pax = sum ÷ pax, Selling, Margin RM / %, Total Gross = margin × pax.
function costingByPax(d, pkg, pax) {
  const k = SEL.paxTab, DP = ["destinations", d.code];
  const comps = pkgComponents(d, pkg);
  const paxList = Object.keys(pkg.pricing.adult).map(Number).sort((a, b) => a - b);
  const src = pkg.pricing.source || {};
  const int = v => num(v) ? Math.round(v).toLocaleString("en-MY") : '<span class="missing">—</span>';
  const ruleTxt = rule => rule.type === "pct" ? `${n2(rule.value * 100, 1)}% of adult cost` : rule.type === "minus" ? `adult cost − RM${n2(rule.value)}` : `flat RM${n2(rule.value)}`;
  const isAdult = k === "adult";
  const nCols = isAdult ? 1 + comps.length + 7 : 1 + 1 + 6;
  // consecutive pax rows with the same TO form one block
  const blocks = [];
  for (const p of paxList) {
    const pr = priceRow(d, pkg, activeVariantId(pkg, p), p), id = pr.variant ? pr.variant.id : "—";
    if (!blocks.length || blocks[blocks.length - 1].id !== id) blocks.push({ id, v: pr.variant, rows: [] });
    blocks[blocks.length - 1].rows.push(pr);
  }
  const body = blocks.map(bl => {
    const has = new Set(bl.v ? bl.v.components.map(c => c.key) : []);
    const title = `<tr class="blk-title"><td colspan="${nCols}">${esc(pkg.label.toUpperCase())} / ${esc(bl.v ? bl.v.label : "no TO")}${isAdult ? "" : ` <span class="muted">· ${k.toUpperCase()} cost = ${esc(ruleTxt(pkg.rules[k + "Cost"]))}</span>`}</td></tr>`;
    const head = `<tr class="blk-head"><th>${isAdult ? "Adult" : k.toUpperCase() + " · pax"}</th>${isAdult
      ? comps.map(c => `<th>${has.has(c.key) ? esc(c.label) : ""}</th>`).join("")
      : `<th>Adult cost/pax</th>`}<th>Cost/Pax</th><th class="sp">Selling Price</th><th class="mg">Margin</th><th class="mg">%</th>${isAdult ? `<th>Total Gross</th>` : ""}<th>Catalog</th><th>Source</th></tr>`;
    const rows = bl.rows.map(pr => {
      const p = pr.pax, x = pr[k];
      const cells = isAdult
        ? comps.map(c => { if (!has.has(c.key)) return "<td></td>"; const cc = pr.cost && pr.cost.comps.find(o => o.key === c.key); return `<td title="RM${cc ? n2(cc.group, 2) : "—"} group · RM${cc ? n2(cc.perPax, 2) : "—"} per pax">${int(cc && cc.group)}</td>`; }).join("")
        : `<td class="muted">${int(pr.adult.cost)}</td>`;
      return `<tr class="click${p === pax ? " cur" : ""}" data-pax="${p}"><td class="c"><b>${p}</b></td>${cells}
        <td><b>${int(x.cost)}</b></td><td class="sp"><b>${int(x.selling)}</b></td><td class="mg ${marginClass(x.pct)}"><b>${int(x.margin)}</b></td><td class="mg ${marginClass(x.pct)}">${num(x.pct) ? Math.round(x.pct * 100) + "%" : "—"}</td>
        ${isAdult ? `<td><b>${int(x.margin * p)}</b></td>` : ""}
        <td>${ed([...DP, "packages", pkg.id, "pricing", k, String(p)], pkg.pricing[k][String(p)], { display: int(x.catalog - (+pkg.rules.tierUpgrade || 0)) })}</td>
        <td class="c">${(src[k] || {})[String(p)] === "catalog" ? '<span class="pill nav">catalog</span>' : '<span class="pill grey" title="Not printed in the catalog — from R&D Costing tab">R&amp;D</span>'}</td></tr>`;
    }).join("");
    return title + head + rows;
  }).join("");
  return `<div class="card full" id="costPax"><h2>Costing by pax <span class="sub">${esc(pkg.label)} · RM</span>
    <span class="right tabs">${["adult", "cwb", "cnb"].map(t => `<button class="tab${t === k ? " on" : ""}" data-tab="${t}">${t.toUpperCase()}</button>`).join("")}</span></h2>
    <div class="scroll" style="max-height:640px;overflow-y:auto"><table class="rd">${body}</table></div>
    <div class="note">${isAdult ? "Component columns are for the whole group. Cost/Pax = sum of components ÷ pax. Margin = Selling − Cost/Pax. Total Gross = Margin × pax." : "Cost/Pax comes from the adult cost by the rule above. Margin = Selling − Cost/Pax."} Selling = catalog + tier upgrade − discount tier 2. Hover a component for exact RM. Click a row to quote that pax count.</div></div>`;
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
  return `<div class="card full" id="addons"><h2>Add-ons <span class="sub">${list.length} items · from R&D Add-Ons tab · enter qty to add to the group total</span></h2>
    <div class="scroll" style="max-height:520px;overflow-y:auto"><table><thead><tr><th>Item</th><th class="l">Per</th><th>Cost</th><th>Selling</th><th>Margin</th><th>Margin %</th><th>Qty</th><th>Line selling</th><th>Line margin</th><th class="l">Category</th><th class="l">Notes</th></tr></thead><tbody>
    ${list.map(a => {
      const c = num(a.cost) ? a.cost : NaN, sv = num(a.selling) ? a.selling : NaN, m = sv - c, p = num(m) && sv ? m / Math.abs(sv) : NaN;
      const q = +SEL.addonQty[a.id] || 0;
      return `<tr${q ? ' class="cur"' : ""}><td style="white-space:normal;min-width:200px">${esc(a.label)}</td><td class="l muted">${esc(a.per || "")}</td>
        <td>${ed([...DP, "addons", a.id, "cost"], a.cost, { display: num(a.cost) ? rm(a.cost, 2) : '<span class="pill bad" title="No cost in the R&D sheet">cost?</span>' })}</td>
        <td>${ed([...DP, "addons", a.id, "selling"], a.selling, { display: rm(sv, 2) })}</td>
        <td class="${marginClass(p)}">${rm(m, 2)}</td><td>${marginPill(p)}</td>
        <td><input type="number" min="0" max="999" class="aq" data-addon="${esc(a.id)}" value="${q || ""}" placeholder="0" style="width:58px;text-align:right;border:1px solid var(--line);border-radius:5px;padding:3px 5px"></td>
        <td>${q ? rm(q * sv, 2) : ""}</td><td class="${marginClass(p)}">${q ? rm(q * m, 2) : ""}</td><td class="l muted">${esc(a.category || "")}</td><td class="l small muted" style="white-space:normal;min-width:160px">${esc(a.notes || "")}</td></tr>`;
    }).join("")}
    ${t.n ? `<tr class="total"><td>Selected add-ons</td><td></td><td>${rm(t.cost, 2)}</td><td>${rm(t.sell, 2)}</td><td>${rm(tm, 2)}</td><td>${marginPill(t.sell ? tm / t.sell : NaN)}</td><td></td><td>${rm(t.sell, 2)}</td><td>${rm(tm, 2)}</td><td></td><td></td></tr>` : ""}
    </tbody></table></div><div class="note">Qty is for this quote only and is not saved. Negative rows are deductions (e.g. "Tolak"). Add-ons without a cost show <span class="pill bad">cost?</span>; their margin cannot be computed.</div></div>`;
}
function rateCard(d) {
  const DP = ["destinations", d.code];
  const groups = {};
  d.rates.forEach(r => (groups[r.group || "Rates"] ||= []).push(r));
  const isAdmin = SESSION && SESSION.role === "admin";
  return `<div class="card full"><h2>Rate card · ${esc(d.name)} <span class="sub">source: ${esc(d.source)}</span>${EDIT && !VIEW ? "" : '<span class="right"><span class="pill grey">log in → Edit costs to change</span></span>'}</h2>
  <div class="body small">
    <b>FX</b> ${d.fx.filter(f => !f.locked).map(f => `· ${esc(f.label)} ${ed([...DP, "fx", f.id, "value"], f.value)}`).join(" ")}
    &nbsp;&nbsp; <b>Nights</b> ${ed([...DP, "nights"], d.nights)}
  </div>
  <details class="sec" open><summary>Rates (${d.rates.length})</summary><div class="scroll"><table><thead><tr><th>Item</th><th class="l">Group</th><th>Rate</th><th class="l">Unit</th><th class="l">FX</th><th>= MYR</th></tr></thead><tbody>
    ${Object.entries(groups).map(([g, list]) => list.map(r => `<tr><td>${esc(r.label)}</td><td class="l muted">${esc(g)}</td><td>${ed([...DP, "rates", r.id, "value"], r.value, { display: n2(r.value) })}</td><td class="l muted">${esc(r.unit)}</td><td class="l muted">${esc(r.fx)}</td><td>${rm(r.value * fxOf(d, r.fx), 2)}</td></tr>`).join("")).join("")}
  </tbody></table></div></details>
  ${d.tables.length ? `<details class="sec" open><summary>Per-pax rate tables (${d.tables.length})</summary><div class="scroll" style="max-height:420px;overflow-y:auto"><table><thead><tr><th>Pax</th>${d.tables.map(t => `<th>${esc(t.label)}<br><span class="muted">${esc(t.unit)}</span></th>`).join("")}</tr></thead><tbody>
    ${[...new Set(d.tables.flatMap(t => Object.keys(t.values)))].map(Number).sort((a, b) => a - b).map(p => `<tr><td>${p}</td>${d.tables.map(t => `<td>${t.values[String(p)] === undefined ? '<span class="muted">—</span>' : ed([...DP, "tables", t.id, "values", String(p)], t.values[String(p)], { display: n2(t.values[String(p)]) })}</td>`).join("")}</tr>`).join("")}
  </tbody></table></div></details>` : ""}
  <details class="sec"><summary>TO formulas &amp; pax coverage${isAdmin ? "" : " (admin edits)"}</summary><div class="scroll"><table><thead><tr><th>TO</th><th class="l">Component</th><th class="l">Formula (group total unless per pax)</th></tr></thead><tbody>
    ${d.variants.map(v => v.components.map((c, i) => `<tr><td>${i ? "" : `<b>${esc(v.id)}</b><br><span class="muted small">pax ${v.paxMin}–${v.paxMax}</span>`}</td><td class="l">${esc(c.label)}</td><td class="l" style="min-width:320px">${isAdmin && EDIT && !VIEW ? ed([...DP, "variants", v.id, "components", c.key, "expr"], c.expr, { text: true }) : `<span class="expr">${esc(c.expr)}</span>`}</td></tr>`).join("")).join("")}
  </tbody></table></div>
  <div class="note">Formulas use <code>R.id</code> (rate converted to MYR at its FX), <code>T['id']</code> (per-pax table value at the current pax), <code>N</code> (nights), <code>pax</code> and <code>band(pax,[max,value],…)</code> for vehicle bands.</div></details>
  </div>`;
}
const touchesDest = e => !PAGE_DEST || !(e.changes || []).length || e.changes.some(c => c.path[1] === PAGE_DEST);
function historyCard() {
  const all = [...HISTORY.entries].filter(touchesDest).sort((a, b) => b.v - a.v), es = all.slice(0, 6);
  return `<div class="card full" id="histCard"><h2>Change history${PAGE_DEST ? " · " + esc(PAGE_DEST) : ""} <span class="sub">latest ${es.length} of ${all.length}</span><span class="right"><button class="btn" data-act="history">All versions</button></span></h2>
    <div class="hist">${es.map(histEntry).join("") || '<div class="empty">No history yet.</div>'}</div></div>`;
}
function histEntry(e) {
  const src = DATA;
  if (PAGE_DEST && e.changes) e = { ...e, changes: e.changes.filter(c => c.path[1] === PAGE_DEST) };
  return `<div class="e"><div class="h"><span class="pill nav">v${e.v}</span><b>${esc(e.by)}</b><span class="muted small">${esc(fmtDate(e.at))}</span>
    <span class="small">${esc(e.note || "")}</span>
    <span style="margin-left:auto">${e.v !== DATA.version ? `<button class="btn" data-view="${e.v}">View v${e.v}</button>` : '<span class="pill ok">current</span>'}</span></div>
    ${e.changes && e.changes.length ? `<ul>${e.changes.slice(0, 12).map(c => `<li>${esc(c.label || describe(src, c.path))}: <span class="from">${esc(showVal(c.from))}</span> → <span class="to">${esc(showVal(c.to))}</span></li>`).join("")}${e.changes.length > 12 ? `<li class="muted">+ ${e.changes.length - 12} more</li>` : ""}</ul>` : ""}</div>`;
}

/* ============================================================ versions */
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
  // One commit that writes several files; fails (409/422) if someone pushed first.
  async commit(files, message, parentSha, token) {
    const parent = await this.req("GET", this.repoPath() + "/git/commits/" + parentSha, null, token);
    const tree = await this.req("POST", this.repoPath() + "/git/trees", { base_tree: parent.tree.sha, tree: files.map(f => ({ path: f.path, mode: "100644", type: "blob", content: f.content })) }, token);
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
    const [d, h, u] = await Promise.all([fetchJson(PATHS.data), fetchJson(PATHS.history).catch(() => ({ entries: [] })), fetchJson(PATHS.users).catch(() => ({ users: [] }))]);
    DATA = d; BASE = clone(d); HISTORY = h; USERS = u;
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
  const t = e.target.closest("button, tr[data-pax], tr[data-variant], tr[data-href], [data-close], a");
  if (!t) return;
  if (t.dataset.href && t.tagName === "TR") { location.href = t.dataset.href; return; }
  if (t.matches("[data-close]")) return closeModal();
  if (t.id === "btnLogin") return openLogin();
  if (t.id === "doLogin") return doLogin();
  if (t.id === "doSetup") return doSetup();
  if (t.id === "btnLogout") { if (pendingChanges().length && !confirm("Discard unsaved changes?")) return; SESSION = null; EDIT = false; DATA = clone(BASE); return render(); }
  if (t.id === "btnEdit") { EDIT = !EDIT; VIEW = null; return render(); }
  if (t.id === "btnAcct") return openAccount();
  if (t.id === "btnHistory" || t.dataset.act === "history") return openHistory();
  if (t.id === "btnSave" || t.dataset.act === "review") return openReview();
  if (t.dataset.act === "discard") { if (confirm("Discard all unsaved changes?")) { DATA = clone(BASE); render(); } return; }
  if (t.dataset.act === "viewCurrent") { VIEW = null; return render(); }
  if (t.dataset.act === "restore") {
    const snap = VIEW.data, v = VIEW.v;
    DATA = clone(BASE);
    for (const c of diff(stripMeta(BASE), stripMeta(snap))) setPath(DATA, c.path, clone(c.to));
    VIEW = null; EDIT = true; render(); openReview("Restore to v" + v); return;
  }
  if (t.dataset.view) { const v = +t.dataset.view; VIEW = { v, data: snapshotAt(v) }; EDIT = false; closeModal(); render(); window.scrollTo(0, 0); return; }
  if (t.dataset.tab) { SEL.paxTab = t.dataset.tab; return render(); }
  if (t.dataset.pax) { const p = +t.dataset.pax; SEL.bandOverride = ""; SEL.adult = Math.max(0, p - SEL.cwb - SEL.cnb); if (SEL.adult + SEL.cwb + SEL.cnb !== p) { SEL.cwb = SEL.cnb = 0; SEL.adult = p; } return render(); }
  if (t.dataset.variant) { SEL.variant = t.dataset.variant; return render(); }
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
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset && t.dataset.addon) { SEL.addonQty[t.dataset.addon] = Math.max(0, parseInt(t.value || "0", 10) || 0); return render(); }
  if (t.id === "selPkg") { SEL.pkg = t.value; SEL.variant = "auto"; return render(); }
  if (t.id === "selVar") { SEL.variant = t.value; return render(); }
  if (t.id && t.id.startsWith("pax_")) { SEL[t.id.slice(4)] = Math.max(0, Math.min(99, parseInt(t.value || "0", 10) || 0)); return render(); }
  if (t.id === "bandOv") { SEL.bandOverride = t.value === "" ? "" : String(Math.max(1, parseInt(t.value, 10) || 1)); return render(); }
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

window.PTCALC = { priceRow, variantCost, diff, applyChanges, snapshotAt, describe, get DATA() { return DATA; }, get BASE() { return BASE; }, GH, SEL, render, saveChanges, set SESSION(s) { SESSION = s; }, set EDIT(v) { EDIT = v; }, get HISTORY() { return HISTORY; }, unlock, wrapVault, aesEnc, setUsers(u) { USERS = u; } };
load().catch(() => { });
