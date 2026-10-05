# ARBA PT Costing Calculator

One page for every PT destination: pick **destination → package → tour operator**, enter
see

- each cost component that makes up the total cost (airport, transport, hotel, guide, …),
- catalog price, selling price, margin RM and margin % for every pax type,
- **TO Contract Rate**: the TO's contract / rate card files, to open or upload,
- **Costing by pax**: per pax, A + B + C + … (each component) = Cost, Cost + Margin = Selling, for pax 2–30,
- **Add-ons** from the R&D Add-Ons tab: cost, selling price, margin. Enter a qty to add them to the group total.

Hub: `https://prod-at22.github.io/pt-calculator-hub/` — one row per catalog package (names from
the Project PT sheet, `tools/catalogs.json`), its PO and last update, searchable. Each
destination has its own link by code in lowercase, e.g. `/sel/`, `/seljju/`, `/hnd/`, `/kix/`,
`/dps/`, `/mle/`, `/kbv/`, `/ltoba/` (Medan Lake Toba). 37 destinations are live; Yunnan 3
Wilayah has no R&D file yet.

**Krabi (KBV)** has Hotel and Season selectors: cost = the hotel's KTT rate (THB) × FX for the
package and Day-3 choice (Tour operator box); a 4★ / 4★+ hotel adds the catalog upgrade
(`tools/extract_krabi.py`, checked against every hotel × season × package × day-3).

The hub lists every package with its PO and last update date. PO per destination (Oct 2026): **Acap** Turki, Istanbul, Perth, New Zealand, Maldives, Melbourne · **Aiman** Korea, Vietnam, Jakarta-Bandung, Jogja, Lombok, Surabaya · **Thania** Jepun, Switzerland · **Fyka** Bali, Beijing, KK, Aceh, Krabi, Semporna, Perhentian, Lake Toba, Bangkok, Phuket, Padang · **Amirul** Yunnan. Change it on the destination page when there is a handover, and in `PO` in `tools/extract_rd.py` so a re-import keeps it.

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
| `data/data.json` | all rates, FX, TO formulas, catalog prices and rules. **This is the source of truth once people start saving.** |
| `data/history.json` | change log, one entry per version |
| `data/users.json` | usernames + encrypted keys (no passwords, no plain token) |
| `tools/build_data.py` | one-off seed: reads the R&D workbooks + Catalog PT JSON → `data/data.json` |
| `tests/test_calc.js` | checks every TO × pax cost against the R&D sheet, plus login/save/history |

## Where the numbers come from

- **Tokyo (HND)** is built rate by rate from the R&D Raw Costing (JPY rates × FX), so editing
  one supplier rate updates every pax count (`tools/build_data.py`).
- **Every other destination** comes from its R&D workbook in
  `~/Downloads/PT DESTINASI R&D REFORMAT/<DESTINATION>/` (newest `*reformat*` file) through
  `tools/extract_rd.py`:
  - cost components per pax = the CR tab columns (group totals are divided by pax);
  - catalog, selling, margin and child rules = the Costing tab, **computed by the workbook
    itself**: for each TO the script sets `PILIH TO` (Phuket: the hotel / package / season
    selectors), recalculates with LibreOffice and reads the result;
  - every TO × pax × Adult/CWB/CNB row is re-computed the way the page does and must match the
    R&D; `tests/truth/<CODE>.json` keeps those R&D numbers and `tests/test_calc.js` checks the
    page against them.
- Selling = R&D catalog + tier upgrade − discount tier 2, exactly as the Costing tab.
- Where the R&D has a catalog price but no cost (e.g. Seoul Self Tour 13–30 pax), the page
  shows the cost as missing instead of the R&D's RM0 / 100% margin.
- Child rules: % of adult cost, adult cost − RM, or (Aceh, Aceh-Sabang, Beijing) % of Ground
  only with tipping/activities charged in full.

### Re-importing after the R&D changes

```bash
git pull                                  # live data.json = source of truth
python3 tools/extract_rd.py --work /tmp/ptx            # all, or --only SEL DPS
python3 tools/extract_krabi.py --work /tmp/ptx         # Krabi
python3 tools/merge_dests.py --dests /tmp/ptx/dest --keep HND --by <you> --note "<why>"
cp /tmp/ptx/truth/*.json tests/truth/ && python3 tools/make_pages.py
node tests/test_calc.js tests/truth.json
```

A re-import replaces whole destinations, so it is logged as one version marked
"re-import"; older versions of those destinations cannot be opened cell by cell afterwards.

## Page layout (Product R&D)

Each destination page: header (destination, PO, last update, **locked FX chips**), package /
tour operator (/ hotel, season) selectors, then tabs:

| Tab | For |
|---|---|
| **Costing** (default) | R&D-style table per TO block: components, Cost/Pax, Catalog, Selling, Margin, %, Total Gross; margin range and lowest margin above it. Rows alternate grey / white, one header colour; margin is green when positive, red when negative |
| TO Contract Rate | the TO's contract / rate card files (PDF, Excel, image, max 25 MB). Anyone can open them; logged-in users upload or remove. Files live in the repo under `contracts/<code>/`, listed in the destination's `contracts` in `data.json`; each upload / removal is one version in the history |
| Add-ons | cost / selling / margin; a qty totals the selected add-ons |
| Flags | this destination's cross-check flags |
| History | versions that touched this destination |

## FX

FX is read from each R&D sheet (`tools/extract_fx.py`) and shown as 🔒 chips. It is never
editable on the page: the costs were converted at that rate in the R&D, so change FX in the R&D
sheet and re-import.

## Flags (cross-check)

`/flags/` lists every disagreement between the catalog (Catalog PT site JSON, transcribed from
the Canva PDF), the R&D sheet and the calculator, with a suggested fix; filter by severity,
area and PO. Regenerate after any import:

```bash
node tools/margins.js > /tmp/ptx/margins.json
python3 tools/crosscheck.py --fx /tmp/ptx/fx.json --margins /tmp/ptx/margins.json
```

## Editing (POs)

1. **Log in to edit**, then **Edit costs**. Editable cells turn yellow; a changed cell turns orange.
2. Change catalog prices (Costing tab), add-on cost / selling, or the PO. The whole page recalculates as you type.
   TO rates and formulas are not edited on the page: change them in the R&D sheet and re-import.
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

Add its R&D folder to `DESTS` (and `PO`, `COUNTRY`) in `tools/extract_rd.py`, then follow
*Re-importing* above with `--only <CODE>`.

## Verifying

```bash
# recalculate the R&D workbooks (openpyxl files have no cached values)
/Applications/LibreOffice.app/Contents/MacOS/soffice --headless --convert-to xlsx --outdir out PT_SEL_RD_reformatted.xlsx PT_HND_RD_reformatted.xlsx
npm i jsdom
node tests/test_calc.js tests/truth.json
```

## Things the R&D sheets flag that are worth checking

- **Seoul**: the CR adds ATK profit (USD 70 ≈ RM278/pax) on top of the ATK package rate, and the
  sheet itself warns the package rate may already include profit. If so, set *ATK profit* to 0.
- **Seoul Self Tour** costs are marked *estimated* in the R&D sheet, and it has no published catalog.
- **Tokyo Standard** at 2 pax shows 7% margin (cost RM5,579 vs selling RM5,997 after the tier-2 discount).
- **Seoul - Jeju**: the catalog site prices are RM300 higher than the R&D Costing tab at every pax
  and pax type (e.g. 2 pax adult RM6,197 vs RM5,897). The calculator follows the R&D.
- **Seoul add-ons** have selling prices but no cost in the R&D sheet (shown as *cost?*).
- **Seoul - Jeju add-on "Tolak 1 malam 3★"**: cost +150 but selling −150, so margin shows −RM300.
  The cost should probably be −150.
- **Tokyo WIF-STD**: the CR note says "FX Qayyum 0.0259" but the formulas use WIF's 0.029. The
  calculator follows the formulas.
