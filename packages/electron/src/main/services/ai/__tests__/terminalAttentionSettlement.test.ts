// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { settleTerminalAttentionBeforeContinuation } from '../terminalAttentionSettlement';

describe('terminal attention settlement', () => {
  it('compare-clears the exact generation before continuing', async () => {
    const order: string[] = [];
    const clearPendingPrompt = vi.fn(async () => {
      order.push('clear');
      return { applied: true, superseded: false, attentionGeneration: 'generation-a' };
    });

    const result = await settleTerminalAttentionBeforeContinuation(
      { sessionId: 'session-1', attentionGeneration: 'generation-a', reason: 'completed' },
      async () => { order.push('continue'); return 'done'; },
      { clearPendingPrompt },
    );

    expect(clearPendingPrompt).toHaveBeenCalledWith(
      'session-1', false, 'approval', { attentionGeneration: 'generation-a' },
    );
    expect(order).toEqual(['clear', 'continue']);
    expect(result.continuationResult).toBe('done');
  });

  it('withholds terminal continuation when a newer prompt generation owns the bit', async () => {
    const continuation = vi.fn(async () => 'wrong');
    const result = await settleTerminalAttentionBeforeContinuation(
      { sessionId: 'session-1', attentionGeneration: 'generation-a', reason: 'error' },
      continuation,
      {
        clearPendingPrompt: vi.fn(async () => ({
          applied: false, superseded: true, attentionGeneration: 'generation-a',
        })),
      },
    );

    expect(continuation).not.toHaveBeenCalled();
    expect(result.continuationResult).toBeUndefined();
  });
});
