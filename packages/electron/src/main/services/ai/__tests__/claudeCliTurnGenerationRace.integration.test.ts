// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../mcp/httpServer', () => ({
  revokeHostBoundMcpAuthority: vi.fn(async () => undefined),
}));

import { endHostBoundAiSession } from '../aiServiceQueuedChainSettlement';

describe('Claude CLI turn generation race', () => {
  it('rechecks after revocation so delayed A cannot end B', async () => {
    let state = { attentionGeneration: 'generation-a' };
    const endSession = vi.fn(async (
      _sessionId: string,
      _options: { attentionGeneration?: string },
    ) => undefined);
    const manager = {
      getSessionState: () => state,
      endSession,
      updateActivity: vi.fn(),
    };
    let release!: () => void;
    const revoke = new Promise<void>((resolve) => { release = resolve; });
    const { terminateHostBoundAiSession } = await import('../aiServiceQueuedChainSettlement');

    const endingA = terminateHostBoundAiSession(
      'session-1',
      () => manager.endSession('session-1', { attentionGeneration: 'generation-a' }),
      () => manager.getSessionState().attentionGeneration === 'generation-a',
      () => revoke,
    );
    state = { attentionGeneration: 'generation-b' };
    release();

    await expect(endingA).resolves.toBe(false);
    expect(endSession).not.toHaveBeenCalled();
    expect(state.attentionGeneration).toBe('generation-b');
  });

  it('ends the unchanged current generation', async () => {
    const manager = {
      getSessionState: () => ({ attentionGeneration: 'generation-a' }),
      endSession: vi.fn(async () => undefined),
      updateActivity: vi.fn(),
    };
    await expect(endHostBoundAiSession(
      manager as any, 'session-1', 'generation-a',
    )).resolves.toBe(true);
    expect(manager.endSession).toHaveBeenCalledWith(
      'session-1', { attentionGeneration: 'generation-a' },
    );
  });
});
