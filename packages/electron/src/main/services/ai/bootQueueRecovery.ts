/**
 * Boot-time re-drive of stranded queues.
 *
 * Exact claim-token/generation reconciliation normalizes rows left mid-flight
 * at quit. Nothing then claimed the `pending` bucket, so a
 * prompt queued before a quit sat there until the user happened to open that
 * session's transcript (#962). This hands every stranded session to the queue
 * driver.
 *
 * Deliberately drives only what the sweep left `pending`: rows the sweep
 * resolved must never be re-sent (NIM-615 / #783).
 */

export interface BootQueueRecoveryDeps {
  listSessionIdsWithPending(): Promise<string[]>;
  getWorkspacePath(sessionId: string): Promise<string | null | undefined>;
  failAllPending(sessionId: string, errorMessage: string): Promise<number>;
  requestDrive(sessionId: string, workspacePath: string): void;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

export interface BootExecutingQueueStore {
  listExecutingSessionIds(): Promise<string[]>;
  listForSession(sessionId: string, options: { includeCompleted: true }): Promise<Array<Pick<
    import('../PGLiteQueuedPromptsStore').QueuedPrompt,
    | 'id'
    | 'sessionId'
    | 'status'
    | 'claimToken'
    | 'dispatchStartedAt'
    | 'terminalStatus'
    | 'attentionGeneration'
    | 'providerThreadId'
    | 'providerTurnId'
    | 'providerTurnState'
  >>>;
  releaseClaim(id: string, sessionId: string, claimToken: string): Promise<import('../PGLiteQueuedPromptsStore').QueueSettlementResult>;
  completeAfterDispatch(id: string, sessionId: string, claimToken: string, terminal?: undefined, attentionGeneration?: string): Promise<import('../PGLiteQueuedPromptsStore').QueueSettlementResult>;
  failAfterDispatch(id: string, error: string, sessionId: string, claimToken: string, terminal?: undefined, attentionGeneration?: string): Promise<import('../PGLiteQueuedPromptsStore').QueueSettlementResult>;
}

/**
 * Reconcile each exact boot owner. Provider-bound nonterminal rows retain their
 * fence until a provider read is available; no message-timestamp sweep runs.
 */
export async function reconcileExecutingQueuesOnBoot(
  store: BootExecutingQueueStore,
): Promise<{ completed: number; failed: number; released: number; retained: number }> {
  const result = { completed: 0, failed: 0, released: 0, retained: 0 };
  for (const sessionId of await store.listExecutingSessionIds()) {
    const rows = (await store.listForSession(sessionId, { includeCompleted: true }))
      .filter((row) => row.status === 'executing');
    for (const row of rows) {
      if (!row.claimToken) {
        result.retained += 1;
        continue;
      }
      if (row.terminalStatus === 'completed' || row.providerTurnState === 'completed') {
        const settled = await store.completeAfterDispatch(
          row.id, sessionId, row.claimToken, undefined, row.attentionGeneration,
        );
        if (settled.outcome === 'settled' || settled.outcome === 'idempotent_same_claim') result.completed += 1;
        else result.retained += 1;
        continue;
      }
      if (
        row.terminalStatus === 'failed'
        || row.providerTurnState === 'failed'
        || row.providerTurnState === 'interrupted'
      ) {
        const settled = await store.failAfterDispatch(
          row.id,
          row.providerTurnState === 'interrupted' ? 'Provider turn interrupted before restart' : 'Provider turn failed before restart',
          sessionId,
          row.claimToken,
          undefined,
          row.attentionGeneration,
        );
        if (settled.outcome === 'settled' || settled.outcome === 'idempotent_same_claim') result.failed += 1;
        else result.retained += 1;
        continue;
      }
      if (!row.dispatchStartedAt) {
        const released = await store.releaseClaim(row.id, sessionId, row.claimToken);
        if (released.outcome === 'settled' || released.outcome === 'idempotent_same_claim') result.released += 1;
        else result.retained += 1;
        continue;
      }
      if (row.providerThreadId || row.providerTurnId) {
        result.retained += 1;
        continue;
      }
      const failed = await store.failAfterDispatch(
        row.id,
        'Host restarted before provider turn identity was available',
        sessionId,
        row.claimToken,
        undefined,
        row.attentionGeneration,
      );
      if (failed.outcome === 'settled' || failed.outcome === 'idempotent_same_claim') result.failed += 1;
      else result.retained += 1;
    }
  }
  return result;
}

/** Returns the number of sessions handed to the driver. */
export async function driveStrandedQueuesOnBoot(deps: BootQueueRecoveryDeps): Promise<number> {
  const sessionIds = await deps.listSessionIdsWithPending();
  if (sessionIds.length === 0) return 0;

  deps.logInfo(`[Main] Boot recovery: driving ${sessionIds.length} session(s) with pending prompts`);

  let driven = 0;
  for (const sessionId of sessionIds) {
    try {
      const workspacePath = await deps.getWorkspacePath(sessionId);
      if (!workspacePath) {
        // Routing needs a workspace; without one there is no window to deliver
        // into and no honest way to pick a fallback. Fail atomically rather
        // than silently leaving the rows pending forever.
        await deps.failAllPending(
          sessionId,
          'Queued prompt delivery failed: workspace mapping unavailable',
        );
        deps.logWarn('[Main] Boot recovery: failed pending prompts for unmapped session');
        continue;
      }
      deps.requestDrive(sessionId, workspacePath);
      driven += 1;
    } catch {
      // One malformed or unavailable session must not prevent later pending
      // rows from reaching their valid workspace driver. Do not expose the
      // workspace, prompt, provider output, or raw exception in this warning.
      deps.logWarn('[Main] Boot recovery: failed to recover one session; continuing');
    }
  }

  return driven;
}
