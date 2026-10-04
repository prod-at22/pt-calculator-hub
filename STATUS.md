# Status & handoff (4 Oct 2026, data v6)

Live: https://prod-at22.github.io/pt-calculator-hub/ · repo `prod-at22/pt-calculator-hub` (gh CLI is logged in as prod-at22).
How everything works: README.md. This file = where we stopped.

## Done
- 37 destinations, 64 catalog packages on the hub (package name · PO · last update; no TO names).
- Destination page tabs: Costing (default, R&D-style table: components · Cost/Pax · Catalog Price ·
  Selling (Catalog − RM200) · Margin · % · Total Gross) / Quote / Add-ons / Rates & FX / Flags / History.
- FX from each R&D sheet shown as locked chips (never editable; change in R&D, re-import).
- Krabi: hotel + season selectors. JBDO (v5): new CTRANS fullboard rate 2–10 pax incl. Whoosh,
  Whoosh column removed, Hiace option at 5 pax, 11+ pax has no rate.
- /flags/: 92 cross-check flags (catalog × R&D × calculator) with suggested fixes.
- Login/save not set up yet: no users in data/users.json (needs a fine-grained token → First-time setup).

## Waiting on the PO team (decisions)
1. Discount Tier 2: keep RM200 (31 destinations) or 0 everywhere?
2. One FX per currency (THB 0.131 vs 0.122; IDR; USD 3.97 vs 4.0295; RMB 0.65 vs 0.58; AUD).
3. For each "R&D price ≠ catalog" flag, which side is right (Seoul-Jeju +300, Bangkok, Hokkaido +1,200
   hotel, Phuket, Semporna, Aceh-Sabang/KK/Danang child prices, JBDO).
4. JBDO R&D sheet must get the new CTRANS rate before any re-import (else old cost returns); CTRANS 11+ pax rate.
5. No R&D yet: Yunnan 3 Wilayah, Ho Chi Minh, Maldives Standard (4★).

## Sources
- R&D: ~/Downloads/PT DESTINASI R&D REFORMAT/<DEST>/ (newest *reformat*; My Drive root copies are older).
- Catalog: ~/Library/CloudStorage/GoogleDrive-product@arbatravel.com/My Drive/Catalog PT (new)/catalogs/*.json
- Project PT sheet (codes, POs, catalog names): Drive file 10lru13aYbcbI888rhghOipOyiKm_6FYykfFu0xfoReQ

## Rebuild / check
```bash
python3 tools/extract_rd.py --work /tmp/ptx && python3 tools/extract_krabi.py --work /tmp/ptx
python3 tools/extract_fx.py --work /tmp/ptx
python3 tools/merge_dests.py --dests /tmp/ptx/dest --keep HND JBDO --by <you> --note "<why>"
python3 tools/make_pages.py
node tools/margins.js > /tmp/ptx/margins.json && python3 tools/crosscheck.py --fx /tmp/ptx/fx.json --margins /tmp/ptx/margins.json
node tests/test_calc.js tests/truth.json      # needs: npm i jsdom
```
Keep `--keep HND JBDO` (HND is hand-built; JBDO has the new CTRANS rate not yet in R&D).
