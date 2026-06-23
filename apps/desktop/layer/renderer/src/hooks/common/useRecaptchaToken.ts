import { useCallback } from "react"
import { useGoogleReCaptcha } from "react-google-recaptcha-v3"

type RecaptchaE2EWindow = Window &
  typeof globalThis & {
    __FOCAL_E2E_RECAPTCHA_TOKEN__?: string
  }

export const useRecaptchaToken = () => {
  const { executeRecaptcha } = useGoogleReCaptcha()

  return useCallback(
    async (action: string) => {
      const e2eToken = (window as RecaptchaE2EWindow).__FOCAL_E2E_RECAPTCHA_TOKEN__
      if (e2eToken) {
        return e2eToken
      }

      if (
        navigator.webdriver ||
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1"
      ) {
        return "e2e-token"
      }

      if (!executeRecaptcha) {
        return null
      }

      try {
        return await executeRecaptcha(action)
      } catch (error) {
        console.error("Failed to execute reCAPTCHA", error)
        return null
      }
    },
    [executeRecaptcha],
  )
}
