export const imageRefererMatches = [
  {
    url: /^https:\/\/\w+\.sinaimg\.cn/,
    referer: "https://weibo.com",
  },
  {
    url: /^https:\/\/i\.pximg\.net/,
    referer: "https://www.pixiv.net",
  },
  {
    url: /^https:\/\/cdnfile\.sspai\.com/,
    referer: "https://sspai.com",
  },
  {
    url: /^https:\/\/(?:\w|-)+\.cdninstagram\.com/,
    referer: "https://www.instagram.com",
  },
  {
    url: /^https:\/\/sp1\.piokok\.com/,
    referer: "https://www.piokok.com",
    force: true,
  },
  {
    url: /^https?:\/\/[\w-]+\.xhscdn\.com/,
    referer: "https://www.xiaohongshu.com",
  },
]

export const getImageProxyUrl = ({
  url,
}: {
  url: string
  width?: number
  height?: number
  canUseProxy?: boolean
}) => {
  return url
}

export const replaceImgUrlIfNeed = ({
  url,
}: {
  url?: string
  inBrowser?: boolean
  canUseProxy?: boolean
}) => {
  if (!url) return url
  return url
}
