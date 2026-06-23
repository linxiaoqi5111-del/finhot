import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { useQuery } from "@tanstack/react-query"

import { followApi } from "~/lib/api-client"

export const useServerConfigsQuery = () => {
  const { data } = useQuery({
    queryKey: ["server-configs"],
    queryFn: () => followApi.status.getConfigs(),
    enabled: !LOCAL_RSS_MODE,
  })
  return data?.data
}
