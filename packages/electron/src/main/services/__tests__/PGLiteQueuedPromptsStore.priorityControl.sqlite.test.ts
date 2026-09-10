// [ASTRA-ORCH]
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import { createPGLiteQueuedPromptsStore } from '../PGLiteQueuedPromptsStore';

describe('PGLiteQueuedPromptsStore priority control rows on SQLite', () => {
  let tmpDir: string;
  let database: SQLiteDatabase;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-priority-queue-'));
    database = new SQLiteDatabase({
      dbDir: tmpDir, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1000, sampleRate: 0,
    });
    await database.initialize();
    await database.query(`INSERT INTO ai_sessions (id, workspace_id, provider, title) VALUES ($1, $2, $3, $4)`,
      ['session-1', 'D:\\repo', 'openai-codex', 'Target']);
  });
  afterEach(async () => { await database.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function input() {
    return { id: 'control-1', sessionId: 'session-1', prompt: 'priority', producer: 'send_prompt_now:caller',
      idempotencyKey: 'priority:key-1', requestDigest: 'digest-1', controlOperation: 'operator_directive' };
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
