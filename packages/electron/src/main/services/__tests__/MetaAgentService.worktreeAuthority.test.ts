import { beforeEach, describe, expect, it, vi } from 'vitest';

const worktreeStoreMocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  getAllNames: vi.fn(),
}));

const gitWorktreeMocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  deleteWorktree: vi.fn(),
  generateUniqueWorktreeName: vi.fn(),
  getAllBranchNames: vi.fn(),
  getExistingWorktreeDirectories: vi.fn(),
  verifyWorktreeBinding: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    updateMetadata: vi.fn(),
  },
  AgentMessagesRepository: { create: vi.fn() },
  SessionFilesRepository: {},
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class {
    async initialize() {}
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const separator = id.indexOf(':');
      if (separator <= 0) throw new Error(`invalid model: ${id}`);
      return {
        provider: id.slice(0, separator),
        model: id.slice(separator + 1),
        combined: id,
      };
    },
    tryParse: (id: string) => {
      const separator = id.indexOf(':');
      return separator > 0
        ? { provider: id.slice(0, separator), model: id.slice(separator + 1) }
        : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../NotificationService', () => ({
  notificationService: { showNotificationWithResult: vi.fn() },
}));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (value: unknown) => value }));
vi.mock('../WorktreeStore', () => ({
  createWorktreeStore: vi.fn(() => worktreeStoreMocks),
}));
vi.mock('../GitWorktreeService', () => ({
  GitWorktreeService: class {
    createWorktree = gitWorktreeMocks.createWorktree;
    deleteWorktree = gitWorktreeMocks.deleteWorktree;
    generateUniqueWorktreeName = gitWorktreeMocks.generateUniqueWorktreeName;
    getAllBranchNames = gitWorktreeMocks.getAllBranchNames;
    getExistingWorktreeDirectories = gitWorktreeMocks.getExistingWorktreeDirectories;
    verifyWorktreeBinding = gitWorktreeMocks.verifyWorktreeBinding;
  },
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn() },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../file/GitRefWatcher', () => ({
  gitRefWatcher: { start: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository, AgentMessagesRepository } from '@nimbalyst/runtime';
import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';
import { MetaAgentService } from '../MetaAgentService';

const WORKSPACE = '/workspace';
const PARENT = {
  id: 'parent-session',
  provider: 'claude-code',
  model: 'claude-code:opus',
  workspacePath: WORKSPACE,
  worktreeId: null,
};
const FRESH_WORKTREE = {
  id: 'fresh-worktree',
  name: 'fresh-child',
  path: '/workspace_worktrees/fresh-child',
  branch: 'worktree/fresh-child',
  baseBranch: 'main',
  projectPath: WORKSPACE,
  createdAt: 1,
};
const INHERITED_WORKTREE = {
  ...FRESH_WORKTREE,
  id: 'caller-worktree',
  name: 'caller-child',
  path: '/workspace_worktrees/caller-child',
  branch: 'worktree/caller-child',
};

function identityFor(worktree: typeof FRESH_WORKTREE) {
  return {
    projectRoot: WORKSPACE,
    worktreeRoot: worktree.path,
    gitDir: `/.git/worktrees/${worktree.name}`,
    commonDir: '/.git',
    branch: worktree.branch,
    head: 'abc123',
    projectHead: 'abc123',
  };
}

describe('MetaAgentService worktree authority', () => {
  let service: any;
  let aiService: {
    queuePromptForSession: ReturnType<typeof vi.fn>;
    triggerQueuedPromptProcessingForSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(databaseWorker.query).mockResolvedValue({
      rows: [{ in_flight: '0', total: '0' }],
    } as any);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(PARENT as any);
    worktreeStoreMocks.getAllNames.mockResolvedValue(new Set());
    worktreeStoreMocks.get.mockResolvedValue(null);
    gitWorktreeMocks.getExistingWorktreeDirectories.mockReturnValue(new Set());
    gitWorktreeMocks.getAllBranchNames.mockResolvedValue(new Set());
    gitWorktreeMocks.generateUniqueWorktreeName.mockReturnValue(FRESH_WORKTREE.name);
    gitWorktreeMocks.createWorktree.mockResolvedValue(FRESH_WORKTREE);
    gitWorktreeMocks.verifyWorktreeBinding.mockResolvedValue(identityFor(FRESH_WORKTREE));
    aiService = {
      queuePromptForSession: vi.fn().mockResolvedValue({}),
      triggerQueuedPromptProcessingForSession: vi.fn().mockResolvedValue(true),
    };
    service = MetaAgentService.getInstance() as any;
    service.aiService = aiService;
  });

  it.each(['stale-worktree', 'missing-worktree', 'dirty-worktree', 'live-worktree'])(
    'rejects arbitrary %s attachment before any lookup or mutation',
    async (worktreeId) => {
      await expect(
        service.createChildSessionInternal(PARENT.id, WORKSPACE, { worktreeId })
      ).rejects.toThrow(/worktreeId attachment is not supported/);

      expect(AISessionsRepository.get).not.toHaveBeenCalled();
      expect(AISessionsRepository.create).not.toHaveBeenCalled();
      expect(worktreeStoreMocks.get).not.toHaveBeenCalled();
      expect(worktreeStoreMocks.create).not.toHaveBeenCalled();
      expect(gitWorktreeMocks.createWorktree).not.toHaveBeenCalled();
    }
  );

  it('rejects worktreeId on spawn_session before workstream or session mutation', async () => {
    await expect(
      service.spawnSession(PARENT.id, WORKSPACE, {
        prompt: 'do work',
        worktreeId: 'sibling-worktree',
      })
    ).rejects.toThrow(/worktreeId attachment is not supported/);

    expect(AISessionsRepository.get).not.toHaveBeenCalled();
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('creates and verifies a fresh binding before persisting its child session', async () => {
    const result = await service.createChildSessionInternal(PARENT.id, WORKSPACE, {
      prompt: 'implement the bounded task',
      useWorktree: true,
    });

    expect(gitWorktreeMocks.verifyWorktreeBinding).toHaveBeenCalledWith(
      WORKSPACE,
      FRESH_WORKTREE,
      { requireProjectHeadMatch: true }
    );
    expect(AISessionsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        worktreeId: FRESH_WORKTREE.id,
        createdBySessionId: PARENT.id,
      })
    );
    expect(AgentMessagesRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: result.sessionId,
        content: 'implement the bounded task',
      })
    );
    expect(result).toMatchObject({
      worktreeId: FRESH_WORKTREE.id,
      worktreePath: FRESH_WORKTREE.path,
      worktreeMode: 'new',
      queuedInitialPrompt: true,
    });
  });

  it('inherits only the caller-bound worktree after verifying its live identity', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...PARENT,
      worktreeId: INHERITED_WORKTREE.id,
    } as any);
    worktreeStoreMocks.get.mockResolvedValue(INHERITED_WORKTREE);
    gitWorktreeMocks.verifyWorktreeBinding.mockResolvedValue(identityFor(INHERITED_WORKTREE));

    const result = await service.createChildSessionInternal(PARENT.id, WORKSPACE, {
      prompt: 'continue in the caller checkout',
    });

    expect(worktreeStoreMocks.get).toHaveBeenCalledWith(INHERITED_WORKTREE.id);
    expect(gitWorktreeMocks.verifyWorktreeBinding).toHaveBeenCalledWith(
      WORKSPACE,
      INHERITED_WORKTREE
    );
    expect(gitWorktreeMocks.createWorktree).not.toHaveBeenCalled();
    expect(AISessionsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: INHERITED_WORKTREE.id })
    );
    expect(result).toMatchObject({
      worktreeId: INHERITED_WORKTREE.id,
      worktreePath: INHERITED_WORKTREE.path,
      worktreeMode: 'inherited',
    });
  });

  it('fails closed when the caller-bound worktree record is missing', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...PARENT,
      worktreeId: INHERITED_WORKTREE.id,
    } as any);
    worktreeStoreMocks.get.mockResolvedValue(null);

    await expect(
      service.createChildSessionInternal(PARENT.id, WORKSPACE, { prompt: 'continue' })
    ).rejects.toThrow(/was not found/);

    expect(gitWorktreeMocks.verifyWorktreeBinding).not.toHaveBeenCalled();
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('fails closed on an unverifiable caller binding without creating a child', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...PARENT,
      worktreeId: INHERITED_WORKTREE.id,
    } as any);
    worktreeStoreMocks.get.mockResolvedValue(INHERITED_WORKTREE);
    gitWorktreeMocks.verifyWorktreeBinding.mockRejectedValue(new Error('registered HEAD mismatch'));

    await expect(
      service.createChildSessionInternal(PARENT.id, WORKSPACE, { prompt: 'continue' })
    ).rejects.toThrow(/HEAD mismatch/);

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('requires the parent control route and a fresh initial task before mutation', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValueOnce(null as any);
    await expect(
      service.createChildSessionInternal(PARENT.id, WORKSPACE, { prompt: 'work' })
    ).rejects.toThrow(/parent control route/);

    await expect(
      service.createChildSessionInternal(PARENT.id, WORKSPACE, { useWorktree: true })
    ).rejects.toThrow(/non-empty initial prompt/);

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(gitWorktreeMocks.createWorktree).not.toHaveBeenCalled();
  });

  it('removes a fresh worktree record and checkout if binding verification fails', async () => {
    gitWorktreeMocks.verifyWorktreeBinding.mockRejectedValue(new Error('binding mismatch'));

    await expect(
      service.createChildSessionInternal(PARENT.id, WORKSPACE, {
        prompt: 'work',
        useWorktree: true,
      })
    ).rejects.toThrow(/binding mismatch/);

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(worktreeStoreMocks.delete).toHaveBeenCalledWith(FRESH_WORKTREE.id);
    expect(gitWorktreeMocks.deleteWorktree).toHaveBeenCalledWith(
      FRESH_WORKTREE.path,
      WORKSPACE
    );
  });

  it('rolls back the child and fresh binding when its initial task cannot be queued', async () => {
    service.shouldBypassChildAgentExecutionForTests = () => false;
    aiService.queuePromptForSession.mockRejectedValue(new Error('queue unavailable'));

    await expect(
      service.createChildSessionInternal(PARENT.id, WORKSPACE, {
        prompt: 'work',
        useWorktree: true,
      })
    ).rejects.toThrow(/queue unavailable/);

    expect(AISessionsRepository.delete).toHaveBeenCalledTimes(1);
    expect(worktreeStoreMocks.delete).toHaveBeenCalledWith(FRESH_WORKTREE.id);
    expect(gitWorktreeMocks.deleteWorktree).toHaveBeenCalledWith(
      FRESH_WORKTREE.path,
      WORKSPACE
    );
  });
});
