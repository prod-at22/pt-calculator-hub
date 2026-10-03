# ARBA PT Costing Calculator

One page for every PT destination: pick **destination → package → tour operator**, enter
pax (Adult / CWB / CNB / Infant) and see

- each cost component that makes up the total cost (airport, transport, hotel, guide, …),
- catalog price, selling price, margin RM and margin % for every pax type,
- a price list for every pax count (like the R&D Costing tab),
- every TO that can run that pax count, side by side,
- **Costing by pax**: per pax, A + B + C + … (each component) = Cost, Cost + Margin = Selling, for pax 2–30,
- **Add-ons** from the R&D Add-Ons tab: cost, selling price, margin. Enter a qty to add them to the group total.

Hub: `https://prod-at22.github.io/pt-calculator-hub/`. Each destination has its own link by code:

| Code | Link |
|---|---|
| SEL | `https://prod-at22.github.io/pt-calculator-hub/sel/` |
| SELJJU | `https://prod-at22.github.io/pt-calculator-hub/seljju/` |
| HND | `https://prod-at22.github.io/pt-calculator-hub/hnd/` |

The hub lists every package with its PO and last update date. PO per destination: Korea (SEL, SELJJU) Aiman, Jepun (HND) Thania; change it on the destination page when there is a handover.

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

- **Cost**: the R&D workbook CR tab (`PT_SEL_RD_reformatted.xlsx`, `PT_HND_RD_reformatted.xlsx`), rebuilt
  as components. Seoul = ATK package rate per pax + K-ETA + ATK profit. Tokyo = the Raw Costing
  rates (JPY or MYR) × quantity × FX, exactly as the CR formulas do.
- **Selling price**: the Catalog PT site (`catalog-pt-public`). Pax counts the catalog does not print
  (e.g. 16–30) come from the R&D Costing tab and are tagged **R&D** in the price list.
- **Rules** (CWB/CNB/infant cost, discount tier 2, tier upgrade): R&D Costing tab header cells.

## Editing (POs)

1. **Log in to edit**, then **Edit costs**. Editable cells turn yellow; a changed cell turns orange.
2. Change rates, FX, per-pax tables, catalog prices or rules. The whole page recalculates as you type.
3. **Save vN**: check the list of changes, write a short note (e.g. "Qayyum 2027 rate card"), save.
   The live page shows the new version within about a minute.
4. If someone else saved first, your edits are applied on top of theirs automatically, unless you both
   changed the same cell. Then the save stops and asks you to reload.

Only **admins** can edit TO formulas (Rate card → *TO formulas & pax coverage*). Formulas use:
`R.id` (a rate, already converted to MYR at its FX), `T['id']` (per-pax table value at this pax),
`N` (nights), `pax`, and `band(pax,[max,value],…)` for vehicle size bands.

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

The data model is the same for every destination: `fx`, `rates`, `tables` (per-pax cost rows),
`variants` (one per TO/variant, a list of cost components) and `packages` (catalog prices, rules
and which TO covers which pax range). Add a function for it in `tools/build_data.py` that reads
that R&D workbook, run the tests against a recalculated copy of the workbook, then merge the new
destination into the **live** `data/data.json` from the repo, not a fresh build, so existing
edits are kept. Then run `python3 tools/make_pages.py` to create its `/<code>/` page.

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
- **Seoul - Jeju**: the catalog prices are RM300 higher than the R&D Costing tab at every pax and
  pax type (e.g. 2 pax adult RM6,197 vs RM5,897). The calculator uses the catalog.
- **Seoul add-ons** have selling prices but no cost in the R&D sheet (shown as *cost?*).
- **Seoul - Jeju add-on "Tolak 1 malam 3★"**: cost +150 but selling −150, so margin shows −RM300.
  The cost should probably be −150.
- **Tokyo WIF-STD**: the CR note says "FX Qayyum 0.0259" but the formulas use WIF's 0.029. The
  calculator follows the formulas.
