"""Write the ARBA internal rate sheet for Qayyum (Tokyo) as a PDF from data/data.json (HND rates).

Qayyum has no contract-rate document on file; its rates live in the Japan ProdReq (§5.2–5.3, §12).
This sheet is ARBA's own summary of those rates, labelled as such — not a supplier document.

    python3 tools/make_qayyum_sheet.py contracts/hnd/<file>.pdf
"""
import json, sys, datetime
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

out = sys.argv[1]
d = next(x for x in json.load(open("data/data.json"))["destinations"] if x["code"] == "HND")
R = {r["id"]: r for r in d["rates"]}
FX = next(f["value"] for f in d["fx"] if f["id"] == "QAYYUM")
yen = lambda v: "¥{:,.0f}".format(v)
rm = lambda v: "RM{:,.2f}".format(v)

st = getSampleStyleSheet()
H1 = ParagraphStyle("h1", parent=st["Title"], fontSize=16, spaceAfter=2)
H2 = ParagraphStyle("h2", parent=st["Heading2"], fontSize=11.5, spaceBefore=10, spaceAfter=4)
P = ParagraphStyle("p", parent=st["BodyText"], fontSize=8.8, leading=11.5)
S = ParagraphStyle("s", parent=P, fontSize=7.8, leading=10, textColor=colors.HexColor("#555555"))
WARN = ParagraphStyle("w", parent=P, backColor=colors.HexColor("#fff1a8"), borderPadding=5, leading=12)

def table(rows, widths, head=True):
    t = Table(rows, colWidths=widths, repeatRows=1 if head else 0)
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), "Helvetica", 8.3),
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.3),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#dde3ea")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f3f4f6")]),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c9d0d8")),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    return t

story = [
    Paragraph("QAYYUM TOKYO — RATE SHEET 2026", H1),
    Paragraph("ARBA Travel · Product R&amp;D · disusun %s" % datetime.date.today().strftime("%d %b %Y"), S),
    Spacer(1, 6),
    Paragraph("<b>Dokumen dalaman ARBA — bukan kontrak rasmi Qayyum.</b> Qayyum tidak mengeluarkan CR bertulis. "
              "Kadar di bawah disusun daripada <b>ProdReq Jepun</b> (§5.2–5.3, §12; sumber asal: Tokyo raw costing sheet "
              "Jan–Dec 2026 dan CROSS CHECK JEPUN.xlsx), termasuk revisi Qayyum yang disahkan PO Sep 2026. "
              "Sahkan dengan Qayyum sebelum dijadikan rujukan kontrak.", WARN),
    Paragraph("1. Asas", H2),
    Paragraph("Kenderaan Toyota Voxy / Noah (7 tempat), <b>1–7 pax</b> (6 pax paling selesa). Kadar <b>bundled</b>: transport + "
              "driving guide Melayu beragama Islam, 10 jam termasuk masa perjalanan. Tiada elaun guide atau service charge WIF "
              "di atasnya. FX Qayyum <b>1 JPY = RM%s</b> (ditetapkan PO). Mata wang sumber: JPY." % FX, P),
    Paragraph("2. Kadar (per kenderaan)", H2),
]
rows = [["Item", "Asas", "Revisi", "Dicaj", "RM @ %s" % FX, "Nota"]]
lines = [("Airport transfer Haneda (sehala)", 20000, 2000, "+¥2,000 sehala (PO Sep 2026)"),
         ("Airport transfer Narita (sehala)", 30000, 2000, "pickup sebelum 09:00 +¥5,000"),
         ("Tokyo City Tour (10 jam)", 73000, 3000, "+¥3,000 setiap trip"),
         ("Fuji Tour (10 jam)", 78000, 3000, "pickup sebelum 09:00 +¥5,000"),
         ("Tokyo + Ghibli / Hello Kitty / Harry Potter", 77000, None, "revisi +¥3,000 belum disahkan"),
         ("Kamakura (10 jam)", 78000, None, "revisi +¥3,000 belum disahkan"),
         ("Disneyland / DisneySea transfer (sehala)", 20000, None, "revisi belum disahkan"),
         ("Shinkansen transfer hotel ↔ Tokyo Station (sehala)", 20000, None, "revisi belum disahkan")]
for name, base, rev, note in lines:
    ch = base + (rev or 0)
    rows.append([Paragraph(name, P), yen(base), "+" + yen(rev) if rev else "—", yen(ch), rm(ch * FX), Paragraph(note, S)])
story.append(table(rows, [62 * mm, 18 * mm, 16 * mm, 18 * mm, 22 * mm, 44 * mm]))
story.append(Spacer(1, 3))
story.append(Paragraph("Hub calculator menggunakan: Haneda %s, City Tour %s, Fuji %s." % (yen(R["hndQ"]["value"]), yen(R["qCity"]["value"]), yen(R["qFuji"]["value"])), S))

story.append(Paragraph("3. Costing PT Tokyo Standard 5D4N (Qayyum, 2–7 pax)", H2))
story.append(Paragraph("Airport Haneda ×2 (D1, D5) · Fuji Tour ×1 · Tokyo City Tour ×3 · apartment RM%s/pax/malam × %d malam · "
                       "Iyashi No Sato %s/pax." % (R["apt"]["value"], d["nights"], yen(R["iyashi"]["value"])), P))
rows = [["Pax", "Airport Haneda\n(%s × 2)" % yen(R["hndQ"]["value"]), "Fuji + City ×3\n(%s + %s × 3)" % (yen(R["qFuji"]["value"]), yen(R["qCity"]["value"])),
         "Iyashi No Sato\n(%s × pax)" % yen(R["iyashi"]["value"]), "Apartment\n(RM%s × %d × pax)" % (R["apt"]["value"], d["nights"]), "Kos / pax"]]
for p in range(2, 8):
    air = 2 * R["hndQ"]["value"] * FX
    tr = (R["qFuji"]["value"] + 3 * R["qCity"]["value"]) * FX
    ent = R["iyashi"]["value"] * FX * p
    apt = R["apt"]["value"] * d["nights"] * p
    rows.append([str(p), rm(air), rm(tr), rm(ent), rm(apt), rm((air + tr + ent + apt) / p)])
story.append(table(rows, [12 * mm, 30 * mm, 42 * mm, 30 * mm, 36 * mm, 30 * mm]))
story.append(Paragraph("Lajur kenderaan dan entrance ialah jumlah kumpulan; Kos / pax = jumlah ÷ pax.", S))

story.append(Paragraph("4. Caj operasi (dari sheet supplier Tokyo)", H2))
for t in ["Overtime: 7 &amp; 10 seater ¥5,000/jam (satu quote TO Sep 2026 sebut ¥7,000 — sahkan); dibayar tunai kepada driver.",
          "Driver bermalam jauh dari base (Fuji / Shirakawa): ¥10,000/malam.",
          "Penginapan mesti dalam 23 wad Tokyo. Itabashi / Nerima / Suginami: airport +¥2,000, full day +¥5,000.",
          "Narita, Fuji, Hakone: pickup sebelum 09:00 +¥5,000.",
          "Tokyo return fee ¥50,000 bila tour tamat di luar Tokyo.",
          "Kerusi keselamatan bayi / kanak-kanak ¥5,000 setiap kerusi (wajib).",
          "Airport transfer: maksimum 1 bagasi (saiz S–M) setiap pax."]:
    story.append(Paragraph("• " + t, P))
story.append(Paragraph("5. Belum disahkan dengan Qayyum", H2))
for t in ["Tol, parking dan minyak termasuk dalam kadar trip atau tidak.",
          "Tiket entrance driving guide termasuk dalam kadar bundled atau dicaj berasingan.",
          "Revisi +¥3,000 untuk Disney / Shinkansen transfer, Ghibli dan Kamakura.",
          "Makan guide (¥1,500/hari) dianggap termasuk dalam kadar bundled.",
          "Status lesen kenderaan (plat hijau)."]:
    story.append(Paragraph("• " + t, P))

def foot(c, doc):
    c.setFont("Helvetica", 7); c.setFillColor(colors.HexColor("#777777"))
    c.drawString(15 * mm, 10 * mm, "ARBA Travel · Dokumen dalaman · Bukan kontrak Qayyum · Sumber: ProdReq Jepun")
    c.drawRightString(195 * mm, 10 * mm, "Muka %d" % doc.page)

SimpleDocTemplate(out, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm, bottomMargin=16 * mm,
                  title="Qayyum Tokyo Rate Sheet 2026 (ARBA internal)", author="ARBA Travel Product R&D").build(story, onFirstPage=foot, onLaterPages=foot)
print("wrote", out)
