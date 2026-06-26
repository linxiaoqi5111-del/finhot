#!/usr/bin/env python3
"""FinHot scheduled-task health monitor.

Runs a handful of cheap checks against the locally-running FinHot stack and
reports whether the scheduled scrape -> enrich -> deploy pipeline is healthy.

Checks
------
1. rss-proxy service   : http://localhost:2233/api/public/manifest returns 200
2. embedding service   : http://localhost:8077/v1/models returns 200
3. devweb LaunchAgent  : com.finhot.devweb is loaded with a live PID
4. cache freshness     : per-category newest feed `updatedAt` is recent enough
                         for the most recent scheduled refresh slot (Beijing
                         time, matches planRefreshAt in rss-proxy.ts)
5. auto-deploy outcome : the most recent deploy line in the devweb log is a
                         success, not an `Auto-deploy failed` (e.g. ETIMEDOUT)

On any failure it fires a single macOS desktop notification (deduplicated so it
does not spam every run) and always writes a machine-readable health.json.

Usage
-----
    python3 monitor.py            # run checks, print summary, write health.json
    python3 monitor.py --notify   # also raise macOS notifications on problems
    python3 monitor.py --json     # print the full health.json to stdout
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.request

# ── Configuration ────────────────────────────────────────────────────────────
REPO = os.environ.get("FINHOT_REPO", "/Users/a77/khazix-skills")
CACHE_DIR = os.path.join(REPO, "apps/desktop/.finhot-cache")
MANIFEST = os.path.join(CACHE_DIR, "manifest.json")
HEALTH_OUT = os.path.join(CACHE_DIR, "monitor-health.json")
STATE_FILE = "/tmp/finhot-monitor-state.json"
DEVWEB_LOG = "/tmp/finhot-devweb.log"

RSS_URL = "http://localhost:2233/api/public/manifest"
EMBED_URL = "http://localhost:8077/v1/models"
HTTP_TIMEOUT = 12

# How long after a scheduled slot before we expect the refresh to have landed.
MARKET_GRACE_MIN = 15  # scrape + enrich + (slow) deploy
WECHAT_GRACE_MIN = 20
FRESH_TOLERANCE_MIN = 6  # clock skew / slot rounding slack

# Re-notify about the same ongoing problem at most this often.
RENOTIFY_SEC = 3600

BJ = dt.timezone(dt.timedelta(hours=8))  # Beijing, fixed UTC+8 (no DST)

MARKET_CATEGORIES = ("推特", "雪球", "微博")
WECHAT_CATEGORY = "微信"


# ── Schedule helpers (mirror planRefreshAt in rss-proxy.ts) ──────────────────
def _market_slots(now_bj: dt.datetime) -> list[dt.datetime]:
    slots: list[dt.datetime] = []
    for dayoff in (-1, 0):
        d = (now_bj + dt.timedelta(days=dayoff)).date()
        times = [(8, 30), (21, 30)]
        h, m = 9, 30
        while (h, m) <= (15, 0):
            times.append((h, m))
            m += 30
            if m == 60:
                m, h = 0, h + 1
        for hh, mm in times:
            slots.append(dt.datetime(d.year, d.month, d.day, hh, mm, tzinfo=BJ))
    return sorted(slots)


def _wechat_slots(now_bj: dt.datetime) -> list[dt.datetime]:
    slots: list[dt.datetime] = []
    for dayoff in (-1, 0):
        d = (now_bj + dt.timedelta(days=dayoff)).date()
        for hh, mm in ((8, 30), (21, 30)):
            slots.append(dt.datetime(d.year, d.month, d.day, hh, mm, tzinfo=BJ))
    return sorted(slots)


def _last_due_slot(slots: list[dt.datetime], now_bj: dt.datetime, grace_min: int):
    cutoff = now_bj - dt.timedelta(minutes=grace_min)
    due = [s for s in slots if s <= cutoff]
    return due[-1] if due else None


# ── Individual checks ────────────────────────────────────────────────────────
def _http_ok(url: str) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            code = resp.getcode()
            return (200 <= code < 300, f"HTTP {code}")
    except Exception as exc:  # noqa: BLE001 - report any failure verbatim
        return (False, f"{type(exc).__name__}: {exc}")


def check_rss() -> dict:
    ok, detail = _http_ok(RSS_URL)
    return {"name": "rss-proxy (:2233)", "ok": ok, "detail": detail}


def check_embed() -> dict:
    ok, detail = _http_ok(EMBED_URL)
    return {"name": "embedding (:8077)", "ok": ok, "detail": detail}


def check_devweb_agent() -> dict:
    try:
        out = subprocess.run(
            ["launchctl", "list", "com.finhot.devweb"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        return {"name": "devweb LaunchAgent", "ok": False, "detail": f"{type(exc).__name__}: {exc}"}
    if out.returncode != 0:
        return {"name": "devweb LaunchAgent", "ok": False, "detail": "not loaded"}
    pid = None
    for line in out.stdout.splitlines():
        s = line.strip()
        if s.startswith('"PID"'):
            pid = s.split("=")[-1].strip().rstrip(";").strip()
    if pid and pid.isdigit():
        return {"name": "devweb LaunchAgent", "ok": True, "detail": f"PID {pid}"}
    return {"name": "devweb LaunchAgent", "ok": False, "detail": "loaded but no PID (crashed/idle)"}


def _parse_iso(s: str):
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return None


def check_freshness(now_bj: dt.datetime) -> list[dict]:
    results: list[dict] = []
    try:
        with open(MANIFEST, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        return [{"name": "cache freshness", "ok": False, "detail": f"manifest unreadable: {exc}"}]

    feeds = manifest.get("feeds", {}) if isinstance(manifest, dict) else {}
    newest: dict[str, dt.datetime] = {}
    for feed in feeds.values():
        cat = feed.get("category")
        ts = _parse_iso(feed.get("updatedAt", ""))
        if not cat or ts is None:
            continue
        if cat not in newest or ts > newest[cat]:
            newest[cat] = ts

    def evaluate(cat: str, due: dt.datetime | None):
        latest = newest.get(cat)
        if due is None:
            results.append({"name": f"freshness {cat}", "ok": True, "detail": "no slot due yet"})
            return
        if latest is None:
            results.append({"name": f"freshness {cat}", "ok": False, "detail": "no feeds in manifest"})
            return
        age_min = (now_bj - latest.astimezone(BJ)).total_seconds() / 60
        expected_by = due - dt.timedelta(minutes=FRESH_TOLERANCE_MIN)
        ok = latest.astimezone(BJ) >= expected_by
        detail = (
            f"newest {latest.astimezone(BJ):%m-%d %H:%M} ({age_min:.0f}m ago); "
            f"due slot {due:%m-%d %H:%M}"
        )
        results.append({"name": f"freshness {cat}", "ok": ok, "detail": detail})

    market_due = _last_due_slot(_market_slots(now_bj), now_bj, MARKET_GRACE_MIN)
    for cat in MARKET_CATEGORIES:
        evaluate(cat, market_due)
    wechat_due = _last_due_slot(_wechat_slots(now_bj), now_bj, WECHAT_GRACE_MIN)
    evaluate(WECHAT_CATEGORY, wechat_due)
    return results


def check_deploy() -> dict:
    try:
        with open(DEVWEB_LOG, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()[-6000:]
    except Exception as exc:  # noqa: BLE001
        return {"name": "auto-deploy", "ok": False, "detail": f"log unreadable: {exc}"}
    last_ok = last_fail = -1
    for i, line in enumerate(lines):
        if "Auto-deployed public site" in line:
            last_ok = i
        elif "Auto-deploy failed" in line:
            last_fail = i
    if last_ok < 0 and last_fail < 0:
        return {"name": "auto-deploy", "ok": True, "detail": "no deploy events in recent log"}
    if last_fail > last_ok:
        msg = lines[last_fail].split("]", 1)[-1].strip() or lines[last_fail].strip()
        return {"name": "auto-deploy", "ok": False, "detail": f"last deploy FAILED: {msg[:120]}"}
    url = lines[last_ok].rsplit("→", 1)[-1].strip() if "→" in lines[last_ok] else "ok"
    return {"name": "auto-deploy", "ok": True, "detail": f"last deploy ok ({url})"}


# ── Notification + state ─────────────────────────────────────────────────────
def _osa_quote(s: str) -> str:
    # AppleScript string literal: escape backslash/quote, flatten newlines.
    return (
        s.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\r", " ")
        .replace("\n", " · ")
    )


def _notify(title: str, message: str) -> None:
    try:
        script = (
            f'display notification "{_osa_quote(message)}" '
            f'with title "{_osa_quote(title)}" sound name "Basso"'
        )
        subprocess.run(["osascript", "-e", script], timeout=10)
    except Exception:  # noqa: BLE001 - notification is best-effort
        pass


def _load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:  # noqa: BLE001
        return {}


def _save_state(state: dict) -> None:
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
    except Exception:  # noqa: BLE001
        pass


def maybe_notify(failures: list[dict]) -> None:
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    state = _load_state()
    signature = "|".join(sorted(f["name"] for f in failures))
    prev_sig = state.get("signature", "")
    prev_ts = float(state.get("ts", 0))

    if not failures:
        if prev_sig:  # recovered from a previous problem
            _notify("FinHot 监控 · 已恢复", "定时任务恢复正常 ✅")
        _save_state({"signature": "", "ts": now})
        return

    changed = signature != prev_sig
    stale = (now - prev_ts) > RENOTIFY_SEC
    if changed or stale:
        lines = [f"✗ {f['name']}: {f['detail']}" for f in failures]
        _notify("FinHot 监控 · 异常", "\n".join(lines)[:600])
    _save_state({"signature": signature, "ts": now})


# ── Main ─────────────────────────────────────────────────────────────────────
def run() -> dict:
    now_utc = dt.datetime.now(dt.timezone.utc)
    now_bj = now_utc.astimezone(BJ)
    checks: list[dict] = [check_rss(), check_embed(), check_devweb_agent()]
    checks.extend(check_freshness(now_bj))
    checks.append(check_deploy())
    failures = [c for c in checks if not c["ok"]]
    return {
        "checkedAt": now_utc.isoformat(),
        "checkedAtBeijing": now_bj.strftime("%Y-%m-%d %H:%M:%S"),
        "overall": "ok" if not failures else "fail",
        "failingCount": len(failures),
        "checks": checks,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--notify", action="store_true", help="raise macOS notifications on problems")
    ap.add_argument("--json", action="store_true", help="print full health.json to stdout")
    args = ap.parse_args()

    health = run()
    try:
        os.makedirs(os.path.dirname(HEALTH_OUT), exist_ok=True)
        with open(HEALTH_OUT, "w", encoding="utf-8") as fh:
            json.dump(health, fh, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        print(f"warn: could not write {HEALTH_OUT}: {exc}", file=sys.stderr)

    failures = [c for c in health["checks"] if not c["ok"]]
    if args.notify:
        maybe_notify(failures)

    if args.json:
        print(json.dumps(health, ensure_ascii=False, indent=2))
    else:
        print(f"[{health['checkedAtBeijing']}] overall={health['overall']} "
              f"({len(failures)} failing)")
        for c in health["checks"]:
            mark = "ok " if c["ok"] else "FAIL"
            print(f"  [{mark}] {c['name']}: {c['detail']}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
