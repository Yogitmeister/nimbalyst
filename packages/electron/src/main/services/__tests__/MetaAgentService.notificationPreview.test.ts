// [ASTRA-ORCH]
// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

// NIM-604: notifications accept a bounded final pointer or metadata/file count.
// Full task and response data remain available through get_session_result.
//
// Mock surface mirrors MetaAgentService.fullResponse.test.ts (enough to import
// MetaAgentService without pulling electron-app / node-pty into the graph).
// buildNotificationMessage takes a plain SessionResultData object directly, so
// no repository mocking is needed beyond making the import succeed.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { list: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: { getFilesBySession: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1], combined: id }),
    tryParse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('../ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: (content: unknown) => (typeof content === 'string' ? content : ''),
  extractUserPrompts: () => ['original task'],
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { SessionFilesRepository } from '@nimbalyst/runtime/storage/repositories/SessionFilesRepository';
import { MetaAgentService, dedupeFilePaths } from '../MetaAgentService';

const PREFETCHED = {
  title: 'Child: research',
  provider: 'claude-code',
  model: 'claude-code:sonnet',
  status: 'idle',
  lastActivity: 1,
  createdAt: 1,
  updatedAt: 2,
  worktreeId: null,
};

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'child-1',
    title: 'Child: research',
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    status: 'idle',
    lastActivity: 1,
    originalPrompt: null as string | null,
    userPrompts: [],
    lastResponse: null,
    fullResponse: null,
    recentMessages: [],
    editedFiles: [],
    pendingPrompt: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 2,
    worktreeId: null,
    toolScope: null,
    ...overrides,
  };
}

describe('MetaAgentService child completion fallback contract (NIM-604)', () => {
  it('keeps get_session_result-equivalent data (SessionResultData.originalPrompt) fully untouched', () => {
    // buildNotificationMessage must not mutate the input result object -- the
    // full originalPrompt remains exactly as constructed for any other reader
    // (get_session_result, UI, session-list) that consumes SessionResultData
    // directly rather than the notification string.
    const service = MetaAgentService.getInstance();
    const longPrompt = 'C'.repeat(5000);
    const result = baseResult({ originalPrompt: longPrompt });

    (service as any).buildNotificationMessage('session:completed', result);

    expect(result.originalPrompt).toBe(longPrompt);
    expect(result.originalPrompt!.length).toBe(5000);
  });
});

describe('MetaAgentService child completion pointer and file bounds (NIM-604)', () => {
  it.each([
    'session:completed',
    'session:error',
    'session:waiting',
    'session:interrupted',
  ] as const)('uses the same bounded pointer branch for %s', (eventType) => {
    const service = MetaAgentService.getInstance();
    const pointer = 'DONE: fixed the bounded update | report: _pending/result.md';
    const message = (service as any).buildNotificationMessage(eventType, baseResult({
      originalPrompt: 'private original task',
      recentMessages: [{ direction: 'output', text: pointer }],
      editedFiles: ['src/private.ts'],
    }));
    expect(message).toContain(`Event: ${eventType}`);
    expect(message).toContain(pointer);
    expect(message).not.toContain('Original task');
    expect(message).not.toContain('Recent messages:');
    expect(message).not.toContain('src/private.ts');
  });

  it('uses metadata and count-only files without child-controlled bodies for invalid pointers', () => {
    const service = MetaAgentService.getInstance();
    const originalPrompt = '\u{1F600}'.repeat(1500);
    const recentMessage = 'private recent child message';
    const lastResponse = 'private last response';
    const message = (service as any).buildNotificationMessage('session:completed', baseResult({
      originalPrompt,
      recentMessages: [{ direction: 'output', text: recentMessage }],
      lastResponse,
      editedFiles: ['src/a.ts', 'src/b.ts'],
    }));
    expect(message).toContain('Event: session:completed');
    expect(message).toContain('Files modified: 2 unique files');
    expect(message).toContain('get_session_result');
    expect(message).not.toContain('Original task');
    expect(message).not.toContain('Recent messages:');
    expect(message).not.toContain(recentMessage);
    expect(message).not.toContain(lastResponse);
    expect(message).not.toContain(originalPrompt);
    expect(message).not.toContain('src/a.ts');
    expect(message).not.toContain('src/b.ts');
  });

  it('suppresses absent-pointer task and message bodies while retaining the result route', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:error', baseResult({
      originalPrompt: 'private original task body',
      recentMessages: [{ direction: 'input', text: 'private recent input body' }],
      lastResponse: 'private last response body',
      editedFiles: ['src/private.ts'],
    }));

    expect(message).toContain('Event: session:error');
    expect(message).toContain('Files modified: 1 unique file');
    expect(message).toContain('get_session_result');
    expect(message).not.toContain('private original task body');
    expect(message).not.toContain('private recent input body');
    expect(message).not.toContain('private last response body');
  });

  it('rejects malformed or overlong pointer-looking final lines', () => {
    const service = MetaAgentService.getInstance();
    for (const candidate of [
      'DONE: this prose has no report pointer',
      `DONE: short | report: _pending/result.md | note: ${'x'.repeat(500)}`,
      'DONE | report: ',
    ]) {
      const message = (service as any).buildNotificationMessage('session:completed', baseResult({
        originalPrompt: 'fallback task',
        recentMessages: [{ direction: 'output', text: candidate }],
      }));
      expect(message).not.toContain('Original task: fallback task');
      expect(message).not.toContain(candidate);
      expect(message).not.toContain('Recent messages:');
    }
  });

  it('deduplicates repeated edit paths in first-seen order before every consumer reads them', () => {
    expect(dedupeFilePaths(['src/a.ts', 'src/a.ts', 'src/b.ts', 'src/a.ts']))
      .toEqual(['src/a.ts', 'src/b.ts']);
    expect(dedupeFilePaths([])).toEqual([]);
  });

  it('deduplicates edit events before get_session_result and notification consumers receive them', async () => {
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([] as never);
    vi.mocked(SessionFilesRepository.getFilesBySession).mockResolvedValue([
      { filePath: '/ws/src/a.ts' },
      { filePath: '/ws/src/a.ts' },
      { filePath: '/ws/src/b.ts' },
    ] as never);

    const service = MetaAgentService.getInstance();
    const data = await (service as any).buildSessionResultData('child-files', '/ws', PREFETCHED, false);
    expect(data.editedFiles.map((file: string) => file.split('\\').join('/')))
      .toEqual(['src/a.ts', 'src/b.ts']);
  });
});
