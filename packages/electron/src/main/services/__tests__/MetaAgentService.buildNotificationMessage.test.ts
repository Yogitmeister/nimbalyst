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

describe('MetaAgentService.buildNotificationMessage real-world pointer signal grammar (NIM-604, CC review repair)', () => {
  // These forms are grepped from actual usage in this workspace, not
  // invented -- the recognizer's first cut only matched the brief's literal
  // template and never matched any of them in production.
  it('recognizes a bracketed-session-tag DONE signal with commit + session fields', () => {
    const service = MetaAgentService.getInstance();
    const signal =
      '[efb4f366] DONE: fixed the queue drain bug | file: src/queue.ts | commit: eeb8f0f | session: efb4f366-9fed-44e6-8250-65c7179f85fa';
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: 'Fix the queue drain bug',
      recentMessages: [{ direction: 'output', text: signal }],
    });

    expect(message).toContain(signal);
    expect(message).not.toContain('Original task:');
  });

  it('recognizes a report:/notion: signal with no file: or session: field at all', () => {
    const service = MetaAgentService.getInstance();
    const signal =
      'DONE: migration complete | report: _pending/migration-report.md | notion: https://notion.so/workspace/page-abc123';
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      recentMessages: [{ direction: 'output', text: signal }],
    });

    expect(message).toContain(signal);
  });

  it('recognizes a BLOCKED ON signal with a report: pointer', () => {
    const service = MetaAgentService.getInstance();
    const signal = 'BLOCKED ON: waiting for API credentials | report: _pending/api-blocker.md';
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      recentMessages: [{ direction: 'output', text: signal }],
    });

    expect(message).toContain(signal);
  });

  it('recognizes CONSULTED and GATE-STOPPED status words from the child-brief template convention', () => {
    const service = MetaAgentService.getInstance();
    for (const signal of [
      'CONSULTED: got a second opinion | report: _pending/consult-notes.md',
      'GATE-STOPPED: waiting on Manual Gate review | report: _pending/gate-status.md',
    ]) {
      const message = (service as any).buildNotificationMessage('session:completed', {
        ...BASE_RESULT,
        recentMessages: [{ direction: 'output', text: signal }],
      });
      expect(message).toContain(signal);
    }
  });

  it('recognizes the minimal file:-only form with no session field', () => {
    const service = MetaAgentService.getInstance();
    const signal = 'DONE: reconciliation complete | file: _pending/x.md';
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      recentMessages: [{ direction: 'output', text: signal }],
    });

    expect(message).toContain(signal);
  });

  it('keeps recognizing the original brief-literal form', () => {
    const service = MetaAgentService.getInstance();
    const signal = 'DONE | file: report.md | session: abc-123';
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      recentMessages: [{ direction: 'output', text: signal }],
    });

    expect(message).toContain(signal);
  });

  // Prose false-positive controls -- ordinary chatty wrap-ups must NOT be
  // mistaken for a signal just because they start with the right word.
  it('does not treat plain prose starting with "Done" as a signal (no pipe at all)', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: 'Investigate the flaky test',
      recentMessages: [{ direction: 'output', text: 'Done for now, nothing else to check today.' }],
    });

    expect(message).toContain('Original task: Investigate the flaky test');
  });

  it('does not treat a message merely mentioning "done" mid-sentence as a signal', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: 'Review the PR',
      recentMessages: [{ direction: 'output', text: 'All tests pass and the review is done. Nothing else to add.' }],
    });

    expect(message).toContain('Original task: Review the PR');
  });

  it('does not treat BLOCKED prose lacking the ON:/report:/file: structure as a signal', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: 'Deploy the service',
      recentMessages: [{ direction: 'output', text: 'BLOCKED -- need your input on which environment to target.' }],
    });

    expect(message).toContain('Original task: Deploy the service');
  });

  it('rejects a signal-shaped line whose summary text before the pointer field is too long', () => {
    // Proof of rejection is "Original task:" surviving -- once
    // extractChildPointerSignal declines to treat this as a signal, the
    // line falls through to the ordinary fallback path, where the
    // pre-existing (NIM-427, out of scope here) recentMessages echo -- not
    // this test -- governs whether/how much of it is later shown, capped in
    // production by extractRecentMessages's real 2,000-char cap, which this
    // synthetic recentMessages array deliberately bypasses.
    const service = MetaAgentService.getInstance();
    const overlong = `DONE: ${'padding '.repeat(80)}| file: report.md`;
    expect(overlong.length).toBeGreaterThan(500);

    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: 'Long-running child task',
      recentMessages: [{ direction: 'output', text: overlong }],
    });

    expect(message).toContain('Original task: Long-running child task');
  });

  it('rejects an otherwise well-formed signal whose overall line exceeds the length cap', () => {
    // Structurally valid prefix (short summary, real file: pointer with a
    // non-empty value) but the line keeps going past the pointer field --
    // the regex alone has no trailing $ anchor, so only the explicit
    // length gate in extractChildPointerSignal catches this case. Same
    // rejection proof as above: "Original task:" surviving means the
    // fallback path was taken, not the signal-preferred path.
    const service = MetaAgentService.getInstance();
    const overlong = `DONE: short summary | file: report.md | note: ${'x'.repeat(480)}`;
    expect(overlong.length).toBeGreaterThan(500);

    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: 'Another long-running child task',
      recentMessages: [{ direction: 'output', text: overlong }],
    });

    expect(message).toContain('Original task: Another long-running child task');
  });
});
