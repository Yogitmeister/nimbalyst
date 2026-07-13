import { AISessionsRepository } from '@nimbalyst/runtime';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { getDatabase } from '../../database/initialize';
import { createWorktreeStore } from '../WorktreeStore';
import { resolvePromptTargetSession } from '../WorktreePromptTargetService';
import type { QueuedPrompt } from '../PGLiteQueuedPromptsStore';

export interface ClaudeCliPromptTarget {
  requestedSessionId: string;
  session: SessionData;
  sessionId: string;
  workspacePath: string;
  cwd: string;
  continuedFromSessionId: string | null;
}

export interface ClaudeCliPendingPromptOwnershipStore {
  transferPending(
    sourceSessionId: string,
    targetSessionId: string,
  ): Promise<QueuedPrompt[]>;
}

export interface ClaudeCliQueuedPromptTarget extends ClaudeCliPromptTarget {
  transferredPrompts: QueuedPrompt[];
}

/**
 * Resolve the authoritative session identity and cwd for every genuine Claude
 * CLI start or prompt boundary. Caller-provided cwd values are deliberately not
 * accepted: a retired worktree path must never survive into a new PTY launch.
 */
export async function resolveClaudeCliPromptTarget(
  requestedSessionId: string,
  workspacePath: string,
): Promise<ClaudeCliPromptTarget> {
  const requested = await AISessionsRepository.get(requestedSessionId);
  if (!requested || requested.workspacePath !== workspacePath) {
    throw new Error(`Session ${requestedSessionId} not found`);
  }
  if (requested.provider !== 'claude-code-cli') {
    throw new Error(`Session ${requestedSessionId} is not a claude-code-cli session`);
  }

  let resolved = await resolvePromptTargetSession(requested, workspacePath);
  if (resolved.session.provider !== 'claude-code-cli') {
    throw new Error(`Prompt target ${resolved.session.id} is not a claude-code-cli session`);
  }

  let cwd = workspacePath;
  if (resolved.session.worktreeId) {
    const db = getDatabase();
    if (!db) throw new Error('Database not initialized');
    const worktree = await createWorktreeStore(db).get(resolved.session.worktreeId);
    if (!worktree || worktree.isArchived) {
      // The row changed between the shared resolver's binding proof and cwd
      // selection. Resolve once more so the prompt still gets a continuation;
      // never fall back to the root cwd while retaining the worktree session ID.
      resolved = await resolvePromptTargetSession(resolved.session, workspacePath);
      if (resolved.session.worktreeId) {
        throw new Error(`Worktree ${resolved.session.worktreeId} is not an active prompt target`);
      }
    } else {
      cwd = worktree.path;
    }
  }

  return {
    requestedSessionId,
    session: resolved.session,
    sessionId: resolved.session.id,
    workspacePath,
    cwd,
    continuedFromSessionId: resolved.continuedFromSessionId,
  };
}

/**
 * Move pending queue ownership before a redirected CLI can claim anything.
 * The database update is atomic and status-scoped, so repeated wakeups converge
 * on one continuation without duplicating or stranding a pending row.
 */
export async function resolveClaudeCliQueuedPromptTarget(
  requestedSessionId: string,
  workspacePath: string,
  queueStore: ClaudeCliPendingPromptOwnershipStore,
): Promise<ClaudeCliQueuedPromptTarget> {
  const target = await resolveClaudeCliPromptTarget(requestedSessionId, workspacePath);
  const transferredPrompts = target.sessionId === requestedSessionId
    ? []
    : await queueStore.transferPending(requestedSessionId, target.sessionId);

  return { ...target, transferredPrompts };
}
