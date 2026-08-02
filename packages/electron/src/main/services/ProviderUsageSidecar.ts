import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs';

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
  writeJsonAtomically(targetPath, sidecar);
  return true;
}
