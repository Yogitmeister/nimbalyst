import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
  },
  AgentMessagesRepository: {
    create: vi.fn(),
  },
  SessionFilesRepository: {},
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class {
    async initialize() {}
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      if (i <= 0) throw new Error(`invalid model: ${id}`);
      const provider = id.slice(0, i);
      const model = id.slice(i + 1);
      return { provider, model, combined: `${provider}:${model}` };
    },
    tryParse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({
  createWorktreeStore: () => ({
    get: vi.fn(),
    getAllNames: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  }),
}));
vi.mock('../GitWorktreeService', () => ({
  GitWorktreeService: class {
    getExistingWorktreeDirectories() { return []; }
    getAllBranchNames() { return []; }
    generateUniqueWorktreeName(names: Set<string>) { return 'test-worktree'; }
    async createWorktree(workspaceId: string, opts: { name: string }) {
      return { id: 'wt-1', path: '/workspace/.worktree/test-worktree', name: opts.name, branch: 'feature', baseBranch: 'main' };
    }
  },
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn() } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: { start: vi.fn().mockReturnValue(Promise.resolve()) } }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({
  startMetaAgentServer: vi.fn(),
  setMetaAgentToolFns: vi.fn(),
  shutdownMetaAgentServer: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { MetaAgentService } from '../MetaAgentService';

describe('MetaAgentService worktree dispatch regression (NIM-395)', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
  });

  it('dispatches queued prompt using canonical workspaceId, not worktreePath', async () => {
    const service = MetaAgentService.getInstance();
    const queuedPrompts: Array<{ sessionId: string; workspacePath: string }> = [];

    (service as any).aiService = {
      queuePromptForSession: vi.fn(),
      triggerQueuedPromptProcessingForSession: vi.fn(async (sessionId: string, workspacePath: string) => {
        queuedPrompts.push({ sessionId, workspacePath });
        return true;
      }),
    };

    // Force non-test execution path so the trigger call is reached
    delete (process.env as any).NODE_ENV;
    delete (process.env as any).PLAYWRIGHT;
    delete (process.env as any).PLAYWRIGHT_TEST;

    await (service as any).createChildSessionInternal('parent', '/canonical/workspace', {
      prompt: 'do work',
      useWorktree: true,
    });

    expect(queuedPrompts).toHaveLength(1);
    expect(queuedPrompts[0].workspacePath).toBe('/canonical/workspace');
    expect(queuedPrompts[0].workspacePath).not.toMatch(/\.worktree/);
  });
});
