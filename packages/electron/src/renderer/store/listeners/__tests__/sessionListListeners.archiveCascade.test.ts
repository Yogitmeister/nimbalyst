// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import {
  agentBubbleStateAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionListWorkspaceAtom,
  sessionRegistryAtom,
} from '../../atoms/sessions';
import { initSessionListListeners } from '../sessionListListeners';

const WORKSPACE = '/workspace/current';

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    provider: 'openai-codex',
    model: 'openai-codex:gpt-5.6-terra',
    sessionType: 'session',
    workspaceId: WORKSPACE,
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...overrides,
  };
}

describe('session list archive cascade updates', () => {
  let cleanup: (() => void) | undefined;
  let handlers: Record<string, (...args: any[]) => void>;

  beforeEach(() => {
    handlers = {};
    store.set(sessionListWorkspaceAtom, WORKSPACE);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return () => delete handlers[event];
        }),
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    store.set(sessionRegistryAtom, new Map());
    for (const id of ['parent', 'child', 'sibling', 'other-parent', 'other-child']) {
      store.set(sessionHasPendingInteractivePromptAtom(id), false);
    }
  });

  it('removes direct workstream children from the Agent badge when the parent is archived', () => {
    store.set(sessionRegistryAtom, new Map([
      ['parent', session('parent', { sessionType: 'workstream', childCount: 1 })],
      ['child', session('child', { parentSessionId: 'parent' })],
    ]));
    store.set(sessionHasPendingInteractivePromptAtom('child'), true);
    expect(store.get(agentBubbleStateAtom)).toEqual({ color: 'orange', count: 1 });

    cleanup = initSessionListListeners();
    handlers['sessions:session-updated']('parent', { isArchived: true });

    expect(store.get(sessionRegistryAtom).get('parent')?.isArchived).toBe(true);
    expect(store.get(sessionRegistryAtom).get('child')?.isArchived).toBe(true);
    expect(store.get(agentBubbleStateAtom)).toEqual({ color: null, count: 0 });
  });

  it('mirrors archive and restore only to direct children of the updated parent', () => {
    store.set(sessionRegistryAtom, new Map([
      ['parent', session('parent', { sessionType: 'workstream', childCount: 1 })],
      ['child', session('child', { parentSessionId: 'parent' })],
      ['sibling', session('sibling')],
      ['other-parent', session('other-parent', { sessionType: 'workstream', childCount: 1 })],
      ['other-child', session('other-child', { parentSessionId: 'other-parent' })],
    ]));

    cleanup = initSessionListListeners();
    handlers['sessions:session-updated']('parent', { isArchived: true });

    const archived = store.get(sessionRegistryAtom);
    expect(archived.get('child')?.isArchived).toBe(true);
    expect(archived.get('sibling')?.isArchived).toBe(false);
    expect(archived.get('other-child')?.isArchived).toBe(false);

    handlers['sessions:session-updated']('parent', { isArchived: false });
    const restored = store.get(sessionRegistryAtom);
    expect(restored.get('parent')?.isArchived).toBe(false);
    expect(restored.get('child')?.isArchived).toBe(false);
    expect(restored.get('sibling')?.isArchived).toBe(false);
    expect(restored.get('other-child')?.isArchived).toBe(false);
  });
});
