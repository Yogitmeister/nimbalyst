/**
 * Host-side pre-dispatch reasoning policy — Auto / Auto+ effort modes.
 *
 * When a session's stored effort setting is 'auto' or 'auto-plus', the host
 * classifies each outgoing user turn BEFORE provider initialization and picks
 * a concrete effort level for that turn. The decision is turn-scoped: the
 * session's stored setting stays 'auto'/'auto-plus' (the user's dropdown never
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

import { clampEffortForModel, type EffortLevel } from './effortLevels';
import type { ReasoningMode } from './providers/claudeCode/reasoning';

export type ComplexityTier = 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';

export interface TurnEffortDecision {
  /** Concrete effort to run this turn at (already ceiling-clamped). */
  effort: EffortLevel | undefined;
  /** The stored mode the decision came from. */
  mode: ReasoningMode;
  /** Classifier tier — only present for auto modes with a classified prompt. */
  tier?: ComplexityTier;
  /**
   * 'fixed'   — stored concrete level / app default (pre-existing behavior)
   * 'policy'  — auto mode, classified this prompt
   * 'sticky'  — auto mode, no prompt available (config refresh) → last decision
   */
  source: 'fixed' | 'policy' | 'sticky';
}

interface PolicyState {
  lastEffort: EffortLevel;
  /** Consecutive low-signal turns — used to decay gradually, not instantly. */
  simpleStreak: number;
}

const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

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

export function classifyPrompt(text: string): PromptClassification {
  const trimmed = (text ?? '').trim();
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

function stepDownOne(from: EffortLevel, to: EffortLevel): EffortLevel {
  const fromIdx = EFFORT_ORDER.indexOf(from);
  const toIdx = EFFORT_ORDER.indexOf(to);
  if (toIdx >= fromIdx) return to;
  return EFFORT_ORDER[fromIdx - 1];
}

export function isAutoEffortSetting(value: unknown): value is 'auto' | 'auto-plus' {
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
  storedSetting: unknown;
  appDefault: EffortLevel | undefined;
  modelId?: string | null;
  promptText?: string;
}): TurnEffortDecision {
  const { sessionId, storedSetting, appDefault, modelId, promptText } = params;

  if (!isAutoEffortSetting(storedSetting)) {
    // Pre-existing fixed behavior: explicit per-session value wins, else the
    // app default; undefined leaves the CLI on its own default.
    const fixed =
      storedSetting != null && storedSetting !== '' && EFFORT_ORDER.includes(storedSetting as EffortLevel)
        ? (storedSetting as EffortLevel)
        : appDefault;
    return { effort: fixed, mode: 'fixed', source: 'fixed' };
  }

  const mode: ReasoningMode = storedSetting;
  const tierMap = mode === 'auto-plus' ? AUTO_PLUS_TIER_MAP : AUTO_TIER_MAP;
  const defaultEffort = mode === 'auto-plus' ? AUTO_PLUS_DEFAULT_EFFORT : AUTO_DEFAULT_EFFORT;
  const state = policyStates.get(sessionId);

  if (promptText === undefined) {
    const sticky = state?.lastEffort ?? defaultEffort;
    return { effort: clampEffortForModel(modelId, sticky), mode, source: 'sticky' };
  }

  const { tier, continuation } = classifyPrompt(promptText);
  const last = state?.lastEffort ?? defaultEffort;
  let target = tierMap[tier];

  if (continuation) {
    // Inherit the running level: a two-word "continue" carries no information
    // about the task's difficulty.
    target = last;
  } else if (EFFORT_ORDER.indexOf(target) < EFFORT_ORDER.indexOf(last)) {
    // Hysteresis: decay one level per turn instead of cliff-dropping — a hard
    // task's follow-up turns are usually still the hard task.
    target = stepDownOne(last, target);
  }

  const clamped = clampEffortForModel(modelId, target);
  policyStates.set(sessionId, {
    lastEffort: clamped,
    simpleStreak: tier === 'SIMPLE' ? (state?.simpleStreak ?? 0) + 1 : 0,
  });

  return { effort: clamped, mode, tier, source: 'policy' };
}

/** Test/lifecycle helper. */
export function resetReasoningPolicyState(sessionId?: string): void {
  if (sessionId) policyStates.delete(sessionId);
  else policyStates.clear();
}
