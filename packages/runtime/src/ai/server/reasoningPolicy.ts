/**
 * Host-side pre-dispatch reasoning policy — Auto / Auto+ effort modes.
 *
 * When a session's stored effortPolicy is 'auto' or 'auto-plus', the host
 * classifies each outgoing user turn BEFORE provider initialization and picks
 * a concrete effort level for that turn. The decision is turn-scoped: the
 * session's stored effortPolicy stays 'auto'/'auto-plus' (the user's dropdown never
 * flaps), and the per-turn resolution is surfaced separately (indicator +
 * metadata.autoEffortLast + launch/MCP payloads).
 *
 * This is deliberately NOT an agent calling a tool on itself to raise its own
 * effort and restore it afterwards — that set/restore pattern is a race. The
 * policy runs in the host, on the turn boundary, every turn.
 *
 * Classifier: a TypeScript reimplementation of the scoring idea in LiteLLM's
 * `complexity_router` strategy (MIT; rule-based, 7 signal groups, 4 tiers,
 * "2+ reasoning markers force the top tier"), remapped from model-routing to
 * effort selection. Deterministic, zero external calls, O(prompt length).
 */

import type { EffortLevel } from './effortLevels';
import {
  reasoningCapabilitiesForModel,
  type ReasoningCapabilities,
  type EffortPolicy,
} from './providers/claudeCode/reasoning';

export type ComplexityTier = 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';

export interface TurnEffortDecision {
  /** Concrete effort to run this turn at, drawn from the target's declared ladder. */
  effort: string | undefined;
  /** The stored mode the decision came from. */
  effortPolicy: EffortPolicy;
  /** Classifier tier — only present for auto modes with a classified prompt. */
  tier?: ComplexityTier;
  /**
   * 'fixed'   — stored concrete level / app default (pre-existing behavior)
   * 'policy'  — auto mode, classified this prompt
   * 'sticky'  — auto mode, no prompt available (config refresh) → last decision
   */
  source: 'fixed' | 'policy' | 'sticky';
  /** Whether this classified turn moved upward from the prior sticky decision. */
  escalated?: boolean;
  /** The target ladder used for validation/resolution, ascending. */
  effortValues?: readonly string[];
}

interface PolicyState {
  lastEffort: string;
  effortPolicy: 'auto' | 'auto-plus';
  lastUsedAt: number;
}

const POLICY_TARGETS: EffortLevel[] = ['medium', 'high', 'xhigh', 'max'];
const MAX_POLICY_STATES = 500;
const POLICY_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLASSIFIER_CHARS = 8_000;

/** Yogev's spec: Auto defaults high and moves per turn; Auto+ runs one level hotter. */
const AUTO_TIER_MAP: Record<ComplexityTier, EffortLevel> = {
  SIMPLE: 'medium',
  MEDIUM: 'high',
  COMPLEX: 'xhigh',
  REASONING: 'max',
};
const AUTO_PLUS_TIER_MAP: Record<ComplexityTier, EffortLevel> = {
  SIMPLE: 'high',
  MEDIUM: 'xhigh',
  COMPLEX: 'max',
  REASONING: 'max',
};
const AUTO_DEFAULT_EFFORT: EffortLevel = 'high';
const AUTO_PLUS_DEFAULT_EFFORT: EffortLevel = 'xhigh';

const policyStates = new Map<string, PolicyState>();

const REASONING_MARKERS = [
  'why', 'prove', 'derive', 'root cause', 'root-cause', 'debug', 'diagnose',
  'architect', 'design', 'trade-off', 'tradeoff', 'analyze', 'analyse',
  'compare', 'evaluate', 'optimi', 'refactor', 'step by step', 'step-by-step',
  'reason', 'think through', 'edge case', 'edge-case', 'race condition',
  'security', 'vulnerab', 'algorithm', 'complexity', 'strategy', 'plan out',
];

const SIMPLE_INDICATORS = [
  'hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay', 'yes', 'no',
  'got it', 'sounds good', 'great', 'nice', 'cool', 'sure',
];

const MULTI_STEP_PATTERNS = [
  /\b(then|after that|next,|finally|first\b.*\bsecond)/i,
  /^\s*\d+[.)]\s/m,
  /^\s*[-*]\s/m,
];

const TECHNICAL_TERMS = [
  'api', 'endpoint', 'schema', 'database', 'sql', 'migration', 'deploy',
  'docker', 'kubernetes', 'regex', 'async', 'thread', 'mutex', 'cache',
  'compiler', 'typescript', 'python', 'rust', 'protocol', 'encryption',
  'oauth', 'webhook', 'pipeline', 'ci/cd', 'test', 'build', 'commit',
];

export interface PromptClassification {
  tier: ComplexityTier;
  /** True for short, low-signal follow-ups ("continue", "yes") that should inherit the running effort. */
  continuation: boolean;
}

/**
 * Keep the classifier on the user-authored segment. Nimbalyst may append
 * system/document/attachment wrappers to messages on some transport paths;
 * those blocks are useful provider context but must not be able to pump spend.
 */
export function sanitizePromptForReasoningPolicy(text: string): string {
  let sanitized = text ?? '';
  const wrappedBlocks = [
    'NIMBALYST_SYSTEM_MESSAGE',
    'DOCUMENT_CONTENT',
    'NIMBALYST_ATTACHMENT',
    'ATTACHMENT',
    'FILE_CONTENT',
  ];
  for (const tag of wrappedBlocks) {
    sanitized = sanitized.replace(
      new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi'),
      ' '
    );
  }
  return sanitized.slice(0, MAX_CLASSIFIER_CHARS).trim();
}

export function classifyPrompt(text: string): PromptClassification {
  const trimmed = sanitizePromptForReasoningPolicy(text);
  const lower = trimmed.toLowerCase();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const hasCode = /```|[{};]\s*$|\bfunction\b|\bconst\b|=>|\bimport\b|\bclass\b/m.test(trimmed);
  const reasoningHits = REASONING_MARKERS.filter((m) => lower.includes(m)).length;
  const multiStep = MULTI_STEP_PATTERNS.some((p) => p.test(trimmed));
  const technicalHits = TECHNICAL_TERMS.filter((t) => lower.includes(t)).length;
  const questionCount = (trimmed.match(/\?/g) ?? []).length;
  const deepQuestion = /\b(how|why)\b/i.test(trimmed) && questionCount > 0;
  const isSimplePhrase =
    wordCount <= 4 && SIMPLE_INDICATORS.some((s) => lower === s || lower.startsWith(s + ' ') || lower.startsWith(s + ','));

  // Low-signal follow-up: too short to judge, no hard signals — the ongoing
  // task's difficulty lives in prior turns, not in "continue"/"go ahead".
  const continuation =
    wordCount < 8 && !hasCode && reasoningHits === 0 && !isSimplePhrase && wordCount > 0;

  // Hard override, from the LiteLLM strategy: 2+ reasoning markers = top tier.
  if (reasoningHits >= 2) {
    return { tier: 'REASONING', continuation: false };
  }

  let score = 0;
  if (wordCount > 150) score += 2;
  else if (wordCount > 60) score += 1;
  if (hasCode) score += 2;
  score += reasoningHits * 2;
  if (multiStep) score += 1;
  score += Math.min(technicalHits, 3);
  if (deepQuestion) score += 1;
  if (questionCount >= 3) score += 1;
  if (isSimplePhrase) score -= 3;

  let tier: ComplexityTier;
  if (score <= 0) tier = 'SIMPLE';
  else if (score <= 2) tier = 'MEDIUM';
  else if (score <= 5) tier = 'COMPLEX';
  else tier = 'REASONING';

  return { tier, continuation };
}

function projectPolicyTarget(target: EffortLevel, values: readonly string[]): string {
  if (values.includes(target)) return target;
  if (values.length === 1) return values[0];
  const targetIndex = Math.max(0, POLICY_TARGETS.indexOf(target));
  const projectedIndex = Math.round((targetIndex / (POLICY_TARGETS.length - 1)) * (values.length - 1));
  return values[projectedIndex];
}

function stepDownOne(from: string, to: string, values: readonly string[]): string {
  const fromIdx = values.indexOf(from);
  const toIdx = values.indexOf(to);
  if (fromIdx <= 0 || toIdx < 0 || toIdx >= fromIdx) return to;
  return values[fromIdx - 1];
}

function prunePolicyStates(now: number): void {
  for (const [sessionId, state] of policyStates) {
    if (now - state.lastUsedAt > POLICY_STATE_TTL_MS) policyStates.delete(sessionId);
  }
  while (policyStates.size >= MAX_POLICY_STATES) {
    const oldest = policyStates.keys().next().value as string | undefined;
    if (!oldest) break;
    policyStates.delete(oldest);
  }
}

export function defaultEffortForPolicy(
  effortPolicy: EffortPolicy,
  capabilities: ReasoningCapabilities
): string | undefined {
  const values = capabilities.effort?.values;
  if (!values?.length) return undefined;
  if (effortPolicy === 'fixed') return capabilities.effort?.default;
  const target = effortPolicy === 'auto-plus' ? AUTO_PLUS_DEFAULT_EFFORT : AUTO_DEFAULT_EFFORT;
  return projectPolicyTarget(target, values);
}

export function isAutoEffortPolicy(value: unknown): value is 'auto' | 'auto-plus' {
  return value === 'auto' || value === 'auto-plus';
}

/**
 * Resolve the concrete effort for a turn.
 *
 * - Fixed settings pass through untouched (source 'fixed').
 * - Auto modes with a prompt classify it, apply hysteresis (upward jumps are
 *   immediate; downward moves step one level per turn; low-signal follow-ups
 *   inherit the running level), clamp to the model ceiling, and record the
 *   session's sticky state (source 'policy').
 * - Auto modes without a prompt (settings-refresh paths that run off-turn)
 *   reuse the sticky state without mutating it (source 'sticky').
 */
export function resolveEffortForTurn(params: {
  sessionId: string;
  storedEffort: unknown;
  storedEffortPolicy: unknown;
  appDefault: EffortLevel | undefined;
  provider?: string;
  modelId?: string | null;
  customBackendId?: string | null;
  promptText?: string;
}): TurnEffortDecision {
  const {
    sessionId,
    storedEffort,
    storedEffortPolicy,
    appDefault,
    provider,
    modelId,
    customBackendId,
    promptText,
  } = params;
  const capabilities = reasoningCapabilitiesForModel(provider, modelId, customBackendId);
  const values = capabilities.effort?.values ?? [];

  if (!isAutoEffortPolicy(storedEffortPolicy)) {
    policyStates.delete(sessionId);
    // Pre-existing fixed behavior: explicit per-session value wins, else the
    // app default; undefined leaves the CLI on its own default.
    const requested =
      storedEffort != null && storedEffort !== ''
        ? String(storedEffort)
        : appDefault;
    if (requested !== undefined && !values.includes(requested)) {
      throw new Error(
        `Effort '${requested}' is not supported for this model/backend. Supported values: ${values.join(', ') || 'none'}.`
      );
    }
    return { effort: requested, effortPolicy: 'fixed', source: 'fixed', effortValues: values };
  }

  const effortPolicy: EffortPolicy = storedEffortPolicy;
  const tierMap = effortPolicy === 'auto-plus' ? AUTO_PLUS_TIER_MAP : AUTO_TIER_MAP;
  const defaultEffort = defaultEffortForPolicy(effortPolicy, capabilities);
  if (!defaultEffort || values.length === 0) {
    throw new Error(`Effort policy '${effortPolicy}' requires a model/backend with an effort ladder.`);
  }
  const now = Date.now();
  prunePolicyStates(now);
  const priorState = policyStates.get(sessionId);
  const state = priorState?.effortPolicy === effortPolicy ? priorState : undefined;

  if (promptText === undefined) {
    const sticky = state?.lastEffort ?? defaultEffort;
    return { effort: sticky, effortPolicy, source: 'sticky', effortValues: values };
  }

  const { tier, continuation } = classifyPrompt(promptText);
  const last = state?.lastEffort ?? defaultEffort;
  let target = projectPolicyTarget(tierMap[tier], values);
  const lastIndex = values.indexOf(last);

  if (continuation) {
    // Inherit the running level: a two-word "continue" carries no information
    // about the task's difficulty.
    target = last;
  } else if (values.indexOf(target) < lastIndex) {
    // Hysteresis: decay one level per turn instead of cliff-dropping — a hard
    // task's follow-up turns are usually still the hard task.
    target = stepDownOne(last, target, values);
  }

  const targetIndex = values.indexOf(target);
  const escalated = lastIndex >= 0 && targetIndex > lastIndex;
  policyStates.delete(sessionId);
  policyStates.set(sessionId, {
    lastEffort: target,
    effortPolicy,
    lastUsedAt: now,
  });

  return {
    effort: target,
    effortPolicy,
    tier,
    source: 'policy',
    escalated,
    effortValues: values,
  };
}

/** Test/lifecycle helper. */
export function resetReasoningPolicyState(sessionId?: string): void {
  if (sessionId) policyStates.delete(sessionId);
  else policyStates.clear();
}
