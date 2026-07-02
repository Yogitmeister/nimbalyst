/**
 * Per-session custom backend registry for Claude Code.
 *
 * A session with no selected backend keeps the default Anthropic Claude Code
 * behavior. Selecting a backend stores only this registry id in session
 * metadata; gateway tokens are read from process.env at spawn time and are not
 * persisted.
 */

export interface ClaudeCodeBackend {
  id: string;
  name: string;
  baseUrl: string;
  authTokenEnv: string;
  upstreamModel: string;
  capabilities?: string;
}

export const CLAUDE_CODE_BACKENDS: readonly ClaudeCodeBackend[] = [
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek V4 Reasoner',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authTokenEnv: 'DEEPSEEK_API_KEY',
    upstreamModel: 'deepseek-reasoner',
    capabilities: 'effort,max_effort,thinking',
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V4 Fast',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authTokenEnv: 'DEEPSEEK_API_KEY',
    upstreamModel: 'deepseek-chat',
    capabilities: 'effort',
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authTokenEnv: 'MOONSHOT_STUDIO_API_KEY',
    upstreamModel: 'kimi-k2.6',
    capabilities: 'effort,thinking',
  },
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authTokenEnv: 'MOONSHOT_STUDIO_API_KEY',
    upstreamModel: 'kimi-k2.7-code',
    capabilities: 'effort,thinking',
  },
  {
    id: 'qwen3-max-thinking',
    name: 'Qwen3 Max Thinking',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'qwen/qwen3-max-thinking',
    capabilities: 'effort,thinking',
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen 3.7 Plus',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'qwen/qwen3.7-plus',
    capabilities: 'effort,thinking',
  },
  {
    id: 'kimi-k2-thinking',
    name: 'Kimi K2 Thinking',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'moonshotai/kimi-k2-thinking',
    capabilities: 'effort,thinking',
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'google/gemini-3.5-flash',
    capabilities: 'effort',
  },
  {
    id: 'a54',
    name: 'GPT-5.4',
    baseUrl: 'https://openrouter.ai/api',
    authTokenEnv: 'OPENROUTER_API_KEY',
    upstreamModel: 'openai/gpt-5.4',
    capabilities: 'effort',
  },
] as const;

export function resolveClaudeCodeBackend(backendId: string | undefined | null): ClaudeCodeBackend | undefined {
  if (!backendId) return undefined;
  return CLAUDE_CODE_BACKENDS.find((backend) => backend.id === backendId);
}

export function applyClaudeCodeBackendEnv(env: Record<string, any>, backend: ClaudeCodeBackend): void {
  const token = process.env[backend.authTokenEnv];

  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = backend.baseUrl;
  if (token) {
    env.ANTHROPIC_AUTH_TOKEN = token;
  } else {
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  env.ANTHROPIC_DEFAULT_OPUS_MODEL = backend.upstreamModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = backend.upstreamModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = backend.upstreamModel;
  env.CLAUDE_CODE_SUBAGENT_MODEL = backend.upstreamModel;

  if (backend.capabilities) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = backend.capabilities;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = backend.capabilities;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = backend.capabilities;
  }
}
