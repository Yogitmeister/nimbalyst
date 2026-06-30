import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THINKING_MODE,
  parseThinkingMode,
} from '../effortLevels';

describe('thinking mode parsing', () => {
  it('defaults to disabled', () => {
    expect(DEFAULT_THINKING_MODE).toBe('disabled');
    expect(parseThinkingMode(undefined)).toBe('disabled');
    expect(parseThinkingMode(null)).toBe('disabled');
  });

  it('accepts enabled and disabled modes', () => {
    expect(parseThinkingMode('enabled')).toBe('enabled');
    expect(parseThinkingMode('disabled')).toBe('disabled');
  });

  it('falls back to the default for unknown values', () => {
    expect(parseThinkingMode('on')).toBe('disabled');
    expect(parseThinkingMode('off')).toBe('disabled');
    expect(parseThinkingMode('')).toBe('disabled');
  });
});
