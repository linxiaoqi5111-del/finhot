"""热词候选抽取与突发度计算。

热词的特点是"突然冒出来"（钼代钨、CCL、τ定律），不可能靠预设词表，
所以候选来自三路：
1. jieba 分词出的长度>=2的词
2. 中文 2-4 字 n-gram（捕捉词典里没有的新词，如"钼代钨"）
3. 英文/希腊字母 token（捕捉 CCL、τ定律 这类符号词）

热度 = 当日提及该词的快讯条数；突发度 = 当日值相对过去 N 天基线的倍数。
"""
import math
import re
from collections import defaultdict

import jieba

CJK = r"\u4e00-\u9fff"
SEG_SPLIT = re.compile(rf"[^{CJK}A-Za-z0-9\u03b1-\u03c9\u0391-\u03a9+]+")
LATIN_TOKEN = re.compile(r"[A-Za-z\u03b1-\u03c9\u0391-\u03a9][A-Za-z0-9\u03b1-\u03c9\u0391-\u03a9\-+]{1,14}")
HAN_RUN = re.compile(rf"[{CJK}]+")

STOPWORDS = set("""
公司 市场 指数 美元 亿元 万元 同比 环比 增长 下跌 上涨 涨幅 跌幅 报价 收盘 开盘 盘中 盘后
股份 股票 板块 概念 行业 产业 投资 基金 证券 银行 保险 期货 现货 主力 资金 净流入 净流出
表示 称 据悉 消息 报道 记者 获悉 宣布 发布 公告 披露 显示 数据 预计 预期 或将 有望 持续
今日 昨日 明日 今年 去年 明年 本周 上周 下周 目前 日前 近期 此前 未来 国内 国际 全球 中国
美国 欧洲 日本 央行 美联储 政策 经济 金融 财经 新闻 快讯 点击 详情 查看 相关 进一步 方面
人民币 港元 港股 美股 A股 涨停 跌停 触及 创下 新高 新低 季度 年度 月份 关注 影响 风险 机会
认为 指出 强调 要求 推动 加快 促进 提升 实现 完成 启动 开展 推进 加强 支持 服务 建设 发展
交易 价格 通胀 企业 科技 智能 生产 合作 计划 时间 产品 国家 实施 超过 会议 协议 事件 决定
控制 管理 重要 领域 基本 增加 减少 提高 降低 部分 全部 可能 或者 以及 对于 关于 通过 进行
情况 问题 工作 项目 业务 报告 研究 分析 技术 系统 平台 模式 增速 规模 水平 同期 累计 出现
有限公司 公告称 本次 重大 事项 存在 其他 主要 确定 目标 方式 总股本 万股 股东 股权 控股 集团 上市
信息 人民 基础 正在 需求 资产 消费 创新 利率 投资者 证券报 采购 转让 增持 减持 回购 中标 签署
""".split())

_STOP_FRAGMENTS = {g for w in STOPWORDS if len(w) >= 3 for n in (2, 3) for i in range(len(w) - n + 1) for g in [w[i:i + n]] if g != w}

GENERIC_LATIN = {"https", "http", "www", "com", "cn", "html", "api", "app", "ceo", "cfo", "cto",
                 "ipo", "gdp", "cpi", "ppi", "pmi", "etf", "reits", "st", "ai"}


def _ngrams(run, lo=2, hi=4):
    for n in range(lo, hi + 1):
        for i in range(len(run) - n + 1):
            yield run[i:i + n]


def extract_terms(text):
    """返回一条快讯中的候选热词集合。"""
    terms = set()
    for seg in SEG_SPLIT.split(text):
        if not seg:
            continue
        for m in LATIN_TOKEN.finditer(seg):
            tok = m.group()
            if tok.lower() not in GENERIC_LATIN and not tok.isdigit():
                terms.add(tok.upper() if tok.isascii() and tok.isalpha() and len(tok) <= 6 else tok)
        for run in HAN_RUN.findall(seg):
            for w in jieba.cut(run):
                if len(w) >= 2 and w not in STOPWORDS:
                    terms.add(w)
            for g in _ngrams(run):
                if g not in STOPWORDS and g not in _STOP_FRAGMENTS:
                    terms.add(g)
    return terms


def count_daily_terms(docs, min_doc=2):
    """docs: 文本列表 -> {term: 出现的文档数}，过滤低频与冗余子串。"""
    df = defaultdict(int)
    for text in docs:
        for t in extract_terms(text):
            df[t] += 1
    df = {t: c for t, c in df.items() if c >= min_doc}
    # 子串去冗余：若某词是更长词的子串且文档数几乎相同，则丢弃子串
    terms_sorted = sorted(df, key=len, reverse=True)
    drop = set()
    for i, long_t in enumerate(terms_sorted):
        for short_t in terms_sorted[i + 1:]:
            if short_t in drop or short_t not in long_t:
                continue
            if df[short_t] <= df[long_t] * 1.34:
                drop.add(short_t)
    df = {t: c for t, c in df.items() if t not in drop}
    # 片段去噪：若某词包含一个明显更热的短词（如「统特朗普」含「特朗普」），
    # 说明它只是跨词边界的 n-gram 碎片，丢弃
    kept = sorted(df, key=len)
    frag = set()
    for i, short_t in enumerate(kept):
        for long_t in kept[i + 1:]:
            if short_t in long_t and df[short_t] > df[long_t] * 1.5:
                frag.add(long_t)
    return {t: c for t, c in df.items() if t not in frag}


def burst_score(today, baseline_avg):
    """突发度：当日文档数相对历史基线的提升倍数，加平滑避免除零。"""
    lift = (today + 1) / (baseline_avg + 1)
    return round(math.sqrt(today) * math.log2(max(lift, 1.0) + 1), 2), round(lift, 2)
