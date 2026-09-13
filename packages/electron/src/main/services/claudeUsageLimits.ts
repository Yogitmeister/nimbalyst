/**
 * Pure parsing helpers for the Claude usage API payload.
 *
 * Deliberately dependency-free: ClaudeUsageService reaches for electron, the
 * runtime's Claude config-dir resolvers, and the shell-environment manager, so
 * importing it just to exercise a pure reducer drags in the whole main-process
 * graph. Keeping the payload shape here lets the parsing rules be unit-tested
 * on their own.
 *
 * Guiding rule for everything below: this panel exists because a limit the user
 * was pinned against rendered as *nothing at all*. A limit we cannot fully
 * understand must therefore stay visible and be reported as unknown — never
 * silently coerced to zero and filtered out.
 */

export type ClaudeUsageSeverity = 'normal' | 'warning' | 'critical';

/**
 * A weekly limit that applies to one model rather than the whole account —
 * "Fable (Weekly)", "Opus (Weekly)", and whatever the API scopes next.
 *
 * These arrive in the `limits[]` array as `kind: "weekly_scoped"` entries
 * carrying `scope.model.display_name`. The older dedicated `seven_day_opus`
 * field is still in the payload but now reports `null`, so a client that only
 * reads that field silently shows no per-model limit at all.
 */
export interface ClaudeScopedLimit {
  /** Stable across polls: keyed on model identity, not array position. */
  id: string;
  /** Model display name, e.g. "Fable". */
  label: string;
  /**
   * 0-100, clamped. `null` means the API sent no usable `percent` — render it
   * as unknown rather than as 0%, which would hide a limit that may be full.
   */
  utilization: number | null;
  resetsAt: string | null;
  severity: ClaudeUsageSeverity;
  /** The API's own "you are being limited by this right now" flag. */
  isActive: boolean;
}

/** Entries we could not turn into a bar, kept so the caller can log them. */
export interface ClaudeScopedLimitDiscard {
  reason: 'no-model-name';
  kind: string | null;
  /** Present when the entry was scoped to something other than a model. */
  surfaceScoped: boolean;
}

export interface ClaudeScopedLimitParse {
  limits: ClaudeScopedLimit[];
  discarded: ClaudeScopedLimitDiscard[];
}

/** Shape of one entry in the usage API's `limits[]` array. */
interface RawUsageLimit {
  kind?: string;
  group?: string;
  percent?: unknown;
  severity?: unknown;
  resets_at?: string | null;
  is_active?: unknown;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: unknown;
  } | null;
}

interface RawUsagePayload {
  limits?: unknown;
  seven_day_opus?: { utilization?: unknown; resets_at?: string | null } | null;
}

const SEVERITY_RANK: Record<ClaudeUsageSeverity, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
};

function normalizeSeverity(value: unknown): ClaudeUsageSeverity | null {
  return typeof value === 'string' && value in SEVERITY_RANK
    ? (value as ClaudeUsageSeverity)
    : null;
}

/** Matches the popover's own colour thresholds. */
function severityFromUtilization(utilization: number): ClaudeUsageSeverity {
  if (utilization >= 80) return 'critical';
  if (utilization >= 50) return 'warning';
  return 'normal';
}

function worstSeverity(a: ClaudeUsageSeverity, b: ClaudeUsageSeverity): ClaudeUsageSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Accepts a number or a numeric string and clamps to 0-100. Anything else —
 * absent, null, NaN, a non-numeric string — is `null`, i.e. "unknown", never 0.
 */
function parsePercent(value: unknown): number | null {
  const raw = typeof value === 'string' ? Number(value) : value;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, raw));
}

/**
 * Resolve the severity we render with.
 *
 * The API grades these itself, so its verdict is the floor — but a payload that
 * reports `normal` alongside `percent: 95` should still read as critical, so we
 * take the worse of the two. An unknown percent is never "normal": it is at
 * least a warning, because it may be a limit that is already full.
 */
function resolveSeverity(apiSeverity: unknown, utilization: number | null): ClaudeUsageSeverity {
  const declared = normalizeSeverity(apiSeverity);
  if (utilization === null) return declared ?? 'warning';
  const derived = severityFromUtilization(utilization);
  return declared ? worstSeverity(declared, derived) : derived;
}

/**
 * Pull the per-model weekly limits out of a usage API response.
 *
 * Any entry scoped to a model counts, whatever `kind` the server calls it —
 * matching on `kind === 'weekly_scoped'` alone would silently drop every bar
 * the day the server renames it. Entries that are scoped to something we cannot
 * label are reported in `discarded` rather than dropped in silence.
 */
export function parseScopedLimits(data: unknown): ClaudeScopedLimitParse {
  const payload = (data ?? {}) as RawUsagePayload;
  const hasLimitsArray = Array.isArray(payload.limits);
  const rawLimits = hasLimitsArray ? (payload.limits as RawUsageLimit[]) : [];

  const limits: ClaudeScopedLimit[] = [];
  const discarded: ClaudeScopedLimitDiscard[] = [];
  const seenKeys = new Map<string, number>();

  for (const limit of rawLimits) {
    if (!limit?.scope) continue; // account-wide session / weekly rows
    const label = limit.scope.model?.display_name;
    if (typeof label !== 'string' || label.trim() === '') {
      // Scoped to *something* (a surface, a model the server did not name), so
      // it was meant to be shown. Surface it instead of pretending it was never
      // there.
      discarded.push({
        reason: 'no-model-name',
        kind: typeof limit.kind === 'string' ? limit.kind : null,
        surfaceScoped: limit.scope.surface != null,
      });
      continue;
    }

    const utilization = parsePercent(limit.percent);
    const key = limit.scope.model?.id || label.toLowerCase();
    const seen = (seenKeys.get(key) ?? 0) + 1;
    seenKeys.set(key, seen);

    limits.push({
      id: seen === 1 ? `weekly_scoped:${key}` : `weekly_scoped:${key}#${seen}`,
      label,
      utilization,
      resetsAt: limit.resets_at ?? null,
      severity: resolveSeverity(limit.severity, utilization),
      isActive: limit.is_active === true,
    });
  }

  // Only stand in for the legacy field when the server sent no `limits[]` at
  // all. Gating on "no scoped entries" instead would resurrect a stale Opus bar
  // on a current payload that legitimately has none.
  if (!hasLimitsArray) {
    const legacyOpus = payload.seven_day_opus;
    if (legacyOpus) {
      const utilization = parsePercent(legacyOpus.utilization);
      limits.push({
        id: 'weekly_scoped:opus:legacy',
        label: 'Opus',
        utilization,
        resetsAt: legacyOpus.resets_at ?? null,
        severity: resolveSeverity(undefined, utilization),
        isActive: false,
      });
    }
  }

  return { limits, discarded };
}

/** Convenience wrapper for callers that do not need the discard report. */
export function extractScopedLimits(data: unknown): ClaudeScopedLimit[] {
  return parseScopedLimits(data).limits;
}
