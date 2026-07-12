/**
 * Effort level constants for adaptive reasoning (Opus 4.6 and Sonnet 4.6) and
 * for OpenAI Codex's reasoning-effort dial.
 * Matches the Claude Code CLI's /model effort slider and CLAUDE_CODE_EFFORT_LEVEL env var.
 *
 * Levels: low, medium, high (default), xhigh, max, ultra (Codex-only, shown to users as "Pro")
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const EFFORT_LEVELS: { key: EffortLevel; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'xhigh', label: 'xHigh' },
  { key: 'max', label: 'Max' },
  { key: 'ultra', label: 'Pro' },
];

export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'high';

const VALID_EFFORT_LEVELS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Known provider prefixes for Codex model ids, longest/most-specific first. */
const CODEX_PROVIDER_PREFIXES = ['openai-codex-acp:', 'openai-codex:'];

/** Exact Codex model ids whose catalog-declared ceiling is `ultra` ("Pro"). */
const CODEX_ULTRA_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra']);

/** Exact Codex model ids whose catalog-declared ceiling is `max`. */
const CODEX_MAX_MODELS = new Set(['gpt-5.6-luna']);

/**
 * Per-model effort ceiling — the single source of truth for which levels a
 * given model actually supports. Codex's own catalog declares a
 * `supported_reasoning_levels` list per model and the app-server rejects
 * requests above it rather than clamping: gpt-5.6-sol/terra go up to `ultra`
 * (the tier ChatGPT's web UI brands "Pro"), gpt-5.6-luna up to `max`, and
 * every OTHER Codex model — including unrecognized/future ids — stops at the
 * conservative established `xhigh` ceiling. Unknown ids are never assumed to
 * support `max`/`ultra`: only the exact catalog ids above do. The Claude Code
 * CLI's own effort slider tops out at `max` regardless of variant.
 *
 * Normalizes the optional provider prefix and compares the bare model id
 * against an exact allowlist — never a substring match — so both the
 * renderer's provider-prefixed id ("openai-codex:gpt-5.6-sol") and the bare
 * id the protocol layer dispatches ("gpt-5.6-sol") resolve correctly without
 * a lookalike future id (e.g. "gpt-5.6-solstice") inheriting Sol's ceiling.
 */
function effortCeiling(modelId: string | undefined | null): EffortLevel {
  const id = (modelId ?? '').toLowerCase();
  const prefix = CODEX_PROVIDER_PREFIXES.find(p => id.startsWith(p));
  const bareModel = prefix ? id.slice(prefix.length) : id;
  const isCodex = prefix != null || bareModel.startsWith('gpt-');
  if (!isCodex) return 'max';
  if (CODEX_ULTRA_MODELS.has(bareModel)) return 'ultra';
  if (CODEX_MAX_MODELS.has(bareModel)) return 'max';
  return 'xhigh';
}

/** The effort levels a given model actually supports, in ascending order. */
export function supportedEffortLevelsForModel(
  modelId: string | undefined | null
): { key: EffortLevel; label: string }[] {
  const ceiling = EFFORT_ORDER.indexOf(effortCeiling(modelId));
  return EFFORT_LEVELS.filter(l => EFFORT_ORDER.indexOf(l.key) <= ceiling);
}

/** Clamp a requested effort to the model's ceiling. Never upgrades. */
export function clampEffortForModel(
  modelId: string | undefined | null,
  effort: EffortLevel
): EffortLevel {
  const ceiling = EFFORT_ORDER.indexOf(effortCeiling(modelId));
  const requested = EFFORT_ORDER.indexOf(effort);
  return requested > ceiling ? EFFORT_ORDER[ceiling] : effort;
}

/**
 * Validate and return a valid EffortLevel, or the default if invalid.
 */
export function parseEffortLevel(value: unknown): EffortLevel {
  if (typeof value === 'string' && VALID_EFFORT_LEVELS.has(value)) {
    return value as EffortLevel;
  }
  return DEFAULT_EFFORT_LEVEL;
}

/**
 * The effort level a model picker/toolbar should display for a session: the
 * explicit per-session value if set, else the app-wide default, clamped to
 * what the given model actually supports. The toolbar must never claim a
 * stronger level than what dispatch will actually send — covers both a
 * stale per-session value surviving a model downgrade (e.g. Pro persisted
 * while on Sol, then the session switches to Luna) and a persisted app-wide
 * default of `ultra` viewed on a model that doesn't support it.
 */
export function effectiveEffortLevel(
  modelId: string | undefined | null,
  rawSessionEffortLevel: unknown,
  appDefaultEffortLevel: EffortLevel
): EffortLevel {
  const requested = rawSessionEffortLevel != null
    ? parseEffortLevel(rawSessionEffortLevel)
    : appDefaultEffortLevel;
  return clampEffortForModel(modelId, requested);
}

/**
 * Whether switching a session to `newModelId` should rewrite its persisted
 * per-session effort level, and to what. Returns null when there is nothing
 * to correct: no explicit per-session value was set (nothing is "stale" —
 * `effectiveEffortLevel` above already re-clamps against the new model on
 * every render) or the existing explicit value already fits the new model's
 * ceiling. Callers should only write back when this returns non-null, so a
 * session that was only ever following the app-wide default doesn't get
 * silently pinned to an explicit per-session value.
 */
export function effortLevelCorrectionForModelChange(
  newModelId: string | undefined | null,
  rawSessionEffortLevel: unknown
): EffortLevel | null {
  if (rawSessionEffortLevel == null) return null;
  const explicit = parseEffortLevel(rawSessionEffortLevel);
  const clamped = clampEffortForModel(newModelId, explicit);
  return clamped !== explicit ? clamped : null;
}

/**
 * Build the `sessions:update-metadata` IPC payload for a model change,
 * folding in an effort-level correction (if any) as ONE atomic update
 * instead of a separate follow-up call. A split model-then-effort
 * persistence sequence can leave the database on the new model with a
 * stale explicit effort value if the second call fails or races, even
 * though the UI (which re-clamps via `effectiveEffortLevel` on every
 * render) already looks correct. Returns a bare `{ model }` when there is
 * nothing to correct, so callers never send an empty `metadata` object.
 */
export function buildModelChangeMetadataUpdate(
  newModelId: string,
  rawSessionEffortLevel: unknown
): { model: string; metadata?: { effortLevel: EffortLevel } } {
  const correctedEffort = effortLevelCorrectionForModelChange(newModelId, rawSessionEffortLevel);
  return correctedEffort != null
    ? { model: newModelId, metadata: { effortLevel: correctedEffort } }
    : { model: newModelId };
}

/**
 * Resolve the effective effort level for a session.
 *
 * An explicit per-session value wins; otherwise we fall back to the app-wide
 * default that the UI effort selector displays. Without this fallback the
 * selector showed the app default (e.g. "Max") while the session silently ran
 * at the CLI's built-in "high", because the default was never written into
 * session metadata (GitHub #546).
 *
 * Returns undefined only when neither is set, so callers leave the CLI on its
 * own built-in default rather than forcing one.
 */
export function resolveEffortLevel(
  sessionEffortLevel: unknown,
  appDefaultEffortLevel: EffortLevel | undefined
): EffortLevel | undefined {
  if (sessionEffortLevel != null && sessionEffortLevel !== '') {
    return parseEffortLevel(sessionEffortLevel);
  }
  return appDefaultEffortLevel;
}
