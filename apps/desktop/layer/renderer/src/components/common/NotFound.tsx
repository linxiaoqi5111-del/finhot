import { Button } from "@follow/components/ui/button/index.js"
import { ELECTRON_BUILD } from "@follow/shared/constants"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import type { Location } from "react-router"
import { Navigate, useLocation, useNavigate } from "react-router"

import { useSyncTheme } from "~/hooks/common"
import { removeAppSkeleton } from "~/lib/app"
import { FocalLogo } from "~/modules/brand/FocalLogo"

import { PoweredByFooter } from "./PoweredByFooter"

class AccessNotFoundError extends Error {
  constructor(
    message: string,
    public path: string,
    public location: Location<any>,
  ) {
    super(message)
    this.name = "AccessNotFoundError"
  }

  override toString() {
    return `${this.name}: ${this.message} at ${this.path}`
  }
}
export const NotFound = () => {
  const location = useLocation()
  useSyncTheme()

  useEffect(() => {
    if (!ELECTRON_BUILD) {
      return
    }
    console.error(
      new AccessNotFoundError(
        "Electron app got to a 404 page, this should not happen",
        location.pathname,
        location,
      ),
    )
  }, [location])

  useEffect(() => {
    removeAppSkeleton()
  }, [])
  const navigate = useNavigate()
  const { t } = useTranslation()

  if (location.pathname.endsWith("/index.html")) {
    return <Navigate to="/" />
  }

  return (
    <div className="prose center m-auto size-full flex-col dark:prose-invert">
      <main className="flex grow flex-col items-center justify-center">
        <div className="center mb-8 flex">
          <FocalLogo className="size-20 rounded-[1.75rem]" />
        </div>
        <p className="font-semibold">{t("not_found.description")}</p>
        <p>
          Current path: <code>{location.pathname}</code>
        </p>

        <p>
          <Button onClick={() => navigate("/")}>{t("not_found.back_home")}</Button>
        </p>
      </main>

      <PoweredByFooter className="center -mt-12 flex gap-2 py-8" />
    </div>
  )
}
