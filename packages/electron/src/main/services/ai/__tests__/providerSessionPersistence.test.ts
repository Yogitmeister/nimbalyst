import { describe, expect, it, vi } from 'vitest';
import { createProviderSessionPersistenceHandler } from '../providerSessionPersistence';

describe('provider session persistence listener', () => {
  it('registers the exact durable writer promise synchronously before resolving', async () => {
    let release!: () => void;
    const persistence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.fn(() => persistence);
    const reportError = vi.fn();
    const handler = createProviderSessionPersistenceHandler(write, reportError);
    let registered: Promise<void> | undefined;

    let settled = false;
    const listenerCompletion = handler({
      sessionId: 'nimbalyst-session',
      providerSessionId: 'codex-thread',
      waitUntil: (candidate) => {
        registered = candidate;
      },
    }).then(() => {
      settled = true;
    });

    expect(registered).toBe(persistence);
    expect(settled).toBe(false);
    expect(write).toHaveBeenCalledWith('nimbalyst-session', 'codex-thread');

    release();
    await listenerCompletion;
    expect(settled).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('keeps a failed durable write rejected for the provider barrier even though the listener logs it', async () => {
    let reject!: (error: Error) => void;
    const persistence = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const reportError = vi.fn();
    const handler = createProviderSessionPersistenceHandler(() => persistence, reportError);
    let registered: Promise<void> | undefined;

    const listenerCompletion = handler({
      sessionId: 'nimbalyst-session',
      providerSessionId: 'codex-thread',
      waitUntil: (candidate) => {
        registered = candidate;
      },
    });
    expect(registered).toBe(persistence);
    const barrierResult = expect(registered).rejects.toThrow('database unavailable');

    reject(new Error('database unavailable'));
    await barrierResult;
    await listenerCompletion;
    expect(reportError).toHaveBeenCalledOnce();
  });
});
