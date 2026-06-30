"""证据卡：P0/P1 → 结构化 YAML 候选，人工/agent 确认后才写知识库。

边界（硬规则）：
- 只产出**候选**，落点在知识库 repo（config evidence_card.kb_dir，默认 ../../../knowledge-base-private/...）；
- review_status=pending，确认后才升级入正文；
- 绝不直接改知识库 entities/concepts/relations（那是 KB 的 disclosure-archive 职责）。
- 只读标题+元数据+互动问答、**不下 PDF 正文** → evidence_layer 上限 L1_L3_candidate；
  反证（is_reverse_evidence）标 L3_negative。升真 L3 交 KB 的 disclosure-archive。

触发模型：**按需生成**（CLI `evidence` / service 调用），不在 lookup 每次查询时自动落盘
——避免往知识库 disclosures 目录灌大量候选噪音；triage 仍每次跑（分级随缓存持久化）。
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from .schema import DisclosureRecord
from .triage import is_reverse_evidence

# record.source → 人类可读来源类型
SOURCE_TYPE_LABEL: dict[str, str] = {
    "cninfo": "巨潮公告",
    "irm_szse": "互动易(深)",
    "sse_einteract": "上证e互动",
    "inquiry": "监管问询函",
}

# 知识库 disclosures 默认落点（同级 ../../../knowledge-base-private，config 缺失时兜底）。
DEFAULT_KB_DIR = (
    Path(__file__).resolve().parents[3] / "knowledge-base-private" / "wiki" / "raw" / "disclosures"
)


@dataclass
class EvidenceCard:
    company: str
    code: str
    date: str
    source_type: str  # 互动易 / 巨潮公告 / 监管问询函 ...
    source_url: str
    evidence_layer: str  # L3 / L3_negative / L1_L3_candidate
    fact: str
    fact_type: Optional[str] = None
    theme_links: list[str] = field(default_factory=list)
    lifecycle_impact: str = ""  # 例：先进封装逻辑降级（Phase 3 留空，待人工/LLM 补）
    confidence: str = "medium"  # high / medium / low
    triage_level: str = ""  # P0 / P1
    raw_excerpt: str = ""
    review_status: str = "pending"  # pending → kept/discarded/sunk

    def to_dict(self) -> dict:
        return asdict(self)


def from_record(record: DisclosureRecord, *, context: Optional[dict] = None) -> EvidenceCard:
    """DisclosureRecord（P0/P1）→ EvidenceCard 候选草案。

    Phase 3 为规则版（无 LLM）：
    - fact 取 raw_excerpt（互动问答原文）/ title，截断保可读；
    - evidence_layer：反证→L3_negative，否则 L1_L3_candidate（未下 PDF，上限即候选）；
    - lifecycle_impact：反证给「待降级/复核」占位，正向留空（需题材知识，交人工/LLM）；
    - theme_links：暂用查询命中的 matched_keywords（真主题映射待 P4 wiki 接入）。
    """
    reverse = is_reverse_evidence(record)
    fact = (record.raw_excerpt or record.title or "").strip()
    if len(fact) > 200:
        fact = fact[:200] + "…"
    theme = list(record.matched_keywords)
    if context and context.get("theme_links"):
        # context 可补充主题标签（P4 wiki 缺口检测时注入）
        for t in context["theme_links"]:
            if t not in theme:
                theme.append(t)
    return EvidenceCard(
        company=record.company_name,
        code=record.company_code,
        date=(record.published_at or "")[:10],
        source_type=SOURCE_TYPE_LABEL.get(record.source, record.source or ""),
        source_url=record.url,
        evidence_layer="L3_negative" if reverse else "L1_L3_candidate",
        fact=fact,
        fact_type=record.fact_type,
        theme_links=theme,
        lifecycle_impact="反证：相关逻辑待降级/复核" if reverse else "",
        confidence="high" if (reverse or record.triage_level == "P0") else "medium",
        triage_level=record.triage_level or "",
        raw_excerpt=(record.raw_excerpt or "")[:500],
        review_status="pending",
    )


def to_yaml(card: EvidenceCard) -> str:
    """证据卡 → YAML 文本（字段序同 EvidenceCard 定义；方法内延迟 import yaml）。"""
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - 环境问题
        raise RuntimeError("证据卡 YAML 输出需要 PyYAML") from exc
    return yaml.safe_dump(card.to_dict(), allow_unicode=True, sort_keys=False, width=4096)


def write_candidate(card: EvidenceCard, kb_dir: Path) -> Path:
    """把证据卡候选写到知识库 disclosures 目录（目录即 review-queue）。返回写入路径。

    文件名稳定可去重：`{date}_{code}_{level}_{fact_hash8}.yaml`。
    """
    kb_dir = Path(kb_dir)
    kb_dir.mkdir(parents=True, exist_ok=True)
    slug = hashlib.sha1((card.fact or card.code or "").encode("utf-8")).hexdigest()[:8]
    fname = f"{card.date or 'nodate'}_{card.code or 'nocode'}_{card.triage_level or 'P'}_{slug}.yaml"
    path = kb_dir / fname
    path.write_text(to_yaml(card), encoding="utf-8")
    return path


def generate_candidates(
    records: list[DisclosureRecord],
    *,
    kb_dir: Path,
    context: Optional[dict] = None,
) -> list[Path]:
    """批量：过滤 P0/P1 → 生成证据卡候选 → 写盘。返回写入路径列表（P2/P3 跳过）。"""
    paths: list[Path] = []
    for r in records:
        if r.triage_level in ("P0", "P1"):
            paths.append(write_candidate(from_record(r, context=context), kb_dir))
    return paths


def resolve_kb_dir(config: Optional[dict] = None) -> Path:
    """从 config['evidence_card']['kb_dir'] 解析落点（相对 disclosure_lookup 目录）；缺失用默认。"""
    p = (((config or {}).get("evidence_card")) or {}).get("kb_dir") or ""
    if not p:
        return DEFAULT_KB_DIR
    pp = Path(p)
    return pp if pp.is_absolute() else (Path(__file__).resolve().parent / pp)
