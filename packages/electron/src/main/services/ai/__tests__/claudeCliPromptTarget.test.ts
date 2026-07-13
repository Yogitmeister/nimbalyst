import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryMocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({ AISessionsRepository: repositoryMocks }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../../WorktreeLifecycleService', () => ({
  createWorktreeLifecycleService: vi.fn(),
}));

import {
  resolveClaudeCliPromptTarget,
  resolveClaudeCliQueuedPromptTarget,
} from '../claudeCliPromptTarget';

const WORKSPACE = '/workspace';
const RETIRED_CWD = '/workspace/.nimbalyst/worktrees/deleted';

describe('claude-code-cli continuation target routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes repeated queued/wakeup delivery to one root continuation and transfers the row once', async () => {
    const retired = {
      id: 'retired-cli',
      provider: 'claude-code-cli',
      model: 'claude-code-cli:opus',
      title: 'Retired CLI work',
      workspacePath: WORKSPACE,
      worktreeId: 'wt-retired',
      worktreePath: RETIRED_CWD,
      isArchived: true,
      metadata: {
        worktreeLifecycle: {
          resumable: false,
          terminalDisposition: 'retired',
          retiredWorktreePath: RETIRED_CWD,
        },
      },
    } as any;
    let continuation: any = null;
    repositoryMocks.get.mockImplementation(async (sessionId: string) => {
      if (sessionId === retired.id) return retired;
      if (sessionId === continuation?.id) return continuation;
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
    repositoryMocks.updateMetadata.mockImplementation(async (_id: string, update: any) => {
      retired.metadata.worktreeLifecycle = {
        ...retired.metadata.worktreeLifecycle,
        ...update.metadata.worktreeLifecycle,
      };
    });

    const pending = [{
      id: 'queued-followup',
      sessionId: retired.id,
      prompt: 'continue safely',
      status: 'pending',
      createdAt: 1,
    }] as any[];
    const queueStore = {
      transferPending: vi.fn(async (source: string, target: string) => {
        const moved = pending.filter(
          (row) => row.sessionId === source && row.status === 'pending',
        );
        moved.forEach((row) => { row.sessionId = target; });
        return moved;
      }),
    };

    const first = await resolveClaudeCliQueuedPromptTarget(
      retired.id,
      WORKSPACE,
      queueStore,
    );
    const repeated = await resolveClaudeCliQueuedPromptTarget(
      retired.id,
      WORKSPACE,
      queueStore,
    );

    expect(first.sessionId).toBe(repeated.sessionId);
    expect(first.sessionId).not.toBe(retired.id);
    expect(first.cwd).toBe(WORKSPACE);
    expect(first.cwd).not.toBe(RETIRED_CWD);
    expect(first.transferredPrompts.map((row) => row.id)).toEqual(['queued-followup']);
    expect(repeated.transferredPrompts).toEqual([]);
    expect(pending).toEqual([
      expect.objectContaining({ id: 'queued-followup', sessionId: first.sessionId }),
    ]);
    expect(repositoryMocks.create).toHaveBeenCalledTimes(1);

    const directTarget = await resolveClaudeCliPromptTarget(retired.id, WORKSPACE);
    expect(directTarget.sessionId).toBe(first.sessionId);
    expect(directTarget.cwd).toBe(WORKSPACE);
  });
});
