// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeClaimedRun, selectCoalescibleRun } from '../coalesceQueuedPrompts';
import {
  SessionProcessingGuard,
  dispatchClaimedQueuedPrompt,
  tryClaimAndDispatchNextQueuedPrompt,
  type ClaimedQueuedPrompt,
  type QueuedPromptStoreLike,
} from '../queuedPromptDispatcher';

describe('queuedPromptDispatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])('serializes send-now and FIFO continuation while claiming (drain bypass: %s)', async (bypass) => {
    vi.useFakeTimers();
    let pending: ClaimedQueuedPrompt[] = [
      { id: 'agent', prompt: 'agent follow-up' },
      // A slash command always opens its own turn, so this row stays a second dispatch.
      { id: 'human', prompt: '/compact' },
    ];
    let releaseClaim!: () => void;
    let claimStarted!: () => void;
    const started = new Promise<void>((resolve) => { claimStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [...pending]),
      claim: vi.fn(async (id) => {
        const row = pending.find((prompt) => prompt.id === id) ?? null;
        pending = pending.filter((prompt) => prompt.id !== id);
        if (id === 'agent') {
          claimStarted();
          await blocked;
        }
        return row;
      }),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const processingSet = new SessionProcessingGuard();
    const sendMessageHandler = vi.fn(async () => ({ content: 'ok' }));
    const options = {
      queueStore, processingSet, sendMessageHandler,
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(), logInfo: vi.fn(), onPromptClaimed: vi.fn(),
      startSession: vi.fn(async () => {}),
      targetWindow: { isDestroyed: () => false, webContents: { mainFrame: {} } } as unknown as Electron.BrowserWindow,
      sessionId: 'session', workspacePath: '/workspace', source: 'send-now',
      canBypassChainGuard: () => bypass,
    };
    const first = tryClaimAndDispatchNextQueuedPrompt(options);
    await started;
    const reserved = processingSet.has('session');
    const competing = await tryClaimAndDispatchNextQueuedPrompt({ ...options, source: 'FIFO continuation' });
    releaseClaim();
    await first;
    await vi.runAllTimersAsync();

    expect(competing).toBe(false);
    expect(reserved).toBe(true);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(pending.map((row) => row.id)).toEqual(['human']);
    expect(processingSet.has('session')).toBe(false);
    expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(true);
    await vi.runAllTimersAsync();
    expect(sendMessageHandler).toHaveBeenCalledTimes(2);
    expect(queueStore.fail).not.toHaveBeenCalled();

    // A storage failure must release the reservation and let a later retry run.
    vi.mocked(queueStore.listPending).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).rejects.toThrow('storage unavailable');
    expect(processingSet.has('session')).toBe(false);
    expect(await tryClaimAndDispatchNextQueuedPrompt(options)).toBe(false);
    expect(processingSet.has('session')).toBe(false);
  });

  it('starts the session before dispatching a claimed queued prompt', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-1',
      prompt: 'continue',
      attachments: null,
      documentContext: { filePath: '/tmp/example.md' } as any,
    };

    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {
        order.push('complete');
      }),
      fail: vi.fn(async () => {
        order.push('fail');
      }),
    };

    const processingSet = new SessionProcessingGuard();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn(() => {
          order.push('promptClaimed');
        }),
        mainFrame: {},
      },
    } as unknown as Electron.BrowserWindow;

    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {
        order.push('continue');
      }),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: ({ sessionId, promptId }) => {
        targetWindow.webContents.send('ai:promptClaimed', { sessionId, promptId });
      },
      processingSet,
      queueStore,
      sendMessageHandler: vi.fn(async () => {
        order.push('sendMessage');
        return { content: 'ok' };
      }),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {
        order.push('startSession');
      }),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    expect(processed).toBe(true);
    expect(order).toEqual(['startSession', 'promptClaimed']);
    expect(processingSet.has('session-1')).toBe(true);

    await vi.runAllTimersAsync();

    expect(order).toEqual(['startSession', 'promptClaimed', 'sendMessage', 'complete', 'continue']);
    expect(processingSet.has('session-1')).toBe(false);
  });

  describe('queue coalescing', () => {
    const agentPrompt = (
      id: string,
      prompt: string,
      provenance: Record<string, unknown> = {},
    ): ClaimedQueuedPrompt => ({
      id,
      prompt,
      attachments: null,
      documentContext: {
        promptProvenance: { actor: 'agent', origin: 'child-session-update', ...provenance },
      } as any,
    });

    // Composer rows carry the composer's mode; agent rows carry none.
    const humanPrompt = (
      id: string,
      prompt: string,
      mode?: 'planning' | 'agent' | 'auto',
    ): ClaimedQueuedPrompt => ({
      id,
      prompt,
      attachments: null,
      documentContext: {
        promptProvenance: { actor: 'human', origin: 'composer' },
        ...(mode && { mode }),
      } as any,
    });

    async function drain(pending: ClaimedQueuedPrompt[]) {
      vi.useFakeTimers();
      const completed: string[] = [];
      const sent: string[] = [];
      const contexts: any[] = [];

      const queueStore: QueuedPromptStoreLike = {
        listPending: vi.fn(async () => pending),
        claim: vi.fn(async (id: string) => pending.find((p) => p.id === id) ?? null),
        complete: vi.fn(async (id: string) => {
          completed.push(id);
        }),
        fail: vi.fn(async () => {}),
      };

      const targetWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), mainFrame: {} },
      } as unknown as Electron.BrowserWindow;

      await tryClaimAndDispatchNextQueuedPrompt({
        continueQueuedPromptChain: vi.fn(async () => {}),
        logError: vi.fn(),
        logInfo: vi.fn(),
        onPromptClaimed: () => {},
        processingSet: new SessionProcessingGuard(),
        queueStore,
        sendMessageHandler: vi.fn(async (_e, message: string, documentContext: unknown) => {
          sent.push(message);
          contexts.push(documentContext);
          return { content: 'ok' };
        }),
        sessionId: 'session-1',
        source: 'test queue',
        startSession: vi.fn(async () => {}),
        targetWindow,
        workspacePath: '/workspace/project',
      });

      await vi.runAllTimersAsync();
      return { completed, sent, contexts };
    }

    // The orchestration bottleneck: N children reporting cost the parent N
    // turns, because the drain took pendingPrompts[0] and nothing else.
    it('merges a run of agent-authored prompts into one turn and completes every row', async () => {
      const { completed, sent } = await drain([
        agentPrompt('a', 'first report'),
        agentPrompt('b', 'second report'),
        agentPrompt('c', 'third report'),
      ]);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('first report');
      expect(sent[0]).toContain('second report');
      expect(sent[0]).toContain('third report');
      expect([...completed].sort()).toEqual(['a', 'b', 'c']);
    });

    // Yogev's queued follow-ups used to cost one turn (and one "send now" press)
    // each, with agent reports in between costing more.
    it('merges user and agent rows into one turn, oldest first', async () => {
      const { completed, sent } = await drain([
        agentPrompt('a', 'agent one'),
        humanPrompt('h', 'user follow-up'),
        agentPrompt('c', 'agent two'),
      ]);

      expect(sent).toHaveLength(1);
      const order = ['agent one', 'user follow-up', 'agent two'].map((text) => sent[0].indexOf(text));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((x, y) => x - y));
      expect([...completed].sort()).toEqual(['a', 'c', 'h']);
    });

    it('merges a user-authored head with the agent rows behind it', async () => {
      const { completed, sent } = await drain([
        humanPrompt('h', 'do the thing'),
        agentPrompt('a', 'agent report'),
      ]);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('do the thing');
      expect(sent[0]).toContain('agent report');
      expect([...completed].sort()).toEqual(['a', 'h']);
    });

    it('labels each message with its author so a report is not read as the user', async () => {
      const { sent } = await drain([
        humanPrompt('h', 'user note'),
        agentPrompt('a', 'child report', { originSessionId: 'child-session-7' }),
        agentPrompt('b', 'no id on this one'),
        {
          id: 's',
          prompt: 'wake up',
          attachments: null,
          documentContext: { promptProvenance: { actor: 'system', origin: 'automation' } } as any,
        },
      ]);

      expect(sent[0]).toContain('Later messages may correct or supersede earlier ones');
      expect(sent[0]).toContain('--- message 1 of 4 (user) ---\nuser note');
      expect(sent[0]).toContain('--- message 2 of 4 (agent: child-session-7) ---\nchild report');
      expect(sent[0]).toContain('--- message 3 of 4 (agent: child-session-update) ---\nno id on this one');
      expect(sent[0]).toContain('--- message 4 of 4 (system) ---\nwake up');
    });

    it('labels a row with no provenance as the user', async () => {
      const { sent } = await drain([
        { id: 'p', prompt: 'plain row', attachments: null, documentContext: null },
        agentPrompt('a', 'agent report'),
      ]);

      expect(sent[0]).toContain('--- message 1 of 2 (user) ---\nplain row');
    });

    it('runs a slash command at the head on its own and leaves the rest pending', async () => {
      const { completed, sent } = await drain([
        humanPrompt('c', '/compact'),
        humanPrompt('h', 'then continue'),
        agentPrompt('a', 'agent report'),
      ]);

      expect(sent).toEqual(['/compact']);
      expect(completed).toEqual(['c']);
    });

    it('ends the run before a slash command in the middle of the queue', async () => {
      const { completed, sent } = await drain([
        agentPrompt('a', 'agent report'),
        humanPrompt('h', 'user note'),
        humanPrompt('c', '  /clear'),
        humanPrompt('d', 'after the command'),
      ]);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('agent report');
      expect(sent[0]).toContain('user note');
      expect(sent[0]).not.toContain('/clear');
      expect([...completed].sort()).toEqual(['a', 'h']);
    });

    it('ends the run at a row that declares a different mode', async () => {
      const { completed, sent, contexts } = await drain([
        humanPrompt('a', 'plan this', 'planning'),
        humanPrompt('b', 'also plan this', 'planning'),
        humanPrompt('c', 'now edit', 'agent'),
        humanPrompt('d', 'after the edit', 'agent'),
      ]);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('also plan this');
      expect(sent[0]).not.toContain('now edit');
      expect([...completed].sort()).toEqual(['a', 'b']);
      expect(contexts[0].mode).toBe('planning');
    });

    // Agent, mobile and automation rows declare no mode: they inherit the
    // session's, so they must not split a user's run, and a later declared mode
    // must still apply to the merged turn.
    it('merges rows that declare no mode and applies a later declared mode to the turn', async () => {
      const { sent, contexts } = await drain([
        agentPrompt('a', 'agent report'),
        humanPrompt('h', 'plan only please', 'planning'),
        agentPrompt('b', 'another report'),
      ]);

      expect(sent).toHaveLength(1);
      expect(contexts[0].mode).toBe('planning');
    });

    it('keeps the head mode when later rows declare none', async () => {
      const { sent, contexts } = await drain([
        humanPrompt('h', 'edit this', 'agent'),
        agentPrompt('a', 'agent report'),
      ]);

      expect(sent).toHaveLength(1);
      expect(contexts[0].mode).toBe('agent');
    });

    // supersedeOpenQuestions only closes questions for a human turn, and the
    // turn takes the head row's provenance.
    it('counts a merged turn as human when any row in it is human, even behind an agent head', async () => {
      const { contexts } = await drain([
        agentPrompt('a', 'agent report', { originSessionId: 'child-1' }),
        humanPrompt('h', 'user answer'),
      ]);

      expect(contexts[0].promptProvenance).toMatchObject({
        actor: 'human',
        origin: 'composer',
        queuedPromptId: 'a',
      });
      expect(contexts[0].queuedPromptId).toBe('a');
    });

    it('keeps agent provenance when the merged run has no human row', async () => {
      const { contexts } = await drain([
        agentPrompt('a', 'one', { originSessionId: 'child-1' }),
        agentPrompt('b', 'two', { originSessionId: 'child-2' }),
      ]);

      expect(contexts[0].promptProvenance).toMatchObject({ actor: 'agent', originSessionId: 'child-1' });
    });

    it('caps a merged turn at 20 rows and leaves the rest pending', async () => {
      const rows = Array.from({ length: 25 }, (_, index) =>
        index % 2 === 0 ? humanPrompt(`r${index}`, `row ${index}`) : agentPrompt(`r${index}`, `row ${index}`),
      );
      const { completed, sent } = await drain(rows);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('[20 messages arrived while you were working');
      expect(sent[0]).toContain('row 19');
      expect(sent[0]).not.toContain('row 20');
      expect(completed).toHaveLength(20);
    });

    it('sends a single row unchanged, without a header or label', async () => {
      const { sent } = await drain([humanPrompt('h', 'just this')]);

      expect(sent).toEqual(['just this']);
    });

    it('delivers the attachments of every merged row with the turn', async () => {
      const { sent, contexts } = await drain([
        { ...humanPrompt('h', 'see image'), attachments: [{ id: 'img-1' }] },
        { ...agentPrompt('a', 'see log'), attachments: [{ id: 'log-1' }] },
      ]);

      expect(sent).toHaveLength(1);
      expect(contexts[0].attachments).toEqual([{ id: 'img-1' }, { id: 'log-1' }]);
    });
  });

  describe('selectCoalescibleRun', () => {
    const row = (id: string, prompt: string, documentContext: any = null) => ({ id, prompt, documentContext });

    it('returns an empty run for an empty queue', () => {
      expect(selectCoalescibleRun([])).toEqual([]);
    });

    it('treats a slash command after whitespace as a slash command', () => {
      expect(selectCoalescibleRun([row('a', ' \n/compact'), row('b', 'next')]).map((r) => r.id)).toEqual(['a']);
    });

    it('honours an explicit batch size', () => {
      const pending = ['a', 'b', 'c'].map((id) => row(id, id));
      expect(selectCoalescibleRun(pending, 2).map((r) => r.id)).toEqual(['a', 'b']);
    });
  });

  describe('mergeClaimedRun', () => {
    it('returns a single row untouched', () => {
      const only = { id: 'a', prompt: 'solo', attachments: null, documentContext: null };
      expect(mergeClaimedRun([only])).toBe(only);
    });

    it('concatenates attachments from every row in order', () => {
      const merged = mergeClaimedRun([
        { id: 'a', prompt: 'one', attachments: [{ id: 'x' }], documentContext: null },
        { id: 'b', prompt: 'two', attachments: null, documentContext: null },
        { id: 'c', prompt: 'three', attachments: [{ id: 'y' }], documentContext: null },
      ]);

      expect(merged.attachments).toEqual([{ id: 'x' }, { id: 'y' }]);
    });
  });

  it('fires onChainSettled when no follow-on prompt is dispatched', async () => {
    vi.useFakeTimers();

    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-1',
      prompt: 'continue',
      attachments: null,
      documentContext: null,
    };

    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };

    const processingSet = new SessionProcessingGuard();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const onChainSettled = vi.fn(async () => {});
    // continueQueuedPromptChain doesn't dispatch a follow-on (no pending prompts).
    const continueQueuedPromptChain = vi.fn(async () => {});

    await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled,
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    await vi.runAllTimersAsync();

    expect(processingSet.has('session-1')).toBe(false);
    expect(onChainSettled).toHaveBeenCalledTimes(1);
    expect(onChainSettled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspacePath: '/workspace/project',
      source: 'test queue',
    });
  });

  // NIM-7428: a turn that ends with settled background work wakes the session
  // with a turn the chain does not own. Settling the chain then ended a running
  // session and woke the parent mid-turn; continuing it sent a second prompt that
  // aborted the wake turn and dropped the task results it carried.
  it('leaves the session to a wake turn the lead started instead of settling or continuing', async () => {
    vi.useFakeTimers();
    const claimedPrompt: ClaimedQueuedPrompt = { id: 'prompt-1', prompt: 'continue', attachments: null, documentContext: null };
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const processingSet = new SessionProcessingGuard();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;
    const continueQueuedPromptChain = vi.fn(async () => {});
    const onChainSettled = vi.fn(async () => {});
    const onAfterSettled = vi.fn(async () => {});

    await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onAfterSettled,
      onChainSettled,
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
      isLeadTurnPending: () => true,
    });
    await vi.runAllTimersAsync();

    expect(queueStore.complete).toHaveBeenCalledWith('prompt-1');
    expect(processingSet.has('session-1')).toBe(false);
    expect(continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(onChainSettled).not.toHaveBeenCalled();
    expect(onAfterSettled).not.toHaveBeenCalled();
  });

  it('dispatches past the guard a draining turn holds, only when its live query can take the prompt', async () => {
    vi.useFakeTimers();
    const claimedPrompt = { id: 'prompt-1', sessionId: 'session-1', prompt: 'follow up', status: 'executing' } as never;
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const processingSet = new SessionProcessingGuard();
    const drainingTurnToken = processingSet.acquire('session-1');
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;
    const sendMessageHandler = vi.fn(async () => ({ content: 'ok' }));
    const dispatch = (canBypassChainGuard: () => boolean) => tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler,
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
      canBypassChainGuard,
    });

    expect(await dispatch(() => false)).toBe(false);
    expect(await dispatch(() => true)).toBe(true);
    await vi.runAllTimersAsync();

    expect(sendMessageHandler).toHaveBeenCalledOnce();
    // The draining turn's later release must not drop the follow-up's guard.
    expect(processingSet.releaseIfOwner('session-1', drainingTurnToken)).toBe(false);
    vi.useRealTimers();
  });

  it('dispatches once to a replacement window when the original window is destroyed', async () => {
    vi.useFakeTimers();

    // Regression: a long guarded/streaming prompt retains its original
    // BrowserWindow. If that renderer dies or reloads, FIFO continuation must
    // not bail just because the passed window is gone — a replacement window
    // for the same workspace should receive the next queued prompt exactly once.
    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-1',
      prompt: 'continue',
      attachments: null,
      documentContext: null,
    };

    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };

    const processingSet = new SessionProcessingGuard();

    // The original window is destroyed (renderer died/reloaded mid-stream).
    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    // The replacement window for the same workspace is live.
    const replacementWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    let dispatchedSender: Electron.WebContents | undefined;
    const sendMessageHandler = vi.fn(async (event: Electron.IpcMainInvokeEvent) => {
      dispatchedSender = event.sender;
      return { content: 'ok' };
    });
    const resolveLiveWindow = vi.fn((_workspacePath: string) => replacementWindow);

    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler,
      resolveLiveWindow,
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow: destroyedWindow,
      workspacePath: '/workspace/project',
    });

    // Without the fix the dispatcher bails on the destroyed window and never
    // resolves a replacement, so nothing is dispatched.
    expect(processed).toBe(true);
    expect(resolveLiveWindow).toHaveBeenCalledWith('/workspace/project');

    await vi.runAllTimersAsync();

    // Exactly-once after the deferred dispatch settles. The replacement
    // window's webContents, not the destroyed original, is the IPC sender.
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(dispatchedSender).toBe(replacementWindow.webContents);
    expect(queueStore.complete).toHaveBeenCalledTimes(1);
    expect(queueStore.fail).not.toHaveBeenCalled();
    expect(processingSet.has('session-1')).toBe(false);
  });

  it('bails (without dispatching) when the window is destroyed and no replacement exists', async () => {
    vi.useFakeTimers();

    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-1',
      prompt: 'continue',
      attachments: null,
      documentContext: null,
    };

    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };

    const processingSet = new SessionProcessingGuard();

    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const sendMessageHandler = vi.fn(async () => ({ content: 'ok' }));

    const processed = await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain: vi.fn(async () => {}),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler,
      resolveLiveWindow: vi.fn(() => null),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow: destroyedWindow,
      workspacePath: '/workspace/project',
    });

    expect(processed).toBe(false);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(queueStore.claim).not.toHaveBeenCalled();
    expect(processingSet.has('session-1')).toBe(false);
  });

  it('does NOT fire onChainSettled when a follow-on prompt is dispatched', async () => {
    vi.useFakeTimers();

    const claimedPrompt: ClaimedQueuedPrompt = {
      id: 'prompt-1',
      prompt: 'continue',
      attachments: null,
      documentContext: null,
    };

    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [claimedPrompt]),
      claim: vi.fn(async () => claimedPrompt),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };

    const processingSet = new SessionProcessingGuard();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const onChainSettled = vi.fn(async () => {});
    // continueQueuedPromptChain dispatches a follow-on by re-adding to processingSet.
    const continueQueuedPromptChain = vi.fn(async (sessionId: string) => {
      processingSet.add(sessionId);
    });

    await tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled,
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
      sessionId: 'session-1',
      source: 'test queue',
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    await vi.runAllTimersAsync();

    expect(onChainSettled).not.toHaveBeenCalled();
  });

  it('keeps the guard held for a priority prompt when the dispatch it displaced settles (#1018)', async () => {
    vi.useFakeTimers();

    // #1018: an interrupt drops the processing guard and replaces the in-flight
    // queued prompt with a priority one. The displaced dispatch still has a
    // pending `finally`; when it runs it must not release a guard the priority
    // prompt now owns, or the FIFO continuation claims the next prompt and sends
    // it while the priority turn is still executing.
    const displaced: ClaimedQueuedPrompt = {
      id: 'prompt-displaced',
      prompt: 'displaced',
      attachments: null,
      documentContext: null,
    };
    const priority: ClaimedQueuedPrompt = {
      id: 'prompt-priority',
      prompt: 'priority',
      attachments: null,
      documentContext: null,
    };
    const fifo: ClaimedQueuedPrompt = {
      id: 'prompt-fifo',
      prompt: 'fifo',
      attachments: null,
      documentContext: null,
    };

    let pending: ClaimedQueuedPrompt[] = [displaced];
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => pending),
      claim: vi.fn(async (promptId: string) => {
        const found = pending.find((row) => row.id === promptId) ?? null;
        pending = pending.filter((row) => row.id !== promptId);
        return found;
      }),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };

    const processingSet = new SessionProcessingGuard();
    const targetWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    // Each turn hangs until the test settles it by its prompt text.
    const settleTurn = new Map<string, () => void>();
    const sendMessageHandler = vi.fn(
      async (_event: Electron.IpcMainInvokeEvent, message: string) => {
        await new Promise<void>((resolve) => settleTurn.set(message, resolve));
        return { content: 'ok' };
      },
    );

    const continueQueuedPromptChain = vi.fn(
      async (
        sessionId: string,
        _workspacePath: string,
        _window: Electron.BrowserWindow,
        source: string,
      ) => {
        await tryClaimAndDispatchNextQueuedPrompt({
          ...dispatchOptions(),
          logInfo: vi.fn(),
          sessionId,
          source,
        });
      },
    );

    const onAfterSettled = vi.fn(async () => {});
    const dispatchOptions = () => ({
      continueQueuedPromptChain,
      onAfterSettled,
      logError: vi.fn(),
      onPromptClaimed: () => {},
      processingSet,
      queueStore,
      sendMessageHandler,
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath: '/workspace/project',
    });

    const flush = async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    };

    // The ordinary FIFO dispatch takes the guard and starts its turn.
    await tryClaimAndDispatchNextQueuedPrompt({
      ...dispatchOptions(),
      logInfo: vi.fn(),
      sessionId: 'session-1',
      source: 'initial',
    });
    await flush();
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);

    // The interrupt drops the guard, then the priority prompt takes it.
    processingSet.delete('session-1');
    await dispatchClaimedQueuedPrompt({
      ...dispatchOptions(),
      claimed: priority,
      sessionId: 'session-1',
      source: 'priority',
    });
    await flush();
    expect(sendMessageHandler).toHaveBeenCalledTimes(2);
    expect(processingSet.has('session-1')).toBe(true);

    // A FIFO prompt lands behind the priority turn; the displaced dispatch now
    // settles and runs its `finally`.
    pending = [fifo];
    settleTurn.get('displaced')!();
    await flush();

    // The priority turn still owns the guard, so the FIFO prompt stays queued.
    expect(processingSet.has('session-1')).toBe(true);
    expect(queueStore.claim).not.toHaveBeenCalledWith('prompt-fifo');
    expect(sendMessageHandler).toHaveBeenCalledTimes(2);
    expect(onAfterSettled).not.toHaveBeenCalled();

    // Once the priority turn settles it releases its own guard, and the FIFO
    // prompt is claimed by the normal continuation.
    settleTurn.get('priority')!();
    await flush();
    expect(queueStore.claim).toHaveBeenCalledWith('prompt-fifo');
    expect(sendMessageHandler).toHaveBeenCalledTimes(3);

    settleTurn.get('fifo')!();
    await vi.runAllTimersAsync();
    expect(processingSet.has('session-1')).toBe(false);
  });
});
