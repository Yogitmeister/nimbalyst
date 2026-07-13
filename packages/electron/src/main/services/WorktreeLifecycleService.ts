import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log/main';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import {
  GitWorktreeService,
  type WorktreeRemovalReadiness,
} from './GitWorktreeService';
import { createSuperLoopStore } from './SuperLoopStore';
import {
  createWorktreeStore,
  type Worktree,
  type WorktreeStore,
} from './WorktreeStore';

const logger = log.scope('WorktreeLifecycleService');

export type WorktreeCleanupMode = 'archive' | 'delete';

export interface WorktreeLifecycleMetadata {
  resultCapturedAt?: number;
  completionReportAt?: number;
  parentAuditAt?: number;
  terminalDisposition?: 'complete' | 'retired';
  resumable?: boolean;
  retiredAt?: number;
  retirementReason?: string;
  retiredWorktreeId?: string;
  retiredWorktreePath?: string;
  continuationSessionId?: string;
}

interface DatabaseLike {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}

interface LinkedSessionRow {
  id: string;
  status: string | null;
  is_archived: boolean | number | null;
  metadata: unknown;
}

interface LinkedSessionSnapshot {
  id: string;
  status: string;
  isArchived: boolean;
  metadata: Record<string, unknown>;
}

interface LiveSessionState {
  status?: string;
  isStreaming?: boolean;
}

interface GitLifecycleAdapter {
  verifyWorktreeRemovalReadiness(
    projectPath: string,
    worktree: Worktree,
  ): Promise<WorktreeRemovalReadiness>;
  deleteWorktreeSafely(
    worktreePath: string,
    workspacePath: string,
    beforeRemove: () => Promise<WorktreeRemovalReadiness>,
  ): Promise<void>;
  listWorktrees(
    workspacePath: string,
  ): Promise<Array<{ path: string; branch: string; isMain: boolean }>>;
}

export interface WorktreeLifecycleDependencies {
  gitService?: GitLifecycleAdapter;
  worktreeStore?: WorktreeStore;
  pathExists?: (worktreePath: string) => boolean;
  getLiveSessionState?: (sessionId: string) => LiveSessionState | null;
  stopWatcher?: (worktreePath: string) => Promise<void>;
  startWatcher?: (worktreePath: string) => Promise<void>;
  destroySessionTerminals?: (sessionIds: string[]) => Promise<void>;
  getWorktreeTerminalIds?: (workspacePath: string, worktreeId: string) => string[];
  destroyTerminal?: (terminalId: string) => Promise<void>;
  deleteStoredTerminal?: (workspacePath: string, terminalId: string) => void;
  updateSessionRepository?: (
    sessionId: string,
    isArchived: boolean,
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  now?: () => number;
}

export interface WorktreeCleanupResult {
  worktreeId: string;
  mode: WorktreeCleanupMode;
  sessionIds: string[];
}

export interface WorktreeReconciliationResult {
  usable: Worktree[];
  reconciledIds: string[];
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeBoolean(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    // Missing paths still need a stable comparable form for reconciliation.
  }
  const normalized = path.normalize(canonical);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function lifecycleMetadata(metadata: Record<string, unknown>): WorktreeLifecycleMetadata {
  return normalizeJsonObject(metadata.worktreeLifecycle) as WorktreeLifecycleMetadata;
}

/**
 * Owns the destructive worktree lifecycle. Every user-facing delete/archive
 * route must enter here so linked sessions and Git durability are revalidated
 * in the same removal lock immediately before disk state changes.
 */
export class WorktreeLifecycleService {
  private readonly gitService: GitLifecycleAdapter;
  private readonly worktreeStore: WorktreeStore;
  private readonly pathExists: (worktreePath: string) => boolean;
  private readonly getLiveSessionState: (sessionId: string) => LiveSessionState | null;
  private readonly stopWatcher: (worktreePath: string) => Promise<void>;
  private readonly startWatcher: (worktreePath: string) => Promise<void>;
  private readonly destroySessionTerminals: (sessionIds: string[]) => Promise<void>;
  private readonly getWorktreeTerminalIds: (workspacePath: string, worktreeId: string) => string[];
  private readonly destroyTerminal: (terminalId: string) => Promise<void>;
  private readonly deleteStoredTerminal: (workspacePath: string, terminalId: string) => void;
  private readonly updateSessionRepository: (
    sessionId: string,
    isArchived: boolean,
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseLike,
    dependencies: WorktreeLifecycleDependencies = {},
  ) {
    this.gitService = dependencies.gitService ?? new GitWorktreeService();
    this.worktreeStore = dependencies.worktreeStore ?? createWorktreeStore(db);
    this.pathExists = dependencies.pathExists ?? fs.existsSync;
    this.getLiveSessionState = dependencies.getLiveSessionState ?? ((sessionId) =>
      getSessionStateManager().getSessionState(sessionId));
    this.stopWatcher = dependencies.stopWatcher ?? (async () => undefined);
    this.startWatcher = dependencies.startWatcher ?? (async () => undefined);
    this.destroySessionTerminals = dependencies.destroySessionTerminals ?? (async () => undefined);
    this.getWorktreeTerminalIds = dependencies.getWorktreeTerminalIds ?? (() => []);
    this.destroyTerminal = dependencies.destroyTerminal ?? (async () => undefined);
    this.deleteStoredTerminal = dependencies.deleteStoredTerminal ?? (() => undefined);
    this.updateSessionRepository = dependencies.updateSessionRepository ?? (async () => undefined);
    this.now = dependencies.now ?? Date.now;
  }

  async validateCleanup(
    worktreeId: string,
    workspacePath: string,
  ): Promise<{ worktree: Worktree; sessions: LinkedSessionSnapshot[]; readiness: WorktreeRemovalReadiness }> {
    if (!worktreeId) throw new Error('worktreeId is required');
    if (!workspacePath) throw new Error('workspacePath is required');

    const worktree = await this.worktreeStore.get(worktreeId);
    if (!worktree) throw new Error(`Worktree not found: ${worktreeId}`);
    if (normalizePathForComparison(worktree.projectPath) !== normalizePathForComparison(workspacePath)) {
      throw new Error('Worktree does not belong to the requested workspace');
    }

    const sessions = await this.loadLinkedSessions(worktreeId);
    await this.assertLinkedSessionsClosed(sessions);
    const readiness = await this.gitService.verifyWorktreeRemovalReadiness(workspacePath, worktree);
    return { worktree, sessions, readiness };
  }

  async cleanupWorktree(
    worktreeId: string,
    workspacePath: string,
    mode: WorktreeCleanupMode,
  ): Promise<WorktreeCleanupResult> {
    let snapshots: LinkedSessionSnapshot[] | null = null;
    let worktree: Worktree | null = null;
    let watcherStopped = false;
    let terminalIds: string[] = [];

    try {
      const initial = await this.worktreeStore.get(worktreeId);
      if (!initial) throw new Error(`Worktree not found: ${worktreeId}`);
      worktree = initial;

      await this.gitService.deleteWorktreeSafely(
        initial.path,
        workspacePath,
        async () => {
          const validated = await this.validateCleanup(worktreeId, workspacePath);
          worktree = validated.worktree;
          snapshots = validated.sessions;

          await this.retireLinkedSessions(validated.worktree, validated.sessions, 'worktree-cleanup');
          await this.destroySessionTerminals(validated.sessions.map((session) => session.id));
          terminalIds = this.getWorktreeTerminalIds(workspacePath, worktreeId);
          for (const terminalId of terminalIds) {
            await this.destroyTerminal(terminalId);
          }
          watcherStopped = true;
          await this.stopWatcher(validated.worktree.path);

          // Re-run the complete proof after lifecycle side effects and as close
          // as possible to removal. A newly linked session or queued prompt
          // must invalidate this attempt rather than inherit a deleted cwd.
          const finalValidation = await this.validateCleanup(worktreeId, workspacePath);
          const initialSessionIds = validated.sessions.map((session) => session.id).sort();
          const finalSessionIds = finalValidation.sessions.map((session) => session.id).sort();
          if (
            initialSessionIds.length !== finalSessionIds.length
            || initialSessionIds.some((sessionId, index) => sessionId !== finalSessionIds[index])
          ) {
            throw new Error('Linked session set changed during worktree cleanup');
          }
          return finalValidation.readiness;
        },
      );
    } catch (error) {
      if (worktree && snapshots && await this.isUsableRegistration(worktree)) {
        await this.restoreLinkedSessions(snapshots);
        if (watcherStopped) {
          await this.startWatcher(worktree.path).catch((watcherError) => {
            logger.error('Failed to restart watcher after cleanup rollback', {
              worktreeId,
              error: watcherError,
            });
          });
        }
      }
      throw error;
    }

    if (!worktree || !snapshots) {
      throw new Error(`Worktree cleanup did not capture lifecycle state: ${worktreeId}`);
    }

    for (const terminalId of terminalIds) {
      try {
        this.deleteStoredTerminal(workspacePath, terminalId);
      } catch (error) {
        // Disk removal has already succeeded. A stale terminal-store entry
        // must not prevent the database from reflecting that unavailable cwd.
        logger.warn('Failed to remove stored terminal after worktree cleanup', {
          worktreeId,
          terminalId,
          error,
        });
      }
    }

    // Disk removal is already proven. Persist the unavailable worktree state
    // before optionally deleting the row so a failed final delete remains safe.
    await this.worktreeStore.updateArchived(worktreeId, true);
    const superLoopStore = createSuperLoopStore(this.db);
    const loop = await superLoopStore.getLoopByWorktreeId(worktreeId);
    if (loop && !loop.isArchived) {
      await superLoopStore.updateLoop(loop.id, { isArchived: true });
    }
    if (mode === 'delete') {
      await this.worktreeStore.delete(worktreeId);
    }

    return {
      worktreeId,
      mode,
      sessionIds: snapshots.map((session) => session.id),
    };
  }

  /**
   * Reconcile database rows against both disk and Git's authoritative
   * registration list. Unverifiable rows are retired and never returned.
   */
  async reconcileWorkspace(workspacePath: string): Promise<WorktreeReconciliationResult> {
    const worktrees = await this.worktreeStore.list(workspacePath);
    const registrations = await this.gitService.listWorktrees(workspacePath);
    const registeredPaths = new Set(
      registrations.map((registration) => normalizePathForComparison(registration.path)),
    );
    const usable: Worktree[] = [];
    const reconciledIds: string[] = [];

    for (const worktree of worktrees) {
      const registered = registeredPaths.has(normalizePathForComparison(worktree.path));
      if (this.pathExists(worktree.path) && registered) {
        usable.push(worktree);
        continue;
      }

      await this.retireUnavailableWorktree(
        worktree,
        this.pathExists(worktree.path) ? 'git-registration-missing' : 'worktree-path-missing',
      );
      reconciledIds.push(worktree.id);
    }

    return { usable, reconciledIds };
  }

  async reconcileAllWorkspaces(): Promise<void> {
    const { rows } = await this.db.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id
       FROM worktrees
       WHERE is_archived = FALSE OR is_archived IS NULL`,
    );
    for (const row of rows) {
      try {
        await this.reconcileWorkspace(row.workspace_id);
      } catch (error) {
        // Git may be unavailable for a project that is not currently mounted.
        // Fail closed without reclassifying every row on an uncertain read.
        logger.warn('Could not reconcile worktrees for workspace', {
          workspacePath: row.workspace_id,
          error,
        });
      }
    }
  }

  private async loadLinkedSessions(worktreeId: string): Promise<LinkedSessionSnapshot[]> {
    const { rows } = await this.db.query<LinkedSessionRow>(
      `SELECT id, status, is_archived, metadata
       FROM ai_sessions
       WHERE worktree_id = $1
       ORDER BY created_at ASC`,
      [worktreeId],
    );
    return rows.map((row) => ({
      id: row.id,
      status: row.status ?? 'idle',
      isArchived: normalizeBoolean(row.is_archived),
      metadata: normalizeJsonObject(row.metadata),
    }));
  }

  private async assertLinkedSessionsClosed(sessions: LinkedSessionSnapshot[]): Promise<void> {
    const activeQueueBySession = new Map<string, string>();
    if (sessions.length > 0) {
      const placeholders = sessions.map((_, index) => `$${index + 1}`).join(', ');
      const { rows } = await this.db.query<{ session_id: string; status: string }>(
        `SELECT session_id, status
         FROM queued_prompts
         WHERE session_id IN (${placeholders})
           AND status IN ('pending', 'executing')`,
        sessions.map((session) => session.id),
      );
      for (const row of rows) activeQueueBySession.set(row.session_id, row.status);
    }

    for (const session of sessions) {
      const live = this.getLiveSessionState(session.id);
      if (
        session.status === 'running'
        || session.status === 'waiting_for_input'
        || live?.status === 'running'
        || live?.status === 'waiting_for_input'
        || live?.isStreaming === true
      ) {
        throw new Error(`Linked session ${session.id} is running or waiting`);
      }

      const queueStatus = activeQueueBySession.get(session.id);
      if (queueStatus) {
        throw new Error(`Linked session ${session.id} has a ${queueStatus} queued prompt`);
      }
      if (session.metadata.hasPendingPrompt === true) {
        throw new Error(`Linked session ${session.id} has a pending interactive prompt`);
      }

      const lifecycle = lifecycleMetadata(session.metadata);
      if (!lifecycle.resultCapturedAt) {
        throw new Error(`Linked session ${session.id} has no captured result`);
      }
      if (!lifecycle.completionReportAt && !lifecycle.parentAuditAt) {
        throw new Error(`Linked session ${session.id} has no completion artifact or parent audit`);
      }

      const phase = session.metadata.phase;
      const terminalComplete = phase === 'complete' || lifecycle.terminalDisposition === 'complete';
      const terminalRetired = lifecycle.terminalDisposition === 'retired' && lifecycle.resumable === false;
      if (!terminalComplete && !terminalRetired) {
        throw new Error(`Linked session ${session.id} has no terminal disposition`);
      }
    }
  }

  private async retireLinkedSessions(
    worktree: Worktree,
    sessions: LinkedSessionSnapshot[],
    reason: string,
  ): Promise<void> {
    const retiredAt = this.now();
    const mutated: LinkedSessionSnapshot[] = [];
    try {
      for (const session of sessions) {
        const lifecycle = lifecycleMetadata(session.metadata);
        const metadata = {
          ...session.metadata,
          worktreeLifecycle: {
            ...lifecycle,
            terminalDisposition: 'retired',
            resumable: false,
            retiredAt,
            retirementReason: reason,
            retiredWorktreeId: worktree.id,
            retiredWorktreePath: worktree.path,
          } satisfies WorktreeLifecycleMetadata,
        };
        await this.db.query(
          `UPDATE ai_sessions
           SET is_archived = $2, metadata = $3
           WHERE id = $1`,
          [session.id, true, JSON.stringify(metadata)],
        );
        mutated.push(session);
        await this.updateSessionRepository(session.id, true, metadata);
      }
    } catch (error) {
      await this.restoreLinkedSessions(mutated);
      throw error;
    }
  }

  private async restoreLinkedSessions(sessions: LinkedSessionSnapshot[]): Promise<void> {
    const failures: string[] = [];
    for (const session of sessions) {
      try {
        await this.db.query(
          `UPDATE ai_sessions
           SET is_archived = $2, metadata = $3
           WHERE id = $1`,
          [session.id, session.isArchived, JSON.stringify(session.metadata)],
        );
        await this.updateSessionRepository(session.id, session.isArchived, session.metadata);
      } catch (error) {
        failures.push(`${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Failed to restore linked sessions: ${failures.join('; ')}`);
    }
  }

  private async retireUnavailableWorktree(worktree: Worktree, reason: string): Promise<void> {
    const sessions = await this.loadLinkedSessions(worktree.id);
    await this.retireLinkedSessions(worktree, sessions, reason);
    // Archive the worktree only after its linked sessions are safely retired.
    // If retirement fails, the active row remains eligible for a later retry.
    await this.worktreeStore.updateArchived(worktree.id, true);
    const superLoopStore = createSuperLoopStore(this.db);
    const loop = await superLoopStore.getLoopByWorktreeId(worktree.id);
    if (loop && !loop.isArchived) {
      await superLoopStore.updateLoop(loop.id, { isArchived: true });
    }
    logger.warn('Retired unavailable worktree record', {
      worktreeId: worktree.id,
      path: worktree.path,
      reason,
    });
  }

  private async isUsableRegistration(worktree: Worktree): Promise<boolean> {
    if (!this.pathExists(worktree.path)) return false;
    try {
      const registrations = await this.gitService.listWorktrees(worktree.projectPath);
      const expected = normalizePathForComparison(worktree.path);
      return registrations.some((registration) =>
        normalizePathForComparison(registration.path) === expected);
    } catch {
      return false;
    }
  }
}

export function createWorktreeLifecycleService(
  db: DatabaseLike,
  dependencies: WorktreeLifecycleDependencies = {},
): WorktreeLifecycleService {
  return new WorktreeLifecycleService(db, {
    updateSessionRepository: async (sessionId, isArchived, metadata) => {
      await AISessionsRepository.updateMetadata(sessionId, {
        isArchived,
        metadata,
      });
    },
    ...dependencies,
  });
}
