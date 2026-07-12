import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_BACKENDS,
  resolveClaudeCodeBackend,
} from '../providers/claudeCode/customBackends';

describe('customBackends catalog', () => {
  it('carries the current DeepSeek V4 model ids (legacy ids die 2026-07-24)', () => {
    const ids = CLAUDE_CODE_BACKENDS.map((b) => b.id);
    expect(ids).toContain('deepseek-v4-pro');
    expect(ids).toContain('deepseek-v4-flash');
    expect(ids).not.toContain('deepseek-reasoner');
    expect(ids).not.toContain('deepseek-chat');
  });

  it('maps each DeepSeek entry to its own upstream model id (no legacy aliases)', () => {
    const pro = CLAUDE_CODE_BACKENDS.find((b) => b.id === 'deepseek-v4-pro');
    const flash = CLAUDE_CODE_BACKENDS.find((b) => b.id === 'deepseek-v4-flash');
    expect(pro?.upstreamModel).toBe('deepseek-v4-pro');
    expect(flash?.upstreamModel).toBe('deepseek-v4-flash');
    expect(pro?.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(flash?.baseUrl).toBe('https://api.deepseek.com/anthropic');
  });
});

describe('resolveClaudeCodeBackend', () => {
  it('resolves current ids directly', () => {
    expect(resolveClaudeCodeBackend('deepseek-v4-pro')?.id).toBe('deepseek-v4-pro');
    expect(resolveClaudeCodeBackend('kimi-k2.6')?.id).toBe('kimi-k2.6');
  });

  it('remaps persisted legacy DeepSeek ids to V4 Flash (equivalent tier, not a silent Pro upgrade)', () => {
    expect(resolveClaudeCodeBackend('deepseek-reasoner')?.id).toBe('deepseek-v4-flash');
    expect(resolveClaudeCodeBackend('deepseek-chat')?.id).toBe('deepseek-v4-flash');
  });

  it('returns undefined for unknown ids and empty input', () => {
    expect(resolveClaudeCodeBackend('not-a-backend')).toBeUndefined();
    expect(resolveClaudeCodeBackend(undefined)).toBeUndefined();
    expect(resolveClaudeCodeBackend(null)).toBeUndefined();
    expect(resolveClaudeCodeBackend('')).toBeUndefined();
  });
});
