/**
 * Typed reasoning-control model (NIM-251).
 *
 * Wire-verified constraint (Temp/yogi_v0681/effort_wire_capture_findings.md,
 * CLI 2.1.202): the only reasoning axis the Claude Code CLI transport actually
 * carries is the effort ladder — CLAUDE_CODE_EFFORT_LEVEL env var →
 * `output_config.effort` in every emitted request, custom base URLs included.
 * Thinking rides `{type: "adaptive"}` unconditionally and budget tokens are
 * not emitted at all, so neither is modeled as a controllable axis here until
 * a transport exists that carries them.
 *
 * Validation is atomic and fail-closed: an invalid selection rejects the whole
 * update — no silent clamp, no partial apply, no fallback.
 */

import {
  DEFAULT_EFFORT_LEVEL,
  type EffortLevel,
  supportedEffortLevelsForModel,
} from '../../effortLevels';
import { resolveClaudeCodeBackend } from './customBackends';

/**
 * 'fixed'     — a concrete effort level is pinned (today's behavior).
 * 'auto'      — host-side per-turn policy picks the effort (defaults high).
 * 'auto-plus' — auto biased one level hotter ("sports mode").
 */
export type ReasoningMode = 'fixed' | 'auto' | 'auto-plus';

export const REASONING_MODES: readonly ReasoningMode[] = ['fixed', 'auto', 'auto-plus'];

export interface ReasoningCapabilities {
  /** Backend-declared effort vocabulary, ascending. Never assumed to be Claude's ladder. */
  effort?: {
    values: readonly string[];
    default: string;
    labels?: Readonly<Record<string, string>>;
  };
  /** Policy modes available for this model (requires an effort axis). */
  modes: readonly ReasoningMode[];
}

/** Atomic selection — validated as a whole against ReasoningCapabilities. */
export interface ReasoningSelection {
  /** Concrete effort value from the model's declared vocabulary (fixed mode). */
  effort?: string;
  /** Selection mode; omitted means 'fixed'. */
  mode?: ReasoningMode;
}

export type ReasoningValidation =
  | { ok: true; normalized: { mode: ReasoningMode; effort?: string } }
  | { ok: false; error: string };

/**
 * Declared reasoning capabilities for a resolved provider/model/backend combo.
 * Reads the same per-model ceiling data the effort selector uses, plus the
 * per-backend effort vocabulary for Claude-compatible backends.
 */
export function reasoningCapabilitiesForModel(
  provider: string | undefined,
  modelId: string | undefined | null,
  customBackendId?: string | undefined | null
): ReasoningCapabilities {
  const backend = resolveClaudeCodeBackend(customBackendId ?? undefined);
  if (backend?.effortValues && backend.effortValues.length > 0) {
    return {
      effort: {
        values: backend.effortValues,
        default: backend.effortValues.includes(DEFAULT_EFFORT_LEVEL)
          ? DEFAULT_EFFORT_LEVEL
          : backend.effortValues[backend.effortValues.length - 1],
      },
      modes: REASONING_MODES,
    };
  }

  const supported = supportedEffortLevelsForModel(modelId ?? undefined);
  if (supported.length === 0) {
    return { modes: ['fixed'] };
  }
  return {
    effort: {
      values: supported.map((l) => l.key),
      default: DEFAULT_EFFORT_LEVEL,
      ...(supported.some((l) => l.key === 'ultra') ? { labels: { ultra: 'Pro' } } : {}),
    },
    modes: REASONING_MODES,
  };
}

/**
 * Validate a ReasoningSelection against declared capabilities. Rejects the
 * ENTIRE selection on any invalid field — callers must not clamp or partially
 * apply a rejected selection.
 */
export function validateReasoningSelection(
  selection: ReasoningSelection,
  capabilities: ReasoningCapabilities
): ReasoningValidation {
  const mode: ReasoningMode = selection.mode ?? 'fixed';

  if (!REASONING_MODES.includes(mode)) {
    return { ok: false, error: `Unknown reasoning mode '${selection.mode}'. Valid modes: ${REASONING_MODES.join(', ')}.` };
  }
  if (!capabilities.modes.includes(mode)) {
    return { ok: false, error: `Reasoning mode '${mode}' is not supported for this model (supported: ${capabilities.modes.join(', ')}).` };
  }

  if (mode === 'auto' || mode === 'auto-plus') {
    if (selection.effort !== undefined) {
      return {
        ok: false,
        error: `Mode '${mode}' resolves effort per turn — do not pass a fixed 'effort' alongside it. Use mode 'fixed' with an effort value instead.`,
      };
    }
    if (!capabilities.effort) {
      return { ok: false, error: `Mode '${mode}' requires a model with an effort ladder; this model declares none.` };
    }
    return { ok: true, normalized: { mode } };
  }

  // fixed mode
  if (selection.effort === undefined) {
    return { ok: false, error: `Mode 'fixed' requires an 'effort' value (one of: ${capabilities.effort?.values.join(', ') ?? 'none available'}).` };
  }
  if (!capabilities.effort) {
    return { ok: false, error: 'This model declares no effort ladder; reasoning effort cannot be set for it.' };
  }
  if (!capabilities.effort.values.includes(selection.effort)) {
    return {
      ok: false,
      error: `Effort '${selection.effort}' is not supported for this model. Supported values: ${capabilities.effort.values.join(', ')}.`,
    };
  }
  return { ok: true, normalized: { mode: 'fixed', effort: selection.effort } };
}

/** The metadata.effortLevel value a normalized selection persists as. */
export function reasoningSelectionToStoredEffort(normalized: {
  mode: ReasoningMode;
  effort?: string;
}): string {
  if (normalized.mode === 'auto' || normalized.mode === 'auto-plus') return normalized.mode;
  return normalized.effort as EffortLevel;
}
