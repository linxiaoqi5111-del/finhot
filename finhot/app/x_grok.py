"""Native X (Twitter) fetch supplement for finhot.

Uses the agent's built-in native X search tools (x_keyword_search etc.)
to get reliable recent posts, bypassing fragile public Nitter/RSSHub.

Workflow:
- Run `python -m app.x_grok prepare` to see the current X users from watchlist
  and the exact prompt to give the agent (Grok).
- Ask the agent: "fetch latest X posts for these users and output as finhot items JSON"
- Agent uses native tools, normalizes, and can directly write data/x_grok.json
  (or you paste the JSON and save).
- Collector / watchlist will automatically pick up items from data/x_grok.json
  (merged with RSS fallback; dedup handles overlap).

The native path gives better coverage, full recent history, thread context option,
and is not dependent on public scrapers dying.

Item format is the same as sources.py / watchlist.py.
"""

import json
import os
import time
from datetime import datetime

WATCHLIST_PATH = os.path.join(os.path.dirname(__file__), "..", "watchlist.json")
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
GROK_X_PATH = os.path.join(DATA_DIR, "x_grok.json")  # list of item dicts


def load_watchlist_x_users():
    """Return the list of X usernames from watchlist.json (without @)."""
    try:
        with open(WATCHLIST_PATH, encoding="utf-8") as f:
            wl = json.load(f)
        return [u.lstrip("@") for u in wl.get("x", [])]
    except Exception:
        return []


def normalize_post(user: str, post: dict) -> dict:
    """Convert a post from agent's x_keyword_search (or similar) result to finhot item.

    Expected post keys (from tool): ID, Author, Timestamp, Content, url if present.
    We make url robust.
    """
    pid = post.get("ID") or post.get("id") or str(int(time.time() * 1000))
    author = post.get("Author") or f"X@{user}"
    content = post.get("Content") or post.get("content") or ""
    # Try to get a clean url
    url = post.get("url") or ""
    if not url and pid:
        url = f"https://x.com/{user}/status/{pid}"

    # Parse timestamp to unix
    ts_str = post.get("Timestamp") or post.get("timestamp") or ""
    ts = 0
    if ts_str:
        try:
            # Handles "Thu, 25 Jun 2026 05:42:22 GMT"
            dt = datetime.strptime(ts_str.split(" (")[0], "%a, %d %b %Y %H:%M:%S %Z")
            ts = int(dt.timestamp())
        except Exception:
            try:
                # Fallback ISO or other
                ts = int(datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp())
            except Exception:
                ts = int(time.time())

    # id consistent with _mkid style but using native source tag
    import hashlib
    raw = f"{user}:{pid}"
    iid = "xnat:" + hashlib.md5(raw.encode()).hexdigest()[:16]

    return {
        "id": iid,
        "source": f"X@{user} (native)",
        "title": "",
        "content": content.strip()[:4000],  # safety
        "url": url,
        "ts": ts,
    }


def load_grok_items(path: str = GROK_X_PATH) -> list:
    """Load previously saved native X items (if the file exists)."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "items" in data:
            return data["items"]
        return []
    except FileNotFoundError:
        return []
    except Exception as e:
        print(f"[x_grok] failed to load {path}: {e}")
        return []


def save_grok_items(items: list, path: str = GROK_X_PATH):
    """Save items (usually called by agent after native fetch)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    print(f"[x_grok] wrote {len(items)} items to {path}")


def save_for_proxy_cache(items: list, cache_root: str | None = None):
    """Convert finhot-style items to the format expected by the central rss-proxy cache
    and write x_grok_entries.json in .finhot-cache (so /api/public/refresh-x-grok picks it up).

    Call this after the agent has fetched with native X tools.
    """
    if cache_root is None:
        # default to monorepo root .finhot-cache next to finhot/
        here = os.path.dirname(__file__)
        cache_root = os.path.join(here, "..", "..", ".finhot-cache")
    os.makedirs(cache_root, exist_ok=True)
    out_path = os.path.join(cache_root, "x_grok_entries.json")

    proxy_entries = []
    for it in items:
        # it is finhot item: id, source, title, content, url, ts
        proxy_entries.append({
            "id": it.get("id"),
            "source": it.get("source", "X@grok (native)"),
            "title": it.get("title") or "",
            "content": it.get("content", ""),
            "url": it.get("url", ""),
            "ts": int(it.get("ts") or time.time()),
        })

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(proxy_entries, f, ensure_ascii=False, indent=2)
    print(f"[x_grok] wrote {len(proxy_entries)} entries for central proxy cache -> {out_path}")
    print("Then run: curl -X POST http://localhost:2233/api/public/refresh-x-grok (or the full /refresh)")
    return out_path


def prepare_fetch_request():
    """Print the current X users + ready-to-paste prompt for the agent."""
    users = load_watchlist_x_users()
    if not users:
        print("No X users in watchlist.json")
        return
    print("Current X users from watchlist:")
    print(users)
    print("\n--- Ask the agent something like: ---")
    prompt = (
        f"Use your native X tools to fetch the latest 5-10 posts (mode=Latest) "
        f"for each of these users: {', '.join(users)}.\n"
        "For each post return enough info to normalize (ID, Author or screen name, "
        "Timestamp, full Content/text, and reconstruct https://x.com/user/status/ID url).\n"
        "Then output a single JSON array of finhot items using this shape:\n"
        '[{"id": "...", "source": "X@username (native)", "title": "", '
        '"content": "...", "url": "https://x.com/...", "ts": 1234567890}, ...]\n'
        "After that, I will save it to finhot/data/x_grok.json so the collector picks it up."
    )
    print(prompt)
    print("\nTip: you can say 'fetch X for finhot now' or 'update native X data for finhot'.")


def fetch_via_agent_cli():
    """Entry point for manual/ agent-driven update.

    In practice the user (or cron + agent) runs:
        python -m app.x_grok fetch
    Then pastes the result or the agent directly edits the json via tools.
    """
    users = load_watchlist_x_users()
    print("X users:", users)
    print("To actually fetch, ask your Grok agent with the prepare prompt above.")
    print("Once you have the JSON array, save it to:", GROK_X_PATH)
    # Example: if agent ran and gave items here, we could accept --json or stdin.
    # For now this is the coordination point.


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("cmd", nargs="?", default="prepare", choices=["prepare", "fetch", "load"])
    args = p.parse_args()
    if args.cmd == "prepare":
        prepare_fetch_request()
    elif args.cmd == "fetch":
        fetch_via_agent_cli()
    elif args.cmd == "load":
        items = load_grok_items()
        print(f"Loaded {len(items)} native X items")
        if items:
            print(json.dumps(items[:2], ensure_ascii=False, indent=2))
