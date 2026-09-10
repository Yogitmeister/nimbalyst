// [ASTRA-ORCH]
// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nimbalyst/runtime')>();
  const { atom } = await import('jotai');
  return {
    ...actual,
    MaterialSymbol: () => null,
    ProviderIcon: () => null,
    copyToClipboard: vi.fn(),
    sessionRefMapAtom: atom(new Map()),
  };
});

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ totalCount, itemContent }: { totalCount: number; itemContent: (index: number) => React.ReactNode }) => (
    <div data-testid="session-history-virtuoso">
      {Array.from({ length: totalCount }, (_, index) => (
        <React.Fragment key={index}>{itemContent(index)}</React.Fragment>
      ))}
    </div>
  ),
}));
vi.mock('../CollapsibleGroup', () => ({ CollapsibleGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../BlitzGroup', () => ({ BlitzGroup: () => null }));
vi.mock('../SuperLoopGroup', () => ({ SuperLoopGroup: () => null }));
vi.mock('../MetaAgentGroup', () => ({ MetaAgentGroup: () => null }));
vi.mock('../NewSuperLoopDialog', () => ({ NewSuperLoopDialog: () => null }));
vi.mock('../ArchiveProgress', () => ({ ArchiveProgress: () => null }));
vi.mock('../IndexBuildDialog', () => ({ IndexBuildDialog: () => null }));
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../SessionRelativeTime', () => ({ SessionRelativeTime: () => null }));
vi.mock('../FullTitleTooltip', () => ({ FullTitleTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../WorkspaceSummaryHeader', () => ({ WorkspaceSummaryHeader: () => null, generateWorkspaceAccentColor: () => '#000' }));
vi.mock('../common/AlphaBadge', () => ({ AlphaBadge: () => null }));
vi.mock('../AgentMode/ArchiveWorktreeDialog', () => ({ ArchiveWorktreeDialog: () => null }));
vi.mock('../../help', () => ({ HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../hooks/useFloatingMenu', () => ({
  FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useFloatingMenu: () => ({
    isOpen: false,
    setIsOpen: vi.fn(),
    refs: { setReference: vi.fn(), setFloating: vi.fn() },
    floatingStyles: {},
    getFloatingProps: () => ({}),
  }),
}));
vi.mock('../../hooks/useArchiveWorktreeDialog', () => ({
  useArchiveWorktreeDialog: () => ({
    dialogState: null,
    showDialog: vi.fn(),
    closeDialog: vi.fn(),
    confirmArchive: vi.fn(),
  }),
}));
vi.mock('../../hooks/useSuperLoop', () => ({ useSuperLoopDialog: () => ({ openDialog: vi.fn() }) }));
import { SessionHistory } from '../SessionHistory';
import {
  sessionListLoadingAtom,
  sessionListWorkspaceAtom,
  sessionRegistryAtom,
  sessionStoreAtom,
  sessionProcessingAtom,
  store,
  type SessionMeta,
  initWorkstreamState,
} from '../../../store';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { setCollapsedGroupsAtom } from '../../../store/atoms/agentMode';

const workspacePath = '/workspace';
const parentId = 'cache-race-parent';
const departedChildId = 'cache-race-departed-child';
const currentChildId = 'cache-race-current-child';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    sessionType: 'session',
    workspaceId: workspacePath,
    isArchived: false,
    isPinned: false,
    parentSessionId: null,
    worktreeId: null,
    childCount: 0,
    uncommittedCount: 0,
    messageCount: 0,
    ...overrides,
  };
}

const departedChild = session(departedChildId, {
  title: 'Departed child',
  parentSessionId: parentId,
});
const currentChild = session(currentChildId, {
  title: 'Replacement child',
  parentSessionId: parentId,
});
const parent = session(parentId, {
  title: 'Typed workstream',
  sessionType: 'workstream',
  childCount: 1,
});

function registryWith(...entries: SessionMeta[]): Map<string, SessionMeta> {
  return new Map(entries.map(entry => [entry.id, entry]));
}

let childRequests: Array<Deferred<{ success: true; children: SessionMeta[] }>>;
let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  childRequests = [];
  invoke = vi.fn((channel: string) => {
    if (channel === 'sessions:list') {
      return Promise.resolve({ success: true, sessions: [parent, departedChild] });
    }
    if (channel === 'sessions:list-children') {
      const request = deferred<{ success: true; children: SessionMeta[] }>();
      childRequests.push(request);
      return request.promise;
    }
    if (channel === 'blitz:list') {
      return Promise.resolve({ success: true, blitzes: [] });
    }
    return Promise.resolve({ success: true });
  });

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      invoke,
      send: vi.fn(),
      on: vi.fn(() => () => {}),
      sessionState: {
        subscribe: vi.fn().mockResolvedValue({ success: true }),
        unsubscribe: vi.fn().mockResolvedValue({ success: true }),
        getTrackedSessionIds: vi.fn().mockResolvedValue({ success: true, sessionIds: [] }),
        getRunningSessionIds: vi.fn().mockResolvedValue({ success: true, sessionIds: [] }),
        onStateChange: vi.fn(() => () => {}),
      },
    },
  });

  store.set(activeWorkspacePathAtom, workspacePath);
  store.set(sessionListWorkspaceAtom, workspacePath);
  store.set(sessionListLoadingAtom, false);
  store.set(setCollapsedGroupsAtom, []);
  store.set(sessionRegistryAtom, registryWith(parent, departedChild));
  store.set(sessionStoreAtom(departedChildId), { id: departedChildId, title: departedChild.title } as any);
  store.set(sessionStoreAtom(currentChildId), { id: currentChildId, title: currentChild.title } as any);
  store.set(sessionProcessingAtom(departedChildId), false);
  store.set(sessionProcessingAtom(currentChildId), false);
  initWorkstreamState(workspacePath);
});

afterEach(() => {
  cleanup();
  store.set(sessionRegistryAtom, new Map());
  store.set(sessionStoreAtom(departedChildId), null);
  store.set(sessionStoreAtom(currentChildId), null);
  store.set(sessionProcessingAtom(departedChildId), false);
  store.set(sessionProcessingAtom(currentChildId), false);
  store.set(activeWorkspacePathAtom, null);
  store.set(sessionListWorkspaceAtom, null);
  store.set(sessionListLoadingAtom, false);
  delete (window as any).electronAPI;
});

describe('SessionHistory workstream children cache race', () => {
  it('proves stale IPC results do not re-cache or render a departed child', async () => {
    render(
      <Provider store={store}>
        <SessionHistory />
      </Provider>,
    );

    await waitFor(() => {
      expect(childRequests).toHaveLength(1);
    });
    expect(invoke).toHaveBeenCalledWith(
      'sessions:list-children',
      parentId,
      workspacePath,
      { includeArchived: false },
    );

    // Both registry updates happen in one React batch. The first update makes
    // the parent empty; the second immediately installs the replacement child.
    // The production registry subscription must invalidate the held request
    // synchronously because the zero-child cleanup effect may never observe
    // the intermediate state.
    act(() => {
      store.set(sessionRegistryAtom, registryWith(
        session(parentId, { title: parent.title, sessionType: 'workstream', childCount: 0 }),
      ));
      store.set(sessionRegistryAtom, registryWith(
        session(parentId, { title: parent.title, sessionType: 'workstream', childCount: 1 }),
        currentChild,
      ));
    });

    await act(async () => {
      childRequests[0].resolve({ success: true, children: [departedChild] });
      await childRequests[0].promise;
    });

    await waitFor(() => {
      expect(childRequests).toHaveLength(2);
    });
    expect(screen.queryByText('Departed child')).toBeNull();

    await act(async () => {
      childRequests[1].resolve({ success: true, children: [currentChild] });
      await childRequests[1].promise;
    });

    await waitFor(() => {
      expect(screen.getByText('Replacement child')).toBeTruthy();
    });
    expect(screen.queryByText('Departed child')).toBeNull();

    // The stale response caused exactly one retry; it did not leave the
    // component in a fetch loop or keep its request marked as pending.
    await act(async () => {
      await Promise.resolve();
    });
    expect(childRequests).toHaveLength(2);
  });
});
