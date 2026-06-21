/**
 * Preset financial RSS feeds for FinHot.
 * Categories: 监管政策 / 产品发布 / 行业动态 / 研报 / 观点洞察
 */

export interface FinanceFeed {
  title: string
  url: string
  category: FinanceFeedCategory
  description?: string
}

export type FinanceFeedCategory =
  | "regulatory"
  | "product"
  | "market"
  | "research"
  | "opinion"

export const FinanceFeedCategoryMap: Record<
  FinanceFeedCategory,
  { label: string; emoji: string; color: string }
> = {
  regulatory: { label: "监管政策", emoji: "🏛", color: "#6366f1" },
  product: { label: "产品发布", emoji: "📦", color: "#10b981" },
  market: { label: "行业动态", emoji: "📊", color: "#f59e0b" },
  research: { label: "研报", emoji: "📑", color: "#8b5cf6" },
  opinion: { label: "观点洞察", emoji: "💡", color: "#ec4899" },
}

export const PRESET_FINANCE_FEEDS: FinanceFeed[] = [
  // 监管政策
  {
    title: "证监会新闻",
    url: "https://rsshub.app/gov/csrc/news",
    category: "regulatory",
    description: "中国证监会官方新闻发布",
  },
  {
    title: "央行公告",
    url: "https://rsshub.app/gov/pbc/goutongjiaoliu",
    category: "regulatory",
    description: "中国人民银行沟通交流",
  },
  {
    title: "金融监管总局",
    url: "https://rsshub.app/gov/cbirc",
    category: "regulatory",
    description: "国家金融监督管理总局",
  },

  // 行业动态
  {
    title: "新浪财经 7x24",
    url: "https://rsshub.app/sina/finance/live",
    category: "market",
    description: "新浪财经 7x24 实时快讯",
  },
  {
    title: "东方财富快讯",
    url: "https://rsshub.app/eastmoney/report/strategy",
    category: "market",
    description: "东方财富研报策略",
  },
  {
    title: "华尔街见闻",
    url: "https://rsshub.app/wallstreetcn/news/global",
    category: "market",
    description: "华尔街见闻全球快讯",
  },
  {
    title: "同花顺快讯",
    url: "https://rsshub.app/10jqka/realtimenews",
    category: "market",
    description: "同花顺实时财经新闻",
  },
  {
    title: "格隆汇",
    url: "https://rsshub.app/gelonghui/live",
    category: "market",
    description: "格隆汇实时资讯",
  },
  {
    title: "第一财经",
    url: "https://rsshub.app/yicai/news",
    category: "market",
    description: "第一财经新闻",
  },

  // 研报
  {
    title: "36氪金融",
    url: "https://rsshub.app/36kr/motif/finance",
    category: "research",
    description: "36氪金融科技",
  },
  {
    title: "巨潮资讯公告",
    url: "https://rsshub.app/cninfo/announcement",
    category: "research",
    description: "巨潮资讯网公告",
  },

  // 观点洞察
  {
    title: "财新网",
    url: "https://rsshub.app/caixin/latest",
    category: "opinion",
    description: "财新网深度报道",
  },
  {
    title: "FT中文网",
    url: "https://rsshub.app/ftchinese/channel/stream",
    category: "opinion",
    description: "FT中文网精选",
  },
]
