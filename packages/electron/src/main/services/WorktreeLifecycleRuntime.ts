import { gitRefWatcher } from '../file/GitRefWatcher';
import {
  deleteTerminalInstance,
  getTerminalsByWorktreeId,
} from '../utils/terminalStore';
import { getTerminalSessionManager } from './TerminalSessionManager';
import {
  createWorktreeLifecycleService,
  type WorktreeLifecycleService,
  type WorktreeLifecycleDependencies,
} from './WorktreeLifecycleService';

interface DatabaseLike {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}

/** Main-process adapter that supplies the irreversible runtime side effects. */
export function createRuntimeWorktreeLifecycleService(
  db: DatabaseLike,
  overrides: WorktreeLifecycleDependencies = {},
): WorktreeLifecycleService {
  const terminalManager = getTerminalSessionManager();
  return createWorktreeLifecycleService(db, {
    stopWatcher: (worktreePath) => gitRefWatcher.stop(worktreePath),
    startWatcher: (worktreePath) => gitRefWatcher.start(worktreePath),
    destroySessionTerminals: (sessionIds) => terminalManager.destroyTerminalsForSessions(sessionIds),
    getWorktreeTerminalIds: getTerminalsByWorktreeId,
    destroyTerminal: (terminalId) => terminalManager.destroyTerminal(terminalId),
    deleteStoredTerminal: deleteTerminalInstance,
    ...overrides,
  });
}
