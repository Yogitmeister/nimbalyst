import { describe, it, expect } from 'vitest';
import {
  resolveEffortLevel,
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  parseEffortLevel,
  clampEffortForModel,
  supportedEffortLevelsForModel,
  effectiveEffortLevel,
  effortLevelCorrectionForModelChange,
  buildModelChangeMetadataUpdate,
} from '../effortLevels';

describe('resolveEffortLevel', () => {
  it('uses the explicit per-session effort when set', () => {
    expect(resolveEffortLevel('low', 'max')).toBe('low');
    expect(resolveEffortLevel('high', 'max')).toBe('high');
  });

  it('falls back to the app default when the session has no effort', () => {
    // The selector displays the app default but never writes it to session
    // metadata; the effective effort must follow that default (GitHub #546).
    expect(resolveEffortLevel(undefined, 'max')).toBe('max');
    expect(resolveEffortLevel(null, 'xhigh')).toBe('xhigh');
    expect(resolveEffortLevel('', 'max')).toBe('max');
  });

  it('returns undefined when neither session nor app default is set', () => {
    expect(resolveEffortLevel(undefined, undefined)).toBeUndefined();
    expect(resolveEffortLevel(null, undefined)).toBeUndefined();
  });

  it('coerces an invalid stored session value to the default level', () => {
    expect(resolveEffortLevel('bogus', 'max')).toBe(DEFAULT_EFFORT_LEVEL);
  });
});

describe('ultra effort level (Codex 5.6 Sol/Terra, shown to users as "Pro")', () => {
  it('parses ultra as a valid level', () => {
    expect(parseEffortLevel('ultra')).toBe('ultra');
  });

  it('labels the ultra tier "Pro" rather than adding a fourth model row', () => {
    expect(EFFORT_LEVELS.find(l => l.key === 'ultra')?.label).toBe('Pro');
  });

  // Ceilings mirror Codex's own per-model supported_reasoning_levels:
  // sol/terra -> ultra, luna -> max, pre-5.6 -> xhigh. Covers both the
  // renderer's provider-prefixed model id and the bare id the protocol layer
  // dispatches, and both Codex transports' provider prefixes.
  it('clamps to each Codex model ceiling', () => {
    expect(clampEffortForModel('gpt-5.6-sol', 'ultra')).toBe('ultra');
    expect(clampEffortForModel('gpt-5.6-terra', 'ultra')).toBe('ultra');
    expect(clampEffortForModel('openai-codex:gpt-5.6-sol', 'ultra')).toBe('ultra');
    expect(clampEffortForModel('openai-codex-acp:gpt-5.6-terra', 'ultra')).toBe('ultra');
    expect(clampEffortForModel('openai-codex:gpt-5.6-luna', 'ultra')).toBe('max');
    expect(clampEffortForModel('gpt-5.6-luna', 'ultra')).toBe('max');
    expect(clampEffortForModel('openai-codex:gpt-5.5', 'max')).toBe('xhigh');
    expect(clampEffortForModel('gpt-5.4', 'ultra')).toBe('xhigh');
    expect(clampEffortForModel('openai-codex-acp:gpt-5.6-sol', 'max')).toBe('max');
  });

  it('clamps ultra to max for Claude and unknown models', () => {
    expect(clampEffortForModel('claude-code:fable', 'ultra')).toBe('max');
    expect(clampEffortForModel('claude-code:opus-4-6', 'ultra')).toBe('max');
    expect(clampEffortForModel(undefined, 'ultra')).toBe('max');
    expect(clampEffortForModel(null, 'ultra')).toBe('max');
  });

  it('never upgrades a lower requested effort', () => {
    expect(clampEffortForModel('openai-codex:gpt-5.6-sol', 'low')).toBe('low');
    expect(clampEffortForModel('openai-codex:gpt-5.5', 'medium')).toBe('medium');
  });

  it('lists supported levels per model for the selector', () => {
    expect(supportedEffortLevelsForModel('openai-codex:gpt-5.6-sol').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(supportedEffortLevelsForModel('openai-codex:gpt-5.6-terra').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(supportedEffortLevelsForModel('openai-codex:gpt-5.6-luna').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(supportedEffortLevelsForModel('openai-codex:gpt-5.4').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh']);
    // Unknown/non-Codex models must not accidentally expose Pro.
    expect(supportedEffortLevelsForModel('claude-code:fable').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(supportedEffortLevelsForModel(undefined).map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  // #B3 parent review point 3: classification must be an exact-id allowlist,
  // never a substring match, and unknown Codex ids must take the
  // conservative xhigh ceiling rather than being assumed to support max.
  it('does not let a lookalike model id inherit Sol/Terra/Luna ceilings via substring match', () => {
    expect(clampEffortForModel('gpt-5.6-solstice', 'ultra')).toBe('xhigh');
    expect(clampEffortForModel('gpt-5.6-solar', 'max')).toBe('xhigh');
    expect(clampEffortForModel('gpt-5.6-terraform', 'ultra')).toBe('xhigh');
    expect(clampEffortForModel('openai-codex:gpt-5.6-lunar', 'ultra')).toBe('xhigh');
    expect(supportedEffortLevelsForModel('gpt-5.6-solstice').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(supportedEffortLevelsForModel('openai-codex:gpt-5.6-terraform').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('treats an unrecognized future gpt-5.6-* Codex model as xhigh, never assumed max', () => {
    expect(clampEffortForModel('gpt-5.6-nova', 'max')).toBe('xhigh');
    expect(clampEffortForModel('openai-codex:gpt-5.6-nova', 'ultra')).toBe('xhigh');
    expect(clampEffortForModel('openai-codex-acp:gpt-5.6', 'max')).toBe('xhigh');
    expect(supportedEffortLevelsForModel('gpt-5.6-nova').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh']);
  });
});

describe('effectiveEffortLevel (display clamp for the model picker/toolbar)', () => {
  // #B3 parent review point 1: the toolbar must never claim a stronger
  // level than what dispatch will actually send.
  it('clamps a stale explicit per-session value to the current model (Pro persisted on Sol, viewed on Luna)', () => {
    expect(effectiveEffortLevel('openai-codex:gpt-5.6-luna', 'ultra', 'high')).toBe('max');
    expect(effectiveEffortLevel('openai-codex:gpt-5.4', 'ultra', 'high')).toBe('xhigh');
    expect(effectiveEffortLevel('claude-code:opus', 'ultra', 'high')).toBe('max');
  });

  it('returns the explicit per-session value unchanged when the current model still supports it', () => {
    expect(effectiveEffortLevel('openai-codex:gpt-5.6-sol', 'ultra', 'high')).toBe('ultra');
    expect(effectiveEffortLevel('openai-codex:gpt-5.6-luna', 'max', 'high')).toBe('max');
  });

  it('clamps a persisted app-wide default of ultra when viewed on a model that cannot run it', () => {
    // No explicit per-session value (null/undefined) -- falls back to the
    // app default, which must still be clamped for display.
    expect(effectiveEffortLevel('openai-codex:gpt-5.6-luna', null, 'ultra')).toBe('max');
    expect(effectiveEffortLevel('openai-codex:gpt-5.4', undefined, 'ultra')).toBe('xhigh');
    expect(effectiveEffortLevel('claude-code:opus', null, 'ultra')).toBe('max');
    expect(effectiveEffortLevel('openai-codex:gpt-5.6-sol', null, 'ultra')).toBe('ultra');
  });

  it('coerces an invalid persisted session value before clamping', () => {
    expect(effectiveEffortLevel('openai-codex:gpt-5.6-sol', 'bogus', 'ultra')).toBe(DEFAULT_EFFORT_LEVEL);
  });
});

describe('effortLevelCorrectionForModelChange (persist-on-model-change for #B3 parent review point 1)', () => {
  it('returns the clamped level when an explicit per-session value no longer fits the new model', () => {
    expect(effortLevelCorrectionForModelChange('openai-codex:gpt-5.6-luna', 'ultra')).toBe('max');
    expect(effortLevelCorrectionForModelChange('openai-codex:gpt-5.4', 'ultra')).toBe('xhigh');
    expect(effortLevelCorrectionForModelChange('claude-code:opus', 'ultra')).toBe('max');
  });

  it('returns null when the explicit value already fits the new model (nothing to correct)', () => {
    expect(effortLevelCorrectionForModelChange('openai-codex:gpt-5.6-sol', 'ultra')).toBeNull();
    expect(effortLevelCorrectionForModelChange('openai-codex:gpt-5.6-terra', 'max')).toBeNull();
  });

  it('returns null when no explicit per-session value was set, even if the new model would clamp the app default', () => {
    // Nothing was persisted for this session -- there is no stale value to
    // rewrite, and effectiveEffortLevel already re-clamps the app default
    // for display on every render. Persisting here would silently pin a
    // session that was only ever following the app-wide default.
    expect(effortLevelCorrectionForModelChange('openai-codex:gpt-5.6-luna', null)).toBeNull();
    expect(effortLevelCorrectionForModelChange('openai-codex:gpt-5.6-luna', undefined)).toBeNull();
  });
});

describe('buildModelChangeMetadataUpdate (atomic model+effort persistence for #B3 parent review point 2 follow-up)', () => {
  it('folds the effort correction into the SAME payload as the model, never a split shape', () => {
    expect(buildModelChangeMetadataUpdate('openai-codex:gpt-5.6-luna', 'ultra')).toEqual({
      model: 'openai-codex:gpt-5.6-luna',
      metadata: { effortLevel: 'max' },
    });
    expect(buildModelChangeMetadataUpdate('openai-codex:gpt-5.4', 'ultra')).toEqual({
      model: 'openai-codex:gpt-5.4',
      metadata: { effortLevel: 'xhigh' },
    });
  });

  it('omits the metadata key entirely when there is nothing to correct', () => {
    // A bare { model } payload, not { model, metadata: {} } -- callers must
    // be able to tell "nothing to persist" apart from "persist an empty object".
    const fits = buildModelChangeMetadataUpdate('openai-codex:gpt-5.6-sol', 'ultra');
    expect(fits).toEqual({ model: 'openai-codex:gpt-5.6-sol' });
    expect('metadata' in fits).toBe(false);

    const noExplicitValue = buildModelChangeMetadataUpdate('openai-codex:gpt-5.6-luna', null);
    expect(noExplicitValue).toEqual({ model: 'openai-codex:gpt-5.6-luna' });
    expect('metadata' in noExplicitValue).toBe(false);
  });
});
