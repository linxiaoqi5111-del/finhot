"""编排入口（service 函数层）：cache-aside → sources → triage。

供 CLI / 未来 FastAPI / MCP 调用。Phase 1 先实现 search_company（含缓存），
search_keyword / search_event 随后。

教学备注：把「编排」与「实现细节」分层——上层只调 search_company(...)，
内部怎么查缓存、调哪些源、怎么 triage 都被封装。换存储/换源不影响调用方。
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from . import cache
from .schema import DisclosureRecord
from .sources import get_source
from .triage import triage as run_triage

DEFAULT_CONFIG = Path(__file__).resolve().parent / "config.yaml"


def load_config(path: Path = DEFAULT_CONFIG) -> dict:
    """读 config.yaml（延迟 import yaml；缺失给出清晰指引）。"""
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - 环境问题
        raise RuntimeError(
            "需要 PyYAML：pip install -r finhot/disclosure_lookup/requirements.txt"
        ) from exc
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def db_path(config: dict) -> Path:
    """从 config 解析缓存 db 路径（相对 config.yaml 所在目录）。"""
    p = ((config.get("cache") or {}).get("db_path")) or ""
    if not p:
        return cache.DEFAULT_DB_PATH
    pp = Path(p)
    return pp if pp.is_absolute() else (DEFAULT_CONFIG.parent / pp)


def _enabled_sources(config: dict, override: Optional[list[str]]) -> list[str]:
    src_cfg = config.get("sources") or {}
    if override:  # 用户显式指定的子集（只取已知源）
        return [s for s in override if s in src_cfg]
    return [name for name, c in src_cfg.items() if c and c.get("enabled")]


def _resolve_company(query: str) -> tuple[str, str]:
    """query 为 6 位代码 → (code, '')；否则当公司名 → 经 cninfo topSearch 反查 (code, name)。"""
    q = query.strip()
    if q.isdigit() and len(q) == 6:
        return q, ""
    from .sources.cninfo import top_search

    try:
        rows = top_search(q)
    except Exception:  # noqa: BLE001 - 联想搜索失败
        return "", q
    for r in rows:  # 精确同名优先
        if r["name"] == q:
            return r["code"], r["name"]
    for r in rows:  # 否则首个 A股、未退市
        if r["category"] in ("A股", "") and not r["delisted"]:
            return r["code"], r["name"]
    return (rows[0]["code"], rows[0]["name"]) if rows else ("", q)


def search_company(
    query: str,
    *,
    days: int = 30,
    sources: Optional[list[str]] = None,
    use_cache: bool = True,
    config: Optional[dict] = None,
) -> list[DisclosureRecord]:
    """按公司（名或代码）查近 N 天披露。

    流程：解析公司 → 各启用源 cache-aside（水位新鲜则读缓存，否则打源 → triage 分级
    → 写回）→ 合并去重（doc_hash）→ 按日期倒序。triage 写回 triage_level/score，
    随缓存持久化；缓存命中路径已有分级，无需重跑。
    """
    cfg = config or load_config()
    code, name = _resolve_company(query)
    if not code:
        print(f"[warn] 无法解析公司：{query}")
        return []
    ttl = int((cfg.get("cache") or {}).get("ttl_days", 7))
    empty_ttl = int((cfg.get("cache") or {}).get("empty_ttl_days", 1))
    conn = cache.connect(db_path(cfg))
    try:
        merged: dict[str, DisclosureRecord] = {}
        for sname in _enabled_sources(cfg, sources):
            qkey = f"{sname}:{code}:{days}d"
            if use_cache and cache.is_fresh(conn, qkey):
                recs = cache.get_cached(conn, source=sname, company_code=code, days=days)
            else:
                try:
                    recs = get_source(sname).search_company(code, name, days=days)
                except Exception as exc:  # noqa: BLE001 - 单源失败不中断整体
                    print(f"[warn] 源 {sname} 失败：{exc}")
                    recs = cache.get_cached(
                        conn, source=sname, company_code=code, days=days, include_expired=True
                    )
                else:
                    recs = [run_triage(r, config=cfg) for r in recs]
                    # 负缓存：空结果给水位短 TTL（empty_ttl_days，默认 1 天），避免空查询锁满 ttl_days
                    cache.put_records(
                        conn, recs, query_key=qkey, ttl_days=ttl if recs else empty_ttl
                    )
            for r in recs:
                merged[r.doc_hash] = r
    finally:
        conn.close()
    return sorted(merged.values(), key=lambda r: r.published_at, reverse=True)


def search_keyword(
    keyword: str,
    *,
    days: int = 30,
    codes: Optional[list[str]] = None,
    sources: Optional[list[str]] = None,
    use_cache: bool = True,
    config: Optional[dict] = None,
) -> list[DisclosureRecord]:
    """按关键词查（CoWoS / 量产 / 客户验证 / 否认合作 ...）。"""
    cfg = config or load_config()
    ttl = int((cfg.get("cache") or {}).get("ttl_days", 7))
    empty_ttl = int((cfg.get("cache") or {}).get("empty_ttl_days", 1))
    code_tag = ",".join(codes) if codes else "all"
    conn = cache.connect(db_path(cfg))
    try:
        merged: dict[str, DisclosureRecord] = {}
        for sname in _enabled_sources(cfg, sources):
            qkey = f"{sname}:kw:{keyword}:{code_tag}:{days}d"
            if use_cache and cache.is_fresh(conn, qkey):
                recs = cache.get_cached(conn, source=sname, keyword=keyword, days=days)
            else:
                try:
                    recs = get_source(sname).search_keyword(keyword, days=days, codes=codes)
                except NotImplementedError:
                    recs = []
                except Exception as exc:  # noqa: BLE001
                    print(f"[warn] 源 {sname} 关键词查询失败：{exc}")
                    recs = []
                else:
                    recs = [run_triage(r, config=cfg) for r in recs]
                    # 负缓存：空结果给水位短 TTL（empty_ttl_days，默认 1 天），避免空查询锁满 ttl_days
                    cache.put_records(
                        conn, recs, query_key=qkey, ttl_days=ttl if recs else empty_ttl
                    )
            for r in recs:
                merged[r.doc_hash] = r
    finally:
        conn.close()
    return sorted(merged.values(), key=lambda r: r.published_at, reverse=True)


def search_event(
    company: str,
    event: str,
    *,
    days: int = 90,
    config: Optional[dict] = None,
) -> list[DisclosureRecord]:
    """按事件查某公司（订单/认证/客户导入/产能释放）。

    Phase 1：= 公司查 + 事件词本地过滤（标题/片段命中）。Phase 2 由 triage 增强。
    """
    recs = search_company(company, days=days, config=config)
    ev = event.strip()
    if not ev:
        return recs
    return [r for r in recs if ev in r.title or ev in r.raw_excerpt]
