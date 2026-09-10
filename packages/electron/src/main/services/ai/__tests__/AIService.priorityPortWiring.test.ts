// [ASTRA-ORCH]
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  databaseQuery: vi.fn(),
  getProvider: vi.fn(),
  inboxCurrent: vi.fn(),
  inboxEnd: vi.fn(),
  mobileContexts: [] as Array<Record<string, any>>,
  mobileInitialize: vi.fn(),
  stateGet: vi.fn(),
  stateInterrupt: vi.fn(),
  stateSetDatabase: vi.fn(),
  sweepExecuting: vi.fn(),
}));

vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: {} }));

vi.mock('@nimbalyst/runtime', () => ({
  DocumentContextService: class {
    setPersistCallback() {}
  },
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  AIProvider: class {},
  SessionManager: class {
    cleanupAllSessions() { return 0; }
  },
  ProviderFactory: { getProvider: harness.getProvider },
  ModelRegistry: {},
  isAskUserQuestionProvider: () => false,
  ClaudeCodeProvider: class {
    static setCustomClaudeCodePathLoader() {}
    static getCachedSdkSlashCommands() { return []; }
    static getCachedSdkSkills() { return []; }
  },
  OpenCodeProvider: class {
    static getCachedSdkSlashCommands() { return []; }
  },
  getBuiltInProviderControlEntry: () => undefined,
  resolveProviderControlSnapshot: () => undefined,
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({
    getSessionState: harness.stateGet,
    interruptSession: harness.stateInterrupt,
    setDatabase: harness.stateSetDatabase,
  }),
}));

vi.mock('../sessionInboxService', () => ({
  sessionInbox: {
    current: harness.inboxCurrent,
    end: harness.inboxEnd,
  },
}));

vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: { query: harness.databaseQuery },
}));

vi.mock('../../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({ sweepExecutingForSession: harness.sweepExecuting }),
}));

vi.mock('../MobileSyncHandler', () => ({
  MobileSyncHandler: class {
    constructor(context: Record<string, any>) {
      harness.mobileContexts.push(context);
    }
    initialize() { return harness.mobileInitialize(); }
  },
}));

vi.mock('../MessageStreamingHandler', () => ({
  MessageStreamingHandler: class {
    handle = vi.fn();
  },
}));
vi.mock('../HooklessAgentFileWatcher', () => ({ HooklessAgentFileWatcher: class {} }));
vi.mock('../tools', () => ({ ToolExecutor: class {}, toolRegistry: { register: vi.fn() }, BUILT_IN_TOOLS: [] }));
vi.mock('../../analytics/AnalyticsService.ts', () => ({ AnalyticsService: { getInstance: () => ({}) } }));
vi.mock('../SettingsService', () => ({ getSettingsService: () => ({}) }));
vi.mock('../providerSettingsCacheInvalidation', () => ({ subscribeProviderSettingsInvalidation: vi.fn() }));
vi.mock('../mobileSettingsSync', () => ({ scheduleMobileSettingsSync: vi.fn() }));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../../utils/privateSettingsStore', () => ({ default: class {} }));
vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(), createWindow: vi.fn(), isAppQuitting: () => false,
}));
vi.mock('../../TerminalSessionManager', () => ({
  getTerminalSessionManager: () => ({ isTerminalActive: () => false, writeToTerminal: vi.fn() }),
}));
vi.mock('../../SyncManager', () => ({ getSyncProvider: () => null }));
vi.mock('../../../window/workspaceWindowAvailability', () => ({ onWorkspaceWindowAvailable: vi.fn() }));
vi.mock('../resolveProviderApiKey', () => ({ resolveProviderApiKey: vi.fn() }));
vi.mock('../../credentials/providerCredentials', () => ({ getProviderCredentials: vi.fn() }));
vi.mock('../providerResolution', () => ({ isExtensionAgentProvider: () => false }));
vi.mock('../claudeCodeModelReconcile', () => ({ reconcileClaudeCodeModels: vi.fn() }));
vi.mock('../claudeCliQueueFlushSingleton', () => ({ flushNextClaudeCliQueuedPromptForSession: vi.fn() }));
vi.mock('../../../utils/store', () => ({
  getAIProviderOverrides: vi.fn(), getDefaultEffortLevel: vi.fn(), getDefaultThinkingMode: vi.fn(),
}));
vi.mock('../../../utils/aiSettingsMerge', () => ({ getAIProviderOverridesWithWorktreeFallback: vi.fn() }));
vi.mock('../../../utils/workspaceDetection', () => ({ resolveProjectPath: vi.fn() }));
vi.mock('../worktreeInference', () => ({ inferWorktreePathFromFilePath: vi.fn(), inferWorktreePathFromCommand: vi.fn() }));
vi.mock('../aiServiceUtils', () => ({ safeSend: vi.fn() }));
vi.mock('../queuedPromptDispatcher', () => ({
  SessionProcessingGuard: class { delete = vi.fn(); },
  tryClaimAndDispatchNextQueuedPrompt: vi.fn(),
}));
vi.mock('../QueueDriveService', () => ({ QueueDriveService: class {} }));
vi.mock('../resolveWorkspaceWindow', () => ({ createWorkspaceWindowResolver: () => ({}) }));
vi.mock('../queueDriveAttempt', () => ({ runQueueDriveAttempt: vi.fn() }));
vi.mock('../queuedPromptSyncPublisher', () => ({ publishQueuedPromptsToSync: vi.fn() }));
vi.mock('../claudeCliQueueDispatch', () => ({ dispatchQueuedPromptToClaudeCli: vi.fn() }));
vi.mock('../queuedPromptClaimEvents', () => ({ publishQueuedPromptClaim: vi.fn() }));
vi.mock('../claudeCliLauncherSingleton', () => ({ ensureClaudeCliSession: vi.fn() }));
vi.mock('../providerWorkflowCatalog', () => ({ resolveProviderWorkflowCatalog: vi.fn() }));
vi.mock('../startupQueuedPromptDrain', () => ({ drainPendingOrdinaryPromptsOnStartup: vi.fn() }));

vi.mock('../ipc/registerInitHandlers', () => ({ registerInitHandlers: vi.fn() }));
vi.mock('../ipc/registerSessionHandlers', () => ({ registerSessionHandlers: vi.fn() }));
vi.mock('../ipc/registerQueuedPromptHandlers', () => ({ registerQueuedPromptHandlers: vi.fn() }));
vi.mock('../ipc/registerInteractivePromptHandlers', () => ({ registerInteractivePromptHandlers: vi.fn() }));
vi.mock('../ipc/registerTurnControlHandlers', () => ({ registerTurnControlHandlers: vi.fn() }));
vi.mock('../ipc/registerSettingsHandlers', () => ({ registerSettingsHandlers: vi.fn() }));
vi.mock('../ipc/registerModelHandlers', () => ({ registerModelHandlers: vi.fn() }));
vi.mock('../ipc/registerProjectSettingsHandlers', () => ({ registerProjectSettingsHandlers: vi.fn() }));
vi.mock('../ipc/registerExtensionChatHandlers', () => ({ registerExtensionChatHandlers: vi.fn() }));

import { AIService } from '../AIService';

const SETTLEMENT = { id: 'control-1', outcome: 'claimed' as const };
const BASE_ROW = {
  provider: 'openai-codex',
  status: 'running',
  last_activity: 100,
  updated_at: 200,
};
const EXPECTED_STATE = {
  status: 'running' as const,
  generation: 'running:100:200',
  lastActivity: 100,
  updatedAt: 200,
};

describe('AIService priority-port wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.mobileContexts.length = 0;
    harness.mobileInitialize.mockResolvedValue(undefined);
    harness.inboxCurrent.mockReturnValue({ sessionId: 'session-1', token: 7 });
    harness.inboxEnd.mockResolvedValue(undefined);
    harness.stateGet.mockReturnValue({ status: 'running', isStreaming: true });
    harness.stateInterrupt.mockResolvedValue(undefined);
    harness.sweepExecuting.mockResolvedValue({ completed: 0, failed: 0, rolledBack: 1 });
  });

  it('forwards the exact optional settlement through buildIpcContext', async () => {
    const publishQueueStateToSync = vi.fn().mockResolvedValue(undefined);
    const fakeService = {
      sessionManager: {}, analytics: {}, streamingHandler: { handle: vi.fn() },
      sessionsProcessingQueue: {}, documentContextService: {}, hooklessWatcher: {},
      cachedNormalizedProviderSettings: {}, publishQueueStateToSync,
    };

    const context = (AIService.prototype as any).buildIpcContext.call(fakeService);
    await context.publishQueueStateToSync('session-1', SETTLEMENT);

    expect(publishQueueStateToSync).toHaveBeenCalledOnce();
    expect(publishQueueStateToSync).toHaveBeenCalledWith('session-1', SETTLEMENT);
  });

  it('forwards the exact optional settlement through MobileSyncHandler construction', async () => {
    const publishSpy = vi.spyOn(AIService.prototype, 'publishQueueStateToSync').mockResolvedValue(undefined);

    new AIService({} as any);
    expect(harness.mobileContexts).toHaveLength(1);
    await harness.mobileContexts[0].publishQueueStateToSync('session-1', SETTLEMENT);

    expect(publishSpy).toHaveBeenCalledOnce();
    expect(publishSpy).toHaveBeenCalledWith('session-1', SETTLEMENT);
    publishSpy.mockRestore();
  });

  it('retires the captured inbox, sweeps delivery-aware queue state, and clears abort/no-active running state', async () => {
    harness.databaseQuery.mockResolvedValue({ rows: [BASE_ROW] });
    harness.getProvider.mockReturnValue({
      interruptCurrentTurn: vi.fn().mockResolvedValue({ method: 'abort', hadActiveTurn: false }),
    });
    const queueDelete = vi.fn();
    const publishQueueStateToSync = vi.fn().mockResolvedValue(undefined);
    const fakeService = {
      sessionsProcessingQueue: { delete: queueDelete },
      publishQueueStateToSync,
    };

    const result = await AIService.prototype.interruptCurrentTurnForSession.call(
      fakeService as any, 'session-1', EXPECTED_STATE,
    );

    expect(result).toEqual({ success: true, method: 'abort', nativeEntered: true });
    expect(harness.inboxCurrent).toHaveBeenCalledWith('session-1');
    expect(harness.inboxEnd).toHaveBeenCalledWith({ sessionId: 'session-1', token: 7 }, false);
    expect(queueDelete).toHaveBeenCalledWith('session-1');
    expect(harness.sweepExecuting).toHaveBeenCalledWith('session-1');
    expect(publishQueueStateToSync).toHaveBeenCalledWith('session-1');
    expect(harness.stateInterrupt).toHaveBeenCalledWith('session-1');
  });

  it('rejects a stale generation before native interrupt, inbox capture, or queue sweep', async () => {
    const drifted = { ...BASE_ROW, updated_at: 201 };
    harness.databaseQuery
      .mockResolvedValueOnce({ rows: [BASE_ROW] })
      .mockResolvedValueOnce({ rows: [drifted] });
    const nativeInterrupt = vi.fn();
    harness.getProvider.mockReturnValue({ interruptCurrentTurn: nativeInterrupt });
    const queueDelete = vi.fn();
    const publishQueueStateToSync = vi.fn();

    const result = await AIService.prototype.interruptCurrentTurnForSession.call({
      sessionsProcessingQueue: { delete: queueDelete }, publishQueueStateToSync,
    } as any, 'session-1', EXPECTED_STATE);

    expect(result).toEqual({ success: false, error: 'stale lifecycle generation', nativeEntered: false });
    expect(nativeInterrupt).not.toHaveBeenCalled();
    expect(harness.inboxCurrent).not.toHaveBeenCalled();
    expect(harness.inboxEnd).not.toHaveBeenCalled();
    expect(queueDelete).not.toHaveBeenCalled();
    expect(harness.sweepExecuting).not.toHaveBeenCalled();
    expect(publishQueueStateToSync).not.toHaveBeenCalled();
  });
});
