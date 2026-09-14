// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../mcp/httpServer', () => ({
  revokeHostBoundMcpAuthority: vi.fn(async () => undefined),
}));
vi.mock('../pendingPromptPersistence', () => ({
  setSessionPendingPrompt: vi.fn(async (_id, _pending, _kind, options) => ({
    applied: true,
    superseded: false,
    attentionGeneration: options.attentionGeneration,
  })),
}));

import { settleOrphanedPromptTurn } from '../orphanedPromptTurnSettlement';

describe('orphaned prompt generation settlement', () => {
  it('refuses to settle an orphan after its generation was replaced', async () => {
    const stateManager = {
      getSessionState: () => ({ attentionGeneration: 'generation-b' }),
      endSession: vi.fn(async () => undefined),
      updateActivity: vi.fn(),
    };

    await expect(settleOrphanedPromptTurn(
      { sessionId: 'session-1', attentionGeneration: 'generation-a' },
      'error',
      stateManager as any,
    )).resolves.toBe(false);
    expect(stateManager.endSession).not.toHaveBeenCalled();
  });

  it('settles the unchanged orphan generation', async () => {
    let state: { attentionGeneration: string } | undefined = {
      attentionGeneration: 'generation-a',
    };
    const stateManager = {
      getSessionState: () => state,
      endSession: vi.fn(async (_id, options) => {
        if (state?.attentionGeneration === options.attentionGeneration) state = undefined;
      }),
      updateActivity: vi.fn(),
    };

    await expect(settleOrphanedPromptTurn(
      { sessionId: 'session-1', attentionGeneration: 'generation-a' },
      'interrupted',
      stateManager as any,
    )).resolves.toBe(true);
    expect(stateManager.endSession).toHaveBeenCalledWith(
      'session-1', { attentionGeneration: 'generation-a' },
    );
  });
});
