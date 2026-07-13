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

/** Nimbalyst's effort-selection policy; independent of provider reasoning mode. */
export type EffortPolicy = 'fixed' | 'auto' | 'auto-plus';
export type ReasoningThinking = 'provider-default' | 'enabled' | 'disabled';

export const EFFORT_POLICIES: readonly EffortPolicy[] = ['fixed', 'auto', 'auto-plus'];

export interface ReasoningCapabilities {
  /** Backend-declared effort vocabulary, ascending. Never assumed to be Claude's ladder. */
  effort?: {
    values: readonly string[];
    default: string;
    labels?: Readonly<Record<string, string>>;
  };
  /** Provider-native reasoning modes, e.g. GPT-5.6 standard|pro. */
  mode?: {
    values: readonly string[];
    default: string;
  };
  /** Provider-native thinking toggle. Omitted when the transport cannot drive it. */
  thinking?: {
    values: readonly ReasoningThinking[];
    default: ReasoningThinking;
  };
  /** Provider-native reasoning budget. Omitted when the transport cannot drive it. */
  budgetTokens?: {
    min: number;
    max: number;
    default: number;
  };
  /** Host-side effort policies available for this model. */
  effortPolicies: readonly EffortPolicy[];
}

/** Atomic selection — validated as a whole against ReasoningCapabilities. */
export interface ReasoningSelection {
  thinking?: ReasoningThinking;
  /** Provider-native reasoning mode. This is never fixed/auto/auto-plus. */
  mode?: string;
  /** Concrete effort value from the model's declared vocabulary. */
  effort?: string;
  /** Host-side effort policy; omitted means fixed. */
  effortPolicy?: EffortPolicy;
  budgetTokens?: number;
}

export interface NormalizedReasoningSelection {
  thinking?: ReasoningThinking;
  mode?: string;
  effort?: string;
  effortPolicy: EffortPolicy;
  budgetTokens?: number;
}

export type ReasoningValidation =
  | { ok: true; normalized: NormalizedReasoningSelection }
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
  if (provider !== 'claude-code' && provider !== 'openai-codex') {
    return { effortPolicies: ['fixed'] };
  }

  const backend = resolveClaudeCodeBackend(customBackendId ?? undefined);
  if (customBackendId && !backend) {
    throw new Error(
      `Claude Agent backend '${customBackendId}' is stale or invalid. Select a current backend before changing reasoning controls.`
    );
  }
  const supportedValues = backend?.effortValues?.length
    ? backend.effortValues
    : supportedEffortLevelsForModel(modelId ?? undefined).map((l) => l.key);
  if (supportedValues.length === 0) return { effortPolicies: ['fixed'] };

  return {
    effort: {
      values: supportedValues,
      default: supportedValues.includes(DEFAULT_EFFORT_LEVEL)
        ? DEFAULT_EFFORT_LEVEL
        : supportedValues[supportedValues.length - 1],
    },
    // Today's transports keep thinking on their provider default. Advertising
    // only that neutral value makes the public shape transport-aware without
    // pretending enabled/disabled is drivable.
    thinking: { values: ['provider-default'], default: 'provider-default' },
    effortPolicies: EFFORT_POLICIES,
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
  const allowedKeys = new Set(['thinking', 'mode', 'effort', 'effortPolicy', 'budgetTokens']);
  const unknownKey = Object.keys(selection as Record<string, unknown>).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    return { ok: false, error: `Unknown reasoning field '${unknownKey}'; the selection was not applied.` };
  }
  const effortPolicy: EffortPolicy = selection.effortPolicy ?? 'fixed';
  if (!EFFORT_POLICIES.includes(effortPolicy)) {
    return { ok: false, error: `Unknown effort policy '${selection.effortPolicy}'. Valid policies: ${EFFORT_POLICIES.join(', ')}.` };
  }
  if (!capabilities.effortPolicies.includes(effortPolicy)) {
    return { ok: false, error: `Effort policy '${effortPolicy}' is not supported for this model.` };
  }

  let mode: string | undefined;
  if (selection.mode !== undefined) {
    if (!capabilities.mode?.values.includes(selection.mode)) {
      return {
        ok: false,
        error: `Provider reasoning mode '${selection.mode}' is not supported for this model (supported: ${capabilities.mode?.values.join(', ') || 'none'}).`,
      };
    }
    mode = selection.mode;
  } else {
    mode = capabilities.mode?.default;
  }

  let thinking: ReasoningThinking | undefined;
  if (selection.thinking !== undefined) {
    if (!capabilities.thinking?.values.includes(selection.thinking)) {
      return { ok: false, error: `Thinking '${selection.thinking}' is not supported by this transport.` };
    }
    thinking = selection.thinking;
  } else {
    thinking = capabilities.thinking?.default;
  }

  let budgetTokens: number | undefined;
  if (selection.budgetTokens !== undefined) {
    const budget = capabilities.budgetTokens;
    if (!budget) return { ok: false, error: 'This model/transport does not expose a reasoning token budget.' };
    if (!Number.isInteger(selection.budgetTokens) || selection.budgetTokens < budget.min || selection.budgetTokens > budget.max) {
      return { ok: false, error: `budgetTokens must be an integer from ${budget.min} to ${budget.max}.` };
    }
    budgetTokens = selection.budgetTokens;
  } else {
    budgetTokens = capabilities.budgetTokens?.default;
  }

  if (effortPolicy === 'auto' || effortPolicy === 'auto-plus') {
    if (selection.effort !== undefined) {
      return {
        ok: false,
        error: `Effort policy '${effortPolicy}' resolves effort per turn — do not pass a fixed 'effort' alongside it. Use effortPolicy 'fixed' instead.`,
      };
    }
    if (!capabilities.effort) {
      return { ok: false, error: `Effort policy '${effortPolicy}' requires a model with an effort ladder; this model declares none.` };
    }
    return { ok: true, normalized: { effortPolicy, ...(mode && { mode }), ...(thinking && { thinking }), ...(budgetTokens !== undefined && { budgetTokens }) } };
  }

  const effort = selection.effort ?? capabilities.effort?.default;
  if (effort === undefined && !capabilities.effort) {
    return { ok: true, normalized: { effortPolicy: 'fixed', ...(mode && { mode }), ...(thinking && { thinking }), ...(budgetTokens !== undefined && { budgetTokens }) } };
  }
  if (!capabilities.effort) {
    return { ok: false, error: 'This model declares no effort ladder; reasoning effort cannot be set for it.' };
  }
  if (!capabilities.effort.values.includes(effort as string)) {
    return {
      ok: false,
      error: `Effort '${effort}' is not supported for this model. Supported values: ${capabilities.effort.values.join(', ')}.`,
    };
  }
  return { ok: true, normalized: { effortPolicy: 'fixed', effort, ...(mode && { mode }), ...(thinking && { thinking }), ...(budgetTokens !== undefined && { budgetTokens }) } };
}

/** Flat metadata fields for the orthogonal provider-mode / effort-policy axes. */
export function reasoningSelectionToMetadata(
  normalized: NormalizedReasoningSelection,
  capabilities: ReasoningCapabilities,
): Record<string, unknown> {
  const storedEffort = normalized.effort ?? capabilities.effort?.default;
  return {
    ...(storedEffort && { effortLevel: storedEffort as EffortLevel }),
    effortPolicy: normalized.effortPolicy,
    ...(normalized.mode && { reasoningMode: normalized.mode }),
    ...(normalized.thinking && { reasoningThinking: normalized.thinking }),
    ...(normalized.budgetTokens !== undefined && { reasoningBudgetTokens: normalized.budgetTokens }),
  };
}
