/**
 * Per-session non-Anthropic brain profiles for the Claude Code harness.
 *
 * These profiles only configure the environment of the native Claude Code
 * process spawned for one Nimbalyst session. They never mutate process.env or
 * provider settings, and an unknown persisted profile is an error rather than
 * a request to use the default Anthropic route.
 *
 * Backend list is JSON-driven (2026-07-30, Yogev-directed): the list below is
 * a fallback seed baked into the app so it never breaks if the external file
 * is missing or malformed. On every load, an optional user-editable override
 * at userData/ollama-backends.json is preferred if present and valid -- this
 * is what lets a new Ollama model be added, changed, or removed without a
 * Nimbalyst code change or rebuild. No secret ever lives in this file: every
 * entry's authToken is the same fixed, non-secret local-proxy placeholder
 * that tools/Ollala/nimbalyst-brainswap/litellm-ollama.yaml also expects --
 * the real OLLAMA_API_KEY stays in .env, read only by the LiteLLM proxy
 * process, never by Nimbalyst.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CLAUDE_CODE_CODEX_SOL_MODEL,
  CLAUDE_CODE_CODEX_SOL_SDK_ALIAS,
  CLAUDE_CODE_CODEX_SOL_VARIANT,
  CLAUDE_CODE_CODEX_TERRA_MODEL,
  CLAUDE_CODE_CODEX_TERRA_SDK_ALIAS,
  CLAUDE_CODE_CODEX_TERRA_VARIANT,
  CLAUDE_CODE_CODEX_LUNA_MODEL,
  CLAUDE_CODE_CODEX_LUNA_SDK_ALIAS,
  CLAUDE_CODE_CODEX_LUNA_VARIANT,
  CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_VARIANT,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_SDK_ALIAS,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT,
} from '../../../modelConstants';

export const OLLAMA_GLM_5_2_CLOUD_BACKEND_ID =
  CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_VARIANT;

export interface ClaudeCodeBackend {
  id: string;
  persistedModel: string;
  provider: 'ollama' | 'codex-proxy';
  model: string;
  upstreamModel: string;
  upstreamBaseUrl: string;
  baseUrl: string;
  /**
   * Non-secret local proxy token. For 'ollama' this mirrors the existing
   * LiteLLM config; for 'codex-proxy' it is CLIProxyAPI's own configured
   * ingress api-key (also non-secret -- the real credential is the Codex
   * OAuth record CLIProxyAPI holds server-side, never this token).
   */
  authToken: string;
  /**
   * The model identity Claude Code is told to request.
   * - 'ollama': a Claude-shaped alias accepted by the LiteLLM profile, which
   *   translates it to `model` at the Ollama Cloud OpenAI endpoint.
   * - 'codex-proxy': the literal Codex catalog model id (e.g. `gpt-5.6-terra`)
   *   -- CLIProxyAPI accepts it directly, so this collapses to the same value
   *   as `model`/`upstreamModel` for these entries. See modelConstants.ts.
   */
  claudeModelAlias: string;
  /** Display label for the model dropdown, e.g. "Terra". Falls back to `id`. */
  label?: string;
}

const SEED_BACKENDS: readonly ClaudeCodeBackend[] = [
  {
    id: OLLAMA_GLM_5_2_CLOUD_BACKEND_ID,
    persistedModel: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_MODEL,
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    upstreamModel: 'openai/glm-5.2:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_GLM_5_2_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_MODEL,
    provider: 'ollama',
    model: 'gpt-oss:20b-cloud',
    upstreamModel: 'openai/gpt-oss:20b-cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_GPT_OSS_20B_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_MODEL,
    provider: 'ollama',
    model: 'nemotron-3-nano:30b-cloud',
    upstreamModel: 'openai/nemotron-3-nano:30b-cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_NEMOTRON_3_NANO_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_MODEL,
    provider: 'ollama',
    model: 'deepseek-v4-flash:cloud',
    upstreamModel: 'openai/deepseek-v4-flash:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_FLASH_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_MODEL,
    provider: 'ollama',
    model: 'qwen3.5:cloud',
    upstreamModel: 'openai/qwen3.5:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_QWEN3_5_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_MODEL,
    provider: 'ollama',
    model: 'nemotron-3-super:cloud',
    upstreamModel: 'openai/nemotron-3-super:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_NEMOTRON_3_SUPER_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_MODEL,
    provider: 'ollama',
    model: 'glm-5.1:cloud',
    upstreamModel: 'openai/glm-5.1:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_GLM_5_1_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_MODEL,
    provider: 'ollama',
    model: 'minimax-m2.7:cloud',
    upstreamModel: 'openai/minimax-m2.7:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_MINIMAX_M2_7_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_MODEL,
    provider: 'ollama',
    model: 'kimi-k2.6:cloud',
    upstreamModel: 'openai/kimi-k2.6:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_KIMI_K2_6_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_MODEL,
    provider: 'ollama',
    model: 'kimi-k2.7-code:cloud',
    upstreamModel: 'openai/kimi-k2.7-code:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_KIMI_K2_7_CODE_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_MODEL,
    provider: 'ollama',
    model: 'minimax-m3:cloud',
    upstreamModel: 'openai/minimax-m3:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_MINIMAX_M3_CLOUD_SDK_ALIAS,
  },
  {
    id: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT,
    persistedModel: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL,
    provider: 'ollama',
    model: 'deepseek-v4-pro:cloud',
    upstreamModel: 'openai/deepseek-v4-pro:cloud',
    upstreamBaseUrl: 'https://ollama.com/v1',
    baseUrl: 'http://127.0.0.1:4002',
    authToken: 'sk-nim-local-proxy',
    claudeModelAlias: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_SDK_ALIAS,
  },
];

/**
 * Codex ChatGPT-subscription backends via a dedicated, Nimbalyst-managed
 * CLIProxyAPI instance (router-for-me/CLIProxyAPI v7.2.86 -- the same
 * pinned/hashed binary already live-evaluated for the standalone terminal
 * pilot at tools/claudex/, see knowledge/methods/
 * claudex_codex_subscription_brain.md and DECISION_BRIEF.md's 2026-08-01
 * supersession note). Port 38118 is deliberately distinct from that terminal
 * pilot's own pinned port (38117) so a developer's personal `claudex` session
 * and an in-app Nimbalyst session never collide on the same loopback listener
 * -- same reasoning as the Ollama leg never sharing a port with a user's own
 * proxy. `upstreamModel`/`upstreamBaseUrl` are not meaningful for this
 * provider (CLIProxyAPI owns the Codex-side routing entirely) and are set to
 * the literal model id / this backend's own baseUrl for schema uniformity.
 */
const CODEX_PROXY_BASE_URL = 'http://127.0.0.1:38118';
const CODEX_PROXY_AUTH_TOKEN = 'sk-nim-codex-proxy';

const CODEX_SEED_BACKENDS: readonly ClaudeCodeBackend[] = [
  {
    id: CLAUDE_CODE_CODEX_SOL_VARIANT,
    persistedModel: CLAUDE_CODE_CODEX_SOL_MODEL,
    provider: 'codex-proxy',
    model: CLAUDE_CODE_CODEX_SOL_SDK_ALIAS,
    upstreamModel: CLAUDE_CODE_CODEX_SOL_SDK_ALIAS,
    upstreamBaseUrl: CODEX_PROXY_BASE_URL,
    baseUrl: CODEX_PROXY_BASE_URL,
    authToken: CODEX_PROXY_AUTH_TOKEN,
    claudeModelAlias: CLAUDE_CODE_CODEX_SOL_SDK_ALIAS,
    label: 'Sol',
  },
  {
    id: CLAUDE_CODE_CODEX_TERRA_VARIANT,
    persistedModel: CLAUDE_CODE_CODEX_TERRA_MODEL,
    provider: 'codex-proxy',
    model: CLAUDE_CODE_CODEX_TERRA_SDK_ALIAS,
    upstreamModel: CLAUDE_CODE_CODEX_TERRA_SDK_ALIAS,
    upstreamBaseUrl: CODEX_PROXY_BASE_URL,
    baseUrl: CODEX_PROXY_BASE_URL,
    authToken: CODEX_PROXY_AUTH_TOKEN,
    claudeModelAlias: CLAUDE_CODE_CODEX_TERRA_SDK_ALIAS,
    label: 'Terra',
  },
  {
    id: CLAUDE_CODE_CODEX_LUNA_VARIANT,
    persistedModel: CLAUDE_CODE_CODEX_LUNA_MODEL,
    provider: 'codex-proxy',
    model: CLAUDE_CODE_CODEX_LUNA_SDK_ALIAS,
    upstreamModel: CLAUDE_CODE_CODEX_LUNA_SDK_ALIAS,
    upstreamBaseUrl: CODEX_PROXY_BASE_URL,
    baseUrl: CODEX_PROXY_BASE_URL,
    authToken: CODEX_PROXY_AUTH_TOKEN,
    claudeModelAlias: CLAUDE_CODE_CODEX_LUNA_SDK_ALIAS,
    label: 'Luna',
  },
];

function isValidBackend(candidate: unknown): candidate is ClaudeCodeBackend {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const c = candidate as Record<string, unknown>;
  return (
    typeof c.id === 'string' && c.id.length > 0 &&
    typeof c.persistedModel === 'string' && c.persistedModel.length > 0 &&
    (c.provider === 'ollama' || c.provider === 'codex-proxy') &&
    typeof c.model === 'string' && c.model.length > 0 &&
    typeof c.upstreamModel === 'string' && c.upstreamModel.length > 0 &&
    typeof c.upstreamBaseUrl === 'string' && c.upstreamBaseUrl.length > 0 &&
    typeof c.baseUrl === 'string' && c.baseUrl.length > 0 &&
    typeof c.authToken === 'string' && c.authToken.length > 0 &&
    typeof c.claudeModelAlias === 'string' && c.claudeModelAlias.length > 0 &&
    (c.label === undefined || (typeof c.label === 'string' && c.label.length > 0))
  );
}

/**
 * Every backend Nimbalyst ships out of the box, across every provider family.
 * `ALL_SEED_BACKENDS` is what actually seeds/falls back the effective list;
 * `SEED_BACKENDS` (Ollama-only) stays exported for existing call sites and
 * tests that specifically exercise the Ollama fleet.
 */
const ALL_SEED_BACKENDS: readonly ClaudeCodeBackend[] = [
  ...SEED_BACKENDS,
  ...CODEX_SEED_BACKENDS,
];

/**
 * userData/ollama-backends.json -- same directory electron-store already
 * resolves ai-settings.json into (verified: %APPDATA%/@nimbalyst/electron on
 * Windows). Resolved via process.env.APPDATA directly rather than Electron's
 * app.getPath('userData') so this module stays a plain, Electron-free data
 * module -- it is unit-tested with plain vitest today and must stay that way.
 *
 * The filename predates the Codex leg and is kept for backward compatibility
 * (an existing install's override file already lives here); despite the
 * name, it now holds every custom backend family, not just Ollama. KNOWN
 * GAP: bootstrapOverrideFile() below only writes once, on first run when the
 * file is absent -- an install that already has this file from before the
 * Codex leg shipped will NOT automatically gain the new Codex rows; the user
 * (or a future migration) must add them to the existing file by hand. Not
 * addressed here; flagged in the PR's acceptance note rather than silently
 * left implicit.
 */
function getOverrideFilePath(): string | undefined {
  const appData = process.env.APPDATA;
  if (!appData) return undefined;
  return path.join(appData, '@nimbalyst', 'electron', 'ollama-backends.json');
}

function loadOverrideBackends(): readonly ClaudeCodeBackend[] | undefined {
  const filePath = getOverrideFilePath();
  if (!filePath) return undefined;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.warn(`[customBackends] ${filePath} is not a non-empty array; using seed backends.`);
      return undefined;
    }
    if (!parsed.every(isValidBackend)) {
      console.warn(`[customBackends] ${filePath} has an entry missing a required field; using seed backends.`);
      return undefined;
    }
    return parsed as ClaudeCodeBackend[];
  } catch (err) {
    // ENOENT (file doesn't exist yet) is the expected first-run case, handled
    // silently by the bootstrap step below. Anything else is worth a warning.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[customBackends] Failed to read ${filePath}: ${(err as Error).message}. Using seed backends.`);
    }
    return undefined;
  }
}

/** Best-effort: seed the override file on first run so it exists as an editable file. Never throws. */
function bootstrapOverrideFile(): void {
  const filePath = getOverrideFilePath();
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(ALL_SEED_BACKENDS, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal: read-only environment, missing permissions, etc. The app
    // still works off the in-memory seed either way.
  }
}

const loadedOverride = loadOverrideBackends();
if (!loadedOverride) {
  bootstrapOverrideFile();
}

/**
 * The effective backend list for this process. Prefers a valid userData
 * override; falls back to the baked-in seed. Adding, removing, or changing a
 * model going forward means editing the override JSON file directly -- no
 * Nimbalyst code change or rebuild required. See the module doc comment.
 */
export const CLAUDE_CODE_BACKENDS: readonly ClaudeCodeBackend[] = loadedOverride ?? ALL_SEED_BACKENDS;

/**
 * Resolve a persisted backend id.
 *
 * Missing means a normal Anthropic Claude Code session. A present-but-unknown
 * id fails closed so stale or mistyped Ollama sessions cannot silently run on
 * Anthropic.
 */
export function resolveClaudeCodeBackend(
  backendId: string | undefined | null
): ClaudeCodeBackend | undefined {
  if (!backendId) {
    return undefined;
  }

  const backend = CLAUDE_CODE_BACKENDS.find((candidate) => candidate.id === backendId);
  if (!backend) {
    throw new Error(`Unsupported Claude Code backend profile: ${backendId}`);
  }
  return backend;
}

/**
 * Resolve from the canonical persisted model identity. Any lookalike Ollama
 * identity is rejected rather than treated as an ordinary Anthropic model.
 */
export function resolveClaudeCodeBackendFromModel(
  model: string | undefined | null
): ClaudeCodeBackend | undefined {
  if (!model) {
    return undefined;
  }
  const backend = CLAUDE_CODE_BACKENDS.find(
    (candidate) => candidate.persistedModel === model
  );
  if (backend) {
    return backend;
  }
  if (model.startsWith('claude-code:ollama-') || model.startsWith('claude-code:codex-')) {
    throw new Error(`Unsupported Claude Code custom backend model identity: ${model}`);
  }
  return undefined;
}

export function resolveClaudeCodeBackendForConfig(config: {
  model?: string;
  claudeCodeBackend?: string;
}): ClaudeCodeBackend | undefined {
  const modelBackend = resolveClaudeCodeBackendFromModel(config.model);
  const configuredBackend = resolveClaudeCodeBackend(config.claudeCodeBackend);
  if (modelBackend && configuredBackend && modelBackend.id !== configuredBackend.id) {
    throw new Error(
      `Claude Code backend ${configuredBackend.id} does not match persisted model ${config.model}`
    );
  }
  if (configuredBackend && config.model !== configuredBackend.persistedModel) {
    throw new Error(
      `Claude Code backend ${configuredBackend.id} requires exact persisted model ${configuredBackend.persistedModel}`
    );
  }
  return modelBackend ?? configuredBackend;
}

/**
 * Route selectors and provider-specific credentials read by the pinned
 * @anthropic-ai/claude-agent-sdk 0.3.220 native CLI. These are deleted only
 * from the per-spawn environment; process.env is never mutated.
 */
export const CLAUDE_CODE_AMBIENT_ROUTE_ENV_KEYS = [
  // Alternate sockets, gateways, relays, and generic HTTP proxying.
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_API_BASE_URL',
  'AGENT_PROXY_URL',
  'AGENT_PROXY_AUTH_TOKEN',
  'CCR_AGENT_PROXY_ENABLED',
  'CCR_AGENT_PROXY_INCLUDE_HOSTS',
  'CCR_AGENT_PROXY_RELAY_MODE',
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
  'CLAUDE_CODE_SIMULATE_PROXY_USAGE',
  'CLAUDE_CODE_AGENT_PROXY_GIT_CONFIG',
  'CLAUDE_CODE_AGENT_PROXY_GH_SHIM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',

  // Provider selectors and provider-specific credentials.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_GOOGLE_CLOUD_LOCATION',
  'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
  'ANTHROPIC_BEDROCK_SERVICE_TIER',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLOUD_ML_REGION',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'CLAUDE_CODE_ARTIFACTS_API_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_QUOTA_PROJECT',

  // OAuth, host-managed authentication, descriptor/file auth, and identity
  // controls recognized by the pinned SDK/CLI.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HFI_BEARER_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_BRIDGE_OAUTH_TOKEN',
  'CLAUDE_BG_SOCKET_TOKENS_PATH',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_SCOPE',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_WORKSPACE_ID',

  // Manager, classifier, fallback, and native-child model selectors. The
  // accepted route re-adds the required selectors with one exact alias.
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'CLAUDE_CODE_BG_CLASSIFIER_MODEL',
  'CLAUDE_CODE_AUTO_MODE_MODEL',
  'CLAUDE_CONTEXT_COLLAPSE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'FALLBACK_FOR_ALL_PRIMARY_MODELS',
  'CLAUDE_CODE_NO_MODEL_FALLBACK',
] as const;

/**
 * Overlay one backend profile onto a per-spawn environment.
 *
 * The backend's own loopback proxy owns protocol translation to the real
 * upstream (LiteLLM -> Ollama Cloud's OpenAI-compatible API for 'ollama';
 * CLIProxyAPI -> Codex's ChatGPT-subscription backend for 'codex-proxy').
 * This function is provider-agnostic by design: all Claude roles, including
 * native Task/Agent children, use the same alias and therefore the same
 * exact backend model, regardless of which provider family it belongs to.
 */
export function applyClaudeCodeBackendEnv(
  env: Record<string, string | undefined>,
  backend: ClaudeCodeBackend
): void {
  // ANTHROPIC_API_KEY signals first-party API-key auth to the native binary and
  // can shadow gateway routing. It must be absent, even when configured in
  // Nimbalyst settings.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  for (const key of CLAUDE_CODE_AMBIENT_ROUTE_ENV_KEYS) {
    delete env[key];
  }

  env.ANTHROPIC_BASE_URL = backend.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = backend.authToken;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_SMALL_FAST_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_MODEL = backend.claudeModelAlias;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION = backend.claudeModelAlias;
  env.CLAUDE_CODE_BG_CLASSIFIER_MODEL = backend.claudeModelAlias;
  env.CLAUDE_CODE_AUTO_MODE_MODEL = backend.claudeModelAlias;
  env.CLAUDE_CONTEXT_COLLAPSE_MODEL = backend.claudeModelAlias;
  env.CLAUDE_CODE_SUBAGENT_MODEL = backend.claudeModelAlias;
  env.CLAUDE_CODE_NO_MODEL_FALLBACK = '1';
  env.NO_PROXY = '127.0.0.1,localhost';
}
