import {
  setSessionPendingPrompt,
  type PendingPromptPersistenceResult,
} from './pendingPromptPersistence';

export type TerminalAttentionReason = 'completed' | 'error' | 'cancelled' | 'interrupted';

export interface TerminalAttentionSettlementArgs {
  sessionId: string;
  attentionGeneration: string;
  reason: TerminalAttentionReason;
}

export interface TerminalAttentionSettlementDeps {
  clearPendingPrompt: typeof setSessionPendingPrompt;
}

const defaultDeps: TerminalAttentionSettlementDeps = {
  clearPendingPrompt: setSessionPendingPrompt,
};

/**
 * Compare-clear one turn's pending-prompt marker before its terminal mutation.
 * The continuation is withheld when a replacement generation owns the marker.
 */
export async function settleTerminalAttentionBeforeContinuation<T>(
  args: TerminalAttentionSettlementArgs,
  continuation: (promptClear: PendingPromptPersistenceResult) => Promise<T>,
  deps: TerminalAttentionSettlementDeps = defaultDeps,
): Promise<{ promptClear: PendingPromptPersistenceResult; continuationResult?: T }> {
  const promptClear = await deps.clearPendingPrompt(
    args.sessionId,
    false,
    'approval',
    { attentionGeneration: args.attentionGeneration },
  );
  if (promptClear.superseded) return { promptClear };
  const continuationResult = await continuation(promptClear);
  return { promptClear, continuationResult };
}
