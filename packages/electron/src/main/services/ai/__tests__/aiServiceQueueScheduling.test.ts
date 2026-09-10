// [ASTRA-ORCH]
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  create: vi.fn(), getSession: vi.fn(), flush: vi.fn(), request: vi.fn(), publish: vi.fn(),
}));
vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: (name: string, fn: any) => h.handlers.set(name, fn) }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn() } } }));
vi.mock('../../RepositoryManager', () => ({ getQueuedPromptsStore: () => ({ create: h.create }) }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: h.getSession } }));
vi.mock('../../analytics/AnalyticsService.ts', () => ({ AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) } }));
vi.mock('../aiServiceUtils', () => ({ safeSend: vi.fn(), getFileExtensionForAnalytics: () => undefined }));
vi.mock('../../TerminalSessionManager', () => ({ getTerminalSessionManager: () => ({ isTerminalActive: () => true }) }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => ({ getSessionState: () => ({ status: 'idle' }) }) }));
vi.mock('../claudeCliQueueFlushSingleton', () => ({ flushNextClaudeCliQueuedPromptForSession: h.flush }));
import { registerQueuedPromptHandlers } from '../ipc/registerQueuedPromptHandlers';
import type { AIServiceContext } from '../ipc/AIServiceContext';
describe('ai:createQueuedPrompt queue-drive admission', () => {
  beforeEach(() => {
    vi.clearAllMocks(); h.handlers.clear();
    h.create.mockImplementation(async (input) => ({ ...input, createdAt: 1 }));
    h.publish.mockResolvedValue(undefined);
    registerQueuedPromptHandlers({ requestQueueDrive: h.request, publishQueueStateToSync: h.publish } as unknown as AIServiceContext);
  });
  it.each(['openai-codex', 'claude-code', 'model-launcher', 'claude-code-cli'])('drives %s after persistence', async (provider) => {
    h.getSession.mockResolvedValue({ provider, workspacePath: 'D:/repo' });
    await h.handlers.get('ai:createQueuedPrompt')!({}, 'session', 'prompt');
    expect(h.request).toHaveBeenCalledWith('session', 'D:/repo', 'renderer-trigger');
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.request.mock.invocationCallOrder[0]);
    if (provider === 'claude-code-cli') expect(h.flush).toHaveBeenCalledWith('session', 'D:/repo');
    else expect(h.flush).not.toHaveBeenCalled();
  });
  it('does not drive a failed persistence', async () => {
    h.create.mockRejectedValue(new Error('disk unavailable'));
    await expect(h.handlers.get('ai:createQueuedPrompt')!({}, 'session', 'prompt')).rejects.toThrow('disk unavailable');
    expect(h.request).not.toHaveBeenCalled();
  });
});
