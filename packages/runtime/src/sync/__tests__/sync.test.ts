import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSyncedSessionStore } from '../SyncedSessionStore';
import type { SessionStore } from '../../ai/adapters/sessionStore';
import type { SyncProvider, SessionChange
 } from '../types';

describe('SyncedSessionStore', () => {
  let mockBaseStore: SessionStore;
  let mockSyncProvider: SyncProvider;
  let capturedChanges: { sessionId: string; change: SessionChange }[];

  beforeEach(() => {
    capturedChanges = [];

    mockBaseStore = {
      ensureReady: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
      updateMetadata: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      updateTitleIfNotNamed: vi.fn().mockResolvedValue(true),
      updateTags: vi.fn().mockResolvedValue(['alpha', 'beta']),
      claimBlitzNameIfChildNotNamed: vi.fn().mockResolvedValue({
        childClaimed: true,
        parentNamed: true,
      }),
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

  it('syncs the write-once marker with an atomic first title', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    const updated = await syncedStore.updateTitleIfNotNamed!('s-first-name', 'First title');

    expect(updated).toBe(true);
    const change = capturedChanges.find(c => c.sessionId === 's-first-name');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect(change.change.metadata).toMatchObject({
        title: 'First title',
        hasBeenNamed: true,
      });
    }
  });

  it('sets hasBeenNamed in the non-atomic compatibility fallback', async () => {
    delete mockBaseStore.updateTitleIfNotNamed;
    mockBaseStore.get = vi.fn().mockResolvedValue({ hasBeenNamed: false });
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    const updated = await syncedStore.updateTitleIfNotNamed!('s-fallback', 'Fallback title');

    expect(updated).toBe(true);
    expect(mockBaseStore.updateMetadata).toHaveBeenCalledWith('s-fallback', {
      title: 'Fallback title',
      hasBeenNamed: true,
    });
  });

  it('converges a second peer on both title and write-once state', async () => {
    const source = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });
    await source.updateTitleIfNotNamed!('s-two-peer', 'Source winner');
    const outbound = capturedChanges.find(c => c.sessionId === 's-two-peer');
    expect(outbound?.change.type).toBe('metadata_updated');

    const peerState = { title: 'Untitled', hasBeenNamed: false };
    if (outbound?.change.type === 'metadata_updated') {
      Object.assign(peerState, outbound.change.metadata);
    }
    const peerStore: SessionStore = {
      ...mockBaseStore,
      get: vi.fn().mockImplementation(async () => ({ ...peerState })),
      updateMetadata: vi.fn().mockImplementation(async (_id, patch) => Object.assign(peerState, patch)),
      updateTitleIfNotNamed: vi.fn().mockImplementation(async (_id, title) => {
        if (peerState.hasBeenNamed) return false;
        peerState.title = title;
        peerState.hasBeenNamed = true;
        return true;
      }),
    };

    expect(await peerStore.updateTitleIfNotNamed!('s-two-peer', 'Losing title')).toBe(false);
    expect(peerState).toMatchObject({ title: 'Source winner', hasBeenNamed: true });
  });

  it('syncs the complete store-resolved tag set after a delta', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    const tags = await syncedStore.updateTags!('s-tags', {
      add: ['beta'],
      remove: ['old'],
    });

    expect(tags).toEqual(['alpha', 'beta']);
    expect(mockBaseStore.updateTags).toHaveBeenCalledWith('s-tags', {
      add: ['beta'],
      remove: ['old'],
    });
    const change = capturedChanges.find(c => c.sessionId === 's-tags');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect(change.change.metadata.tags).toEqual(['alpha', 'beta']);
    }
  });

  it('syncs both sides of an atomic Blitz first-name claim', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    const result = await syncedStore.claimBlitzNameIfChildNotNamed!(
      'child-1',
      'blitz-1',
      'Blitz winner',
    );

    expect(result).toEqual({ childClaimed: true, parentNamed: true });
    const child = capturedChanges.find(c => c.sessionId === 'child-1');
    const parent = capturedChanges.find(c => c.sessionId === 'blitz-1');
    expect(child?.change.type).toBe('metadata_updated');
    expect(parent?.change.type).toBe('metadata_updated');
    if (child?.change.type === 'metadata_updated') {
      expect(child.change.metadata.hasBeenNamed).toBe(true);
    }
    if (parent?.change.type === 'metadata_updated') {
      expect(parent.change.metadata).toMatchObject({
        title: 'Blitz winner',
        hasBeenNamed: true,
      });
    }
  });
});
