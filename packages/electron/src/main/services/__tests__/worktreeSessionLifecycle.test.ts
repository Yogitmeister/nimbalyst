import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionRepositoryMocks = vi.hoisted(() => ({
  get: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: sessionRepositoryMocks,
}));

import { recordWorktreeSessionResult } from '../worktreeSessionLifecycle';

describe('recordWorktreeSessionResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures a terminal completion report for a linked worktree session', async () => {
    sessionRepositoryMocks.get.mockResolvedValue({
      id: 'session-1',
      worktreeId: 'wt-1',
      metadata: { phase: 'complete' },
    });

    await recordWorktreeSessionResult('session-1', 'completion-report');

    expect(sessionRepositoryMocks.updateMetadata).toHaveBeenCalledWith(
      'session-1',
      {
        metadata: {
          worktreeLifecycle: expect.objectContaining({
            resultCapturedAt: expect.any(Number),
            completionReportAt: expect.any(Number),
            terminalDisposition: 'complete',
          }),
        },
      },
    );
  });

  it('does not create lifecycle evidence for a main-workspace session', async () => {
    sessionRepositoryMocks.get.mockResolvedValue({
      id: 'session-1',
      worktreeId: null,
      metadata: {},
    });

    await recordWorktreeSessionResult('session-1', 'completion-report');

    expect(sessionRepositoryMocks.updateMetadata).not.toHaveBeenCalled();
  });
});
