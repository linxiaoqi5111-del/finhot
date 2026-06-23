import type { CaptureExceptionPayload, IdentifyPayload, TrackerAdapter, TrackPayload } from "./base"

type FirebaseTracker = {
  logEvent: (eventName: string, properties?: Record<string, unknown>) => Promise<unknown> | unknown
  setUserId: (id: string) => Promise<unknown> | unknown
  setUserProperties: (properties: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface FirebaseAdapterConfig {
  instance: FirebaseTracker
  enabled?: boolean
}

export class FirebaseAdapter implements TrackerAdapter {
  private enabled: boolean
  private firebaseInstance: FirebaseTracker

  constructor(config: FirebaseAdapterConfig) {
    this.firebaseInstance = config.instance
    this.enabled = config.enabled ?? true
  }

  initialize(): void {
    // Firebase is initialized by the caller.
  }

  async track({ eventName, properties }: TrackPayload): Promise<void> {
    if (!this.isEnabled()) return

    try {
      await this.firebaseInstance.logEvent(eventName, properties)
    } catch (error) {
      console.error(`[Firebase] Failed to track event "${eventName}":`, error)
    }
  }

  async captureException({ error, properties }: CaptureExceptionPayload): Promise<void> {
    if (!this.isEnabled()) return

    try {
      await this.firebaseInstance.logEvent("exception", {
        description: error instanceof Error ? error.message : String(error),
        fatal: false,
        ...properties,
      })
    } catch (captureError) {
      console.error("[Firebase] Failed to capture exception:", captureError)
    }
  }

  async identify(payload: IdentifyPayload): Promise<void> {
    if (!this.isEnabled()) return

    try {
      await this.firebaseInstance.setUserId(payload.id)
      await this.firebaseInstance.setUserProperties({
        avatar: payload.image,
        email: payload.email,
        handle: payload.handle,
        name: payload.name,
      })
    } catch (error) {
      console.error("[Firebase] Failed to identify user:", error)
    }
  }

  async setUserProperties(properties: Record<string, unknown>): Promise<void> {
    if (!this.isEnabled()) return

    try {
      await this.firebaseInstance.setUserProperties(properties)
    } catch (error) {
      console.error("[Firebase] Failed to set user properties:", error)
    }
  }

  async clear(): Promise<void> {
    if (!this.isEnabled()) return

    try {
      await this.firebaseInstance.setUserId("")
      await this.firebaseInstance.setUserProperties({})
    } catch (error) {
      console.error("[Firebase] Failed to clear user data:", error)
    }
  }

  getName(): string {
    return "Firebase"
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }
}
