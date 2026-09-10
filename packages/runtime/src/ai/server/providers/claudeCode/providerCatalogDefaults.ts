// [ASTRA-ORCH]
export const CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_MODEL = 'claude-code:ollama-glm-5-2-cloud' as const;
export const CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_VARIANT = 'ollama-glm-5-2-cloud' as const;
export const CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_SDK_ALIAS = 'claude-sonnet-4-5-20250929' as const;
export const CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_MODEL = 'claude-code:ollama-gpt-oss-20b-cloud' as const;
export const CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_VARIANT = 'ollama-gpt-oss-20b-cloud' as const;
export const CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_SDK_ALIAS = 'claude-ollama-gpt-oss-20b' as const;
export const CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_MODEL = 'claude-code:ollama-nemotron-3-nano-cloud' as const;
export const CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_VARIANT = 'ollama-nemotron-3-nano-cloud' as const;
export const CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_SDK_ALIAS = 'claude-ollama-nemotron-3-nano' as const;
export const CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_MODEL = 'claude-code:ollama-deepseek-v4-flash-cloud' as const;
export const CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_VARIANT = 'ollama-deepseek-v4-flash-cloud' as const;
export const CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_SDK_ALIAS = 'claude-ollama-deepseek-v4-flash' as const;
export const CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_MODEL = 'claude-code:ollama-qwen3-5-cloud' as const;
export const CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_VARIANT = 'ollama-qwen3-5-cloud' as const;
export const CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_SDK_ALIAS = 'claude-ollama-qwen3-5' as const;
export const CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_MODEL = 'claude-code:ollama-nemotron-3-super-cloud' as const;
export const CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_VARIANT = 'ollama-nemotron-3-super-cloud' as const;
export const CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_SDK_ALIAS = 'claude-ollama-nemotron-3-super' as const;
export const CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_MODEL = 'claude-code:ollama-glm-5-1-cloud' as const;
export const CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_VARIANT = 'ollama-glm-5-1-cloud' as const;
export const CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_SDK_ALIAS = 'claude-ollama-glm-5-1' as const;
export const CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_MODEL = 'claude-code:ollama-minimax-m2-7-cloud' as const;
export const CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_VARIANT = 'ollama-minimax-m2-7-cloud' as const;
export const CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_SDK_ALIAS = 'claude-ollama-minimax-m2-7' as const;
export const CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_MODEL = 'claude-code:ollama-kimi-k2-6-cloud' as const;
export const CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_VARIANT = 'ollama-kimi-k2-6-cloud' as const;
export const CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_SDK_ALIAS = 'claude-ollama-kimi-k2-6' as const;
export const CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_MODEL = 'claude-code:ollama-kimi-k2-7-code-cloud' as const;
export const CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_VARIANT = 'ollama-kimi-k2-7-code-cloud' as const;
export const CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_SDK_ALIAS = 'claude-ollama-kimi-k2-7-code' as const;
export const CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_MODEL = 'claude-code:ollama-minimax-m3-cloud' as const;
export const CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_VARIANT = 'ollama-minimax-m3-cloud' as const;
export const CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_SDK_ALIAS = 'claude-ollama-minimax-m3' as const;
export const CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL = 'claude-code:ollama-deepseek-v4-pro-cloud' as const;
export const CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT = 'ollama-deepseek-v4-pro-cloud' as const;
export const CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_SDK_ALIAS = 'claude-ollama-deepseek-v4-pro' as const;

export const CLAUDE_CODE_OLLAMA_BACKEND_IDENTITIES = [
  {
    persistedModel: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_SDK_ALIAS,
  },
  {
    persistedModel: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL,
    variant: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT,
    sdkAlias: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_SDK_ALIAS,
  },
] as const;

import {
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES,
  type ProviderCatalogEntry,
} from "./providerCatalog";

/**
 * Ollama Cloud speaks Anthropic Messages natively at `/v1/messages`, so the
 * Claude harness reaches it directly and the LiteLLM translation proxy that
 * used to sit at 127.0.0.1:4002 is gone. The base URL carries no `/v1`: the
 * harness appends `/v1/messages` itself.
 *
 * Auth is `Authorization: Bearer` — the endpoint returns 401 for `x-api-key`
 * (ollama/ollama#16922), which is why this route resolves a credential
 * reference rather than reusing an Anthropic-style key header.
 */
const OLLAMA_ENDPOINT = "https://ollama.com";
export const LOCAL_PROXY_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[0];
export const CLAUDEX_INGRESS_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[1];
export const DEEPSEEK_API_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[2];
export const OPENROUTER_API_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[3];
export const OLLAMA_API_CREDENTIAL_REF =
  REVIEWED_PROVIDER_CREDENTIAL_REFERENCES[4];

export const CLAUDEX_SOL_ENTRY_ID = "claudex-sol";
export const CLAUDEX_TERRA_ENTRY_ID = "claudex-terra";
export const CLAUDEX_LUNA_ENTRY_ID = "claudex-luna";
export const DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID = "deepseek-v4-pro-official";
export const DEEPSEEK_V4_FLASH_OFFICIAL_ENTRY_ID = "deepseek-v4-flash-official";
export const DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID = "deepseek-v4-pro-openrouter";
export const DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID =
  "deepseek-v4-flash-openrouter";

const FAMILY_ORDER: Readonly<Record<string, number>> = {
  native: 10,
  deepseek: 20,
  qwen: 30,
  kimi: 40,
  glm: 50,
  minimax: 60,
  codex: 70,
  grok: 80,
  gpt: 90,
  nemotron: 100,
};

function createOllamaCatalogEntry(options: {
  id: string;
  persistedId: string;
  providerModelId: string;
  family: string;
}): ProviderCatalogEntry {
  return {
    id: options.id,
    provider: "ollama",
    harness: { id: "claude-agent", order: 10 },
    family: {
      id: options.family,
      order: FAMILY_ORDER[options.family] ?? 1_000,
    },
    displayName: options.providerModelId,
    model: {
      persistedId: options.persistedId,
      persistedIdNamespace: "claude-code:ollama-",
      providerModelId: options.providerModelId,
      version: options.providerModelId,
    },
    capabilities: {
      mainSession: true,
      subagent: true,
      consultation: true,
      tools: true,
      vision: false,
    },
    interfaces: [
      {
        id: "claude-agent-anthropic",
        kind: "http",
        consumers: [
          "claude-agent-main",
          "claude-agent-subagent",
          "consultation",
        ],
        protocol: "anthropic-messages",
        transportProfile: "anthropic-compatible-proxy",
        authProfile: "credential-reference",
        endpoint: OLLAMA_ENDPOINT,
        credentialRef: OLLAMA_API_CREDENTIAL_REF,
        // Direct route: the exact Ollama model id goes on the wire. The old
        // Claude-shaped alias only existed so LiteLLM could translate it.
        modelAlias: options.providerModelId,
      },
    ],
    controls: createThinkingToggleControl("claude-agent-anthropic"),
  };
}

function createReviewedRouteEntry(options: {
  id: string;
  provider: "deepseek" | "openai" | "openrouter";
  persistedId: string;
  persistedIdNamespace:
    | "claude-code:claudex-"
    | "claude-code:deepseek-"
    | "claude-code:openrouter-";
  providerModelId: string;
  modelAlias: string;
  endpoint: string;
  credentialRef: string;
  controls?: ProviderCatalogEntry["controls"];
}): ProviderCatalogEntry {
  return {
    id: options.id,
    provider: options.provider,
    harness: { id: "claude-agent", order: 10 },
    family: {
      id: options.provider === "openai" ? "codex" : "deepseek",
      order: options.provider === "openai" ? 70 : 20,
    },
    displayName: options.providerModelId,
    model: {
      persistedId: options.persistedId,
      persistedIdNamespace: options.persistedIdNamespace,
      providerModelId: options.providerModelId,
      version: options.providerModelId,
    },
    capabilities: {
      mainSession: true,
      subagent: true,
      consultation: true,
      tools: true,
      vision: false,
    },
    interfaces: [
      {
        id: "claude-agent-anthropic",
        kind: "http",
        consumers: [
          "claude-agent-main",
          "claude-agent-subagent",
          "consultation",
        ],
        protocol: "anthropic-messages",
        transportProfile: "anthropic-compatible-proxy",
        authProfile: "credential-reference",
        endpoint: options.endpoint,
        credentialRef: options.credentialRef,
        modelAlias: options.modelAlias,
      },
    ],
    controls: options.controls ?? {},
  };
}

function createEffortControl(
  interfaceId: string
): ProviderCatalogEntry["controls"] {
  return {
    effort: {
      persistenceKey: "effort-level",
      allowedValues: ["high", "max"],
      defaultValue: "high",
      mappings: [
        {
          interfaceId,
          target: "launch.effort-level",
          values: [
            { storedValue: "high", resolvedValue: "high" },
            { storedValue: "max", resolvedValue: "max" },
          ],
        },
      ],
    },
  };
}

/**
 * One selector, four values, for routes whose provider exposes a graded
 * reasoning effort: DeepSeek official and OpenRouter.
 *
 * "Off" is a value of the same selector rather than a second toggle, because
 * every provider here expresses off as an effort state — OpenRouter documents
 * `effort:"none"` as equivalent to `enabled:false`, and DeepSeek uses
 * `thinking.type:disabled`. A separate on/off toggle would be redundant with it
 * and could contradict it.
 *
 * Both mappings always resolve, so the receipt records the full intent:
 *  - `launch.thinking-mode` carries off vs on, and is the parameter that
 *    actually silences reasoning (verified on the wire against both providers).
 *  - `launch.effort-level` carries the graded level. At "off" it resolves to the
 *    cheapest level because thinking is disabled and the level is then moot;
 *    sending both was measured as a clean 200 on OpenRouter, not the 400 that
 *    first-party Anthropic returns for effort=max with thinking disabled.
 */
function createReasoningEffortControl(
  interfaceId: string
): ProviderCatalogEntry["controls"] {
  return {
    effort: {
      persistenceKey: "effort-level",
      allowedValues: ["off", "low", "high", "max"],
      defaultValue: "high",
      mappings: [
        {
          interfaceId,
          target: "launch.effort-level",
          values: [
            { storedValue: "off", resolvedValue: "low" },
            { storedValue: "low", resolvedValue: "low" },
            { storedValue: "high", resolvedValue: "high" },
            { storedValue: "max", resolvedValue: "max" },
          ],
        },
        {
          interfaceId,
          target: "launch.thinking-mode",
          values: [
            { storedValue: "off", resolvedValue: "disabled" },
            { storedValue: "low", resolvedValue: "adaptive" },
            { storedValue: "high", resolvedValue: "adaptive" },
            { storedValue: "max", resolvedValue: "adaptive" },
          ],
        },
      ],
    },
  };
}

/**
 * Ollama Cloud gets on/off only, deliberately.
 *
 * Measured 2026-08-14 on `deepseek-v4-flash:cloud`: `think:"low"` and
 * `think:"max"` produce reasoning lengths inside one noise band (medians 260 vs
 * 240 over 3 runs each), and the Anthropic-shaped endpoint documents
 * `budget_tokens` as "accepted but not enforced". Only `disabled` is a
 * categorical change. A graded picker here would be theatre.
 */
function createThinkingToggleControl(
  interfaceId: string
): ProviderCatalogEntry["controls"] {
  return {
    thinking: {
      persistenceKey: "thinking-mode",
      allowedValues: ["enabled", "disabled"],
      defaultValue: "enabled",
      mappings: [
        {
          interfaceId,
          target: "launch.thinking-mode",
          values: [
            { storedValue: "enabled", resolvedValue: "adaptive" },
            { storedValue: "disabled", resolvedValue: "disabled" },
          ],
        },
      ],
    },
  };
}

export const BUILT_IN_PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_MODEL,
    providerModelId: "glm-5.2:cloud",
    family: "glm",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_MODEL,
    providerModelId: "gpt-oss:20b-cloud",
    family: "gpt",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_MODEL,
    providerModelId: "nemotron-3-nano:30b-cloud",
    family: "nemotron",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_MODEL,
    providerModelId: "deepseek-v4-flash:cloud",
    family: "deepseek",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_MODEL,
    providerModelId: "qwen3.5:cloud",
    family: "qwen",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_MODEL,
    providerModelId: "nemotron-3-super:cloud",
    family: "nemotron",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_MODEL,
    providerModelId: "glm-5.1:cloud",
    family: "glm",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_MODEL,
    providerModelId: "minimax-m2.7:cloud",
    family: "minimax",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_MODEL,
    providerModelId: "kimi-k2.6:cloud",
    family: "kimi",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_MODEL,
    providerModelId: "kimi-k2.7-code:cloud",
    family: "kimi",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_MODEL,
    providerModelId: "minimax-m3:cloud",
    family: "minimax",
  }),
  createOllamaCatalogEntry({
    id: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT,
    persistedId: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL,
    providerModelId: "deepseek-v4-pro:cloud",
    family: "deepseek",
  }),
  createReviewedRouteEntry({
    id: CLAUDEX_SOL_ENTRY_ID,
    provider: "openai",
    persistedId: "claude-code:claudex-sol",
    persistedIdNamespace: "claude-code:claudex-",
    providerModelId: "gpt-5.6-sol",
    modelAlias: "gpt-5.6-sol",
    endpoint: "http://127.0.0.1:38117",
    credentialRef: CLAUDEX_INGRESS_CREDENTIAL_REF,
    controls: createEffortControl("claude-agent-anthropic"),
  }),
  createReviewedRouteEntry({
    id: CLAUDEX_TERRA_ENTRY_ID,
    provider: "openai",
    persistedId: "claude-code:claudex-terra",
    persistedIdNamespace: "claude-code:claudex-",
    providerModelId: "gpt-5.6-terra",
    modelAlias: "gpt-5.6-terra",
    endpoint: "http://127.0.0.1:38117",
    credentialRef: CLAUDEX_INGRESS_CREDENTIAL_REF,
    controls: createEffortControl("claude-agent-anthropic"),
  }),
  createReviewedRouteEntry({
    id: CLAUDEX_LUNA_ENTRY_ID,
    provider: "openai",
    persistedId: "claude-code:claudex-luna",
    persistedIdNamespace: "claude-code:claudex-",
    providerModelId: "gpt-5.6-luna",
    modelAlias: "gpt-5.6-luna",
    endpoint: "http://127.0.0.1:38117",
    credentialRef: CLAUDEX_INGRESS_CREDENTIAL_REF,
    controls: createEffortControl("claude-agent-anthropic"),
  }),
  createReviewedRouteEntry({
    id: DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID,
    provider: "deepseek",
    persistedId: "claude-code:deepseek-v4-pro",
    persistedIdNamespace: "claude-code:deepseek-",
    providerModelId: "deepseek-v4-pro",
    modelAlias: "deepseek-v4-pro[1m]",
    endpoint: "https://api.deepseek.com/anthropic",
    credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
    controls: createReasoningEffortControl("claude-agent-anthropic"),
  }),
  createReviewedRouteEntry({
    id: DEEPSEEK_V4_FLASH_OFFICIAL_ENTRY_ID,
    provider: "deepseek",
    persistedId: "claude-code:deepseek-v4-flash",
    persistedIdNamespace: "claude-code:deepseek-",
    providerModelId: "deepseek-v4-flash",
    modelAlias: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com/anthropic",
    credentialRef: DEEPSEEK_API_CREDENTIAL_REF,
    controls: createReasoningEffortControl("claude-agent-anthropic"),
  }),
  createReviewedRouteEntry({
    id: DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID,
    provider: "openrouter",
    persistedId: "claude-code:openrouter-deepseek-v4-pro",
    persistedIdNamespace: "claude-code:openrouter-",
    providerModelId: "deepseek/deepseek-v4-pro-0813",
    modelAlias: "deepseek/deepseek-v4-pro-0813",
    endpoint: "https://openrouter.ai/api",
    credentialRef: OPENROUTER_API_CREDENTIAL_REF,
    controls: createReasoningEffortControl("claude-agent-anthropic"),
  }),
  createReviewedRouteEntry({
    id: DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID,
    provider: "openrouter",
    persistedId: "claude-code:openrouter-deepseek-v4-flash",
    persistedIdNamespace: "claude-code:openrouter-",
    providerModelId: "deepseek/deepseek-v4-flash-0731",
    modelAlias: "deepseek/deepseek-v4-flash-0731",
    endpoint: "https://openrouter.ai/api",
    credentialRef: OPENROUTER_API_CREDENTIAL_REF,
    controls: createReasoningEffortControl("claude-agent-anthropic"),
  }),
];
