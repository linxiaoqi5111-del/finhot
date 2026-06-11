import os
import sqlite3

DB_PATH = os.environ.get("FINHOT_DB", os.path.join(os.path.dirname(__file__), "..", "data", "finhot.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT,
    content TEXT,
    url TEXT,
    ts INTEGER NOT NULL,
    day TEXT NOT NULL,
    event_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_day ON items(day);
CREATE TABLE IF NOT EXISTS term_daily (
    term TEXT NOT NULL,
    day TEXT NOT NULL,
    doc_count INTEGER NOT NULL,
    spec_count INTEGER NOT NULL DEFAULT 0,
    weight REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (term, day)
);
CREATE INDEX IF NOT EXISTS idx_term_daily_day ON term_daily(day);
"""


def connect():
    path = os.path.abspath(DB_PATH)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(term_daily)")}
    if "spec_count" not in cols:
        conn.execute("ALTER TABLE term_daily ADD COLUMN spec_count INTEGER NOT NULL DEFAULT 0")
    if "weight" not in cols:
        conn.execute("ALTER TABLE term_daily ADD COLUMN weight REAL NOT NULL DEFAULT 0")
    item_cols = {r[1] for r in conn.execute("PRAGMA table_info(items)")}
    if "event_id" not in item_cols:
        conn.execute("ALTER TABLE items ADD COLUMN event_id TEXT")
    return conn
