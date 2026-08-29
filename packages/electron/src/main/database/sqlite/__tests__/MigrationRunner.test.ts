// @vitest-environment node
/**
 * Tests for the SQLite migration runner using a fake database handle.
 * Doesn't require better-sqlite3 to be installed; only exercises the runner's
 * orchestration logic (ordering, idempotency, the _migrations ledger).
 *
 * The end-of-file block also runs the real bundled migrations against an
 * `:memory:` better-sqlite3 database to verify the on-disk SQL is valid and
 * produces the expected end-state schema (columns, indexes, triggers).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'node:worker_threads';
import { getMigrations, runMigrations, type Migration } from '../MigrationRunner';
import { SQLiteDatabase } from '../SQLiteDatabase';

/**
 * Stage a no-op .sql for every migration the runner expects, and return their
 * versions in order. Derived from `getMigrations` so adding a migration does
 * not mean hand-editing a parallel list here -- that list went stale on every
 * new schema file.
 */
function stageMigrationFiles(dir: string, overrides: Record<string, string> = {}): number[] {
  const versions: number[] = [];
  for (const migration of getMigrations(dir)) {
    const sqlFile = (migration as { sqlFile?: string }).sqlFile;
    if (sqlFile) {
      const name = path.basename(sqlFile);
      fs.writeFileSync(sqlFile, overrides[name] ?? '-- noop\n');
    }
    versions.push(migration.version);
  }
  return versions.sort((a, b) => a - b);
}

/** Bare-minimum mock that supports the bits MigrationRunner touches. */
class FakeDb {
  // Map from version -> migration row.
  private migrations: Array<{ version: number; name: string }> = [];
  public execs: string[] = [];

  exec(sql: string) {
    this.execs.push(sql);
    if (/CREATE TABLE IF NOT EXISTS _migrations/i.test(sql)) {
      // ok
    }
  }

  prepare(sql: string) {
    if (/SELECT version, name FROM _migrations WHERE version/i.test(sql)) {
      return {
        get: (version: number) => this.migrations.find((m) => m.version === version),
      };
    }
    if (/SELECT version, name FROM _migrations/i.test(sql)) {
      return {
        all: () => this.migrations.map((m) => ({ version: m.version, name: m.name })),
      };
    }
    if (/SELECT version FROM _migrations/i.test(sql)) {
      return {
        all: () => this.migrations.map((m) => ({ version: m.version })),
        get: (version: number) => this.migrations.find((m) => m.version === version),
      };
    }
    // Fork-lane ledger relocation reads a row's name by version.
    if (/SELECT name FROM _migrations WHERE version/i.test(sql)) {
      return {
        get: (version: number) => this.migrations.find((m) => m.version === version),
      };
    }
    if (/UPDATE _migrations SET version/i.test(sql)) {
      return {
        run: (to: number, from: number, name: string) => {
          const row = this.migrations.find((m) => m.version === from && m.name === name);
          if (row) row.version = to;
        },
      };
    }
    if (/INSERT INTO _migrations/i.test(sql)) {
      return {
        run: (version: number, name: string) => {
          this.migrations.push({ version, name });
        },
      };
    }
    throw new Error(`unexpected prepare: ${sql}`);
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T & { immediate: T } {
    const wrapped = ((...args: any[]) => fn(...args)) as T & { immediate: T };
    wrapped.immediate = wrapped;
    return wrapped;
  }
}

describe('runMigrations', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-migrations-'));
  });

  it('applies migrations in version order and records them', () => {
    // Stage every migration the runner knows about; versions come back in order.
    const expectedVersions = stageMigrationFiles(tmp);

    const db = new FakeDb();
    // Hack: inject our own migration list via reflection-equivalent. Re-using
    // the real getMigrations() requires reading 0001_initial.sql; we want to
    // exercise the ordering logic with custom entries.
    const customs: Migration[] = [
      { version: 2, name: 'second', sql: 'SELECT 2' },
      { version: 1, name: 'first', sql: 'SELECT 1' },
    ];
    // The simplest way to test ordering is to call the runner directly with
    // a stand-in implementation; for now, test the file-backed path with the
    // bundled migrations.
    const result = runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(result.applied).toEqual(expectedVersions);
    expect(result.skipped).toEqual([]);

    // Second invocation: nothing to apply, all skipped.
    const result2 = runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(result2.applied).toEqual([]);
    expect(result2.skipped).toEqual(expectedVersions);

    // Anti-flake: unused locals lint silencer.
    void customs;
  });

  it('reads the migration SQL from disk and execs it', () => {
    // Real SQL for the two under test; no-ops for the rest.
    stageMigrationFiles(tmp, {
      '0001_initial.sql': 'CREATE TABLE foo (id INTEGER PRIMARY KEY);',
      '0002_pending_files_index.sql': 'CREATE INDEX bar ON foo(id);',
    });

    const db = new FakeDb();
    runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(db.execs.some((s) => s.includes('CREATE TABLE foo'))).toBe(true);
    expect(db.execs.some((s) => s.includes('CREATE INDEX bar'))).toBe(true);
  });

  it('is idempotent when two SQLite connections initialize the same database concurrently', async () => {
    for (const migration of getMigrations(tmp)) {
      if (migration.sqlFile) {
        fs.writeFileSync(migration.sqlFile, '-- noop\n');
      }
    }

    const dbPath = path.join(tmp, 'concurrent.sqlite');
    const runnerPath = path.resolve(__dirname, '..', 'MigrationRunner.ts');
    const betterSqlitePath = require.resolve('better-sqlite3');
    const snapshotBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);

    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const BetterSqlite = require(workerData.betterSqlitePath);
      const { runMigrations } = require(workerData.runnerPath);
      const raw = new BetterSqlite(workerData.dbPath, { timeout: 10_000 });
      const barrier = new Int32Array(workerData.snapshotBarrier);
      const db = {
        exec: raw.exec.bind(raw),
        transaction: raw.transaction.bind(raw),
        prepare(sql) {
          const statement = raw.prepare(sql);
          if (!/SELECT version FROM _migrations ORDER BY version ASC/i.test(sql)) {
            return statement;
          }
          return {
            all() {
              const rows = statement.all();
              const arrivals = Atomics.add(barrier, 0, 1) + 1;
              if (arrivals < 2) {
                Atomics.wait(barrier, 0, arrivals, 10_000);
              } else {
                Atomics.notify(barrier, 0);
              }
              return rows;
            },
          };
        },
      };
      try {
        const result = runMigrations(db, workerData.schemaDir);
        parentPort.postMessage({ ok: true, result });
      } catch (error) {
        parentPort.postMessage({
          ok: false,
          error: {
            name: error?.name,
            message: error?.message,
            code: error?.code,
          },
        });
      } finally {
        raw.close();
      }
    `;

    const runWorker = () => new Promise<{
      ok: boolean;
      error?: { name?: string; message?: string; code?: string };
    }>((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          betterSqlitePath,
          runnerPath,
          dbPath,
          schemaDir: tmp,
          snapshotBarrier,
        },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });

    const outcomes = await Promise.all([runWorker(), runWorker()]);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
  });
});

describe('runMigrations against the real schema dir', () => {
  it('applies 0003 and adds searchable_text + message_kind to ai_agent_messages', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-mig-real-'));
    const schemaDir = path.resolve(__dirname, '..', 'schemas');
    const sqlite = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    try {
      await sqlite.initialize();
      const handle = sqlite.getRawHandle()!;

      const versions = handle
        .prepare(`SELECT version FROM _migrations ORDER BY version ASC`)
        .all() as Array<{ version: number }>;
      expect(versions.map((v) => v.version)).toContain(3);

      const cols = handle
        .prepare(`PRAGMA table_info(ai_agent_messages)`)
        .all() as Array<{ name: string; type: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('searchable_text');
      expect(colNames).toContain('message_kind');

      const sText = cols.find((c) => c.name === 'searchable_text');
      const mKind = cols.find((c) => c.name === 'message_kind');
      expect(sText?.type).toBe('TEXT');
      expect(mKind?.type).toBe('TEXT');

      const replicaCols = handle
        .prepare(`PRAGMA table_info(collab_document_replicas)`)
        .all() as Array<{ name: string }>;
      expect(replicaCols.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'staged_encrypted_snapshot',
          'staged_snapshot_generation',
          'staged_snapshot_checksum',
          'staged_encoding_version',
          'staged_snapshot_token',
          'snapshot_commit_token',
          'quarantine_reason',
          'quarantined_at',
        ]),
      );
    } finally {
      await sqlite.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * Fork-lineage ledger collision.
 *
 * This fork mints migrations on top of upstream's. Before the v0.74.3 fold the
 * carry `queued_prompt_priority_control` was version 32; upstream then minted
 * its own 32. Because the runner keys on version alone, an existing database
 * hit BOTH failure modes: the carry re-ran (hard `duplicate column name` at
 * startup) and upstream's 32 silently never ran while the ledger claimed it had.
 *
 * These tests exist because every gate we had ran against a FRESH database,
 * where the collision is invisible — upstream folded the same tables into
 * `0001_initial.sql`, so its migration 32 is a no-op there. The failure only
 * appears on a database that predates the fold.
 */
describe('fork-lane migration numbering', () => {
  it('keeps upstream versions contiguous and fork versions in the reserved lane', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migforklane-'));
    try {
      const versions = getMigrations(tmpDir).map((m) => m.version);
      const upstream = versions.filter((v) => v < 1000);
      const fork = versions.filter((v) => v >= 1000);

      // Upstream's range must stay contiguous from 1. A fork migration minted
      // inside it is exactly the mistake that shipped a broken build: it looks
      // fine on a fresh database and corrupts the ledger on an existing one.
      expect(upstream).toEqual(
        Array.from({ length: upstream.length }, (_, i) => i + 1),
      );
      expect(fork.length).toBeGreaterThan(0);
      expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upgrades a pre-fold database without re-running the carry or skipping upstream 32', async () => {
    const Database = (await import('better-sqlite3')).default;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migprefold-'));
    const dbPath = path.join(tmpDir, 'prefold.sqlite');
    const schemaDir = path.join(__dirname, '..', 'schemas');
    const db = new Database(dbPath);
    try {
      // Build a current database, then rewind its ledger to the pre-fold shape:
      // the carry recorded as 32, and none of upstream's 32-34 present. The
      // carry's COLUMNS stay in place — that is what makes the re-run fatal.
      runMigrations(db, schemaDir);
      // Undo everything upstream 32-34 created, so the fixture is a faithful
      // pre-fold database rather than a current one with a doctored ledger.
      db.exec('DROP TABLE IF EXISTS feedback_request_cache');
      db.exec('DROP TABLE IF EXISTS feedback_request_index');
      db.exec('DROP TABLE IF EXISTS feedback_request_index_backfill');
      db.exec('DROP INDEX IF EXISTS idx_tracker_workspace_local_key');
      db.exec('ALTER TABLE tracker_items DROP COLUMN local_key');
      db.exec('DELETE FROM _migrations WHERE version IN (32, 33, 34, 1001)');
      db.prepare("INSERT INTO _migrations (version, name) VALUES (32, 'queued_prompt_priority_control')").run();

      const before = db.prepare('PRAGMA table_info(queued_prompts)').all() as Array<{ name: string }>;
      expect(before.map((c) => c.name)).toContain('delivery_class');

      // Without the relocation this throws `duplicate column name: delivery_class`.
      const result = runMigrations(db, schemaDir);

      // Upstream's 32 is applied inside the SAME transaction as the relocation,
      // so no concurrently-starting older build can ever observe version 32
      // absent and re-run its own carry migration into a duplicate-column crash.
      expect(result.relocated).toEqual([
        {
          from: 32,
          to: 1001,
          name: 'queued_prompt_priority_control',
          backfilled: { version: 32, name: 'feedback_request_cache' },
        },
      ]);
      // The silent half of the defect: upstream 32 must really have run.
      expect(result.applied).not.toContain(32);
      const ledger = db.prepare('SELECT version, name FROM _migrations WHERE version IN (32, 1001)').all() as Array<{ version: number; name: string }>;
      expect(ledger).toEqual(
        expect.arrayContaining([
          { version: 32, name: 'feedback_request_cache' },
          { version: 1001, name: 'queued_prompt_priority_control' },
        ]),
      );
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_request_cache'")
        .all();
      expect(tables).toHaveLength(1);

      // The carry's columns must be untouched, not duplicated.
      const after = db.prepare('PRAGMA table_info(queued_prompts)').all() as Array<{ name: string }>;
      expect(after.map((c) => c.name)).toEqual(before.map((c) => c.name));

      // Idempotent: a second run relocates nothing and applies nothing.
      const second = runMigrations(db, schemaDir);
      expect(second.relocated).toEqual([]);
      expect(second.applied).toEqual([]);
      expect(second.nameMismatches).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upgrades a database left by the first broken fold build, which recorded the carry as 35', async () => {
    const Database = (await import('better-sqlite3')).default;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migcarry35-'));
    const dbPath = path.join(tmpDir, 'carry35.sqlite');
    const schemaDir = path.join(__dirname, '..', 'schemas');
    const db = new Database(dbPath);
    try {
      // The state any database reaches when the first v0.74.3 fold build — which
      // numbered the carry 35 — migrated successfully. Upstream 32-34 are intact;
      // only the carry sits at the wrong number.
      runMigrations(db, schemaDir);
      db.exec('DELETE FROM _migrations WHERE version = 1001');
      db.prepare("INSERT INTO _migrations (version, name) VALUES (35, 'queued_prompt_priority_control')").run();

      const before = db.prepare('PRAGMA table_info(queued_prompts)').all() as Array<{ name: string }>;

      // Without the 35 alias this reruns the carry and dies on ADD COLUMN.
      const result = runMigrations(db, schemaDir);

      expect(result.relocated).toEqual([
        { from: 35, to: 1001, name: 'queued_prompt_priority_control' },
      ]);
      expect(result.applied).toEqual([]);
      const after = db.prepare('PRAGMA table_info(queued_prompts)').all() as Array<{ name: string }>;
      expect(after.map((c) => c.name)).toEqual(before.map((c) => c.name));
      expect(db.prepare('SELECT name FROM _migrations WHERE version = 35').get()).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves the ledger alone when the row is not backed by real schema', async () => {
    const Database = (await import('better-sqlite3')).default;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mignoschema-'));
    const dbPath = path.join(tmpDir, 'noschema.sqlite');
    const schemaDir = path.join(__dirname, '..', 'schemas');
    const db = new Database(dbPath);
    try {
      runMigrations(db, schemaDir);
      // A ledger row claiming the carry ran, on a database whose queued_prompts
      // never got the columns — reachable through adoption or hand repair.
      // Canonicalizing on the name alone would record it applied forever and
      // leave the schema missing: the silent defect, recreated.
      db.exec('DELETE FROM _migrations WHERE version = 1001');
      db.exec('DROP INDEX IF EXISTS idx_queued_prompts_control_idempotency');
      db.exec('DROP INDEX IF EXISTS idx_queued_prompts_priority_pending');
      for (const col of [
        'delivery_class', 'priority_rank', 'delivery_ready', 'producer',
        'idempotency_key', 'request_digest', 'control_operation',
        'interrupt_target_generation', 'interrupt_reservation_owner', 'interrupt_receipt',
      ]) {
        db.exec(`ALTER TABLE queued_prompts DROP COLUMN ${col}`);
      }
      db.prepare("INSERT INTO _migrations (version, name) VALUES (35, 'queued_prompt_priority_control')").run();

      // The row is not trusted, so the canonical migration runs for real instead
      // of being recorded as already-applied.
      const result = runMigrations(db, schemaDir);
      expect(result.relocated).toEqual([]);
      expect(result.applied).toContain(1001);
      const cols = (db.prepare('PRAGMA table_info(queued_prompts)').all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(cols).toContain('delivery_class');
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails loudly rather than recording success when the carry schema is only partly present', async () => {
    const Database = (await import('better-sqlite3')).default;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migpartial-'));
    const dbPath = path.join(tmpDir, 'partial.sqlite');
    const schemaDir = path.join(__dirname, '..', 'schemas');
    const db = new Database(dbPath);
    try {
      runMigrations(db, schemaDir);
      db.exec('DELETE FROM _migrations WHERE version = 1001');
      db.exec('ALTER TABLE queued_prompts DROP COLUMN delivery_class');
      db.prepare("INSERT INTO _migrations (version, name) VALUES (35, 'queued_prompt_priority_control')").run();

      // A half-applied carry cannot be repaired by rerunning unguarded ADD COLUMN
      // statements. The important property is that it does not get canonicalized
      // into "applied" — a loud failure is recoverable by reinstalling the older
      // build, a ledger that lies about the schema is not.
      expect(() => runMigrations(db, schemaDir)).toThrow(/duplicate column name/);
      expect(db.prepare('SELECT name FROM _migrations WHERE version = 1001').get()).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses to migrate when a ledger name disagrees with this build', async () => {
    const Database = (await import('better-sqlite3')).default;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migmismatch-'));
    const dbPath = path.join(tmpDir, 'mismatch.sqlite');
    const schemaDir = path.join(__dirname, '..', 'schemas');
    const db = new Database(dbPath);
    try {
      runMigrations(db, schemaDir);
      // A version recorded under a name this build does not use for it: the
      // version-keyed skip is about to lie about migration 30 having run.
      db.prepare("UPDATE _migrations SET name = 'something_else' WHERE version = 30").run();

      // Fail closed. A loud refusal is recoverable by reinstalling the previous
      // build; a silent wrong schema is not, and that is what shipped.
      expect(() => runMigrations(db, schemaDir)).toThrow(/does not match this build/);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('still opens a database written by a newer build (downgrade stays possible)', async () => {
    const Database = (await import('better-sqlite3')).default;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mignewer-'));
    const dbPath = path.join(tmpDir, 'newer.sqlite');
    const schemaDir = path.join(__dirname, '..', 'schemas');
    const db = new Database(dbPath);
    try {
      runMigrations(db, schemaDir);
      // Rows this build has never heard of must be ignored, not rejected —
      // rolling back to an older build is the recovery path when a release
      // misbehaves, so an older build has to tolerate a newer ledger.
      db.prepare("INSERT INTO _migrations (version, name) VALUES (9999, 'from_the_future')").run();
      const result = runMigrations(db, schemaDir);
      expect(result.nameMismatches).toEqual([]);
      expect(result.applied).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
