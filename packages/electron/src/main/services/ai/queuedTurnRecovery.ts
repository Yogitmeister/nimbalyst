import type { QueuedPrompt, QueuedPromptsStore } from '../PGLiteQueuedPromptsStore';
import type {
  ProviderQueuedTurnSnapshot,
  QueuedTurnControlCapability,
} from '@nimbalyst/runtime/ai/server';

export type ProviderTurnStatus = 'active' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type QueueTurnReconciliation =
  | 'owned-active'
  | 'owned-completed'
  | 'owned-failed'
  | 'owned-interrupted'
  | 'foreign-active'
  | 'missing-terminal'
  | 'uncertain';

export type ProviderThreadRead = ProviderQueuedTurnSnapshot;

/**
 * Classify one exact queued claim against a provider `thread/read` snapshot.
 * Unknown identity is deliberately not inferred from host liveness.
 */
export function reconcileQueuedTurn(
  row: Pick<QueuedPrompt, 'providerTurnId' | 'providerThreadId' | 'terminalStatus'>,
  snapshot: ProviderThreadRead | null,
): QueueTurnReconciliation {
  if (
    !row.providerThreadId
    || !row.providerTurnId
    || !snapshot?.identityProven
    || snapshot.threadId !== row.providerThreadId
  ) return 'uncertain';
  const owned = snapshot.turns.find((turn) => turn.id === row.providerTurnId);
  if (owned?.status === 'active') return 'owned-active';
  if (owned?.status === 'completed') return 'owned-completed';
  if (owned?.status === 'failed') return 'owned-failed';
  if (owned?.status === 'interrupted') return 'owned-interrupted';
  if (snapshot.turns.some((turn) => turn.status === 'active')) return 'foreign-active';
  if (row.terminalStatus === 'completed' || row.terminalStatus === 'failed') return 'missing-terminal';
  return 'uncertain';
}

/**
 * Run before abort/interrupt/idle projection. Any nonterminal or unknown
 * queued turn keeps the writer fence; a user control never substitutes a
 * delivery heuristic for the provider's authoritative thread read.
 */
export async function reconcileQueuedTurnsBeforeControl(
  sessionId: string,
  queueStore: QueuedPromptsStore,
  capability: QueuedTurnControlCapability | null | undefined,
): Promise<{
  allowControl: boolean;
  queuedTurnHandled: boolean;
  exactInterruptSent: boolean;
  states: QueueTurnReconciliation[];
}> {
  const rows = (await queueStore.listForSession(sessionId, { includeCompleted: true }))
    .filter((row) => row.status === 'executing');
  if (rows.length === 0) {
    return { allowControl: true, queuedTurnHandled: false, exactInterruptSent: false, states: [] };
  }

  const snapshot = await capability?.inspect(sessionId) ?? null;
  const states: QueueTurnReconciliation[] = [];
  const ownedActive: QueuedPrompt[] = [];
  for (const row of rows) {
    const state = reconcileQueuedTurn(row, snapshot);
    states.push(state);
    if (state === 'owned-active') {
      ownedActive.push(row);
    } else if (state === 'owned-completed') {
      await queueStore.completeAfterDispatch(
        row.id, row.sessionId, row.claimToken!, undefined, row.attentionGeneration,
      );
    } else if (state === 'owned-failed' || state === 'owned-interrupted') {
      await queueStore.failAfterDispatch(
        row.id,
        state === 'owned-failed' ? 'Provider turn failed' : 'Provider turn interrupted',
        row.sessionId,
        row.claimToken!,
        undefined,
        row.attentionGeneration,
      );
    }
  }

  const durableTurnIds = new Set(rows.map((row) => row.providerTurnId).filter(Boolean));
  const hasForeignActive = snapshot?.turns.some(
    (turn) => turn.status === 'active' && !durableTurnIds.has(turn.id),
  ) ?? false;
  const hasUnknownOwner = states.some((state) => state === 'foreign-active' || state === 'uncertain');
  if (hasForeignActive || hasUnknownOwner || ownedActive.length > 1 || !capability) {
    return { allowControl: false, queuedTurnHandled: true, exactInterruptSent: false, states };
  }

  if (ownedActive.length === 1) {
    const row = ownedActive[0];
    const interrupted = await capability.interruptExact(sessionId, {
      threadId: row.providerThreadId!,
      turnId: row.providerTurnId!,
    });
    return {
      allowControl: interrupted,
      queuedTurnHandled: true,
      exactInterruptSent: interrupted,
      states,
    };
  }

  return {
    allowControl: states.every((state) => (
      state === 'owned-completed' || state === 'owned-failed' || state === 'owned-interrupted'
    )),
    queuedTurnHandled: true,
    exactInterruptSent: false,
    states,
  };
}
