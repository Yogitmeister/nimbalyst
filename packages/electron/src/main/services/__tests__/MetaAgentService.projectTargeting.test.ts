// [ASTRA-ORCH]
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSessionMock,
  getSessionMock,
  databaseQueryMock,
  routeResolverMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  getSessionMock: vi.fn(),
  databaseQueryMock: vi.fn(),
  routeResolverMock: vi.fn(),
}));

const CATALOG_ENTRY = {
  id: 'deepseek-v4-flash-official',
  provider: 'deepseek',
  displayName: 'DeepSeek V4 Flash',
  model: {
    persistedId: 'claude-code:deepseek-v4-flash',
    providerModelId: 'deepseek-chat',
    version: 'v4',
  },
  interfaces: [{ credentialRef: 'deepseek.api-key' }],
};

const CATALOG_RESOLUTION = {
  schemaVersion: 2,
  entries: [CATALOG_ENTRY],
  disabledIds: [],
  errors: [],
  fatalErrors: [],
};

const ROUTES = {
  main: { model: { catalogEntryId: CATALOG_ENTRY.id, persistedId: CATALOG_ENTRY.model.persistedId } },
  subagent: { model: { catalogEntryId: CATALOG_ENTRY.id, persistedId: CATALOG_ENTRY.model.persistedId } },
  consultation: { model: { catalogEntryId: CATALOG_ENTRY.id, persistedId: CATALOG_ENTRY.model.persistedId } },
};

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    create: createSessionMock,
    updateMetadata: vi.fn(),
    get: getSessionMock,
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: { create: vi.fn() } }));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({ SessionFilesRepository: {} }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  BUILT_IN_PROVIDER_CATALOG: [],
  isCatalogPersistedModelId: (model: string) => model.startsWith('claude-code:deepseek-'),
  resolveProviderCatalog: () => CATALOG_RESOLUTION,
  resolveClaudeAgentRuntimeRoutes: routeResolverMock,
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':').slice(1).join(':'), combined: id }),
    tryParse: (id: string) => {
      const index = typeof id === 'string' ? id.indexOf(':') : -1;
      return index > 0 ? { provider: id.slice(0, index), model: id.slice(index + 1), combined: id } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));
vi.mock('@nimbalyst/runtime/ai/server/providers/claudeCode/dependencyInjection', () => ({
  ClaudeCodeDeps: { providerCatalogResolutionLoader: () => CATALOG_RESOLUTION },
}));
vi.mock('@nimbalyst/runtime/ai/server/providers/claudeCode/providerRouteCredentials', () => ({
  getProviderRouteCredentialPresence: vi.fn(() => ({ 'deepseek.api-key': true })),
}));
vi.mock('@nimbalyst/runtime/ai/server/providers/claudeCode/providerRuntimeRoutePersistence', () => ({
  PROVIDER_RUNTIME_ROUTE_METADATA_KEY: 'providerRuntimeRoute',
  createDurableProviderRuntimeRouteSnapshot: vi.fn(() => ({
    main: { receipt: { resolved: { persistedModelId: CATALOG_ENTRY.model.persistedId } } },
  })),
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (value: unknown) => value }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: databaseQueryMock } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('../ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({ extractMessageText: vi.fn(), extractUserPrompts: vi.fn() }));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({ ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() } }));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MetaAgentService } from '../MetaAgentService';

const CLAUDE_PARENT = {
  id: 'parent-claude-session',
  workspacePath: '/workspace/path',
  provider: 'claude-code',
  model: 'claude-code:opus',
};

describe('MetaAgentService catalog child projection', () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    getSessionMock.mockReset().mockResolvedValue(CLAUDE_PARENT as any);
    databaseQueryMock.mockReset().mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] });
    routeResolverMock.mockReset().mockReturnValue(ROUTES);
    (MetaAgentService.getInstance() as any).aiService = { queuePromptForSession: vi.fn() };
  });

  it('derives the canonical model and exposes only safe catalog identity', async () => {
    const result = await (MetaAgentService.getInstance() as any).createChildSessionInternal(
      CLAUDE_PARENT.id,
      '/workspace/path',
      { provider: 'claude-code', claudeCodeBackend: CATALOG_ENTRY.id },
    );

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude-code',
      model: CATALOG_ENTRY.model.persistedId,
      metadata: expect.objectContaining({ providerRuntimeRoute: expect.anything() }),
    }));
    expect(result.claudeCodeBackend).toEqual({
      id: CATALOG_ENTRY.id,
      provider: CATALOG_ENTRY.provider,
      persistedModel: CATALOG_ENTRY.model.persistedId,
      model: CATALOG_ENTRY.model.providerModelId,
    });
    expect(JSON.stringify(result.claudeCodeBackend)).not.toContain('endpoint-sentinel');
    expect(JSON.stringify(result.claudeCodeBackend)).not.toContain('credential-sentinel');
  });

  it('inherits a catalog-owned parent model without Anthropic fallback', async () => {
    getSessionMock.mockResolvedValue({
      ...CLAUDE_PARENT,
      model: CATALOG_ENTRY.model.persistedId,
    } as any);

    const result = await (MetaAgentService.getInstance() as any).createChildSessionInternal(
      CLAUDE_PARENT.id,
      '/workspace/path',
      {},
    );

    expect(result.model).toBe(CATALOG_ENTRY.model.persistedId);
    expect(result.claudeCodeBackend.id).toBe(CATALOG_ENTRY.id);
  });

  it('rejects backend/model mismatch before session or spawn-gate mutation', async () => {
    routeResolverMock.mockImplementation(() => {
      throw new Error('Provider route deepseek-v4-flash-official does not match persisted model');
    });

    await expect((MetaAgentService.getInstance() as any).createChildSessionInternal(
      CLAUDE_PARENT.id,
      '/workspace/path',
      {
        provider: 'claude-code',
        model: 'claude-code:deepseek-v4-pro',
        claudeCodeBackend: CATALOG_ENTRY.id,
      },
    )).rejects.toThrow('does not match persisted model');

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(databaseQueryMock).not.toHaveBeenCalled();
  });

  it('rejects a catalog backend paired with the wrong provider before mutation', async () => {
    await expect((MetaAgentService.getInstance() as any).createChildSessionInternal(
      CLAUDE_PARENT.id,
      '/workspace/path',
      { provider: 'openai-codex', claudeCodeBackend: CATALOG_ENTRY.id },
    )).rejects.toThrow('requires provider claude-code');

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(databaseQueryMock).not.toHaveBeenCalled();
  });

  it('qualifies spawn once before creation and passes the result through', async () => {
    const result = JSON.parse(await (MetaAgentService.getInstance() as any).spawnSession(
      CLAUDE_PARENT.id,
      '/workspace/path',
      {
        prompt: 'spawn once',
        provider: 'claude-code',
        claudeCodeBackend: CATALOG_ENTRY.id,
        isolated: true,
      },
    ));

    expect(routeResolverMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(result.claudeCodeBackend.id).toBe(CATALOG_ENTRY.id);
  });
  it('preserves queued prompt whitespace, provenance and the meta-agent drive edge', async () => {
    const service = MetaAgentService.getInstance() as any;
    const payload = '  exact payload\n';
    const queue = vi.fn(async () => ({ id: 'queued-truth', prompt: payload }));
    const drive = vi.fn(async () => {});
    service.shouldBypassChildAgentExecutionForTests = () => false;
    service.aiService = { queuePromptForSession: queue, triggerQueuedPromptProcessingForSession: drive };
    getSessionMock.mockResolvedValue({ id: 'target', workspacePath: '/workspace', worktreePath: '/worktree' });
    databaseQueryMock.mockResolvedValue({ rows: [{ status: 'idle' }] });
    const result = JSON.parse(await service.sendPromptToSession('origin', 'target', '/workspace', payload));
    expect(queue).toHaveBeenCalledWith('target', payload, undefined, {
      promptProvenance: expect.objectContaining({ originSessionId: 'origin', origin: 'session-orchestration' }),
    });
    expect(result).toMatchObject({ queuedPromptId: 'queued-truth', prompt: payload, processingTriggered: true });
    expect(drive).toHaveBeenCalledWith('target', '/worktree', 'meta-agent');
  });

});
