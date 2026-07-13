import { beforeAll, describe, expect, it } from 'vitest';
import {
  ModelRegistry,
  resolveClaudeCodeModelVariant,
  type AIModel,
} from '@nimbalyst/runtime/ai/server';
import {
  contextWindowForClaudeCodeModel,
  getClaudeCodeModelCapability,
} from '@nimbalyst/runtime/ai/modelConstants';
import { resolveClaudeCliModelArg } from '../claudeCliSpawnConfig';
import { buildClaudeCliModelSwitchCommand } from '../claudeCliModelSwitch';

describe('Claude model capability matrix', () => {
  let catalogs: Record<'claude-code' | 'claude-code-cli', AIModel[]>;

  beforeAll(async () => {
    const [sdk, cli] = await Promise.all([
      ModelRegistry.getModelsForProvider('claude-code'),
      ModelRegistry.getModelsForProvider('claude-code-cli'),
    ]);
    catalogs = { 'claude-code': sdk, 'claude-code-cli': cli };
  });

  it.each([
    ['claude-code', 'claude-code:fable', 1_000_000],
    ['claude-code', 'claude-code:fable-1m', 1_000_000],
    ['claude-code', 'claude-code:opus', 1_000_000],
    ['claude-code', 'claude-code:opus-4-7', 1_000_000],
    ['claude-code', 'claude-code:opus-4-6', 200_000],
    ['claude-code', 'claude-code:opus-4-6-1m', 1_000_000],
    ['claude-code', 'claude-code:sonnet', 1_000_000],
    ['claude-code', 'claude-code:sonnet-4-6', 200_000],
    ['claude-code', 'claude-code:sonnet-4-6-1m', 1_000_000],
    ['claude-code-cli', 'claude-code-cli:fable', 1_000_000],
    ['claude-code-cli', 'claude-code-cli:fable-1m', 1_000_000],
    ['claude-code-cli', 'claude-code-cli:opus', 1_000_000],
    ['claude-code-cli', 'claude-code-cli:opus-4-7', 1_000_000],
    ['claude-code-cli', 'claude-code-cli:opus-4-6', 1_000_000],
    ['claude-code-cli', 'claude-code-cli:sonnet', 1_000_000],
    ['claude-code-cli', 'claude-code-cli:sonnet-4-6', 200_000],
    ['claude-code', 'claude-code:haiku', 200_000],
    ['claude-code-cli', 'claude-code-cli:haiku', 200_000],
  ] as const)('%s catalog exposes %s at %i tokens', (provider, id, expectedWindow) => {
    expect(catalogs[provider].find((model) => model.id === id)?.contextWindow).toBe(expectedWindow);
  });

  it('keeps SDK Fable aliases on the bundled full model id without requiring [1m]', () => {
    expect(resolveClaudeCodeModelVariant('claude-code:fable', 'claude-code:opus')).toBe('claude-fable-5');
    expect(resolveClaudeCodeModelVariant('claude-code:fable-5', 'claude-code:opus')).toBe('claude-fable-5');
    expect(resolveClaudeCodeModelVariant('claude-fable-5', 'claude-code:opus')).toBe('claude-fable-5');
  });

  it('resolves SDK aliases for selected-model context input without cross-surface inheritance', () => {
    expect(contextWindowForClaudeCodeModel('agent-sdk', 'claude-code:fable')).toBe(1_000_000);
    expect(contextWindowForClaudeCodeModel('agent-sdk', 'claude-code:fable-5')).toBe(1_000_000);
    expect(contextWindowForClaudeCodeModel('agent-sdk', 'claude-fable-5')).toBe(1_000_000);
    expect(contextWindowForClaudeCodeModel('interactive-cli', 'claude-fable-5')).toBe(1_000_000);
    expect(contextWindowForClaudeCodeModel('interactive-cli', 'claude-opus-4-6')).toBe(200_000);
    expect(contextWindowForClaudeCodeModel('agent-sdk', 'claude-code-cli:fable')).toBeUndefined();
    expect(contextWindowForClaudeCodeModel('interactive-cli', 'claude-code:fable')).toBeUndefined();
  });

  it('keys otherwise identical Fable names by surface, variant, and context mode', () => {
    expect(getClaudeCodeModelCapability('agent-sdk', 'fable')).toMatchObject({
      key: 'agent-sdk:fable:claude-fable-5:base',
      modelValue: 'claude-fable-5',
      contextWindow: 1_000_000,
    });
    expect(getClaudeCodeModelCapability('interactive-cli', 'fable')).toMatchObject({
      key: 'interactive-cli:fable:fable:base',
      modelValue: 'fable',
      contextWindow: 1_000_000,
    });
    expect(getClaudeCodeModelCapability('interactive-cli', 'fable-1m')).toMatchObject({
      key: 'interactive-cli:fable:fable:explicit-1m',
      modelValue: 'fable[1m]',
      contextWindow: 1_000_000,
    });
  });

  it('does not infer the SDK base-Fable window from its display label', () => {
    const baseFable = catalogs['claude-code'].find((model) => model.id === 'claude-code:fable');
    expect(baseFable?.name).not.toContain('(1M)');
    expect(baseFable?.contextWindow).toBe(1_000_000);
  });

  it('keeps interactive CLI base and explicit Fable routing distinct', () => {
    expect(resolveClaudeCliModelArg('claude-code-cli:fable')).toBe('fable');
    expect(resolveClaudeCliModelArg('claude-code-cli:fable-5')).toBe('fable');
    expect(resolveClaudeCliModelArg('claude-code-cli:fable-1m')).toBe('fable[1m]');
    expect(resolveClaudeCliModelArg('claude-fable-5')).toBe('claude-fable-5');
    expect(buildClaudeCliModelSwitchCommand('claude-code-cli:fable')).toBe('/model fable');
    expect(buildClaudeCliModelSwitchCommand('claude-code-cli:fable-1m')).toBe('/model fable[1m]');
  });
});
