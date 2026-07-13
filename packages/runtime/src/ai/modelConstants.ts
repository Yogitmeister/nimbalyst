/**
 * Shared AI model constants available across hosts.
 */

export interface ModelDefinition {
  id: string;
  displayName: string;
  shortName: string;
  maxTokens: number;
  contextWindow: number;
}

export const CLAUDE_MODELS: ModelDefinition[] = [
  {
    id: 'claude-fable-5',
    displayName: 'Claude Fable 5 (1M)',
    shortName: 'Fable 5',
    maxTokens: 8192,
    // Fable 5 is the tier above Opus — 1M context natively, dateless alias.
    contextWindow: 1000000,
  },
  {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8 (1M)',
    shortName: 'Opus 4.8',
    maxTokens: 8192,
    // Opus 4.8 ships with a 1M context window natively (no beta header).
    // The API alias is dateless and pinned to this snapshot — see
    // platform.claude.com/docs/en/about-claude/models/overview.
    contextWindow: 1000000,
  },
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7 (1M)',
    shortName: 'Opus 4.7',
    maxTokens: 8192,
    // Opus 4.7 uses the 1M context window natively — no beta header required
    // (unlike Opus 4.6 which needed `context-1m-2025-08-07`).
    contextWindow: 1000000,
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    shortName: 'Opus 4.6',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5 (1M)',
    shortName: 'Sonnet 5',
    maxTokens: 8192,
    // Sonnet 5 ships with a 1M context window natively (dateless alias, pinned
    // snapshot). Adaptive thinking only; rejects `temperature` (see
    // ClaudeProvider.supportsTemperature).
    contextWindow: 1000000,
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    shortName: 'Sonnet 4.6',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-opus-4-5-20251101',
    displayName: 'Claude Opus 4.5',
    shortName: 'Opus 4.5',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-opus-4-1-20250805',
    displayName: 'Claude Opus 4.1',
    shortName: 'Opus 4.1',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-opus-4-20250514',
    displayName: 'Claude Opus 4',
    shortName: 'Opus 4',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    displayName: 'Claude Sonnet 4.5',
    shortName: 'Sonnet 4.5',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    shortName: 'Sonnet 4',
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: 'claude-3-7-sonnet-20250219',
    displayName: 'Claude Sonnet 3.7',
    shortName: 'Sonnet 3.7',
    maxTokens: 8192,
    contextWindow: 200000,
  },
];

export const OPENAI_MODELS: ModelDefinition[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    shortName: '5.6 Sol',
    maxTokens: 128000,
    contextWindow: 372000,
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    shortName: '5.6 Terra',
    maxTokens: 128000,
    contextWindow: 372000,
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    shortName: '5.6 Luna',
    maxTokens: 128000,
    contextWindow: 372000,
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    shortName: '5.5',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    shortName: '5.4',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5.3-chat-latest',
    displayName: 'GPT-5.3 Chat',
    shortName: '5.3 Chat',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5.2',
    displayName: 'GPT-5.2',
    shortName: '5.2',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5.1',
    displayName: 'GPT-5.1',
    shortName: '5.1',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5',
    displayName: 'GPT-5',
    shortName: '5.0',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5-mini',
    displayName: 'GPT-5 Mini',
    shortName: '5 Mini',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-5-nano',
    displayName: 'GPT-5 Nano',
    shortName: '5 Nano',
    maxTokens: 128000,
    contextWindow: 400000,
  },
  {
    id: 'gpt-4.1',
    displayName: 'GPT-4.1',
    shortName: '4.1',
    maxTokens: 32768,
    contextWindow: 1047576,
  },
  {
    id: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 Mini',
    shortName: '4.1 Mini',
    maxTokens: 32768,
    contextWindow: 1047576,
  },
  {
    id: 'gpt-4.1-nano',
    displayName: 'GPT-4.1 Nano',
    shortName: '4.1 Nano',
    maxTokens: 32768,
    contextWindow: 1047576,
  },
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    shortName: '4o',
    maxTokens: 16384,
    contextWindow: 128000,
  },
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    shortName: '4o Mini',
    maxTokens: 16384,
    contextWindow: 128000,
  },
];

/**
 * Claude Code variant display metadata — single source of truth.
 *
 * Both the runtime (`ClaudeCodeProvider` — builds the model catalog that the
 * SDK consumes) and the renderer (`modelUtils.ts` — renders the session-chrome
 * label that shows which variant is active) must agree on these values.
 * Duplicating the table in both places caused the renderer indicator to
 * display a stale "Opus 4.6" after the runtime was bumped to 4.7.
 *
 * Two kinds of variants:
 * - Canonical variants (`opus`, `sonnet`, `haiku`) — the SDK resolves these
 *   to the latest underlying model. The version field is for display only.
 * - Pinned variants (`opus-4-6`, ...) — resolve according to the provider
 *   surface. The Agent SDK receives a full Anthropic model ID, while the
 *   interactive CLI keeps its independently supported command value.
 */
export type ClaudeCodeVariant = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'opus-4-7' | 'opus-4-6' | 'sonnet-4-6';
export type ClaudeCodeVariantInput = ClaudeCodeVariant | 'opus-4-8' | 'fable-5';

/**
 * Accepted input aliases for Claude Agent model identifiers.
 *
 * `opus-4-8` is intentionally accepted as an alias for the canonical `opus`
 * variant so legacy code paths (meta-agent, Agent tool, imported session IDs)
 * can request the current Opus generation explicitly without requiring a
 * duplicate visible picker entry. `fable-5` is accepted as an alias for
 * `fable` for the same reason.
 */
export const CLAUDE_CODE_ACCEPTED_VARIANT_INPUTS: readonly ClaudeCodeVariantInput[] = [
  'fable',
  'fable-5',
  'opus',
  'opus-4-8',
  'opus-4-7',
  'opus-4-6',
  'sonnet',
  'sonnet-4-6',
  'haiku',
] as const;

const CLAUDE_CODE_VARIANT_INPUT_MAP: Readonly<Record<ClaudeCodeVariantInput, ClaudeCodeVariant>> = {
  fable: 'fable',
  'fable-5': 'fable',
  opus: 'opus',
  'opus-4-8': 'opus',
  'opus-4-7': 'opus-4-7',
  'opus-4-6': 'opus-4-6',
  sonnet: 'sonnet',
  'sonnet-4-6': 'sonnet-4-6',
  haiku: 'haiku',
};

export function normalizeClaudeCodeVariant(variant: string): ClaudeCodeVariant | null {
  return CLAUDE_CODE_VARIANT_INPUT_MAP[variant.toLowerCase() as ClaudeCodeVariantInput] ?? null;
}

export const CLAUDE_CODE_VARIANT_VERSIONS: Record<ClaudeCodeVariant, string> = {
  fable: '5',
  opus: '4.8',
  sonnet: '5',
  haiku: '4.5',
  'opus-4-7': '4.7',
  'opus-4-6': '4.6',
  'sonnet-4-6': '4.6',
};

export const CLAUDE_CODE_MODEL_LABELS: Record<ClaudeCodeVariant, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  'opus-4-7': 'Opus',
  'opus-4-6': 'Opus',
  'sonnet-4-6': 'Sonnet',
};

export type ClaudeCodeProviderSurface = 'agent-sdk' | 'interactive-cli';

interface ClaudeCodeBaseCapability {
  /** Value passed to the surface before an optional `[1m]` suffix. */
  modelValue: string;
  /** Effective window for the unsuffixed value on this surface. */
  contextWindow: number;
  /** Whether Nimbalyst keeps an explicit `-1m` picker row for this variant. */
  supportsExplicit1M: boolean;
}

export interface ClaudeCodeModelCapability extends ClaudeCodeBaseCapability {
  key: string;
  surface: ClaudeCodeProviderSurface;
  variant: ClaudeCodeVariant;
  isExtendedContext: boolean;
}

const CONTEXT_200K = 200_000;
const CONTEXT_1M = 1_000_000;

/**
 * Path- and variant-aware Claude Code capability source of truth.
 *
 * Proven offline against the binaries shipped/installed on 2026-07-13:
 * Agent SDK 0.3.204 bundles Claude Code 2.1.204, and the independently installed
 * interactive CLI is 2.1.202. Both registries mark Fable 5, Opus 4.8/4.7, and
 * Sonnet 5 as native 1M models; older pinned models and Haiku remain 200K.
 * Surface identity still matters because the SDK and CLI accept different model
 * values even when their effective windows match. The CLI's retained pinned-Opus
 * rows route through its current `opus` alias, so their effective window follows
 * that alias without changing the saved picker IDs.
 */
export const CLAUDE_CODE_MODEL_CAPABILITIES: Readonly<
  Record<ClaudeCodeProviderSurface, Readonly<Record<ClaudeCodeVariant, ClaudeCodeBaseCapability>>>
> = {
  'agent-sdk': {
    fable: { modelValue: 'claude-fable-5', contextWindow: CONTEXT_1M, supportsExplicit1M: true },
    opus: { modelValue: 'opus', contextWindow: CONTEXT_1M, supportsExplicit1M: true },
    'opus-4-7': { modelValue: 'claude-opus-4-7', contextWindow: CONTEXT_1M, supportsExplicit1M: true },
    'opus-4-6': { modelValue: 'claude-opus-4-6', contextWindow: CONTEXT_200K, supportsExplicit1M: true },
    sonnet: { modelValue: 'sonnet', contextWindow: CONTEXT_1M, supportsExplicit1M: true },
    'sonnet-4-6': { modelValue: 'claude-sonnet-4-6', contextWindow: CONTEXT_200K, supportsExplicit1M: true },
    haiku: { modelValue: 'haiku', contextWindow: CONTEXT_200K, supportsExplicit1M: false },
  },
  'interactive-cli': {
    fable: { modelValue: 'fable', contextWindow: CONTEXT_1M, supportsExplicit1M: true },
    opus: { modelValue: 'opus', contextWindow: CONTEXT_1M, supportsExplicit1M: true },
    // Preserve the CLI's established alias routing for saved pinned-Opus rows.
    'opus-4-7': { modelValue: 'opus', contextWindow: CONTEXT_1M, supportsExplicit1M: true },
    'opus-4-6': { modelValue: 'opus', contextWindow: CONTEXT_1M, supportsExplicit1M: true },
    sonnet: { modelValue: 'sonnet', contextWindow: CONTEXT_1M, supportsExplicit1M: true },
    'sonnet-4-6': { modelValue: 'sonnet-4-6', contextWindow: CONTEXT_200K, supportsExplicit1M: true },
    haiku: { modelValue: 'haiku', contextWindow: CONTEXT_200K, supportsExplicit1M: false },
  },
};

const CLAUDE_CODE_FULL_MODEL_VARIANTS: Readonly<Record<string, ClaudeCodeVariant>> = {
  'claude-fable-5': 'fable',
  'claude-opus-4-8': 'opus',
  'claude-opus-4-7': 'opus-4-7',
  'claude-opus-4-6': 'opus-4-6',
  'claude-sonnet-5': 'sonnet',
  'claude-sonnet-4-6': 'sonnet-4-6',
  'claude-haiku-4-5': 'haiku',
  'claude-haiku-4-5-20251001': 'haiku',
};

/** Resolve a model/alias to the capability belonging to one provider surface. */
export function getClaudeCodeModelCapability(
  surface: ClaudeCodeProviderSurface,
  model: string,
  explicitContext?: boolean,
): ClaudeCodeModelCapability | null {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return null;

  const colonIndex = trimmed.indexOf(':');
  let raw = trimmed;
  if (colonIndex >= 0) {
    const provider = trimmed.slice(0, colonIndex);
    const expectedProvider = surface === 'agent-sdk' ? 'claude-code' : 'claude-code-cli';
    if (provider !== expectedProvider) return null;
    raw = trimmed.slice(colonIndex + 1);
  }

  const hasBracketContext = raw.endsWith('[1m]');
  const withoutBracketContext = raw.replace(/\[1m\]$/, '');
  const hasDashContext = withoutBracketContext.endsWith('-1m');
  const withoutContext = withoutBracketContext.replace(/-1m$/, '');
  const fullModelVariant = CLAUDE_CODE_FULL_MODEL_VARIANTS[withoutContext];
  const variant = normalizeClaudeCodeVariant(withoutContext)
    ?? fullModelVariant
    ?? null;
  if (!variant) return null;

  const base = CLAUDE_CODE_MODEL_CAPABILITIES[surface][variant];
  // Bare full model IDs remain full IDs on either surface. Their own model
  // definition supplies the window instead of inheriting a similarly named
  // picker route (important for pinned CLI models).
  const fullModelDefinition = fullModelVariant
    ? CLAUDE_MODELS.find((definition) => definition.id === withoutContext)
    : undefined;
  const baseModelValue = fullModelVariant ? withoutContext : base.modelValue;
  const baseContextWindow = fullModelVariant
    ? (fullModelDefinition?.contextWindow ?? CONTEXT_200K)
    : base.contextWindow;
  const isExtendedContext = explicitContext ?? (hasBracketContext || hasDashContext);
  return {
    ...base,
    key: `${surface}:${variant}:${baseModelValue}:${isExtendedContext ? 'explicit-1m' : 'base'}`,
    surface,
    variant,
    isExtendedContext,
    modelValue: isExtendedContext ? `${baseModelValue}[1m]` : baseModelValue,
    contextWindow: isExtendedContext ? CONTEXT_1M : baseContextWindow,
  };
}

/** Context window for a model on one surface, including accepted aliases. */
export function contextWindowForClaudeCodeModel(
  surface: ClaudeCodeProviderSurface,
  model: string | undefined,
): number | undefined {
  return model ? getClaudeCodeModelCapability(surface, model)?.contextWindow : undefined;
}

/** Compatibility export for code that needs the SDK's pinned base values. */
export const CLAUDE_CODE_PINNED_SDK_MODELS: Partial<Record<ClaudeCodeVariant, string>> =
  Object.fromEntries(
    Object.entries(CLAUDE_CODE_MODEL_CAPABILITIES['agent-sdk'])
      .filter(([variant, capability]) => capability.modelValue !== variant)
      .map(([variant, capability]) => [variant, capability.modelValue]),
  ) as Partial<Record<ClaudeCodeVariant, string>>;

/** Variants that retain an explicit 1M-context picker row. */
export const CLAUDE_CODE_VARIANTS_WITH_1M: readonly ClaudeCodeVariant[] =
  (Object.entries(CLAUDE_CODE_MODEL_CAPABILITIES['agent-sdk']) as Array<[
    ClaudeCodeVariant,
    ClaudeCodeBaseCapability,
  ]>)
    .filter(([, capability]) => capability.supportsExplicit1M)
    .map(([variant]) => variant);

/**
 * Safe silent fallback for the Claude Agent providers (#631 / NIM-848).
 *
 * Whenever a session's model is unexpectedly empty/lost, resolution must avoid
 * inventing an explicit `[1m]` modifier. The unsuffixed fallback may itself be
 * a native-1M model; this invariant is about preserving the base route, not
 * imposing an obsolete 200K cap or silently choosing a different variant.
 *
 * This is intentionally distinct from the user-facing default
 * (`DEFAULT_MODELS['claude-code']`, currently `opus-1m`): new installs may
 * still default to an explicit 1M row as a visible choice, while the invisible
 * fallback remains the unsuffixed canonical model.
 */
export const CLAUDE_CODE_SAFE_FALLBACK_MODEL = 'claude-code:opus' as const;

export const DEFAULT_MODELS = {
  claude: 'claude:claude-opus-4-8',
  openai: 'openai:gpt-5.6-sol',
  'claude-code': 'claude-code:opus-1m',
  'claude-code-cli': 'claude-code-cli:opus-1m',
  'openai-codex': 'openai-codex:gpt-5.6-sol',
  'openai-codex-acp': 'openai-codex-acp:gpt-5.6-sol',
  lmstudio: 'lmstudio:local-model',
  opencode: 'opencode:anthropic/claude-sonnet-4-5',
  'copilot-cli': 'copilot-cli:default',
};

/**
 * Curated preset list of models for the OpenCode agent.
 *
 * OpenCode itself uses `<providerID>/<modelID>` (e.g. `anthropic/claude-sonnet-4-5`).
 * In Nimbalyst's model registry we wrap that with the `opencode:` prefix so the
 * provider-router knows which agent to dispatch to. The OpenCode protocol layer
 * strips the prefix before forwarding to the SDK.
 *
 * Keep this list small -- OpenCode supports hundreds of models. These are the
 * defaults users see in the picker before they configure custom providers.
 */
export interface OpenCodePresetModel {
  /** Full id with the `opencode:` registry prefix. */
  id: string;
  /** Human-readable label shown in pickers. */
  name: string;
  /** OpenCode provider id (the segment before the `/`). */
  providerID: string;
  /** OpenCode model id (the segment after the `/`). */
  modelID: string;
}

export const OPENCODE_PRESET_MODELS: OpenCodePresetModel[] = [
  {
    id: 'opencode:anthropic/claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
  },
  {
    id: 'opencode:anthropic/claude-opus-4-1',
    name: 'Claude Opus 4.1',
    providerID: 'anthropic',
    modelID: 'claude-opus-4-1',
  },
  {
    id: 'opencode:openai/gpt-5',
    name: 'GPT-5',
    providerID: 'openai',
    modelID: 'gpt-5',
  },
  {
    id: 'opencode:openai/gpt-5-mini',
    name: 'GPT-5 Mini',
    providerID: 'openai',
    modelID: 'gpt-5-mini',
  },
  {
    id: 'opencode:google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    providerID: 'google',
    modelID: 'gemini-2.5-pro',
  },
  {
    id: 'opencode:zai/glm-5.2',
    name: 'GLM 5.2 (Z.AI)',
    providerID: 'zai',
    modelID: 'glm-5.2',
  },
  {
    id: 'opencode:zai-coding-plan/glm-5.2',
    name: 'GLM 5.2 (Z.AI Coding Plan)',
    providerID: 'zai-coding-plan',
    modelID: 'glm-5.2',
  },
];

/** OpenCode provider id reserved for an LM Studio bridge written into opencode.json. */
export const OPENCODE_LMSTUDIO_PROVIDER_ID = 'lmstudio';
