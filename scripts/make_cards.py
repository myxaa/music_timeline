#!/usr/bin/env python3
"""
Generate printable PDFs of Music Timeline / Hitster-style cards.

Each card:
  FRONT  — QR code + dense crosshatch bleed-blocker (prevents year
            on the other side showing through thin paper under light).
  BACK   — Year (large bold) + artist + title + region label.

Layout: 4 × 5 = 20 cards per A4 page, duplex-friendly (back sheet is
column-mirrored so QR fronts and answer backs align).

Designed for plain B&W laser/inkjet printing — no colour required.

Usage:
    python scripts/make_cards.py --host https://myxaa.github.io/music_timeline/
    python scripts/make_cards.py --host ... --region world
    python scripts/make_cards.py --host ... --region russia
    python scripts/make_cards.py --host ... --region israel
    python scripts/make_cards.py --host ... --only-verified --out cards/all.pdf
    python scripts/make_cards.py --ids w006,r130,i004 --host ...
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

try:
    from bidi.algorithm import get_display
    HAS_BIDI = True
except ImportError:
    HAS_BIDI = False

import json
import qrcode
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT    = Path(__file__).resolve().parent.parent
SONGS   = ROOT / "data" / "songs.json"
OUT_DIR = ROOT / "cards"

CARDS_PER_ROW = 4
CARDS_PER_COL = 5
PAGE_W, PAGE_H = A4
MARGIN_X = 8 * mm
MARGIN_Y = 8 * mm
CARD_W = (PAGE_W - 2 * MARGIN_X) / CARDS_PER_ROW   # ~48.5 mm
CARD_H = (PAGE_H - 2 * MARGIN_Y) / CARDS_PER_COL   # ~56.2 mm


# ─── RTL text helper ─────────────────────────────────────────────────────────
_RTL_RANGES = (
    (0x0590, 0x05FF),   # Hebrew
    (0x0600, 0x06FF),   # Arabic
    (0xFB1D, 0xFDFF),
    (0xFE70, 0xFEFF),
)

def _has_rtl(text: str) -> bool:
    return any(lo <= ord(c) <= hi for c in text for lo, hi in _RTL_RANGES)

def visual(text: str) -> str:
    """Return the string in visual left-to-right order for ReportLab rendering."""
    if HAS_BIDI and _has_rtl(text):
        return get_display(text)
    return text


# ─── Font ────────────────────────────────────────────────────────────────────
def find_unicode_font() -> str:
    candidates = [
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\arialuni.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                pdfmetrics.registerFont(TTFont("Body", path))
                return "Body"
            except Exception:
                continue
    return "Helvetica"


# ─── QR ──────────────────────────────────────────────────────────────────────
def build_qr_image(payload: str) -> ImageReader:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return ImageReader(buf)


def card_payload(song: dict, host: str | None) -> str:
    if host:
        sep = "" if host.endswith(("?", "&")) else ("&" if "?" in host else "?")
        return f"{host}{sep}id={song['id']}"
    return f"mt:{song['id']}"


# ─── Bleed-blocker crosshatch ────────────────────────────────────────────────
def draw_crosshatch(c: canvas.Canvas, x: float, y: float,
                    w: float, h: float, spacing_mm: float = 1.5) -> None:
    """
    Fill a rectangle with a dense diagonal crosshatch.

    Printed on the FRONT of a card, this opaque pattern prevents the large
    year number on the BACK from showing through thin paper when held up to
    light — a real problem with cheap 80 gsm copy paper.
    """
    s = spacing_mm * mm
    from reportlab.lib.pagesizes import A4 as _A4  # local import to avoid top-level
    c.saveState()
    # Clip to card bounds using a path so hatch lines don't escape the card.
    p = c.beginPath()
    p.rect(x, y, w, h)
    c.clipPath(p, stroke=0, fill=0)
    c.setLineWidth(0.25)
    c.setStrokeGray(0.6)

    # 45° diagonals in both directions
    diag = w + h
    steps = int(diag / s) + 2
    ox, oy = x, y + h
    for i in range(-steps, steps):
        offset = i * s
        # top-left → bottom-right
        c.line(ox + offset, oy, ox + offset + diag, oy - diag)
        # top-right → bottom-left
        c.line(ox + offset, oy - diag, ox + offset + diag, oy)

    c.restoreState()


# ─── Card faces ──────────────────────────────────────────────────────────────
def draw_front(c: canvas.Canvas, song: dict, x: float, y: float,
               host: str | None) -> None:
    # Outer border
    c.setStrokeGray(0.6)
    c.setLineWidth(0.3)
    c.rect(x, y, CARD_W, CARD_H)

    # Crosshatch bleed-blocker fills the whole card face (behind the QR).
    # It is light enough that a scanner still reads the QR easily, but
    # dense enough to block the year from showing through 80 gsm paper.
    draw_crosshatch(c, x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1, spacing_mm=1.8)

    # White rectangle behind QR so the QR is clean against the hatch
    qr_size = min(CARD_W, CARD_H) - 14 * mm
    qx = x + (CARD_W - qr_size) / 2
    qy = y + (CARD_H - qr_size) / 2 + 3 * mm
    pad = 1.5 * mm
    c.setFillGray(1.0)
    c.setStrokeGray(1.0)
    c.rect(qx - pad, qy - pad, qr_size + 2 * pad, qr_size + 2 * pad, stroke=0, fill=1)

    # QR code
    img = build_qr_image(card_payload(song, host))
    c.drawImage(img, qx, qy, width=qr_size, height=qr_size,
                preserveAspectRatio=True, mask="auto")

    # Card ID label at bottom
    c.setFillGray(0.0)
    c.setFont("Helvetica", 6.5)
    c.drawCentredString(x + CARD_W / 2, y + 3 * mm, song["id"])


def wrap_text(text: str, max_chars: int) -> list[str]:
    if not text:
        return [""]
    words = text.split()
    lines, cur = [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > max_chars:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(cur)
    return lines


REGION_LABEL = {"world": "WORLD", "ussr": "USSR", "russia": "RUSSIA", "israel": "ISRAEL"}


def draw_back(c: canvas.Canvas, song: dict, x: float, y: float,
              body_font: str) -> None:
    # Outer border
    c.setStrokeGray(0.6)
    c.setFillGray(1.0)
    c.setLineWidth(0.3)
    c.rect(x, y, CARD_W, CARD_H, stroke=1, fill=1)

    cx = x + CARD_W / 2

    # Year — large bold, black
    c.setFillGray(0.0)
    c.setFont("Helvetica-Bold", 26)
    c.drawCentredString(cx, y + CARD_H - 15 * mm, str(song["year"]))

    # Thin rule under year
    c.setStrokeGray(0.7)
    c.setLineWidth(0.3)
    c.line(x + 4 * mm, y + CARD_H - 17.5 * mm, x + CARD_W - 4 * mm, y + CARD_H - 17.5 * mm)

    # Artist
    c.setFillGray(0.0)
    c.setFont(body_font, 8.5)
    for i, line in enumerate(wrap_text(visual(song["artist"]), 28)):
        c.drawCentredString(cx, y + CARD_H - 23 * mm - i * 4.5 * mm, line)

    # Title (slightly smaller, grey)
    c.setFillGray(0.3)
    c.setFont(body_font, 7)
    title_y = y + CARD_H - 35 * mm
    for i, line in enumerate(wrap_text(visual(song["title"]), 32)):
        c.drawCentredString(cx, title_y - i * 3.8 * mm, line)

    # Region label — small caps style at bottom
    c.setFillGray(0.5)
    c.setFont("Helvetica", 6)
    c.drawCentredString(cx, y + 3 * mm,
                        REGION_LABEL.get(song["region"], song["region"]).upper())

    # Thin rule above region label
    c.setStrokeGray(0.8)
    c.line(x + 4 * mm, y + 7 * mm, x + CARD_W - 4 * mm, y + 7 * mm)


# ─── Main ────────────────────────────────────────────────────────────────────
def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--host", default=None)
    p.add_argument("--only-verified", action="store_true")
    p.add_argument("--region", default=None,
                   help="Filter by region: world | russia | israel | ussr "
                        "(russia includes both russia+ussr; omit for all)")
    p.add_argument("--ids", default=None)
    p.add_argument("--out", default=None)
    args = p.parse_args()

    all_songs = json.loads(SONGS.read_text(encoding="utf-8"))

    songs = [s for s in all_songs if s.get("youtube_id")]  # verified only

    if args.region:
        region = args.region.lower()
        if region == "russia":
            songs = [s for s in songs if s["region"] in ("russia", "ussr")]
        else:
            songs = [s for s in songs if s["region"] == region]
    if args.only_verified:
        pass  # already filtered above
    if args.ids:
        wanted = {x.strip() for x in args.ids.split(",") if x.strip()}
        songs = [s for s in all_songs if s["id"] in wanted]  # allow unverified for --ids
    if not songs:
        sys.exit("No songs selected.")

    body_font = find_unicode_font()
    if body_font == "Helvetica" and not HAS_BIDI:
        print("Warning: no Unicode-capable font found and python-bidi missing. "
              "Cyrillic/Hebrew cards may render incorrectly.")

    if not HAS_BIDI:
        print("Warning: python-bidi not installed. Hebrew/Arabic text will be reversed. "
              "Install with: pip install python-bidi")

    OUT_DIR.mkdir(exist_ok=True)
    if args.out:
        out_path = Path(args.out)
    else:
        tag = args.region or "all"
        out_path = OUT_DIR / f"cards-{tag}.pdf"

    c = canvas.Canvas(str(out_path), pagesize=A4)
    per_page = CARDS_PER_ROW * CARDS_PER_COL

    for page_start in range(0, len(songs), per_page):
        batch = songs[page_start: page_start + per_page]

        # FRONT page (QR + bleed blocker)
        for i, song in enumerate(batch):
            col = i % CARDS_PER_ROW
            row = i // CARDS_PER_ROW
            x = MARGIN_X + col * CARD_W
            y = PAGE_H - MARGIN_Y - (row + 1) * CARD_H
            draw_front(c, song, x, y, args.host)
        c.showPage()

        # BACK page (answer) — columns mirrored for duplex alignment
        for i, song in enumerate(batch):
            col = i % CARDS_PER_ROW
            row = i // CARDS_PER_ROW
            mirrored_col = (CARDS_PER_ROW - 1) - col
            x = MARGIN_X + mirrored_col * CARD_W
            y = PAGE_H - MARGIN_Y - (row + 1) * CARD_H
            draw_back(c, song, x, y, body_font)
        c.showPage()

    c.save()
    print(f"Wrote {len(songs)} cards ({(len(songs) + per_page - 1) // per_page} "
          f"page-pairs) → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
