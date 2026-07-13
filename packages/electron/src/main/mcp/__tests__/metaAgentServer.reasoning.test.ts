import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/workspaceDetection', () => ({
  resolveProjectPath: (value: string) => value,
}));

import {
  META_AGENT_TOOL_DEFS,
  dispatchMetaAgentTool,
  getMetaAgentOpenAITools,
  setMetaAgentToolFns,
} from '../metaAgentServer';

describe('meta-agent reasoning MCP contract', () => {
  const setModelControl = vi.fn();

  beforeEach(() => {
    setModelControl.mockReset().mockResolvedValue('{"ok":true}');
    const noop = vi.fn().mockResolvedValue('{}');
    setMetaAgentToolFns({
      listWorktrees: noop,
      createSession: noop,
      spawnSession: noop,
      setModelControl,
      getSessionStatus: noop,
      getSessionResult: noop,
      listQueuedPrompts: noop,
      sendPrompt: noop,
      notifyUser: noop,
      compactSession: noop,
      respondToPrompt: noop,
      listSpawnedSessions: noop,
    });
  });

  it('publishes reasoning on create/spawn and exposes set_model_control to extension meta-agents', () => {
    const create = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'create_session');
    const spawn = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'spawn_session');
    const setControl = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'set_model_control');

    expect(create?.inputSchema.properties).toHaveProperty('reasoning');
    expect(spawn?.inputSchema.properties).toHaveProperty('reasoning');
    expect(setControl?.inputSchema.required).toContain('reasoning');
    expect(getMetaAgentOpenAITools().map((tool) => tool.function.name)).toContain('set_model_control');
  });

  it('dispatches the exact prefixed tool name with self-targeting arguments intact', async () => {
    await expect(dispatchMetaAgentTool(
      'mcp__nimbalyst-host__set_model_control',
      'caller-session',
      '/workspace',
      { reasoning: { effortPolicy: 'auto' } },
    )).resolves.toBe('{"ok":true}');

    expect(setModelControl).toHaveBeenCalledWith(
      'caller-session',
      '/workspace',
      { reasoning: { effortPolicy: 'auto' } },
    );
  });
});
