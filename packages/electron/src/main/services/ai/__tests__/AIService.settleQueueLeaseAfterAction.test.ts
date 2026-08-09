import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { ProviderFactory } from '@nimbalyst/runtime/ai/server';

type TerminationResult = 'terminated' | 'timeout';

function service(sessionId: string): AIService {
  const instance = Object.create(AIService.prototype) as any;
  instance.queueProcessingLeases = new Map<string, symbol>([[sessionId, Symbol('dispatch')]]);
  return instance;
}

function callSettle(
  instance: AIService,
  sessionId: string,
  provider: unknown,
  sweepQueueDb: () => Promise<boolean> = vi.fn(async () => true),
): Promise<'released' | 'retained'> {
  return (instance as any).settleQueueLeaseAfterAction(
    sessionId,
    provider,
    'test-context',
    sweepQueueDb,
  );
}

function leases(instance: AIService): Map<string, symbol> {
  return (instance as any).queueProcessingLeases;
}

function exactHandle(
  results: TerminationResult[],
  id = 'turn-A',
): {
  id: string;
  waitForTermination: ReturnType<typeof vi.fn>;
  hardClose: ReturnType<typeof vi.fn>;
  acquireSettlementHold: ReturnType<typeof vi.fn>;
  releaseSettlementHold: ReturnType<typeof vi.fn>;
} {
  const releaseSettlementHold = vi.fn();
  return {
    id,
    waitForTermination: vi.fn(async () => results.shift() ?? 'terminated'),
    hardClose: vi.fn(),
    acquireSettlementHold: vi.fn(() => ({ release: releaseSettlementHold })),
    releaseSettlementHold,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AIService.settleQueueLeaseAfterAction (NIM-591)', () => {
  const sessionId = 'settle-lease-session';

  it('holds a settlement reservation through the DB sweep, blocking the NIM-590 claim reservation boundary', async () => {
    const instance = service(sessionId);
    const handle = exactHandle(['terminated']);
    let nim590ReservationAdmitted = false;
    const sweep = vi.fn(async () => {
      // This is the exact NIM-590 admission predicate. The stale sweep runs
      // while the settlement reservation still occupies the slot.
      if (!leases(instance).has(sessionId)) {
        leases(instance).set(sessionId, Symbol('nim-590-new-claim'));
        nim590ReservationAdmitted = true;
      }
      expect(leases(instance).has(sessionId)).toBe(true);
      return true;
    });

    await expect(callSettle(instance, sessionId, {
      captureCurrentTurnTermination: vi.fn(() => handle),
    }, sweep)).resolves.toBe('released');

    expect(nim590ReservationAdmitted).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(leases(instance).has(sessionId)).toBe(false);
  });

  it('uses one captured handle across 3s + 30s, then runs the named hardClose recovery on that exact turn', async () => {
    const instance = service(sessionId);
    const handle = exactHandle(['timeout', 'timeout', 'terminated']);
    const provider = {
      captureCurrentTurnTermination: vi.fn(() => handle),
      isTurnCurrentForSettlement: vi.fn(() => true),
      getHardRecoveryProviderType: vi.fn(() => 'claude-code' as const),
    };
    const providerLookup = vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(provider as any);
    const destroyProvider = vi.spyOn(ProviderFactory, 'destroyProvider').mockImplementation(() => {});
    const sweep = vi.fn(async () => true);

    await expect(callSettle(instance, sessionId, provider, sweep)).resolves.toBe('released');

    expect(provider.captureCurrentTurnTermination).toHaveBeenCalledTimes(2);
    expect(handle.waitForTermination).toHaveBeenNthCalledWith(1, 3000);
    expect(handle.waitForTermination).toHaveBeenNthCalledWith(2, 30_000);
    expect(handle.waitForTermination).toHaveBeenNthCalledWith(3, 5000);
    expect(handle.hardClose).toHaveBeenCalledWith(
      'test-context: 3s + 30s termination recovery',
    );
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(logger.main.warn).toHaveBeenCalledWith(
      expect.stringContaining('hardClose terminated exact turn turn-A'),
    );
    expect(providerLookup).toHaveBeenCalledWith('claude-code', sessionId);
    expect(destroyProvider).toHaveBeenCalledWith(sessionId, 'claude-code');
    expect(handle.acquireSettlementHold).toHaveBeenCalledTimes(1);
    expect(handle.releaseSettlementHold).toHaveBeenCalledTimes(1);
    expect(destroyProvider.mock.invocationCallOrder[0]).toBeLessThan(sweep.mock.invocationCallOrder[0]);
    expect(sweep.mock.invocationCallOrder[0]).toBeLessThan(handle.releaseSettlementHold.mock.invocationCallOrder[0]);
  });

  it('retains the reservation and never sweeps when exact hardClose still cannot produce a termination receipt', async () => {
    const instance = service(sessionId);
    const handle = exactHandle(['timeout', 'timeout', 'timeout']);
    const sweep = vi.fn(async () => true);

    await expect(callSettle(instance, sessionId, {
      captureCurrentTurnTermination: vi.fn(() => handle),
    }, sweep)).resolves.toBe('retained');

    expect(handle.hardClose).toHaveBeenCalledTimes(1);
    expect(sweep).not.toHaveBeenCalled();
    expect(leases(instance).has(sessionId)).toBe(true);
    expect(logger.main.error).toHaveBeenCalledWith(
      expect.stringContaining('settlement reservation remains fail-closed'),
    );
  });

  it('waits only on A, then refuses the DB sweep when the provider has moved to B', async () => {
    const instance = service(sessionId);
    const handleA = exactHandle(['timeout', 'terminated'], 'turn-A');
    const handleB = exactHandle(['timeout'], 'turn-B');
    let current = handleA;
    const capture = vi.fn(() => current);
    handleA.waitForTermination.mockImplementationOnce(async () => {
      current = handleB;
      return 'timeout';
    });
    const sweep = vi.fn(async () => true);

    await expect(callSettle(instance, sessionId, {
      captureCurrentTurnTermination: capture,
    }, sweep)).resolves.toBe('retained');

    expect(capture).toHaveBeenCalledTimes(2);
    expect(handleA.waitForTermination).toHaveBeenNthCalledWith(1, 3000);
    expect(handleA.waitForTermination).toHaveBeenNthCalledWith(2, 30_000);
    expect(handleB.waitForTermination).not.toHaveBeenCalled();
    expect(handleB.hardClose).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
    expect(leases(instance).has(sessionId)).toBe(true);
  });

  it('does not sweep or delete a different owner that replaces the settlement reservation', async () => {
    const instance = service(sessionId);
    let resolveTermination!: (value: TerminationResult) => void;
    const handle = {
      id: 'turn-A',
      waitForTermination: vi.fn(
        () => new Promise<TerminationResult>((resolve) => { resolveTermination = resolve; }),
      ),
      hardClose: vi.fn(),
    };
    const sweep = vi.fn(async () => true);
    const settling = callSettle(instance, sessionId, {
      captureCurrentTurnTermination: vi.fn(() => handle),
    }, sweep);

    await Promise.resolve();
    const newerOwner = Symbol('newer-owner');
    leases(instance).set(sessionId, newerOwner);
    resolveTermination('terminated');

    await expect(settling).resolves.toBe('retained');
    expect(sweep).not.toHaveBeenCalled();
    expect(leases(instance).get(sessionId)).toBe(newerOwner);
  });

  it('retains the settlement reservation when the DB sweep fails', async () => {
    const instance = service(sessionId);
    const sweep = vi.fn(async () => false);

    await expect(callSettle(instance, sessionId, {
      captureCurrentTurnTermination: vi.fn(() => exactHandle(['terminated'])),
    }, sweep)).resolves.toBe('retained');

    expect(leases(instance).has(sessionId)).toBe(true);
  });

  it('leaves a failed ticket participant-free so the next caller owns a recovery pass', async () => {
    const instance = service(sessionId);
    const handle = exactHandle(['terminated']);
    const provider = {
      captureCurrentTurnTermination: vi.fn(() => handle),
    };

    await expect(callSettle(
      instance,
      sessionId,
      provider,
      vi.fn(async () => false),
    )).resolves.toBe('retained');

    const retainedTicket = (instance as any).getActiveQueueSettlement(sessionId);
    expect(retainedTicket).toMatchObject({ participants: 0 });
    expect(handle.releaseSettlementHold).not.toHaveBeenCalled();

    const recoveryTicket = (instance as any).beginQueueSettlement(sessionId, provider);
    expect(recoveryTicket).toBe(retainedTicket);
    expect(recoveryTicket.participants).toBe(1);

    await expect((instance as any).settleQueueLeaseAfterAction(
      sessionId,
      provider,
      'recovery-pass',
      vi.fn(async () => true),
      recoveryTicket,
    )).resolves.toBe('released');

    expect(leases(instance).has(sessionId)).toBe(false);
    expect(handle.acquireSettlementHold).toHaveBeenCalledTimes(1);
    expect(handle.releaseSettlementHold).toHaveBeenCalledTimes(1);
  });

  it('acquires and holds a settlement lock via the FIFO-predecessor fallback when the active-turn capture is null (NIM-591 null-capture admission fence)', async () => {
    const instance = service(sessionId);
    // captureCurrentTurnTermination() is null (the turn already finished
    // naturally; ClaudeCodeProvider clears currentTurnTermination on exit)
    // but captureLatestTurnTermination() still exposes that same turn as
    // the FIFO predecessor a new turn's admission will be fenced against.
    const handle = exactHandle(['terminated'], 'turn-A-latest');
    const waitForCurrentTurnSettled = vi.fn(async () => 'settled' as const);
    const isLeadBusy = vi.fn(() => false);
    // Matches ClaudeCodeProvider, the only real implementer of the
    // fallback: it also exposes isTurnCurrentForSettlement, which is what
    // actually gates the capturedTurn pre-sweep recheck (isLeadBusy is only
    // a defensive fallback for providers that lack it).
    const isTurnCurrentForSettlement = vi.fn(() => true);
    const sweep = vi.fn(async () => true);

    await expect(callSettle(instance, sessionId, {
      captureCurrentTurnTermination: vi.fn(() => null),
      captureLatestTurnTermination: vi.fn(() => handle),
      waitForCurrentTurnSettled,
      isLeadBusy,
      isTurnCurrentForSettlement,
    }, sweep)).resolves.toBe('released');

    // The fallback handle's own exact-process-termination proof gated the
    // sweep -- the legacy compatibility wait (which has no fence against a
    // newly starting generation) was never reached.
    expect(handle.waitForTermination).toHaveBeenCalledWith(3000);
    expect(waitForCurrentTurnSettled).not.toHaveBeenCalled();
    expect(isLeadBusy).not.toHaveBeenCalled();
    expect(handle.acquireSettlementHold).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(handle.releaseSettlementHold).toHaveBeenCalledTimes(1);
    // The hold must still be held while the sweep is in flight -- released
    // only after -- so a turn admitted during that async window would have
    // blocked on it instead of racing the sweep unfenced.
    expect(sweep.mock.invocationCallOrder[0])
      .toBeLessThan(handle.releaseSettlementHold.mock.invocationCallOrder[0]);
  });

  it('falls back to the legacy compatibility wait only when the provider exposes no FIFO-predecessor capture at all', async () => {
    const instance = service(sessionId);
    const waitForCurrentTurnSettled = vi.fn(async () => 'settled' as const);
    const isLeadBusy = vi.fn(() => false);
    const sweep = vi.fn(async () => true);

    // No captureLatestTurnTermination -- a provider that genuinely lacks
    // the FIFO-predecessor capability (e.g. a non-Claude-Code provider),
    // not merely a turn that happens to be idle right now.
    await expect(callSettle(instance, sessionId, {
      captureCurrentTurnTermination: vi.fn(() => null),
      waitForCurrentTurnSettled,
      isLeadBusy,
    }, sweep)).resolves.toBe('released');

    expect(waitForCurrentTurnSettled).toHaveBeenCalledTimes(1);
    expect(isLeadBusy).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('keeps one bounded compatibility wait for providers without an immutable handle', async () => {
    const instance = service(sessionId);
    const waitForCurrentTurnSettled = vi.fn(async () => 'settled' as const);
    const sweep = vi.fn(async () => true);

    await expect(callSettle(instance, sessionId, {
      waitForCurrentTurnSettled,
      isLeadBusy: vi.fn(() => false),
    }, sweep)).resolves.toBe('released');

    expect(waitForCurrentTurnSettled).toHaveBeenCalledTimes(1);
    expect(waitForCurrentTurnSettled).toHaveBeenCalledWith(3000);
  });

  it('logs and retains on a legacy settlement timeout', async () => {
    const instance = service(sessionId);
    const waitForCurrentTurnSettled = vi.fn(async () => 'timeout' as const);
    const sweep = vi.fn(async () => true);

    await expect(callSettle(instance, sessionId, {
      waitForCurrentTurnSettled,
      isLeadBusy: vi.fn(() => false),
    }, sweep)).resolves.toBe('retained');

    expect(sweep).not.toHaveBeenCalled();
    expect(leases(instance).has(sessionId)).toBe(true);
    expect(logger.main.error).toHaveBeenCalledWith(
      expect.stringContaining('did not settle within timeout'),
    );
  });

  it('fails closed when a provider without capture or legacy wait still reports a busy lead', async () => {
    const instance = service(sessionId);
    const isLeadBusy = vi.fn(() => true);
    const sweep = vi.fn(async () => true);

    await expect(callSettle(instance, sessionId, { isLeadBusy }, sweep))
      .resolves.toBe('retained');

    expect(isLeadBusy).toHaveBeenCalledTimes(1);
    expect(sweep).not.toHaveBeenCalled();
    expect(leases(instance).has(sessionId)).toBe(true);
  });
});
