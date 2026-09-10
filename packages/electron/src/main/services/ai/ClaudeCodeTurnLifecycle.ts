// [ASTRA-ORCH]
import {
  isCatalogPersistedModelId,
  resolveClaudeCodeBackend,
  type AIProvider,
} from '@nimbalyst/runtime/ai/server';
import { CLAUDE_CODE_SAFE_FALLBACK_MODEL } from '@nimbalyst/runtime/ai/modelConstants';
import {
  type ProviderConfig,
  type SessionData,
} from '@nimbalyst/runtime/ai/server/types';
import {
  resolveEffortLevel,
  resolveThinkingMode,
} from '@nimbalyst/runtime/ai/server/effortLevels';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { getDefaultEffortLevel, getDefaultThinkingMode } from '../../utils/store';
import { resolveClaudeCodeSessionRoute } from './ClaudeCodeSessionRoute';

type ResumableProvider = AIProvider & {
  setProviderSessionData?: (
    sessionId: string,
    data: {
      providerSessionId: string;
      claudeSessionId: string;
      codexThreadId: string;
    },
  ) => void;
  getProviderSessionData?: (
    sessionId: string,
  ) => {
    providerSessionId?: string;
    claudeSessionId?: string;
  } | null;
};

/**
 * Reconstruct the current route identity before touching an agent provider or
 * restored provider-session id. Catalog-owned configurations carry no ambient
 * API key; ClaudeCodeProvider then resolves the one named reference itself.
 */
export async function buildClaudeCodeRuntimeConfigForTurn(
  session: SessionData,
  apiKey?: string,
  effectiveWorkspacePath?: string,
): Promise<ProviderConfig> {
  const snapshotModel = session.model || session.providerConfig?.model;
  const route = await resolveClaudeCodeSessionRoute(
    session.id,
    snapshotModel,
    session.metadata as Record<string, unknown> | undefined,
    () => AISessionsRepository.get(session.id),
  );
  const runtimeModel = route.model;
  const metadata = route.metadata;
  const backend = route.backend;
  const catalogOwned = runtimeModel
    ? isCatalogPersistedModelId(runtimeModel)
    : false;

  const nestedMetadata = metadata?.metadata as Record<string, unknown> | undefined;
  const legacyBackendId =
    (metadata?.claudeCodeBackend as string | undefined)
    ?? (nestedMetadata?.claudeCodeBackend as string | undefined);
  if (legacyBackendId) {
    const legacyBackend = resolveClaudeCodeBackend(legacyBackendId);
    if (!backend || legacyBackend?.persistedModel !== backend.persistedModel) {
      throw new Error(
        `Claude Code session ${session.id} has backend metadata without the matching canonical model identity`,
      );
    }
  }

  const effortLevel = catalogOwned
    ? undefined
    : resolveEffortLevel(metadata?.effortLevel, getDefaultEffortLevel());
  return {
    ...(route.workspacePath ?? session.workspacePath ?? effectiveWorkspacePath
      ? { workspacePath: route.workspacePath ?? session.workspacePath ?? effectiveWorkspacePath }
      : {}),
    maxTokens: (session.providerConfig as any)?.maxTokens,
    temperature: (session.providerConfig as any)?.temperature,
    ...(!catalogOwned && apiKey ? { apiKey } : {}),
    ...(effortLevel && { effortLevel }),
    ...(!catalogOwned
      ? { thinkingMode: resolveThinkingMode(metadata?.thinkingMode, getDefaultThinkingMode()) }
      : {}),
    ...(backend ? { claudeCodeBackend: backend.id } : {}),
    model: runtimeModel || CLAUDE_CODE_SAFE_FALLBACK_MODEL,
  };
}

/**
 * The lifecycle boundary: persisted identity and provider credential admission
 * must complete before a provider-side session restore can mutate state.
 */
export async function prepareClaudeCodeProviderTurn(
  provider: AIProvider,
  session: SessionData,
  buildRuntimeConfig: () => Promise<ProviderConfig>,
): Promise<ProviderConfig> {
  const config = await buildRuntimeConfig();
  await provider.initialize(config);

  if (session.providerSessionId) {
    const resumable = provider as ResumableProvider;
    if (!resumable.setProviderSessionData) {
      throw new Error(
        `[AIService] Claude Code provider cannot restore session ${session.id}`,
      );
    }
    resumable.setProviderSessionData(session.id, {
      providerSessionId: session.providerSessionId,
      claudeSessionId: session.providerSessionId,
      codexThreadId: session.providerSessionId,
    });
    const restored = resumable.getProviderSessionData?.(session.id);
    const restoredId = restored?.providerSessionId ?? restored?.claudeSessionId;
    if (restoredId !== session.providerSessionId) {
      throw new Error(
        `[AIService] Provider session restore failed for session ${session.id}: persisted provider identity did not survive restoration.`,
      );
    }
  }

  return config;
}
