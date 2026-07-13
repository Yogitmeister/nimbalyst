import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  resolve: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('../claudeCliLauncherSingleton', () => ({
  ensureClaudeCliSession: mocks.ensure,
}));
vi.mock('../claudeCliPromptTarget', () => ({
  resolveClaudeCliPromptTarget: mocks.resolve,
}));
vi.mock('../claudeCliSubmitSingleton', () => ({
  submitClaudeCliPromptProduction: mocks.submit,
}));

import {
  ensureClaudeCliPromptTargetSession,
  submitClaudeCliPromptToTarget,
} from '../claudeCliPromptTargetSingleton';

const target = {
  requestedSessionId: 'retired-cli',
  session: {
    id: 'continuation-cli',
    provider: 'claude-code-cli',
    model: 'claude-code-cli:opus',
  },
  sessionId: 'continuation-cli',
  workspacePath: '/workspace',
  cwd: '/workspace',
  continuedFromSessionId: 'retired-cli',
};

describe('claude-code-cli ensure and direct-submit target rails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue(target);
    mocks.ensure.mockResolvedValue({ success: true });
    mocks.submit.mockResolvedValue({ submitted: true });
  });

  it('mounts one continuation PTY at the main workspace and drops stale cwd/resume inputs', async () => {
    const result = await ensureClaudeCliPromptTargetSession({
      sessionId: 'retired-cli',
      workspacePath: '/workspace',
      cwd: '/deleted/worktree',
      resumeSessionId: 'stale-provider-session',
      model: 'claude-code-cli:sonnet',
      cols: 100,
      rows: 30,
    });

    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledWith({
      sessionId: 'continuation-cli',
      workspacePath: '/workspace',
      cwd: '/workspace',
      model: 'claude-code-cli:opus',
      resumeSessionId: undefined,
      cols: 100,
      rows: 30,
    });
    expect(result).toMatchObject({
      success: true,
      sessionId: 'continuation-cli',
      continuedFromSessionId: 'retired-cli',
    });
  });

  it('submits a direct follow-up exactly once to the continuation PTY', async () => {
    const result = await submitClaudeCliPromptToTarget({
      sessionId: 'retired-cli',
      workspacePath: '/workspace',
      prompt: 'continue safely',
    });

    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'continuation-cli',
      cwd: '/workspace',
    }));
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'continuation-cli',
      workspacePath: '/workspace',
      prompt: 'continue safely',
    }));
    expect(mocks.submit).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'retired-cli',
    }));
    expect(result).toEqual({
      success: true,
      submitted: true,
      sessionId: 'continuation-cli',
      continuedFromSessionId: 'retired-cli',
    });
  });
});
