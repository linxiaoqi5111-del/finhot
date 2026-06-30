"""SQLite cache-aside：先查缓存，miss/过期才打源，结果写回。

教学备注（cache-aside / 旁路缓存）：
- 读：先查 cache，命中且未过期直接返回；否则打外部源，再 put_records 写回。
- 由应用控制读写，缓存与源解耦——最常用的缓存模式（对比 read/write-through：
  由缓存层代理读写、对应用透明，但耦合更深）。
- 目的：降低官方接口压力、避免触发限频。只存元数据+摘要+片段，不全文向量化。

存储选型 SQLite：标准库零依赖、文件型、按公司/关键词点查天然合适（对比 DuckDB 偏
列式分析扫描、JSONL 无索引）。
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
from pathlib import Path
from typing import Optional

from .schema import DisclosureRecord

CN_TZ = dt.timezone(dt.timedelta(hours=8))  # 北京时间 UTC+8（与 cninfo 口径一致）

DEFAULT_DB_PATH = Path(__file__).resolve().parent / ".cache" / "disclosure_cache.sqlite"

# 表结构（对应需求里的字段；matched_keywords 存 JSON array 字符串）
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS disclosure_cache (
  doc_hash         TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  company_code     TEXT,
  company_name     TEXT,
  title            TEXT,
  url              TEXT,
  published_at     TEXT,
  summary          TEXT,
  raw_excerpt      TEXT,
  matched_keywords TEXT,
  source_authority INTEGER,
  fact_type        TEXT,
  fetched_at       TEXT NOT NULL,
  ttl_expires_at   TEXT NOT NULL,
  review_status    TEXT DEFAULT 'pending',   -- pending/kept/discarded/sunk
  triage_level     TEXT,
  triage_score     REAL
);
CREATE INDEX IF NOT EXISTS idx_company ON disclosure_cache(company_code, published_at);
CREATE INDEX IF NOT EXISTS idx_ttl ON disclosure_cache(ttl_expires_at);

-- 查询水位：记录某 (source, 维度键, 窗口) 最近一次成功拉取时间，用于判断
-- 「这个窗口最近查过且没过期 → 直接读缓存、不打源」。
CREATE TABLE IF NOT EXISTS query_watermark (
  query_key      TEXT PRIMARY KEY,   -- e.g. cninfo:688323:30d
  fetched_at     TEXT NOT NULL,
  ttl_expires_at TEXT NOT NULL
);
"""


# --------------------------------------------------------------------------- #
# 时间工具：统一用 +08:00、秒级 ISO；TTL 比较用同格式字符串（字典序即时间序）。
# --------------------------------------------------------------------------- #
def _now() -> dt.datetime:
    return dt.datetime.now(CN_TZ)


def _iso(d: dt.datetime) -> str:
    return d.isoformat(timespec="seconds")


def _parse(s: Optional[str]) -> Optional[dt.datetime]:
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s)
    except ValueError:
        return None


def _row_to_record(row: sqlite3.Row) -> DisclosureRecord:
    kws: list[str] = []
    if row["matched_keywords"]:
        try:
            kws = json.loads(row["matched_keywords"])
        except (ValueError, TypeError):
            kws = []
    return DisclosureRecord(
        company_name=row["company_name"] or "",
        company_code=row["company_code"] or "",
        source=row["source"],
        title=row["title"] or "",
        url=row["url"] or "",
        published_at=row["published_at"] or "",
        summary=row["summary"] or "",
        raw_excerpt=row["raw_excerpt"] or "",
        matched_keywords=kws,
        source_authority=row["source_authority"] if row["source_authority"] is not None else 3,
        fact_type=row["fact_type"],
        doc_hash=row["doc_hash"],  # 显式传入，避免 __post_init__ 重算
        triage_level=row["triage_level"],
        triage_score=row["triage_score"],
    )


# --------------------------------------------------------------------------- #
# 连接 / 建表
# --------------------------------------------------------------------------- #
def connect(db_path: Path = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """打开连接（Row 工厂）并确保建表。"""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """执行 SCHEMA_SQL（幂等，IF NOT EXISTS）。"""
    conn.executescript(SCHEMA_SQL)
    conn.commit()


# --------------------------------------------------------------------------- #
# cache-aside 读写
# --------------------------------------------------------------------------- #
def is_fresh(conn: sqlite3.Connection, query_key: str) -> bool:
    """查询水位是否新鲜（未过期）→ 决定是否跳过外部源。"""
    row = conn.execute(
        "SELECT ttl_expires_at FROM query_watermark WHERE query_key = ?", (query_key,)
    ).fetchone()
    if not row:
        return False
    exp = _parse(row["ttl_expires_at"])
    return bool(exp and exp > _now())


def get_cached(
    conn: sqlite3.Connection,
    *,
    source: Optional[str] = None,
    company_code: Optional[str] = None,
    keyword: Optional[str] = None,
    days: int = 30,
    include_expired: bool = False,
) -> list[DisclosureRecord]:
    """按 (source / company_code / keyword / days 窗口) 读缓存，默认排除过期。"""
    clauses: list[str] = []
    params: list = []
    if source:
        clauses.append("source = ?")
        params.append(source)
    if company_code:
        clauses.append("company_code = ?")
        params.append(company_code)
    if keyword:
        clauses.append("(title LIKE ? OR raw_excerpt LIKE ? OR matched_keywords LIKE ?)")
        like = f"%{keyword}%"
        params += [like, like, like]
    if days:
        cutoff = (_now() - dt.timedelta(days=days)).date().isoformat()
        clauses.append("substr(published_at, 1, 10) >= ?")
        params.append(cutoff)
    if not include_expired:
        clauses.append("ttl_expires_at > ?")
        params.append(_iso(_now()))
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = f"SELECT * FROM disclosure_cache{where} ORDER BY published_at DESC"
    return [_row_to_record(r) for r in conn.execute(sql, params).fetchall()]


def put_records(
    conn: sqlite3.Connection,
    records: list[DisclosureRecord],
    *,
    query_key: Optional[str] = None,
    ttl_days: int = 7,
) -> int:
    """upsert 记录 + 更新查询水位，返回写入条数。

    upsert 时**不覆盖** review_status——人工标过 kept/discarded 的不被刷掉。
    """
    now = _now()
    fetched, expires = _iso(now), _iso(now + dt.timedelta(days=ttl_days))
    n = 0
    for r in records:
        conn.execute(
            """INSERT INTO disclosure_cache
               (doc_hash, source, company_code, company_name, title, url, published_at,
                summary, raw_excerpt, matched_keywords, source_authority, fact_type,
                fetched_at, ttl_expires_at, triage_level, triage_score)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(doc_hash) DO UPDATE SET
                 title=excluded.title, url=excluded.url, published_at=excluded.published_at,
                 summary=excluded.summary, raw_excerpt=excluded.raw_excerpt,
                 matched_keywords=excluded.matched_keywords,
                 source_authority=excluded.source_authority, fact_type=excluded.fact_type,
                 fetched_at=excluded.fetched_at, ttl_expires_at=excluded.ttl_expires_at,
                 triage_level=excluded.triage_level, triage_score=excluded.triage_score""",
            (
                r.doc_hash, r.source, r.company_code, r.company_name, r.title, r.url,
                r.published_at, r.summary, r.raw_excerpt,
                json.dumps(r.matched_keywords, ensure_ascii=False),
                r.source_authority, r.fact_type, fetched, expires,
                r.triage_level, r.triage_score,
            ),
        )
        n += 1
    if query_key:
        conn.execute(
            """INSERT INTO query_watermark (query_key, fetched_at, ttl_expires_at)
               VALUES (?,?,?)
               ON CONFLICT(query_key) DO UPDATE SET
                 fetched_at=excluded.fetched_at, ttl_expires_at=excluded.ttl_expires_at""",
            (query_key, fetched, expires),
        )
    conn.commit()
    return n


def mark_review_status(conn: sqlite3.Connection, doc_hash: str, status: str) -> None:
    """更新 review_status：pending/kept/discarded/sunk。"""
    conn.execute(
        "UPDATE disclosure_cache SET review_status = ? WHERE doc_hash = ?", (status, doc_hash)
    )
    conn.commit()


def purge_expired(conn: sqlite3.Connection) -> int:
    """删除过期记录 + 过期水位，返回删除的披露条数。"""
    now = _iso(_now())
    cur = conn.execute("DELETE FROM disclosure_cache WHERE ttl_expires_at <= ?", (now,))
    conn.execute("DELETE FROM query_watermark WHERE ttl_expires_at <= ?", (now,))
    conn.commit()
    return cur.rowcount


def stats(conn: sqlite3.Connection) -> dict:
    """缓存统计：总条数 / 过期数 / 各源 / 各 triage 级 / 水位数。"""
    now = _iso(_now())
    total = conn.execute("SELECT COUNT(*) FROM disclosure_cache").fetchone()[0]
    expired = conn.execute(
        "SELECT COUNT(*) FROM disclosure_cache WHERE ttl_expires_at <= ?", (now,)
    ).fetchone()[0]
    by_source = {
        r[0]: r[1]
        for r in conn.execute(
            "SELECT source, COUNT(*) FROM disclosure_cache GROUP BY source"
        ).fetchall()
    }
    by_level = {
        (r[0] or "-"): r[1]
        for r in conn.execute(
            "SELECT triage_level, COUNT(*) FROM disclosure_cache GROUP BY triage_level"
        ).fetchall()
    }
    watermarks = conn.execute("SELECT COUNT(*) FROM query_watermark").fetchone()[0]
    return {
        "total": total,
        "expired": expired,
        "by_source": by_source,
        "by_level": by_level,
        "watermarks": watermarks,
    }
