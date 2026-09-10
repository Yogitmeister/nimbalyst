// [ASTRA-ORCH]
// @vitest-environment node

import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  dispatchMetaAgentTool,
  setMetaAgentToolFns,
} from '../metaAgentServer';
import { resolveTargetWorkspaceBinding } from '../targetWorkspaceBinding';

const CALLER_WS = path.resolve('caller-workspace');
const TARGET_WS = path.resolve('target-workspace');

function installMetaAgentFns() {
  const getSessionStatus = vi.fn(async () => 'status');
  const getSessionResult = vi.fn(async () => 'result');
  const sendPrompt = vi.fn(async () => 'sent');
  const respondToPrompt = vi.fn(async () => 'responded');
  const listQueuedPrompts = vi.fn(async () => 'queued');
  setMetaAgentToolFns({
    getSessionStatus,
    getSessionResult,
    sendPrompt,
    respondToPrompt,
    listQueuedPrompts,
  } as any);
  return { getSessionStatus, getSessionResult, sendPrompt, respondToPrompt, listQueuedPrompts };
}

describe('resolveTargetWorkspaceBinding', () => {
  it('keeps default calls bound to the caller workspace', () => {
    expect(resolveTargetWorkspaceBinding(CALLER_WS)).toBe(CALLER_WS);
  });

  it('uses an explicit absolute target workspace', () => {
    expect(resolveTargetWorkspaceBinding(CALLER_WS, { targetWorkspacePath: TARGET_WS })).toBe(TARGET_WS);
  });

  it.each([null, '', '   ', 42, 'relative/target'])(
    'fails closed for invalid explicit target workspace (%p)',
    (targetWorkspacePath) => {
      expect(() => resolveTargetWorkspaceBinding(CALLER_WS, { targetWorkspacePath })).toThrow(/targetWorkspacePath/);
    },
  );
});

describe('meta-agent target workspace routing', () => {
  it('routes only the four admitted tools to an explicit target workspace', async () => {
    const fns = installMetaAgentFns();

    await dispatchMetaAgentTool('get_session_status', 'caller', CALLER_WS, {
      sessionId: 'target-session', targetWorkspacePath: TARGET_WS,
    });
    await dispatchMetaAgentTool('get_session_result', 'caller', CALLER_WS, {
      sessionId: 'target-session', targetWorkspacePath: TARGET_WS,
    });
    await dispatchMetaAgentTool('send_prompt', 'caller', CALLER_WS, {
      sessionId: 'target-session', prompt: 'continue', targetWorkspacePath: TARGET_WS,
    });
    await dispatchMetaAgentTool('respond_to_prompt', 'caller', CALLER_WS, {
      sessionId: 'target-session', promptId: 'prompt', promptType: 'ask_user_question_request',
      response: {}, targetWorkspacePath: TARGET_WS,
    });

    for (const fn of [fns.getSessionStatus, fns.getSessionResult, fns.sendPrompt, fns.respondToPrompt]) {
      expect((fn.mock.calls[0] as unknown as [string, string])[1]).toBe(TARGET_WS);
    }
  });

  it('keeps list_queued_prompts hard-bound even when targetWorkspacePath is supplied', async () => {
    const fns = installMetaAgentFns();

    await dispatchMetaAgentTool('list_queued_prompts', 'caller', CALLER_WS, {
      sessionId: 'target-session', targetWorkspacePath: TARGET_WS,
    });

    expect((fns.listQueuedPrompts.mock.calls[0] as unknown as [string, string])[1]).toBe(CALLER_WS);
  });
});
