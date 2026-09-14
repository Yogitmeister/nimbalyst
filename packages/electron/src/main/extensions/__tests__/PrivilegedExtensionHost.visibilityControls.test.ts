import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, utilityProcess: { fork: vi.fn() } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../utils/store', () => ({ getProviderApiKeyFromSettings: vi.fn() }));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn() },
}));
vi.mock('../extensionCapabilityPolicy', () => ({
  canModuleStart: vi.fn(async () => ({ ok: true })), assertPermission: vi.fn(),
  CapabilityDeniedError: class CapabilityDeniedError extends Error {},
}));
vi.mock('../permissionGrantStore', () => ({
  diffDeclaredAgainstGrants: vi.fn(() => ({ added: [], removed: [] })),
  shrinkGrantsToDeclared: vi.fn(), listEffectiveGrants: vi.fn(() => []),
  clearAllGrantsForExtension: vi.fn(), grantModulePermissions: vi.fn(),
}));
vi.mock('../permissionPrompt', () => ({ raisePermissionPrompt: vi.fn(), generatePermissionPromptId: vi.fn(() => 'prompt') }));
vi.mock('../permissionUsageTracker', () => ({ getPermissionUsageTracker: () => ({ record: vi.fn() }) }));
vi.mock('../../mcp/metaAgentServer', () => ({ dispatchExtensionMetaAgentTool: vi.fn(async () => JSON.stringify({ ok: true })) }));

import { PrivilegedExtensionHost } from '../PrivilegedExtensionHost';
import { dispatchExtensionMetaAgentTool } from '../../mcp/metaAgentServer';

const key = 'com.nimbalyst.agent::agent-backend::/repo-worktrees/repair';
const runtimeContext = {
  extensionId: 'com.nimbalyst.agent', moduleId: 'agent-backend',
  workspacePath: '/repo-worktrees/repair', grantedPermissions: ['nimbalyst-database-write'],
  entryFilePath: '/extension/backend.js', extensionPath: '/extension',
};

function managed(send: (message: any) => void) {
  return {
    args: { extensionId: 'com.nimbalyst.agent', extensionName: 'Agent', extensionPath: '/extension', module: { id: 'agent-backend' }, workspacePath: '/repo-worktrees/repair' },
    state: { status: 'running' as const, startedAt: 0, methods: ['sendMessage'] },
    grantedPermissions: ['nimbalyst-database-write'], runtime: { send, kill: async () => {}, isAlive: () => true },
    pending: new Map(), nextRpcId: 1, loggingPrincipalPolicy: 'ordinary-session-id' as const,
  };
}

async function prepareTurn(host: PrivilegedExtensionHost, runtime: ReturnType<typeof managed>, sent: any[], actorSessionId: string) {
  host.bindNextExtensionAgentTurnAuthority({
    extensionId: 'com.nimbalyst.agent', moduleId: 'agent-backend',
    runtimeWorkspacePath: '/repo-worktrees/repair', actorSessionId, canonicalWorkspacePath: '/repo',
  });
  const create = host.request({
    extensionId: 'com.nimbalyst.agent', moduleId: 'agent-backend', workspacePath: '/repo-worktrees/repair',
    method: 'createSession', params: { sessionId: actorSessionId }, requiredPermission: null,
  });
  const createRequest = sent.at(-1);
  const capability = createRequest.params.sessionId;
  (host as any).handleBackendMessage(runtime, { kind: 'rpc-result', id: createRequest.id, result: undefined }, runtimeContext);
  await create;
  const stream = host.stream({
    extensionId: 'com.nimbalyst.agent', moduleId: 'agent-backend', workspacePath: '/repo-worktrees/repair',
    method: 'sendMessage', params: { sessionId: actorSessionId }, requiredPermission: null,
  });
  return { capability, streamId: stream.id };
}

describe('PrivilegedExtensionHost visibility authority', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses only an exact live host-created capability', async () => {
    const host = new PrivilegedExtensionHost();
    const sent: any[] = [];
    const runtime = managed((message) => sent.push(message));
    (host as any).modules.set(key, runtime);
    const { capability } = await prepareTurn(host, runtime, sent, 'host-session');
    expect(capability).not.toBe('host-session');

    await (host as any).handleBrokerRequest(runtime, runtimeContext, 'broker-1', 'toolExecutor', {
      name: 'session_set_pinned', sessionId: capability,
      workspacePath: '/backend-spoofed-workspace', args: { sessionId: 'target', pinned: true },
    }, 'test');

    expect(dispatchExtensionMetaAgentTool).toHaveBeenCalledWith(
      'session_set_pinned', { sessionId: 'target', pinned: true },
      { actorSessionId: 'host-session', workspacePath: '/repo' },
    );
  });

  it('rejects a completed turn A while allowing live turn B', async () => {
    const host = new PrivilegedExtensionHost();
    const sent: any[] = [];
    const runtime = managed((message) => sent.push(message));
    (host as any).modules.set(key, runtime);
    const turnA = await prepareTurn(host, runtime, sent, 'actor-a');
    (host as any).handleBackendMessage(runtime, { kind: 'rpc-stream-end', id: turnA.streamId }, runtimeContext);
    const turnB = await prepareTurn(host, runtime, sent, 'actor-b');

    await (host as any).handleBrokerRequest(runtime, runtimeContext, 'stale-a', 'toolExecutor', {
      name: 'session_set_pinned', sessionId: turnA.capability, args: { sessionId: 'target', pinned: true },
    }, 'test');
    expect(dispatchExtensionMetaAgentTool).not.toHaveBeenCalled();

    await (host as any).handleBrokerRequest(runtime, runtimeContext, 'live-b', 'toolExecutor', {
      name: 'session_set_pinned', sessionId: turnB.capability, args: { sessionId: 'target', pinned: true },
    }, 'test');
    expect(dispatchExtensionMetaAgentTool).toHaveBeenCalledWith(
      'session_set_pinned', { sessionId: 'target', pinned: true },
      { actorSessionId: 'actor-b', workspacePath: '/repo' },
    );
  });
});
