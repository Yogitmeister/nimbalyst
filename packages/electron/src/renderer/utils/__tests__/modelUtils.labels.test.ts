// [ASTRA-ORCH]
import { describe, expect, it } from 'vitest';
import { getClaudeCodeModelLabel, getClaudeCodeModelShortLabel } from '../modelUtils';
describe('catalog model labels', () => {
  it.each([getClaudeCodeModelLabel, getClaudeCodeModelShortLabel])('keeps a DeepSeek route distinct from native Sonnet', (label) => {
    expect(label('claude-code:ollama-deepseek-v4-pro-cloud').toLowerCase()).toContain('deepseek');
    expect(label('claude-code:ollama-deepseek-v4-pro-cloud').toLowerCase()).not.toContain('sonnet');
    expect(label('claude-code:unrecognized-vendor-model')).toBe('claude-code:unrecognized-vendor-model');
  });
});
