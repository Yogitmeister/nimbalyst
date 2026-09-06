import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const provider = {
    abort: vi.fn(),
    resolveAskUserQuestion: vi.fn(() => true),
    rejectAskUserQuestion: vi.fn(),
    resolveExitPlanModeConfirmation: vi.fn(),
    resolveToolPermission: vi.fn(),
  };

  return {
    provider,
    getProvider: vi.fn(),
    getSession: vi.fn(),
    createMessage: vi.fn(),
    ipcListenerCount: vi.fn((_channel: string) => 0),
    ipcEmit: vi.fn(),
    onPromptResolved: vi.fn(),
    getDatabase: vi.fn(() => null),
    createWorktreeStore: vi.fn(),
    terminalIsActive: vi.fn(),
    terminalWrite: vi.fn(),
    sendSessionControlMessage: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    listenerCount: mocks.ipcListenerCount,
    emit: mocks.ipcEmit,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  AI_PROVIDER_TYPES: [
    'claude',
    'claude-code',
    'claude-code-cli',
    'openai',
    'openai-codex',
    'openai-codex-acp',
    'lmstudio',
    'opencode',
    'copilot-cli',
  ],
  ProviderFactory: {
    getProvider: mocks.getProvider,
    // No test in this file exercises extension-agent owners; native census
    // (nativeSessionOwnerCensus.ts) calls this unconditionally, so it must
    // exist on the mock or every cancellation census here would fail closed
    // to 'unknown' via a thrown "not a function". See NIM-590 batch item 5.
    listExtensionAgentProvidersForSession: () => [],
  },
  isAskUserQuestionProvider: (candidate: unknown) =>
    !!candidate &&
    typeof (candidate as { resolveAskUserQuestion?: unknown }).resolveAskUserQuestion === 'function',
  isExitPlanModeProvider: (candidate: unknown) =>
    !!candidate &&
    typeof (candidate as { resolveExitPlanModeConfirmation?: unknown }).resolveExitPlanModeConfirmation === 'function',
  isToolPermissionProvider: (candidate: unknown) =>
    !!candidate &&
    typeof (candidate as { resolveToolPermission?: unknown }).resolveToolPermission === 'function',
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: mocks.getSession,
  },
  AgentMessagesRepository: {
    create: mocks.createMessage,
  },
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    ai: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('../../../tray/TrayManager', () => ({
  TrayManager: {
    getInstance: () => ({
      onPromptResolved: mocks.onPromptResolved,
    }),
  },
}));

vi.mock('../../../mcp/tools/interactiveToolHandlers', () => ({
  getRequestUserInputResponseChannel: (sessionId: string, promptId: string) =>
    `request-user-input-response:${sessionId || 'unknown'}:${promptId}`,
  getRequestUserInputFallbackResponseChannel: (sessionId: string) =>
    `request-user-input-response:${sessionId || 'unknown'}:__fallback__`,
  getToolPermissionResponseChannel: (sessionId: string, requestId: string) =>
    `tool-permission-response:${sessionId || 'unknown'}:${requestId}`,
}));

vi.mock('../../gitEnv', () => ({
  getGitSubprocessEnv: vi.fn(() => ({})),
}));

vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(),
}));

vi.mock('../../../database/initialize', () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock('../../WorktreeStore', () => ({
  createWorktreeStore: mocks.createWorktreeStore,
}));

vi.mock('../../TerminalSessionManager', () => ({
  getTerminalSessionManager: () => ({
    isTerminalActive: mocks.terminalIsActive,
    writeToTerminal: mocks.terminalWrite,
  }),
}));

import {
  initMobileSessionControlHandler,
  resolveGitCommitWorkspacePath,
  resolveVoicePromptResponse,
} from '../MobileSessionControlHandler';

describe('MobileSessionControlHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.provider.abort.mockReset();
    mocks.provider.resolveAskUserQuestion.mockReturnValue(true);
    mocks.ipcListenerCount.mockReturnValue(0);
    mocks.getSession.mockResolvedValue({ provider: 'openai-codex' });
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.terminalIsActive.mockReturnValue(false);
    mocks.sendSessionControlMessage.mockResolvedValue(undefined);
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'openai-codex' && sessionId === 'session-1' ? mocks.provider : null,
    );
  });

  it('uses a native worktree path for mobile commit execution', () => {
    expect(resolveGitCommitWorkspacePath({
      workspacePath: 'D:/project',
      worktreeId: 'wt-1',
      worktreePath: 'D:/project_worktrees/task',
    })).toBe('D:/project_worktrees/task');
  });

  it('fails closed when a native worktree session has no worktree path', () => {
    expect(resolveGitCommitWorkspacePath({
      workspacePath: 'D:/project',
      worktreeId: 'wt-1',
    })).toBeNull();
  });

  it('fails closed when a worktree path lacks a native worktree identity', () => {
    expect(resolveGitCommitWorkspacePath({
      workspacePath: 'D:/project',
      worktreePath: 'D:/project_worktrees/task',
    })).toBeNull();
  });

  it('routes mobile cancel cleanup before abort and keeps the rolled-back count contract', async () => {
    let deliver!: (message: { type: string; sessionId: string; payload: unknown }) => void;
    const onSessionControlMessage = vi.fn((listener: (message: any) => void) => {
      deliver = listener;
      return vi.fn();
    });
    const cancelQueuedPromptTurn = vi.fn(async (
      _sessionId: string,
      cancelNativeTurn: (target: { generation: string; isCurrent(): boolean }) => Promise<any>,
    ) => {
      const nativeOutcome = await cancelNativeTurn({ generation: 'cancel-1', isCurrent: () => true });
      return { nativeOutcome, quarantined: false, rolledBack: 3, lifecycleSettled: true };
    });
    initMobileSessionControlHandler(
      { onSessionControlMessage, sendSessionControlMessage: mocks.sendSessionControlMessage } as any,
      () => null,
      {
        cancelQueuedPromptTurn,
        triggerQueuedPromptProcessing: vi.fn(async () => false),
      },
    );

    deliver({ type: 'cancel', sessionId: 'session-1', payload: {} });
    await vi.waitFor(() => expect(mocks.provider.abort).toHaveBeenCalledTimes(1));

    expect(cancelQueuedPromptTurn).toHaveBeenCalledWith('session-1', expect.any(Function));
    expect(cancelQueuedPromptTurn.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getProvider.mock.invocationCallOrder[0]);
    await expect(cancelQueuedPromptTurn.mock.results[0].value).resolves.toMatchObject({
      rolledBack: 3,
      nativeOutcome: { state: 'native-entered', method: 'built-in:openai-codex:abort' },
    });
    await vi.waitFor(() => expect(mocks.sendSessionControlMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        type: 'cancel_result',
        payload: expect.objectContaining({ success: true, quarantined: false }),
        sentBy: 'desktop',
      }),
    ));
  });

  it('surfaces incomplete mobile cancellation as a retry-required result', async () => {
    let deliver!: (message: { type: string; sessionId: string; payload: unknown }) => void;
    const onSessionControlMessage = vi.fn((listener: (message: any) => void) => {
      deliver = listener;
      return vi.fn();
    });
    const cancelQueuedPromptTurn = vi.fn(async () => ({
      nativeOutcome: { state: 'unknown' as const, error: 'owner did not acknowledge abort' },
      quarantined: true,
      rolledBack: 0,
      lifecycleSettled: false,
    }));
    initMobileSessionControlHandler(
      { onSessionControlMessage, sendSessionControlMessage: mocks.sendSessionControlMessage } as any,
      () => null,
      {
        cancelQueuedPromptTurn,
        triggerQueuedPromptProcessing: vi.fn(async () => false),
      },
    );

    deliver({ type: 'cancel', sessionId: 'session-1', payload: {} });

    await vi.waitFor(() => expect(mocks.sendSessionControlMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        type: 'cancel_result',
        payload: expect.objectContaining({
          success: false,
          quarantined: true,
          retryRequired: true,
          error: 'owner did not acknowledge abort',
        }),
        sentBy: 'desktop',
      }),
    ));
  });

  it('reports callback failure as quarantined instead of silently dropping mobile truth', async () => {
    let deliver!: (message: { type: string; sessionId: string; payload: unknown }) => void;
    const onSessionControlMessage = vi.fn((listener: (message: any) => void) => {
      deliver = listener;
      return vi.fn();
    });
    const cancelQueuedPromptTurn = vi.fn(async () => {
      throw new Error('cancellation owner failed');
    });
    initMobileSessionControlHandler(
      { onSessionControlMessage, sendSessionControlMessage: mocks.sendSessionControlMessage } as any,
      () => null,
      {
        cancelQueuedPromptTurn,
        triggerQueuedPromptProcessing: vi.fn(async () => false),
      },
    );

    deliver({ type: 'cancel', sessionId: 'session-1', payload: {} });

    await vi.waitFor(() => expect(mocks.sendSessionControlMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        type: 'cancel_result',
        payload: expect.objectContaining({
          success: false,
          quarantined: true,
          retryRequired: true,
          error: 'cancellation owner failed',
        }),
        sentBy: 'desktop',
      }),
    ));
  });

  it('runs mobile cancel cleanup even when no provider remains', async () => {
    let deliver!: (message: { type: string; sessionId: string; payload: unknown }) => void;
    const onSessionControlMessage = vi.fn((listener: (message: any) => void) => {
      deliver = listener;
      return vi.fn();
    });
    const cancelQueuedPromptTurn = vi.fn(async (
      _sessionId: string,
      cancelNativeTurn: (target: { generation: string; isCurrent(): boolean }) => Promise<any>,
    ) => {
      const nativeOutcome = await cancelNativeTurn({ generation: 'cancel-1', isCurrent: () => true });
      return { nativeOutcome, quarantined: false, rolledBack: 0, lifecycleSettled: true };
    });
    mocks.getProvider.mockReturnValue(null);
    initMobileSessionControlHandler(
      { onSessionControlMessage } as any,
      () => null,
      {
        cancelQueuedPromptTurn,
        triggerQueuedPromptProcessing: vi.fn(async () => false),
      },
    );

    deliver({ type: 'cancel', sessionId: 'session-1', payload: {} });
    await vi.waitFor(() => expect(cancelQueuedPromptTurn).toHaveBeenCalledWith('session-1', expect.any(Function)));
    await vi.waitFor(() => expect(mocks.getProvider).toHaveBeenCalledWith('openai-codex', 'session-1'));
    expect(mocks.provider.abort).not.toHaveBeenCalled();
  });

  it('keeps CLI provider resolution and Ctrl-C inside the mobile cancellation owner', async () => {
    let deliver!: (message: { type: string; sessionId: string; payload: unknown }) => void;
    const onSessionControlMessage = vi.fn((listener: (message: any) => void) => {
      deliver = listener;
      return vi.fn();
    });
    const cancelQueuedPromptTurn = vi.fn(async (
      _sessionId: string,
      cancelNativeTurn: (target: { generation: string; isCurrent(): boolean }) => Promise<any>,
    ) => {
      const nativeOutcome = await cancelNativeTurn({ generation: 'cancel-1', isCurrent: () => true });
      return { nativeOutcome, quarantined: false, rolledBack: 1, lifecycleSettled: true };
    });
    mocks.getSession.mockResolvedValue({ provider: 'claude-code-cli' });
    mocks.getProvider.mockReturnValue(null);
    mocks.terminalIsActive.mockReturnValue(true);
    initMobileSessionControlHandler(
      { onSessionControlMessage } as any,
      () => null,
      {
        cancelQueuedPromptTurn,
        triggerQueuedPromptProcessing: vi.fn(async () => false),
      },
    );

    deliver({ type: 'cancel', sessionId: 'session-1', payload: {} });
    await vi.waitFor(() => expect(mocks.terminalWrite).toHaveBeenCalledWith('session-1', '\x03'));

    expect(cancelQueuedPromptTurn).toHaveBeenCalledWith('session-1', expect.any(Function));
    expect(mocks.provider.abort).not.toHaveBeenCalled();
  });

  it('does not let a CLI repository row hide another live built-in provider', async () => {
    let deliver!: (message: { type: string; sessionId: string; payload: unknown }) => void;
    const onSessionControlMessage = vi.fn((listener: (message: any) => void) => {
      deliver = listener;
      return vi.fn();
    });
    const cancelQueuedPromptTurn = vi.fn(async (
      _sessionId: string,
      cancelNativeTurn: (target: { generation: string; isCurrent(): boolean }) => Promise<any>,
    ) => {
      const nativeOutcome = await cancelNativeTurn({ generation: 'cancel-1', isCurrent: () => true });
      return {
        nativeOutcome,
        quarantined: nativeOutcome.state === 'unknown',
        rolledBack: 0,
        lifecycleSettled: nativeOutcome.state !== 'unknown',
      };
    });
    mocks.getSession.mockResolvedValue({ provider: 'claude-code-cli' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'opencode' && sessionId === 'session-1' ? mocks.provider : null,
    );
    initMobileSessionControlHandler(
      { onSessionControlMessage } as any,
      () => null,
      {
        cancelQueuedPromptTurn,
        triggerQueuedPromptProcessing: vi.fn(async () => false),
      },
    );

    deliver({ type: 'cancel', sessionId: 'session-1', payload: {} });
    await vi.waitFor(() => expect(mocks.provider.abort).toHaveBeenCalledTimes(1));

    expect(mocks.getProvider).toHaveBeenCalledWith('opencode', 'session-1');
    await expect(cancelQueuedPromptTurn.mock.results[0].value).resolves.toMatchObject({
      nativeOutcome: { state: 'native-entered', method: 'built-in:opencode:abort' },
    });
  });

  it('cancels every live built-in owner instead of choosing one from an ambiguous row', async () => {
    let deliver!: (message: { type: string; sessionId: string; payload: unknown }) => void;
    const onSessionControlMessage = vi.fn((listener: (message: any) => void) => {
      deliver = listener;
      return vi.fn();
    });
    const secondProvider = { abort: vi.fn() };
    const cancelQueuedPromptTurn = vi.fn(async (
      _sessionId: string,
      cancelNativeTurn: (target: { generation: string; isCurrent(): boolean }) => Promise<any>,
    ) => {
      const nativeOutcome = await cancelNativeTurn({ generation: 'cancel-1', isCurrent: () => true });
      return {
        nativeOutcome,
        quarantined: nativeOutcome.state === 'unknown',
        rolledBack: 0,
        lifecycleSettled: nativeOutcome.state !== 'unknown',
      };
    });
    mocks.getSession.mockRejectedValue(new Error('repository unavailable'));
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) => {
      if (sessionId !== 'session-1') return null;
      if (providerType === 'opencode') return mocks.provider;
      if (providerType === 'openai-codex') return secondProvider;
      return null;
    });
    initMobileSessionControlHandler(
      { onSessionControlMessage } as any,
      () => null,
      {
        cancelQueuedPromptTurn,
        triggerQueuedPromptProcessing: vi.fn(async () => false),
      },
    );

    deliver({ type: 'cancel', sessionId: 'session-1', payload: {} });
    await vi.waitFor(() => expect(cancelQueuedPromptTurn).toHaveBeenCalledTimes(1));

    await expect(cancelQueuedPromptTurn.mock.results[0].value).resolves.toMatchObject({
      quarantined: false,
      nativeOutcome: { state: 'native-entered' },
    });
    expect(mocks.provider.abort).toHaveBeenCalledTimes(1);
    expect(secondProvider.abort).toHaveBeenCalledTimes(1);
    expect(mocks.terminalWrite).not.toHaveBeenCalled();
  });

  it('uses the session provider and always persists the mobile response', async () => {
    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('openai-codex', 'session-1');
    expect(mocks.provider.resolveAskUserQuestion).toHaveBeenCalledWith(
      'call_question_123',
      { Scope: 'Everything' },
      'session-1',
      'mobile',
    );
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      source: 'openai-codex',
      direction: 'output',
      content: expect.any(String),
    }));
    expect(JSON.parse(mocks.createMessage.mock.calls[0][0].content)).toMatchObject({
      type: 'ask_user_question_response',
      questionId: 'call_question_123',
      answers: { Scope: 'Everything' },
      cancelled: false,
      respondedBy: 'mobile',
    });
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('wakes the MCP waiter even when the provider consumes the response', async () => {
    mocks.ipcListenerCount.mockImplementation((channel: string) =>
      channel === 'ask-user-question-response:session-1:call_question_123' ? 1 : 0,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.ipcEmit).toHaveBeenCalledWith(
        'ask-user-question-response:session-1:call_question_123',
        {},
        expect.objectContaining({
          answers: { Scope: 'Everything' },
          respondedBy: 'mobile',
          sessionId: 'session-1',
        }),
      );
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
  });

  it('persists the response when no in-process provider is available', async () => {
    mocks.getProvider.mockReturnValue(null);

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    expect(mocks.provider.resolveAskUserQuestion).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.createMessage.mock.calls[0][0].content)).toMatchObject({
      questionId: 'call_question_123',
      answers: { Scope: 'Everything' },
      respondedBy: 'mobile',
    });
  });

  it('routes exit_plan_mode through the real provider capability', async () => {
    // ClaudeCodeProvider is currently the only production provider that
    // advertises ExitPlanMode confirmation support.
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'claude-code' && sessionId === 'session-1' ? mocks.provider : null,
    );
    resolveVoicePromptResponse('session-1', {
      promptType: 'exit_plan_mode',
      promptId: 'call_plan_123',
      response: {
        approved: true,
        feedback: 'lgtm',
        startNewSession: true,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.provider.resolveExitPlanModeConfirmation).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveExitPlanModeConfirmation).toHaveBeenCalledWith(
      'call_plan_123',
      { approved: true, clearContext: true, feedback: 'lgtm' },
      'session-1',
      'mobile',
    );
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('persists before waking provider and IPC consumers', async () => {
    mocks.ipcListenerCount.mockImplementation((channel: string) =>
      channel === 'ask-user-question-response:session-1:call_ordered' ? 1 : 0,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_ordered',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.ipcEmit).toHaveBeenCalledTimes(1);
    });

    expect(mocks.createMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.provider.resolveAskUserQuestion.mock.invocationCallOrder[0]);
    expect(mocks.createMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.ipcEmit.mock.invocationCallOrder[0]);
  });

  it('continues notification cleanup when an IPC listener throws', async () => {
    mocks.ipcListenerCount.mockReturnValue(1);
    mocks.ipcEmit.mockImplementationOnce(() => {
      throw new Error('stale listener');
    });

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_throwing_listener',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(mocks.provider.resolveAskUserQuestion).toHaveBeenCalledTimes(1);
  });

  it('resolves tool_permission against the session provider (not hardcoded claude-code)', async () => {
    resolveVoicePromptResponse('session-1', {
      promptType: 'tool_permission',
      promptId: 'call_perm_123',
      response: {
        decision: 'allow',
        scope: 'once',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.provider.resolveToolPermission).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('openai-codex', 'session-1');
    expect(mocks.getProvider).not.toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveToolPermission).toHaveBeenCalledWith(
      'call_perm_123',
      { decision: 'allow', scope: 'once' },
      'session-1',
      'mobile',
    );
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('resolves tool_permission against an opencode provider (provider-agnostic guard)', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'opencode' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'opencode' && sessionId === 'session-1' ? mocks.provider : null,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'tool_permission',
      promptId: 'call_perm_oc',
      response: {
        decision: 'allow',
        scope: 'session',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.provider.resolveToolPermission).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('opencode', 'session-1');
    expect(mocks.getProvider).not.toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveToolPermission).toHaveBeenCalledWith(
      'call_perm_oc',
      { decision: 'allow', scope: 'session' },
      'session-1',
      'mobile',
    );
  });

  it('recovers ask_user_question on an opencode session via MCP + DB fallback (no in-process resolver)', async () => {
    // OpenCodeProvider extends BaseAgentProvider but does NOT implement
    // resolveAskUserQuestion — so this prompt must still be delivered by the
    // provider-agnostic MCP waiter + durable DB row, keyed to the real provider.
    const opencodeProvider = { resolveToolPermission: vi.fn() };
    mocks.getSession.mockResolvedValue({ provider: 'opencode' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'opencode' && sessionId === 'session-1' ? opencodeProvider : null,
    );
    mocks.ipcListenerCount.mockImplementation((channel: string) =>
      channel === 'ask-user-question-response:session-1:call_question_oc' ? 1 : 0,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_oc',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    // No in-process AskUserQuestion resolver on opencode, so the shared mock's
    // resolver is never touched.
    expect(mocks.provider.resolveAskUserQuestion).not.toHaveBeenCalled();
    // MCP waiter woken independently...
    expect(mocks.ipcEmit).toHaveBeenCalledWith(
      'ask-user-question-response:session-1:call_question_oc',
      {},
      expect.objectContaining({ answers: { Scope: 'Everything' }, respondedBy: 'mobile' }),
    );
    // ...and the durable row is persisted under the real provider.
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'opencode',
    }));
  });

  it('preserves mobile attribution when cancelling a provider question', async () => {
    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { ignored: 'value' },
        cancelled: true,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    expect(mocks.provider.rejectAskUserQuestion).toHaveBeenCalledWith(
      'call_question_123',
      expect.any(Error),
      'mobile',
    );
    expect(JSON.parse(mocks.createMessage.mock.calls[0][0].content)).toMatchObject({
      type: 'ask_user_question_response',
      answers: {},
      cancelled: true,
      respondedBy: 'mobile',
    });
  });
});
