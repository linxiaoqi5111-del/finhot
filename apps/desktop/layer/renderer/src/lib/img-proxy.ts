import {
  getImageProxyUrl as getImageProxyUrlUtils,
  replaceImgUrlIfNeed as replaceImgUrlIfNeedUtils,
} from "@follow/utils/img-proxy"

// Keep the old hook-shaped API for existing components while the implementation is local-only.
// eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix, @eslint-react/hooks-extra/ensure-custom-hooks-using-other-hooks
export const useReplaceImgUrlIfNeed = () => (url?: string) =>
  replaceImgUrlIfNeedUtils({
    url,
  })

// eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix, @eslint-react/hooks-extra/ensure-custom-hooks-using-other-hooks
export const useGetImageProxyUrl =
  () => (params: Omit<Parameters<typeof getImageProxyUrlUtils>[0], "canUseProxy">) =>
    getImageProxyUrlUtils(params)
