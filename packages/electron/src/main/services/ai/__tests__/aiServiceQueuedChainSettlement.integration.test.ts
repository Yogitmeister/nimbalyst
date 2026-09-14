// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../mcp/httpServer', () => ({
  revokeHostBoundMcpAuthority: vi.fn(async () => undefined),
}));
vi.mock('../terminalAttentionSettlement', () => ({
  settleTerminalAttentionBeforeContinuation: vi.fn(async (_args, continuation) => ({
    promptClear: { applied: true, superseded: false, attentionGeneration: 'generation-a' },
    continuationResult: await continuation(),
  })),
}));

import { createAIServiceQueuedChainSettlement } from '../aiServiceQueuedChainSettlement';

function managerHarness() {
  let state: { attentionGeneration: string; status: string } | undefined = {
    attentionGeneration: 'generation-a',
    status: 'running',
  };
  const manager = {
    getSessionState: vi.fn(() => state),
    updateActivity: vi.fn(async (input: { status: string; attentionGeneration: string }) => {
      if (state?.attentionGeneration === input.attentionGeneration) state.status = input.status;
    }),
    endSession: vi.fn(async (_sessionId: string, options: { attentionGeneration?: string }) => {
      if (state?.attentionGeneration === options.attentionGeneration) state = undefined;
    }),
  };
  return {
    manager,
    replace: () => { state = { attentionGeneration: 'generation-b', status: 'running' }; },
    current: () => state,
  };
}

describe('AIService queued-chain generation settlement', () => {
  it('ends the current generation and schedules watcher cleanup', async () => {
    const h = managerHarness();
    const scheduleStop = vi.fn();
    const settlement = createAIServiceQueuedChainSettlement({
      stateManager: h.manager as any,
      scheduleStop,
      logInfo: vi.fn(),
    });

    await settlement.onChainSettled({
      sessionId: 'session-1', workspacePath: '/work', source: 'test',
      attentionGeneration: 'generation-a', outcome: 'completed',
    });

    expect(h.manager.endSession).toHaveBeenCalledWith(
      'session-1', { attentionGeneration: 'generation-a' },
    );
    expect(scheduleStop).toHaveBeenCalledWith('session-1', 500);
  });

  it('does not let delayed generation A end replacement B', async () => {
    const h = managerHarness();
    const settlement = createAIServiceQueuedChainSettlement({
      stateManager: h.manager as any,
      scheduleStop: vi.fn(),
      logInfo: vi.fn(),
    });
    h.replace();

    await settlement.onChainSettled({
      sessionId: 'session-1', workspacePath: '/work', source: 'test',
      attentionGeneration: 'generation-a', outcome: 'completed',
    });

    expect(h.manager.endSession).not.toHaveBeenCalled();
    expect(h.current()?.attentionGeneration).toBe('generation-b');
  });

  it('marks and ends only the exact failed generation', async () => {
    const h = managerHarness();
    const settlement = createAIServiceQueuedChainSettlement({
      stateManager: h.manager as any,
      scheduleStop: vi.fn(),
      logInfo: vi.fn(),
    });

    await settlement.onChainSettled({
      sessionId: 'session-1', workspacePath: '/work', source: 'test',
      attentionGeneration: 'generation-a', outcome: 'failed',
    });

    expect(h.manager.updateActivity).toHaveBeenCalledWith({
      sessionId: 'session-1', status: 'error', attentionGeneration: 'generation-a',
    });
    expect(settlement.settledChildErrored).toBe(true);
  });
});
