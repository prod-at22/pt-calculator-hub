# Status & handoff (8 Oct 2026, data v28 — the hub is the source of truth)

PT R&D Costing Hub (renamed 8 Oct; repo/URL unchanged). Live: https://prod-at22.github.io/pt-calculator-hub/ · repo `prod-at22/pt-calculator-hub` (gh CLI is logged in as prod-at22).
How everything works: README.md. This file = where we stopped. Reply to the PO in Bahasa Melayu.

## Start of a new session
```bash
gh repo clone prod-at22/pt-calculator-hub && cd pt-calculator-hub
git config user.name "ezie ARBA" && git config user.email "eziearba@ezies-MacBook-Air.local"
git config http.postBuffer 524288000          # contracts/ has large files
npm i jsdom --no-save && node tests/test_calc.js   # must say ALL PASSED
```
After any change: `python3 tools/make_pages.py` (asset ?v= hash), run the tests, commit, push, wait for the Pages build.

## Page today
- Hub: one row per catalog package (name · PO · last update). 37 destinations.
- Destination page: header (PO, FX chips — editable in Edit costs) · **Package** (package name only) · **Tour operator** (operator
  name only; lists just that package's TOs, auto-picked by pax) · tabs Costing / Itinerary / Surcharge / Add On / What to Expect / Policy / TO Contract Rate / Flags / History.
- Costing table: one block per TO; component columns (group RM), headers = component name only. Rate-built TOs
  (Tokyo, Osaka, Tokyo-Osaka) get two buttons, both off by default: **Show rate reference** opens a horizontal table above Costing by
  pax (one column per code: A, B, … = rates in order of use, then the FX; item · pax band, supplier, rate; note on
  hover); **Show calculation** writes each cell as its formula in those codes, e.g. "A × 2 × R = 1,144"
  (rateCodes / rateRef / calcText in app.js). A component RM0 at every pax is
  hidden; a single cost line shows as Cost/Pax only. Cost/Pax · Catalog Price · **Selling Price = Catalog − RM200**
  (settings.sellingDiscount, all packages; infant no discount) · Margin (green +, red −) · % · Total Gross.
  Grey/white rows, one header colour, all centred. No Source column, no Quote / Rates & FX tabs.
  In **Edit costs** a *TO rates* table appears above Costing by pax (toRatesCard): per-pax cost per component for
  each TO, or the supplier rates for Tokyo / Osaka / Tokyo-Osaka — this is where TO costs are changed now.
- Names: tools/names.json (package + operator display names), applied by tools/apply_names.py.
- TO Contract Rate tab: files in contracts/<code>/ listed in data.json `contracts`. Uploading from the page needs
  login, which is still not set up (data/users.json empty) — files so far were committed directly.

## Catalog content (Itinerary / Surcharge / Add On / What to Expect / Policy tabs) — the hub is the source
- data/catalogs/<slug>.json = every catalog (67), same schema as Catalog PT. Imported once (8 Oct) byte for
  byte from Drive "Catalog PT (new)/catalogs" (`tools/import_catalogs.py --from-drive` — do NOT run again,
  it would overwrite hub edits). data/catalogs/index.json links slug → package (MAP in tools/flags.py);
  rebuild it with `python3 tools/import_catalogs.py` after editing a catalog. Not linked: ho-chi-minh,
  maldives-standard, yunnan-3-wilayah-6d5n (no calculator package).
- Destination page tabs show the selected package's catalog section by section (see README "Catalogs"); every
  field editable in Edit costs; each card links the public page / PDF.
- **Mirror (automatic, no token)**: workflow `mirror.yml` lives in **prod-at22/catalog-pt-public** itself. Every
  10 min it checks this repo (public); when data/catalogs/ changed since `.hub-sha` (a Catalog Price or Add On save stamps hub_version in the catalog file) it rebuilds only those
  catalogs with catalog-build/build.py (all of them when catalog-build/ changed) and commits to itself
  (GITHUB_TOKEN, contents: write). Delay ≈10–15 min; catalog-pt-public → Actions → "Mirror from PT R&D
  Costing Hub" → Run workflow mirrors at once (slugs, or "all"). Tested 8 Oct (tokyo-standard published).
  CI PDFs = Linux Chrome (Liberation Serif, metric-compatible with the Mac's Times; same pages/layout).
  GitHub disables a scheduled workflow after 60 days without commits to catalog-pt-public — if catalogs sit
  unchanged that long, re-enable it in that repo's Actions tab.
- Drive "Catalog PT (new)" = backup builder only (its build.py pulls data/catalogs/ from here).
- Not editable on the page yet (read-only view; edit the JSON in the repo). Prices shown are the catalog's;
  the Costing tab keeps its own catalog prices in data.json — they can disagree (see flags).

## The hub is the source of truth (v28, 8 Oct 2026)
- All costs, FX, catalog prices, rules and add-ons are edited **on the page** and saved as versions. The R&D
  workbooks are no longer read: the importers (extract_rd, merge_dests, build_data, extract_fx, extract_krabi,
  build_jp_rates), the R&D comparison (tests/truth, crosscheck.py) and the R&D markers / cell references in
  data.json were removed (v28). Do not re-create an R&D import — it would overwrite saved edits.
- Contract-based costs stay script-built from the TO contract (not R&D): **SEL** Basic/Standard (tools/build_sel.py)
  and **SELJJU, JJU, JJUO** (tools/build_korea_cr.py), ATK CR 2026 KRW × 0.0030. Run them only when ATK sends a new CR.
- **HND / OSK / KIX** are rate by rate (rate × FX). Qayyum FX 0.026, WIF 0.029, apartment RM250/pax/night.
  contracts/hnd has the ARBA-internal Qayyum rate sheet (tools/make_qayyum_sheet.py; regenerate after a Qayyum rate change).
- **JBDO**: CTRANS fullboard rate 2–10 pax (v5); catalog = Catalog PT v8, 2–19 pax (v27). 10–19 pax cost RM635/pax (PO 9 Oct, v34).
- Flags (tools/flags.py): catalogs × the hub's own numbers only.
- **Catalogs** (v31): each catalog section comes from its own tab — price = Costing (Catalog Price column),
  header + hotels + itinerary + includes/excludes = Itinerary, Surcharge, Add On (tick per package; 210 catalog
  add-ons imported into data.json with catalogs {slug: position} + price_lines), What to Expect, Policy (notes +
  deposit). Catalog files keep no amounts and no add-on list (addon_groups = order + notes only). hub_version is
  stamped on save. catalog-build/hub_data.py = the rules for the build.
- **Publishing** (8 Oct): the mirror's 10-min cron ran once all day, so a save now dispatches mirror.yml itself
  (startCatalogMirror in app.js; token needs Actions: write on catalog-pt-public). mirror.yml uses
  catalog-build/changed.py, so a data.json-only change (prices, add-ons) is picked up too.
  tools/import_catalogs.py --from-drive is retired; the old Drive builder ("Catalog PT (new)/build.py") cannot
  render the new files — do not use it.

## HANDOFF (10 Oct 2026) — v47 live
- v41 Info KB tidy · v42 Bangkok 4★ / 5★ removed (upgrade / add-on prices kept) · v43–v44 Bangkok Costing rate by rate from
  PT BANGKOK R&D 2026 sheet COSTING BKK (reference only; no meals) · v45 Bangkok Flags / History tabs hidden (destinations[].hideTabs),
  Show calculation folds pax-only parts · v46 Beijing Costing from the Tourdechina CR in RMB · v47 KB Accommodation from the hub.
- **Live FX**: an FX entry with `"live": "<ISO>"` uses today's ECB rate (frankfurter.dev, fallback open.er-api.com) on page open;
  `value` = fallback. Live: BKK THB, PEK RMB (CNY). tools/flags.py uses the stored value.
- v47: KB hotel cards removed — KB Accommodation = the Accommodation list per package + `roomNote` (Nota bilik, KB only) + the
  catalog's room-basis line; photos in pt-kb-house `<slug>/hotel-images.json`; aceh / korea read `KBD.ACC_HTML`. FAQ cancellation /
  refund removed. Simple Calculator tab = config as editable tables + .md download (no embedded KB).
- Open for the PO: Beijing Jul–Aug +RMB400, single supplement RMB750 / 620, +1 FOC 10+ pax; live FX for other destinations;
  admin token + First-time setup.

## KB House from the hub (9 Oct 2026, v32) — Phase 2 in progress
- PO decision (9 Oct): the hub is the source of truth for PT KB House; KB pages mirror the hub; cosmetics (images,
  travel map, page design) stay in pt-kb-house; KB Bahasa Melayu text kept in the hub; variants without a Costing
  package kept as KB-only; aceh / korea stay bespoke; **hub wins** when a KB price differs from the hub.
- Step 1 done: data/kb/<slug>.json (28) + kb-build/build.py; pt-kb-house has mirror.yml + <slug>/assets.json.
  aceh / korea now read their content constants from an injected kbdata block (one-time edit, text identical).
- Step 3 done (v33): tabs **Info KB** + **Simple Calculator** on every destination page; Edit costs → Save writes
  data/kb/<slug>.json and dispatches pt-kb-house mirror.yml. Step 2 (tiers from Costing) is parked on local branch
  kb-step2-tiers — waiting for the PO's answers (Aceh 31+ pax, Lombok HNY 4★ / Phuket 4★ hub vs catalog surcharge, Aceh-Sabang CWB/CNB 16+).
- **Accommodation tab** (PO 9 Oct, v36): hotels moved out of 58 catalog files into data.json destinations[].hotels
  (152 hotels, 35 destinations); all 67 catalogs resolve identical. KB hotel cards merged (v37): cards link hotels by id, names
  from the list; 18 cards stay text (notes / multi-city catalog rows: KK 3★, Medan 4★, Korea Seoul Std & Seoul–Jeju).
- One source of truth (PO 9 Oct, v35): KB price tables, itineraries, includes / excludes are built from the Costing +
  Itinerary tabs (data/kb map.packages links each KB package to its catalog); the KB file keeps none of them. Package
  text uses {{dari:N}} {{2pax:N}} {{pasangan:N}}. Still KB text with prices: compare blocks + FAQ (~138 mentions) — next.
- Next (was): step 2 = calculator tiers + KB price text from Costing (show the PO the text diff per KB before it goes
  live; 8 conflicts in the Phase 1 report); step 3 = hub tabs Info KB + Simple Calculator, Save writes
  data/kb/ and dispatches pt-kb-house mirror.yml (token needs Actions: write on pt-kb-house too).
- Phase 1 report: https://claude.ai/code/artifact/76a209fd-7a4c-47cf-bc86-71f02a28793b

## Open — waiting on the PO
1. Tokyo (on hold by PO): catalog JSON Tokyo Standard (2 pax RM6,197) ≠ ProdReq "catalog v2" (RM6,997) — which is current?
   Qayyum open items: tolls/parking/fuel inside the rate? guide's own entrance? Iyashi entrance still on WIF FX 0.029.
2. Korea CR: Basic 16 pax 406,193 KRW looks wrong; no rate 26–30 pax (except Standard); CR seasonal ±RM150–300 not applied;
   2-pax margin thin on Seoul-Jeju / Jeju-Udo.
3. Maldives operator name unknown (TO box shows "Resort / TO" / "Resort package").
4. Confirm guessed package names: Lake Toba Emiya = Parapat, Baim = Samosir; Perhentian Basic = Shari-La, Standard = Mimpi.
5. One FX per currency (THB 0.131 vs 0.122; IDR; USD 3.97 vs 4.0295; RMB 0.65 vs 0.58; AUD).
6. Done (v29, 8 Oct): the catalog is the source for prices — Costing catalog prices of the 13 catalogs that differed were set to the published catalogs.
   /flags/ regenerated 7 Oct on data v25 (95 flags: 29 high · 37 medium · 29 low). New since v6: KK margin
   problems in 11 lines and Perhentian Shari-La under 10% / CWB below cost (both from Selling = Catalog − RM200),
   Seoul-Jeju 2 pax 6.8% and Jeju-Udo 3.8% margin, Korea 26–30 pax no cost, Qayyum FX 0.026 (HND) vs 0.0259 (KIX).
7. No costing in the hub yet: Yunnan 3 Wilayah, Ho Chi Minh, Maldives Standard (4★). Codes SNZ, NNZ, SUBM, KMGDL not on the hub.
8. Login: admin must create a fine-grained token (Contents RW on pt-calculator-hub + Actions RW on catalog-pt-public and pt-kb-house) and do First-time setup on the live page (cannot be done for them). Password ≥ 10 characters.
9. Uploaded only files named PT from the Drive "Production Team" folder; unlabelled CRs (Perhentian resorts,
   Semporna Legend, Perth K&N, NZ price list, Pak Jamal, KK / Krabi / Maldives folders) were not uploaded.

## Sources
- R&D workbooks (~/Downloads/PT DESTINASI R&D REFORMAT/): history only, not used by the hub.
- Catalog content: data/catalogs/ (this repo). Catalog PT build (mirror): ~/Library/CloudStorage/GoogleDrive-product@arbatravel.com/My Drive/Catalog PT (new)/
- Project PT sheet (codes, POs, catalog names): Drive file 10lru13aYbcbI888rhghOipOyiKm_6FYykfFu0xfoReQ
- TO CRs on Drive: "Production Team" folder 10Ez7h9hXXVsECV4UIGKKx7dnvZDGwOhC (one sub-folder per destination).
- ProdReq skills: /prodreqkorea, /prodreqjepun.

## Rebuild / check
```bash
python3 tools/build_sel.py && python3 tools/build_korea_cr.py      # only when the ATK CR xlsx changes
python3 tools/make_pages.py                                         # after any app.js / app.css / new destination
NODE_PATH=<jsdom dir> python3 tools/flags.py                        # regenerate /flags/
node tests/test_calc.js
```
