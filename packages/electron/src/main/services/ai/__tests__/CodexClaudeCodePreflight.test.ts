import { describe, expect, it, vi } from 'vitest';
import { resolveClaudeCodeBackend } from '@nimbalyst/runtime/ai/server';
import { preflightCodexClaudeCodeBackend } from '../CodexClaudeCodePreflight';

const backend = resolveClaudeCodeBackend('codex-terra')!;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Codex Claude Code CLIProxyAPI preflight', () => {
  it('accepts a ready gateway with the requested model present in the catalog', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({
        data: [
          { id: 'gpt-5.6-sol' },
          { id: 'gpt-5.6-terra' },
          { id: 'gpt-5.6-luna' },
        ],
      }));

    await expect(
      preflightCodexClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:38118/healthz',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:38118/v1/models',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a closed or unready gateway', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection refused'));

    await expect(
      preflightCodexClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).rejects.toThrow('no Nimbalyst session was created: connection refused');
  });

  it('rejects when the requested model is absent from the catalog (e.g. Codex OAuth not logged in)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    await expect(
      preflightCodexClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).rejects.toThrow('is absent from the catalog');
  });

  it('rejects a healthz failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'down' }, 503));

    await expect(
      preflightCodexClaudeCodeBackend(backend, fetchImpl as typeof fetch)
    ).rejects.toThrow('healthz returned HTTP 503');
  });
});
