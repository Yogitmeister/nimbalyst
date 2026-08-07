import { describe, expect, it, vi } from 'vitest';

// Mirrors AIService.interactivePromptSettlement.test.ts's mock set -- AIService.ts
// pulls in a large module graph at import time; these are the pieces that
// actually need stubbing for the module to import cleanly under vitest. None
// of them are touched by settleQueueLeaseAfterAction itself (it only reads
// `this.queueProcessingLeases` and the passed-in `provider`), but the whole
// file still has to import successfully to reach the class at all.
const { query, getSession, clearPending } = vi.hoisted(() => ({
  query: vi.fn(),
  getSession: vi.fn(),
  clearPending: vi.fn(),
}));

vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: getSession },
}));
vi.mock('../pendingPromptPersistence', () => ({ setSessionPendingPrompt: clearPending }));
vi.mock('../../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import { AIService } from '../AIService';
import { logger } from '../../../utils/logger';

/**
 * NIM-591/NIM-615 -- settleQueueLeaseAfterAction replaced an eager,
 * pre-action `queueProcessingLeases.delete(sessionId)` in both
 * ai:cancelRequest and interruptCurrentTurnForSession's plain-caller path
 * with a bounded wait + fail-closed-on-timeout + isLeadBusy() recheck. See
 * _pending/nim591_design_v2.md §2.4/2.5 (the pressure-test finding that all
 * 3 reviewers independently rejected fail-open on timeout) and the addendum
 * (the real target is `queueProcessingLeases: Map<string, symbol>`, not the
 * v1/v2 draft's assumed `Set<string>`).
 *
 * `settleQueueLeaseAfterAction` is a private instance method with no
 * standalone exported logic to import, so these tests call the REAL method
 * on a minimally-seeded AIService instance -- constructed via
 * `Object.create(AIService.prototype)` (matching
 * AIService.interactivePromptSettlement.test.ts's established pattern for
 * this exact situation) rather than paying the full constructor's cost
 * (SessionManager, MessageStreamingHandler, mobile sync, etc., none of which
 * this method touches). This is not a reimplementation: `instance` is a real
 * `AIService` (its prototype chain and every other method are the genuine
 * class), just with only the one field this method reads pre-seeded.
 */

function service(leaseSessionId: string): AIService {
  const instance = Object.create(AIService.prototype) as any;
  instance.queueProcessingLeases = new Map<string, symbol>([[leaseSessionId, Symbol('lease')]]);
  return instance;
}

function callSettle(
  instance: AIService,
  sessionId: string,
  provider: unknown,
  logContext = 'test-context',
): Promise<void> {
  // settleQueueLeaseAfterAction is `private` at the TypeScript layer only --
  // at runtime it's an ordinary method, and this is the real one.
  return (instance as any).settleQueueLeaseAfterAction(sessionId, provider, logContext);
}

function leaseIsSet(instance: AIService, sessionId: string): boolean {
  return (instance as any).queueProcessingLeases.has(sessionId);
}

describe('AIService.settleQueueLeaseAfterAction (NIM-591)', () => {
  const sessionId = 'settle-lease-session';

  it('1. does not delete the lease until waitForCurrentTurnSettled resolves', async () => {
    const instance = service(sessionId);
    let resolveSettled!: (value: 'settled' | 'timeout') => void;
    const waitForCurrentTurnSettled = vi.fn(
      () => new Promise<'settled' | 'timeout'>((resolve) => { resolveSettled = resolve; }),
    );
    const provider = { waitForCurrentTurnSettled, isLeadBusy: vi.fn(() => false) };

    const settlePromise = callSettle(instance, sessionId, provider);

    // Flush a few microtasks while the provider's promise is still pending --
    // the lease must NOT be gone yet.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(leaseIsSet(instance, sessionId)).toBe(true);
    expect(waitForCurrentTurnSettled).toHaveBeenCalledWith(3000);

    resolveSettled('settled');
    await settlePromise;

    expect(leaseIsSet(instance, sessionId)).toBe(false);
  });

  it('2. CORE REGRESSION: leaves the lease SET (fail-closed) when waitForCurrentTurnSettled times out', async () => {
    const instance = service(sessionId);
    const isLeadBusy = vi.fn(() => false); // even "definitely not busy" must not override a timeout
    const provider = {
      waitForCurrentTurnSettled: vi.fn(async () => 'timeout' as const),
      isLeadBusy,
    };

    await callSettle(instance, sessionId, provider);

    expect(leaseIsSet(instance, sessionId)).toBe(true);
    // Timeout is a straight fail-closed return -- isLeadBusy must never even
    // be consulted, let alone allowed to override it.
    expect(isLeadBusy).not.toHaveBeenCalled();
    expect(logger.main.error).toHaveBeenCalledWith(
      expect.stringContaining(`turn for session ${sessionId} did not settle within timeout`),
    );
  });

  it('3. does not delete the lease when isLeadBusy() is true after settling (a newer turn started)', async () => {
    const instance = service(sessionId);
    const provider = {
      waitForCurrentTurnSettled: vi.fn(async () => 'settled' as const),
      isLeadBusy: vi.fn(() => true),
    };

    await callSettle(instance, sessionId, provider);

    expect(leaseIsSet(instance, sessionId)).toBe(true);
  });

  it('4. deletes the lease when isLeadBusy() is false after settling', async () => {
    const instance = service(sessionId);
    const provider = {
      waitForCurrentTurnSettled: vi.fn(async () => 'settled' as const),
      isLeadBusy: vi.fn(() => false),
    };

    await callSettle(instance, sessionId, provider);

    expect(leaseIsSet(instance, sessionId)).toBe(false);
  });

  it('5. deletes the lease immediately for a provider with neither waitForCurrentTurnSettled nor isLeadBusy', async () => {
    const instance = service(sessionId);
    const provider = {}; // e.g. a provider type that predates NIM-591 and implements neither method

    await callSettle(instance, sessionId, provider);

    expect(leaseIsSet(instance, sessionId)).toBe(false);
  });

  it('6. CORE REGRESSION (panel finding, Sonnet 5): does not delete a NEWER lease that replaced the watched one during the wait, even when isLeadBusy() reads false', async () => {
    // isLeadBusy() is a real but imperfect proxy for "a newer turn owns this
    // session" -- it doesn't go true until leadQuery is assigned, well after
    // a new turn's own lease is set. This test forces exactly that gap: a
    // second, different lease occupies the key by the time settlement
    // resolves, while isLeadBusy() still (incorrectly, but realistically)
    // reads false. Only the identity check protects the newer lease here.
    const instance = service(sessionId);
    let resolveSettled!: (value: 'settled' | 'timeout') => void;
    const provider = {
      waitForCurrentTurnSettled: vi.fn(
        () => new Promise<'settled' | 'timeout'>((resolve) => { resolveSettled = resolve; }),
      ),
      isLeadBusy: vi.fn(() => false), // stale/racy read -- a newer turn IS active
    };

    const settlePromise = callSettle(instance, sessionId, provider);

    // While still waiting, a different caller's turn claims a fresh lease
    // for the SAME sessionId (simulating tryClaimAndDispatchNextQueuedPrompt
    // dispatching a new turn before this call's watched turn settles).
    const newerLease = Symbol('newer-lease');
    (instance as any).queueProcessingLeases.set(sessionId, newerLease);

    resolveSettled('settled');
    await settlePromise;

    // The newer lease must survive untouched -- this is the exact bug: a
    // bare `.delete(sessionId)` would remove it regardless of which lease
    // is actually present.
    expect((instance as any).queueProcessingLeases.get(sessionId)).toBe(newerLease);
  });
});
