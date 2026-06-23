import { useQuery } from "@tanstack/react-query"

const isMASBuild = () => typeof process !== "undefined" && !!process.mas

export const useMASStoreVersionQuery = () => {
  const { data } = useQuery({
    queryKey: ["ota-versions", "store", "desktop", "mas"],
    queryFn: () => Promise.resolve(),
    enabled: isMASBuild(),
  })

  return data
}
