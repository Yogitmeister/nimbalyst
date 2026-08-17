// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ingestMobileQueuedPrompts } from '../mobileQueuedPromptIngest';

function makeDeps(overrides: Partial<Parameters<typeof ingestMobileQueuedPrompts>[0]> = {}) {
  const existing = new Set<string>();
  return {
    existing,
    deps: {
      createOrReplayPrompt: vi.fn(async (input: { id: string }) => {
        if (existing.has(input.id)) return { created: false };
        existing.add(input.id);
        return { created: true };
      }),
      publishQueueState: vi.fn(async () => {}),
      getSession: vi.fn(async () => ({ provider: 'claude-code', workspacePath: '/w' })),
      canDispatch: vi.fn(async () => true),
      trackQueued: vi.fn(),
      notifyWindow: vi.fn(),
      requestDrive: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      ...overrides,
    },
  };
}

describe('ingestMobileQueuedPrompts', () => {
  it('publishes the pending queue back to sync before driving, so the phone sees its own prompt as queued', async () => {
    // #1193: the phone inserts no local row when it sends, and the index room
    // excludes the sender from its own broadcast, so this push is the only thing
    // that can render the prompt in the iOS queue pane while it is pending.
    const { deps } = makeDeps();
    const order: string[] = [];
    deps.publishQueueState = vi.fn(async () => {
      order.push('publish');
    });
    deps.requestDrive = vi.fn(() => {
      order.push('drive');
    });

    const inserted = await ingestMobileQueuedPrompts(deps, 'session-1', [
      { id: 'mobile-1', prompt: 'from the phone' },
    ]);

    expect(inserted).toBe(1);
    expect(deps.publishQueueState).toHaveBeenCalledWith('session-1');
    // Publishing after the drive could send a snapshot that a fast claim has
    // already superseded with its own empty publish.
    expect(order).toEqual(['publish', 'drive']);
  });

  it('does not re-publish an identical replay after it already ran', async () => {
    const { existing, deps } = makeDeps();
    existing.add('mobile-1');

    const inserted = await ingestMobileQueuedPrompts(deps, 'session-1', [
      { id: 'mobile-1', prompt: 'from the phone' },
      { id: 'local-2', prompt: 'composed on this desktop' },
    ]);

    expect(inserted).toBe(0);
    expect(deps.createOrReplayPrompt).toHaveBeenCalledTimes(1);
    expect(deps.publishQueueState).not.toHaveBeenCalled();
    expect(deps.requestDrive).not.toHaveBeenCalled();
  });

  it('handles two same-ID callbacks through the atomic boundary with one create, publish, and drive', async () => {
    const { deps } = makeDeps();
    const waiters: Array<() => void> = [];
    let arrivals = 0;
    const createdIds = new Set<string>();
    deps.createOrReplayPrompt = vi.fn(async (input: { id: string }) => {
      arrivals++;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (arrivals === 2) {
          for (const release of waiters) release();
        }
      });
      if (createdIds.has(input.id)) return { created: false };
      createdIds.add(input.id);
      return { created: true };
    });

    const prompt = { id: 'mobile-race', prompt: 'same callback payload' };
    const results = await Promise.all([
      ingestMobileQueuedPrompts(deps, 'session-1', [prompt]),
      ingestMobileQueuedPrompts(deps, 'session-1', [prompt]),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect(deps.createOrReplayPrompt).toHaveBeenCalledTimes(2);
    expect(deps.publishQueueState).toHaveBeenCalledTimes(1);
    expect(deps.requestDrive).toHaveBeenCalledTimes(1);
    expect(deps.logError).not.toHaveBeenCalled();
  });

  it('keeps a non-conflict database failure visible to the listener log', async () => {
    const { deps } = makeDeps();
    const databaseError = new Error('database unavailable');
    deps.createOrReplayPrompt = vi.fn(async () => {
      throw databaseError;
    });

    await expect(
      ingestMobileQueuedPrompts(deps, 'session-1', [{ id: 'mobile-db-error', prompt: 'p' }]),
    ).resolves.toBe(0);

    expect(deps.logError).toHaveBeenCalledWith(
      '[AIService] Failed to insert queuedPrompts into table:',
      databaseError,
    );
    expect(deps.publishQueueState).not.toHaveBeenCalled();
    expect(deps.requestDrive).not.toHaveBeenCalled();
  });

  it('still confirms the queue to the phone when the session row is missing', async () => {
    const { deps } = makeDeps({ getSession: vi.fn(async () => null) });

    const inserted = await ingestMobileQueuedPrompts(deps, 'session-1', [
      { id: 'mobile-1', prompt: 'from the phone' },
    ]);

    expect(inserted).toBe(1);
    expect(deps.publishQueueState).toHaveBeenCalledWith('session-1');
    expect(deps.requestDrive).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalledWith(expect.stringContaining('Session not found'));
  });

  it('acknowledges the queued row but leaves dispatch to an active model recovery', async () => {
    const { deps } = makeDeps({ canDispatch: vi.fn(async () => false) });

    const inserted = await ingestMobileQueuedPrompts(deps, 'session-1', [
      { id: 'mobile-recovery', prompt: 'wait for recovery' },
    ]);

    expect(inserted).toBe(1);
    expect(deps.publishQueueState).toHaveBeenCalledWith('session-1');
    expect(deps.trackQueued).not.toHaveBeenCalled();
    expect(deps.notifyWindow).not.toHaveBeenCalled();
    expect(deps.requestDrive).not.toHaveBeenCalled();
  });

  it('refuses to route a session with no workspacePath rather than guessing a window', async () => {
    const { deps } = makeDeps({
      getSession: vi.fn(async () => ({ provider: 'claude-code', workspacePath: undefined })),
    });

    await ingestMobileQueuedPrompts(deps, 'session-1', [{ id: 'mobile-1', prompt: 'p' }]);

    expect(deps.notifyWindow).not.toHaveBeenCalled();
    expect(deps.requestDrive).not.toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('no workspacePath'));
  });
});
