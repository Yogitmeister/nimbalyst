import { describe, expect, it } from 'vitest';
import { supportsEffortLevel, supportedEffortLevelsForModel } from '../modelUtils';

describe('supportsEffortLevel', () => {
  it.each([
    'claude-code:opus',
    'claude-code:opus-4-6',
    'claude-code:sonnet',
    'claude-code:fable',
    'claude-code-cli:fable-1m',
    'claude-code:opus-4-7',
    'claude-code-cli:opus-4-7-1m',
    'claude-code:sonnet-4-6',
    'claude-code-cli:sonnet-4-6-1m',
  ])('supports current Claude Code effort-capable variants: %s', (modelId) => {
    expect(supportsEffortLevel(modelId)).toBe(true);
  });

  it.each([
    'openai-codex:gpt-5.4',
    'openai-codex-acp:gpt-5.4',
  ])('supports effort for both Codex providers: %s', (modelId) => {
    expect(supportsEffortLevel(modelId)).toBe(true);
  });

  it.each([
    undefined,
    'claude-code:haiku',
    'claude-code:unknown',
    'claude:claude-fable-5',
  ])('does not expose effort for unsupported models: %s', (modelId) => {
    expect(supportsEffortLevel(modelId)).toBe(false);
  });
});

describe('supportedEffortLevelsForModel (re-exported from runtime effortLevels)', () => {
  it.each([
    'openai-codex:gpt-5.6-sol',
    'openai-codex:gpt-5.6-terra',
    'openai-codex-acp:gpt-5.6-sol',
  ])('exposes Pro (ultra) for GPT-5.6 Sol/Terra: %s', (modelId) => {
    expect(supportedEffortLevelsForModel(modelId).map(l => l.key)).toContain('ultra');
  });

  it.each([
    'openai-codex:gpt-5.6-luna',
    'openai-codex:gpt-5.4',
    'claude-code:opus',
    'claude-code:fable',
    undefined,
  ])('does not expose Pro (ultra) for non-Sol/Terra models: %s', (modelId) => {
    expect(supportedEffortLevelsForModel(modelId).map(l => l.key)).not.toContain('ultra');
  });
});
