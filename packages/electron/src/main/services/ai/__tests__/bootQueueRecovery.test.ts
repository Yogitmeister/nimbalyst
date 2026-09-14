// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { driveStrandedQueuesOnBoot, reconcileExecutingQueuesOnBoot } from '../bootQueueRecovery';

type DepOverrides = Partial<Omit<Parameters<typeof driveStrandedQueuesOnBoot>[0], 'requestDrive'>>;

function createDeps(overrides: DepOverrides = {}) {
  return {
    listSessionIdsWithPending: vi.fn(async () => [] as string[]),
    getWorkspacePath: vi.fn(async () => '/ws' as string | null | undefined),
    failAllPending: vi.fn(async () => 0),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    ...overrides,
    requestDrive: vi.fn<(sessionId: string, workspacePath: string) => void>(),
  };
}

describe('driveStrandedQueuesOnBoot', () => {
  it('drives each stranded session exactly once', async () => {
    const deps = createDeps({
      listSessionIdsWithPending: vi.fn(async () => ['s1', 's2', 's3']),
      getWorkspacePath: vi.fn(async (sessionId: string) => `/ws/${sessionId}`),
    });

    const driven = await driveStrandedQueuesOnBoot(deps);

    expect(driven).toBe(3);
    expect(deps.requestDrive).toHaveBeenCalledTimes(3);
    expect(deps.requestDrive.mock.calls).toEqual([
      ['s1', '/ws/s1'],
      ['s2', '/ws/s2'],
      ['s3', '/ws/s3'],
    ]);
  });

  it('drives nothing when the boot sweep left no pending rows', async () => {
    // Rows the sweep resolved (delivered-and-answered, or delivered-but-
    // unanswered) are no longer 'pending', so they must not be re-sent.
    // NIM-615 / #783.
    const deps = createDeps();

    expect(await driveStrandedQueuesOnBoot(deps)).toBe(0);
    expect(deps.requestDrive).not.toHaveBeenCalled();
    expect(deps.logInfo).not.toHaveBeenCalled();
  });

  it('fails every pending row once when a session has no workspace mapping', async () => {
    const deps = createDeps({
      listSessionIdsWithPending: vi.fn(async () => ['orphan', 'ok']),
      getWorkspacePath: vi.fn(async (sessionId: string) => (sessionId === 'ok' ? '/ws' : null)),
    });

    expect(await driveStrandedQueuesOnBoot(deps)).toBe(1);
    expect(deps.requestDrive).toHaveBeenCalledExactlyOnceWith('ok', '/ws');
    expect(deps.failAllPending).toHaveBeenCalledExactlyOnceWith(
      'orphan',
      'Queued prompt delivery failed: workspace mapping unavailable',
    );
    expect(deps.logWarn).toHaveBeenCalledOnce();
  });

  it('continues to a valid session when an earlier workspace lookup rejects', async () => {
    const deps = createDeps({
      listSessionIdsWithPending: vi.fn(async () => ['broken', 'ok']),
      getWorkspacePath: vi.fn(async (sessionId: string) => {
        if (sessionId === 'broken') {
          throw new Error('workspace /private prompt text credential provider output');
        }
        return '/ws';
      }),
    });

    expect(await driveStrandedQueuesOnBoot(deps)).toBe(1);
    expect(deps.requestDrive).toHaveBeenCalledExactlyOnceWith('ok', '/ws');
    expect(deps.failAllPending).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalledExactlyOnceWith(
      '[Main] Boot recovery: failed to recover one session; continuing',
    );
  });

  it('continues to a valid session when failing an unmapped session rejects', async () => {
    const deps = createDeps({
      listSessionIdsWithPending: vi.fn(async () => ['unmapped', 'ok']),
      getWorkspacePath: vi.fn(async (sessionId: string) => (sessionId === 'ok' ? '/ws' : null)),
      failAllPending: vi.fn(async () => {
        throw new Error('workspace /private prompt text credential provider output');
      }),
    });

    expect(await driveStrandedQueuesOnBoot(deps)).toBe(1);
    expect(deps.failAllPending).toHaveBeenCalledExactlyOnceWith(
      'unmapped',
      'Queued prompt delivery failed: workspace mapping unavailable',
    );
    expect(deps.requestDrive).toHaveBeenCalledExactlyOnceWith('ok', '/ws');
    expect(deps.logWarn).toHaveBeenCalledExactlyOnceWith(
      '[Main] Boot recovery: failed to recover one session; continuing',
    );
  });
});

describe('reconcileExecutingQueuesOnBoot', () => {
  it('retains provider-bound active ownership and settles only exact terminal/unbound claims', async () => {
    const rows = [
      {
        id: 'bound-active', sessionId: 's1', status: 'executing' as const,
        claimToken: 'claim-active', dispatchStartedAt: 1, attentionGeneration: 'generation-active',
        providerThreadId: 'thread-a', providerTurnId: 'turn-a', providerTurnState: 'active' as const,
      },
      {
        id: 'terminal', sessionId: 's1', status: 'executing' as const,
        claimToken: 'claim-terminal', dispatchStartedAt: 1, attentionGeneration: 'generation-terminal',
        providerTurnState: 'completed' as const,
      },
      {
        id: 'pre-dispatch', sessionId: 's1', status: 'executing' as const,
        claimToken: 'claim-release', attentionGeneration: 'generation-release',
      },
      {
        id: 'unbound-dispatched', sessionId: 's1', status: 'executing' as const,
        claimToken: 'claim-fail', dispatchStartedAt: 1, attentionGeneration: 'generation-fail',
        providerTurnState: 'unbound' as const,
      },
    ];
    const store = {
      listExecutingSessionIds: vi.fn(async () => ['s1']),
      listForSession: vi.fn(async () => rows),
      releaseClaim: vi.fn(async () => ({ outcome: 'settled' as const })),
      completeAfterDispatch: vi.fn(async () => ({ outcome: 'settled' as const })),
      failAfterDispatch: vi.fn(async () => ({ outcome: 'settled' as const })),
    };

    await expect(reconcileExecutingQueuesOnBoot(store)).resolves.toEqual({
      completed: 1, failed: 1, released: 1, retained: 1,
    });
    expect(store.completeAfterDispatch).toHaveBeenCalledWith(
      'terminal', 's1', 'claim-terminal', undefined, 'generation-terminal',
    );
    expect(store.releaseClaim).toHaveBeenCalledWith('pre-dispatch', 's1', 'claim-release');
    expect(store.failAfterDispatch).toHaveBeenCalledWith(
      'unbound-dispatched',
      'Host restarted before provider turn identity was available',
      's1',
      'claim-fail',
      undefined,
      'generation-fail',
    );
  });
});
