/**
 * Production wiring for the `claude-code-cli` queue flusher (NIM-806 — input
 * integration / queued prompts).
 *
 * Binds the real `getQueuedPromptsStore()` (the SAME store the renderer and
 * mobile write to via `ai:createQueuedPrompt`) and the shared submit composer,
 * and guards against concurrent flushes for a session. Invoked from the
 * launcher's PID `idle` transition (`claudeCliLauncherSingleton`). Kept separate
 * from the pure core so the core unit-tests without pulling in electron.
 */

import { BrowserWindow } from 'electron';
import { getQueuedPromptsStore } from '../RepositoryManager';
import { getTerminalSessionManager } from '../TerminalSessionManager';
import { submitClaudeCliPromptProduction } from './claudeCliSubmitSingleton';
import { flushNextClaudeCliQueuedPrompt } from './claudeCliQueueFlush';
import { resolveClaudeCliQueuedPromptTarget } from './claudeCliPromptTarget';

/** Per-session guard so two close `idle` events can't double-flush. */
const flushInFlight = new Set<string>();

/**
 * Flush the next queued prompt for a session on PID `idle`. Best-effort and
 * self-guarded — never throws into the turn-state callback.
 */
export async function flushNextClaudeCliQueuedPromptForSession(
  sessionId: string,
  workspacePath: string,
): Promise<boolean> {
  let targetSessionId = sessionId;
  let ownsFlushGuard = false;
  try {
    const store = getQueuedPromptsStore();
    const target = await resolveClaudeCliQueuedPromptTarget(sessionId, workspacePath, store);
    targetSessionId = target.sessionId;

    if (target.transferredPrompts.length > 0) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('ai:queuedPromptsReceived', {
            sessionId,
            promptCount: 0,
            redirectedToSessionId: target.sessionId,
          });
          win.webContents.send('ai:queuedPromptsReceived', {
            sessionId: target.sessionId,
            promptCount: target.transferredPrompts.length,
            continuedFromSessionId: target.continuedFromSessionId,
          });
        }
      }
    }

    if (flushInFlight.has(targetSessionId)) return false;
    // A stale source PID-idle callback may be what reached this boundary. Move
    // the rows, but never claim one until the continuation PTY actually exists.
    if (!getTerminalSessionManager().isTerminalActive(targetSessionId)) return false;

    flushInFlight.add(targetSessionId);
    ownsFlushGuard = true;
    return await flushNextClaudeCliQueuedPrompt(
      { sessionId: targetSessionId, workspacePath },
      {
        listPending: (s) => store.listPending(s),
        claim: (id) => store.claim(id),
        complete: (id) => store.complete(id),
        fail: (id, m) => store.fail(id, m),
        submit: (i) => submitClaudeCliPromptProduction(i),
        // The flush runs from the PID-idle transition with no originating IPC
        // event, so there is no single target window; broadcasting is safe
        // because the renderer filters by sessionId (NIM-830).
        notifyClaimed: (promptId) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('ai:promptClaimed', {
                sessionId: targetSessionId,
                promptId,
              });
            }
          }
        },
      },
    );
  } catch (error) {
    console.warn('[ClaudeCliQueueFlush] flush failed:', error);
    return false;
  } finally {
    if (ownsFlushGuard) {
      flushInFlight.delete(targetSessionId);
    }
  }
}
