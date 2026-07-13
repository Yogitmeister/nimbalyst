import { beforeEach, describe, expect, it, vi } from 'vitest';

const superLoopStoreMocks = vi.hoisted(() => ({
  getLoopByWorktreeId: vi.fn().mockResolvedValue(null),
  updateLoop: vi.fn(),
}));

vi.mock('../SuperLoopStore', () => ({
  createSuperLoopStore: () => superLoopStoreMocks,
}));

import {
  WorktreeLifecycleService,
  type WorktreeLifecycleMetadata,
} from '../WorktreeLifecycleService';

const WORKSPACE = '/repo';
const WORKTREE = {
  id: 'wt-1',
  name: 'safe-tree',
  path: '/repo_worktrees/safe-tree',
  branch: 'worktree/safe-tree',
  baseBranch: 'main',
  projectPath: WORKSPACE,
  createdAt: 1,
  isArchived: false,
};

function readyMetadata(overrides: Partial<WorktreeLifecycleMetadata> = {}) {
  return {
    phase: 'complete',
    worktreeLifecycle: {
      resultCapturedAt: 10,
      completionReportAt: 11,
      ...overrides,
    },
  };
}

function createHarness(options: {
  status?: string;
  metadata?: Record<string, unknown>;
  queueStatus?: 'pending' | 'executing';
  liveState?: { status?: string; isStreaming?: boolean } | null;
  pathExists?: boolean;
  registered?: boolean;
} = {}) {
  const sessions = [{
    id: 'session-1',
    status: options.status ?? 'idle',
    is_archived: false,
    metadata: options.metadata ?? readyMetadata(),
  }];
  const queueRows = options.queueStatus
    ? [{ session_id: 'session-1', status: options.queueStatus }]
    : [];
  const db = {
    query: vi.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM ai_sessions') && sql.includes('WHERE worktree_id')) {
        return { rows: sessions.map((session) => ({ ...session })) };
      }
      if (sql.includes('FROM queued_prompts')) {
        return { rows: queueRows };
      }
      if (sql.includes('UPDATE ai_sessions')) {
        const session = sessions.find((candidate) => candidate.id === params[0]);
        if (!session) throw new Error('missing test session');
        session.is_archived = params[1];
        session.metadata = JSON.parse(params[2]);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  let archived = false;
  const worktreeStore = {
    get: vi.fn(async () => ({ ...WORKTREE, isArchived: archived })),
    list: vi.fn(async () => archived ? [] : [{ ...WORKTREE, isArchived: false }]),
    updateArchived: vi.fn(async (_id: string, value: boolean) => { archived = value; }),
    delete: vi.fn(),
  } as any;
  const readiness = {
    projectRoot: WORKSPACE,
    worktreeRoot: WORKTREE.path,
    gitDir: '/repo/.git/worktrees/safe-tree',
    commonDir: '/repo/.git',
    branch: WORKTREE.branch,
    head: 'abc123',
    projectHead: 'abc123',
    baseBranch: WORKTREE.baseBranch,
    remoteRefsContainingHead: ['refs/remotes/origin/main'],
  };
  const registrations = options.registered === false
    ? []
    : [{ path: WORKTREE.path, branch: WORKTREE.branch, isMain: false }];
  const gitService = {
    verifyWorktreeRemovalReadiness: vi.fn().mockResolvedValue(readiness),
    deleteWorktreeSafely: vi.fn(async (
      _worktreePath: string,
      _workspacePath: string,
      beforeRemove: () => Promise<unknown>,
    ) => { await beforeRemove(); }),
    listWorktrees: vi.fn().mockResolvedValue(registrations),
  };
  const startWatcher = vi.fn().mockResolvedValue(undefined);
  const stopWatcher = vi.fn().mockResolvedValue(undefined);
  const destroySessionTerminals = vi.fn().mockResolvedValue(undefined);
  const destroyTerminal = vi.fn().mockResolvedValue(undefined);
  const deleteStoredTerminal = vi.fn();
  const updateSessionRepository = vi.fn().mockResolvedValue(undefined);
  const service = new WorktreeLifecycleService(db as any, {
    gitService: gitService as any,
    worktreeStore,
    pathExists: () => options.pathExists !== false,
    getLiveSessionState: () => options.liveState ?? null,
    stopWatcher,
    startWatcher,
    destroySessionTerminals,
    getWorktreeTerminalIds: () => ['terminal-1'],
    destroyTerminal,
    deleteStoredTerminal,
    updateSessionRepository,
    now: () => 100,
  });
  return {
    service,
    sessions,
    queueRows,
    db,
    gitService,
    worktreeStore,
    stopWatcher,
    startWatcher,
    destroySessionTerminals,
    destroyTerminal,
    deleteStoredTerminal,
    updateSessionRepository,
    get archived() { return archived; },
  };
}

describe('WorktreeLifecycleService cleanup gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    superLoopStoreMocks.getLoopByWorktreeId.mockResolvedValue(null);
  });

  it.each([
    ['running', { status: 'running' }],
    ['waiting', { liveState: { status: 'waiting_for_input' } }],
  ])('refuses a %s linked session without mutating state', async (_name, options) => {
    const harness = createHarness(options as any);

    await expect(
      harness.service.cleanupWorktree(WORKTREE.id, WORKSPACE, 'archive'),
    ).rejects.toThrow(/running or waiting/);

    expect(harness.sessions[0].is_archived).toBe(false);
    expect(harness.worktreeStore.updateArchived).not.toHaveBeenCalled();
  });

  it.each(['pending', 'executing'] as const)(
    'refuses a %s queued prompt without mutating state',
    async (queueStatus) => {
      const harness = createHarness({ queueStatus });

      await expect(
        harness.service.cleanupWorktree(WORKTREE.id, WORKSPACE, 'archive'),
      ).rejects.toThrow(new RegExp(queueStatus));

      expect(harness.sessions[0].is_archived).toBe(false);
    },
  );

  it('refuses cleanup when the captured result is missing', async () => {
    const harness = createHarness({
      metadata: readyMetadata({ resultCapturedAt: undefined }),
    });

    await expect(
      harness.service.cleanupWorktree(WORKTREE.id, WORKSPACE, 'archive'),
    ).rejects.toThrow(/no captured result/);
  });

  it('refuses cleanup when the completion artifact is missing', async () => {
    const harness = createHarness({
      metadata: readyMetadata({ completionReportAt: undefined }),
    });

    await expect(
      harness.service.cleanupWorktree(WORKTREE.id, WORKSPACE, 'archive'),
    ).rejects.toThrow(/no completion artifact or parent audit/);
  });

  it('retires linked sessions and removes a fully durable worktree', async () => {
    const harness = createHarness();

    const result = await harness.service.cleanupWorktree(
      WORKTREE.id,
      WORKSPACE,
      'archive',
    );

    expect(result.sessionIds).toEqual(['session-1']);
    expect(harness.gitService.verifyWorktreeRemovalReadiness).toHaveBeenCalledTimes(2);
    expect(harness.sessions[0].is_archived).toBe(true);
    expect((harness.sessions[0].metadata.worktreeLifecycle as any)).toMatchObject({
      terminalDisposition: 'retired',
      resumable: false,
      retiredWorktreeId: WORKTREE.id,
    });
    expect(harness.worktreeStore.updateArchived).toHaveBeenCalledWith(WORKTREE.id, true);
    expect(harness.worktreeStore.delete).not.toHaveBeenCalled();
    expect(harness.updateSessionRepository).toHaveBeenCalledWith(
      'session-1',
      true,
      expect.objectContaining({
        worktreeLifecycle: expect.objectContaining({ resumable: false }),
      }),
    );
  });

  it('uses the same lifecycle transaction for direct deletion', async () => {
    const harness = createHarness();

    await harness.service.cleanupWorktree(WORKTREE.id, WORKSPACE, 'delete');

    expect(harness.sessions[0].is_archived).toBe(true);
    expect(harness.worktreeStore.delete).toHaveBeenCalledWith(WORKTREE.id);
  });

  it('restores visible and resumable session state when removal fails', async () => {
    const harness = createHarness();
    const originalMetadata = JSON.parse(JSON.stringify(harness.sessions[0].metadata));
    harness.gitService.deleteWorktreeSafely.mockImplementation(async (
      _worktreePath: string,
      _workspacePath: string,
      beforeRemove: () => Promise<unknown>,
    ) => {
      await beforeRemove();
      throw new Error('remove failed');
    });

    await expect(
      harness.service.cleanupWorktree(WORKTREE.id, WORKSPACE, 'archive'),
    ).rejects.toThrow(/remove failed/);

    expect(harness.sessions[0].is_archived).toBe(false);
    expect(harness.sessions[0].metadata).toEqual(originalMetadata);
    expect(harness.startWatcher).toHaveBeenCalledWith(WORKTREE.path);
    expect(harness.updateSessionRepository).toHaveBeenLastCalledWith(
      'session-1',
      false,
      originalMetadata,
    );
    expect(harness.destroySessionTerminals).not.toHaveBeenCalled();
    expect(harness.destroyTerminal).not.toHaveBeenCalled();
    expect(harness.deleteStoredTerminal).not.toHaveBeenCalled();
    expect(harness.worktreeStore.updateArchived).not.toHaveBeenCalled();
  });

  it('rechecks queue emptiness after lifecycle mutation and rolls back on a race', async () => {
    const harness = createHarness();
    const originalMetadata = JSON.parse(JSON.stringify(harness.sessions[0].metadata));
    harness.gitService.verifyWorktreeRemovalReadiness.mockImplementationOnce(async () => {
      harness.queueRows.push({ session_id: 'session-1', status: 'pending' });
      return {
        projectRoot: WORKSPACE,
        worktreeRoot: WORKTREE.path,
        gitDir: '/repo/.git/worktrees/safe-tree',
        commonDir: '/repo/.git',
        branch: WORKTREE.branch,
        head: 'abc123',
        projectHead: 'abc123',
        baseBranch: WORKTREE.baseBranch,
        remoteRefsContainingHead: ['refs/remotes/origin/main'],
      };
    });

    await expect(
      harness.service.cleanupWorktree(WORKTREE.id, WORKSPACE, 'archive'),
    ).rejects.toThrow(/pending queued prompt/);

    expect(harness.sessions[0].is_archived).toBe(false);
    expect(harness.sessions[0].metadata).toEqual(originalMetadata);
    expect(harness.startWatcher).toHaveBeenCalledWith(WORKTREE.path);
  });
});

describe('WorktreeLifecycleService reconciliation', () => {
  it.each([
    ['missing path', { pathExists: false }],
    ['missing registration', { registered: false }],
  ])('retires a record with a %s and stays idempotent', async (_name, options) => {
    const harness = createHarness(options as any);

    const first = await harness.service.reconcileWorkspace(WORKSPACE);
    const second = await harness.service.reconcileWorkspace(WORKSPACE);

    expect(first.usable).toEqual([]);
    expect(first.reconciledIds).toEqual([WORKTREE.id]);
    expect(second.reconciledIds).toEqual([]);
    expect(harness.worktreeStore.updateArchived).toHaveBeenCalledTimes(1);
    expect(harness.sessions[0].is_archived).toBe(true);
    expect((harness.sessions[0].metadata.worktreeLifecycle as any)).toMatchObject({
      terminalDisposition: 'retired',
      resumable: false,
    });
  });

  it('keeps a stale row retryable when its archive marker initially fails', async () => {
    const harness = createHarness({ pathExists: false });
    harness.worktreeStore.updateArchived.mockRejectedValueOnce(new Error('archive write failed'));

    await expect(harness.service.reconcileWorkspace(WORKSPACE))
      .rejects.toThrow(/archive write failed/);

    expect(harness.archived).toBe(false);
    expect(harness.sessions[0].is_archived).toBe(true);

    const retry = await harness.service.reconcileWorkspace(WORKSPACE);
    expect(retry.reconciledIds).toEqual([WORKTREE.id]);
    expect(harness.archived).toBe(true);
  });
});
