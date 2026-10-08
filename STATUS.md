# Status & handoff (8 Oct 2026, data v26)

Live: https://prod-at22.github.io/pt-calculator-hub/ · repo `prod-at22/pt-calculator-hub` (gh CLI is logged in as prod-at22).
How everything works: README.md. This file = where we stopped. Reply to the PO in Bahasa Melayu.

## Start of a new session
```bash
gh repo clone prod-at22/pt-calculator-hub && cd pt-calculator-hub
git config user.name "ezie ARBA" && git config user.email "eziearba@ezies-MacBook-Air.local"
git config http.postBuffer 524288000          # contracts/ has large files
npm i jsdom --no-save && node tests/test_calc.js tests/truth.json   # must say ALL PASSED
```
After any change: `python3 tools/make_pages.py` (asset ?v= hash), run the tests, commit, push, wait for the Pages build.

## Page today
- Hub: one row per catalog package (name · PO · last update). 37 destinations.
- Destination page: header (PO, locked FX chips) · **Package** (package name only) · **Tour operator** (operator
  name only; lists just that package's TOs, auto-picked by pax) · tabs Costing / TO Contract Rate / Add-ons / Flags / History.
- Costing table: one block per TO; component columns (group RM), headers = component name only. Rate-built TOs
  (Tokyo, Osaka, Tokyo-Osaka) get two buttons, both off by default: **Show rate reference** opens a horizontal table above Costing by
  pax (one column per code: A, B, … = rates in order of use, then the FX; item · pax band, supplier, rate; note on
  hover); **Show calculation** writes each cell as its formula in those codes, e.g. "A × 2 × R = 1,144"
  (rateCodes / rateRef / calcText in app.js). A component RM0 at every pax is
  hidden; a single cost line shows as Cost/Pax only. Cost/Pax · Catalog Price · **Selling Price = Catalog − RM200**
  (settings.sellingDiscount, all packages; infant no discount) · Margin (green +, red −) · % · Total Gross.
  Grey/white rows, one header colour, all centred. No Source column, no Quote / Rates & FX tabs.
- Names: tools/names.json (package + operator display names), applied by tools/apply_names.py and re-applied by
  merge_dests.py after every import.
- TO Contract Rate tab: files in contracts/<code>/ listed in data.json `contracts`. Uploading from the page needs
  login, which is still not set up (data/users.json empty) — files so far were committed directly.

## Where each destination's cost comes from
- R&D sheets (tools/extract_rd.py) for everything except below.
- **SEL** Basic/Standard: ATK CR 2026 in KRW × 0.0030 (tools/build_sel.py, reads contracts/sel/…KRW.xlsx via
  tools/korea_cr.py); Seoul add-ons from ProdReq Korea §7–8. Self Tour = R&D.
- **SELJJU, JJU, JJUO**: ATK CR 2026 in KRW × 0.0030 (tools/build_korea_cr.py). Jeju Self Tour = R&D.
- **HND**: rate by rate. Qayyum (Standard 2–7) rates from ProdReq Jepun (airport ¥22,000, City ¥76,000, Fuji ¥81,000),
  **Qayyum FX 0.026** (PO); WIF FX 0.029. Apartment RM250/pax/night. No Qayyum CR exists — contracts/hnd has an
  ARBA-internal rate sheet PDF (tools/make_qayyum_sheet.py; regenerate after any Qayyum rate change).
- **OSK, KIX**: rate by rate since v26 (tools/build_jp_rates.py reads the R&D CR formulas = Raw Costing rate ×
  FX; checks every component at every pax against the old values). Accommodation RM250/pax/night (PO, v24) kept
  via OVERRIDE in that script — R&D still says RM300. After a re-import of OSK/KIX run build_jp_rates.py again.
- **JBDO**: CTRANS fullboard rate 2–10 pax (v5), not yet in the R&D sheet.
- Turkey / Istanbul 4★ removed (no MyTrip CR, no catalog); SKIP_TO in extract_rd.py keeps it out.

Re-import: `--keep HND JBDO SEL SELJJU JJU JJUO` (+ add **OSK KIX** or update their R&D to RM250 first).

## Open — waiting on the PO
1. Tokyo (on hold by PO): catalog JSON Tokyo Standard (2 pax RM6,197) ≠ ProdReq "catalog v2" (RM6,997) — which is current?
   Qayyum open items: tolls/parking/fuel inside the rate? guide's own entrance? Iyashi entrance still on WIF FX 0.029.
2. Korea CR: Basic 16 pax 406,193 KRW looks wrong; no rate 26–30 pax (except Standard); CR seasonal ±RM150–300 not applied;
   2-pax margin thin on Seoul-Jeju / Jeju-Udo.
3. Maldives operator name unknown (TO box shows "Resort / TO (R&D)" / "Resort package").
4. Confirm guessed package names: Lake Toba Emiya = Parapat, Baim = Samosir; Perhentian Basic = Shari-La, Standard = Mimpi.
5. One FX per currency (THB 0.131 vs 0.122; IDR; USD 3.97 vs 4.0295; RMB 0.65 vs 0.58; AUD).
6. "R&D price ≠ catalog" flags: which side is right (Bangkok, Hokkaido +1,200 hotel, Phuket, Semporna, child prices…).
   /flags/ regenerated 7 Oct on data v25 (95 flags: 29 high · 37 medium · 29 low). New since v6: KK margin
   problems in 11 lines and Perhentian Shari-La under 10% / CWB below cost (both from Selling = Catalog − RM200),
   Seoul-Jeju 2 pax 6.8% and Jeju-Udo 3.8% margin, Korea 26–30 pax no cost, Qayyum FX 0.026 (HND) vs 0.0259 (KIX).
7. No R&D yet: Yunnan 3 Wilayah, Ho Chi Minh, Maldives Standard (4★). Codes SNZ, NNZ, SUBM, KMGDL not on the hub.
8. Login: admin must create a fine-grained token and do First-time setup on the live page (cannot be done for them).
9. Uploaded only files named PT from the Drive "Production Team" folder; unlabelled CRs (Perhentian resorts,
   Semporna Legend, Perth K&N, NZ price list, Pak Jamal, KK / Krabi / Maldives folders) were not uploaded.

## Sources
- R&D: ~/Downloads/PT DESTINASI R&D REFORMAT/<DEST>/ (newest *reformat*).
- Catalog: ~/Library/CloudStorage/GoogleDrive-product@arbatravel.com/My Drive/Catalog PT (new)/catalogs/*.json
- Project PT sheet (codes, POs, catalog names): Drive file 10lru13aYbcbI888rhghOipOyiKm_6FYykfFu0xfoReQ
- TO CRs on Drive: "Production Team" folder 10Ez7h9hXXVsECV4UIGKKx7dnvZDGwOhC (one sub-folder per destination).
- ProdReq skills: /prodreqkorea, /prodreqjepun.

## Rebuild / check
```bash
python3 tools/extract_rd.py --work /tmp/ptx && python3 tools/extract_krabi.py --work /tmp/ptx
python3 tools/extract_fx.py --work /tmp/ptx      # or --from-data: FX locked in data.json, no R&D re-import needed
python3 tools/merge_dests.py --dests /tmp/ptx/dest --keep HND JBDO SEL SELJJU JJU JJUO OSK KIX --by <you> --note "<why>"
python3 tools/build_sel.py && python3 tools/build_korea_cr.py      # only when the ATK CR xlsx changes
python3 tools/make_pages.py
node tools/margins.js > /tmp/ptx/margins.json && python3 tools/crosscheck.py --fx /tmp/ptx/fx.json --margins /tmp/ptx/margins.json
node tests/test_calc.js tests/truth.json
```
