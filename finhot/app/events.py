"""信源分级与事件聚类。

借鉴 AIHOT 的两条经验（全部用代码实现，不引入模型）：
1. 信源分级：T1 官方快讯线（财联社等）> T1.5 媒体 RSS > T2 博主（微博/雪球/公众号/X）。
   同一题材，官方快讯提到比博主转发贡献的热度高。
2. 事件聚类：同一件事被多个源转发时（文本字符二元组 Jaccard 相似），聚成一个事件簇，
   热度按"事件数"而非"条数"计，避免转发刷屏放大"传播热"。簇内 tier 最高的条目为主条。
"""
import re

CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")
LATIN = re.compile(r"[A-Za-z][A-Za-z0-9\-+]{1,14}")

# ---- 信源四层分级 ----
# T1 产业优质信源（权重 1.3）：公告级 + 行业权威
T1_SOURCES = {"财联社", "格隆汇", "华尔街见闻"}
# T1.5 综合财经快讯（权重 0.8）：快但噪声多
T15_SOURCES = {"新浪财经7x24", "东方财富快讯", "同花顺快讯"}
# T2 博主个人号（权重 0.5）
T2_PREFIXES = ("微博@", "雪球@", "公众号@", "X@")
# 其余 RSS/产业媒体 → T1.2

TIER_WEIGHTS = {1.0: 1.3, 1.2: 1.0, 1.5: 0.8, 2.0: 0.5}


def source_tier(source):
    if source in T1_SOURCES:
        return 1.0
    if source in T15_SOURCES:
        return 1.5
    if source.startswith(T2_PREFIXES):
        return 2.0
    return 1.2  # 产业媒体 RSS / 垂直媒体


def tier_weight(source):
    return TIER_WEIGHTS[source_tier(source)]


def _tokens(text):
    toks = set()
    for run in CJK_RUN.findall(text):
        toks.update(run[i:i + 2] for i in range(len(run) - 1))
        if len(run) == 1:
            toks.add(run)
    toks.update(m.group().lower() for m in LATIN.finditer(text))
    return toks


def cluster_items(rows, threshold=0.5):
    """rows: [{"id","source","title","content"}] -> {item_id: event_id}。

    贪心聚类：按 tier 优先、再按 id 稳定排序，逐条与已有簇的主条比较
    Jaccard 相似度，达到阈值并入该簇，否则自成新簇（event_id=主条 id）。
    用 token 倒排索引只比较有共享 token 的簇，避免 O(n^2) 全比较。
    """
    items = sorted(rows, key=lambda r: (source_tier(r["source"]), r["id"]))
    clusters = []  # [(event_id, token_set)]
    index = {}  # token -> [cluster_idx]
    assign = {}
    for it in items:
        toks = _tokens((it["title"] or "") + " " + (it["content"] or ""))
        if not toks:
            assign[it["id"]] = it["id"]
            continue
        seen = {}
        for t in toks:
            for ci in index.get(t, ()):
                seen[ci] = seen.get(ci, 0) + 1
        best, best_sim = None, threshold
        for ci, inter in seen.items():
            sim = inter / (len(toks) + len(clusters[ci][1]) - inter)
            if sim >= best_sim:
                best, best_sim = ci, sim
        if best is not None:
            assign[it["id"]] = clusters[best][0]
        else:
            ci = len(clusters)
            clusters.append((it["id"], toks))
            for t in toks:
                index.setdefault(t, []).append(ci)
            assign[it["id"]] = it["id"]
    return assign


def build_events(rows):
    """rows（含 id/source/title/content）-> 事件列表 [{texts, weight, event_id}]。

    事件权重取簇内最高信源权重（官方提过 = 按官方权重计）。
    """
    assign = cluster_items(rows)
    events = {}
    for r in rows:
        eid = assign[r["id"]]
        ev = events.setdefault(eid, {"event_id": eid, "texts": [], "weight": 0.0})
        ev["texts"].append((r["title"] or "") + " " + (r["content"] or ""))
        ev["weight"] = max(ev["weight"], tier_weight(r["source"]))
    return list(events.values()), assign
