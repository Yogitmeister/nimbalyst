import {
  AI_PROVIDER_TYPES,
  ProviderFactory,
  type AIProvider,
  type AIProviderType,
} from '@nimbalyst/runtime/ai/server';
import { getTerminalSessionManager } from '../TerminalSessionManager';

export type NativeTurnCancellationOutcome =
  | { state: 'native-entered'; method: string; settleLifecycle?: boolean }
  | { state: 'proven-no-owner'; method: string }
  | { state: 'unknown'; error: string };

export interface QueuedTurnCancellationTarget {
  generation: string;
  isCurrent(): boolean;
}

export type NativeCancellationMode = 'abort' | 'interrupt';

export type NativeSessionOwner =
  | {
      id: string;
      kind: 'provider';
      providerType: string;
      provider: AIProvider;
    }
  | {
      id: 'terminal';
      kind: 'terminal';
    };

export interface NativeSessionOwnerCensus {
  owners: NativeSessionOwner[];
  failures: string[];
}

export function inspectNativeSessionOwners(sessionId: string): NativeSessionOwnerCensus {
  const owners: NativeSessionOwner[] = [];
  const failures: string[] = [];

  for (const providerType of AI_PROVIDER_TYPES) {
    try {
      const provider = ProviderFactory.getProvider(providerType as AIProviderType, sessionId);
      if (provider) {
        owners.push({
          id: `built-in:${providerType}`,
          kind: 'provider',
          providerType,
          provider,
        });
      }
    } catch (error) {
      failures.push(
        `built-in:${providerType}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    // Ground truth is the live provider cache, not the current
    // AgentProviderRegistry catalog: a provider created while its
    // contribution was registered can outlive that registry entry (the
    // extension is disabled or uninstalled mid-turn), and a catalog walk
    // would silently miss it. See NIM-590 batch item 5.
    for (const entry of ProviderFactory.listExtensionAgentProvidersForSession(sessionId)) {
      owners.push({
        id: `extension:${entry.extensionId}/${entry.contributionId}`,
        kind: 'provider',
        providerType: entry.contributionId,
        provider: entry.provider,
      });
    }
  } catch (error) {
    failures.push(
      `extension-registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    if (getTerminalSessionManager().isTerminalActive(sessionId)) {
      owners.push({ id: 'terminal', kind: 'terminal' });
    }
  } catch (error) {
    failures.push(`terminal: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { owners, failures };
}

/**
 * Enumerate every native owner registry for a session. Repository metadata is
 * deliberately not part of this proof: a stale/missing row cannot hide a live
 * built-in provider, extension contribution, or PTY process.
 */
export function censusNativeSessionOwners(sessionId: string): NativeSessionOwner[] {
  return inspectNativeSessionOwners(sessionId).owners;
}

/**
 * Enter cancellation for every owner captured by one census. A multi-owner
 * session is safe only when every owner accepted native cancellation. Failures
 * are accumulated so one broken provider never prevents the remaining owners
 * from being addressed, but any incomplete entry quarantines the generation.
 */
export async function cancelAllNativeSessionOwners(
  sessionId: string,
  target: QueuedTurnCancellationTarget,
  mode: NativeCancellationMode,
): Promise<NativeTurnCancellationOutcome> {
  const { owners, failures: censusFailures } = inspectNativeSessionOwners(sessionId);
  if (owners.length === 0 && censusFailures.length === 0) {
    return { state: 'proven-no-owner', method: 'all-native-owner-registries-empty' };
  }

  const enteredMethods: string[] = [];
  const failures = [...censusFailures];
  let interruptNeedsNativeSettlement = false;

  for (const owner of owners) {
    if (!target.isCurrent()) {
      failures.push(`${owner.id}: cancellation generation ${target.generation} is stale`);
      break;
    }

    try {
      if (owner.kind === 'terminal') {
        getTerminalSessionManager().writeToTerminal(sessionId, '\x03');
        enteredMethods.push('terminal:ctrl-c');
        if (mode === 'interrupt') interruptNeedsNativeSettlement = true;
        continue;
      }

      if (mode === 'interrupt') {
        const result = await owner.provider.interruptCurrentTurn();
        enteredMethods.push(`${owner.id}:${result.method}`);
        if (result.hadActiveTurn !== false) interruptNeedsNativeSettlement = true;
      } else {
        owner.provider.abort();
        enteredMethods.push(`${owner.id}:abort`);
      }
    } catch (error) {
      failures.push(
        `${owner.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0 || enteredMethods.length !== owners.length) {
    return {
      state: 'unknown',
      error: `native cancellation entered ${enteredMethods.length}/${owners.length} owner(s); ${failures.join('; ')}`,
    };
  }

  return {
    state: 'native-entered',
    method: enteredMethods.join(','),
    // Hard cancel callers explicitly request local settlement. Ordinary
    // interrupt lets a live provider/PTY completion own settlement, while an
    // exact no-active-turn result permits local zombie repair.
    settleLifecycle: mode === 'abort' || !interruptNeedsNativeSettlement,
  };
}
