import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryMocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({ AISessionsRepository: repositoryMocks }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../WorktreeLifecycleService', () => ({
  createWorktreeLifecycleService: vi.fn(),
}));

import { loadPromptTargetSession } from '../WorktreePromptTargetService';

const WORKSPACE = '/workspace';

describe('WorktreePromptTargetService shared execution boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads renderer/direct follow-ups in one main-workspace continuation, never the retired cwd', async () => {
    const retired = {
      id: 'retired-session',
      provider: 'claude-code',
      model: 'claude-code:sonnet',
      title: 'Retired work',
      workspacePath: WORKSPACE,
      worktreeId: 'wt-1',
      worktreePath: '/deleted/worktree',
      isArchived: true,
      metadata: {
        worktreeLifecycle: {
          resumable: false,
          terminalDisposition: 'retired',
          retiredWorktreePath: '/deleted/worktree',
        },
      },
    } as any;
    let continuation: any = null;

    repositoryMocks.get.mockImplementation(async (sessionId: string) => {
      if (sessionId === retired.id) return retired;
      if (continuation?.id === sessionId) return continuation;
      return null;
    });
    repositoryMocks.create.mockImplementation(async (payload: any) => {
      continuation = {
        ...payload,
        workspacePath: payload.workspaceId,
        worktreeId: null,
        worktreePath: null,
        isArchived: false,
      };
    });
    repositoryMocks.updateMetadata.mockImplementation(async (_sessionId: string, update: any) => {
      retired.metadata.worktreeLifecycle = {
        ...retired.metadata.worktreeLifecycle,
        ...update.metadata.worktreeLifecycle,
      };
    });
    const sessionManager = {
      loadSession: vi.fn(async (sessionId: string) =>
        sessionId === continuation?.id ? continuation : null),
    };

    const first = await loadPromptTargetSession(sessionManager, retired.id, WORKSPACE);
    const second = await loadPromptTargetSession(sessionManager, retired.id, WORKSPACE);

    expect(first.continuedFromSessionId).toBe(retired.id);
    expect(second.session.id).toBe(first.session.id);
    expect(repositoryMocks.create).toHaveBeenCalledTimes(1);
    expect(sessionManager.loadSession).not.toHaveBeenCalledWith(retired.id, WORKSPACE);
    expect(first.session.worktreePath || WORKSPACE).toBe(WORKSPACE);
    expect(first.session.worktreePath || WORKSPACE).not.toBe('/deleted/worktree');
  });
});
