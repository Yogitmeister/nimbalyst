// [ASTRA-ORCH]
import { describe, expect, it } from 'vitest';

import { META_AGENT_TOOL_DEFS } from '../metaAgentServer';

describe('catalog child projection schema', () => {
  it('exposes the same safe backend identity contract on create and spawn', () => {
    const create = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'create_session');
    const spawn = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'spawn_session');
    const createBackend = create?.inputSchema.properties.claudeCodeBackend as Record<string, unknown>;
    const spawnBackend = spawn?.inputSchema.properties.claudeCodeBackend as Record<string, unknown>;

    expect(createBackend).toBeDefined();
    expect(spawnBackend).toBeDefined();
    expect(createBackend.enum).toEqual(spawnBackend.enum);
    expect(Array.isArray(createBackend.enum)).toBe(true);
    expect(String(createBackend.description)).toContain('catalog');
    expect(String(createBackend.description)).toContain('mismatch');
    expect(String(spawnBackend.description)).toContain('route and credential material never escapes');
    expect(spawn?.inputSchema.properties).toHaveProperty('provider');
  });
});
