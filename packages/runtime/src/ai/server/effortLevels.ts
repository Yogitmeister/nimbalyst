/**
 * Effort level constants for adaptive reasoning (Opus 4.6 and Sonnet 4.6).
 * Matches the Claude Code CLI's /model effort slider and CLAUDE_CODE_EFFORT_LEVEL env var.
 *
 * Levels: low, medium, high (default), xhigh, max
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const EFFORT_LEVELS: { key: EffortLevel; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'xhigh', label: 'xHigh' },
  { key: 'max', label: 'Max' },
  { key: 'ultra', label: 'Ultra' },
];

export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'high';

const VALID_EFFORT_LEVELS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * Per-model effort ceilings, from each provider's own catalog rather than one
 * global ladder. Codex's embedded catalog (verified live 2026-07-10) declares
 * `supported_reasoning_levels` per model: gpt-5.6-sol/terra go up to `ultra`
 * ("maximum reasoning with automatic task delegation" — what ChatGPT's web UI
 * brands "Pro"), gpt-5.6-luna up to `max`, and every pre-5.6 Codex model stops
 * at `xhigh` (the codex backend errors above a model's ceiling rather than
 * clamping). Claude Code's CLI effort slider tops out at `max`.
 */
const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function effortCeiling(modelId: string | undefined | null): EffortLevel {
  const id = (modelId ?? '').toLowerCase();
  const isCodex = id.includes('openai-codex') || id.startsWith('gpt-');
  if (isCodex) {
    if (id.includes('gpt-5.6-sol') || id.includes('gpt-5.6-terra')) return 'ultra';
    if (id.includes('gpt-5.6')) return 'max';
    return 'xhigh';
  }
  return 'max';
}

/** The effort levels a given model actually supports, in ascending order. */
export function supportedEffortLevelsForModel(
  modelId: string | undefined | null
): { key: EffortLevel; label: string }[] {
  const ceiling = EFFORT_ORDER.indexOf(effortCeiling(modelId));
  return EFFORT_LEVELS.filter(l => EFFORT_ORDER.indexOf(l.key) <= ceiling);
}

/** Clamp a requested effort to the model's ceiling (never upgrades). */
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
