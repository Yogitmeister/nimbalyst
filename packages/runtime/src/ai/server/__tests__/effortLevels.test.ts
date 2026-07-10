import { describe, it, expect } from 'vitest';
import {
  resolveEffortLevel,
  DEFAULT_EFFORT_LEVEL,
  parseEffortLevel,
  clampEffortForModel,
  supportedEffortLevelsForModel,
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

describe('ultra effort level (Codex 5.6)', () => {
  it('parses ultra as a valid level', () => {
    expect(parseEffortLevel('ultra')).toBe('ultra');
  });

  // Ceilings mirror codex.exe's own per-model supported_reasoning_levels
  // (verified live 2026-07-10): sol/terra -> ultra, luna -> max, pre-5.6 -> xhigh.
  it('clamps to each Codex model ceiling', () => {
    expect(clampEffortForModel('openai-codex:gpt-5.6-sol', 'ultra')).toBe('ultra');
    expect(clampEffortForModel('gpt-5.6-terra', 'ultra')).toBe('ultra');
    expect(clampEffortForModel('openai-codex:gpt-5.6-luna', 'ultra')).toBe('max');
    expect(clampEffortForModel('openai-codex:gpt-5.5', 'max')).toBe('xhigh');
    expect(clampEffortForModel('gpt-5.4', 'ultra')).toBe('xhigh');
    expect(clampEffortForModel('openai-codex:gpt-5.3-codex-spark', 'ultra')).toBe('xhigh');
    expect(clampEffortForModel('openai-codex-acp:gpt-5.6-sol', 'max')).toBe('max');
  });

  it('clamps ultra to max for Claude and unknown models', () => {
    expect(clampEffortForModel('claude-code:fable', 'ultra')).toBe('max');
    expect(clampEffortForModel(undefined, 'ultra')).toBe('max');
  });

  it('never upgrades a lower requested effort', () => {
    expect(clampEffortForModel('openai-codex:gpt-5.6-sol', 'low')).toBe('low');
    expect(clampEffortForModel('openai-codex:gpt-5.5', 'medium')).toBe('medium');
  });

  it('lists supported levels per model for the selector', () => {
    expect(supportedEffortLevelsForModel('openai-codex:gpt-5.6-sol').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(supportedEffortLevelsForModel('openai-codex:gpt-5.6-luna').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(supportedEffortLevelsForModel('openai-codex:gpt-5.4').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(supportedEffortLevelsForModel('openai-codex:gpt-5.3-codex-spark').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(supportedEffortLevelsForModel('claude-code:fable').map(l => l.key))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
