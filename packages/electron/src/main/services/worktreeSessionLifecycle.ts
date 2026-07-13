import { AISessionsRepository } from '@nimbalyst/runtime';
import type { WorktreeLifecycleMetadata } from './WorktreeLifecycleService';

export type WorktreeCompletionArtifact = 'completion-report' | 'parent-audit';

const lifecycleUpdateTails = new Map<string, Promise<void>>();

function normalizeLifecycle(value: unknown): WorktreeLifecycleMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as WorktreeLifecycleMetadata
    : {};
}

async function updateWorktreeLifecycle(
  sessionId: string,
  mutate: (
    existing: WorktreeLifecycleMetadata,
    metadata: Record<string, unknown>,
  ) => WorktreeLifecycleMetadata,
): Promise<void> {
  const previous = lifecycleUpdateTails.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const session = await AISessionsRepository.get(sessionId);
    if (!session?.worktreeId) return;

    const metadata = (session.metadata as Record<string, unknown> | undefined) ?? {};
    const existing = normalizeLifecycle(metadata.worktreeLifecycle);
    await AISessionsRepository.updateMetadata(sessionId, {
      metadata: { worktreeLifecycle: mutate(existing, metadata) },
    });
  });
  lifecycleUpdateTails.set(sessionId, next);
  try {
    await next;
  } finally {
    if (lifecycleUpdateTails.get(sessionId) === next) {
      lifecycleUpdateTails.delete(sessionId);
    }
  }
}

/** Capture a non-empty session result without manufacturing artifact evidence. */
export async function recordWorktreeSessionResult(
  sessionId: string,
): Promise<void> {
  await updateWorktreeLifecycle(sessionId, (existing, metadata) => ({
    ...existing,
    resultCapturedAt: existing.resultCapturedAt ?? Date.now(),
    ...(metadata.phase === 'complete' ? { terminalDisposition: 'complete' as const } : {}),
  }));
}

/**
 * Record only an explicit completion artifact. The result-capture gate remains
 * independent and must be satisfied by a real non-empty result read/settle.
 */
export async function recordWorktreeCompletionArtifact(
  sessionId: string,
  artifact: WorktreeCompletionArtifact,
): Promise<void> {
  await updateWorktreeLifecycle(sessionId, (existing, metadata) => {
    const lifecycle: WorktreeLifecycleMetadata = {
      ...existing,
      ...(metadata.phase === 'complete' ? { terminalDisposition: 'complete' as const } : {}),
    };
    if (artifact === 'completion-report') {
      lifecycle.completionReportAt = existing.completionReportAt ?? Date.now();
    } else {
      lifecycle.parentAuditAt = existing.parentAuditAt ?? Date.now();
    }
    return lifecycle;
  });
}
