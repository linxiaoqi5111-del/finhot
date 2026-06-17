import type {
  ByokProviderName,
  UserByokProviderConfig,
  UserByokSettings,
} from "@follow/shared/settings/interface"
import type { ConfigResponse } from "@follow-app/client-sdk"

export interface ByokProviderOption {
  value: ByokProviderName
  label: string
  defaultBaseURL: string
  defaultModel: string
  models: readonly string[]
  iconClassName: string
  apiFormat: "openai-compatible" | "anthropic"
  requiresApiKey: boolean
}

export const PROVIDER_ICON_CLASS_NAMES = {
  openai: "i-focal-openai",
  anthropic: "i-focal-anthropic",
  google: "i-focal-gemini",
  deepseek: "i-focal-deepseek",
  moonshot: "i-focal-moonshot",
  qwen: "i-focal-qwen",
  zhipu: "i-focal-zhipu",
  minimax: "i-focal-minimax",
  volcengine: "i-focal-volcengine",
  qianfan: "i-focal-paddle",
  stepfun: "i-focal-stepfun",
  ollama: "i-focal-ollama",
  "lm-studio": "i-focal-lmstudio",
  mistral: "i-focal-mistral",
  xai: "i-focal-xai",
  groq: "i-focal-groq",
  "vercel-ai-gateway": "i-focal-vercel",
  openrouter: "i-focal-openrouter",
  siliconflow: "i-focal-ai",
  custom: "i-focal-settings-3",
} satisfies Record<ByokProviderName, string>

export const PROVIDER_OPTIONS: ByokProviderOption[] = [
  {
    value: "openai",
    label: "OpenAI",
    defaultBaseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-5",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.openai,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "anthropic",
    label: "Anthropic",
    defaultBaseURL: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-3-5-haiku-latest"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.anthropic,
    apiFormat: "anthropic",
    requiresApiKey: true,
  },
  {
    value: "google",
    label: "Google Gemini",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-pro",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.google,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    defaultBaseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.deepseek,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "moonshot",
    label: "Moonshot",
    defaultBaseURL: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.5",
    models: ["kimi-k2.5", "kimi-k2", "moonshot-v1-128k"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.moonshot,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "qwen",
    label: "Qwen",
    defaultBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus-latest",
    models: ["qwen-max-latest", "qwen-plus-latest", "qwen-turbo-latest"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.qwen,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "zhipu",
    label: "Zhipu AI",
    defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.5",
    models: ["glm-4.5", "glm-4.5-air", "glm-4-flash"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.zhipu,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "minimax",
    label: "MiniMax",
    defaultBaseURL: "https://api.minimax.chat/v1",
    defaultModel: "MiniMax-M1",
    models: ["MiniMax-M1", "MiniMax-Text-01"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.minimax,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "volcengine",
    label: "Volcengine Ark",
    defaultBaseURL: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seed-1-6",
    models: ["doubao-seed-1-6", "doubao-seed-1-6-thinking", "deepseek-v3"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.volcengine,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "qianfan",
    label: "Baidu Qianfan",
    defaultBaseURL: "https://qianfan.baidubce.com/v2",
    defaultModel: "ernie-4.5-turbo-128k",
    models: ["ernie-4.5-turbo-128k", "ernie-x1-turbo-32k"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.qianfan,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "stepfun",
    label: "StepFun",
    defaultBaseURL: "https://api.stepfun.com/v1",
    defaultModel: "step-2-16k",
    models: ["step-2-16k", "step-1-8k"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.stepfun,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "ollama",
    label: "Ollama",
    defaultBaseURL: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
    models: ["llama3.2", "qwen2.5", "deepseek-r1"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.ollama,
    apiFormat: "openai-compatible",
    requiresApiKey: false,
  },
  {
    value: "lm-studio",
    label: "LM Studio",
    defaultBaseURL: "http://localhost:1234/v1",
    defaultModel: "local-model",
    models: ["local-model"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES["lm-studio"],
    apiFormat: "openai-compatible",
    requiresApiKey: false,
  },
  {
    value: "mistral",
    label: "Mistral AI",
    defaultBaseURL: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    models: ["mistral-large-latest", "mistral-small-latest"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.mistral,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "xai",
    label: "xAI",
    defaultBaseURL: "https://api.x.ai/v1",
    defaultModel: "grok-4",
    models: ["grok-4", "grok-3", "grok-3-mini"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.xai,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "groq",
    label: "Groq",
    defaultBaseURL: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.groq,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    defaultBaseURL: "https://ai-gateway.vercel.sh/v1",
    defaultModel: "openai/gpt-5",
    models: ["openai/gpt-5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES["vercel-ai-gateway"],
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    defaultBaseURL: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5",
    models: ["openai/gpt-5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.openrouter,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "siliconflow",
    label: "SiliconFlow (硅基流动)",
    defaultBaseURL: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    models: [
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen3-235B-A22B",
      "Qwen/Qwen3-32B",
      "meta-llama/Llama-4-Maverick-17B-128E-Instruct",
    ],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.siliconflow,
    apiFormat: "openai-compatible",
    requiresApiKey: true,
  },
  {
    value: "custom",
    label: "Custom (自定义)",
    defaultBaseURL: "",
    defaultModel: "",
    models: [],
    iconClassName: PROVIDER_ICON_CLASS_NAMES.custom,
    apiFormat: "openai-compatible",
    requiresApiKey: false,
  },
]

export const getProviderOption = (providerName: ByokProviderName) =>
  PROVIDER_OPTIONS.find((provider) => provider.value === providerName)

export const getProviderDefaultBaseURL = (providerName: ByokProviderName) =>
  getProviderOption(providerName)?.defaultBaseURL ?? ""

export const getProviderDefaultModel = (providerName: ByokProviderName) =>
  getProviderOption(providerName)?.defaultModel ?? ""

export const getProviderLabel = (providerName: ByokProviderName) =>
  getProviderOption(providerName)?.label ?? providerName

export const getProviderModelOptions = (providerName: ByokProviderName) =>
  getProviderOption(providerName)?.models ?? []

export const isOpenAICompatibleProvider = (providerName: ByokProviderName) =>
  getProviderOption(providerName)?.apiFormat === "openai-compatible"

// Some providers (e.g. certain Moonshot/Kimi models) only accept temperature=1.
// Using other values causes "invalid temperature: only 1 is allowed for this model".
const PROVIDERS_REQUIRING_TEMPERATURE_ONE = new Set<ByokProviderName>(["moonshot"])

export const getSafeTemperature = (providerName: ByokProviderName, preferred: number): number =>
  PROVIDERS_REQUIRING_TEMPERATURE_ONE.has(providerName) ? 1 : preferred

export const getConfiguredProviderModel = (provider: UserByokProviderConfig) =>
  provider.model || getProviderDefaultModel(provider.provider)

export const createByokModelValue = (providerName: ByokProviderName, model: string) =>
  `${providerName}/${model}`

export const parseByokModelValue = (value: string | null | undefined) => {
  if (!value) return null

  const separatorIndex = value.indexOf("/")
  if (separatorIndex <= 0) return null

  const providerName = value.slice(0, separatorIndex) as ByokProviderName
  const model = value.slice(separatorIndex + 1)

  if (!model || !getProviderOption(providerName)) return null

  return {
    providerName,
    model,
  }
}

export const getOpenAICompatibleConfiguredProviders = (byok: UserByokSettings | undefined) => {
  if (!byok?.enabled) return []

  return byok.providers.filter((provider) => {
    const providerOption = getProviderOption(provider.provider)
    // Check if API key is present and not empty (handle both null and empty string)
    const hasApiKey = !!provider.apiKey && provider.apiKey.trim() !== ""
    return (
      !!providerOption &&
      isOpenAICompatibleProvider(provider.provider) &&
      (!providerOption.requiresApiKey || hasApiKey)
    )
  })
}

export const resolveConfiguredByokProvider = (
  byok: UserByokSettings | undefined,
  selectedModel?: string | null | undefined,
) => {
  const configuredProviders = getOpenAICompatibleConfiguredProviders(byok)
  if (configuredProviders.length === 0) return null

  const parsedModel = parseByokModelValue(selectedModel)

  // Try to match the provider name from selectedModel if it looks like a byok value.
  // If no match (e.g. stale selectedModel after user switched the BYOK provider in settings),
  // fall back to the first currently configured provider. This makes provider switching robust
  // for background tasks (summary, quality score, etc.) that read the persisted selectedModel.
  let provider = parsedModel
    ? configuredProviders.find((item) => item.provider === parsedModel.providerName)
    : null

  if (!provider) {
    provider = configuredProviders[0]
  }

  if (!provider) return null

  return {
    provider,
    providerLabel: getProviderLabel(provider.provider),
    baseURL: provider.baseURL || getProviderDefaultBaseURL(provider.provider),
    apiKey: provider.apiKey,
    model:
      parsedModel && provider.provider === parsedModel.providerName
        ? parsedModel.model
        : getConfiguredProviderModel(provider),
  }
}

export const buildLocalByokAIConfiguration = (byok: UserByokSettings | undefined) => {
  const configuredProviders = getOpenAICompatibleConfiguredProviders(byok)
  const availableModels = configuredProviders
    .map((provider) => {
      const model = getConfiguredProviderModel(provider)
      return model ? createByokModelValue(provider.provider, model) : null
    })
    .filter((model): model is string => !!model)

  const availableModelsMenu: ConfigResponse["availableModelsMenu"] = configuredProviders.flatMap(
    (provider) => {
      const model = getConfiguredProviderModel(provider)
      if (!model) return []

      return [
        {
          label: getProviderLabel(provider.provider),
          value: "",
        },
        {
          label: model,
          value: createByokModelValue(provider.provider, model),
        },
      ]
    },
  )

  return {
    defaultModel: availableModels[0] ?? "",
    availableModels,
    availableModelsMenu,
    usage: {
      used: 0,
      total: 0,
      remaining: Number.MAX_SAFE_INTEGER,
      resetAt: new Date(8640000000000000),
    },
    rateLimit: {
      maxTokens: Number.MAX_SAFE_INTEGER,
      currentTokens: 0,
      remainingTokens: Number.MAX_SAFE_INTEGER,
      windowDuration: Number.MAX_SAFE_INTEGER,
      windowResetTime: 8640000000000000,
      warningLevel: "safe",
      projectedLimitTime: null,
      usageRate: 0,
    },
    attachmentLimits: {
      maxFiles: 0,
      remainingFiles: 0,
      windowDuration: Number.MAX_SAFE_INTEGER,
      windowResetTime: 8640000000000000,
    },
    freeQuota: {
      shouldCheckDailyLimit: false,
      remainingRequests: Number.MAX_SAFE_INTEGER,
      remainingMonthlyRequests: Number.MAX_SAFE_INTEGER,
      role: "local",
      dailyLimit: Number.MAX_SAFE_INTEGER,
      monthlyLimit: Number.MAX_SAFE_INTEGER,
    },
  } satisfies ConfigResponse
}
