import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StreamChunk } from '@nimbalyst/runtime/ai/server/types';

export type AcceptanceFaultMode =
  | 'drop-terminal-after-final'
  | 'drop-terminal-without-final'
  | 'sync-disconnect';

interface AcceptanceFaultConfig {
  mode: AcceptanceFaultMode;
  root: string;
}

interface ProviderFaultOptions {
  stream: AsyncIterable<StreamChunk>;
  sessionId: string;
  userDataPath: () => string;
  env?: NodeJS.ProcessEnv;
  claimFault?: (config: AcceptanceFaultConfig, sessionId: string) => Promise<boolean>;
  recordApplied?: (
    config: AcceptanceFaultConfig,
    sessionId: string,
    details: Record<string, boolean>,
  ) => Promise<void>;
  onTerminalSuppressed?: (mode: Exclude<AcceptanceFaultMode, 'sync-disconnect'>) => Promise<void>;
}

interface SyncFaultOptions<T> {
  sessionId: string;
  userDataPath: () => string;
  getSyncProvider: () => {
    isConnected(sessionId: string): boolean;
    disconnect(sessionId: string): void;
    connect(sessionId: string): Promise<void>;
  } | null;
  run: () => Promise<T>;
  env?: NodeJS.ProcessEnv;
  claimFault?: (config: AcceptanceFaultConfig, sessionId: string) => Promise<boolean>;
  recordApplied?: (
    config: AcceptanceFaultConfig,
    sessionId: string,
    details: Record<string, boolean>,
  ) => Promise<void>;
}

const SUPPORTED_FAULTS = new Set<AcceptanceFaultMode>([
  'drop-terminal-after-final',
  'drop-terminal-without-final',
  'sync-disconnect',
]);

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolve an installed-acceptance fault only inside an explicitly isolated
 * Electron profile. Unknown modes, ordinary launches, broad roots, and roots
 * which do not contain userData are inert.
 */
export function resolveAcceptanceFault(
  env: NodeJS.ProcessEnv,
  userDataPath: string,
): AcceptanceFaultConfig | null {
  if (env.NIMBALYST_TEST_ACCEPT !== '1') return null;
  const rawMode = env.NIMBALYST_ACCEPT_FAULT;
  if (!rawMode || !SUPPORTED_FAULTS.has(rawMode as AcceptanceFaultMode)) return null;
  const rawRoot = env.NIMBALYST_ACCEPT_ROOT;
  if (!rawRoot || !path.isAbsolute(rawRoot) || !path.isAbsolute(userDataPath)) return null;
  const root = path.resolve(rawRoot);
  const userData = path.resolve(userDataPath);
  if (path.parse(root).root === root || !isContainedPath(root, userData)) return null;
  return { mode: rawMode as AcceptanceFaultMode, root };
}

function safeReceiptSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'session';
}

async function claimFaultOnDisk(
  config: AcceptanceFaultConfig,
  sessionId: string,
): Promise<boolean> {
  const directory = path.join(config.root, 'fault-receipts');
  await mkdir(directory, { recursive: true });
  const claimPath = path.join(directory, `${config.mode}.claim.json`);
  try {
    await writeFile(claimPath, JSON.stringify({
      kind: 'nimbalyst-acceptance-fault',
      mode: config.mode,
      sessionId: safeReceiptSegment(sessionId),
      phase: 'claimed',
      timestamp: new Date().toISOString(),
    }, null, 2), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function recordAppliedOnDisk(
  config: AcceptanceFaultConfig,
  sessionId: string,
  details: Record<string, boolean>,
): Promise<void> {
  const directory = path.join(config.root, 'fault-receipts');
  await mkdir(directory, { recursive: true });
  const receiptPath = path.join(
    directory,
    `${config.mode}.applied.${safeReceiptSegment(sessionId)}.${randomUUID()}.json`,
  );
  await writeFile(receiptPath, JSON.stringify({
    kind: 'nimbalyst-acceptance-fault',
    mode: config.mode,
    sessionId: safeReceiptSegment(sessionId),
    phase: 'applied',
    timestamp: new Date().toISOString(),
    ...details,
  }, null, 2), { encoding: 'utf8', flag: 'wx' });
}

/**
 * Suppress one provider terminal only after MessageStreamingHandler has
 * consumed `turn_started` and durably attached its exact provider identity.
 * The durable claim makes the fault one-shot across a restart of the same
 * quarantine root.
 */
export async function* wrapProviderStreamForAcceptance(
  options: ProviderFaultOptions,
): AsyncGenerator<StreamChunk> {
  const env = options.env ?? process.env;
  if (env.NIMBALYST_TEST_ACCEPT !== '1') {
    yield* options.stream;
    return;
  }
  const config = resolveAcceptanceFault(env, options.userDataPath());
  if (
    !config ||
    (config.mode !== 'drop-terminal-after-final' && config.mode !== 'drop-terminal-without-final') ||
    !options.onTerminalSuppressed
  ) {
    yield* options.stream;
    return;
  }

  const claimFault = options.claimFault ?? claimFaultOnDisk;
  const recordApplied = options.recordApplied ?? recordAppliedOnDisk;
  let armed = false;
  let finalSuppressed = false;

  for await (const chunk of options.stream) {
    if (!armed && chunk.type === 'turn_started' && chunk.providerTurn?.threadId && chunk.providerTurn.turnId) {
      // Yield first. The consumer awaits its ownership CAS before asking this
      // generator for another chunk, so a successful claim below can only arm
      // after the provider identity is durable.
      yield chunk;
      armed = await claimFault(config, options.sessionId);
      continue;
    }

    if (!armed) {
      yield chunk;
      continue;
    }

    if (config.mode === 'drop-terminal-without-final' && chunk.type === 'text') {
      finalSuppressed = true;
      continue;
    }

    if (chunk.type === 'complete') {
      await recordApplied(config, options.sessionId, {
        finalSuppressed,
        terminalSuppressed: true,
      });
      await options.onTerminalSuppressed(config.mode);
      return;
    }

    yield chunk;
  }
}

/** Run one authoritative mutation while its exact session sync transport is
 * disconnected, then reconnect before downstream delivery continues. */
export async function withAcceptanceSyncDisconnect<T>(
  options: SyncFaultOptions<T>,
): Promise<T> {
  const env = options.env ?? process.env;
  if (env.NIMBALYST_TEST_ACCEPT !== '1') return options.run();
  const config = resolveAcceptanceFault(env, options.userDataPath());
  if (!config || config.mode !== 'sync-disconnect') return options.run();

  const claimFault = options.claimFault ?? claimFaultOnDisk;
  if (!await claimFault(config, options.sessionId)) return options.run();
  const provider = options.getSyncProvider();
  if (!provider || !provider.isConnected(options.sessionId)) {
    throw new Error('Acceptance sync-disconnect fault requires an active isolated sync session');
  }

  const recordApplied = options.recordApplied ?? recordAppliedOnDisk;
  provider.disconnect(options.sessionId);
  let mutationSucceeded = false;
  try {
    const result = await options.run();
    mutationSucceeded = true;
    return result;
  } finally {
    await provider.connect(options.sessionId);
    await recordApplied(config, options.sessionId, {
      disconnected: true,
      reconnected: true,
      mutationSucceeded,
    });
  }
}
