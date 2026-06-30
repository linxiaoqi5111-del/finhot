"""evidence_triage 打分器：6 维打分 + 硬门槛分桶 → P0/P1/P2/P3。

模型：规则定级 + 分数排序（非纯阈值）。
- 规则（硬门槛，见 config.triage.levels）给「分级」硬保证，边界稳定；
- 加权分数只用于「同级内排序」（哪条先看）。
这套在风控/告警分级里通用：纯阈值在边界样本上抖动大，规则兜底更稳。

事实硬度（fact_hardness）维度直接复用 cninfo-rss 的税法：
  调 fetch_cninfo.classify() → update_type=hard_delta → 3 / review_candidate → 1 / None → 0。
  classify 返回 None（命中 exclude_any 噪音 / 不构成 L3 候选）只代表「硬度=0」，
  **不是丢弃记录**——记录仍靠 source_authority 落到 P2 进缓存。故 inquiry 源无需特判：
  其标题恒含「问询函/关注函」会被 exclude_any 判 None→硬度 0→P2，正合「问询函仅缓存」。

定级覆盖（triage 里，在 assign_level 之后）：
  - 反证（is_negative）→ P0：最高优先，否认某件具体事影响生命周期，即便标题沾 exclude_any
    也不应被压成噪音（互动问询的回复反证正是高价值信号）。
  - cninfo 噪音（is_noise：标题命中 cninfo exclude_any）→ P3：对应 DESIGN §8「忽略」桶。
    ⚠ 这修了 handoff §6（P3 简写成「否则 sa<2」）与 DESIGN §8（P3=exclude_any）的口径冲突，
    按 DESIGN 对齐。exclude_any 是为 cninfo 公告标题设计的，仅对 source==cninfo 生效，
    互动/问询的 excerpt 不套这套词表。

反证（Phase 2 重点）：标题/问答片段命中强否认词、且涉题材（有 fact_type / 命中查询
关键词 / 来自互动问询）→ 强制 fact_hardness=3、lifecycle_impact=3 → P0。
  ⚠ evidence_layer=L3_negative 的「落字」是 Phase 3 证据卡的职责；本期只把反证顶到 P0。
  ⚠ 精度依赖 raw_excerpt 内容：cninfo 公告 excerpt==标题（信息少），互动问答 excerpt
    含实质问答（命中率高）；问询函回复正文目前未入 excerpt，标题级反证可抓，正文级待
    inquiry.py 富化后自动生效。
"""
from __future__ import annotations

import re
from typing import Optional

from .schema import DisclosureRecord

# 6 个打分维度（各 0-3 分）
DIMENSIONS = (
    "source_authority",  # 来源权威性
    "fact_hardness",  # 事实硬度（复用 cninfo 分类）
    "company_relevance",  # 公司相关性（与主营/逻辑）
    "novelty",  # 新增信息量（知识库是否已见）
    "lifecycle_impact",  # 生命周期影响（升级/降级/反证）
    "market_relevance",  # 盘面相关性（watchlist/题材核心）
)

# ---- 默认权重 / 阈值（config.yaml 缺失或未给时兜底，与 config.yaml 同口径）----
DEFAULT_WEIGHTS: dict[str, float] = {
    "source_authority": 1.0,
    "fact_hardness": 2.0,
    "company_relevance": 1.0,
    "novelty": 1.0,
    "lifecycle_impact": 2.0,
    "market_relevance": 1.0,
}
DEFAULT_LEVELS: dict[str, dict] = {
    "P0": {"fact_hardness_min": 3, "lifecycle_impact_min": 2},
    "P1": {"fact_hardness_min": 2},
    "P2": {"source_authority_min": 2},
}

# ---- 反证（negative evidence）词表 ----
# 强否认词：明确否认/澄清某件具体事。刻意避开裸「未/无」——会误伤「未来/尚未/无法」
# 等非否认语境；用多字短语精度高得多（这是反证识别的命门，宁可少召回别误杀）。
NEGATION_PHRASES = (
    "否认",
    "澄清",
    "不属实",
    "传闻不实",
    "失实",
    "误导性陈述",
    "并未",
    "未涉及",
    "没有涉及",
    "无相关业务",
    "无关",
)
# 强否认子集：出现这些词时，即便混了下面的合规套话，仍按反证处理（强词覆盖套话）。
STRONG_DENIAL = ("否认", "不属实", "传闻不实", "失实", "误导性")
# 程式化免责/合规套话：含这些的不算反证（如审计/年报里的标准表述），抑制升级。
BOILERPLATE_NEGATION = (
    "应披露而未披露",
    "未披露",
    "不存在违反",
    "不存在利益",
    "不存在重大违规",
    "未发现",
    "不构成",
)

# inquiry 源：record.source == "inquiry"（见 sources/inquiry.py 的 InquirySource.name）
_INQUIRY_SOURCE = "inquiry"
# exclude_any 词表是为 cninfo 公告标题设计的，只对 cninfo 源套噪音判定。
_NOISE_CHECK_SOURCE = "cninfo"

# 硬事实型 fact_type（复用 cninfo-rss 的 fact_type_by_keyword 词表）→ lifecycle_impact。
# 改变「生意生命周期」的给高分；普通披露给低分。
_LIFECYCLE_HIGH = {  # 产业链逻辑直接受冲击
    "customer_validation",  # 客户验证：增量逻辑最硬
    "mass_production",
    "capacity_expansion",
    "order_contract",
}
_LIFECYCLE_MID = {  # 重要但偏常规事件
    "certification",
    "acquisition",
    "restructuring",
    "private_placement",
    "project_landing",
    "share_change",
    "buyback",
    "earnings_guidance",
    "earnings_flash",
}

# ---- Gap A：产品进展软词表 ----
# cninfo 税法 include_any 没覆盖的互动问答常见进展信号。命中 → fact_hardness 兜到 2
# （进 P1 复核桶），区别于 classify 的 hard_delta(3)：送样/小批量/试产 是「进展但未坐实」，
# 需复核，不该直接 P0。value = 命中时回填的 fact_type（None=仅提硬度，不回填类型）。
PRODUCT_PROGRESS: dict[str, Optional[str]] = {
    "送样": "customer_validation",
    "小批量": "mass_production",
    "试产": "mass_production",  # 注意 classify 词表是「试生产」(3字)，「试产」是缺口
    "批量供货": "mass_production",
    "形成收入": None,
}
# 否定前缀（紧贴进展词左侧 ≤2 字）：命中则该处不算正向进展（未送样/尚未小批量/没量产），
# 避免把「没送样」误升 P1。$ 锚末尾 → pre 以否定词收尾才算。
_NEG_PREFIX = re.compile(r"(?:尚未|暂未|并未|没有|暂无|未|无|没)$")


# --------------------------------------------------------------------------- #
# cninfo 税法加载（懒加载、进程内缓存；失败降级，triage 不崩）
# --------------------------------------------------------------------------- #
_FC_CACHE: Optional[tuple] = None  # (fetch_cninfo 模块, cninfo-rss config dict) 或 (None, None)


def _fc_and_cfg() -> tuple:
    """复用 sources.cninfo._load_fc 拿 fetch_cninfo 模块 + 其 load_config() 税法。

    返回 (fc, cfg)；任一环节失败（未装 PyYAML / sys.path 注入失败）→ (None, None)，
    调用方据此降级。模块级缓存，整个进程只加载一次。
    """
    global _FC_CACHE
    if _FC_CACHE is None:
        try:
            from .sources.cninfo import _load_fc

            fc = _load_fc()
            _FC_CACHE = (fc, fc.load_config())
        except Exception:  # noqa: BLE001 - 重依赖降级
            _FC_CACHE = (None, None)
    return _FC_CACHE


# --------------------------------------------------------------------------- #
# 内部工具
# --------------------------------------------------------------------------- #
# 互动源 raw_excerpt 约定格式（见 sources/irm.py）："{问题}  ||答复：{答复正文}"。
# triage 对互动源只取**答复正文**做事实抽取——投资者提问里带「回购/量产」不是事实，
# 事实在公司的答复里（修 Gap B：避免提问误升 P0/P1）。
_ANSWER_SEP = "||答复："


def _is_interact(record: DisclosureRecord) -> bool:
    """互动问答源：事实在答复里，不在提问里。"""
    src = record.source or ""
    return src.startswith("irm") or src == "sse_einteract"


def _text(record: DisclosureRecord) -> str:
    """事实抽取的文本输入（classify / 反证 / 进展词 / 否定式都吃它）。

    - 互动源（irm_szse/sse_einteract）：只取 raw_excerpt 里 `||答复：` 之后的**答复正文**；
      无答复（纯提问）→ 返回空（→ fh=0 → P2，提问本身不是事实）。
      权衡：答复独占会漏「答得极简、靠提问补语境」的（问"何时量产"答"2027年"），但精度优先——
      terse 答复只是降到 P2（没丢），多数实质答复会重述主题词（"…有望小批量生产"含"小批量"→P1）。
    - 其余（cninfo/inquiry）：标题 + 问答片段（cninfo excerpt==title，拼接无害）。
    """
    if _is_interact(record):
        excerpt = record.raw_excerpt or ""
        if _ANSWER_SEP in excerpt:
            return excerpt.split(_ANSWER_SEP, 1)[1].strip()
        return ""
    return f"{record.title or ''} {record.raw_excerpt or ''}".strip()


def detect_negation(text: str) -> Optional[str]:
    """命中强否认词则返回该词；命中合规套话（且无强词）或无命中则 None。

    公开给 CLI 复用，避免重复维护词表。
    """
    if not text:
        return None
    has_strong = any(s in text for s in STRONG_DENIAL)
    if not has_strong and any(b in text for b in BOILERPLATE_NEGATION):
        return None  # 套话抑制：年报/审计标准表述，非反证
    for w in NEGATION_PHRASES:
        if w in text:
            return w
    return None


def _is_noise(text: str, exclude_any) -> bool:
    """标题是否命中 cninfo exclude_any 噪音词。纯函数，便于单测。"""
    for w in exclude_any or []:
        if w and w in text:
            return True
    return False


def _detect_product_progress(text: str) -> tuple[Optional[str], bool]:
    """命中产品进展软词 → (fact_type|None, True)；词紧前是否定前缀则跳过该处。

    多次出现时只要有一处非否定命中即算（「已送样、未送样」并存 → 仍算进展）。
    用于互动问答软进展兜底进 P1，同时避免「未送样/尚未小批量」被误当正向进展。
    """
    if not text:
        return None, False
    for term, ft in PRODUCT_PROGRESS.items():
        start = 0
        while True:
            idx = text.find(term, start)
            if idx == -1:
                break
            pre = text[max(0, idx - 2):idx]
            if not _NEG_PREFIX.search(pre):
                return ft, True
            start = idx + 1
    return None, False


def _keyword_negated(text: str, reason: str) -> bool:
    """classify 命中的关键词是否在原文里全被否定前缀修饰（尚未量产/未投产/没达产）。

    用于 §5.8：classify 不看否定前缀，会把时态性否定（「尚未量产」，常配「预计 Q4 量产」）
    当 hard_delta → 假 P0。注意这是**时态性否定**（未到、偏中性），不是「否认/不属实」
    那种断言性反证——故只降为 review(fh=1)，不翻成 P0 反证；断言性否认仍走 detect_negation。

    reason 形如 'keyword:量产' 或 'keyword:签订|combo_miss'；category 路径无单一词 → False。
    全部出现都被否定才算（「已量产…尚未量产」并存 → 仍当正向）。
    """
    if not reason or not reason.startswith("keyword:"):
        return False
    kw = reason.split(":", 1)[1].split("|")[0].strip()
    if not kw or kw not in text:
        return False
    start = 0
    while True:
        idx = text.find(kw, start)
        if idx == -1:
            break
        pre = text[max(0, idx - 2):idx]
        if not _NEG_PREFIX.search(pre):
            return False  # 有一处非否定 → 不算否定
        start = idx + 1
    return True


def _has_theme_anchor(record: DisclosureRecord, fact_type: Optional[str]) -> bool:
    """反证只有在「否认某件具体事」时才有生命周期影响——要有题材锚点。

    锚点判据（任一）：classify 给了 fact_type / 命中查询关键词 / 来自互动或问询源
    （这类记录天然带题材上下文）。纯 cninfo 公告若 classify 没分到 fact_type 又无
    关键词，则一个孤立的「澄清」不足以升 P0（不知在澄清什么）。
    """
    if fact_type:
        return True
    if record.matched_keywords:
        return True
    if record.source == _INQUIRY_SOURCE or _is_interact(record):
        return True
    return False


def _classify_fact_hardness(
    record: DisclosureRecord, fc, cfg
) -> tuple[int, Optional[str]]:
    """复用 fetch_cninfo.classify 算 fact_hardness。返回 (硬度 0-3, fact_type 或 None)。

    - inquiry 源：标题恒含问询特征词 → classify 必走 exclude_any 返回 None；其价值在
      source_authority（→P2）与回复反证（→detect_negation 升 P0），不在硬度，直接给 0。
    - fc/cfg 不可用（未装 PyYAML / sys.path 注入失败）：降级 (0, 已有 fact_type)，
      triage 不崩；反证路径不受影响（detect_negation 独立于 classify）。
    """
    if record.source == _INQUIRY_SOURCE or not fc or not cfg:
        return 0, record.fact_type
    try:
        res = fc.classify({"title": _text(record), "category_code": ""}, cfg)
    except Exception:  # noqa: BLE001
        return 0, record.fact_type
    if not res:
        return 0, record.fact_type
    update_type = res.get("update_type")
    fact_type = res.get("fact_type") or record.fact_type
    if update_type == "hard_delta":
        # §5.8：classify 不看否定前缀，「尚未量产/未投产」会被当 hard_delta→假 P0。
        # 命中词若在原文全被否定前缀修饰 → 降为 review(fh=1)，不当硬事实。
        if _keyword_negated(_text(record), res.get("l3_match_reason", "")):
            return 1, fact_type
        return 3, fact_type
    if update_type == "review_candidate":
        return 1, fact_type
    return 0, fact_type


def _analyze(
    record: DisclosureRecord, *, context: Optional[dict] = None
) -> dict:
    """单次扫描：跑 classify + 反证 + 噪音检测，返回 6 维分 + 元判定。

    score_dimensions / triage 共用，避免 classify 被调两遍。
    """
    ctx = context or {}
    text = _text(record)
    fc, cfg = _fc_and_cfg()

    fact_hardness, fact_type = _classify_fact_hardness(record, fc, cfg)

    # Gap A：产品进展软词（cninfo 税法未覆盖的互动问答进展信号）→ fh 兜到 2（P1 复核桶）。
    # 否定前缀紧贴的（未送样/尚未小批量）不算正向进展，跳过；inquiry 源不套（与跳过 classify 一致）。
    if record.source != _INQUIRY_SOURCE:
        prog_ft, prog_hit = _detect_product_progress(text)
        if prog_hit:
            fact_hardness = max(fact_hardness, 2)
            if not fact_type:
                fact_type = prog_ft

    # 反证：强否认词 + 题材锚点 → 强制硬度拉满
    neg_word = detect_negation(text)
    is_negative = bool(neg_word) and _has_theme_anchor(record, fact_type)
    if is_negative:
        fact_hardness = 3

    # cninfo 噪音：标题命中 exclude_any（仅 cninfo 源）
    exclude = (((cfg or {}).get("l3_title_keywords")) or {}).get("exclude_any") or []
    is_noise = record.source == _NOISE_CHECK_SOURCE and _is_noise(text, exclude)

    # source_authority：直接取记录可信度（源适配器已按 config 赋值），夹到 [0,3]
    source_authority = max(0, min(3, int(record.source_authority or 0)))

    # lifecycle_impact：反证 > 硬事实 > 其余
    if is_negative:
        lifecycle_impact = 3
    elif fact_type in _LIFECYCLE_HIGH:
        lifecycle_impact = 3 if fact_type == "customer_validation" else 2
    elif fact_type in _LIFECYCLE_MID:
        lifecycle_impact = 2
    else:
        lifecycle_impact = 1

    # company_relevance（Phase 2 占位）：命中 context 主营词→3 / 命中查询关键词→2 / 否则 1
    company_kw = ctx.get("company_keywords") or []
    if company_kw and any(k in text for k in company_kw):
        company_relevance = 3
    elif record.matched_keywords:
        company_relevance = 2
    else:
        company_relevance = 1

    # novelty（Phase 2 占位）：context 给「已见 doc_hash 集合」则去重（命中→0），否则默认 2
    # 真·语义去重待 :8077 embedding（Phase 4+），这里只过已知集合。
    seen = ctx.get("seen_doc_hashes")
    if seen is not None:
        novelty = 0 if record.doc_hash in seen else 2
    else:
        novelty = 2

    # market_relevance（Phase 2 占位）：watchlist 命中→3 / 否则 1（watchlist 当前为空）
    watch = ctx.get("watchlist_codes") or []
    market_relevance = 3 if (watch and record.company_code in watch) else 1

    return {
        "dims": {
            "source_authority": source_authority,
            "fact_hardness": fact_hardness,
            "company_relevance": company_relevance,
            "novelty": novelty,
            "lifecycle_impact": lifecycle_impact,
            "market_relevance": market_relevance,
        },
        "fact_type": fact_type,
        "is_negative": is_negative,
        "is_noise": is_noise,
    }


# --------------------------------------------------------------------------- #
# 公开 API
# --------------------------------------------------------------------------- #
def score_dimensions(
    record: DisclosureRecord, *, context: Optional[dict] = None
) -> dict[str, int]:
    """对一条记录打 6 维分（0-3）。

    context 可携带：watchlist_codes / company_keywords / seen_doc_hashes，
    用于 market_relevance / company_relevance / novelty 维度（Phase 2 部分占位）。
    """
    return _analyze(record, context=context)["dims"]


def assign_level(
    dims: dict[str, int], *, config: Optional[dict] = None
) -> tuple[str, float]:
    """按硬门槛规则定级（P0-P3）+ 算加权分（同级排序用）。返回 (level, score)。

    规则（自上而下首个命中即定级，未命中 → P3）：
      P0: fact_hardness>=3 且 lifecycle_impact>=2   （反证/订单/量产/扩产/客户验证）
      P1: fact_hardness>=2                          （送样/收入占比，需复核）
      P2: source_authority>=2                       （官方但低硬度，仅缓存）
      P3: 其余                                      （低权威；cninfo 噪音由 triage 覆盖到这）
    阈值取自 config['triage']['levels']，缺失用 DEFAULT_LEVELS。score 按
    config['triage']['weights'] 加权求和，**仅用于同级内排序**。
    """
    tri_cfg = (config or {}).get("triage") or {}
    levels = tri_cfg.get("levels") or DEFAULT_LEVELS
    weights = tri_cfg.get("weights") or DEFAULT_WEIGHTS

    fh = dims["fact_hardness"]
    li = dims["lifecycle_impact"]
    sa = dims["source_authority"]

    p0 = levels.get("P0") or {}
    if fh >= p0.get("fact_hardness_min", 3) and li >= p0.get("lifecycle_impact_min", 2):
        level = "P0"
    else:
        p1 = levels.get("P1") or {}
        if fh >= p1.get("fact_hardness_min", 2):
            level = "P1"
        else:
            p2 = levels.get("P2") or {}
            level = "P2" if sa >= p2.get("source_authority_min", 2) else "P3"

    score = sum(dims[k] * weights.get(k, 1.0) for k in DIMENSIONS)
    return level, score


def triage(
    record: DisclosureRecord,
    *,
    context: Optional[dict] = None,
    config: Optional[dict] = None,
) -> DisclosureRecord:
    """打分 + 定级 + 覆盖，写回 record.triage_level / triage_score（顺带回填 fact_type）。

    覆盖优先级（在 assign_level 之后）：反证→P0 > cninfo 噪音→P3 > 规则定级。
    幂等：多次跑同一条记录结果一致（fact_type 已存在则不覆盖）。
    """
    a = _analyze(record, context=context)
    level, score = assign_level(a["dims"], config=config)
    if a["is_negative"]:
        level = "P0"  # 反证：dims 已强制 P0，这里显式声明，防御未来阈值调整
    elif a["is_noise"]:
        level = "P3"  # cninfo exclude_any 噪音 → 忽略（反证已在前一分支拦截）
    record.triage_level = level
    record.triage_score = round(score, 2)
    if a["fact_type"] and not record.fact_type:
        record.fact_type = a["fact_type"]
    return record


def is_reverse_evidence(record: DisclosureRecord) -> bool:
    """记录是否为反证（公开；re-derive，与 triage 同源 _analyze）。

    供 evidence_card / CLI 复用，避免把 is_negative 塞进 schema/cache。
    代价：每次调用重跑一次 _analyze（fc/cfg 已缓存，开销小）。
    """
    return _analyze(record)["is_negative"]
