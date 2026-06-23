import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { useAISettingValue } from "~/atoms/settings/ai"
import { followApi } from "~/lib/api-client"
import { buildLocalByokAIConfiguration } from "~/modules/settings/tabs/ai/byok/constants"

export const useAIConfiguration = () => {
  const aiSettings = useAISettingValue()
  const localConfiguration = useMemo(
    () => buildLocalByokAIConfiguration(aiSettings.byok),
    [aiSettings.byok],
  )

  const remoteConfiguration = useQuery({
    queryKey: ["aiConfiguration"],
    queryFn: async () => {
      return followApi.ai.config()
    },
    enabled: !LOCAL_RSS_MODE,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  if (LOCAL_RSS_MODE) {
    return {
      ...remoteConfiguration,
      data: localConfiguration,
      isLoading: false,
      isFetching: false,
      isPending: false,
    }
  }

  return remoteConfiguration
}
