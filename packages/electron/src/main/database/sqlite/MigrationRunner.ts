// [ASTRA-ORCH]
/**
 * SQLite Migration Runner
 *
 * Replaces the inline PL/pgSQL `DO $$ ... END $$` migration blocks scattered
 * through `worker.js` with a single explicit ledger:
 *
 *   _migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)
 *
 * Each migration is a static SQL string or a function that takes the open
 * database and runs imperative work. Migrations run in version order, inside
 * a transaction; on throw, the transaction rolls back and the run aborts.
 *
 * Source-of-truth: `schemas/0001_initial.sql` (the consolidated end state).
 * Follow-up migrations should be added here in version order.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Database as SqliteDatabase } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  /** SQL string, file path, or a callback. Exactly one of these is set. */
  sql?: string;
  sqlFile?: string;
  run?: (db: SqliteDatabase) => void;
}

export interface MigrationResult {
  applied: number[];
  skipped: number[];
  /** Ledger rows canonicalized into the fork lane by `repairForkLedger`. */
  relocated: ForkLaneRepair[];
  /** Ledger rows whose recorded name disagrees with this build's name for that version. */
  nameMismatches: Array<{ version: number; recorded: string; expected: string }>;
}

/**
 * Fork-lineage ledger relocations.
 *
 * This fork mints migrations on top of upstream's. When a later upstream release
 * claims a version number the fork already used, an existing database's
 * version->name binding disagrees with this build's, and because the runner keys
 * on version alone BOTH migrations then misbehave: the fork's re-runs (its new
 * version looks unapplied) and upstream's silently never runs (its version looks
 * applied). The second failure is invisible ג€” the ledger claims forever that a
 * migration ran when it did not.
 *
 * Each entry moves a fork-authored ledger row into the reserved fork lane. Keyed
 * on (version, name) so it cannot misfire on a database where that version
 * legitimately belongs to upstream, and idempotent: once relocated the name test
 * no longer matches.
 *
 * Fork-authored migrations live at version >= FORK_LANE_BASE so upstream's
 * contiguous range can never collide with them again.
 */
const FORK_LANE_BASE = 1000;

interface ForkLaneRule {
  /** Canonical fork-lane version this build uses. */
  canonical: number;
  name: string;
  /** Versions an earlier build of this fork may have recorded the migration under. */
  legacyVersions: number[];
  /**
   * Cheap physical-schema probe. The ledger row is a claim, not proof: an adopted
   * or hand-repaired database can carry the row without the schema. Relocating on
   * the name alone would record the migration as applied forever and leave the
   * schema missing ג€” the same silent class of defect this whole repair exists to
   * undo. Returns false when the claim is not backed by real schema.
   */
  schemaPresent: (db: SqliteDatabase) => boolean;
  /**
   * The upstream migration that now owns a vacated legacy version, if any. It is
   * applied inside the SAME transaction as the relocation so no other process can
   * ever observe that version absent ג€” an older build that snapshotted the ledger
   * mid-repair would otherwise re-run its own migration and die.
   */
  upstreamSuccessor?: { version: number; name: string; file: string };
}

function hasColumns(db: SqliteDatabase, table: string, required: string[]): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  return required.every((c) => present.has(c));
}

const FORK_LANE_RULES: ReadonlyArray<ForkLaneRule> = [
  {
    canonical: 1001,
    name: 'queued_prompt_priority_control',
    // 32: databases built before the v0.74.3 fold, when this carry was numbered 32.
    // 35: databases built by the first (broken) v0.74.3 fold build, which renumbered
    //     the carry to 35 ג€” inside upstream's range, where it will collide again.
    legacyVersions: [32, 35],
    schemaPresent: (db) =>
      hasColumns(db, 'queued_prompts', [
        'delivery_class',
        'priority_rank',
        'delivery_ready',
        'producer',
        'idempotency_key',
        'request_digest',
        'control_operation',
        'interrupt_target_generation',
        'interrupt_reservation_owner',
        'interrupt_receipt',
      ]),
    upstreamSuccessor: {
      version: 32,
      name: 'feedback_request_cache',
      file: '0032_feedback_request_cache.sql',
    },
  },
];

export interface ForkLaneRepair {
  from: number;
  to: number;
  name: string;
  /** Upstream migration applied into the vacated version, in the same transaction. */
  backfilled?: { version: number; name: string };
}

/**
 * Reconcile fork-authored ledger rows into the fork lane.
 *
 * MUST run before the applied-set snapshot: that snapshot is taken once and then
 * consulted in memory, so a repair performed afterwards would leave the loop
 * reading a stale set ג€” it would skip the upstream migration this repair just
 * freed up, silently reproducing the exact defect being fixed.
 */
export function repairForkLedger(db: SqliteDatabase, schemaDir: string): ForkLaneRepair[] {
  const repairs: ForkLaneRepair[] = [];
  const readVersion = db.prepare('SELECT name FROM _migrations WHERE version = ?');
  const move = db.prepare('UPDATE _migrations SET version = ? WHERE version = ? AND name = ?');
  const insert = db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)');

  for (const rule of FORK_LANE_RULES) {
    let repair: ForkLaneRepair | null = null;
    const tx = db.transaction((): void => {
      // Every read happens under the write lock, so two starting processes cannot
      // both decide to repair.
      const legacy = rule.legacyVersions
        .map((v) => ({ version: v, row: readVersion.get(v) as { name: string } | undefined }))
        .find((x) => x.row?.name === rule.name);
      if (!legacy) {
        return; // nothing recorded under a legacy identity: already canonical, or fresh.
      }
      // Never clobber an occupied canonical slot ג€” `version` is the PRIMARY KEY and
      // the UPDATE would throw, aborting startup.
      const occupant = readVersion.get(rule.canonical) as { name: string } | undefined;
      if (occupant) {
        return;
      }
      if (!rule.schemaPresent(db)) {
        // The ledger claims this ran but the schema disagrees. Leave the row alone
        // and let the normal loop apply the canonical migration for real.
        return;
      }

      const successor = rule.upstreamSuccessor;
      if (successor && legacy.version === successor.version) {
        // Vacate and immediately refill the number in one transaction. Readers see
        // either the old state or the repaired one, never a hole at this version.
        move.run(rule.canonical, legacy.version, rule.name);
        db.exec(fs.readFileSync(path.join(schemaDir, successor.file), 'utf-8'));
        insert.run(successor.version, successor.name);
        repair = {
          from: legacy.version,
          to: rule.canonical,
          name: rule.name,
          backfilled: { version: successor.version, name: successor.name },
        };
        return;
      }

      move.run(rule.canonical, legacy.version, rule.name);
      repair = { from: legacy.version, to: rule.canonical, name: rule.name };
    });
    tx.immediate();
    if (repair) {
      repairs.push(repair);
    }
  }
  return repairs;
}

/**
 * Ledger rows whose recorded name disagrees with this build's name for that
 * version. A mismatch means the version-keyed skip is about to lie: the runner
 * will treat a migration as applied that never ran, and the ledger will claim it
 * did forever after. That is exactly how a broken build reached a user's machine.
 *
 * Only versions this build owns are checked. Rows this build does not know about
 * are left alone, so a database written by a NEWER build still opens here ג€”
 * downgrade has to keep working, because rolling back is the recovery path.
 */
export function findLedgerNameMismatches(
  db: SqliteDatabase,
  migrations: Migration[],
): Array<{ version: number; recorded: string; expected: string }> {
  const rows = db.prepare('SELECT version, name FROM _migrations').all() as Array<{
    version: number;
    name: string;
  }>;
  const recordedByVersion = new Map(rows.map((r) => [r.version, r.name]));
  const mismatches: Array<{ version: number; recorded: string; expected: string }> = [];
  for (const m of migrations) {
    const recorded = recordedByVersion.get(m.version);
    if (recorded !== undefined && recorded !== m.name) {
      mismatches.push({ version: m.version, recorded, expected: m.name });
    }
  }
  return mismatches;
}

/**
 * Order matters. Versions must be ascending; gaps are allowed but unusual.
 *
 * The `0001_initial.sql` file is the consolidated end-state schema; everything
 * the PGLite worker's cumulative migrations produced lives there. Once landed,
 * new schema changes go in subsequent migrations (0002_..., 0003_...).
 */
export function getMigrations(schemaDir: string): Migration[] {
  return [
    {
      version: 1,
      name: 'initial',
      sqlFile: path.join(schemaDir, '0001_initial.sql'),
    },
    {
      version: 2,
      name: 'pending_files_index',
      sqlFile: path.join(schemaDir, '0002_pending_files_index.sql'),
    },
    {
      version: 3,
      name: 'searchable_text_message_kind',
      sqlFile: path.join(schemaDir, '0003_searchable_text_message_kind.sql'),
    },
    {
      version: 4,
      name: 'fts_on_searchable_text',
      sqlFile: path.join(schemaDir, '0004_fts_on_searchable_text.sql'),
    },
    {
      version: 5,
      name: 'drop_transcript_events',
      sqlFile: path.join(schemaDir, '0005_drop_transcript_events.sql'),
    },
    {
      version: 6,
      name: 'message_kind_index',
      sqlFile: path.join(schemaDir, '0006_message_kind_index.sql'),
    },
    {
      version: 7,
      name: 'rebuild_fts_after_kind',
      sqlFile: path.join(schemaDir, '0007_rebuild_fts_after_kind.sql'),
    },
    {
      version: 8,
      name: 'guard_fts_triggers',
      sqlFile: path.join(schemaDir, '0008_guard_fts_triggers.sql'),
    },
    {
      version: 9,
      name: 'worktree_pr_linkage',
      sqlFile: path.join(schemaDir, '0009_worktree_pr_linkage.sql'),
    },
    {
      version: 10,
      name: 'tracker_origin_urn',
      sqlFile: path.join(schemaDir, '0010_tracker_origin_urn.sql'),
    },
    {
      version: 11,
      name: 'project_file_sync_baseline',
      sqlFile: path.join(schemaDir, '0011_project_file_sync_baseline.sql'),
    },
    {
      version: 12,
      name: 'tracker_type_defs',
      sqlFile: path.join(schemaDir, '0012_tracker_type_defs.sql'),
    },
    {
      version: 13,
      name: 'orgs_and_projects',
      sqlFile: path.join(schemaDir, '0013_orgs_and_projects.sql'),
    },
    {
      version: 14,
      name: 'tracker_relationship_index',
      sqlFile: path.join(schemaDir, '0014_tracker_relationship_index.sql'),
    },
    {
      version: 15,
      name: 'collab_local_origins_project_id',
      sqlFile: path.join(schemaDir, '0015_collab_local_origins_project_id.sql'),
    },
    {
      version: 16,
      name: 'read_receipts',
      sqlFile: path.join(schemaDir, '0016_read_receipts.sql'),
    },
    {
      version: 17,
      name: 'tracker_type_navigation',
      sqlFile: path.join(schemaDir, '0017_tracker_type_navigation.sql'),
    },
    {
      version: 18,
      name: 'history_preedit_session_index',
      sqlFile: path.join(schemaDir, '0018_history_preedit_session_index.sql'),
    },
    {
      version: 19,
      name: 'collab_document_replicas',
      sqlFile: path.join(schemaDir, '0019_collab_document_replicas.sql'),
    },
    {
      version: 20,
      name: 'collab_replica_staged_snapshots',
      sqlFile: path.join(schemaDir, '0020_collab_replica_staged_snapshots.sql'),
    },
    {
      version: 21,
      name: 'collab_replica_quarantine_observability',
      sqlFile: path.join(schemaDir, '0021_collab_replica_quarantine_observability.sql'),
    },
    {
      version: 22,
      name: 'collab_document_assets',
      sqlFile: path.join(schemaDir, '0022_collab_document_assets.sql'),
    },
    {
      version: 23,
      name: 'collab_asset_retry_schedule',
      sqlFile: path.join(schemaDir, '0023_collab_asset_retry_schedule.sql'),
    },
    {
      version: 24,
      name: 'tracker_personal_state',
      sqlFile: path.join(schemaDir, '0024_tracker_personal_state.sql'),
    },
    {
      version: 25,
      name: 'account_org_bindings',
      sqlFile: path.join(schemaDir, '0025_account_org_bindings.sql'),
    },
    {
      version: 26,
      name: 'tool_usage_counters',
      sqlFile: path.join(schemaDir, '0026_tool_usage_counters.sql'),
    },
    {
      version: 27,
      name: 'tool_usage_backfill_state',
      sqlFile: path.join(schemaDir, '0027_tool_usage_backfill_state.sql'),
    },
    {
      version: 28,
      name: 'tracker_shared_saved_views',
      sqlFile: path.join(schemaDir, '0028_tracker_shared_saved_views.sql'),
    },
    {
      version: 29,
      name: 'tracker_personal_snooze',
      sqlFile: path.join(schemaDir, '0029_tracker_personal_snooze.sql'),
    },
    {
      version: 30,
      name: 'tracker_type_defs_synced_model',
      sqlFile: path.join(schemaDir, '0030_tracker_type_defs_synced_model.sql'),
    },
    {
      version: 31,
      name: 'session_commits',
      sqlFile: path.join(schemaDir, '0031_session_commits.sql'),
    },
    {
      version: 32,
      name: 'feedback_request_cache',
      sqlFile: path.join(schemaDir, '0032_feedback_request_cache.sql'),
    },
    {
      version: 33,
      name: 'tracker_local_key',
      sqlFile: path.join(schemaDir, '0033_tracker_local_key.sql'),
    },
    {
      version: 34,
      name: 'feedback_request_index',
      sqlFile: path.join(schemaDir, '0034_feedback_request_index.sql'),
    },
    {
      version: 35,
      name: 'github_issues',
      sqlFile: path.join(schemaDir, '0035_github_issues.sql'),
    },
    {
      version: 36,
      name: 'history_file_timestamp_index',
      sqlFile: path.join(schemaDir, '0036_history_file_timestamp_index.sql'),
    },
    {
      version: 37,
      name: 'drop_unused_message_index',
      sqlFile: path.join(schemaDir, '0037_drop_unused_message_index.sql'),
    },
    {
      version: 38,
      name: 'repair_double_quoted_review_status',
      sqlFile: path.join(schemaDir, '0038_repair_double_quoted_review_status.sql'),
    },
    {
      version: 39,
      name: 'drop_unique_issue_number_index',
      sqlFile: path.join(schemaDir, '0039_drop_unique_issue_number_index.sql'),
    },
    {
      version: 40,
      name: 'worktree_source_folder',
      sqlFile: path.join(schemaDir, '0040_worktree_source_folder.sql'),
    },
    { version: 41, name: 'document_feedback_index', sqlFile: path.join(schemaDir, '0041_document_feedback_index.sql') },
    { version: 42, name: 'tracker_creation_receipts', sqlFile: path.join(schemaDir, '0042_tracker_creation_receipts.sql') },
    // --- fork lane (version >= FORK_LANE_BASE) ---------------------------------
    // Fork-authored migrations live here, clear of the range upstream mints into.
    // Databases that recorded this one at 32 (pre-fold) or 35 (the first, broken
    // fold build) are canonicalized by repairForkLedger() before the loop runs.
    //
    // This buys distance, not permanence: upstream could eventually reach 1000.
    // The durable fix is a separate namespaced local ledger ג€” see
    // _pending/v15/PLAN-migration-collision-fix.md.
    {
      version: 1001,
      name: 'queued_prompt_priority_control',
      sqlFile: path.join(schemaDir, '1001_queued_prompt_priority_control.sql'),
    },
  ];
}

export function runMigrations(db: SqliteDatabase, schemaDir: string): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const migrations = getMigrations(schemaDir).sort((a, b) => a.version - b.version);

  // Verify ordering: no version may equal a previous version.
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} (${m.name})`);
    }
    seen.add(m.version);
  }

  // Canonicalize fork-lineage ledger rows BEFORE snapshotting the applied set.
  // Order matters: the snapshot below is taken once and then consulted in memory,
  // so a repair performed afterwards would leave the loop reading a stale set and
  // skipping the very upstream migration the repair just freed up.
  const relocated = repairForkLedger(db, schemaDir);

  // Any remaining disagreement between a ledger row's name and this build's name
  // for that version means the version-keyed skip below is about to lie. Refuse
  // rather than silently apply the wrong schema: a loud failure is recoverable by
  // reinstalling the previous build, a silent one is not, and the silent variant
  // is what shipped a broken database to a user.
  const nameMismatches = findLedgerNameMismatches(db, migrations);
  if (nameMismatches.length > 0) {
    const detail = nameMismatches
      .map((m) => `v${m.version}: ledger has '${m.recorded}', this build expects '${m.expected}'`)
      .join('; ');
    throw new Error(
      `Migration ledger does not match this build (${detail}). ` +
        `Refusing to migrate: continuing would skip migrations that never ran. ` +
        `Reinstall the previous version, or file this with the ledger contents.`,
    );
  }

  const appliedRows = db
    .prepare('SELECT version FROM _migrations ORDER BY version ASC')
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  const result: MigrationResult = {
    applied: [],
    skipped: [],
    relocated,
    nameMismatches,
  };

  const findAppliedVersion = db.prepare(
    'SELECT version, name FROM _migrations WHERE version = ?',
  );

  for (const m of migrations) {
    if (applied.has(m.version)) {
      result.skipped.push(m.version);
      continue;
    }
    const sources = [m.sql, m.sqlFile, m.run].filter((x) => x !== undefined);
    if (sources.length !== 1) {
      throw new Error(
        `Migration ${m.version} (${m.name}) must specify exactly one of sql/sqlFile/run`,
      );
    }

    const tx = db.transaction((): boolean => {
      // Another app process or worker may have initialized the same database
      // after our applied-version snapshot. Re-check while holding the
      // immediate write lock so only one connection can apply this version.
      // Compare the name too: a different build racing us could install a
      // different migration under this number, and treating that as our own
      // success is how an unapplied migration gets recorded as applied.
      const existing = findAppliedVersion.get(m.version) as
        | { version: number; name: string }
        | undefined;
      if (existing) {
        if (existing.name !== m.name) {
          throw new Error(
            `Migration ledger v${m.version} was claimed concurrently by '${existing.name}' ` +
              `but this build expects '${m.name}'.`,
          );
        }
        return false;
      }
      if (m.sqlFile) {
        const sql = fs.readFileSync(m.sqlFile, 'utf-8');
        db.exec(sql);
      } else if (m.sql) {
        db.exec(m.sql);
      } else if (m.run) {
        m.run(db);
      }
      db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
        m.version,
        m.name,
      );
      return true;
    });
    if (tx.immediate()) {
      result.applied.push(m.version);
    } else {
      result.skipped.push(m.version);
    }
  }

  return result;
}
