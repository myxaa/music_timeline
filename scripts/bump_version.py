#!/usr/bin/env python3
"""
Bump the cache-busting version in lockstep across app/index.html and app/sw.js.

The version string has the form YYYYMMDDx where x is a single lowercase letter
that distinguishes multiple releases on the same day. The same string is used
as the service-worker cache name suffix and as the ?v= query on every shell
asset reference, so both files must move together.

Usage:
  python scripts/bump_version.py            # today, auto-increment letter
  python scripts/bump_version.py --to 20260524a  # explicit value
"""
from __future__ import annotations

import argparse
import datetime as dt
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGETS = [ROOT / "app/index.html", ROOT / "app/sw.js"]
VERSION_RE = re.compile(r"\b(\d{8})([a-z])\b")


def find_current_version() -> str | None:
    """Pick the version string that already appears in app/sw.js."""
    text = (ROOT / "app/sw.js").read_text(encoding="utf-8")
    m = re.search(r'VERSION\s*=\s*"(\d{8}[a-z])"', text)
    return m.group(1) if m else None


def next_version(today: dt.date, current: str | None) -> str:
    """If we already shipped today, advance the suffix letter; else 'a'."""
    today_str = today.strftime("%Y%m%d")
    if current and current.startswith(today_str):
        letter = current[-1]
        if letter == "z":
            sys.exit("Already at suffix 'z' for today — wait until tomorrow.")
        return today_str + chr(ord(letter) + 1)
    return today_str + "a"


def rewrite(path: pathlib.Path, new_ver: str) -> int:
    """Replace every YYYYMMDDx token in the file. Returns # of substitutions."""
    text = path.read_text(encoding="utf-8")
    new_text, n = VERSION_RE.subn(new_ver, text)
    if n:
        path.write_text(new_text, encoding="utf-8")
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--to", help="Explicit version (e.g. 20260524a)")
    args = ap.parse_args()

    current = find_current_version()
    if args.to:
        if not re.fullmatch(r"\d{8}[a-z]", args.to):
            sys.exit(f"--to must look like YYYYMMDDx, got {args.to!r}")
        new_ver = args.to
    else:
        new_ver = next_version(dt.date.today(), current)

    if current == new_ver:
        print(f"Already at {new_ver} — nothing to do.")
        return

    total = 0
    for path in TARGETS:
        n = rewrite(path, new_ver)
        print(f"  {path.relative_to(ROOT)}: {n} replacement(s)")
        total += n

    print(f"\n{current!r} -> {new_ver!r}  ({total} replacement(s) across {len(TARGETS)} files)")
    print("\nNext: git add -p && git commit && git push")


if __name__ == "__main__":
    main()
