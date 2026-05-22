#!/usr/bin/env python3
"""
Verifier for the Music Timeline / Hitster-clone song database.

Reads data/songs.json. For every entry without a youtube_id, searches YouTube
via yt-dlp and captures the top result's video ID, duration, and uploader.
Sanity-checks duration (60s..600s by default). Writes results back to
data/songs.json. Failures are logged to data/verify_failures.json.

Idempotent: re-running skips already-verified entries unless --reverify is set.

Usage:
    python scripts/verify.py                         # verify all unverified
    python scripts/verify.py --limit 15              # smoke-test first 15
    python scripts/verify.py --reverify              # re-check everything
    python scripts/verify.py --only-failed           # retry past failures
    python scripts/verify.py --ids 001,002,003       # verify specific IDs
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date
from pathlib import Path

import yt_dlp

# Windows consoles default to cp1251/cp1252 which can't print Cyrillic/Hebrew.
# Force UTF-8 on stdout so logging never crashes on non-ASCII titles.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
SONGS = ROOT / "data" / "songs.json"
FAILURES = ROOT / "data" / "verify_failures.json"

MIN_DURATION = 45      # seconds — shorter is likely a clip/snippet
MAX_DURATION = 720     # seconds — longer is likely a compilation/live set


def load_songs() -> list[dict]:
    if not SONGS.exists():
        sys.exit(f"Missing {SONGS}. Create it first.")
    return json.loads(SONGS.read_text(encoding="utf-8"))


def save_songs(songs: list[dict]) -> None:
    SONGS.write_text(
        json.dumps(songs, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def load_failures() -> dict:
    if FAILURES.exists():
        return json.loads(FAILURES.read_text(encoding="utf-8"))
    return {}


def save_failures(failures: dict) -> None:
    FAILURES.write_text(
        json.dumps(failures, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def search_youtube(query: str, n_candidates: int = 5) -> list[dict]:
    """Return up to `n_candidates` YouTube search results for `query`.

    We ask for several so the verifier can skip unavailable / wrong-duration
    top hits without bailing out on the song entirely.
    """
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        # Flat first — cheap. We'll re-resolve the chosen candidate for
        # full duration/availability metadata.
        "extract_flat": "in_playlist",
        "default_search": f"ytsearch{n_candidates}",
        "noplaylist": True,
        "socket_timeout": 30,
        "ignoreerrors": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(query, download=False)
    if not info:
        return []
    entries = info.get("entries") or []
    return [e for e in entries if e and e.get("id")]


def resolve_video(video_id: str) -> dict | None:
    """Fetch full metadata for a single video. Returns None if unavailable."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": 30,
    }
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)
    except Exception:
        return None


def build_query(song: dict) -> str:
    # ytsearch1 already picks the most-viewed result, which is usually the
    # canonical upload. Extra hints like "official audio" hurt for older
    # USSR/Israeli tracks that predate that convention.
    if song.get("query"):
        return song["query"]
    return f"{song['artist']} {song['title']}"


def verify_song(song: dict) -> tuple[dict | None, str | None]:
    """Returns (updated_song, error). On success error is None.

    Walks the top-N search hits and picks the first one that is both
    available and has a plausible duration.
    """
    query = build_query(song)
    try:
        candidates = search_youtube(query, n_candidates=5)
    except Exception as e:  # network, parse, etc.
        return None, f"search_error: {type(e).__name__}: {e}"
    if not candidates:
        return None, "no_results"

    last_reason = "no_candidate_passed"
    for cand in candidates:
        vid = cand.get("id")
        if not vid:
            continue
        full = resolve_video(vid)
        if not full:
            last_reason = f"unavailable: {vid}"
            continue
        duration = full.get("duration")
        if duration is None:
            last_reason = f"no_duration: {vid}"
            continue
        if duration < MIN_DURATION or duration > MAX_DURATION:
            last_reason = f"duration_out_of_range: {duration}s ({vid})"
            continue

        updated = dict(song)
        updated["youtube_id"] = vid
        updated["duration"] = int(duration)
        updated["yt_title"] = full.get("title", "")
        updated["yt_uploader"] = full.get("uploader") or full.get("channel", "")
        updated["verified"] = True
        updated["verified_at"] = date.today().isoformat()
        updated["search_query"] = query
        return updated, None

    return None, last_reason


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--limit", type=int, default=None,
                   help="Only process the first N candidate entries")
    p.add_argument("--reverify", action="store_true",
                   help="Re-verify entries even if already verified")
    p.add_argument("--only-failed", action="store_true",
                   help="Only retry entries that previously failed")
    p.add_argument("--ids", type=str, default=None,
                   help="Comma-separated song IDs to verify")
    p.add_argument("--sleep", type=float, default=0.5,
                   help="Seconds between requests (politeness)")
    args = p.parse_args()

    songs = load_songs()
    failures = load_failures()

    targets: list[int] = []
    ids_filter: set[str] | None = None
    if args.ids:
        ids_filter = {x.strip() for x in args.ids.split(",") if x.strip()}

    for i, s in enumerate(songs):
        sid = s.get("id")
        if ids_filter is not None:
            if sid in ids_filter:
                targets.append(i)
            continue
        if args.only_failed:
            if sid in failures:
                targets.append(i)
            continue
        if args.reverify:
            targets.append(i)
            continue
        if not s.get("verified"):
            targets.append(i)

    if args.limit is not None:
        targets = targets[: args.limit]

    print(f"Verifying {len(targets)} song(s)...")
    ok = 0
    fail = 0
    for n, i in enumerate(targets, start=1):
        s = songs[i]
        sid = s.get("id", f"idx{i}")
        label = f"[{n}/{len(targets)}] {sid} {s['artist']} - {s['title']} ({s['year']})"
        print(label)
        updated, err = verify_song(s)
        if updated is None:
            print(f"  FAIL: {err}")
            failures[sid] = {
                "artist": s["artist"],
                "title": s["title"],
                "year": s["year"],
                "error": err,
                "at": date.today().isoformat(),
            }
            fail += 1
        else:
            songs[i] = updated
            failures.pop(sid, None)
            print(f"  OK: id={updated['youtube_id']} dur={updated['duration']}s "
                  f"\"{updated['yt_title'][:60]}\"")
            ok += 1

        # Persist incrementally — long runs can be interrupted.
        if n % 10 == 0:
            save_songs(songs)
            save_failures(failures)
        time.sleep(args.sleep)

    save_songs(songs)
    save_failures(failures)
    print(f"\nDone: {ok} ok, {fail} failed. Failures in {FAILURES.name}.")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
