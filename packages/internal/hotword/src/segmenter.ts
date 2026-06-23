/**
 * Chinese text segmentation using Intl.Segmenter + financial domain dictionary.
 * Falls back to simple n-gram extraction if Intl.Segmenter is unavailable.
 */

const CJK_RANGE = /[\u4e00-\u9fff]/
const CJK_RUN = /[\u4e00-\u9fff]+/g
const LATIN_TOKEN = /[A-Za-z\u03b1-\u03c9][A-Za-z0-9\u03b1-\u03c9\-+]{1,14}/g
const SPLIT_PATTERN = /[^\u4e00-\u9fffA-Za-z0-9\u03b1-\u03c9\u0391-\u03a9+]+/

/** Financial domain compound terms that segmenters often split incorrectly */
export const FINANCE_DICTIONARY: string[] = [
  // Market structure
  "涨停板",
  "跌停板",
  "涨停",
  "跌停",
  "封板",
  "炸板",
  "连板",
  "断板",
  "打板",
  "排板",
  "首板",
  "二板",
  "三板",
  "高标",
  // Trading
  "主力资金",
  "北向资金",
  "融资融券",
  "大宗交易",
  "龙虎榜",
  "成交额",
  "成交量",
  "换手率",
  "市盈率",
  "市净率",
  // Policy / Regulatory
  "证监会",
  "央行",
  "银保监",
  "金融监管",
  "货币政策",
  "降准",
  "降息",
  "加息",
  "逆回购",
  "MLF",
  "LPR",
  "注册制",
  "退市",
  "转融通",
  "量化交易",
  // Sectors
  "人工智能",
  "大模型",
  "算力",
  "芯片",
  "半导体",
  "新能源",
  "光伏",
  "储能",
  "锂电池",
  "固态电池",
  "机器人",
  "无人驾驶",
  "自动驾驶",
  "智能驾驶",
  "军工",
  "航天",
  "卫星",
  "低空经济",
  "医药",
  "创新药",
  "中药",
  "医疗器械",
  "消费",
  "白酒",
  "食品饮料",
  "房地产",
  "基建",
  "水泥",
  // Common financial terms
  "利好",
  "利空",
  "高开",
  "低开",
  "放量",
  "缩量",
  "突破",
  "回调",
  "反弹",
  "震荡",
  "横盘",
  "牛市",
  "熊市",
  "慢牛",
  "快牛",
  "题材",
  "概念",
  "板块",
  "赛道",
  "风口",
  "龙头",
  "妖股",
  "核心资产",
  "预期差",
  "超预期",
  "不及预期",
  "业绩",
  "营收",
  "净利润",
  "毛利率",
]

/** Stopwords to filter out from results — comprehensive list for financial news */
const STOPWORDS = new Set([
  // Common verbs/actions
  "表示",
  "认为",
  "指出",
  "提出",
  "强调",
  "建议",
  "要求",
  "决定",
  "介绍",
  "透露",
  "回应",
  "称",
  "说",
  "报道",
  "发布",
  "公告",
  "披露",
  "宣布",
  "通知",
  "通报",
  "开展",
  "推动",
  "落实",
  "执行",
  "实施",
  "完成",
  "进行",
  "开始",
  "结束",
  "继续",
  "停止",
  "恢复",
  "调整",
  "优化",
  "加强",
  "提升",
  "促进",
  "深化",
  "扩大",
  "缩小",
  "实现",
  "达到",
  "超过",
  "突破",
  "创新",
  "打造",
  "构建",
  "推进",
  "保持",
  "维持",
  "确保",
  "保障",
  "支持",
  "推出",
  "上线",
  "发行",
  // Time words
  "今日",
  "昨日",
  "今天",
  "昨天",
  "明天",
  "近日",
  "日前",
  "目前",
  "当前",
  "此前",
  "之前",
  "之后",
  "以来",
  "截至",
  "期间",
  "季度",
  "上半年",
  "下半年",
  "全年",
  "年初",
  "年底",
  "月初",
  "月底",
  "上周",
  "本周",
  "下周",
  "今年",
  "去年",
  "明年",
  "未来",
  // Generic nouns
  "公司",
  "企业",
  "机构",
  "部门",
  "单位",
  "组织",
  "平台",
  "系统",
  "方案",
  "计划",
  "规划",
  "政策",
  "措施",
  "办法",
  "意见",
  "通知",
  "报告",
  "文件",
  "材料",
  "信息",
  "内容",
  "形式",
  "模式",
  "方式",
  "领域",
  "行业",
  "方面",
  "层面",
  "角度",
  "程度",
  "水平",
  "能力",
  "情况",
  "问题",
  "条件",
  "环境",
  "趋势",
  "方向",
  "目标",
  "任务",
  "工作",
  "项目",
  "业务",
  "服务",
  "产品",
  "技术",
  "市场",
  "经济",
  "社会",
  "国家",
  "地区",
  "城市",
  "世界",
  "全球",
  // Pronouns/conjunctions/adverbs
  "我们",
  "他们",
  "自己",
  "大家",
  "对方",
  "双方",
  "各方",
  "已经",
  "正在",
  "将要",
  "可能",
  "应该",
  "需要",
  "必须",
  "非常",
  "十分",
  "比较",
  "相对",
  "基本",
  "主要",
  "重要",
  "进一步",
  "充分",
  "全面",
  "持续",
  "积极",
  "有效",
  "合理",
  "以及",
  "对于",
  "关于",
  "通过",
  "根据",
  "按照",
  "围绕",
  "其中",
  "此外",
  "同时",
  "另外",
  "而且",
  "但是",
  "不过",
  "如果",
  "虽然",
  "因为",
  "所以",
  "因此",
  "为了",
  "由于",
  // Numbers/units/measurements
  "美元",
  "亿元",
  "万元",
  "百万",
  "千万",
  "元",
  "亿",
  "同比",
  "环比",
  "增长",
  "下降",
  "上涨",
  "下跌",
  "持平",
  "人民币",
  "港币",
  "欧元",
  "日元",
  // Geographic (too generic)
  "中国",
  "美国",
  "欧洲",
  "日本",
  "韩国",
  "印度",
  "国内",
  "国际",
  "海外",
  "境内",
  "境外",
  "北京",
  "上海",
  "深圳",
  "广州",
  "香港",
  // Finance generics (too common to be hot)
  "港股",
  "美股",
  "A股",
  "股票",
  "股市",
  "数据",
  "显示",
  "或将",
  "相关",
  "有限",
  "集团",
  "股份",
  "上市",
  "挂牌",
  "成功",
  "收购",
  "合作",
  "投资",
  "基金",
  "证券",
  "银行",
  "保险",
  "正式",
  "首次",
  "再次",
  "新增",
  "新设",
  "合计",
  "累计",
  "消息",
  "记者",
  "分析师",
  "研究员",
  "媒体",
  "预计",
  "预期",
  "展望",
  "评级",
  "评估",
  // HTML/tech noise
  "原文",
  "链接",
  "来源",
  "作者",
  "编辑",
  "责编",
  "转载",
  "详情",
  "全文",
  "摘要",
  "标题",
  "正文",
])

const GENERIC_LATIN = new Set([
  "https",
  "http",
  "www",
  "com",
  "org",
  "net",
  "html",
  "htm",
  "api",
  "app",
  "sdk",
  "url",
  "css",
  "xml",
  "rss",
  "json",
  "ceo",
  "cfo",
  "cto",
  "coo",
  "vp",
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "are",
  "was",
  "were",
  "been",
  "have",
  "has",
  "had",
  "will",
  "would",
  "not",
  "but",
  "all",
  "can",
  "may",
  "its",
  "new",
  "one",
  "two",
  "said",
  "year",
  "also",
  "more",
  "than",
  "other",
  "some",
  "per",
  "via",
  "etc",
  "inc",
  "ltd",
  "corp",
])

/**
 * Dictionary terms form the "whitelist" — terms that are always meaningful.
 * Non-dictionary terms must pass a stricter frequency filter.
 */
const DICTIONARY_SET = new Set(FINANCE_DICTIONARY)

let segmenter: Intl.Segmenter | null = null

function getSegmenter(): Intl.Segmenter | null {
  if (segmenter) return segmenter
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" })
    return segmenter
  }
  return null
}

/** Extract n-grams from a Chinese character run (fallback when no segmenter) */
function extractNgrams(run: string, lo = 2, hi = 4): string[] {
  const results: string[] = []
  for (let n = lo; n <= hi; n++) {
    for (let i = 0; i <= run.length - n; i++) {
      results.push(run.slice(i, i + n))
    }
  }
  return results
}

/** Check if a term matches any dictionary entry (for compound term detection) */
function matchDictionary(text: string): string[] {
  const matches: string[] = []
  for (const term of FINANCE_DICTIONARY) {
    if (text.includes(term)) {
      matches.push(term)
    }
  }
  return matches
}

export interface SegmentResult {
  terms: string[]
  dictionaryMatches: string[]
}

/**
 * Segment text and extract candidate hotword terms.
 * Uses a dictionary-first approach:
 * - Dictionary terms are always included (high signal)
 * - Non-dictionary Chinese terms must be >= 3 chars (reduces noise from generic 2-char words)
 * - Latin tokens must be known abbreviations or >= 3 chars
 *
 * Returns de-duplicated terms.
 */
export function segmentText(text: string): SegmentResult {
  const terms = new Set<string>()
  const dictionaryMatches: string[] = []

  // First pass: extract dictionary compound terms (highest priority)
  const dictMatches = matchDictionary(text)
  for (const match of dictMatches) {
    terms.add(match)
    dictionaryMatches.push(match)
  }

  // Split text into segments
  const segments = text.split(SPLIT_PATTERN)

  for (const seg of segments) {
    if (!seg) continue

    // Extract Latin tokens (ETF, REITS, AI, etc.)
    for (const match of seg.matchAll(LATIN_TOKEN)) {
      const tok = match[0]
      if (tok.length < 2) continue
      const lower = tok.toLowerCase()
      if (GENERIC_LATIN.has(lower)) continue
      if (/^\d+$/.test(tok)) continue
      // Uppercase short abbreviations
      const normalized = tok.length <= 6 && /^[a-z]+$/i.test(tok) ? tok.toUpperCase() : tok
      // Only keep if it's a known finance term or >= 3 chars
      if (normalized.length >= 3 || DICTIONARY_SET.has(normalized)) {
        terms.add(normalized)
      }
    }

    // Extract Chinese terms
    const cjkRuns = seg.match(CJK_RUN)
    if (!cjkRuns) continue

    for (const run of cjkRuns) {
      const seg2 = getSegmenter()
      if (seg2) {
        // Use Intl.Segmenter for word-level segmentation
        for (const { segment, isWordLike } of seg2.segment(run)) {
          if (!isWordLike || !CJK_RANGE.test(segment)) continue
          // Dictionary terms: always keep (even 2-char)
          if (DICTIONARY_SET.has(segment)) {
            terms.add(segment)
            continue
          }
          // Non-dictionary: require >= 3 chars to reduce noise
          if (segment.length >= 3) {
            terms.add(segment)
          }
        }
      } else {
        // Fallback: n-gram extraction (prefer 3-4 grams)
        for (const ngram of extractNgrams(run, 3, 4)) {
          terms.add(ngram)
        }
      }
    }
  }

  // Filter stopwords
  const filtered = [...terms].filter((t) => !STOPWORDS.has(t))

  return { terms: filtered, dictionaryMatches }
}
