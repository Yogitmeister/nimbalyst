import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyPrompt,
  resetReasoningPolicyState,
  resolveEffortForTurn,
  sanitizePromptForReasoningPolicy,
} from '../reasoningPolicy';

const base = {
  sessionId: 'session-1',
  appDefault: 'high' as const,
  provider: 'claude-code',
  modelId: 'claude-code:opus',
};

describe('reasoning policy', () => {
  beforeEach(() => resetReasoningPolicyState());

  it('keeps the documented Auto mapping on the full Claude ladder', () => {
    expect(resolveEffortForTurn({
      ...base,
      storedEffort: 'high',
      storedEffortPolicy: 'auto',
      promptText: 'hello',
    }).effort).toBe('medium');

    expect(resolveEffortForTurn({
      ...base,
      storedEffort: 'high',
      storedEffortPolicy: 'auto',
      promptText: 'debug and prove the root cause of this race condition',
    }).effort).toBe('max');
  });

  it('maps Auto and Auto+ monotonically onto DeepSeek high|max', () => {
    const deepSeek = { ...base, customBackendId: 'deepseek-v4-flash' };
    expect(resolveEffortForTurn({
      ...deepSeek,
      storedEffort: 'high',
      storedEffortPolicy: 'auto',
      promptText: 'hello',
    }).effort).toBe('high');
    expect(resolveEffortForTurn({
      ...deepSeek,
      storedEffort: 'high',
      storedEffortPolicy: 'auto',
      promptText: 'debug this architecture and prove the race condition root cause',
    }).effort).toBe('max');

    resetReasoningPolicyState();
    expect(resolveEffortForTurn({
      ...deepSeek,
      storedEffort: 'high',
      storedEffortPolicy: 'auto-plus',
      promptText: 'hello',
    }).effort).toBe('high');
    expect(resolveEffortForTurn({
      ...deepSeek,
      storedEffort: 'high',
      storedEffortPolicy: 'auto-plus',
      promptText: 'How should this API endpoint handle validation for normal client requests?',
    }).effort).toBe('max');
  });

  it('escalates immediately, inherits continuations, and decays one rung at a time', () => {
    const hard = resolveEffortForTurn({
      ...base,
      storedEffort: 'high',
      storedEffortPolicy: 'auto',
      promptText: 'debug and prove the root cause of this race condition',
    });
    expect(hard.effort).toBe('max');
    expect(hard.escalated).toBe(true);

    const continuation = resolveEffortForTurn({
      ...base,
      storedEffort: 'high',
      storedEffortPolicy: 'auto',
      promptText: 'continue',
    });
    expect(continuation.effort).toBe('max');

    const decay = resolveEffortForTurn({
      ...base,
      storedEffort: 'high',
      storedEffortPolicy: 'auto',
      promptText: 'hello',
    });
    expect(decay.effort).toBe('xhigh');
  });

  it('clears sticky state when fixed mode is selected', () => {
    resolveEffortForTurn({
      ...base,
      storedEffort: 'high',
      storedEffortPolicy: 'auto',
      promptText: 'debug and prove the root cause of this race condition',
    });
    resolveEffortForTurn({
      ...base,
      storedEffort: 'high',
      storedEffortPolicy: 'fixed',
      promptText: 'fixed turn',
    });

    expect(resolveEffortForTurn({
      ...base,
      storedEffort: 'high',
      storedEffortPolicy: 'auto',
    }).effort).toBe('high');
  });

  it('strips system/document wrappers and caps inspected input', () => {
    const wrapped = [
      'hello',
      '<NIMBALYST_SYSTEM_MESSAGE>debug prove architect root cause race condition</NIMBALYST_SYSTEM_MESSAGE>',
      '<DOCUMENT_CONTENT>debug prove architect root cause race condition</DOCUMENT_CONTENT>',
    ].join('\n');
    expect(sanitizePromptForReasoningPolicy(wrapped)).toBe('hello');
    expect(classifyPrompt(wrapped).tier).toBe('SIMPLE');

    const beyondCap = `${'plain '.repeat(1_500)}debug prove architect root cause race condition`;
    expect(sanitizePromptForReasoningPolicy(beyondCap).length).toBeLessThanOrEqual(8_000);
    expect(classifyPrompt(beyondCap).tier).not.toBe('REASONING');
  });
});
