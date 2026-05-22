#!/usr/bin/env python3
"""
Generate a printable PDF of Music Timeline / Hitster-style cards.

Each card has:
  - FRONT: a QR code encoding `<host-url>/?id=<song-id>` (or `mt:<id>`)
  - BACK:  year + artist + title + region

Cards are laid out 4×5 (20 per page) on A4. The back sheets are mirrored
horizontally so duplex printing aligns front-to-back.

Usage:
    python scripts/make_cards.py --host https://my.site/app/
    python scripts/make_cards.py --host https://my.site/app/ --only-verified
    python scripts/make_cards.py --ids w006,r130,i004

Only --host is required. If omitted, QR codes encode `mt:<id>` and the
phone's camera app won't be able to open them — useful when you intend to
scan in-app only.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import qrcode
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

# Force UTF-8 stdout for Windows consoles.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
SONGS = ROOT / "data" / "songs.json"
OUT_DIR = ROOT / "cards"

CARDS_PER_ROW = 4
CARDS_PER_COL = 5
PAGE_W, PAGE_H = A4
MARGIN_X = 8 * mm
MARGIN_Y = 8 * mm
CARD_W = (PAGE_W - 2 * MARGIN_X) / CARDS_PER_ROW   # ~48.5 mm
CARD_H = (PAGE_H - 2 * MARGIN_Y) / CARDS_PER_COL   # ~56.2 mm


def find_unicode_font() -> str | None:
    """Locate a system font that can render Cyrillic + Hebrew. Returns the
    registered ReportLab font name, or None if we have to fall back to
    Helvetica (which only handles Latin)."""
    candidates = [
        # Windows
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\arialuni.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        # Linux common
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        # macOS
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
    return None


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


def draw_front(c: canvas.Canvas, song: dict, x: float, y: float, host: str | None) -> None:
    c.setStrokeColorRGB(0.8, 0.8, 0.8)
    c.setLineWidth(0.3)
    c.rect(x, y, CARD_W, CARD_H)

    # QR centered, with room for the card id below.
    # Cards are smaller with 4×5 layout, leave ~12mm for the id label.
    qr_size = min(CARD_W, CARD_H) - 14 * mm
    qx = x + (CARD_W - qr_size) / 2
    qy = y + (CARD_H - qr_size) / 2 + 3 * mm
    img = build_qr_image(card_payload(song, host))
    c.drawImage(img, qx, qy, width=qr_size, height=qr_size, preserveAspectRatio=True, mask="auto")

    c.setFont("Helvetica", 7)
    c.setFillColorRGB(0.4, 0.4, 0.4)
    c.drawCentredString(x + CARD_W / 2, y + 3.5 * mm, song["id"])


def wrap_text(text: str, max_chars: int) -> list[str]:
    """Naive word-wrap that respects no-break for short single words."""
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


REGION_LABEL = {
    "world":  "WORLD",
    "ussr":   "USSR",
    "russia": "RUSSIA",
    "israel": "ISRAEL",
}


def draw_back(c: canvas.Canvas, song: dict, x: float, y: float, body_font: str) -> None:
    c.setStrokeColorRGB(0.8, 0.8, 0.8)
    c.setLineWidth(0.3)
    c.rect(x, y, CARD_W, CARD_H)

    cx = x + CARD_W / 2
    # Year — big and bold. 28pt fits the smaller 4×5 cards well.
    c.setFillColorRGB(0.96, 0.78, 0.26)   # gold (#f5c842)
    c.setFont("Helvetica-Bold", 28)
    c.drawCentredString(cx, y + CARD_H - 16 * mm, str(song["year"]))

    # Artist + title. Use the unicode font if we found one.
    c.setFillColorRGB(0, 0, 0)
    c.setFont(body_font, 9)
    for i, line in enumerate(wrap_text(song["artist"], 26)):
        c.drawCentredString(cx, y + CARD_H - 24 * mm - i * 4.5 * mm, line)

    c.setFont(body_font, 7.5)
    title_y_start = y + CARD_H - 38 * mm
    for i, line in enumerate(wrap_text(song["title"], 30)):
        c.drawCentredString(cx, title_y_start - i * 3.8 * mm, line)

    c.setFont("Helvetica", 6.5)
    c.setFillColorRGB(0.5, 0.5, 0.5)
    c.drawCentredString(cx, y + 3.5 * mm, REGION_LABEL.get(song["region"], song["region"]).upper())


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--host", default=None,
                   help="Base URL of the PWA. E.g. https://my.site/app/")
    p.add_argument("--only-verified", action="store_true",
                   help="Skip songs that don't have a youtube_id yet")
    p.add_argument("--ids", default=None,
                   help="Comma-separated subset of song IDs to print")
    p.add_argument("--out", default=None,
                   help="Output PDF path (default: cards/cards-<n>.pdf)")
    args = p.parse_args()

    songs = json.loads(SONGS.read_text(encoding="utf-8"))
    if args.only_verified:
        songs = [s for s in songs if s.get("youtube_id")]
    if args.ids:
        wanted = {x.strip() for x in args.ids.split(",") if x.strip()}
        songs = [s for s in songs if s["id"] in wanted]
    if not songs:
        sys.exit("No songs selected.")

    body_font = find_unicode_font() or "Helvetica"
    if body_font == "Helvetica":
        print("Warning: no Cyrillic/Hebrew-capable font found. Card backs in"
              " those scripts will show empty boxes. Install Arial/DejaVu/Noto"
              " and rerun.")

    OUT_DIR.mkdir(exist_ok=True)
    out_path = Path(args.out) if args.out else (OUT_DIR / f"cards-{len(songs)}.pdf")
    c = canvas.Canvas(str(out_path), pagesize=A4)

    per_page = CARDS_PER_ROW * CARDS_PER_COL
    for page_start in range(0, len(songs), per_page):
        batch = songs[page_start : page_start + per_page]

        # FRONT page
        for i, song in enumerate(batch):
            col = i % CARDS_PER_ROW
            row = i // CARDS_PER_ROW
            x = MARGIN_X + col * CARD_W
            y = PAGE_H - MARGIN_Y - (row + 1) * CARD_H
            draw_front(c, song, x, y, args.host)
        c.showPage()

        # BACK page (columns reversed so duplex aligns front-to-back).
        for i, song in enumerate(batch):
            col = i % CARDS_PER_ROW
            row = i // CARDS_PER_ROW
            mirrored_col = (CARDS_PER_ROW - 1) - col
            x = MARGIN_X + mirrored_col * CARD_W
            y = PAGE_H - MARGIN_Y - (row + 1) * CARD_H
            draw_back(c, song, x, y, body_font)
        c.showPage()

    c.save()
    print(f"Wrote {len(songs)} cards across "
          f"{2 * ((len(songs) + per_page - 1) // per_page)} pages → {out_path}")
    if args.host is None:
        print("Note: no --host given. QR codes encode mt:<id>; only the app's"
              " in-app scanner can decode them. Pass --host to make them"
              " openable from the phone's native camera.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
