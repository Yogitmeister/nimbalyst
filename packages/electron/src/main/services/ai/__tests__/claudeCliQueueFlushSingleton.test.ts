import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rows = [{
    id: 'queued-followup',
    sessionId: 'continuation-cli',
    prompt: 'continue safely',
    status: 'pending',
    createdAt: 1,
  }];
  return {
    rows,
    resolve: vi.fn(),
    submit: vi.fn(),
    sent: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { send: mocks.sent },
    }],
  },
}));
vi.mock('../../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({
    listPending: vi.fn(async (sessionId: string) => mocks.rows.filter(
      (row) => row.sessionId === sessionId && row.status === 'pending',
    )),
    claim: vi.fn(async (id: string) => {
      const row = mocks.rows.find((candidate) => candidate.id === id);
      if (!row || row.status !== 'pending') return null;
      row.status = 'executing';
      return row;
    }),
    complete: vi.fn(async (id: string) => {
      const row = mocks.rows.find((candidate) => candidate.id === id);
      if (row) row.status = 'completed';
    }),
    fail: vi.fn(async () => undefined),
    transferPending: vi.fn(async () => []),
  }),
}));
vi.mock('../../TerminalSessionManager', () => ({
  getTerminalSessionManager: () => ({
    isTerminalActive: (sessionId: string) => sessionId === 'continuation-cli',
  }),
}));
vi.mock('../claudeCliPromptTarget', () => ({
  resolveClaudeCliQueuedPromptTarget: mocks.resolve,
}));
vi.mock('../claudeCliSubmitSingleton', () => ({
  submitClaudeCliPromptProduction: mocks.submit,
}));

import { flushNextClaudeCliQueuedPromptForSession } from '../claudeCliQueueFlushSingleton';

describe('claude-code-cli PID-idle queue continuation rail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows[0].sessionId = 'continuation-cli';
    mocks.rows[0].status = 'pending';
    const resolvedTarget = {
      requestedSessionId: 'retired-cli',
      session: { id: 'continuation-cli', provider: 'claude-code-cli' },
      sessionId: 'continuation-cli',
      workspacePath: '/workspace',
      cwd: '/workspace',
      continuedFromSessionId: 'retired-cli',
    };
    mocks.resolve
      .mockResolvedValueOnce({ ...resolvedTarget, transferredPrompts: [mocks.rows[0]] })
      .mockResolvedValue({ ...resolvedTarget, transferredPrompts: [] });
    mocks.submit.mockResolvedValue({ submitted: true });
  });

  it('claims and submits only on the continuation, with concurrent stale wakeups deduplicated', async () => {
    const results = await Promise.all([
      flushNextClaudeCliQueuedPromptForSession('retired-cli', '/workspace'),
      flushNextClaudeCliQueuedPromptForSession('retired-cli', '/workspace'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'continuation-cli',
      workspacePath: '/workspace',
      prompt: 'continue safely',
    }));
    expect(mocks.submit).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'retired-cli',
    }));
    expect(mocks.rows[0]).toMatchObject({
      sessionId: 'continuation-cli',
      status: 'completed',
    });
    expect(mocks.sent).toHaveBeenCalledWith('ai:queuedPromptsReceived', {
      sessionId: 'retired-cli',
      promptCount: 0,
      redirectedToSessionId: 'continuation-cli',
    });
    expect(mocks.sent).toHaveBeenCalledWith('ai:queuedPromptsReceived', {
      sessionId: 'continuation-cli',
      promptCount: 1,
      continuedFromSessionId: 'retired-cli',
    });
    expect(mocks.sent).toHaveBeenCalledWith('ai:promptClaimed', {
      sessionId: 'continuation-cli',
      promptId: 'queued-followup',
    });
  });
});
