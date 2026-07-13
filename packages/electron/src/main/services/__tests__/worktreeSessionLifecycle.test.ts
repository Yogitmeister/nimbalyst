import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionRepositoryMocks = vi.hoisted(() => ({
  get: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: sessionRepositoryMocks,
}));

import {
  recordWorktreeCompletionArtifact,
  recordWorktreeSessionResult,
} from '../worktreeSessionLifecycle';

describe('recordWorktreeSessionResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures a result without manufacturing completion or audit evidence', async () => {
    sessionRepositoryMocks.get.mockResolvedValue({
      id: 'session-1',
      worktreeId: 'wt-1',
      metadata: { phase: 'complete' },
    });

    await recordWorktreeSessionResult('session-1');

    const update = sessionRepositoryMocks.updateMetadata.mock.calls[0][1];
    expect(update.metadata.worktreeLifecycle).toMatchObject({
      resultCapturedAt: expect.any(Number),
      terminalDisposition: 'complete',
    });
    expect(update.metadata.worktreeLifecycle).not.toHaveProperty('completionReportAt');
    expect(update.metadata.worktreeLifecycle).not.toHaveProperty('parentAuditAt');
  });

  it('records an explicit completion report without manufacturing a captured result', async () => {
    sessionRepositoryMocks.get.mockResolvedValue({
      id: 'session-1',
      worktreeId: 'wt-1',
      metadata: { phase: 'complete' },
    });

    await recordWorktreeCompletionArtifact('session-1', 'completion-report');

    const update = sessionRepositoryMocks.updateMetadata.mock.calls[0][1];
    expect(update.metadata.worktreeLifecycle).toMatchObject({
      completionReportAt: expect.any(Number),
      terminalDisposition: 'complete',
    });
    expect(update.metadata.worktreeLifecycle).not.toHaveProperty('resultCapturedAt');
  });

  it('serializes concurrent result and artifact writes so neither proof is lost', async () => {
    let metadata: Record<string, any> = { phase: 'complete' };
    sessionRepositoryMocks.get.mockImplementation(async () => ({
      id: 'session-1',
      worktreeId: 'wt-1',
      metadata,
    }));
    sessionRepositoryMocks.updateMetadata.mockImplementation(async (_sessionId: string, update: any) => {
      metadata = { ...metadata, ...update.metadata };
    });

    await Promise.all([
      recordWorktreeSessionResult('session-1'),
      recordWorktreeCompletionArtifact('session-1', 'completion-report'),
    ]);

    expect(metadata.worktreeLifecycle).toMatchObject({
      resultCapturedAt: expect.any(Number),
      completionReportAt: expect.any(Number),
      terminalDisposition: 'complete',
    });
  });

  it('does not create lifecycle evidence for a main-workspace session', async () => {
    sessionRepositoryMocks.get.mockResolvedValue({
      id: 'session-1',
      worktreeId: null,
      metadata: {},
    });

    await recordWorktreeSessionResult('session-1');
    await recordWorktreeCompletionArtifact('session-1', 'completion-report');

    expect(sessionRepositoryMocks.updateMetadata).not.toHaveBeenCalled();
  });
});
