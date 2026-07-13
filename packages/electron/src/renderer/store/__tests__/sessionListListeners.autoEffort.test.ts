import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';

// sessionListListeners intentionally imports the renderer store barrel in
// production. Keep this unit test on the store boundary it exercises instead
// of loading unrelated editor exports (and Monaco's browser-only CSS).
vi.mock('../index', async () => ({
  store: (await import('@nimbalyst/runtime/store')).store,
}));

import {
  sessionAutoEffortLastAtom,
  sessionListWorkspaceAtom,
  sessionStoreAtom,
} from '../atoms/sessions';
import { initSessionListListeners } from '../listeners/sessionListListeners';

type EventHandler = (...args: any[]) => void;

describe('session list auto-effort metadata propagation', () => {
  let handlers: Map<string, EventHandler>;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    handlers = new Map();
    vi.stubGlobal('window', {
      electronAPI: {
        on: vi.fn((channel: string, handler: EventHandler) => {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        }),
      },
    });
    cleanup = initSessionListListeners();
  });

  afterEach(() => {
    cleanup?.();
    vi.unstubAllGlobals();
  });

  it('merges the per-turn record into the loaded session atom immediately', () => {
    const sessionId = 'auto-effort-session';
    store.set(sessionListWorkspaceAtom, '/workspace');
    store.set(sessionStoreAtom(sessionId), {
      id: sessionId,
      title: 'Auto effort',
      provider: 'claude-code',
      model: 'claude-code:opus',
      mode: 'agent',
      messages: [],
      metadata: { effortLevel: 'high', effortPolicy: 'auto' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    handlers.get('sessions:session-updated')?.(sessionId, {
      autoEffortLast: {
        effort: 'max',
        tier: 'REASONING',
        effortPolicy: 'auto',
        source: 'policy',
        at: 123,
      },
      autoEffortCounters: { total: 1 },
    });

    expect(store.get(sessionAutoEffortLastAtom(sessionId))).toEqual({
      effort: 'max',
      tier: 'REASONING',
      effortPolicy: 'auto',
      source: 'policy',
      at: 123,
    });
    expect((store.get(sessionStoreAtom(sessionId))?.metadata as any).autoEffortCounters).toEqual({ total: 1 });
  });
});
