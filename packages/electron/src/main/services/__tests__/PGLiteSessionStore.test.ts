import { describe, expect, it, vi } from 'vitest';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';

describe('PGLiteSessionStore archive filters', () => {
  it('filters out sessions that belong to archived worktrees in list()', async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
    };

    const store = createPGLiteSessionStore(db as any);
    await store.list('/workspace');

    expect(queries[0]).toContain('LEFT JOIN worktrees w ON s.worktree_id = w.id');
    expect(queries[0]).toContain('(s.worktree_id IS NULL OR w.is_archived = FALSE OR w.is_archived IS NULL)');
  });

  it('filters out sessions that belong to archived worktrees in search()', async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
    };

    const store = createPGLiteSessionStore(db as any);
    await store.search('/workspace', 'worktree');

    expect(queries[0]).toContain('LEFT JOIN worktrees w ON s.worktree_id = w.id');
    expect(queries[0]).toContain('(s.worktree_id IS NULL OR w.is_archived = FALSE OR w.is_archived IS NULL)');
  });
});

// Regression: under SQLite, `metadata` / `document_context` / `provider_config`
// / `last_document_state` come back from the driver as raw JSON strings, not
// parsed objects. Without normalization at this boundary, downstream callers
// like SessionManager.updateSessionTokenUsage spread `{...session.metadata}`
// and iterate the string character by character into numeric-keyed
// properties; the result is re-serialized and written back, growing the row
// ~9x per write cycle until a single metadata column hits hundreds of MB.
// See the comment on parseJsonColumn in PGLiteSessionStore.
describe('PGLiteSessionStore JSON-column read normalization', () => {
  const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 's1',
    workspace_id: '/ws',
    provider: 'claude-code',
    model: null,
    title: 'Untitled',
    session_type: 'session',
    mode: 'agent',
    agent_role: 'standard',
    created_by_session_id: null,
    parent_session_id: null,
    worktree_id: null,
    worktree_path: null,
    worktree_project_path: null,
    is_archived: false,
    is_pinned: false,
    branched_from_session_id: null,
    branch_point_message_id: null,
    branched_at: null,
    branched_from_provider_session_id: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    last_read_ms: null,
    has_been_named: false,
    draft_input: null,
    document_context: null,
    provider_config: null,
    provider_session_id: null,
    last_document_state: null,
    metadata: '{}',
    ...overrides,
  });

  it('get() returns metadata as a parsed object even when the driver returns a JSON string', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [makeRow({ metadata: '{"tags":["foo"],"phase":"validating","tokenUsage":{"totalTokens":42}}' })],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const session = await store.get('s1');
    expect(session?.metadata).toEqual({
      tags: ['foo'],
      phase: 'validating',
      tokenUsage: { totalTokens: 42 },
    });
    // The crucial guarantee for the corruption bug: spreading metadata
    // must NOT iterate characters of the original string.
    const spread = { ...(session?.metadata as Record<string, unknown>) };
    expect(spread).not.toHaveProperty('0');
    expect(spread).toHaveProperty('tags');
  });

  it('get() falls back to {} when the metadata text is malformed', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [makeRow({ metadata: 'not json' })],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const session = await store.get('s1');
    expect(session?.metadata).toEqual({});
  });

  it('get() refuses to treat a bare JSON string as a metadata object', async () => {
    // `JSON.parse('"foo"')` succeeds but yields a string; spreading that
    // would again hit the char-by-char trap. The normalizer must reject.
    const db = {
      query: vi.fn(async () => ({
        rows: [makeRow({ metadata: '"foo"' })],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const session = await store.get('s1');
    expect(session?.metadata).toEqual({});
  });

  it('get() parses document_context, provider_config, last_document_state from JSON strings', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          makeRow({
            document_context: '{"path":"/foo.md"}',
            provider_config: '{"endpoint":"https://api"}',
            last_document_state: '{"version":2}',
          }),
        ],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const session = await store.get('s1');
    expect(session?.documentContext).toEqual({ path: '/foo.md' });
    expect(session?.providerConfig).toEqual({ endpoint: 'https://api' });
    expect(session?.lastDocumentState).toEqual({ version: 2 });
  });

  // Regression: a session whose AskUserQuestion / GitCommitProposal /
  // ExitPlanMode / ToolPermission / PromptForUserInput prompt was open at
  // the time of a renderer reload could end up with
  // sessionHasPendingInteractivePromptAtom stuck `true`, because the only
  // recovery was a runtime resolve event the new renderer never saw. The
  // fix persists the bit to `metadata.hasPendingPrompt` and surfaces it as
  // `hasPendingInteractivePrompt` so the renderer rehydrates BOTH true and
  // false from the DB on session list refresh.
  it('list() surfaces hasPendingInteractivePrompt from metadata.hasPendingPrompt', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            ...makeRow({
              id: 'with-pending',
              metadata: '{"hasPendingPrompt":true}',
            }),
            child_count: 0,
            effective_updated_at: new Date(0),
          },
          {
            ...makeRow({
              id: 'without-pending',
              metadata: '{"hasPendingPrompt":false}',
            }),
            child_count: 0,
            effective_updated_at: new Date(0),
          },
          {
            ...makeRow({
              id: 'missing-field',
              metadata: '{}',
            }),
            child_count: 0,
            effective_updated_at: new Date(0),
          },
        ],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const list = await store.list('/ws');
    const findById = (id: string) => list.find((s) => s.id === id) as any;
    expect(findById('with-pending').hasPendingInteractivePrompt).toBe(true);
    expect(findById('without-pending').hasPendingInteractivePrompt).toBe(false);
    expect(findById('missing-field').hasPendingInteractivePrompt).toBe(false);
  });

  it('list() returns metadata-derived fields (tags, phase, hasUnread) from JSON-string metadata', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [{
          ...makeRow({
            metadata: '{"tags":["bug-fix","sqlite"],"phase":"validating","hasUnread":true}',
          }),
          child_count: 0,
          effective_updated_at: new Date(0),
        }],
      })),
    };
    const store = createPGLiteSessionStore(db as any);
    const list = await store.list('/ws');
    expect(list[0]?.tags).toEqual(['bug-fix', 'sqlite']);
    expect(list[0]?.phase).toBe('validating');
    expect(list[0]?.hasUnread).toBe(true);
  });
});

describe('PGLiteSessionStore.updateMetadata defense-in-depth', () => {
  it('refuses to merge when metadata.metadata is a string and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      query: vi.fn(async () => ({ rows: [{ metadata: '{}' }] })),
    };
    const store = createPGLiteSessionStore(db as any);
    await store.updateMetadata('s1', { metadata: '{"poison":true}' as any });
    // No UPDATE should have been issued for the metadata column. The only
    // queries that ran were the ensureReady-style precondition queries.
    const updateCalls = db.query.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && /UPDATE\s+ai_sessions\s+SET\s+metadata\s*=/i.test(c[0])
    );
    expect(updateCalls.length).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses an array metadata payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = { query: vi.fn(async () => ({ rows: [{ metadata: '{}' }] })) };
    const store = createPGLiteSessionStore(db as any);
    await store.updateMetadata('s1', { metadata: ['a', 'b'] as any });
    const updateCalls = db.query.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && /UPDATE\s+ai_sessions\s+SET\s+metadata\s*=/i.test(c[0])
    );
    expect(updateCalls.length).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('serializes concurrent shallow metadata patches so recovery and unrelated fields both survive', async () => {
    let storedMetadata = '{}';
    let updateCount = 0;
    let releaseFirstUpdate!: () => void;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let firstUpdateEntered!: () => void;
    const firstUpdateStarted = new Promise<void>((resolve) => {
      firstUpdateEntered = resolve;
    });

    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (/SELECT\s+metadata\s+FROM\s+ai_sessions/i.test(sql)) {
          return { rows: [{ metadata: storedMetadata }] };
        }
        if (/UPDATE\s+ai_sessions\s+SET\s+metadata\s*=/i.test(sql)) {
          updateCount += 1;
          const nextMetadata = String(params[params.length - 1]);
          if (updateCount === 1) {
            firstUpdateEntered();
            await firstUpdateBlocked;
          }
          storedMetadata = nextMetadata;
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const recoveryStore = createPGLiteSessionStore(db as any);
    const unrelatedStore = createPGLiteSessionStore(db as any);

    const recoveryPatch = recoveryStore.updateMetadata('s1', {
      metadata: {
        backgroundAgentRecovery: {
          version: 1,
          tasks: { generation1: { recoveryState: 'claimed' } },
        },
      },
    });
    await firstUpdateStarted;
    const unrelatedPatch = unrelatedStore.updateMetadata('s1', {
      metadata: { phase: 'validating', tags: ['recovery'] },
    });

    // Drain the promise queue while the first write remains blocked. Without
    // per-session serialization, the second caller reads the same stale JSON,
    // writes its patch, and is then overwritten when the first write resumes.
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    releaseFirstUpdate();
    await Promise.all([recoveryPatch, unrelatedPatch]);

    expect(JSON.parse(storedMetadata)).toEqual({
      backgroundAgentRecovery: {
        version: 1,
        tasks: { generation1: { recoveryState: 'claimed' } },
      },
      phase: 'validating',
      tags: ['recovery'],
      activity: expect.any(Array),
    });
  });
});

describe('PGLiteSessionStore metadata authority operations', () => {
  it('serializes tag deltas across store wrappers without losing additions', async () => {
    let storedMetadata = JSON.stringify({ tags: ['alpha'], phase: 'implementing' });
    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (/SELECT\s+metadata\s+FROM\s+ai_sessions/i.test(sql)) {
          return { rows: [{ metadata: storedMetadata }] };
        }
        if (/UPDATE\s+ai_sessions\s+SET\s+metadata\s*=/i.test(sql)) {
          storedMetadata = String(params[1]);
          await Promise.resolve();
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const firstStore = createPGLiteSessionStore(db as any);
    const secondStore = createPGLiteSessionStore(db as any);

    await Promise.all([
      firstStore.updateTags!('s1', { add: ['beta'], remove: [] }),
      secondStore.updateTags!('s1', { add: ['gamma'], remove: [] }),
    ]);

    expect(JSON.parse(storedMetadata)).toEqual({
      tags: ['alpha', 'beta', 'gamma'],
      phase: 'implementing',
    });
  });

  it('claims a Blitz child and parent in one atomic SQL statement', async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (/UPDATE\s+ai_sessions/i.test(sql) && /RETURNING\s+id/i.test(sql)) {
          return { rows: [{ id: 'child-1' }, { id: 'blitz-1' }] };
        }
        return { rows: [] };
      }),
    };
    const store = createPGLiteSessionStore(db as any);

    const result = await store.claimBlitzNameIfChildNotNamed!(
      'child-1',
      'blitz-1',
      'Atomic Blitz title',
    );

    expect(result).toEqual({ childClaimed: true, parentNamed: true });
    const mutationCalls = db.query.mock.calls.filter((call: any[]) =>
      typeof call[0] === 'string' && /UPDATE\s+ai_sessions/i.test(call[0])
    );
    expect(mutationCalls).toHaveLength(1);
    expect(mutationCalls[0][0]).toContain('EXISTS');
  });

  it('does not report a child claim when the atomic Blitz statement fails', async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (/UPDATE\s+ai_sessions/i.test(sql)) throw new Error('store unavailable');
        return { rows: [] };
      }),
    };
    const store = createPGLiteSessionStore(db as any);

    await expect(
      store.claimBlitzNameIfChildNotNamed!('child-1', 'blitz-1', 'Retry me'),
    ).rejects.toThrow('store unavailable');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
