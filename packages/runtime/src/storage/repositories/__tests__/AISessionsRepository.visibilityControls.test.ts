import { afterEach, describe, expect, it, vi } from 'vitest';
import { AISessionsRepository } from '../AISessionsRepository';

const baseStore = () => ({
  ensureReady: vi.fn(async () => {}),
  create: vi.fn(async () => {}),
  updateMetadata: vi.fn(async () => {}),
  get: vi.fn(async () => null),
  list: vi.fn(async () => []),
  search: vi.fn(async () => []),
  delete: vi.fn(async () => {}),
});

afterEach(() => {
  AISessionsRepository.clearStore();
  AISessionsRepository.configureVisibilityStorageFence(null);
});

describe('AISessionsRepository visibility controls', () => {
  it('constructs an exact pinned CAS and attaches the host fence out of band', async () => {
    const store = {
      ...baseStore(),
      applyVisibilityMutation: vi.fn(async () => true),
    };
    AISessionsRepository.setStore(store);
    AISessionsRepository.configureVisibilityStorageFence({ rootIdentity: 'root-a', ownerId: 'owner-a' });

    await AISessionsRepository.setPinnedVisibility(
      'session-a', true, 'mutation-a', false, '/Workspace', '/workspace',
    );

    const [sessionId, mutation] = (store.applyVisibilityMutation as any).mock.calls[0] as [string, Record<PropertyKey, unknown>];
    expect(sessionId).toBe('session-a');
    expect(mutation).toMatchObject({
      mutationId: 'mutation-a', workspacePath: '/Workspace', workspaceComparisonPath: '/workspace',
      operation: 'session_set_pinned', expected: { isPinned: false }, after: { isPinned: true },
    });
    expect(Object.keys(mutation)).not.toContain('nimbalyst.visibility-storage-fence');
    expect((mutation as Record<PropertyKey, unknown>)[Symbol.for('nimbalyst.visibility-storage-fence')])
      .toEqual({ rootIdentity: 'root-a', ownerId: 'owner-a' });
  });

  it('fails closed when the store rejects the database compare-and-swap', async () => {
    const store = { ...baseStore(), applyVisibilityMutation: vi.fn(async () => false) };
    AISessionsRepository.setStore(store);

    await expect(AISessionsRepository.renameExactSession(
      'session-a', 'Name', 'mutation-a', { title: 'Old', hasBeenNamed: false }, '/ws', '/ws',
    )).rejects.toThrow('SESSION_VISIBILITY_CAS_CONFLICT');
  });

  it('serializes same-session visibility writes', async () => {
    const applied: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const store = {
      ...baseStore(),
      applyVisibilityMutation: vi.fn(async (_id: string, mutation: { mutationId: string }) => {
        applied.push(mutation.mutationId);
        if (mutation.mutationId === 'first') await firstHeld;
        return true;
      }),
    };
    AISessionsRepository.setStore(store);

    const first = AISessionsRepository.setPinnedVisibility('session-a', true, 'first', false, '/ws', '/ws');
    const second = AISessionsRepository.setPinnedVisibility('session-a', false, 'second', true, '/ws', '/ws');
    await Promise.resolve();
    expect(applied).toEqual(['first']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(applied).toEqual(['first', 'second']);
  });
});
