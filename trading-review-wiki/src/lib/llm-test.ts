import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat } from "./llm-client"
import { getProviderConfig } from "./llm-providers"

export interface LlmTestResult {
  ok: boolean
  latencyMs?: number
  status?: number
  error?: string
}

const TEST_TIMEOUT_MS = 15_000

export function previewProviderUrl(config: LlmConfig): string | null {
  try {
    if (config.provider === "custom" && !config.customEndpoint.trim()) return null
    if (config.provider === "ollama" && !config.ollamaUrl.trim()) return null
    return getProviderConfig(config).url
  } catch {
    return null
  }
}

export async function testLlmConnection(
  config: LlmConfig,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<LlmTestResult> {
  const start = performance.now()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  return new Promise((resolve) => {
    let firstTokenAt: number | null = null
    let settled = false

    const settle = (result: LlmTestResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      resolve(result)
    }

    streamChat(
      config,
      [{ role: "user", content: "hi" }],
      {
        onToken: () => {
          if (firstTokenAt === null) {
            firstTokenAt = performance.now()
            controller.abort()
          }
        },
        onDone: () => {
          if (firstTokenAt !== null) {
            settle({ ok: true, latencyMs: Math.round(firstTokenAt - start) })
          } else if (controller.signal.aborted && performance.now() - start >= timeoutMs - 100) {
            settle({ ok: false, error: `超时（>${timeoutMs / 1000}s 未响应）` })
          } else {
            settle({ ok: false, error: "服务返回空响应（可能是流式协议不匹配）" })
          }
        },
        onError: (err) => {
          const msg = err.message || String(err)
          const httpMatch = msg.match(/HTTP (\d+)/)
          settle({
            ok: false,
            status: httpMatch ? Number(httpMatch[1]) : undefined,
            error: msg,
          })
        },
      },
      controller.signal,
    )
  })
}
