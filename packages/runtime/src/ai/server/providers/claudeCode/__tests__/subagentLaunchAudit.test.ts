// [ASTRA-ORCH]
import { describe, expect, it } from 'vitest';
import {
  applyClaudeInitToSubagentLaunchConfig,
  createSubagentLaunchConfigMetadata,
  shouldAttachSubagentLaunchConfig,
} from '../subagentLaunchAudit';

describe('subagentLaunchAudit', () => {
  it('captures every configured safe model control without process or credential data', () => {
    const config = createSubagentLaunchConfigMetadata({
      model: 'sonnet',
      fallbackModel: 'haiku',
      permissionMode: 'auto',
      thinking: { type: 'disabled' },
      maxTurns: 12,
      maxBudgetUsd: 3,
      betas: ['context-1m-2025-08-07'],
      cwd: 'D:\\private-workspace',
      systemPrompt: 'private prompt',
      env: {
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        ANTHROPIC_API_KEY: 'must-not-appear',
      },
    }, {
      effortLevel: 'high',
      thinkingMode: 'disabled',
    });

    expect(config.parameters).toEqual(expect.arrayContaining([
      { key: 'modelRequested', label: 'Requested model', value: 'sonnet', source: 'requested' },
      { key: 'model', label: 'Model', value: 'sonnet', source: 'requested' },
      { key: 'fallbackModel', label: 'Fallback model', value: 'haiku', source: 'requested' },
      { key: 'reasoningEffort', label: 'Reasoning effort', value: 'high', source: 'requested' },
      { key: 'extendedThinking', label: 'Extended reasoning', value: 'off', source: 'requested' },
      { key: 'maximumTurns', label: 'Maximum turns', value: 12, source: 'requested' },
      { key: 'maximumBudgetUsd', label: 'Maximum budget (USD)', value: 3, source: 'requested' },
      { key: 'permissionMode', label: 'Permission mode', value: 'auto', source: 'requested' },
      { key: 'betas', label: 'Model betas', value: 'context-1m-2025-08-07', source: 'requested' },
    ]));
    expect(JSON.stringify(config)).not.toContain('private-workspace');
    expect(JSON.stringify(config)).not.toContain('private prompt');
    expect(JSON.stringify(config)).not.toContain('must-not-appear');
  });

  it('replaces requested values with the effective init model, effort, and permission mode', () => {
    const config = createSubagentLaunchConfigMetadata({
      model: 'sonnet',
      env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' },
      permissionMode: 'default',
    }, {});

    applyClaudeInitToSubagentLaunchConfig(config, {
      model: 'claude-sonnet-4-6-20260801',
      effort: 'medium',
      permissionMode: 'auto',
    });

    expect(config.parameters).toEqual(expect.arrayContaining([
      { key: 'model', label: 'Model', value: 'claude-sonnet-4-6-20260801', source: 'effective_session' },
      { key: 'reasoningEffort', label: 'Reasoning effort', value: 'medium', source: 'effective_session' },
      { key: 'permissionMode', label: 'Permission mode', value: 'auto', source: 'effective_session' },
    ]));
  });

  it('attaches audit metadata only to sub-agent launch and child-output chunks', () => {
    expect(shouldAttachSubagentLaunchConfig({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Agent' }] },
    })).toBe(true);
    expect(shouldAttachSubagentLaunchConfig({
      type: 'assistant',
      parent_tool_use_id: 'toolu_child',
      message: { content: [{ type: 'text', text: 'done' }] },
    })).toBe(true);
    expect(shouldAttachSubagentLaunchConfig({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ordinary output' }] },
    })).toBe(false);
  });
});
