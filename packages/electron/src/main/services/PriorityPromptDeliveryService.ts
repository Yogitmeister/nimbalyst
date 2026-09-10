// [ASTRA-ORCH]
import { createHash, randomUUID } from 'crypto';

export type PriorityTargetStatus = 'idle' | 'running' | 'waiting_for_input' | 'error' | 'interrupted' | 'missing';

export interface PriorityTargetState {
  status: PriorityTargetStatus;
  generation: string;
  lastActivity: number | null;
  updatedAt: number | null;
}

export function createPriorityTargetGeneration(
  status: PriorityTargetStatus,
  lastActivity: number | null,
  updatedAt: number | null,
): string {
  return `${status}:${lastActivity ?? 'none'}:${updatedAt ?? 'none'}`;
}

export interface PriorityInterruptReceipt {
  generation: string;
  attempted: boolean;
  success: boolean;
  method: string | null;
  error: string | null;
  nativeEntered: boolean;
  recordedAt: number;
}

export interface PriorityControlPrompt {
  id: string;
  sessionId: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  deliveryClass: 'control';
  priorityRank: number;
  deliveryReady?: boolean;
  interruptTargetGeneration: string | null;
  interruptReservationOwner: string | null;
  interruptReceipt: PriorityInterruptReceipt | null;
  errorMessage?: string;
}

interface CreateControlPromptInput {
  id: string;
  sessionId: string;
  prompt: string;
  producer: string;
  idempotencyKey: string;
  requestDigest: string;
  controlOperation: string;
}

interface Dependencies {
  createControlPrompt(input: CreateControlPromptInput): Promise<{ row: PriorityControlPrompt; replayed: boolean }>;
  getTargetState(sessionId: string, workspacePath: string): Promise<PriorityTargetState>;
  hasStructuredPendingPrompt(sessionId: string): Promise<boolean>;
  reserveInterrupt(input: { promptId: string; generation: string; owner: string }): Promise<{ row: PriorityControlPrompt; reserved: boolean }>;
  recordInterruptReceipt(input: { promptId: string; generation: string; receipt: PriorityInterruptReceipt }): Promise<PriorityControlPrompt>;
  interruptCurrentTurn(sessionId: string, expectedState: PriorityTargetState): Promise<{ success: boolean; method?: string; error?: string; nativeEntered?: boolean }>;
  triggerProcessing(sessionId: string, workspacePath: string): Promise<boolean>;
  getControlPrompt(promptId: string): Promise<PriorityControlPrompt | null>;
  createReservationOwner?(): string;
  createControlPromptId?(): string;
}

export interface DeliverPriorityPromptInput {
  sessionId: string;
  workspacePath: string;
  prompt: string;
  idempotencyKey: string;
  producer: string;
  controlOperation: string;
  interruptWaitingForInput: boolean;
}

export interface PriorityPromptDeliveryReceipt {
  sessionId: string;
  queuedPromptId: string;
  deliveryClass: 'control';
  priorityRank: number;
  idempotencyKey: string;
  producer: string;
  controlOperation: string;
  replayed: boolean;
  action: 'processing_triggered' | 'queued_waiting_for_authority' | 'structured_prompt_requires_response' | 'interrupt_attempted' | 'interrupt_receipt_replayed' | 'interrupt_already_reserved' | 'stale_generation_rejected';
  targetBefore: PriorityTargetState;
  targetAfter: PriorityTargetState;
  processingTriggerCalled: boolean;
  processingTriggerAccepted: boolean;
  interrupt: { attempted: boolean; success: boolean | null; method: string | null; error: string | null; nativeEntered: boolean; targetGeneration: string | null; reservationOwner: string | null };
}

function required(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function digest(input: { sessionId: string; prompt: string; producer: string; controlOperation: string }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function interrupt(row: PriorityControlPrompt, receipt: PriorityInterruptReceipt | null) {
  return {
    attempted: receipt?.attempted ?? false,
    success: receipt?.success ?? null,
    method: receipt?.method ?? null,
    error: receipt?.error ?? null,
    nativeEntered: receipt?.nativeEntered ?? false,
    targetGeneration: row.interruptTargetGeneration,
    reservationOwner: row.interruptReservationOwner,
  };
}

export function createPriorityPromptDeliveryService(deps: Dependencies) {
  return {
    async deliver(raw: DeliverPriorityPromptInput): Promise<PriorityPromptDeliveryReceipt> {
      const sessionId = required(raw.sessionId, 'sessionId');
      const workspacePath = required(raw.workspacePath, 'workspacePath');
      const prompt = required(raw.prompt, 'prompt');
      const idempotencyKey = required(raw.idempotencyKey, 'idempotencyKey');
      const producer = required(raw.producer, 'producer');
      const controlOperation = required(raw.controlOperation, 'controlOperation');
      const created = await deps.createControlPrompt({
        id: deps.createControlPromptId?.() ?? `control-${randomUUID()}`,
        sessionId, prompt, producer, idempotencyKey,
        requestDigest: digest({ sessionId, prompt, producer, controlOperation }), controlOperation,
      });
      let row = created.row;
      if (row.status === 'failed' && !row.interruptReceipt) {
        throw new Error(row.errorMessage ?? 'Priority control prompt failed before its interrupt outcome was recorded');
      }
      const targetBefore = await deps.getTargetState(sessionId, workspacePath);
      const result = (action: PriorityPromptDeliveryReceipt['action'], targetAfter: PriorityTargetState, called: boolean, accepted: boolean): PriorityPromptDeliveryReceipt => ({
        sessionId, queuedPromptId: row.id, deliveryClass: 'control', priorityRank: row.priorityRank,
        idempotencyKey, producer, controlOperation, replayed: created.replayed, action, targetBefore, targetAfter,
        processingTriggerCalled: called, processingTriggerAccepted: accepted, interrupt: interrupt(row, row.interruptReceipt),
      });
      if (row.interruptReceipt) {
        const retry = row.status === 'pending' && row.interruptReceipt.success;
        const accepted = retry ? await deps.triggerProcessing(sessionId, workspacePath) : false;
        return result('interrupt_receipt_replayed', retry ? await deps.getTargetState(sessionId, workspacePath) : targetBefore, retry, accepted);
      }
      if (targetBefore.status === 'waiting_for_input') {
        if (await deps.hasStructuredPendingPrompt(sessionId)) return result('structured_prompt_requires_response', targetBefore, false, false);
        if (!raw.interruptWaitingForInput) return result('queued_waiting_for_authority', targetBefore, false, false);
      }
      if (targetBefore.status === 'missing') throw new Error(`Session ${sessionId} disappeared before priority delivery`);
      const needsInterrupt = targetBefore.status === 'running' || targetBefore.status === 'waiting_for_input';
      const reservation = await deps.reserveInterrupt({ promptId: row.id, generation: targetBefore.generation, owner: deps.createReservationOwner?.() ?? randomUUID() });
      row = reservation.row;
      if (!reservation.reserved) {
        row = await deps.getControlPrompt(row.id) ?? row;
        const retry = Boolean(row.interruptReceipt?.success && row.status === 'pending');
        const accepted = retry ? await deps.triggerProcessing(sessionId, workspacePath) : false;
        return result(row.interruptReceipt ? 'interrupt_receipt_replayed' : 'interrupt_already_reserved', await deps.getTargetState(sessionId, workspacePath), retry, accepted);
      }
      const current = await deps.getTargetState(sessionId, workspacePath);
      if (current.generation !== targetBefore.generation || current.status !== targetBefore.status) {
        row = await deps.recordInterruptReceipt({ promptId: row.id, generation: targetBefore.generation, receipt: { generation: targetBefore.generation, attempted: false, success: false, method: null, error: 'stale lifecycle generation', nativeEntered: false, recordedAt: Date.now() } });
        return result('stale_generation_rejected', await deps.getTargetState(sessionId, workspacePath), false, false);
      }
      if (!needsInterrupt) {
        row = await deps.recordInterruptReceipt({ promptId: row.id, generation: targetBefore.generation, receipt: { generation: targetBefore.generation, attempted: false, success: true, method: 'not-required', error: null, nativeEntered: false, recordedAt: Date.now() } });
        const accepted = await deps.triggerProcessing(sessionId, workspacePath);
        return result('processing_triggered', await deps.getTargetState(sessionId, workspacePath), true, accepted);
      }
      const attempted = await deps.interruptCurrentTurn(sessionId, targetBefore);
      row = await deps.recordInterruptReceipt({ promptId: row.id, generation: targetBefore.generation, receipt: { generation: targetBefore.generation, attempted: true, success: attempted.success, method: attempted.method ?? null, error: attempted.error ?? null, nativeEntered: attempted.nativeEntered === true, recordedAt: Date.now() } });
      const accepted = attempted.success ? await deps.triggerProcessing(sessionId, workspacePath) : false;
      return result('interrupt_attempted', await deps.getTargetState(sessionId, workspacePath), attempted.success, accepted);
    },
  };
}
