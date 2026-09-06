import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';
import { payloadReceiptsMatch, queueTruthMismatchError, type QueuedPromptPayloadReceipt } from './queuedPromptTruth';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import type { QueueSettlementResult } from '../PGLiteQueuedPromptsStore';

export type SessionPromptDispatchPreflight = (sessionId: string) => Promise<boolean>;

interface SessionWithDispatchMetadata {
  metadata?: unknown;
}

/**
 * Build the single fail-closed gate used by every queued-prompt admission rail.
 * A missing/unreadable session or malformed metadata is not safe to dispatch;
 * legacy sessions with no metadata remain eligible.
 */
export function createSessionPromptDispatchPreflight(
  loadSession: (sessionId: string) => Promise<SessionWithDispatchMetadata | null>,
): SessionPromptDispatchPreflight {
  return async (sessionId: string): Promise<boolean> => {
    try {
      const session = await loadSession(sessionId);
      if (!session) return false;

      let metadata = session.metadata;
      if (metadata === null || metadata === undefined) return true;
      if (typeof metadata === 'string') {
        try {
          metadata = JSON.parse(metadata) as unknown;
        } catch {
          return false;
        }
      }
      if (typeof metadata !== 'object' || Array.isArray(metadata)) return false;

      return (metadata as Record<string, unknown>).modelChangeReconciliation == null;
    } catch {
      return false;
    }
  };
}

/** Production repository-backed gate shared by SDK, CLI, startup, and IPC rails. */
export const preflightSessionPromptDispatch = createSessionPromptDispatchPreflight(
  (sessionId) => AISessionsRepository.get(sessionId),
);

export interface ClaimedQueuedPrompt {
  id: string;
  prompt: string;
  claimToken?: string;
  attachments?: unknown[] | null;
  documentContext?: DocumentContext | null;
  payloadReceipt?: QueuedPromptPayloadReceipt;
  clientSubmissionId?: string;
  sourceSessionId?: string;
  sourceRoomId?: string;
  submissionSequence?: number;
  producer?: string;
  claimTrigger?: string;
  claimTriggeredAt?: number;
  turnId?: string;
  providerInputMessageId?: string;
  providerOutputMessageId?: string;
}

export interface QueuedPromptStoreLike {
  listPending(sessionId: string): Promise<ClaimedQueuedPrompt[]>;
  claim(promptId: string, expectedSessionId: string, claimTrigger?: string): Promise<ClaimedQueuedPrompt | null>;
  beginDispatch(promptId: string, expectedSessionId: string, claimToken: string): Promise<QueueSettlementResult>;
  releaseClaim(promptId: string, expectedSessionId: string, claimToken: string): Promise<QueueSettlementResult>;
  completeAfterDispatch(promptId: string, expectedSessionId: string, claimToken: string, terminal?: QueuedPromptTerminalReceipt): Promise<QueueSettlementResult>;
  failAfterDispatch(promptId: string, errorMessage: string, expectedSessionId: string, claimToken: string, terminal?: QueuedPromptTerminalReceipt): Promise<QueueSettlementResult>;
}

export interface QueuedPromptTerminalReceipt {
  lifecycle: 'completed' | 'failed';
  terminalAt: number;
  eventSequence: number;
}

const settlementAccepted = (result: QueueSettlementResult): boolean =>
  result.outcome === 'settled' || result.outcome === 'idempotent_same_claim';

interface DispatchClaimedQueuedPromptOptions {
  claimed: ClaimedQueuedPrompt;
  continueQueuedPromptChain: (
    sessionId: string,
    workspacePath: string,
    targetWindow: Electron.BrowserWindow,
    source: string,
  ) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  onAfterSettled?: () => Promise<void>;
  onChainSettled?: (payload: { sessionId: string; workspacePath: string; source: string }) => Promise<void>;
  onPromptClaimed: (payload: { sessionId: string; promptId: string }) => void;
  processingLeases: Map<string, symbol>;
  queueStore: QueuedPromptStoreLike;
  /**
   * Marks a session as "committed" (past the point of no return) for the
   * exact duration this dispatch is inside `sendMessageHandler`. Unlike
   * `processingLeases`, cancellation must NOT delete this on fence install --
   * it exists so a concurrent cancellation whose native census finds zero
   * owners can tell "genuinely nothing will ever start" (safe to declare
   * proven-no-owner) apart from "a dispatch already committed to running but
   * hasn't registered a native owner yet" (must not declare proven-no-owner).
   * See NIM-590 batch item 1.
   */
  sessionDispatchCommitments: Map<string, symbol>;
  sendMessageHandler: (
    event: Electron.IpcMainInvokeEvent,
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    workspacePath?: string,
  ) => Promise<{ content: string; queuedPromptTerminal?: QueuedPromptTerminalReceipt }>;
  sessionId: string;
  source: string;
  startSession: (options: { sessionId: string; workspacePath: string }) => Promise<void>;
  targetWindow: Electron.BrowserWindow;
  workspacePath: string;
}

export async function dispatchClaimedQueuedPrompt(
  options: DispatchClaimedQueuedPromptOptions,
): Promise<boolean> {
  const {
    claimed,
    continueQueuedPromptChain,
    logError,
    onAfterSettled,
    onChainSettled,
    onPromptClaimed,
    processingLeases,
    queueStore,
    sendMessageHandler,
    sessionDispatchCommitments,
    sessionId,
    source,
    startSession,
    targetWindow,
    workspacePath,
  } = options;

  const dispatchLease = Symbol(`queued-prompt:${sessionId}:${claimed.id}`);
  const claimToken = claimed.claimToken;
  if (!claimToken) {
    // queueStore.claim() always sets a randomUUID() claim_token on a genuine
    // claim -- this branch is unreachable in production. It exists only for
    // defensive type-narrowing (or a misbehaving mock). Do NOT attempt a
    // durable releaseClaim('') here: the store requires an exact claim_token
    // match, so an empty token can never match a real row and the call is
    // guaranteed to no-op -- worse, sweepExecuting also requires claim_token
    // IS NOT NULL, so a row that ever reached this state would have zero
    // recovery path anywhere in the system. Calling releaseClaim would only
    // give false confidence that something was cleaned up. See NIM-590 batch
    // item 8.
    logError(
      `[AIService] Claimed queued prompt ${claimed.id} (session ${sessionId}) has no ownership token -- this violates queueStore.claim()'s contract and cannot be durably released by token. Investigate the claim path; no automatic recovery exists for this row.`,
      new Error('claimed prompt missing ownership token'),
    );
    return false;
  }
  processingLeases.set(sessionId, dispatchLease);

  try {
    await startSession({ sessionId, workspacePath });
  } catch (error) {
    const release = await queueStore.releaseClaim(claimed.id, sessionId, claimToken);
    if (!settlementAccepted(release)) {
      logError(
        `[AIService] Failed to release pre-dispatch claim ${claimed.id} (${release.outcome})`,
        error,
      );
    }
    if (processingLeases.get(sessionId) === dispatchLease) {
      processingLeases.delete(sessionId);
    }
    throw error;
  }

  try {
    onPromptClaimed({ sessionId, promptId: claimed.id });
  } catch (notificationError) {
    logError(`[AIService] Failed to notify renderer of claimed prompt ${claimed.id}:`, notificationError);
  }

  const docContext = {
    ...(claimed.documentContext || {}),
    queuedPromptId: claimed.id,
    attachments: claimed.attachments,
    // This travels with the persisted input message. It binds the source and
    // terminal-output identities without using timestamps, prompt text, or
    // array position as a proxy.
    queuedPromptTruth: {
      clientSubmissionId: claimed.clientSubmissionId ?? claimed.id,
      queueRowId: claimed.id,
      sourceSessionId: claimed.sourceSessionId ?? sessionId,
      sourceRoomId: claimed.sourceRoomId ?? sessionId,
      submissionSequence: claimed.submissionSequence,
      producer: claimed.producer,
      claimTrigger: claimed.claimTrigger,
      claimTriggeredAt: claimed.claimTriggeredAt,
      turnId: claimed.turnId,
      providerInputMessageId: claimed.providerInputMessageId,
      providerOutputMessageId: claimed.providerOutputMessageId,
      payloadReceipt: claimed.payloadReceipt,
      lifecycle: 'streaming' as const,
    },
  } as DocumentContext;

  let admissionSettled = false;
  let settleAdmission!: (dispatched: boolean) => void;
  const admission = new Promise<boolean>((resolve) => {
    settleAdmission = (dispatched) => {
      if (admissionSettled) return;
      admissionSettled = true;
      resolve(dispatched);
    };
  });

  setImmediate(async () => {
    let dispatchStarted = false;
    let compatibleSettlement = false;
    try {
      if (processingLeases.get(sessionId) !== dispatchLease) {
        settleAdmission(false);
        return;
      }
      if (claimed.payloadReceipt && !payloadReceiptsMatch(claimed.prompt, claimed.payloadReceipt)) {
        throw queueTruthMismatchError();
      }
      const begin = await queueStore.beginDispatch(claimed.id, sessionId, claimToken);
      if (!settlementAccepted(begin)) {
        logError(
          `[AIService] Dispatch intent rejected for queued prompt ${claimed.id} (${begin.outcome})`,
          new Error(begin.outcome),
        );
        settleAdmission(false);
        return;
      }
      dispatchStarted = true;
      if (processingLeases.get(sessionId) !== dispatchLease) {
        settleAdmission(false);
        return;
      }

      const mockEvent = {
        sender: targetWindow.webContents,
        senderFrame: targetWindow.webContents.mainFrame,
      } as Electron.IpcMainInvokeEvent;

      // The handler invocation is the point at which this attempt becomes an
      // actual dispatch. Resolve the caller-facing admission receipt before
      // awaiting the stream, but never report true for a pre-start revocation.
      settleAdmission(true);
      // Past this point the dispatch lease can no longer be revoked in time --
      // sendMessageHandler is about to run unconditionally and will
      // eventually register a real native owner. Record the commitment so a
      // concurrent cancellation's native census (which cannot see this turn
      // until it registers) does not mistake "not yet visible" for "proven
      // absent". Cleared unconditionally in the finally below.
      sessionDispatchCommitments.set(sessionId, dispatchLease);
      const result = await sendMessageHandler(mockEvent, claimed.prompt, docContext, sessionId, workspacePath);
      const completion = result.queuedPromptTerminal?.lifecycle === 'failed'
        ? await queueStore.failAfterDispatch(
            claimed.id,
            'Provider returned a terminal error',
            sessionId,
            claimToken,
            result.queuedPromptTerminal,
          )
        : result.queuedPromptTerminal
          ? await queueStore.completeAfterDispatch(claimed.id, sessionId, claimToken, result.queuedPromptTerminal)
          : await queueStore.completeAfterDispatch(claimed.id, sessionId, claimToken);
      compatibleSettlement = settlementAccepted(completion);
      if (!compatibleSettlement) {
        logError(
          `[AIService] Completion rejected for queued prompt ${claimed.id} (${completion.outcome})`,
          new Error(completion.outcome),
        );
      }
    } catch (queueError) {
      logError(`[AIService] Failed to process queued prompt ${claimed.id}:`, queueError);
      const terminal = (queueError as Error & { queuedPromptTerminal?: QueuedPromptTerminalReceipt }).queuedPromptTerminal;
      const settlement = dispatchStarted
        ? terminal
          ? await queueStore.failAfterDispatch(
              claimed.id,
              queueError instanceof Error ? queueError.message : 'Unknown error',
              sessionId,
              claimToken,
              terminal,
            )
          : await queueStore.failAfterDispatch(
              claimed.id,
              queueError instanceof Error ? queueError.message : 'Unknown error',
              sessionId,
              claimToken,
            )
        : await queueStore.releaseClaim(claimed.id, sessionId, claimToken);
      compatibleSettlement = settlementAccepted(settlement);
      if (!compatibleSettlement) {
        logError(
          `[AIService] Failure settlement rejected for queued prompt ${claimed.id} (${settlement.outcome})`,
          queueError,
        );
      }
    } finally {
      settleAdmission(false);
      // Unconditional: sendMessageHandler has now settled (success, rejected
      // completion, or thrown), so a native owner either exists (census will
      // find it) or will never appear for this attempt. Clear regardless of
      // which branch above ran, mirroring settleAdmission(false) just above --
      // an early return anywhere in this block must never leak this entry.
      if (sessionDispatchCommitments.get(sessionId) === dispatchLease) {
        sessionDispatchCommitments.delete(sessionId);
      }
      // An interrupt revokes this dispatch's lease before a priority prompt
      // acquires a replacement. The interrupted dispatch can settle later, but
      // its stale finally block must not release the replacement lease or
      // continue the ordinary FIFO chain concurrently with priority delivery.
      if (processingLeases.get(sessionId) !== dispatchLease) {
        return;
      }
      processingLeases.delete(sessionId);
      if (!compatibleSettlement) {
        // startSession() already established a local running lifecycle before
        // the durable begin was accepted. If begin declined (or could not be
        // settled) and this dispatch still owns the lease, nobody else can end
        // that local lifecycle. A replacement lease is fenced by the identity
        // check above and remains untouched.
        if (onChainSettled) {
          try {
            await onChainSettled({ sessionId, workspacePath, source });
          } catch (settledErr) {
            logError(`[AIService] ${source} finally: incompatible-dispatch lifecycle settlement failed:`, settledErr);
          }
        }
        return;
      }
      try {
        await continueQueuedPromptChain(
          sessionId,
          workspacePath,
          targetWindow,
          `${source} finally`,
        );
      } catch (chainErr) {
        logError(`[AIService] ${source} finally: error checking for pending prompts:`, chainErr);
      }
      // If no follow-on prompt was dispatched, the chain has fully settled.
      // The inner sendMessage's completion handler deferred endSession because
      // processingLeases still contained this session (we hadn't reached this
      // delete yet), so nobody has marked the session idle. Do it now.
      if (!processingLeases.has(sessionId) && onChainSettled) {
        try {
          await onChainSettled({ sessionId, workspacePath, source });
        } catch (settledErr) {
          logError(`[AIService] ${source} finally: chain-settled hook failed:`, settledErr);
        }
      }
      if (onAfterSettled) {
        try {
          await onAfterSettled();
        } catch (afterErr) {
          logError(`[AIService] ${source} finally: post-settle hook failed:`, afterErr);
        }
      }
    }
  });

  return admission;
}

interface TryClaimAndDispatchNextQueuedPromptOptions {
  claimReservations: Map<string, symbol>;
  continueQueuedPromptChain: DispatchClaimedQueuedPromptOptions['continueQueuedPromptChain'];
  isTurnAdmissionBlocked: (sessionId: string) => boolean;
  logError: DispatchClaimedQueuedPromptOptions['logError'];
  logInfo: (message: string) => void;
  onAfterSettled?: DispatchClaimedQueuedPromptOptions['onAfterSettled'];
  onChainSettled?: DispatchClaimedQueuedPromptOptions['onChainSettled'];
  onPromptClaimed: DispatchClaimedQueuedPromptOptions['onPromptClaimed'];
  processingLeases: Map<string, symbol>;
  preflight: SessionPromptDispatchPreflight;
  queueStore: QueuedPromptStoreLike;
  sendMessageHandler: DispatchClaimedQueuedPromptOptions['sendMessageHandler'] | null;
  sessionDispatchCommitments: DispatchClaimedQueuedPromptOptions['sessionDispatchCommitments'];
  sessionId: string;
  source: string;
  startSession: DispatchClaimedQueuedPromptOptions['startSession'];
  resolveLiveWindow?: (workspacePath: string) => Electron.BrowserWindow | null;
  targetWindow: Electron.BrowserWindow | null;
  workspacePath: string;
}

const claimAttemptOperations = new WeakMap<
  Map<string, symbol>,
  Map<string, Promise<boolean>>
>();

export function tryClaimAndDispatchNextQueuedPrompt(
  options: TryClaimAndDispatchNextQueuedPromptOptions,
): Promise<boolean> {
  let operations = claimAttemptOperations.get(options.claimReservations);
  if (!operations) {
    operations = new Map();
    claimAttemptOperations.set(options.claimReservations, operations);
  }
  const existing = operations.get(options.sessionId);
  if (existing) return existing;

  let begin!: () => void;
  const beginGate = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const operation = (async () => {
    await beginGate;
    return executeClaimAndDispatchNextQueuedPrompt(options);
  })();
  operations.set(options.sessionId, operation);
  const cleanup = () => {
    if (operations?.get(options.sessionId) === operation) {
      operations.delete(options.sessionId);
    }
  };
  void operation.then(cleanup, cleanup);
  begin();
  return operation;
}

async function executeClaimAndDispatchNextQueuedPrompt(
  options: TryClaimAndDispatchNextQueuedPromptOptions,
): Promise<boolean> {
  const {
    claimReservations,
    continueQueuedPromptChain,
    isTurnAdmissionBlocked,
    logError,
    logInfo,
    onAfterSettled,
    onChainSettled,
    onPromptClaimed,
    processingLeases,
    preflight,
    queueStore,
    sendMessageHandler,
    sessionDispatchCommitments,
    sessionId,
    source,
    startSession,
    resolveLiveWindow,
    targetWindow,
    workspacePath,
  } = options;

  const liveWindow =
    targetWindow && !targetWindow.isDestroyed()
      ? targetWindow
      : resolveLiveWindow?.(workspacePath) ?? null;

  if (!liveWindow || liveWindow.isDestroyed()) {
    logInfo(`[AIService] ${source}: no live window available to continue queued prompts for session ${sessionId}`);
    return false;
  }

  if (
    processingLeases.has(sessionId)
    || claimReservations.has(sessionId)
    || isTurnAdmissionBlocked(sessionId)
  ) {
    logInfo(`[AIService] ${source}: session ${sessionId} already owns turn admission, skipping queued prompt`);
    return false;
  }

  // A claim attempt is not an active dispatch chain. Keep its reservation in
  // a separate map so streaming completion never mistakes a probe that may
  // decline for the owner that will eventually settle the session.
  const reservation = Symbol(`queued-prompt-claim:${sessionId}`);
  claimReservations.set(sessionId, reservation);
  const ownsReservation = (): boolean => claimReservations.get(sessionId) === reservation;
  const releaseReservation = (): void => {
    if (ownsReservation()) claimReservations.delete(sessionId);
  };

  try {
    if (!(await preflight(sessionId))) {
      logInfo(`[AIService] ${source}: durable model reconciliation blocks queued dispatch for session ${sessionId}`);
      return false;
    }
    if (!ownsReservation()) return false;

    const pendingPrompts = await queueStore.listPending(sessionId);
    if (!ownsReservation()) return false;
    if (pendingPrompts.length === 0) {
      logInfo(`[AIService] ${source}: no pending prompts for session ${sessionId}`);
      return false;
    }

    const nextPrompt = pendingPrompts[0];
    logInfo(`[AIService] ${source}: processing prompt ${nextPrompt.id} for session ${sessionId}`);

    const claimed = await queueStore.claim(nextPrompt.id, sessionId, source);
    if (!claimed) {
      logInfo(`[AIService] ${source}: prompt ${nextPrompt.id} already claimed`);
      return false;
    }

    if (!claimed.claimToken) {
      // See the identical branch in dispatchClaimedQueuedPrompt: this is
      // unreachable in production (claim() always sets a randomUUID token),
      // and a durable releaseClaim('') call is guaranteed to no-op against a
      // real row -- do not pretend it recovered anything. NIM-590 batch item 8.
      logError(
        `[AIService] Claimed queued prompt ${claimed.id} (session ${sessionId}) has no ownership token -- this violates queueStore.claim()'s contract and cannot be durably released by token. Investigate the claim path; no automatic recovery exists for this row.`,
        new Error('claimed prompt missing ownership token'),
      );
      return false;
    }

    if (!sendMessageHandler || !ownsReservation()) {
      const release = await queueStore.releaseClaim(claimed.id, sessionId, claimed.claimToken);
      if (!settlementAccepted(release)) {
        logError(
          `[AIService] Failed to release undispatched claim ${claimed.id} (${release.outcome})`,
          new Error(release.outcome),
        );
      }
      if (!sendMessageHandler) {
        logError('[AIService] Failed to process queued prompt because sendMessageHandler is not initialized', new Error('sendMessageHandler not initialized'));
      }
      return false;
    }

    // dispatchClaimedQueuedPrompt installs its dispatch lease synchronously
    // before its first await. Release the tentative reservation only after
    // that handoff has happened, leaving no admission gap between the two.
    const dispatchPromise = dispatchClaimedQueuedPrompt({
      claimed,
      continueQueuedPromptChain,
      logError,
      onAfterSettled,
      onChainSettled,
      onPromptClaimed,
      processingLeases,
      queueStore,
      sendMessageHandler,
      sessionDispatchCommitments,
      sessionId,
      source,
      startSession,
      targetWindow: liveWindow,
      workspacePath,
    });
    releaseReservation();
    return await dispatchPromise;
  } finally {
    releaseReservation();
  }
}
