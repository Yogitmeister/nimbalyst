import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';

export interface OllamaUsageSidecarInput {
  limitsAvailable: boolean;
  session?: { utilization: number; resetsAt: string | null };
  weekly?: { utilization: number; resetsAt: string | null };
  lastUpdated: number;
}

interface ProviderUsageWindow {
  slot: 'session' | 'weekly';
  label: 'session' | 'weekly';
  used_percentage: number;
  window_seconds: null;
  resets_at: null;
}

export interface ProviderUsageSidecar {
  schema_version: 1;
  provider: 'ollama';
  source: 'nimbalyst-ollama';
  fetched_at: number;
  windows: ProviderUsageWindow[];
  error_code: null;
}

export function defaultOllamaUsageSidecarPath(): string {
  const cacheDir = process.env.TOKEN_OPTIMIZER_CACHE_DIR
    || join(homedir(), '.claude', 'token-optimizer');
  return join(cacheDir, 'ollama-usage.json');
}

function projectWindow(
  slot: 'session' | 'weekly',
  value: OllamaUsageSidecarInput['session']
): ProviderUsageWindow | null {
  if (!value || !Number.isFinite(value.utilization) || value.utilization < 0 || value.utilization > 100) {
    return null;
  }
  // Ollama's account response does not supply reset/duration information. Do not
  // infer it from pricing cadence, activity periods, or any other proxy field.
  return {
    slot,
    label: slot,
    used_percentage: Math.round(value.utilization * 10) / 10,
    window_seconds: null,
    resets_at: null,
  };
}

export function projectOllamaUsageSidecar(input: OllamaUsageSidecarInput): ProviderUsageSidecar | null {
  if (!input.limitsAvailable || !Number.isFinite(input.lastUpdated) || input.lastUpdated <= 0 || input.lastUpdated > Date.now()) {
    return null;
  }
  const windows = [
    projectWindow('session', input.session),
    projectWindow('weekly', input.weekly),
  ].filter((window): window is ProviderUsageWindow => window !== null);
  if (windows.length === 0) return null;
  return {
    schema_version: 1,
    provider: 'ollama',
    source: 'nimbalyst-ollama',
    fetched_at: input.lastUpdated,
    windows,
    error_code: null,
  };
}

const LOCK_STALE_MS = 60 * 1000;

function tryAcquireSidecarLock(lockPath: string): number | null {
  try {
    const existing = statSync(lockPath);
    if (Date.now() - existing.mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
  } catch {
    // Missing lock is normal; exclusive creation below resolves races.
  }

  try {
    const descriptor = openSync(lockPath, 'wx');
    writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    return descriptor;
  } catch {
    return null;
  }
}

function priorFetchedAt(targetPath: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(targetPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const fetchedAt = (parsed as { fetched_at?: unknown }).fetched_at;
    return typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? fetchedAt : null;
  } catch {
    return null;
  }
}

function writeJsonAtomically(targetPath: string, value: ProviderUsageSidecar): void {
  const directory = dirname(targetPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const descriptor = openSync(temporaryPath, 'w');
    try {
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, targetPath);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The successful rename removes the temporary path.
    }
  }
}

/**
 * Publish only a complete, redacted, valid Ollama usage snapshot. A rejected
 * update leaves any prior valid snapshot intact for last-known-good rendering.
 */
export function publishOllamaUsageSidecar(
  input: OllamaUsageSidecarInput,
  targetPath = defaultOllamaUsageSidecarPath(),
): boolean {
  const sidecar = projectOllamaUsageSidecar(input);
  if (!sidecar) return false;

  // Standalone ollama_usage.js uses this exact <sidecar>.lock convention.
  // Holding it across read/compare/write makes Nimbalyst and standalone
  // publishers one ownership domain and preserves the newest valid sidecar.
  const lockPath = `${targetPath}.lock`;
  const descriptor = tryAcquireSidecarLock(lockPath);
  if (descriptor === null) return false;
  try {
    const prior = priorFetchedAt(targetPath);
    if (prior !== null && prior > sidecar.fetched_at) return false;
    writeJsonAtomically(targetPath, sidecar);
    return true;
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // Lock cleanup below is still required after a descriptor close failure.
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock may already have been removed by cleanup after a write error.
    }
  }
}
