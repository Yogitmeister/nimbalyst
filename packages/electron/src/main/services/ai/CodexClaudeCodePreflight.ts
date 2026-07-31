import type { ClaudeCodeBackend } from '@nimbalyst/runtime/ai/server';

type FetchLike = typeof fetch;

interface CliProxyApiModelsResponse {
  data?: Array<{ id?: unknown }>;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  authToken: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prove that the fixed loopback endpoint is a ready CLIProxyAPI gateway
 * carrying the exact requested Codex model in its authenticated catalog.
 *
 * This is deliberately a read-only gate, matching
 * preflightOllamaClaudeCodeBackend's contract: it neither starts nor repairs
 * the gateway, and callers must run it before creating worktrees, session
 * rows, or queue rows. Endpoint shapes (`/healthz`, `/v1/models`) are
 * confirmed against the already-pinned `tools/claudex/claudex.py`'s own
 * doctor/smoke checks (v7.2.86) -- CLIProxyAPI has no per-alias targeted
 * health endpoint the way LiteLLM does, so an absent model in the catalog
 * (e.g. before Codex OAuth login completes) is the failure signal instead.
 */
export async function preflightCodexClaudeCodeBackend(
  backend: ClaudeCodeBackend,
  fetchImpl: FetchLike = globalThis.fetch,
  timeoutMs = 5_000
): Promise<void> {
  if (backend.baseUrl !== 'http://127.0.0.1:38118') {
    throw new Error(`Codex Claude Code route rejected unexpected proxy endpoint: ${backend.baseUrl}`);
  }

  try {
    const healthz = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/healthz`,
      backend.authToken,
      timeoutMs
    );
    if (!healthz.ok) {
      throw new Error(`healthz returned HTTP ${healthz.status}`);
    }

    const modelsResponse = await fetchWithTimeout(
      fetchImpl,
      `${backend.baseUrl}/v1/models`,
      backend.authToken,
      timeoutMs
    );
    if (!modelsResponse.ok) {
      throw new Error(`model catalog returned HTTP ${modelsResponse.status}`);
    }

    const payload = await modelsResponse.json() as CliProxyApiModelsResponse;
    const hasModel = payload.data?.some((entry) => entry.id === backend.claudeModelAlias);
    if (!hasModel) {
      throw new Error(
        `required model ${backend.claudeModelAlias} is absent from the catalog -- Codex OAuth login may be incomplete`
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Codex Claude Code preflight failed for ${backend.id}; no Nimbalyst session was created: ${reason}`
    );
  }
}
