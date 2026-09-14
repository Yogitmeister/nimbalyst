import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { endHostBoundAiSession } from './aiServiceQueuedChainSettlement';
import { settleTerminalAttentionBeforeContinuation } from './terminalAttentionSettlement';

export interface OrphanedPromptTurnOwnership {
  sessionId: string;
  attentionGeneration: string;
}

/** Settle an orphan only while its immutable generation is still current. */
export async function settleOrphanedPromptTurn(
  ownership: OrphanedPromptTurnOwnership,
  reason: 'error' | 'cancelled' | 'interrupted' = 'error',
  stateManager = getSessionStateManager(),
): Promise<boolean> {
  const current = stateManager.getSessionState(ownership.sessionId);
  if (!current || current.attentionGeneration !== ownership.attentionGeneration) return false;

  const settlement = await settleTerminalAttentionBeforeContinuation(
    {
      sessionId: ownership.sessionId,
      attentionGeneration: ownership.attentionGeneration,
      reason,
    },
    () => endHostBoundAiSession(
      stateManager,
      ownership.sessionId,
      ownership.attentionGeneration,
    ),
  );
  return settlement.continuationResult === true;
}
