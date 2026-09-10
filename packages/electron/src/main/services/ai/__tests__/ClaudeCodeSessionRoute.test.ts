// [ASTRA-ORCH]
import { describe, expect, it } from 'vitest';
import { resolveClaudeCodeSessionRoute } from '../ClaudeCodeSessionRoute';

const OLLAMA_MODEL = 'claude-code:ollama-glm-5-2-cloud';
const CLAUDEX_MODEL = 'claude-code:claudex-sol';

function durableRouteMetadata(model: string) {
  const routePart = () => ({
    plan: { model: { persistedId: model } },
    receipt: {
      resolved: { persistedModelId: model },
      fallbackUsed: false,
    },
  });
  return {
    providerRuntimeRouteSnapshotV1: {
      schemaVersion: 1,
      main: routePart(),
      subagent: routePart(),
      consultation: routePart(),
    },
  };
}

describe('Claude Code persisted session routing', () => {
  it('re-reads the exact persisted catalog identity and scrubbed route receipt', async () => {
    const metadata = durableRouteMetadata(OLLAMA_MODEL);
    const result = await resolveClaudeCodeSessionRoute(
      'session-1',
      OLLAMA_MODEL,
      undefined,
      async () => ({
        model: OLLAMA_MODEL,
        workspacePath: 'D:/workspace',
        metadata,
      }),
    );

    expect(result.model).toBe(OLLAMA_MODEL);
    // Ollama routes went direct-to-ollama.com (no more local LiteLLM proxy
    // hop; see providerCatalogDefaults.ts's OLLAMA_API_CREDENTIAL_REF), so no
    // current catalog entry uses LOCAL_PROXY_CREDENTIAL_REF and the legacy
    // ClaudeCodeBackend projection is always empty -- same as the general
    // catalog identity case below.
    expect(result.backend).toBeUndefined();
    expect(result.workspacePath).toBe('D:/workspace');
  });

  it('passes valid general catalog identity and persisted workspace context to the runtime provider', async () => {
    const result = await resolveClaudeCodeSessionRoute(
      'session-general',
      CLAUDEX_MODEL,
      undefined,
      async () => ({
        model: CLAUDEX_MODEL,
        workspacePath: 'D:/workspace',
        metadata: durableRouteMetadata(CLAUDEX_MODEL),
      }),
    );

    expect(result).toMatchObject({
      model: CLAUDEX_MODEL,
      backend: undefined,
      workspacePath: 'D:/workspace',
    });
  });

  it('fails closed when a catalog session persistence read fails, disappears, or drifts', async () => {
    await expect(
      resolveClaudeCodeSessionRoute(
        'session-1',
        OLLAMA_MODEL,
        undefined,
        async () => { throw new Error('persistence unavailable'); },
      ),
    ).rejects.toThrow('cannot refresh its persisted model identity');
    await expect(
      resolveClaudeCodeSessionRoute(
        'session-1',
        OLLAMA_MODEL,
        undefined,
        async () => null,
      ),
    ).rejects.toThrow('has no persisted session row');
    await expect(
      resolveClaudeCodeSessionRoute(
        'session-1',
        CLAUDEX_MODEL,
        undefined,
        async () => ({ model: 'claude-code:openrouter-deepseek-v4-flash' }),
      ),
    ).rejects.toThrow('persisted model identity changed or was lost');
  });

  it('rejects invalid durable main, subagent, or consultation receipt identity without a fallback', async () => {
    const metadata = durableRouteMetadata(CLAUDEX_MODEL) as any;
    metadata.providerRuntimeRouteSnapshotV1.consultation.receipt.fallbackUsed = true;
    await expect(
      resolveClaudeCodeSessionRoute(
        'session-invalid',
        CLAUDEX_MODEL,
        undefined,
        async () => ({ model: CLAUDEX_MODEL, metadata }),
      ),
    ).rejects.toThrow('durable consultation route identity changed or is invalid');
  });
});
