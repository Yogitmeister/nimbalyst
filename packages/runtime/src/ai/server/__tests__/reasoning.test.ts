import { describe, expect, it } from 'vitest';
import {
  reasoningCapabilitiesForModel,
  validateReasoningSelection,
} from '../providers/claudeCode/reasoning';

describe('reasoning capabilities and atomic validation', () => {
  it('uses the selected backend ladder instead of the Claude model ladder', () => {
    const capabilities = reasoningCapabilitiesForModel(
      'claude-code',
      'claude-code:opus',
      'deepseek-v4-flash',
    );

    expect(capabilities.effort?.values).toEqual(['high', 'max']);
    expect(capabilities.effort?.default).toBe('high');
  });

  it('rejects a stale backend rather than silently treating it as Anthropic', () => {
    expect(() => reasoningCapabilitiesForModel(
      'claude-code',
      'claude-code:opus',
      'removed-backend',
    )).toThrow(/stale or invalid/);
  });

  it('does not advertise effort controls for providers without a reasoning transport', () => {
    expect(reasoningCapabilitiesForModel(
      'antigravity-gemini-agent',
      'antigravity-gemini-agent:gemini-flash-3.5',
    )).toEqual({ effortPolicies: ['fixed'] });
  });

  it('fails closed when Codex does not advertise a provider mode', () => {
    const capabilities = reasoningCapabilitiesForModel(
      'openai-codex',
      'openai-codex:gpt-5.6-sol',
    );
    const result = validateReasoningSelection(
      { mode: 'pro', effort: 'max', effortPolicy: 'fixed' },
      capabilities,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Provider reasoning mode 'pro' is not supported");
  });

  it('does not infer Pro mode from Ultra effort', () => {
    const capabilities = reasoningCapabilitiesForModel(
      'openai-codex',
      'openai-codex:gpt-5.6-sol',
    );
    const result = validateReasoningSelection(
      { effort: 'ultra', effortPolicy: 'fixed' },
      capabilities,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized.mode).toBeUndefined();
  });

  it('supports Auto independently when no provider mode is available', () => {
    const capabilities = reasoningCapabilitiesForModel(
      'openai-codex',
      'openai-codex:gpt-5.6-sol',
    );
    const result = validateReasoningSelection(
      { effortPolicy: 'auto-plus' },
      capabilities,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.mode).toBeUndefined();
      expect(result.normalized.effortPolicy).toBe('auto-plus');
      expect(result.normalized.effort).toBeUndefined();
    }
  });

  it('rejects an auto effort policy carrying a fixed effort atomically', () => {
    const capabilities = reasoningCapabilitiesForModel('claude-code', 'claude-code:opus');
    const result = validateReasoningSelection(
      { effortPolicy: 'auto', effort: 'max' },
      capabilities,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/do not pass a fixed 'effort'/);
  });

  it('rejects out-of-ladder DeepSeek effort without clamping', () => {
    const capabilities = reasoningCapabilitiesForModel(
      'claude-code',
      'claude-code:opus',
      'deepseek-v4-pro',
    );
    const result = validateReasoningSelection(
      { effortPolicy: 'fixed', effort: 'xhigh' },
      capabilities,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Supported values: high, max');
  });

  it('rejects unknown fields instead of partially applying a selection', () => {
    const capabilities = reasoningCapabilitiesForModel('claude-code', 'claude-code:opus');
    const result = validateReasoningSelection(
      { effort: 'high', effortPolicy: 'fixed', surprise: true } as any,
      capabilities,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown reasoning field 'surprise'");
  });
});
