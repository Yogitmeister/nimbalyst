import { describe, expect, it, vi } from 'vitest';

vi.mock('../sessionContextServer', () => ({
  SESSION_VISIBILITY_TOOL_NAMES: [
    'session_set_pinned', 'session_set_workstream', 'session_rename',
  ],
  getSessionVisibilityOpenAITools: () => [
    ['session_set_pinned', { sessionId: { type: 'string' }, pinned: { type: 'boolean' } }],
    ['session_set_workstream', { sessionId: { type: 'string' }, workstreamId: { type: ['string', 'null'] } }],
    ['session_rename', { sessionId: { type: 'string' }, name: { type: 'string' } }],
  ].map(([name, properties]) => ({
    type: 'function',
    function: {
      name,
      description: String(name),
      parameters: { type: 'object', additionalProperties: false, properties },
    },
  })),
  dispatchHostBoundSessionVisibilityTool: vi.fn(),
}));
vi.mock('../../utils/workspaceDetection', () => ({
  resolveProjectPath: (value: string) => value,
}));

import {
  dispatchExtensionMetaAgentTool,
  getMetaAgentOpenAITools,
} from '../metaAgentServer';
import { dispatchHostBoundSessionVisibilityTool } from '../sessionContextServer';

describe('extension meta-agent visibility-control dispatch', () => {
  it('exposes strict controls without backend authority fields', () => {
    const tools = getMetaAgentOpenAITools();
    for (const name of ['session_set_pinned', 'session_set_workstream', 'session_rename']) {
      const tool = tools.find((candidate) => candidate.function.name === name);
      expect(tool?.function.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      expect((tool?.function.parameters as any).properties).not.toHaveProperty('actorSessionId');
      expect((tool?.function.parameters as any).properties).not.toHaveProperty('workspacePath');
    }
  });

  it('keeps the actor and workspace outside backend-controlled arguments', async () => {
    vi.mocked(dispatchHostBoundSessionVisibilityTool).mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      isError: false,
    });

    await expect(dispatchExtensionMetaAgentTool(
      'session_set_pinned',
      { sessionId: 'target', pinned: true },
      { actorSessionId: 'host-actor', workspacePath: '/canonical' },
    )).resolves.toBe(JSON.stringify({ ok: true }));

    expect(dispatchHostBoundSessionVisibilityTool).toHaveBeenCalledWith(
      'session_set_pinned',
      { sessionId: 'target', pinned: true },
      { actorSessionId: 'host-actor', workspacePath: '/canonical' },
    );
  });
});
