/**
 * Preset financial RSS feeds for FinHot.
 * Categories: 监管政策 / 产品发布 / 行业动态 / 研报 / 观点洞察
 *
 * URL priority: local RSSHub (localhost:1200) > public fallback (rss.kael.ink)
 * The local instance is faster, more reliable, and supports cookie-based sources.
 */

/** Base URL for local self-hosted RSSHub instance */
export const LOCAL_RSSHUB_BASE = "http://localhost:1200"

/** Fallback public RSSHub instance */
export const FALLBACK_RSSHUB_BASE = "https://rss.kael.ink"

export interface FinanceFeed {
  title: string
  url: string
  category: FinanceFeedCategory
  description?: string
}

export type FinanceFeedCategory = "regulatory" | "product" | "market" | "research" | "opinion"

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
    title: "财联社电报",
    url: `${LOCAL_RSSHUB_BASE}/cls/telegraph`,
    category: "regulatory",
    description: "财联社7x24电报快讯",
  },
  {
    title: "财联社深度",
    url: `${LOCAL_RSSHUB_BASE}/cls/depth`,
    category: "regulatory",
    description: "财联社深度报道",
  },

  // 行业动态
  {
    title: "华尔街见闻",
    url: `${LOCAL_RSSHUB_BASE}/wallstreetcn/news/global`,
    category: "market",
    description: "华尔街见闻全球快讯",
  },
  {
    title: "金十数据",
    url: `${LOCAL_RSSHUB_BASE}/jin10`,
    category: "market",
    description: "金十数据快讯",
  },
  {
    title: "格隆汇",
    url: `${LOCAL_RSSHUB_BASE}/gelonghui/live`,
    category: "market",
    description: "格隆汇实时资讯",
  },
  {
    title: "第一财经",
    url: `${LOCAL_RSSHUB_BASE}/yicai/news`,
    category: "market",
    description: "第一财经新闻",
  },

  // 研报
  {
    title: "36氪最新",
    url: `${LOCAL_RSSHUB_BASE}/36kr/news/latest`,
    category: "research",
    description: "36氪最新科技商业资讯",
  },
  {
    title: "36氪 Feed",
    url: "https://36kr.com/feed",
    category: "research",
    description: "36氪官方 RSS Feed",
  },

  // 观点洞察
  {
    title: "财新网",
    url: `${LOCAL_RSSHUB_BASE}/caixin/latest`,
    category: "opinion",
    description: "财新网深度报道",
  },
  {
    title: "知乎热榜",
    url: `${LOCAL_RSSHUB_BASE}/zhihu/hot`,
    category: "opinion",
    description: "知乎热门话题",
  },

  // 社交媒体（需要本地 RSSHub + Cookie）
  {
    title: "微博财经热搜",
    url: `${LOCAL_RSSHUB_BASE}/weibo/search/hot`,
    category: "market",
    description: "微博实时热搜榜（需本地 RSSHub Cookie）",
  },
  {
    title: "雪球热帖",
    url: `${LOCAL_RSSHUB_BASE}/xueqiu/hots`,
    category: "opinion",
    description: "雪球社区热门讨论（需本地 RSSHub Cookie）",
  },
]
