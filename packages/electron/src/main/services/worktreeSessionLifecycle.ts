import { AISessionsRepository } from '@nimbalyst/runtime';
import type { WorktreeLifecycleMetadata } from './WorktreeLifecycleService';

export type WorktreeCompletionArtifact = 'completion-report' | 'parent-audit';

function normalizeLifecycle(value: unknown): WorktreeLifecycleMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as WorktreeLifecycleMetadata
    : {};
}

/** Persist durable evidence used by the worktree cleanup fail-closed gate. */
export async function recordWorktreeSessionResult(
  sessionId: string,
  artifact?: WorktreeCompletionArtifact,
): Promise<void> {
  const session = await AISessionsRepository.get(sessionId);
  if (!session?.worktreeId) return;

  const metadata = (session.metadata as Record<string, unknown> | undefined) ?? {};
  const existing = normalizeLifecycle(metadata.worktreeLifecycle);
  const capturedAt = Date.now();
  const lifecycle: WorktreeLifecycleMetadata = {
    ...existing,
    resultCapturedAt: capturedAt,
    ...(metadata.phase === 'complete' ? { terminalDisposition: 'complete' as const } : {}),
  };
  if (artifact === 'completion-report') lifecycle.completionReportAt = capturedAt;
  if (artifact === 'parent-audit') lifecycle.parentAuditAt = capturedAt;

  await AISessionsRepository.updateMetadata(sessionId, {
    metadata: { worktreeLifecycle: lifecycle },
  });
}
