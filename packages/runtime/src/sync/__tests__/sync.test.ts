// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMessageSyncHandler, createSyncedSessionStore } from '../SyncedSessionStore';
import type { SessionStore } from '../../ai/adapters/sessionStore';
import type { SyncProvider, SessionChange
 } from '../types';

describe('SyncedSessionStore', () => {
  let mockBaseStore: SessionStore;
  let mockSyncProvider: SyncProvider;
  let capturedChanges: { sessionId: string; change: SessionChange }[];
  let persistedSessions: Map<string, any>;

  beforeEach(() => {
    capturedChanges = [];
    persistedSessions = new Map();

    mockBaseStore = {
      ensureReady: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(async (payload: any) => {
        persistedSessions.set(payload.id, {
          ...payload,
          workspacePath: payload.workspaceId,
          messages: [],
          createdAt: payload.createdAt ?? 1,
          updatedAt: payload.updatedAt ?? 1,
        });
      }),
      updateMetadata: vi.fn().mockResolvedValue(undefined),
      applyVisibilityMutation: vi.fn().mockResolvedValue(true),
      hasVisibilityMutation: vi.fn().mockResolvedValue(true),
      get: vi.fn(async (sessionId: string) => persistedSessions.get(sessionId) ?? null),
      list: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      updateTitleIfNotNamed: vi.fn().mockResolvedValue(true),
    };

    mockSyncProvider = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      disconnectAll: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue({ connected: true, syncing: false, lastSyncedAt: Date.now(), error: null }),
      onStatusChange: vi.fn().mockReturnValue(() => {}),
      onRemoteChange: vi.fn().mockReturnValue(() => {}),
      pushChange: vi.fn((sessionId: string, change: SessionChange) => {
        capturedChanges.push({ sessionId, change });
      }),
    };
  });

  it('forwards atomic visibility mutations and publishes only public fields', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    const mutation = {
      mutationId: 'host-only-mutation-id',
      workspacePath: 'C:\\repo',
      workspaceComparisonPath: 'c:/repo',
      operation: 'session_set_pinned' as const,
      expected: { isPinned: false },
      after: { isPinned: true },
    };

    await expect(syncedStore.applyVisibilityMutation?.('target', mutation)).resolves.toBe(true);
    expect(mockBaseStore.applyVisibilityMutation).toHaveBeenCalledWith('target', mutation);
    expect(capturedChanges).toEqual([{
      sessionId: 'target',
      change: { type: 'metadata_updated', metadata: { isPinned: true } },
    }]);
    expect(JSON.stringify(capturedChanges)).not.toContain('host-only-mutation-id');

    await expect(syncedStore.hasVisibilityMutation?.(
      'target', mutation.mutationId, 'exact-fingerprint',
    )).resolves.toBe(true);
    expect(mockBaseStore.hasVisibilityMutation).toHaveBeenCalledWith(
      'target', mutation.mutationId, 'exact-fingerprint',
    );
  });

  it('retires a stalled visibility write without publishing stale output', async () => {
    let releaseMutation!: (value: boolean) => void;
    const mutationGate = new Promise<boolean>((resolve) => { releaseMutation = resolve; });
    mockBaseStore.applyVisibilityMutation = vi.fn(() => mutationGate);
    const staleStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    const mutation = {
      mutationId: 'stale-mutation',
      workspacePath: 'C:\\repo',
      workspaceComparisonPath: 'c:/repo',
      operation: 'session_set_pinned' as const,
      expected: { isPinned: false },
      after: { isPinned: true },
    };

    const staleWrite = staleStore.applyVisibilityMutation?.('target', mutation);
    await Promise.resolve();
    await staleStore.dispose?.();
    releaseMutation(true);
    await expect(staleWrite).rejects.toThrow('SYNCED_SESSION_STORE_DISPOSED');
    expect(mockSyncProvider.pushChange).not.toHaveBeenCalled();

    mockBaseStore.applyVisibilityMutation = vi.fn().mockResolvedValue(true);
    const currentStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    await expect(currentStore.applyVisibilityMutation?.('target', {
      ...mutation,
      mutationId: 'current-mutation',
    })).resolves.toBe(true);
  });

  it('should pass title and provider when creating a session', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.create({
      id: 'test-session-123',
      title: 'My Test Session',
      provider: 'claude-code',
      model: 'claude-3-opus',
      mode: 'agent',
      workspaceId: 'workspace-1',
    });

    // Verify base store was called
    expect(mockBaseStore.create).toHaveBeenCalledWith({
      id: 'test-session-123',
      title: 'My Test Session',
      provider: 'claude-code',
      model: 'claude-3-opus',
      mode: 'agent',
      workspaceId: 'workspace-1',
    });

    // Verify sync provider received the metadata
    expect(capturedChanges).toHaveLength(1);
    expect(capturedChanges[0].sessionId).toBe('test-session-123');
    expect(capturedChanges[0].change.type).toBe('metadata_updated');

    if (capturedChanges[0].change.type === 'metadata_updated') {
      const metadata = capturedChanges[0].change.metadata;
      expect(metadata.title).toBe('My Test Session');
      expect(metadata.provider).toBe('claude-code');
      expect(metadata.model).toBe('claude-3-opus');
      expect(metadata.mode).toBe('agent');
    }
  });

  it('create() returns after local persistence even when sync connect is slow', async () => {
    // Regression coverage for GitHub #705: creating a new empty session should
    // only wait for local persistence, not for the session-room WebSocket.
    let resolveConnect!: () => void;
    const connectPromise = new Promise<void>(resolve => {
      resolveConnect = resolve;
    });
    mockSyncProvider.connect = vi.fn().mockReturnValue(connectPromise);

    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    let createResolved = false;
    const createPromise = syncedStore.create({
      id: 'slow-sync-session',
      title: 'Slow Sync Session',
      provider: 'claude-code',
      workspaceId: 'workspace-1',
    } as any).then(() => {
      createResolved = true;
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockBaseStore.create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'slow-sync-session',
    }));
    expect(mockSyncProvider.connect).toHaveBeenCalledWith('slow-sync-session');
    expect(createResolved).toBe(true);
    expect(capturedChanges).toHaveLength(1);
    expect(capturedChanges[0].sessionId).toBe('slow-sync-session');

    resolveConnect();
    await connectPromise;
    await Promise.resolve();

    expect(capturedChanges).toHaveLength(1);

    await createPromise;
  });

  it('should pass title when updating metadata', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    // Pre-connect the session
    await mockSyncProvider.connect('test-session-456');

    await syncedStore.updateMetadata('test-session-456', {
      title: 'Updated Title',
      mode: 'planning',
    });

    // Find the metadata_updated change (skip the connect)
    const metadataChange = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(metadataChange).toBeDefined();

    if (metadataChange?.change.type === 'metadata_updated') {
      expect(metadataChange.change.metadata.title).toBe('Updated Title');
      expect(metadataChange.change.metadata.mode).toBe('planning');
    }
  });

  it('pushes isPinned through updateMetadata without bumping updatedAt', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-pin', { isPinned: true } as any);

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect((change.change.metadata as any).isPinned).toBe(true);
      // isPinned is not sort-relevant; updatedAt must NOT be bumped or the
      // session jumps to the top of the iOS list on every pin/unpin.
      expect(change.change.metadata.updatedAt).toBeUndefined();
    }
  });

  it('pushes parentSessionId reparent (value -> value) through updateMetadata', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-reparent', { parentSessionId: 'new-parent' });

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect((change.change.metadata as any).parentSessionId).toBe('new-parent');
    }
  });

  it('pushes phase and tags from the metadata blob through updateMetadata', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-mcp', {
      metadata: { phase: 'implementing', tags: ['foo', 'bar'] },
    });

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect((change.change.metadata as any).phase).toBe('implementing');
      expect((change.change.metadata as any).tags).toEqual(['foo', 'bar']);
    }
  });

  it('pushes top-level hasBeenNamed through updateMetadata', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-named', {
      hasBeenNamed: true,
    } as any);

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect((change.change.metadata as any).hasBeenNamed).toBe(true);
    }
  });

  it('does NOT push when only local-only fields change', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-local-only', {
      lastDocumentState: { filePath: '/foo.md', contentHash: 'abc' },
    });

    // No metadata_updated should have been pushed.
    const metadataChanges = capturedChanges.filter(c => c.change.type === 'metadata_updated');
    expect(metadataChanges).toHaveLength(0);
    // But the local DB write must still have happened.
    expect(mockBaseStore.updateMetadata).toHaveBeenCalled();
  });

  it('pushes only sync-relevant fields when mixed with local-only fields', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-mixed', {
      isPinned: true,
      lastDocumentState: { filePath: '/foo.md', contentHash: 'abc' },
    } as any);

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      const m = change.change.metadata as any;
      expect(m.isPinned).toBe(true);
      // lastDocumentState must NOT leak onto the wire.
      expect(m.lastDocumentState).toBeUndefined();
    }
  });

  it('bumps updatedAt for sort-relevant changes (title) but not for pins', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-title', { title: 'Renamed' });
    await syncedStore.updateMetadata('s-pin-only', { isPinned: false } as any);

    const titleChange = capturedChanges.find(c => c.sessionId === 's-title');
    const pinChange = capturedChanges.find(c => c.sessionId === 's-pin-only');
    expect(titleChange?.change.type).toBe('metadata_updated');
    expect(pinChange?.change.type).toBe('metadata_updated');
    if (titleChange?.change.type === 'metadata_updated') {
      expect(typeof titleChange.change.metadata.updatedAt).toBe('number');
    }
    if (pinChange?.change.type === 'metadata_updated') {
      expect(pinChange.change.metadata.updatedAt).toBeUndefined();
    }
  });

  it('create() pushes structural fields and naming metadata from the create payload', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.create({
      id: 's-workstream',
      title: 'Workstream Root',
      provider: 'claude-code',
      workspaceId: 'workspace-1',
      sessionType: 'workstream',
      parentSessionId: 'p-1',
      worktreeId: 'wt-1',
      hasBeenNamed: true,
    } as any);

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      const m = change.change.metadata as any;
      expect(m.sessionType).toBe('workstream');
      expect(m.parentSessionId).toBe('p-1');
      expect(m.worktreeId).toBe('wt-1');
      expect(m.hasBeenNamed).toBe(true);
      // create() always carries a fresh updatedAt so iOS sorts the new session.
      expect(typeof m.updatedAt).toBe('number');
    }
  });

  it('keeps autoConnect enabled when the option is omitted', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    await syncedStore.create({
      id: 'default-connect',
      title: 'Default connect',
      provider: 'claude-code',
      workspaceId: 'workspace-1',
    } as any);
    expect(mockSyncProvider.connect).toHaveBeenCalledWith('default-connect');
  });

  it('publishes deletion and disconnects an already connected session', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    await syncedStore.create({
      id: 'delete-me',
      title: 'Delete me',
      provider: 'claude-code',
      workspaceId: 'workspace-1',
    } as any);
    await syncedStore.updateTitleIfNotNamed?.('delete-me', 'Delete me');
    await syncedStore.delete('delete-me');
    expect(capturedChanges).toContainEqual({
      sessionId: 'delete-me',
      change: { type: 'session_deleted' },
    });
    expect(mockSyncProvider.disconnect).toHaveBeenCalledWith('delete-me');
  });

  it('retains a durable create fact until an index frame is accepted', async () => {
    const obligations = new Map<string, any>();
    mockBaseStore.createWithSyncPublicationObligation = vi.fn(async (payload: any, obligation: any) => {
      await mockBaseStore.create(payload);
      obligations.set(payload.id, obligation);
    });
    mockBaseStore.clearSyncPublicationObligation = vi.fn(async (sessionId: string, obligationId: string) => {
      const obligation = obligations.get(sessionId);
      if (!obligation || obligation.obligationId !== obligationId) return false;
      obligations.delete(sessionId);
      return true;
    });
    mockBaseStore.hasSyncPublicationObligation = vi.fn(async (sessionId: string, obligationId: string) => (
      obligations.get(sessionId)?.obligationId === obligationId
    ));
    mockSyncProvider.pushMetadataChangeWithResult = vi.fn().mockResolvedValue({
      outcome: 'index_frame_written', attempted: true, indexFrameWritten: true,
    });

    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    await syncedStore.create({
      id: 'durable-create',
      title: 'Durable create',
      provider: 'claude-code',
      workspaceId: 'workspace-1',
    } as any);
    await vi.waitFor(() => expect(mockBaseStore.clearSyncPublicationObligation).toHaveBeenCalled());
    expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledWith(
      'durable-create',
      expect.objectContaining({ workspaceId: 'workspace-1' }),
    );
    expect(obligations.size).toBe(0);
  });

  it('does not create a durable obligation for a filtered session', async () => {
    mockBaseStore.createWithSyncPublicationObligation = vi.fn();
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      syncFilter: () => false,
    });
    await syncedStore.create({
      id: 'filtered-create',
      title: 'Filtered',
      provider: 'claude-code',
      workspaceId: 'workspace-1',
    } as any);
    expect(mockBaseStore.create).toHaveBeenCalled();
    expect(mockBaseStore.createWithSyncPublicationObligation).not.toHaveBeenCalled();
  });

  it('rediscovers an unsuccessful durable publication after reconstruction', async () => {
    const obligation = {
      obligationId: 'obligation-retry',
      sessionId: 'retry-session',
      workspaceId: 'workspace-1',
      createdAt: 1,
    };
    persistedSessions.set('retry-session', {
      id: 'retry-session', title: 'Retry', workspaceId: 'workspace-1', provider: 'claude-code',
    });
    mockBaseStore.listSyncPublicationObligations = vi.fn().mockResolvedValue([obligation]);
    mockBaseStore.hasSyncPublicationObligation = vi.fn().mockResolvedValue(true);
    mockBaseStore.clearSyncPublicationObligation = vi.fn().mockResolvedValue(true);
    mockSyncProvider.pushMetadataChangeWithResult = vi.fn()
      .mockResolvedValueOnce({ outcome: 'queued', attempted: true, indexFrameWritten: false })
      .mockResolvedValueOnce({ outcome: 'index_frame_written', attempted: true, indexFrameWritten: true });

    const firstStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    await firstStore.ensureReady();
    await vi.waitFor(() => expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(1));
    await firstStore.dispose?.();

    const reconstructedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    await reconstructedStore.ensureReady();
    await vi.waitFor(() => expect(mockBaseStore.clearSyncPublicationObligation).toHaveBeenCalledWith(
      'retry-session', 'obligation-retry',
    ));
  });

  it('preserves message handler publication outcomes and metadata timestamp', async () => {
    mockSyncProvider.pushChange = vi.fn()
      .mockResolvedValueOnce({ published: false, reason: 'queued', retryable: true })
      .mockResolvedValueOnce({ published: true });
    const handler = createMessageSyncHandler(mockSyncProvider);
    const outcome = await handler.onMessageCreated({
      id: 'message-1', sessionId: 'message-session',
    } as any, 123);
    expect(outcome).toEqual({ published: false, reason: 'queued', retryable: true });
    expect(mockSyncProvider.pushChange).toHaveBeenLastCalledWith('message-session', {
      type: 'metadata_updated', metadata: { updatedAt: 123 },
    });
  });

  it('holds all successor mutations behind an admitted durable create publication', async () => {
    let releasePublication!: (value: any) => void;
    const publicationGate = new Promise((resolve) => { releasePublication = resolve; });
    const events: string[] = [];
    mockBaseStore.createWithSyncPublicationObligation = vi.fn(async (payload: any) => {
      await mockBaseStore.create(payload);
    });
    mockBaseStore.hasSyncPublicationObligation = vi.fn().mockResolvedValue(true);
    mockBaseStore.clearSyncPublicationObligation = vi.fn().mockResolvedValue(true);
    mockSyncProvider.pushMetadataChangeWithResult = vi.fn(() => publicationGate) as any;
    mockSyncProvider.pushChange = vi.fn(async (_sessionId: string, change: SessionChange) => {
      events.push(change.type);
    });
    const store = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    await store.create({
      id: 'ordered-session', title: 'Ordered', provider: 'claude-code', workspaceId: 'workspace-1',
    } as any);
    await vi.waitFor(() => expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(1));

    const metadata = store.updateMetadata('ordered-session', { title: 'Metadata' });
    const visibility = store.applyVisibilityMutation?.('ordered-session', {
      mutationId: 'ordered', workspacePath: 'C:\\repo', workspaceComparisonPath: 'c:/repo',
      operation: 'session_set_pinned' as const, expected: {}, after: { isPinned: true },
    });
    const title = store.updateTitleIfNotNamed?.('ordered-session', 'Title');
    const deleted = store.delete('ordered-session');
    await Promise.resolve();
    expect(mockBaseStore.updateMetadata).not.toHaveBeenCalled();
    expect(mockBaseStore.applyVisibilityMutation).not.toHaveBeenCalled();
    expect(mockBaseStore.updateTitleIfNotNamed).not.toHaveBeenCalled();
    expect(mockBaseStore.delete).not.toHaveBeenCalled();

    releasePublication({ outcome: 'index_frame_written', attempted: true, indexFrameWritten: true });
    await Promise.all([metadata, visibility, title, deleted]);
    expect(events).toEqual([
      'metadata_updated', 'metadata_updated', 'metadata_updated', 'session_deleted',
    ]);
  });

  it('does not let a queued successor mutate after disposal returns', async () => {
    let releasePublication!: (value: any) => void;
    const publicationGate = new Promise((resolve) => { releasePublication = resolve; });
    mockBaseStore.createWithSyncPublicationObligation = vi.fn(async (payload: any) => {
      await mockBaseStore.create(payload);
    });
    mockBaseStore.hasSyncPublicationObligation = vi.fn().mockResolvedValue(true);
    mockBaseStore.clearSyncPublicationObligation = vi.fn().mockResolvedValue(true);
    mockSyncProvider.pushMetadataChangeWithResult = vi.fn(() => publicationGate) as any;
    const store = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    await store.create({
      id: 'dispose-ordered', title: 'Dispose ordered', provider: 'claude-code', workspaceId: 'workspace-1',
    } as any);
    await vi.waitFor(() => expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(1));

    const successor = store.updateMetadata('dispose-ordered', { title: 'Must not land' });
    const successorOutcome = successor.catch((error) => error);
    await store.dispose?.();
    expect(mockBaseStore.updateMetadata).not.toHaveBeenCalled();

    releasePublication({ outcome: 'index_frame_written', attempted: true, indexFrameWritten: true });
    await expect(successorOutcome).resolves.toMatchObject({
      message: 'SYNCED_SESSION_STORE_DISPOSED',
    });
    await Promise.resolve();
    expect(mockBaseStore.updateMetadata).not.toHaveBeenCalled();
  });

  it('retires a cleared late-scan job without publishing or retrying', async () => {
    const obligation = {
      obligationId: 'cleared-obligation', sessionId: 'cleared-session',
      workspaceId: 'workspace-1', createdAt: 1,
    };
    persistedSessions.set(obligation.sessionId, {
      id: obligation.sessionId, title: 'Cleared', workspaceId: obligation.workspaceId, provider: 'claude-code',
    });
    let checked!: () => void;
    const checkedPromise = new Promise<void>((resolve) => { checked = resolve; });
    mockBaseStore.listSyncPublicationObligations = vi.fn().mockResolvedValue([obligation]);
    mockBaseStore.hasSyncPublicationObligation = vi.fn(async () => {
      checked();
      return false;
    });
    mockBaseStore.clearSyncPublicationObligation = vi.fn().mockResolvedValue(false);
    mockSyncProvider.pushMetadataChangeWithResult = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      const store = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      await store.ensureReady();
      await checkedPromise;
      await Promise.resolve();

      expect(mockBaseStore.hasSyncPublicationObligation).toHaveBeenCalledWith(
        obligation.sessionId, obligation.obligationId,
      );
      expect(mockSyncProvider.pushMetadataChangeWithResult).not.toHaveBeenCalled();
      expect(mockBaseStore.clearSyncPublicationObligation).not.toHaveBeenCalled();
      expect(timeoutSpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('retires a replaced job and publishes only the current obligation identity', async () => {
    const oldObligation = {
      obligationId: 'old-obligation', sessionId: 'replacement-session',
      workspaceId: 'workspace-1', createdAt: 1,
    };
    const currentObligation = { ...oldObligation, obligationId: 'current-obligation', createdAt: 2 };
    const session = {
      id: oldObligation.sessionId, title: 'Replacement',
      workspaceId: oldObligation.workspaceId, provider: 'claude-code',
    };
    let current = oldObligation;
    let releaseFirstRead!: () => void;
    let firstReadStarted!: () => void;
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const firstReadStartedPromise = new Promise<void>((resolve) => { firstReadStarted = resolve; });
    let readCount = 0;
    mockBaseStore.get = vi.fn(async () => {
      readCount += 1;
      if (readCount === 1) {
        firstReadStarted();
        await firstReadGate;
      }
      return session as any;
    });
    mockBaseStore.listSyncPublicationObligations = vi.fn()
      .mockResolvedValueOnce([oldObligation])
      .mockResolvedValueOnce([currentObligation]);
    let oldCompared!: () => void;
    const oldComparedPromise = new Promise<void>((resolve) => { oldCompared = resolve; });
    mockBaseStore.hasSyncPublicationObligation = vi.fn(async (_sessionId, obligationId) => {
      if (obligationId === oldObligation.obligationId) oldCompared();
      return current.obligationId === obligationId;
    });
    let currentCleared!: () => void;
    const currentClearedPromise = new Promise<void>((resolve) => { currentCleared = resolve; });
    mockBaseStore.clearSyncPublicationObligation = vi.fn(async (_sessionId, obligationId) => {
      if (obligationId !== current.obligationId) return false;
      currentCleared();
      return true;
    });
    mockSyncProvider.pushMetadataChangeWithResult = vi.fn().mockResolvedValue({
      outcome: 'index_frame_written', attempted: true, indexFrameWritten: true,
    });
    const store = createSyncedSessionStore(mockBaseStore, mockSyncProvider);

    await store.ensureReady();
    await firstReadStartedPromise;
    current = currentObligation;
    releaseFirstRead();
    await oldComparedPromise;
    await Promise.resolve();
    expect(mockSyncProvider.pushMetadataChangeWithResult).not.toHaveBeenCalled();
    expect(mockBaseStore.clearSyncPublicationObligation).not.toHaveBeenCalled();

    await store.ensureReady();
    await currentClearedPromise;
    expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(1);
    expect(mockBaseStore.clearSyncPublicationObligation).toHaveBeenCalledWith(
      currentObligation.sessionId, currentObligation.obligationId,
    );
  });
});
