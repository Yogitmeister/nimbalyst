import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_BACKENDS } from '@nimbalyst/runtime/ai/server';
import { META_AGENT_TOOL_DEFS } from '../metaAgentServer';

describe('meta-agent Claude Code backend schema', () => {
  for (const toolName of ['create_session', 'spawn_session']) {
    it(`exposes the exact backend profile on ${toolName}`, () => {
      const tool = META_AGENT_TOOL_DEFS.find((candidate) => candidate.name === toolName);
      const property = tool?.inputSchema.properties.claudeCodeBackend as {
        type?: string;
        enum?: string[];
      } | undefined;

      // Asserted against the live registry rather than a second hardcoded
      // list, so this test can't itself drift out of sync with a new
      // provider family the way its Ollama-only literal enum just did.
      expect(property).toEqual(
        expect.objectContaining({
          type: 'string',
          enum: CLAUDE_CODE_BACKENDS.map((backend) => backend.id),
        })
      );
    });
  }
});
