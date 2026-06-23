import { IN_ELECTRON, LOCAL_RSS_MODE } from "@follow/shared/constants"
import { whoamiQueryKey } from "@follow/store/user/hooks"
import { userSyncService } from "@follow/store/user/store"
import { tracker } from "@follow/tracker"
import { clearStorage } from "@follow/utils/ns"
import type { FetchError } from "ofetch"
import { useEffect } from "react"

import { setLoginModalShow } from "~/atoms/user"
import { QUERY_PERSIST_KEY } from "~/constants"
import { useAuthQuery } from "~/hooks/common"
import {
  getAccountInfo,
  getSession as refreshBetterAuthSession,
  signOut as signOutFn,
} from "~/lib/auth"
import { ipcServices } from "~/lib/client"
import { clearAuthSessionToken, getAuthSessionToken } from "~/lib/client-session"
import { defineQuery } from "~/lib/defineQuery"
import { clearLocalPersistStoreData } from "~/store/utils/clear"

const sessionCookieRefreshInterval = 1000 * 60 * 60 * 12

let lastSessionCookieRefreshAt = 0
let sessionCookieRefreshPromise: Promise<unknown> | null = null

const refreshAuthSessionCookie = async () => {
  if (LOCAL_RSS_MODE) {
    return
  }

  if (IN_ELECTRON && !getAuthSessionToken()) {
    return
  }

  if (Date.now() - lastSessionCookieRefreshAt < sessionCookieRefreshInterval) {
    return
  }

  sessionCookieRefreshPromise ??= refreshBetterAuthSession()
    .then((result) => {
      if (!result?.error) {
        lastSessionCookieRefreshAt = Date.now()
      }
      return result
    })
    .catch(() => null)
    .finally(() => {
      sessionCookieRefreshPromise = null
    })

  await sessionCookieRefreshPromise
}

export const auth = {
  getSession: () =>
    defineQuery(whoamiQueryKey, () =>
      LOCAL_RSS_MODE ? Promise.resolve(null) : userSyncService.whoami(),
    ),
  getAccounts: () =>
    defineQuery(["auth", "accounts"], () =>
      LOCAL_RSS_MODE ? Promise.resolve({ data: [] }) : getAccountInfo(),
    ),
}

const useAccounts = () => {
  return useAuthQuery(auth.getAccounts())
}

export const useHasPassword = () => {
  const accounts = useAccounts()
  return {
    ...accounts,
    data: !!accounts.data?.data?.find((account) => account.provider === "credential"),
  }
}

export const useSession = (options?: { enabled?: boolean }) => {
  const { data, isLoading, ...rest } = useAuthQuery(auth.getSession(), {
    retry(failureCount, error) {
      const fetchError = error as FetchError

      if (fetchError.statusCode === undefined) {
        return false
      }

      return !!(3 - failureCount)
    },
    enabled: options?.enabled ?? true,
    refetchOnMount: true,
    staleTime: 0,
    meta: {
      persist: true,
    },
  })
  const { error } = rest
  const fetchError = error as FetchError

  const getAuthStatus = ():
    | "loading"
    | "authenticated"
    | "error"
    | "unauthenticated"
    | "unknown" => {
    if (isLoading) {
      return "loading"
    }

    if (fetchError) {
      return "error"
    }

    if (data) {
      return "authenticated"
    }

    if (data === null) {
      return "unauthenticated"
    }

    return "unknown"
  }

  return {
    session: data,
    ...rest,
    status: getAuthStatus(),
  } as const
}

export const useAuthSessionCookieRefresh = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled || LOCAL_RSS_MODE) {
      return
    }

    const refresh = () => {
      if (document.visibilityState !== "hidden") {
        void refreshAuthSessionCookie()
      }
    }

    refresh()

    const interval = window.setInterval(refresh, sessionCookieRefreshInterval)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [enabled])
}

export const handleSessionChanges = () => {
  setLoginModalShow(false)
  if (LOCAL_RSS_MODE) {
    window.location.reload()
    return
  }

  const authSessionToken = getAuthSessionToken()
  ipcServices?.auth.sessionChanged(authSessionToken ?? undefined)
  window.location.reload()
}

export const signOut = async () => {
  const authSessionToken = getAuthSessionToken()
  clearAuthSessionToken()
  // Clear query cache
  localStorage.removeItem(QUERY_PERSIST_KEY)

  // clear local store data
  await clearLocalPersistStoreData()

  // Clear local storage
  clearStorage()
  // Sign out
  await tracker.manager.clear()
  if (LOCAL_RSS_MODE) {
    window.location.reload()
    return
  }

  if (IN_ELECTRON) {
    void ipcServices?.auth.signOut()
    const authService = ipcServices?.auth as
      | ({ signOutRemote?: (token?: string) => Promise<void> } & NonNullable<
          typeof ipcServices
        >["auth"])
      | undefined
    void authService?.signOutRemote?.(authSessionToken ?? undefined)
  } else {
    await ipcServices?.auth.signOut()
    await signOutFn()
  }
  window.location.reload()
}
