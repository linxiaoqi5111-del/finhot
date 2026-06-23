const FIREBASE_CONFIG_DEFAULT = "{}"

export const DEFAULT_VALUES = {
  PROD: {
    API_URL: "http://127.0.0.1:0",
    OTA_URL: "http://127.0.0.1:0",
    WEB_URL: "http://127.0.0.1",
    INBOXES_EMAIL: "@local",
    FIREBASE_CONFIG: FIREBASE_CONFIG_DEFAULT,
    RECAPTCHA_V3_SITE_KEY: "",

    POSTHOG_KEY: "",
    POSTHOG_HOST: "http://127.0.0.1",
  },
  DEV: {
    API_URL: "http://127.0.0.1:0",
    OTA_URL: "http://127.0.0.1:0",
    WEB_URL: "http://127.0.0.1",
    INBOXES_EMAIL: "__dev@local",
  },
  STAGING: {
    API_URL: "http://127.0.0.1:0",
    OTA_URL: "http://127.0.0.1:0",
    WEB_URL: "http://127.0.0.1",
    INBOXES_EMAIL: "@local",
    POSTHOG_KEY: "",
    POSTHOG_HOST: "http://127.0.0.1",
  },
  LOCAL: {
    API_URL: "http://localhost:3000",
    OTA_URL: "http://localhost:8787",
    WEB_URL: "http://localhost:2233",
    INBOXES_EMAIL: "@follow.re",
  },
}
