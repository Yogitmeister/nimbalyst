import { describe, expect, it, vi } from 'vitest';

const namingMocks = vi.hoisted(() => ({
  updateMetadata: null as null | ((sessionId: string, metadata: Record<string, unknown>) => Promise<void>),
  autoNameApplyTitle: null as null | ((sessionId: string, title: string) => Promise<boolean | void>),
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
}));
const repositoryMocks = vi.hoisted(() => ({
  get: vi.fn(),
  updateMetadata: vi.fn().mockResolvedValue(undefined),
  updateTags: vi.fn().mockResolvedValue([]),
  updateTitleIfNotNamed: vi.fn().mockResolvedValue(true),
  claimBlitzNameIfChildNotNamed: vi.fn().mockResolvedValue({
    childClaimed: true,
    parentNamed: true,
  }),
}));
const evidenceMocks = vi.hoisted(() => ({
  recordWorktreeCompletionArtifact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class {
    async initialize() {}
    async updateSessionTitle(sessionId: string, title: string, options?: unknown) {
      return namingMocks.updateSessionTitle(sessionId, title, options);
    }
  },
  setPreferredAgentLanguage: vi.fn(),
}));
vi.mock('@nimbalyst/runtime', () => ({ AISessionsRepository: repositoryMocks }));
vi.mock('../../mcp/sessionNamingServer', () => ({
  setUpdateSessionTitleIfNotNamedFn: vi.fn(),
  setUpdateSessionMetadataFn: (fn: typeof namingMocks.updateMetadata) => {
    namingMocks.updateMetadata = fn;
  },
  setUpdateSessionTagsFn: vi.fn(),
  setGetWorkspaceTagsFn: vi.fn(),
  setGetSessionTagsFn: vi.fn(),
  setGetSessionTitleFn: vi.fn(),
  setGetSessionPhaseFn: vi.fn(),
  setGetSessionMetaAuthorityContextFn: vi.fn(),
}));
vi.mock('../ai/claudeCliSessionAutoNameSingleton', () => ({
  setClaudeCliAutoNameApplyTitleFn: (
    fn: typeof namingMocks.autoNameApplyTitle,
  ) => {
    namingMocks.autoNameApplyTitle = fn;
  },
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

  it('uses the authoritative repository compare-and-set for first naming', async () => {
    const service = SessionNamingService.getInstance();
    await service.start();
    repositoryMocks.updateTitleIfNotNamed.mockClear();
    repositoryMocks.get.mockResolvedValue({ id: 'session-2' });

    const updated = await service.applySessionTitleIfNotNamed('session-2', 'First stable title');

    expect(updated).toBe(true);
    expect(repositoryMocks.updateTitleIfNotNamed).toHaveBeenCalledWith(
      'session-2',
      'First stable title',
    );
  });

  it('wires the CLI auto-namer through first-name CAS and preserves a concurrent winner', async () => {
    const service = SessionNamingService.getInstance();
    await service.start();
    expect(namingMocks.autoNameApplyTitle).not.toBeNull();
    namingMocks.updateSessionTitle.mockClear();
    repositoryMocks.get.mockResolvedValueOnce({ id: 'auto-name-race' });
    repositoryMocks.updateTitleIfNotNamed.mockResolvedValueOnce(false);

    const updated = await namingMocks.autoNameApplyTitle!(
      'auto-name-race',
      'Stale generated title',
    );

    expect(updated).toBe(false);
    expect(namingMocks.updateSessionTitle).not.toHaveBeenCalled();
  });

  it('does not consume a Blitz child claim when the atomic parent operation fails', async () => {
    const service = SessionNamingService.getInstance();
    await service.start();
    repositoryMocks.updateMetadata.mockClear();
    repositoryMocks.get
      .mockResolvedValueOnce({ id: 'child-1', parentSessionId: 'blitz-1' })
      .mockResolvedValueOnce({ id: 'blitz-1', sessionType: 'blitz' });
    repositoryMocks.claimBlitzNameIfChildNotNamed.mockRejectedValueOnce(
      new Error('transient store failure'),
    );

    await expect(
      service.applySessionTitleIfNotNamed('child-1', 'Retryable Blitz title'),
    ).rejects.toThrow('transient store failure');

    expect(repositoryMocks.updateMetadata).not.toHaveBeenCalledWith(
      'child-1',
      expect.objectContaining({ hasBeenNamed: true }),
    );
  });

  it('fails closed before child naming when session membership lookup rejects', async () => {
    const service = SessionNamingService.getInstance();
    await service.start();
    repositoryMocks.updateTitleIfNotNamed.mockClear();
    repositoryMocks.get.mockRejectedValueOnce(new Error('transient membership failure'));

    await expect(
      service.applySessionTitleIfNotNamed('child-lookup-error', 'Must remain retryable'),
    ).rejects.toThrow('transient membership failure');

    expect(repositoryMocks.updateTitleIfNotNamed).not.toHaveBeenCalled();
  });

  it('fails closed before child naming when a declared parent is missing', async () => {
    const service = SessionNamingService.getInstance();
    await service.start();
    repositoryMocks.updateTitleIfNotNamed.mockClear();
    repositoryMocks.claimBlitzNameIfChildNotNamed.mockClear();
    repositoryMocks.get
      .mockResolvedValueOnce({ id: 'child-missing-parent', parentSessionId: 'missing-parent' })
      .mockResolvedValueOnce(null);

    await expect(
      service.applySessionTitleIfNotNamed('child-missing-parent', 'Must remain retryable'),
    ).rejects.toThrow('Session parent could not be resolved before naming');

    expect(repositoryMocks.updateTitleIfNotNamed).not.toHaveBeenCalled();
    expect(repositoryMocks.claimBlitzNameIfChildNotNamed).not.toHaveBeenCalled();
  });
});
