import { describe, expect, it, vi } from 'vitest';

const namingMocks = vi.hoisted(() => ({
  updateMetadata: null as null | ((sessionId: string, metadata: Record<string, unknown>) => Promise<void>),
}));
const repositoryMocks = vi.hoisted(() => ({
  get: vi.fn(),
  updateMetadata: vi.fn().mockResolvedValue(undefined),
}));
const evidenceMocks = vi.hoisted(() => ({
  recordWorktreeCompletionArtifact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class { async initialize() {} },
  setPreferredAgentLanguage: vi.fn(),
}));
vi.mock('@nimbalyst/runtime', () => ({ AISessionsRepository: repositoryMocks }));
vi.mock('../../mcp/sessionNamingServer', () => ({
  setUpdateSessionTitleFn: vi.fn(),
  setUpdateSessionMetadataFn: (fn: typeof namingMocks.updateMetadata) => {
    namingMocks.updateMetadata = fn;
  },
  setGetWorkspaceTagsFn: vi.fn(),
  setGetSessionTagsFn: vi.fn(),
  setGetSessionTitleFn: vi.fn(),
  setGetSessionPhaseFn: vi.fn(),
}));
vi.mock('../ai/claudeCliSessionAutoNameSingleton', () => ({
  setClaudeCliAutoNameApplyTitleFn: vi.fn(),
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../../utils/store', () => ({ getPreferredAgentLanguage: () => 'en' }));
vi.mock('../worktreeSessionLifecycle', () => evidenceMocks);

import { SessionNamingService } from '../SessionNamingService';

describe('SessionNamingService worktree completion evidence', () => {
  it('records a completion report only at an explicit complete phase transition', async () => {
    await SessionNamingService.getInstance().start();
    expect(namingMocks.updateMetadata).not.toBeNull();

    await namingMocks.updateMetadata!('session-1', { phase: 'validating' });
    expect(evidenceMocks.recordWorktreeCompletionArtifact).not.toHaveBeenCalled();

    await namingMocks.updateMetadata!('session-1', { phase: 'complete' });
    expect(repositoryMocks.updateMetadata).toHaveBeenLastCalledWith(
      'session-1',
      { metadata: { phase: 'complete' } },
    );
    expect(evidenceMocks.recordWorktreeCompletionArtifact).toHaveBeenCalledWith(
      'session-1',
      'completion-report',
    );
  });
});
