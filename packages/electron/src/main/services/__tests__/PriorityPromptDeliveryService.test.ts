// [ASTRA-ORCH]
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPriorityPromptDeliveryService,
  type PriorityControlPrompt,
  type PriorityTargetState,
} from '../PriorityPromptDeliveryService';

const sessionId = 'target-session';
const workspacePath = 'D:\\repo';

function row(overrides: Partial<PriorityControlPrompt> = {}): PriorityControlPrompt {
  return {
    id: 'control-1', sessionId, status: 'pending', deliveryClass: 'control', priorityRank: 100,
    deliveryReady: false, interruptTargetGeneration: null, interruptReservationOwner: null,
    interruptReceipt: null, ...overrides,
  };
}

function state(status: PriorityTargetState['status'], generation = `${status}:10:20`): PriorityTargetState {
  return { status, generation, lastActivity: 10, updatedAt: 20 };
}

describe('PriorityPromptDeliveryService', () => {
  const createControlPrompt = vi.fn();
  const getTargetState = vi.fn();
  const hasStructuredPendingPrompt = vi.fn();
  const reserveInterrupt = vi.fn();
  const recordInterruptReceipt = vi.fn();
  const interruptCurrentTurn = vi.fn();
  const triggerProcessing = vi.fn();
  const getControlPrompt = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    createControlPrompt.mockResolvedValue({ row: row(), replayed: false });
    getTargetState.mockResolvedValue(state('idle'));
    hasStructuredPendingPrompt.mockResolvedValue(false);
    reserveInterrupt.mockImplementation(async ({ generation, owner }) => ({
      row: row({ interruptTargetGeneration: generation, interruptReservationOwner: owner }), reserved: true,
    }));
    recordInterruptReceipt.mockImplementation(async ({ receipt }) => row({
      status: 'executing', interruptTargetGeneration: receipt.generation,
      interruptReservationOwner: 'owner', interruptReceipt: receipt,
    }));
    interruptCurrentTurn.mockResolvedValue({ success: true, method: 'interrupt', nativeEntered: true });
    triggerProcessing.mockResolvedValue(true);
    getControlPrompt.mockResolvedValue(row());
  });

  function service() {
    return createPriorityPromptDeliveryService({
      createControlPrompt, getTargetState, hasStructuredPendingPrompt, reserveInterrupt,
      recordInterruptReceipt, interruptCurrentTurn, triggerProcessing, getControlPrompt,
      createReservationOwner: () => 'owner', createControlPromptId: () => 'control-1',
    });
  }

  function deliver(overrides = {}) {
    return service().deliver({
      sessionId, workspacePath, prompt: 'Act now', idempotencyKey: 'operation-1',
      producer: 'send_prompt_now:caller', controlOperation: 'operator_directive',
      interruptWaitingForInput: false, ...overrides,
    });
  }

  it('records an idle receipt before triggering priority delivery', async () => {
    const result = await deliver();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(recordInterruptReceipt).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({ attempted: false, success: true, method: 'not-required' }),
    }));
    expect(recordInterruptReceipt.mock.invocationCallOrder[0]).toBeLessThan(triggerProcessing.mock.invocationCallOrder[0]);
    expect(result.action).toBe('processing_triggered');
  });

  it('fences and interrupts a running target before delivery', async () => {
    getTargetState.mockResolvedValue(state('running'));
    const result = await deliver();
    expect(reserveInterrupt).toHaveBeenCalledWith(expect.objectContaining({ generation: 'running:10:20' }));
    expect(interruptCurrentTurn).toHaveBeenCalledWith(sessionId, expect.objectContaining({ generation: 'running:10:20' }));
    expect(triggerProcessing).toHaveBeenCalledWith(sessionId, workspacePath);
    expect(result.action).toBe('interrupt_attempted');
  });

  it('keeps structured waiting prompts protected', async () => {
    getTargetState.mockResolvedValue(state('waiting_for_input'));
    hasStructuredPendingPrompt.mockResolvedValue(true);
    const result = await deliver({ interruptWaitingForInput: true });
    expect(reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(result.action).toBe('structured_prompt_requires_response');
  });

  it('fails closed on lifecycle generation drift', async () => {
    getTargetState
      .mockResolvedValueOnce(state('running', 'running:10:20'))
      .mockResolvedValueOnce(state('idle', 'idle:30:40'))
      .mockResolvedValue(state('idle', 'idle:30:40'));
    const result = await deliver();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(result.action).toBe('stale_generation_rejected');
  });

  it('replays an interrupt receipt without interrupting twice', async () => {
    createControlPrompt.mockResolvedValue({ row: row({
      status: 'executing', interruptTargetGeneration: 'running:10:20', interruptReceipt: {
        generation: 'running:10:20', attempted: true, success: true, method: 'interrupt',
        error: null, nativeEntered: true, recordedAt: 20,
      },
    }), replayed: true });
    const result = await deliver();
    expect(reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(result.action).toBe('interrupt_receipt_replayed');
  });

  it('re-drives a pending row with a successful receipt without interrupting twice', async () => {
    createControlPrompt.mockResolvedValue({ row: row({
      status: 'pending', deliveryReady: true, interruptTargetGeneration: 'running:10:20',
      interruptReservationOwner: 'owner', interruptReceipt: {
        generation: 'running:10:20', attempted: true, success: true, method: 'interrupt',
        error: null, nativeEntered: true, recordedAt: 20,
      },
    }), replayed: true });

    const result = await deliver();

    expect(reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(triggerProcessing).toHaveBeenCalledWith(sessionId, workspacePath);
    expect(result.action).toBe('interrupt_receipt_replayed');
    expect(result.processingTriggerAccepted).toBe(true);
  });

  it('surfaces a boot-failed receipt-less reservation before lifecycle reads or side effects', async () => {
    const recoveryError = 'Priority interrupt outcome is unknown after restart. Inspect the session, then reissue the control operation.';
    createControlPrompt.mockResolvedValue({ row: row({
      status: 'failed', interruptTargetGeneration: 'running:10:20',
      interruptReservationOwner: 'dead-process', errorMessage: recoveryError,
    }), replayed: true });

    await expect(deliver()).rejects.toThrow(recoveryError);
    expect(getTargetState).not.toHaveBeenCalled();
    expect(reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(triggerProcessing).not.toHaveBeenCalled();
  });
});
