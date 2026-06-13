/**
 * Retry helper for transient network-class failures.
 * Aborted errors and HTTP 4xx/5xx are NOT retried.
 */

const TRANSIENT_PATTERNS = [
  /network error/i,
  /load failed/i,
  /connection lost/i,
  /timed out/i,
  /timeout/i,
  /failed to fetch/i,
  /networkerror/i,
  /econnreset/i,
  /socket hang up/i,
]

export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "AbortError") return false
  // HTTP errors: only retry 5xx and 429
  const httpMatch = err.message.match(/HTTP (\d{3})/)
  if (httpMatch) {
    const code = Number(httpMatch[1])
    return code === 429 || (code >= 500 && code < 600)
  }
  return TRANSIENT_PATTERNS.some((p) => p.test(err.message))
}

export interface RetryOptions {
  maxAttempts?: number
  backoffMs?: number[]
  signal?: AbortSignal
  onRetry?: (err: Error, attempt: number, nextDelayMs: number) => void
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const backoffMs = options.backoffMs ?? [3000, 8000]
  let lastErr: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      const err = new Error("Aborted")
      err.name = "AbortError"
      throw err
    }
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt >= maxAttempts || !isTransientError(err)) throw err
      const delay = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]
      options.onRetry?.(err as Error, attempt, delay)
      await sleepCancellable(delay, options.signal)
    }
  }
  throw lastErr
}

function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("Aborted")
      err.name = "AbortError"
      reject(err)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      const err = new Error("Aborted")
      err.name = "AbortError"
      reject(err)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
