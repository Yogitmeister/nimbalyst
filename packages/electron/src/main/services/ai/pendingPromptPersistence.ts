/**
 * Persist the per-session "interactive prompt is open" bit to
 * `ai_sessions.metadata.hasPendingPrompt` and push the same change to
 * connected mobile clients.
 *
 * This is the authoritative source for "Waiting for your response" sidebar
 * indicators across desktop ↔ mobile. The renderer reads it on session list
 * load via `hasPendingInteractivePrompt`, so a stuck atom from a missed
 * resolve event is healed on the next session list refresh.
 *
 * Callers: every place that opens or resolves an interactive prompt
 * (AskUserQuestion, ExitPlanMode, ToolPermission, GitCommitProposal,
 * RequestUserInput / PromptForUserInput).
 *
 * This also notifies `TrayManager`, so the menu bar can never disagree with the
 * sidebar about whether a session is blocked. It used to be a second call every
 * callsite had to remember, and the MCP AskUserQuestion path made neither call
 * for SDK sessions -- a session waiting on a question showed as "Running" in the
 * menu bar panel. Notify here and there is nothing left to forget.
 */

import { AISessionsRepository } from '@nimbalyst/runtime';
import { getSyncProvider } from '../SyncManager';
import { requestMobilePush } from './mobilePushRequest';
import { TrayManager } from '../../tray/TrayManager';
import type { PromptKind } from '../../tray/fleetSnapshot';
import { logger } from '../../utils/logger';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';

/**
 * NIM-2208: session ids whose bit this process has set since startup.
 *
 * The stale-prompt reconcile needs the (normally empty) set of sessions carrying
 * the bit. Reading it back from the DB meant a `SELECT id, metadata FROM
 * ai_sessions` scan over every session row — 5k+ on a working install — on every
 * pass. This function is the single writer of the bit, and the startup sweep
 * clears every row before anything can set one, so an in-memory mirror is
 * authoritative for the running process and costs no query at all.
 */
const sessionsWithPendingPrompt = new Set<string>();

/** Sessions currently carrying a pending-prompt bit set by this process. */
export function getSessionsWithPendingPrompt(): string[] {
  return [...sessionsWithPendingPrompt];
}

/** Reset the mirror; called by the startup sweep once every row is cleared. */
export function resetPendingPromptTracking(): void {
  sessionsWithPendingPrompt.clear();
}

export interface PendingPromptPersistenceOptions {
  /** Generation that opened the prompt, or the exact generation allowed to clear it. */
  attentionGeneration?: string;
}

export interface PendingPromptPersistenceResult {
  applied: boolean;
  superseded: boolean;
  attentionGeneration: string | null;
}

/**
 * `kind` is what the prompt is asking for: `approval` for a tool permission or
 * commit proposal (a tap), `decision` for a question, a plan, or a structured
 * input (thinking required). The menu bar strip colours its dot by it -- a
 * session title does not tell you whether responding costs three seconds or ten
 * minutes, and this does. Every callsite knows which it is opening; the default
 * exists only for the clear path, where it is unused.
 */
export async function setSessionPendingPrompt(
  sessionId: string,
  hasPendingPrompt: boolean,
  kind: PromptKind = 'approval',
  options: PendingPromptPersistenceOptions = {},
): Promise<PendingPromptPersistenceResult> {
  const attentionGeneration = options.attentionGeneration?.trim()
    || getSessionStateManager().getSessionState(sessionId)?.attentionGeneration
    || null;
  if (!sessionId) {
    return { applied: false, superseded: false, attentionGeneration };
  }

  const liveGeneration = getSessionStateManager().getSessionState(sessionId)?.attentionGeneration;
  if (hasPendingPrompt && attentionGeneration && liveGeneration && liveGeneration !== attentionGeneration) {
    return { applied: false, superseded: true, attentionGeneration };
  }

  // A prompt that is already open must not push again -- repeated sets would
  // burn the server's forced-push budget on a single blocked session.
  const wasAlreadyPending = sessionsWithPendingPrompt.has(sessionId);

  let localApplied = false;
  try {
    localApplied = await AISessionsRepository.compareAndSetPendingPrompt(
      sessionId,
      hasPendingPrompt,
      hasPendingPrompt ? attentionGeneration : null,
      !hasPendingPrompt && attentionGeneration ? attentionGeneration : undefined,
    );
  } catch (err) {
    logger.main.warn(
      `[pendingPromptPersistence] Failed to persist hasPendingPrompt=${hasPendingPrompt} for session ${sessionId}:`,
      err,
    );
  }

  if (!localApplied) {
    return { applied: false, superseded: attentionGeneration !== null, attentionGeneration };
  }

  // A replacement may start while the database CAS is in flight. Undo only
  // this generation if it lost ownership; a newer prompt remains untouched.
  if (hasPendingPrompt && attentionGeneration) {
    const currentGeneration = getSessionStateManager().getSessionState(sessionId)?.attentionGeneration;
    if (currentGeneration && currentGeneration !== attentionGeneration) {
      await AISessionsRepository.compareAndSetPendingPrompt(
        sessionId,
        false,
        null,
        attentionGeneration,
      ).catch(() => false);
      return { applied: false, superseded: true, attentionGeneration };
    }
  }

  if (hasPendingPrompt) {
    sessionsWithPendingPrompt.add(sessionId);
    TrayManager.getInstance().onPromptCreated(sessionId, kind);
  } else {
    sessionsWithPendingPrompt.delete(sessionId);
    TrayManager.getInstance().onPromptResolved(sessionId);
  }

  try {
    const sp = getSyncProvider();
    if (sp && localApplied) {
      const metadata = attentionGeneration
        ? {
            hasPendingPrompt,
            pendingPromptGeneration: hasPendingPrompt ? attentionGeneration : null,
            updatedAt: Date.now(),
          }
        : { hasPendingPrompt, updatedAt: Date.now() };
      sp.pushChange(sessionId, {
        type: 'metadata_updated',
        metadata: metadata as any,
      });
    }
  } catch (err) {
    logger.main.warn(
      `[pendingPromptPersistence] Failed to push hasPendingPrompt sync change for session ${sessionId}:`,
      err,
    );
  }

  if (hasPendingPrompt && localApplied && !wasAlreadyPending) {
    void notifyMobileOfBlockedSession(sessionId);
  }

  return {
    applied: localApplied,
    superseded: false,
    attentionGeneration,
  };
}

/**
 * Page the user's phone when a session blocks on a human answer.
 *
 * Forced (#1268): a blocked agent is the case where "notify me even though I
 * appear to be at my desk" is the whole point, so the server's presence
 * suppression is deliberately bypassed and the decision is left to its
 * targeting rules. Never gate this on local presence -- doing so stops the
 * `force` flag from ever reaching the server.
 */
async function notifyMobileOfBlockedSession(sessionId: string): Promise<void> {
  try {
    const session = await AISessionsRepository.get(sessionId);
    const title = session?.title || 'AI Session';
    await requestMobilePush(sessionId, title, 'Waiting for your response', {
      force: true,
      reason: 'awaiting_human',
    });
  } catch (err) {
    logger.main.warn(
      `[pendingPromptPersistence] Failed to request mobile push for blocked session ${sessionId}:`,
      err,
    );
  }
}
