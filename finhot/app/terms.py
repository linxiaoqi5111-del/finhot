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
同时 成本 长期 材料 新增 传统 开发 场景 开始 之一 加速 形成 简称 记录 纪录 细节 据称 认购 用于 今晚
匿名 意味着 不同 另一 散户 盎司 一种 可以 已经 由于 因此 所以 以后 还是 但是 如果 现在 大幅 显著 明显
首次 未来几年 今年以来 这些 那些 各种 多个 部分原因 相比 甚至 几乎 非常 更多 更好 最新 带来 提供 获得 表明
达到 后续 设计 随着 明确 讨论 内容 活动 大量 已有 多家 地点 大型 伴随 还称 关系 要点 条款 布局 空间
竞争 利润 监管 大规模 厂商 赛道 产能 短期 年底 此外 期间 之后 之前 发现 需要 如何 什么 怎么 能够 开展
就是 所有 得到 来自 作出 机构 专业 稳定 正常 实际 时代 探索 负责人 框架 日内 日内涨 日内跌 储备 股价 股市
工业 消费者 回复 这次 上次 每次 再次 一起 一样 一直 只有 只是 其实 当然 真正 完全 特别 整个 全部 本轮
旨在 具有 每日 推出 面向 办理 内涨 内跌 期银 纽约 伦敦 单日 当地时间 北京时间 消息称 透露 报价 现报 涨幅 跌幅
最高 最低 重磅 暴涨 暴跌 大涨 大跌 利好 利空 炸了 爆了 刷屏 突然 全面 彻底 继续 轰动 惊人 罕见 紧急
回应 预测 估计 相信 觉得 看好 看空 观点 评论 解读 盘点 梳理 复盘 总结 展望 点评 直击 聚焦 围绕 涉及
上市公司 实验室 集团股份 股份公司
控制 管理 重要 领域 基本 增加 减少 提高 降低 部分 全部 可能 或者 以及 对于 关于 通过 进行
情况 问题 工作 项目 业务 报告 研究 分析 技术 系统 平台 模式 增速 规模 水平 同期 累计 出现
有限公司 公告称 本次 重大 事项 存在 其他 主要 确定 目标 方式 总股本 万股 股东 股权 控股 集团 上市
信息 人民 基础 正在 需求 资产 消费 创新 利率 投资者 证券报 采购 转让 增持 减持 回购 中标 签署
正式 成为 近日 收到 合计 尚未 波动 异常 经营 研发 生态 核心 电子 子公司 持股 能力 打击 设施
申请 截至 安全 任何 供应 包括 冲击 地区 我们 行动 及其 其中 公布 连续 比例 金额 政府 不确定性
交易日 股票交易 公司股票 集中竞价 大宗 自查 全资 双方 方案 阶段 注意 取得 作为 收入 日起 制造
战略 全国 客户 资本 中心 应用 人士 最大 城市 业绩 前期 头部 传闻 亿美元 万美元 亿股 当日 媒体
集中 竞价 了解 打造 变更 进展 计算 产生 新的 通知 营业 充分 力争 聚焦 共同 高端 进入 注册
基础设施 周期 实质性 大额 较大 程度 能为 或大 公司股 占公 日收 司股 司近 常波 业链 个交 对公 不超
""".split())

# 炒作信号词本身不能当热词（它们是闸口，不是题材），见下方 SPEC_SIGNALS

_STOP_FRAGMENTS = {g for w in STOPWORDS if len(w) >= 3 for n in (2, 3) for i in range(len(w) - n + 1) for g in [w[i:i + n]] if g != w}
# 生成 n-gram 前先把停用词当作分隔符切掉，从根上避免「公司近」「司股」这类跨词边界碎片
_STOP_SPLIT = None  # 在文件尾部初始化（需要 SPEC_SIGNALS）

GENERIC_LATIN = {"https", "http", "www", "com", "cn", "html", "api", "app", "ceo", "cfo", "cto",
                 "ipo", "gdp", "cpi", "ppi", "pmi", "etf", "reits", "st", "ai",
                 "sh", "sz", "bj", "hk", "a股", "qfii",
                 "nbsp", "amp", "quot", "ldquo", "rdquo", "middot", "hellip", "mdash"}  # HTML 实体残留


# 虚词/功能字：含这些字的 n-gram 几乎都是跨词边界碎片（的散户、是一、朗普谈伊……），直接丢弃
_FUNC_CHARS = set("的了是在将已与对为于也都该或被把其这那但并而则即从向至因由据称如若让之及等呢吗啊吧就又再很更最仅只未非何每各另某些此何")


def _token_ngrams(piece, lo=2, hi=4):
    """按 jieba 分词边界拼接相邻 token 生成候选词（捕捉词典外新词如「六氟化钨」），
    不再从任意字位置切 n-gram，从根上避免「朗普谈伊」这类跨词碎片。"""
    toks = list(jieba.cut(piece))
    for i in range(len(toks)):
        cur = ""
        for j in range(i, len(toks)):
            cur += toks[j]
            if len(cur) > hi:
                break
            if len(cur) >= lo:
                yield cur


_SIGNAL_SET = None  # 在文件尾部初始化（依赖 SPEC_SIGNALS 定义）


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
                if len(w) >= 2 and w not in STOPWORDS and w not in _SIGNAL_SET:
                    terms.add(w)
            for piece in _STOP_SPLIT.split(run):
                for g in _token_ngrams(piece):
                    if g in STOPWORDS or g in _STOP_FRAGMENTS or g in _SIGNAL_SET:
                        continue
                    if any(ch in _FUNC_CHARS for ch in g):
                        continue
                    terms.add(g)
    return terms


def count_daily_terms(events, min_doc=2):
    """events: [{"texts": [文本...], "weight": 信源权重}] -> {term: (事件数, 炒作事件数, 权重和)}。

    热度按事件计而非条数计（同一件事的转发只算一次）；权重和 = 提及该词的
    各事件信源权重之和，用于打分。min_doc 过滤仍按原始条数（避免一条孤例成词）。
    """
    df = defaultdict(int)        # 事件数
    spec = defaultdict(int)      # 炒作语境事件数
    wsum = defaultdict(float)    # 信源权重和
    df_items = defaultdict(int)  # 原始条数（仅用于低频过滤）
    for ev in events:
        ev_terms = set()
        speculative = False
        for text in ev["texts"]:
            terms = extract_terms(text)
            ev_terms |= terms
            speculative = speculative or is_speculative(text)
            for t in terms:
                df_items[t] += 1
        for t in ev_terms:
            df[t] += 1
            wsum[t] += ev.get("weight", 1.0)
            if speculative:
                spec[t] += 1
    df = {t: c for t, c in df.items() if df_items[t] >= min_doc}
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
    return {t: (c, spec.get(t, 0), round(wsum[t], 2)) for t, c in df.items() if t not in frag}


# ---- A股炒作闸口 ----
# 一条快讯是否处于"容易引起A股炒作"的语境：含炒作信号词或A股股票代码。
# 热词的"炒作浓度" = 出现在炒作语境快讯中的次数 / 总出现次数，
# 宏观政治类词（伊朗、加息……）几乎不会出现在这种语境里，会被闸口拦掉。
SPEC_SIGNALS = [
    "涨停", "概念股", "概念", "板块", "题材", "受益", "产业链", "国产替代", "量产",
    "中标", "订单", "扩产", "投产", "签约", "新技术", "突破", "商业化", "送样",
    "客户验证", "供应商", "渗透率", "放量", "异动", "龙头", "炒作", "暴涨", "大涨",
    "封板", "连板", "妖股", "游资", "席位", "龙虎榜", "市占率", "出货量", "首发",
    "获订单", "独家供应", "打入", "切入", "落地", "试点", "招标", "新产品", "专利",
]
STOCK_CODE = re.compile(r"\b(?:[036]\d{5}|[48]\d{5})\b|[（(]\d{6}[）)]")


def is_speculative(text):
    """判断一条快讯是否处于 A股炒作语境。"""
    return bool(STOCK_CODE.search(text)) or any(s in text for s in SPEC_SIGNALS)


def burst_score(today, baseline_avg):
    """突发度：当日文档数相对历史基线的提升倍数，加平滑避免除零。"""
    lift = (today + 1) / (baseline_avg + 1)
    return round(math.sqrt(today) * math.log2(max(lift, 1.0) + 1), 2), round(lift, 2)


_SIGNAL_SET = set(SPEC_SIGNALS)
_STOP_SPLIT = re.compile("|".join(
    re.escape(w) for w in sorted(STOPWORDS | _SIGNAL_SET, key=len, reverse=True) if len(w) >= 2
))
