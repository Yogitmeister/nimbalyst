// [ASTRA-ORCH]
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPGLiteQueuedPromptsStore } from '../PGLiteQueuedPromptsStore';

/**
 * Regression test for a v15-fold-introduced defect: `delivery_ready` is declared
 * `INTEGER ... CHECK (delivery_ready IN (0, 1))` (see packages/electron/src/main/database/worker.js,
 * the real PGLite table definition), but three read queries compared it against the boolean literal
 * `TRUE`, and one INSERT/one UPDATE bound a JS boolean directly. SQLite silently coerces boolean and
 * integer, so a SQLite-backed test (see PGLiteQueuedPromptsStore.priorityControl.sqlite.test.ts) never
 * caught this. Postgres/PGLite does not -- `operator does not exist: integer = boolean` (sqlState
 * 42883) at runtime. This test runs against a real in-memory `PGlite` instance -- the same wire
 * protocol type-strictness as production -- so this class of defect cannot return silently again.
 */
describe('PGLiteQueuedPromptsStore delivery_ready typing (real PGLite backend)', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE ai_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        provider TEXT,
        title TEXT
      );

      CREATE TABLE ai_agent_messages (session_id TEXT, direction TEXT, created_at TIMESTAMPTZ, content TEXT);

      CREATE TABLE queued_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
        attachments JSONB,
        document_context JSONB,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_message TEXT,
        delivery_class TEXT NOT NULL DEFAULT 'ordinary' CHECK (delivery_class IN ('ordinary', 'control')),
        priority_rank INTEGER NOT NULL DEFAULT 0,
        delivery_ready INTEGER NOT NULL DEFAULT 1 CHECK (delivery_ready IN (0, 1)),
        producer TEXT,
        idempotency_key TEXT,
        request_digest TEXT,
        control_operation TEXT,
        interrupt_target_generation TEXT,
        interrupt_reservation_owner TEXT,
        interrupt_receipt TEXT
      );

      CREATE UNIQUE INDEX idx_queued_prompts_control_idempotency
        ON queued_prompts(session_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    await db.query(`INSERT INTO ai_sessions (id, workspace_id, provider, title) VALUES ($1, $2, $3, $4)`,
      ['session-1', 'D:\\repo', 'openai-codex', 'Target']);
  });

  afterEach(async () => {
    await db.close();
  });

  it('lists a freshly created ordinary prompt as pending (listPending)', async () => {
    const store = createPGLiteQueuedPromptsStore(db as any);
    await store.create({ id: 'ordinary-1', sessionId: 'session-1', prompt: 'first' });

    const pending = await store.listPending('session-1');
    expect(pending.map((r) => r.id)).toEqual(['ordinary-1']);
  });

  it('creates a priority control prompt (INSERT literal) without a type error', async () => {
    const store = createPGLiteQueuedPromptsStore(db as any);
    const { row, replayed } = await store.createPriorityControlPrompt({
      id: 'control-1',
      sessionId: 'session-1',
      prompt: 'priority',
      producer: 'send_prompt_now:caller',
      idempotencyKey: 'priority:key-1',
      requestDigest: 'digest-1',
      controlOperation: 'operator_directive',
    });

    expect(replayed).toBe(false);
    expect(row).toMatchObject({ id: 'control-1', deliveryClass: 'control', deliveryReady: false });
  });

  it('claims a pending prompt (WHERE literal) and releases a control row via the interrupt receipt (UPDATE binding)', async () => {
    const store = createPGLiteQueuedPromptsStore(db as any);
    await store.create({ id: 'ordinary-1', sessionId: 'session-1', prompt: 'first' });
    await expect(store.claim('ordinary-1')).resolves.toMatchObject({ id: 'ordinary-1', status: 'executing' });

    await store.createPriorityControlPrompt({
      id: 'control-1',
      sessionId: 'session-1',
      prompt: 'priority',
      producer: 'send_prompt_now:caller',
      idempotencyKey: 'priority:key-1',
      requestDigest: 'digest-1',
      controlOperation: 'operator_directive',
    });
    await store.reservePriorityInterrupt({ promptId: 'control-1', generation: 'idle:10:20', owner: 'owner-1' });
    const released = await store.recordPriorityInterruptReceipt({
      promptId: 'control-1',
      generation: 'idle:10:20',
      receipt: {
        generation: 'idle:10:20', attempted: false, success: true, method: 'not-required', error: null,
        nativeEntered: false, recordedAt: 30,
      },
    });

    expect(released.deliveryReady).toBe(true);
    await expect(store.listPending('session-1')).resolves.toMatchObject([{ id: 'control-1' }]);
  });

  // Was SKIPPED (uncovered a second, distinct defect: sqlState 42P08, untyped $1 in
  // `$1 IS NULL OR delivery_class = $1` -- Postgres cannot infer the parameter type there while
  // SQLite silently could). Fixed via an explicit `$1::text` cast, authorized in
  // D:\CLAUDE\_pending\v15\RULING-nim207-sqlite-isms.md. See
  // D:\CLAUDE\_pending\v15\FLAG-listPendingSessionIds-param-type-inference.md for the original finding.
  it('lists session ids with pending ordinary prompts (second WHERE literal)', async () => {
    const store = createPGLiteQueuedPromptsStore(db as any);
    await store.create({ id: 'ordinary-1', sessionId: 'session-1', prompt: 'first' });

    await expect(store.listPendingSessionIds({ deliveryClass: 'ordinary' })).resolves.toEqual(['session-1']);
  });
  it('terminalizes an orphan reservation with integer delivery readiness on real PGLite', async () => {
    const store = createPGLiteQueuedPromptsStore(db as any);
    await store.createPriorityControlPrompt({
      id: 'orphan', sessionId: 'session-1', prompt: 'priority', producer: 'caller',
      idempotencyKey: 'orphan-key', requestDigest: 'digest', controlOperation: 'operator_directive',
    });
    await store.reservePriorityInterrupt({ promptId: 'orphan', generation: 'running:1:2', owner: 'old-process' });
    await expect(store.sweepExecutingOnBoot()).resolves.toEqual({ completed: 0, failed: 1, rolledBack: 0 });
    await expect(store.get('orphan')).resolves.toMatchObject({
      status: 'failed', deliveryReady: false, interruptReceipt: undefined,
      errorMessage: expect.stringContaining('outcome is unknown after restart'),
    });
    await expect(store.sweepExecutingOnBoot()).resolves.toEqual({ completed: 0, failed: 0, rolledBack: 0 });
  });

});
