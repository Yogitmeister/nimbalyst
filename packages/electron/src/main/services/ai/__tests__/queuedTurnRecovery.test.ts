import { describe, expect, it, vi } from 'vitest';
import { reconcileQueuedTurn, reconcileQueuedTurnsBeforeControl } from '../queuedTurnRecovery';

const owned = { providerThreadId: 'thread-a', providerTurnId: 'turn-a' };

describe('queued turn recovery ownership', () => {
  it('keeps an unmatched active provider turn fenced as foreign-active', () => {
    expect(reconcileQueuedTurn(owned, {
      identityProven: true,
      threadId: 'thread-a',
      turns: [{ id: 'turn-b', status: 'active' }],
    })).toBe('foreign-active');
  });

  it('fails closed as uncertain without durable provider identity', () => {
    expect(reconcileQueuedTurn({ providerThreadId: 'thread-a' }, {
      identityProven: true,
      threadId: 'thread-a',
      turns: [],
    })).toBe('uncertain');
  });

  it.each(['completed', 'failed', 'interrupted'] as const)('recognizes owned terminal %s', (status) => {
    expect(reconcileQueuedTurn(owned, {
      identityProven: true,
      threadId: 'thread-a',
      turns: [{ id: 'turn-a', status }],
    })).toBe(`owned-${status}`);
  });

  it('fails closed when a read is from another thread', () => {
    expect(reconcileQueuedTurn(owned, {
      identityProven: true,
      threadId: 'thread-b',
      turns: [{ id: 'turn-a', status: 'completed' }],
    })).toBe('uncertain');
  });

  it('interrupts only the exact owned active provider turn and keeps its row fenced', async () => {
    const interruptExact = vi.fn(async () => true);
    const store = {
      listForSession: vi.fn(async () => [{
        id: 'prompt-a', sessionId: 'session-a', status: 'executing',
        claimToken: 'claim-a', attentionGeneration: 'generation-a',
        providerThreadId: 'thread-a', providerTurnId: 'turn-a',
      }]),
      completeAfterDispatch: vi.fn(),
      failAfterDispatch: vi.fn(),
    } as any;
    const result = await reconcileQueuedTurnsBeforeControl('session-a', store, {
      inspect: async () => ({
        identityProven: true,
        threadId: 'thread-a',
        turns: [{ id: 'turn-a', status: 'active' }],
      }),
      interruptExact,
    });

    expect(result).toMatchObject({
      allowControl: true,
      queuedTurnHandled: true,
      exactInterruptSent: true,
      states: ['owned-active'],
    });
    expect(interruptExact).toHaveBeenCalledWith('session-a', {
      threadId: 'thread-a', turnId: 'turn-a',
    });
    expect(store.completeAfterDispatch).not.toHaveBeenCalled();
    expect(store.failAfterDispatch).not.toHaveBeenCalled();
  });

  it('settles owned terminal evidence but fences a foreign active replacement', async () => {
    const interruptExact = vi.fn(async () => true);
    const store = {
      listForSession: vi.fn(async () => [{
        id: 'prompt-a', sessionId: 'session-a', status: 'executing',
        claimToken: 'claim-a', attentionGeneration: 'generation-a',
        providerThreadId: 'thread-a', providerTurnId: 'turn-a',
      }]),
      completeAfterDispatch: vi.fn(async () => ({ outcome: 'settled' })),
      failAfterDispatch: vi.fn(),
    } as any;
    const result = await reconcileQueuedTurnsBeforeControl('session-a', store, {
      inspect: async () => ({
        identityProven: true,
        threadId: 'thread-a',
        turns: [
          { id: 'turn-a', status: 'completed' },
          { id: 'turn-b', status: 'active' },
        ],
      }),
      interruptExact,
    });

    expect(store.completeAfterDispatch).toHaveBeenCalledTimes(1);
    expect(result.allowControl).toBe(false);
    expect(result.queuedTurnHandled).toBe(true);
    expect(interruptExact).not.toHaveBeenCalled();
  });
});
