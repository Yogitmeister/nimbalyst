import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { revokeHostBoundMcpAuthority } from '../../mcp/httpServer';
import { settleTerminalAttentionBeforeContinuation } from './terminalAttentionSettlement';

type SessionEndManager = Pick<
  ReturnType<typeof getSessionStateManager>,
  'endSession' | 'getSessionState' | 'updateActivity'
>;

/** Prove ownership, revoke synchronously, re-prove after transport awaits, then settle. */
export async function terminateHostBoundAiSession(
  sessionId: string,
  terminalTransition: () => Promise<void>,
  ownsTerminalTurn: () => boolean,
  revokeAuthority: (sessionId: string) => Promise<void> = revokeHostBoundMcpAuthority,
): Promise<boolean> {
  if (!ownsTerminalTurn()) return false;
  await revokeAuthority(sessionId);
  if (!ownsTerminalTurn()) return false;
  await terminalTransition();
  return true;
}

export async function endHostBoundAiSession(
  stateManager: SessionEndManager,
  sessionId: string,
  attentionGeneration: string,
): Promise<boolean> {
  return terminateHostBoundAiSession(
    sessionId,
    () => stateManager.endSession(sessionId, { attentionGeneration }),
    () => stateManager.getSessionState(sessionId)?.attentionGeneration === attentionGeneration,
  );
}

export interface AIServiceQueuedChainSettlementPayload {
  sessionId: string;
  workspacePath: string;
  source: string;
  attentionGeneration?: string;
  outcome: 'completed' | 'failed';
}

export interface AIServiceQueuedChainSettlementTracker {
  readonly settledChildErrored: boolean;
  onChainSettled(payload: AIServiceQueuedChainSettlementPayload): Promise<void>;
}

export function createAIServiceQueuedChainSettlement(deps: {
  stateManager?: SessionEndManager;
  scheduleStop(sessionId: string, delayMs: number): void;
  logInfo(message: string): void;
}): AIServiceQueuedChainSettlementTracker {
  const stateManager = deps.stateManager ?? getSessionStateManager();
  let settledChildErrored = false;

  return {
    get settledChildErrored() {
      return settledChildErrored;
    },
    async onChainSettled(payload) {
      const generation = payload.attentionGeneration;
      settledChildErrored = payload.outcome === 'failed';
      if (!generation) {
        deps.logInfo(`[AIService] ${payload.source}: refusing generationless chain settlement for ${payload.sessionId}`);
        return;
      }
      const current = stateManager.getSessionState(payload.sessionId);
      if (!current || current.attentionGeneration !== generation) return;

      if (payload.outcome === 'failed' && current.status !== 'error') {
        await stateManager.updateActivity({
          sessionId: payload.sessionId,
          status: 'error',
          attentionGeneration: generation,
        });
      }

      await settleTerminalAttentionBeforeContinuation(
        {
          sessionId: payload.sessionId,
          attentionGeneration: generation,
          reason: payload.outcome === 'failed' ? 'error' : 'completed',
        },
        () => endHostBoundAiSession(stateManager, payload.sessionId, generation),
      );

      if (!stateManager.getSessionState(payload.sessionId)) {
        deps.scheduleStop(payload.sessionId, 500);
      }
    },
  };
}
