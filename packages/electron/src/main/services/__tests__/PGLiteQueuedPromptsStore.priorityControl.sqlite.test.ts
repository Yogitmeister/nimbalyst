// [ASTRA-ORCH]
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import { createPGLiteQueuedPromptsStore } from '../PGLiteQueuedPromptsStore';
import {
  createPriorityPromptDeliveryService,
  type PriorityControlPrompt,
} from '../PriorityPromptDeliveryService';

const ORPHANED_PRIORITY_INTERRUPT_ERROR =
  'Priority interrupt outcome is unknown after restart. Inspect the session, then reissue the control operation.';

describe('PGLiteQueuedPromptsStore priority control rows on SQLite', () => {
  let tmpDir: string;
  let database: SQLiteDatabase;
  function createDatabase() {
    return new SQLiteDatabase({
      dbDir: tmpDir, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1000, sampleRate: 0,
    });
  }
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-priority-queue-'));
    database = createDatabase();
    await database.initialize();
    await database.query(`INSERT INTO ai_sessions (id, workspace_id, provider, title) VALUES ($1, $2, $3, $4)`,
      ['session-1', 'D:\\repo', 'openai-codex', 'Target']);
  });
  afterEach(async () => { await database.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function input() {
    const requestDigest = createHash('sha256').update(JSON.stringify({
      sessionId: 'session-1', prompt: 'priority', producer: 'send_prompt_now:caller',
      controlOperation: 'operator_directive',
    })).digest('hex');
    return { id: 'control-1', sessionId: 'session-1', prompt: 'priority', producer: 'send_prompt_now:caller',
      idempotencyKey: 'priority:key-1', requestDigest, controlOperation: 'operator_directive' };
  }

  it('keeps ordinary FIFO while a released control row sorts first', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await store.create({ id: 'ordinary-1', sessionId: 'session-1', prompt: 'first' });
    await store.create({ id: 'ordinary-2', sessionId: 'session-1', prompt: 'second' });
    await store.createPriorityControlPrompt(input());
    expect((await store.listPending('session-1')).map((r) => r.id)).toEqual(['ordinary-1', 'ordinary-2']);
    await store.reservePriorityInterrupt({ promptId: 'control-1', generation: 'idle:10:20', owner: 'owner-1' });
    await store.recordPriorityInterruptReceipt({ promptId: 'control-1', generation: 'idle:10:20', receipt: {
      generation: 'idle:10:20', attempted: false, success: true, method: 'not-required', error: null,
      nativeEntered: false, recordedAt: 30,
    }});
    expect((await store.listPending('session-1')).map((r) => r.id)).toEqual(['control-1', 'ordinary-1', 'ordinary-2']);
    expect(await store.listPendingSessionIds({ deliveryClass: 'ordinary' })).toEqual(['session-1']);
  });

  it('replays a stable key and rejects conflicting reuse', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await expect(store.createPriorityControlPrompt(input())).resolves.toMatchObject({ replayed: false, row: { id: 'control-1', deliveryClass: 'control', priorityRank: 100 } });
    await expect(store.createPriorityControlPrompt({ ...input(), id: 'control-2' })).resolves.toMatchObject({ replayed: true, row: { id: 'control-1' } });
    await expect(store.createPriorityControlPrompt({ ...input(), id: 'control-3', requestDigest: 'different' })).rejects.toThrow(/idempotency_conflict/);
  });

  it('records one durable interrupt receipt and releases the control row', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await store.createPriorityControlPrompt(input());
    await expect(store.reservePriorityInterrupt({ promptId: 'control-1', generation: 'running:10:20', owner: 'owner-1' }))
      .resolves.toMatchObject({ reserved: true, row: { interruptTargetGeneration: 'running:10:20', interruptReservationOwner: 'owner-1' } });
    await expect(store.reservePriorityInterrupt({ promptId: 'control-1', generation: 'running:10:20', owner: 'owner-2' })).resolves.toMatchObject({ reserved: false });
    const receipt = { generation: 'running:10:20', attempted: true, success: true, method: 'interrupt', error: null, nativeEntered: true, recordedAt: 30 };
    await expect(store.recordPriorityInterruptReceipt({ promptId: 'control-1', generation: receipt.generation, receipt })).resolves.toMatchObject({ interruptReceipt: receipt });
    await expect(store.listPending('session-1')).resolves.toMatchObject([{ id: 'control-1', deliveryReady: true }]);
  });

  it('fails a receipt-less interrupt reservation once on restart without retrying native interrupt or dispatch', async () => {
    const initialStore = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await initialStore.create({ id: 'ordinary-1', sessionId: 'session-1', prompt: 'ordinary' });
    await initialStore.createPriorityControlPrompt(input());
    await initialStore.reservePriorityInterrupt({
      promptId: 'control-1', generation: 'running:10:20', owner: 'dead-process',
    });

    const receiptedInput = {
      ...input(), id: 'control-receipted', idempotencyKey: 'priority:key-receipted', requestDigest: 'digest-receipted',
    };
    await initialStore.createPriorityControlPrompt(receiptedInput);
    await initialStore.reservePriorityInterrupt({
      promptId: receiptedInput.id, generation: 'idle:10:20', owner: 'completed-process',
    });
    await initialStore.recordPriorityInterruptReceipt({
      promptId: receiptedInput.id, generation: 'idle:10:20', receipt: {
        generation: 'idle:10:20', attempted: false, success: true, method: 'not-required',
        error: null, nativeEntered: false, recordedAt: 30,
      },
    });

    await database.close();
    database = createDatabase();
    await database.initialize();
    const restartedStore = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));

    await expect(restartedStore.sweepExecutingOnBoot()).resolves.toEqual({
      completed: 0, failed: 1, rolledBack: 0,
    });
    await expect(restartedStore.get('control-1')).resolves.toMatchObject({
      status: 'failed', completedAt: expect.any(Number), deliveryReady: false,
      errorMessage: ORPHANED_PRIORITY_INTERRUPT_ERROR,
      interruptReservationOwner: 'dead-process', interruptReceipt: undefined,
    });
    await expect(restartedStore.get('ordinary-1')).resolves.toMatchObject({ status: 'pending' });
    await expect(restartedStore.get('control-receipted')).resolves.toMatchObject({
      status: 'pending', deliveryReady: true, interruptReceipt: { success: true },
    });
    await expect(restartedStore.sweepExecutingOnBoot()).resolves.toEqual({
      completed: 0, failed: 0, rolledBack: 0,
    });

    const getTargetState = vi.fn();
    const reserveInterrupt = vi.fn();
    const recordInterruptReceipt = vi.fn();
    const interruptCurrentTurn = vi.fn();
    const triggerProcessing = vi.fn();
    const service = createPriorityPromptDeliveryService({
      createControlPrompt: async (request) => {
        const replay = await restartedStore.createPriorityControlPrompt(request);
        return { row: replay.row as unknown as PriorityControlPrompt, replayed: replay.replayed };
      },
      getTargetState,
      hasStructuredPendingPrompt: vi.fn(),
      reserveInterrupt,
      recordInterruptReceipt,
      interruptCurrentTurn,
      triggerProcessing,
      getControlPrompt: vi.fn(),
      createControlPromptId: () => 'ignored-on-replay',
    });
    const repeat = () => service.deliver({
      sessionId: 'session-1', workspacePath: 'D:\\repo', prompt: 'priority',
      idempotencyKey: 'priority:key-1', producer: 'send_prompt_now:caller',
      controlOperation: 'operator_directive', interruptWaitingForInput: false,
    });

    await expect(repeat()).rejects.toThrow(ORPHANED_PRIORITY_INTERRUPT_ERROR);
    await expect(repeat()).rejects.toThrow(ORPHANED_PRIORITY_INTERRUPT_ERROR);
    expect(getTargetState).not.toHaveBeenCalled();
    expect(reserveInterrupt).not.toHaveBeenCalled();
    expect(recordInterruptReceipt).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(triggerProcessing).not.toHaveBeenCalled();
  });

  it('creates one durable row when same-ID mobile ingestion races', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    const input = {
      id: 'mobile-race-1',
      sessionId: 'session-1',
      prompt: 'same prompt',
      attachments: [{ id: 'attachment-1', filename: 'one.png' }],
    };

    const results = await Promise.all([
      store.createOrReplayMobilePrompt(input),
      store.createOrReplayMobilePrompt(input),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
    expect(results.map((result) => result.row.id)).toEqual(['mobile-race-1', 'mobile-race-1']);
    expect(await store.listForSession('session-1')).toHaveLength(1);
  });

  it('withdraws only an exact pending row, never a row already claimed for delivery', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await store.create({ id: 'mobile-withdraw-pending', sessionId: 'session-1', prompt: 'withdraw me' });

    await expect(store.withdrawPending('mobile-withdraw-pending', 'session-1')).resolves.toBe(true);
    await expect(store.claim('mobile-withdraw-pending')).resolves.toBeNull();

    await store.create({ id: 'mobile-withdraw-claimed', sessionId: 'session-1', prompt: 'already running' });
    await expect(store.claim('mobile-withdraw-claimed')).resolves.toMatchObject({ id: 'mobile-withdraw-claimed' });
    await expect(store.withdrawPending('mobile-withdraw-claimed', 'session-1')).resolves.toBe(false);
    await expect(store.get('mobile-withdraw-claimed')).resolves.toMatchObject({ status: 'executing' });
  });

  it('accepts an identical replay but rejects same-ID session, prompt, or attachment mismatches', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    const input = {
      id: 'mobile-replay-1',
      sessionId: 'session-1',
      prompt: 'same prompt',
      attachments: [{ id: 'attachment-1', filename: 'one.png' }],
    };

    await expect(store.createOrReplayMobilePrompt(input)).resolves.toMatchObject({ created: true });
    await expect(store.createOrReplayMobilePrompt(input)).resolves.toMatchObject({
      created: false,
      row: { id: input.id, sessionId: input.sessionId, prompt: input.prompt },
    });
    await expect(store.createOrReplayMobilePrompt({ ...input, sessionId: 'session-2' }))
      .rejects.toThrow(/idempotency_conflict/);
    await expect(store.createOrReplayMobilePrompt({ ...input, prompt: 'different prompt' }))
      .rejects.toThrow(/idempotency_conflict/);
    await expect(store.createOrReplayMobilePrompt({ ...input, attachments: [] }))
      .rejects.toThrow(/idempotency_conflict/);
  });
});
