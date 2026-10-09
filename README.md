# ARBA PT R&D Costing Hub

One page for every PT destination: pick **destination → package → tour operator**, enter
see

- each cost component that makes up the total cost (airport, transport, hotel, guide, …),
- catalog price, selling price, margin RM and margin % for every pax type,
- **TO Contract Rate**: the TO's contract / rate card files, to open or upload,
- **Costing by pax**: per pax, A + B + C + … (each component) = Cost, Cost + Margin = Selling, for pax 2–30,
- **Add-ons**: cost, selling price, margin. Enter a qty to add them to the group total.

Hub: `https://prod-at22.github.io/pt-calculator-hub/` — a simple list like PT Catalog House, one row per catalog package (names from
the Project PT sheet, `tools/catalogs.json`), its PO and last update, searchable. Each
destination has its own link by code in lowercase, e.g. `/sel/`, `/seljju/`, `/hnd/`, `/kix/`,
`/dps/`, `/mle/`, `/kbv/`, `/ltoba/` (Medan Lake Toba). 37 destinations are live; Yunnan 3
Wilayah has no costing in the hub yet.

**Krabi (KBV)** has Hotel and Season selectors: cost = the hotel's KTT rate (THB) × FX for the
package and Day-3 choice (Tour operator box); a 4★ / 4★+ hotel adds the catalog upgrade.

The hub lists every package with its PO and last update date. PO per destination (Oct 2026): **Acap** Turki, Istanbul, Perth, New Zealand, Maldives, Melbourne · **Aiman** Korea, Vietnam, Jakarta-Bandung, Jogja, Lombok, Surabaya · **Thania** Jepun, Switzerland · **Fyka** Bali, Beijing, KK, Aceh, Krabi, Semporna, Perhentian, Lake Toba, Bangkok, Phuket, Padang · **Amirul** Yunnan. Change it on the destination page when there is a handover.

Anyone with the link can **view**. To **change** a cost you log in with your own username and
password. Every save becomes a new version (v2, v3, …) with who, when, a note and each cell's
old → new value. Any old version can be viewed and restored.

## Files

| File | What it is |
|---|---|
| `index.html` | hub: one card per destination |
| `<code>/index.html` | the calculator for one destination (e.g. `sel/`, `hnd/`) |
| `app.js`, `app.css` | the calculator code, shared by every page |
| `tools/make_pages.py` | writes `index.html` and one `<code>/index.html` per destination in `data.json` |
| `data/data.json` | all rates, FX, TO formulas, catalog prices and rules. **The source of truth** — change it on the page (Edit costs), never in an R&D workbook. |
| `data/history.json` | change log, one entry per version |
| `data/users.json` | usernames + encrypted keys (no passwords, no plain token) |
| `tests/test_calc.js` | engine, rules and UI checks against fixed numbers, plus login/save/history |
| `tools/flags.py` | writes `data/flags.json`: catalogs (`data/catalogs/`) × the hub's own numbers |

## The hub is the source of truth (since 8 Oct 2026, v28)

Every cost, FX rate, catalog price, rule and add-on lives in `data/data.json` and is changed **on the
page** (log in → Edit costs → Save; each save is a version in History). The R&D workbooks
(`PT DESTINASI R&D REFORMAT/…xlsx`) were only the starting point: the data was imported from them once
(up to v26) and the import tools have been removed, so nothing can overwrite the hub from a workbook.
The R&D files are no longer read, compared or kept in sync — do not update them for the hub's sake.

- **Tokyo (HND), Osaka (OSK), Tokyo-Osaka (KIX)** are rate by rate (supplier rate × FX), so editing one
  rate updates every pax count; Show calculation / Rate reference work there.
- **Seoul (SEL) Basic / Standard, Seoul-Jeju, Jeju, Jeju-Udo** cost = the ATK contract rate per pax
  (ATK CR 2026 Korea in KRW × 0.0030, `contracts/…KRW.xlsx`). When ATK sends a new CR, run
  `tools/build_sel.py` / `tools/build_korea_cr.py` (they read the contract, not an R&D sheet).
  Seoul add-ons follow the Korea ProdReq §7–§8.
- **Every other destination**: cost components per pax per TO, as imported; edit them on the page.
- Selling Price = catalog (+ tier upgrade) − RM200 for every package (`settings.sellingDiscount`, PO 6 Oct 2026);
  infant price has no discount.
- A package with a catalog price but no TO cost shows the cost as missing (and a Flag), never RM0.
- Child rules: % of adult cost, adult cost − RM, or (Aceh, Aceh-Sabang, Beijing) % of Ground
  only with tipping/activities charged in full.

Older versions: imports were logged with `rebase: true`; versions before the last one cannot be
rebuilt cell by cell (History shows them as "before import").

## Page layout (Product R&D)

**Package** shows the package name only; **Tour operator** shows the operator only and lists just the
operators of the selected package (auto-picked by pax). Both names come from `tools/names.json`
(`tools/apply_names.py`).

Each destination page: header (destination, PO, last update, **FX chips** — editable in Edit costs), package /
tour operator (/ hotel, season) selectors, then tabs:

| Tab | For |
|---|---|
| **Costing** (default) | table per TO block (same layout as the old R&D sheet): components, Cost/Pax, Catalog, Selling, Margin, %, Total Gross; margin range and lowest margin above it. Rows alternate grey / white, one header colour; margin is green when positive, red when negative |
| **Itinerary** · **Surcharge** · **What to Expect** · **Policy** | the package's customer catalog, one section per tab (see *Catalogs* below) — every field editable in Edit costs |
| TO Contract Rate | the TO's contract / rate card files (PDF, Excel, image, max 25 MB). Anyone can open them; logged-in users upload or remove. Files live in the repo under `contracts/<code>/`, listed in the destination's `contracts` in `data.json`; each upload / removal is one version in the history |
| **Accommodation** | one hotel list per destination (`data.json` `hotels`): city, type, name, ★, or similar; each hotel ticked per catalog for its **Accommodation** section (`acc`: position) and/or a row of its **Surcharge** hotel table (`sur`: position + one amount per surcharge column). Catalogs print them (hub_data.py `hotels()`); the KB's hotel cards (`data/kb/<slug>.json`) link hotels by id (`hotels: [ids]`, + optional `extra` text) and take their names from this list; a card without `hotels` is free text (e.g. Single Supplement). Itinerary day "Hotel" column stays on Itinerary; peak dates stay on Surcharge |
| **Add On** | cost / selling / margin; tick *In catalog* to print an add-on in the package's catalog; **Add item** / **Delete** (Edit costs) add or remove an add-on (Delete warns when it is printed in a catalog); Add item adds a new add-on (category, name, per, cost, selling; ticked for the catalog by default, price text = selling/per); a qty totals the selected add-ons |
| **Info KB** | the PT KB House content for this destination (Bahasa Melayu): attractions with Muslim-friendly info, FAQ / Important Notes (searchable), the KB's tab blocks (transport, hotel, halal, solat, flight, visa, free gift …), packages, hotels, marketing. Edit costs edits every field (images stay in pt-kb-house) — saved to `data/kb/<slug>.json` |
| **Simple Calculator** | the KB's own quotation calculator (live KB page, opened on its calculator), the price tiers it quotes from, and in Edit costs its config (calc-config JSON) |
| Flags | this destination's cross-check flags |
| History | versions that touched this destination |

## Catalogs → catalog-pt-public

Each section of a customer catalog comes from its own tab of the destination page (selected package):

| Catalog section | Tab | Stored in |
|---|---|---|
| Package Price | **Costing** — Catalog Price column (Edit costs also shows the catalog's price-table layout: pax bands, column labels, infant line with `{price}`) | `data.json` pricing (amounts) · catalog `prices` (layout only) |
| Title, route, duration, basis, valid until, version, highlights, itinerary, includes / excludes | **Itinerary** | `data/catalogs/<slug>.json` |
| Accommodation (hotels) · Surcharge hotel rows | **Accommodation** | `data.json` hotels (`catalogs: {slug: {acc / sur, amounts}}`) |
| Surcharge | **Surcharge** | catalog `surcharge` |
| Additional activities | **Add On** — tick *In catalog* per package; name, includes / excludes / duration and catalog price text per item | `data.json` addons (`catalogs: {slug: position}`, `price_lines`) · catalog `addon_groups` (group order + notes) |
| What to Expect | **What to Expect** | catalog `expect` |
| Important Notes, Deposit & Full Payment | **Policy** | catalog `notes`, `deposit` |

All editable in Edit costs and saved together (one commit, one History version). `catalog-build/hub_data.py`
(public page / PDF) and `resolvePrices()` / `addonCard()` in `app.js` apply the same rules.

**Publishing:** after a save the page starts `mirror.yml` in prod-at22/catalog-pt-public (workflow_dispatch);
it runs `catalog-build/changed.py <last mirrored hub commit> <now>`, which resolves every catalog at both commits
(content + Costing prices + Add On items) and rebuilds only those whose page differs (all of them when
`catalog-build/` changed). The cron schedule in that workflow is only a fallback — GitHub runs it rarely.
The admin's token therefore needs **Contents: Read and write on pt-calculator-hub** and **Actions: Read and write
on catalog-pt-public and pt-kb-house**; without the second the save still works and the page says the catalogs wait for the schedule. Catalogs without a Costing package /
hub destination (Ho Chi Minh, Maldives 4 Star, Yunnan 3 Wilayah) keep printed amounts (and, for Ho Chi Minh and
Yunnan 3 Wilayah, their own add-on list). Keep every pax in a band at the same Costing price — Flags warns.

## KB House → pt-kb-house (since 9 Oct 2026, v32)

The hub is also the source of every **PT KB House** page (`https://prod-at22.github.io/pt-kb-house/<slug>/`):

| File | What it is |
|---|---|
| `data/kb/<slug>.json` | one KB (28): `kind` (`template`, or `bespoke` for aceh / korea), `content` (what the page shows: packages, itineraries, attractions + Muslim-friendly info, hotels, tab blocks, FAQ `snapshot`), `calc` (Simple Calculator config) |
| `kb-build/build.py` | `python3 kb-build/build.py <pt-kb-house dir> [slug …]` writes `content` into the page's `kbdata` block (bespoke: also the `snapshot` markdown), `calc` into `CALC_CFG` and `calc-config.json`. Nothing else in the page changes |

Shown and edited on each destination page in the **Info KB** and **Simple Calculator** tabs (`data/kb/index.json`
links a KB to the destination codes it covers; one KB can cover several, e.g. korea = SEL, SELJJU, JJU, JJUO). Save writes
`data/kb/<slug>.json` in the same commit and starts pt-kb-house's `mirror.yml` (token: **Actions: write on pt-kb-house**).
Cosmetics stay in pt-kb-house: the page (layout, CSS, engine, travel map, logo) and the images
(`<slug>/assets.json`; the hub refers to them as `@asset:<key>`). pt-kb-house's `mirror.yml` checks out the hub,
runs the builder for every KB (an unchanged KB stays byte-identical), re-adds the nav bar and commits. Imported
once on 9 Oct from the live pages (rendered text checked identical for all 28); do not edit KB content or
`calc-config.json` in pt-kb-house any more.

## FX

Each destination's FX rates (e.g. JPY → MYR for WIF and Qayyum) are part of the hub data. Log in and
press Edit costs to change one: every cost in that currency is recalculated at once. Flags lists any
currency that has different rates in different destinations.

## Flags (cross-check)

`/flags/` lists every disagreement between the catalogs (`data/catalogs/*.json`) and the hub's own
numbers (prices, pax coverage, missing TO costs, margins, add-ons, FX), with a suggested fix; filter
by severity, area and PO. Regenerate after changes:

```bash
NODE_PATH=<dir with jsdom> python3 tools/flags.py      # runs tools/margins.js itself
```

## Editing (POs)

1. **Log in to edit**, then **Edit costs**. Editable cells turn yellow; a changed cell turns orange.
2. Change catalog prices and **TO rates** (Costing tab: in Edit costs a *TO rates* table appears above
   the costing — per-pax cost per component, or supplier rates for Tokyo / Osaka / Tokyo-Osaka), FX,
   add-on cost / selling, or the PO. The whole page recalculates as you type.
3. **Save vN**: check the list of changes, write a short note (e.g. "Qayyum 2027 rate card"), save.
   The live page shows the new version within about a minute.
4. If someone else saved first, your edits are applied on top of theirs automatically, unless you both
   changed the same cell. Then the save stops and asks you to reload.

TO formulas (in `data.json`) use `R.id` (a rate, already converted to MYR at its FX), `T['id']`
(per-pax table value at this pax), `N` (nights), `pax`, and `band(pax,[max,value],…)` for vehicle size bands.

## One-time setup (admin)

1. Create a **public** repo `prod-at22/pt-calculator-hub`, upload this folder, and turn on
   GitHub Pages (Settings → Pages → branch `main`, folder `/`).
2. Create a **fine-grained personal access token** (GitHub → Settings → Developer settings →
   Fine-grained tokens): *Repository access* = only `pt-calculator-hub`, *Permissions* →
   *Contents: Read and write*. Nothing else. Set an expiry date and note it.
3. Open the live page → **Log in to edit**. With no users yet it shows *First-time setup*: paste
   the token, choose your admin username and a password (min 10 characters).
4. **Account → Add user** for each PO (username + a temporary password, role editor or admin).
   Ask them to change it via **Account → Change my password** the first time they log in.

### How the login works, and its limits

- The token is stored once in `users.json`, encrypted with a random vault key. Each user's
  entry holds that vault key encrypted with a key derived from **their** password
  (PBKDF2-SHA256, 310,000 rounds → AES-GCM). A wrong password cannot decrypt anything, so it
  cannot save.
- Everyone shares one repo token behind the scenes; the username is what goes into the history
  log and the commit message.
- Removing a user stops them logging in. A removed user who already logged in could have
  copied the token, so if you don't trust them, also **Account → Replace GitHub token**
  (create a new token first, then delete the old one on GitHub).
- When the token expires, saving fails with a GitHub error. An admin creates a new one and uses
  **Replace GitHub token**. Passwords don't change.
- Costs and margins are readable by anyone with the link (public repo). The page is marked
  `noindex` but that is not access control.

## Adding the next destination

Add it to `data/data.json` (copy a similar destination's structure: fx, rates/tables, variants, packages,
addons), run `python3 tools/apply_names.py` and `python3 tools/make_pages.py`, then fill the numbers on the page.

## Verifying

```bash
npm i jsdom
node tests/test_calc.js
```
