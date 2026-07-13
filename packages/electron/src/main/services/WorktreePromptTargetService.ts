import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import { AISessionsRepository } from '@nimbalyst/runtime';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { getDatabase } from '../database/initialize';
import { GitWorktreeService } from './GitWorktreeService';
import { createWorktreeStore } from './WorktreeStore';
import {
  createWorktreeLifecycleService,
  type WorktreeLifecycleMetadata,
} from './WorktreeLifecycleService';

const retiredContinuationPromises = new Map<string, Promise<SessionData>>();

function getWorktreeLifecycleMetadata(session: SessionData): WorktreeLifecycleMetadata {
  const metadata = (session.metadata as Record<string, unknown> | undefined) ?? {};
  const lifecycle = metadata.worktreeLifecycle;
  return lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle)
    ? lifecycle as WorktreeLifecycleMetadata
    : {};
}

async function getOrCreateRetiredContinuation(
  source: SessionData,
  workspacePath: string,
): Promise<SessionData> {
  const lifecycle = getWorktreeLifecycleMetadata(source);
  if (lifecycle.continuationSessionId) {
    const existing = await AISessionsRepository.get(lifecycle.continuationSessionId);
    if (
      existing?.workspacePath === workspacePath
      && !existing.worktreeId
      && existing.isArchived !== true
      && getWorktreeLifecycleMetadata(existing).resumable !== false
    ) {
      return existing;
    }
  }

  const inFlight = retiredContinuationPromises.get(source.id);
  if (inFlight) return inFlight;

  const creation = (async (): Promise<SessionData> => {
    const continuationId = randomUUID();
    const sourceMetadata = (source.metadata as Record<string, unknown> | undefined) ?? {};
    const continuationMetadata: Record<string, unknown> = {
      continuedFromRetiredSessionId: source.id,
    };
    if (sourceMetadata.notifyParent !== undefined) {
      continuationMetadata.notifyParent = sourceMetadata.notifyParent;
    }
    if (sourceMetadata.toolScope !== undefined) {
      continuationMetadata.toolScope = sourceMetadata.toolScope;
    }

    await AISessionsRepository.create({
      id: continuationId,
      provider: source.provider,
      model: source.model,
      title: `${source.title || 'Session'} (continuation)`,
      workspaceId: workspacePath,
      sessionType: 'session',
      mode: source.mode,
      providerConfig: source.providerConfig as Record<string, unknown> | undefined,
      agentRole: source.agentRole ?? 'standard',
      createdBySessionId: source.createdBySessionId ?? null,
      parentSessionId: source.parentSessionId ?? null,
      branchedFromSessionId: source.id,
      branchedAt: Date.now(),
      hasBeenNamed: true,
      metadata: continuationMetadata,
    } as any);

    try {
      await AISessionsRepository.updateMetadata(source.id, {
        isArchived: true,
        metadata: {
          worktreeLifecycle: {
            ...lifecycle,
            terminalDisposition: 'retired',
            resumable: false,
            continuationSessionId: continuationId,
          } satisfies WorktreeLifecycleMetadata,
        },
      });
    } catch (error) {
      await AISessionsRepository.delete(continuationId).catch(() => undefined);
      throw error;
    }

    const continuation = await AISessionsRepository.get(continuationId);
    if (!continuation) {
      throw new Error(`Continuation session ${continuationId} was not persisted`);
    }

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('sessions:refresh-list', {
          workspacePath,
          sessionId: continuationId,
        });
        if (continuation.parentSessionId) {
          window.webContents.send('sessions:child-added', {
            workspacePath,
            parentSessionId: continuation.parentSessionId,
            childSessionId: continuationId,
          });
        }
      }
    }
    return continuation;
  })();

  retiredContinuationPromises.set(source.id, creation);
  try {
    return await creation;
  } finally {
    retiredContinuationPromises.delete(source.id);
  }
}

/**
 * Resolve an execution target that cannot retain a retired or unverifiable
 * worktree cwd. All prompt dispatch surfaces should enter this boundary before
 * loading a provider or choosing its working directory.
 */
export async function resolvePromptTargetSession(
  session: SessionData,
  workspacePath: string,
): Promise<{ session: SessionData; continuedFromSessionId: string | null }> {
  if (session.workspacePath !== workspacePath) {
    throw new Error(`Session ${session.id} not found`);
  }

  const lifecycle = getWorktreeLifecycleMetadata(session);
  let requiresContinuation = lifecycle.resumable === false || session.isArchived === true;

  if (!requiresContinuation && session.worktreeId) {
    const db = getDatabase();
    if (!db) throw new Error('Database not initialized');
    const worktreeStore = createWorktreeStore(db);
    const worktree = await worktreeStore.get(session.worktreeId);
    if (!worktree || worktree.isArchived) {
      requiresContinuation = true;
    } else {
      try {
        await new GitWorktreeService().verifyWorktreeBinding(workspacePath, worktree);
      } catch {
        requiresContinuation = true;
        await createWorktreeLifecycleService(db).reconcileWorkspace(workspacePath).catch(() => {
          // Routing away from an unverifiable cwd remains mandatory even when
          // reconciliation cannot persist an archive marker immediately.
        });
      }
    }
  }

  if (!requiresContinuation) {
    return { session, continuedFromSessionId: null };
  }

  const continuation = await getOrCreateRetiredContinuation(session, workspacePath);
  return { session: continuation, continuedFromSessionId: session.id };
}

/** Shared renderer/direct/SDK-queue execution boundary used before cwd choice. */
export async function loadPromptTargetSession(
  sessionManager: { loadSession(sessionId: string, workspacePath: string): Promise<SessionData | null> },
  requestedSessionId: string,
  workspacePath: string,
): Promise<{ session: SessionData; continuedFromSessionId: string | null }> {
  const requestedSession = await AISessionsRepository.get(requestedSessionId);
  if (!requestedSession || requestedSession.workspacePath !== workspacePath) {
    throw new Error(`Session ${requestedSessionId} not found`);
  }

  const resolvedTarget = await resolvePromptTargetSession(requestedSession, workspacePath);
  const session = await sessionManager.loadSession(resolvedTarget.session.id, workspacePath);
  if (!session) {
    throw new Error(`Session ${resolvedTarget.session.id} not found`);
  }
  if (session.id !== resolvedTarget.session.id) {
    throw new Error(
      `Session mismatch: requested ${resolvedTarget.session.id} but got ${session.id}`,
    );
  }

  return { session, continuedFromSessionId: resolvedTarget.continuedFromSessionId };
}
