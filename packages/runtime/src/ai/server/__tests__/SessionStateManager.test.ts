import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStartError, SessionStateManager } from '../SessionStateManager';
import type { SessionStateEvent } from '../types/SessionState';

class FakeDatabaseWorker {
  public queries: Array<{ sql: string; params?: any[] }> = [];
  public queryInterceptor?: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[] } | undefined> | { rows: any[] } | undefined;
  private workspaceIds = new Map<string, string>();

  setWorkspace(sessionId: string, workspaceId: string): void {
    this.workspaceIds.set(sessionId, workspaceId);
  }

  async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });

    const intercepted = await this.queryInterceptor?.(sql, params);
    if (intercepted) return intercepted as { rows: T[] };

    if (sql.includes('SELECT workspace_id')) {
      const sessionId = params?.[0];
      const workspaceId = typeof sessionId === 'string' ? this.workspaceIds.get(sessionId) ?? null : null;
      return { rows: workspaceId ? [{ workspace_id: workspaceId } as T] : [] };
    }

    return { rows: [] };
  }
}

describe('SessionStateManager', () => {
  let manager: SessionStateManager;
  let database: FakeDatabaseWorker;

  beforeEach(() => {
    manager = new SessionStateManager();
    database = new FakeDatabaseWorker();
    manager.setDatabase(database);
  });

  it('emits session:completed when ending an active session', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);

    await manager.startSession({
      sessionId: 'session-active',
      workspacePath: '/workspace/project',
    });

    listener.mockClear();

    await manager.endSession('session-active');

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed',
      sessionId: 'session-active',
      workspacePath: '/workspace/project',
    }));
  });

  it('emits session:completed when an active session goes idle (CLI turn boundary)', async () => {
    // NIM-806: the claude-code-cli PID watcher reports turn end via
    // updateActivity({status:'idle'}). The renderer only clears the running
    // indicator on session:completed/error/interrupted — a 'session:activity'
    // event leaves the session spinning forever. So idle must emit completed.
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);

    await manager.startSession({
      sessionId: 'session-cli',
      workspacePath: '/workspace/project',
      initialStatus: 'running',
    });

    listener.mockClear();

    await manager.updateActivity({ sessionId: 'session-cli', status: 'idle', isStreaming: false });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed',
      sessionId: 'session-cli',
    }));
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session:activity' }));

    // The session must stay active so the NEXT turn's running is still detected.
    expect(manager.isSessionActive('session-cli')).toBe(true);

    // A subsequent running->idle cycle still produces started then completed.
    listener.mockClear();
    await manager.updateActivity({ sessionId: 'session-cli', status: 'running', isStreaming: true });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'session:streaming' }));
    listener.mockClear();
    await manager.updateActivity({ sessionId: 'session-cli', status: 'idle', isStreaming: false });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'session:completed' }));
  });

  it('emits session:completed for sessions missing from active state', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);
    database.setWorkspace('session-missing', '/workspace/project');

    await manager.endSession('session-missing');

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed',
      sessionId: 'session-missing',
      workspacePath: '/workspace/project',
    }));
    expect(database.queries.some(({ sql }) => sql.includes('SELECT workspace_id'))).toBe(true);
    expect(database.queries.some(({ sql, params }) =>
      sql.includes('UPDATE ai_sessions SET status = $1') && params?.[0] === 'idle' && params?.[1] === 'session-missing'
    )).toBe(true);
  });

  it('installs and exposes one generation when start event delivery fails', async () => {
    let generationAtPersistence: string | undefined;
    database.queryInterceptor = async (sql, params) => {
      if (sql.includes('UPDATE ai_sessions') && params?.[0] === 'running') {
        generationAtPersistence = manager.getSessionState('session-start-failure')?.attentionGeneration;
      }
      return undefined;
    };
    const listener = vi.fn((event: SessionStateEvent) => {
      if (event.type === 'session:started') throw new Error('listener failed');
    });
    manager.subscribe(listener);

    let thrown: unknown;
    try {
      await manager.startSession({
        sessionId: 'session-start-failure',
        workspacePath: '/workspace/project',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SessionStartError);
    const startError = thrown as SessionStartError;
    expect(startError.attentionGeneration).toBe(generationAtPersistence);
    expect(manager.getSessionState('session-start-failure')?.attentionGeneration).toBe(
      startError.attentionGeneration,
    );
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:started',
      attentionGeneration: startError.attentionGeneration,
    }));
  });

  it('retains the owned generation when start persistence fails', async () => {
    database.queryInterceptor = async (sql, params) => {
      if (sql.includes('UPDATE ai_sessions') && params?.[0] === 'running') {
        throw new Error('database unavailable');
      }
      return undefined;
    };

    let thrown: unknown;
    try {
      await manager.startSession({ sessionId: 'session-persistence-failure' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SessionStartError);
    const startError = thrown as SessionStartError;
    expect(startError.message).toBe('database unavailable');
    expect(manager.getSessionState('session-persistence-failure')?.attentionGeneration).toBe(
      startError.attentionGeneration,
    );
    await manager.endSession('session-persistence-failure', {
      attentionGeneration: startError.attentionGeneration,
    });
    expect(manager.getSessionState('session-persistence-failure')).toBeNull();
  });

  it('returns and emits the exact generation installed for a start', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);

    const generation = await manager.startSession({
      sessionId: 'session-generation',
      workspacePath: '/workspace/project',
    });

    expect(generation).toMatch(/^session-generation:/);
    expect(manager.getSessionState('session-generation')?.attentionGeneration).toBe(generation);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:started',
      attentionGeneration: generation,
    }));
  });

  it('suppresses a delayed stale update after a replacement starts', async () => {
    const firstGeneration = await manager.startSession({
      sessionId: 'session-delayed-update',
      attentionGeneration: 'turn-a',
    });
    let releaseUpdate!: () => void;
    let updateStarted!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const updateStartedPromise = new Promise<void>((resolve) => { updateStarted = resolve; });
    database.queryInterceptor = async (sql, params) => {
      if (sql.includes('UPDATE ai_sessions') && params?.[0] === 'error') {
        updateStarted();
        await updateGate;
      }
      return undefined;
    };
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);

    const staleUpdate = manager.updateActivity({
      sessionId: 'session-delayed-update',
      status: 'error',
      attentionGeneration: firstGeneration,
    });
    await updateStartedPromise;
    const replacementStart = manager.startSession({
      sessionId: 'session-delayed-update',
      attentionGeneration: 'turn-b',
    });
    expect(manager.getSessionState('session-delayed-update')).toMatchObject({
      attentionGeneration: 'turn-b', status: 'running',
    });
    listener.mockClear();
    releaseUpdate();
    await Promise.all([staleUpdate, replacementStart]);

    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:error', attentionGeneration: firstGeneration,
    }));
    expect(manager.getSessionState('session-delayed-update')).toMatchObject({
      attentionGeneration: 'turn-b', status: 'running',
    });
    const statuses = database.queries
      .filter(({ sql }) => sql.includes('UPDATE ai_sessions SET status'))
      .map(({ params }) => params?.[0]);
    expect(statuses.slice(-2)).toEqual(['error', 'running']);
  });

  it('suppresses a delayed terminal event after a replacement starts', async () => {
    await manager.startSession({
      sessionId: 'session-delayed-end', attentionGeneration: 'turn-a',
    });
    let releaseEnd!: () => void;
    let endStarted!: () => void;
    const endGate = new Promise<void>((resolve) => { releaseEnd = resolve; });
    const endStartedPromise = new Promise<void>((resolve) => { endStarted = resolve; });
    database.queryInterceptor = async (sql, params) => {
      if (sql.includes('UPDATE ai_sessions') && params?.[0] === 'idle') {
        endStarted();
        await endGate;
      }
      return undefined;
    };
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);

    const staleEnd = manager.endSession('session-delayed-end', {
      attentionGeneration: 'turn-a',
    });
    await endStartedPromise;
    const replacementStart = manager.startSession({
      sessionId: 'session-delayed-end', attentionGeneration: 'turn-b',
    });
    listener.mockClear();
    releaseEnd();
    await Promise.all([staleEnd, replacementStart]);

    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed', attentionGeneration: 'turn-a',
    }));
    expect(manager.getSessionState('session-delayed-end')).toMatchObject({
      attentionGeneration: 'turn-b', status: 'running',
    });
    const statuses = database.queries
      .filter(({ sql }) => sql.includes('UPDATE ai_sessions SET status'))
      .map(({ params }) => params?.[0]);
    expect(statuses.slice(-2)).toEqual(['idle', 'running']);
  });

  it('rotates generation when a new prompt follows an idle CLI turn', async () => {
    await manager.startSession({
      sessionId: 'session-cli-rotation',
      attentionGeneration: 'turn-a',
    });
    await manager.updateActivity({
      sessionId: 'session-cli-rotation', status: 'idle', attentionGeneration: 'turn-a',
    });

    await manager.updateActivity({
      sessionId: 'session-cli-rotation', status: 'waiting_for_input',
    });

    const current = manager.getSessionState('session-cli-rotation');
    expect(current?.attentionGeneration).toMatch(/^session-cli-rotation:/);
    expect(current?.attentionGeneration).not.toBe('turn-a');
    expect(current?.status).toBe('waiting_for_input');
  });

  it('rejects a stale turn terminal transition after a newer generation starts', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);

    const firstGeneration = await manager.startSession({
      sessionId: 'session-race',
      workspacePath: '/workspace/project',
    });
    const secondGeneration = await manager.startSession({
      sessionId: 'session-race',
      workspacePath: '/workspace/project',
    });
    expect(secondGeneration).not.toBe(firstGeneration);

    listener.mockClear();
    await manager.endSession('session-race', { attentionGeneration: firstGeneration });

    expect(manager.getSessionState('session-race')).toMatchObject({
      attentionGeneration: secondGeneration,
      status: 'running',
    });
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session:completed' }));
  });

  it('does not let a stale generation overwrite current activity', async () => {
    const firstGeneration = await manager.startSession({ sessionId: 'session-update' });
    const secondGeneration = await manager.startSession({ sessionId: 'session-update' });

    await manager.updateActivity({
      sessionId: 'session-update',
      status: 'error',
      attentionGeneration: firstGeneration,
    });

    expect(manager.getSessionState('session-update')).toMatchObject({
      attentionGeneration: secondGeneration,
      status: 'running',
    });
  });

  it('rejects stale interrupt and liveness signals without mutation or events', async () => {
    const firstGeneration = await manager.startSession({ sessionId: 'session-stale-signals' });
    const secondGeneration = await manager.startSession({ sessionId: 'session-stale-signals' });
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);
    listener.mockClear();
    const state = manager.getSessionState('session-stale-signals')!;
    const lastActivity = state.lastActivity;
    const queryCount = database.queries.length;

    manager.markTurnAlive('session-stale-signals', firstGeneration);
    await manager.interruptSession('session-stale-signals', {
      attentionGeneration: firstGeneration,
    });

    expect(manager.getSessionState('session-stale-signals')).toMatchObject({
      attentionGeneration: secondGeneration,
      status: 'running',
    });
    expect(state.lastActivity).toBe(lastActivity);
    expect(database.queries).toHaveLength(queryCount);
    expect(listener).not.toHaveBeenCalled();
  });

  it('accepts current-generation update, liveness, and terminal signals', async () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);
    const generation = await manager.startSession({ sessionId: 'session-current-signals' });
    listener.mockClear();

    await manager.updateActivity({
      sessionId: 'session-current-signals',
      status: 'waiting_for_input',
      attentionGeneration: generation,
    });
    manager.markTurnAlive('session-current-signals', generation);
    await manager.endSession('session-current-signals', { attentionGeneration: generation });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:waiting', attentionGeneration: generation,
    }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:activity', attentionGeneration: generation,
    }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:completed', attentionGeneration: generation,
    }));
    expect(manager.getSessionState('session-current-signals')).toBeNull();
  });

  it('preserves liveness events for not-yet-tracked child sessions', () => {
    const listener = vi.fn<(event: SessionStateEvent) => void>();
    manager.subscribe(listener);

    manager.markTurnAlive('session-untracked-child', 'child-turn');

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session:activity',
      sessionId: 'session-untracked-child',
      attentionGeneration: 'child-turn',
    }));
    expect(manager.getSessionState('session-untracked-child')).toBeNull();
  });
});
