// [ASTRA-ORCH]
import { CLAUDE_CODE_VARIANTS, ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { listLaunchableCatalogRoutes } from '@nimbalyst/runtime/ai/server';

/**
 * The full set of shipped Claude Code model ids: the base variants from
 * `CLAUDE_CODE_VARIANTS`, plus every catalog route that can open a lead
 * session. This is the canonical enabled list for a fresh install, and the
 * catalog the saved allow-list is reconciled against — so a newly-added model
 * can never be silently dropped from the picker again (the drift that hid
 * Fable 5 and sonnet-4-6).
 *
 * It reads the catalog, not the legacy `CLAUDE_CODE_BACKENDS` projection:
 * that projection only accepted local-proxy routes, so direct-API brains would
 * be exported by the provider and then filtered straight back out by an
 * existing install's exclusive allow-list. Both gates have to agree.
 *
 * The catalog routes belong here for the same reason the variants do. They are
 * `claude-code` picker rows, an explicit allow-list is exclusive, and there is
 * no per-model UI to re-enable one — so without this an existing install never
 * sees a newly-shipped brain swap.
 */
export function claudeCodeCatalogModelIds(): string[] {
  return [
    ...CLAUDE_CODE_VARIANTS.map((v) => ModelIdentifier.create('claude-code', v).combined),
    ...listLaunchableCatalogRoutes().map((entry) => entry.model.persistedId),
  ];
}

/** Default enabled claude-code models for a fresh install (whole catalog). */
export const DEFAULT_CLAUDE_CODE_MODELS: string[] = claudeCodeCatalogModelIds();

export interface ReconcileResult {
  /** The user's allow-list after back-filling any newly-shipped variants. */
  models: string[];
  /** The snapshot of variants to persist as "known" for next reconciliation. */
  known: string[];
  /** Whether `models` changed (i.e. a write is needed). */
  changed: boolean;
}

/**
 * Reconcile a user's saved claude-code allow-list against the shipped catalog.
 *
 * Any catalog variant not present in `known` (the persisted snapshot of variants
 * we've reconciled before) is treated as newly-shipped and enabled by default.
 * Variants already in `known` are left untouched, so a deliberate user opt-out is
 * never re-enabled.
 *
 * First run on an existing install (`known` undefined) treats everything the user
 * doesn't already have as new — this is what back-fills variants (fable,
 * sonnet-4-6) that shipped before this reconciliation existed. This matches the
 * intent of the previous per-variant insertion migrations.
 */
export function reconcileClaudeCodeModels(
  current: string[],
  known: string[] | undefined,
  catalog: string[] = claudeCodeCatalogModelIds(),
): ReconcileResult {
  const knownSet = new Set(known ?? []);
  const currentSet = new Set(current);
  const additions = catalog.filter((id) => !knownSet.has(id) && !currentSet.has(id));
  // Remember the union so a variant later dropped from the catalog isn't treated
  // as brand new if it returns.
  const nextKnown = Array.from(new Set([...(known ?? []), ...catalog]));
  return {
    models: additions.length > 0 ? [...current, ...additions] : current,
    known: nextKnown,
    changed: additions.length > 0,
  };
}
