import { describe, expect, it, vi } from 'vitest';

// NIM-427: buildNotificationMessage() echoed result.originalPrompt into the
// child-session completion notification with no length cap -- a long parent
// task prompt would echo in full. Guards the 500-char + ellipsis truncation,
// mirrored from extractLastAgentResponse's existing preview-cap convention
// used one line above for the sibling "Last response" field.
//
// Mock surface mirrors MetaAgentService.fullResponse.test.ts (enough to
// import MetaAgentService without pulling electron-app / node-pty into the
// graph). buildNotificationMessage is synchronous and pure over its
// SessionResultData argument, so no repository mocks need real behavior.
vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
  AgentMessagesRepository: { list: vi.fn() },
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
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
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

import { MetaAgentService, dedupeFilePaths } from '../MetaAgentService';

const BASE_RESULT = {
  sessionId: 'child-1',
  title: 'Child task',
  status: 'idle',
  originalPrompt: null as string | null,
  recentMessages: [] as Array<{ direction: string; text: string }>,
  editedFiles: [] as string[],
  toolScope: null,
  errorMessage: null,
  lastResponse: null,
};

describe('MetaAgentService.buildNotificationMessage originalPrompt cap (NIM-427)', () => {
  it('truncates a long originalPrompt to 500 chars with an ellipsis', () => {
    const service = MetaAgentService.getInstance();
    const longPrompt = 'P'.repeat(2000);
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: longPrompt,
    });

    const line = message.split('\n').find((l: string) => l.startsWith('Original task: '));
    expect(line).toBeDefined();
    const echoed = line!.slice('Original task: '.length);
    expect(echoed.length).toBe(503); // 500 + '...'
    expect(echoed.endsWith('...')).toBe(true);
    expect(echoed.startsWith('P'.repeat(500))).toBe(true);
  });

  it('does not truncate or alter a prompt already under the cap', () => {
    const service = MetaAgentService.getInstance();
    const shortPrompt = 'Fix the login bug';
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: shortPrompt,
    });

    expect(message).toContain(`Original task: ${shortPrompt}`);
    expect(message).not.toContain('...');
  });

  it('omits the Original task line entirely when there is no prompt', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: null,
    });

    expect(message).not.toContain('Original task:');
  });
});

describe('dedupeFilePaths (NIM-604)', () => {
  it('collapses repeated identical paths to first-seen order', () => {
    const raw = ['src/a.ts', 'src/a.ts', 'src/b.ts', 'src/a.ts', 'src/c.ts', 'src/b.ts'];
    expect(dedupeFilePaths(raw)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('returns an empty array unchanged', () => {
    expect(dedupeFilePaths([])).toEqual([]);
  });

  it('leaves an already-unique list untouched', () => {
    const raw = ['src/a.ts', 'src/b.ts'];
    expect(dedupeFilePaths(raw)).toEqual(raw);
  });
});

describe('MetaAgentService.buildNotificationMessage child pointer signal (NIM-604)', () => {
  it('prefers a DONE pointer signal and omits original task, recent messages, and edited files', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: 'A'.repeat(2000),
      recentMessages: [
        { direction: 'input', text: 'go fix it' },
        { direction: 'output', text: 'DONE | file: report.md | session: abc-123' },
      ],
      editedFiles: ['src/a.ts', 'src/a.ts', 'src/a.ts'],
    });

    expect(message).toContain('DONE | file: report.md | session: abc-123');
    expect(message).not.toContain('Original task:');
    expect(message).not.toContain('Recent messages:');
    expect(message).not.toContain('Files modified:');
    expect(message).not.toContain('go fix it');
  });

  it('prefers a BLOCKED pointer signal the same way', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      recentMessages: [{ direction: 'output', text: 'BLOCKED | file: notes.md | session: xyz-789' }],
    });

    expect(message).toContain('BLOCKED | file: notes.md | session: xyz-789');
    expect(message).not.toContain('Last response:');
  });

  it('also recognizes a pointer signal via lastResponse when recentMessages is empty', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      recentMessages: [],
      lastResponse: 'DONE | file: report.md | session: abc-123',
    });

    expect(message).toContain('DONE | file: report.md | session: abc-123');
    expect(message).not.toContain('Last response:');
  });

  it('falls back to the bounded summary when the last message is not a pointer signal', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: 'Fix the login bug',
      recentMessages: [{ direction: 'output', text: 'All done, looks good to me!' }],
    });

    expect(message).toContain('Original task: Fix the login bug');
    expect(message).toContain('Recent messages:');
    expect(message).toContain('- Assistant: All done, looks good to me!');
  });

  it('does not treat a signal-shaped line as the signal unless it is the true last line', () => {
    const service = MetaAgentService.getInstance();
    // The pointer shape appears mid-message, not as the final line -- must
    // NOT be treated as a signal (a child mentioning the convention in
    // passing should not suppress the real recap).
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: 'Investigate the flaky test',
      recentMessages: [{ direction: 'output', text: 'DONE | file: x.md | session: y\nOne more thing to check.' }],
    });

    expect(message).toContain('Original task: Investigate the flaky test');
  });
});

describe('MetaAgentService.buildNotificationMessage edited-files dedup + bounded pointer (NIM-604)', () => {
  it('renders a deduped unique-file count, never a repeated path list, when there is no pointer signal', () => {
    // Simulates SessionFilesRepository returning several edit EVENTS for the
    // same file plus one other file -- buildSessionResultData's own call to
    // dedupeFilePaths() is what collapses these before they ever reach
    // buildNotificationMessage; this test drives that same production path.
    const rawEditEvents = ['src/parser.ts', 'src/parser.ts', 'src/parser.ts', 'src/index.ts', 'src/parser.ts'];
    const editedFiles = dedupeFilePaths(rawEditEvents);
    expect(editedFiles).toEqual(['src/parser.ts', 'src/index.ts']);

    const service = MetaAgentService.getInstance();
    const longPrompt = 'X'.repeat(5000);
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: longPrompt,
      editedFiles,
    });

    // Bounded: the 5,000-char prompt is capped, and no file path is echoed
    // (let alone repeated) -- only a unique count with a get_session_result
    // pointer for the detail.
    expect(message.length).toBeLessThan(1000);
    expect(message).toContain('Files modified: 2 unique files');
    expect(message).toContain('get_session_result');
    expect(message).not.toContain('src/parser.ts');
    expect(message).not.toContain('src/index.ts');
    // No duplicated file paths can appear, because none appear at all.
    expect(message.split('src/parser.ts').length - 1).toBe(0);
  });

  it('uses singular "file" for exactly one unique edited file', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      editedFiles: dedupeFilePaths(['src/only.ts', 'src/only.ts']),
    });

    expect(message).toContain('Files modified: 1 unique file ');
  });

  it('omits the Files modified line entirely when nothing was edited', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      editedFiles: [],
    });

    expect(message).not.toContain('Files modified');
  });
});
