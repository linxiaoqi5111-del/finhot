import { useCallback } from "react"

export const useRequireLogin = () => {
  const isLoggedIn = true

  const ensureLogin = useCallback(() => {
    return true
  }, [])

  const withLoginGuard = useCallback(
    <T extends (...args: any[]) => unknown>(action: T) => {
      if (!action) return action

      return ((...args: Parameters<T>) => {
        if (!ensureLogin()) {
          return
        }
        return action(...args)
      }) as T
    },
    [ensureLogin],
  )

  return {
    isLoggedIn,
    ensureLogin,
    withLoginGuard,
    showLoginModal: ensureLogin,
  }
}
