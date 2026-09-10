// [ASTRA-ORCH]
import {
  isCatalogPersistedModelId,
  resolveClaudeCodeBackendFromModel,
  type ClaudeCodeBackend,
} from '@nimbalyst/runtime/ai/server';
import { PROVIDER_RUNTIME_ROUTE_METADATA_KEY } from '@nimbalyst/runtime/ai/server/providers/claudeCode/providerRuntimeRoutePersistence';

export interface PersistedClaudeCodeRouteRow {
  model?: string | null;
  metadata?: unknown;
  workspacePath?: string;
}

export interface ResolvedClaudeCodeSessionRoute {
  model: string | undefined;
  metadata: Record<string, unknown> | undefined;
  backend: ClaudeCodeBackend | undefined;
  workspacePath: string | undefined;
}

type DurableRoutePart = {
  plan?: { model?: { persistedId?: unknown } };
  receipt?: {
    resolved?: { persistedModelId?: unknown };
    fallbackUsed?: unknown;
  };
};

function assertDurableRouteBundleMatchesModel(
  sessionId: string,
  model: string | undefined,
  metadata: Record<string, unknown> | undefined,
): void {
  const persisted = metadata?.[PROVIDER_RUNTIME_ROUTE_METADATA_KEY];
  if (persisted === undefined) return;
  if (typeof persisted !== 'object' || persisted === null || !model) {
    throw new Error(
      `Catalog-routed Claude Code session ${sessionId} has an invalid durable route snapshot`,
    );
  }

  for (const consumer of ['main', 'subagent', 'consultation'] as const) {
    const part = (persisted as Record<string, unknown>)[consumer] as DurableRoutePart | undefined;
    if (
      part?.plan?.model?.persistedId !== model ||
      part.receipt?.resolved?.persistedModelId !== model ||
      part.receipt?.fallbackUsed !== false
    ) {
      throw new Error(
        `Catalog-routed Claude Code session ${sessionId} durable ${consumer} route identity changed or is invalid`,
      );
    }
  }
}

/**
 * Re-read the persisted Claude Code identity before each fresh or restored
 * lifecycle preparation. Catalog-owned sessions never fall back to a stale
 * in-memory model when that read fails, disappears, or disagrees with the
 * durable route bundle.
 */
export async function resolveClaudeCodeSessionRoute(
  sessionId: string,
  snapshotModel: string | undefined,
  snapshotMetadata: Record<string, unknown> | undefined,
  loadPersisted: () => Promise<PersistedClaudeCodeRouteRow | null>,
): Promise<ResolvedClaudeCodeSessionRoute> {
  const snapshotBackend = resolveClaudeCodeBackendFromModel(snapshotModel);
  const snapshotCatalogModel = snapshotModel
    ? isCatalogPersistedModelId(snapshotModel)
    : false;
  let fresh: PersistedClaudeCodeRouteRow | null;
  try {
    fresh = await loadPersisted();
  } catch (error) {
    if (snapshotCatalogModel) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Catalog-routed Claude Code session ${sessionId} cannot refresh its persisted model identity: ${reason}`,
      );
    }
    return {
      model: snapshotModel,
      metadata: snapshotMetadata,
      backend: undefined,
      workspacePath: undefined,
    };
  }

  if (!fresh) {
    if (snapshotCatalogModel) {
      throw new Error(
        `Catalog-routed Claude Code session ${sessionId} has no persisted session row`,
      );
    }
    return {
      model: snapshotModel,
      metadata: snapshotMetadata,
      backend: undefined,
      workspacePath: undefined,
    };
  }

  const model = fresh.model || undefined;
  const backend = resolveClaudeCodeBackendFromModel(model);
  if (
    snapshotCatalogModel &&
    (model !== snapshotModel ||
      (snapshotBackend && backend?.persistedModel !== snapshotBackend.persistedModel))
  ) {
    throw new Error(
      `Catalog-routed Claude Code session ${sessionId} persisted model identity changed or was lost`,
    );
  }
  if (snapshotCatalogModel) {
    assertDurableRouteBundleMatchesModel(
      sessionId,
      model,
      fresh.metadata as Record<string, unknown> | undefined,
    );
  }

  return {
    model,
    metadata: fresh.metadata as Record<string, unknown> | undefined,
    backend,
    workspacePath: fresh.workspacePath,
  };
}
