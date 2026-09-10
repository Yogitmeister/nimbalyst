// [ASTRA-ORCH]
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionProcessingGuard,
  dispatchClaimedQueuedPrompt,
  tryClaimAndDispatchNextQueuedPrompt,
  type ClaimedQueuedPrompt,
  type QueuedPromptStoreLike,
} from '../queuedPromptDispatcher';
import {
  createPriorityPromptDeliveryService,
  type PriorityControlPrompt,
  type PriorityInterruptReceipt,
  type PriorityTargetState,
} from '../../PriorityPromptDeliveryService';

describe('queuedPromptDispatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
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

  describe('agent-authored coalescing', () => {
    const agentPrompt = (id: string, prompt: string): ClaimedQueuedPrompt => ({
      id,
      prompt,
      attachments: null,
      documentContext: {
        promptProvenance: { actor: 'agent', origin: 'child-session-update' },
      } as any,
    });

    const humanPrompt = (id: string, prompt: string): ClaimedQueuedPrompt => ({
      id,
      prompt,
      attachments: null,
      documentContext: {
        promptProvenance: { actor: 'human', origin: 'composer' },
      } as any,
    });

    async function drain(pending: ClaimedQueuedPrompt[]) {
      vi.useFakeTimers();
      const completed: string[] = [];
      const sent: string[] = [];

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
        sendMessageHandler: vi.fn(async (_e, message: string) => {
          sent.push(message);
          return { content: 'ok' };
        }),
        sessionId: 'session-1',
        source: 'test queue',
        startSession: vi.fn(async () => {}),
        targetWindow,
        workspacePath: '/workspace/project',
      });

      await vi.runAllTimersAsync();
      return { completed, sent };
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

    // A human message is a hard boundary: it must never be silently folded in
    // with agent chatter, and nothing behind it may be pulled forward.
    it('stops the run at a human-authored prompt', async () => {
      const { completed, sent } = await drain([
        agentPrompt('a', 'agent one'),
        humanPrompt('h', 'stop and do this instead'),
        agentPrompt('c', 'agent two'),
      ]);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toBe('agent one');
      expect(sent[0]).not.toContain('stop and do this instead');
      expect(completed).toEqual(['a']);
    });

    it('leaves a human-authored head as its own turn', async () => {
      const { completed, sent } = await drain([
        humanPrompt('h', 'do the thing'),
        agentPrompt('a', 'agent report'),
      ]);

      expect(sent).toEqual(['do the thing']);
      expect(completed).toEqual(['h']);
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
    // continueQueuedPromptChain dispatches a follow-on by replacing the lease.
    const continueQueuedPromptChain = vi.fn(async (sessionId: string) => {
      processingSet.acquire(sessionId);
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

    const dispatchOptions = () => ({
      continueQueuedPromptChain,
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

  it('dispatches an ordinary prompt exactly once when post-turn drains race', async () => {
    vi.useFakeTimers();
    const queued: ClaimedQueuedPrompt = {
      id: 'ordinary-after-active-turn', prompt: 'continue after the current turn',
      attachments: null, documentContext: null,
    };
    let claimed = false;
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => claimed ? [] : [queued]),
      claim: vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return queued;
      }),
      complete: vi.fn(async () => {}), fail: vi.fn(async () => {}),
    };
    const processingSet = new SessionProcessingGuard();
    const targetWindow = {
      isDestroyed: () => false, webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;
    const sendMessageHandler = vi.fn(async () => ({ content: 'ok' }));
    const options = {
      continueQueuedPromptChain: vi.fn(async () => {}), logError: vi.fn(), logInfo: vi.fn(),
      onPromptClaimed: vi.fn(), processingSet, queueStore, sendMessageHandler,
      sessionId: 'session-1', source: 'completion-handler queue',
      startSession: vi.fn(async () => {}), targetWindow, workspacePath: '/workspace/project',
    };

    const results = await Promise.all([
      tryClaimAndDispatchNextQueuedPrompt(options),
      tryClaimAndDispatchNextQueuedPrompt(options),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await vi.runAllTimersAsync();
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(queueStore.complete).toHaveBeenCalledTimes(1);
  });

  it('keeps a replacement control lease when the real priority path interrupts an ordinary dispatch', async () => {
    const sessionId = 'priority-handoff-session';
    const workspacePath = '/workspace/project';
    const deferred = <T = void>() => {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
    const ordinaryStarted = deferred();
    const priorityStarted = deferred();
    const ordinaryTurn = deferred<void>();
    const priorityTurn = deferred<void>();
    const processingSet = new SessionProcessingGuard();
    const acquireSpy = vi.spyOn(processingSet, 'acquire');
    const ordinary: ClaimedQueuedPrompt = { id: 'ordinary-1', prompt: 'ordinary work' };
    const control: ClaimedQueuedPrompt = {
      id: 'control-1', prompt: 'priority control', deliveryReady: false,
    };
    const queueRows = new Map<string, { prompt: ClaimedQueuedPrompt; status: string }>([
      [ordinary.id, { prompt: ordinary, status: 'pending' }],
      [control.id, { prompt: control, status: 'pending' }],
    ]);
    const controlRow: PriorityControlPrompt = {
      id: control.id, sessionId, status: 'pending', deliveryClass: 'control', priorityRank: 100,
      deliveryReady: false, interruptTargetGeneration: null, interruptReservationOwner: null,
      interruptReceipt: null,
    };
    const running: PriorityTargetState = {
      status: 'running', generation: 'running:10:20', lastActivity: 10, updatedAt: 20,
    };
    const queueStore: QueuedPromptStoreLike = {
      listPending: vi.fn(async () => [...queueRows.values()]
        .filter((row) => row.status === 'pending' && row.prompt.deliveryReady !== false)
        .map((row) => row.prompt)
        .sort((a, b) => (b.id === control.id ? 1 : 0) - (a.id === control.id ? 1 : 0))),
      claim: vi.fn(async (promptId) => {
        const row = queueRows.get(promptId);
        if (!row || row.status !== 'pending') return null;
        row.status = 'executing';
        return row.prompt;
      }),
      complete: vi.fn(async (promptId) => { queueRows.get(promptId)!.status = 'completed'; }),
      fail: vi.fn(async (promptId) => { queueRows.get(promptId)!.status = 'failed'; }),
    };
    const targetWindow = {
      isDestroyed: () => false, webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;
    const continueQueuedPromptChain = vi.fn(async () => {});
    const dispatch = (source: string) => tryClaimAndDispatchNextQueuedPrompt({
      continueQueuedPromptChain,
      logError: vi.fn(),
      logInfo: vi.fn(),
      onPromptClaimed: vi.fn(),
      processingSet,
      queueStore,
      sendMessageHandler: vi.fn(async (_event, message) => {
        if (message === ordinary.prompt) {
          ordinaryStarted.resolve();
          await ordinaryTurn.promise;
        } else {
          priorityStarted.resolve();
          await priorityTurn.promise;
        }
        return { content: message };
      }),
      sessionId,
      source,
      startSession: vi.fn(async () => {}),
      targetWindow,
      workspacePath,
    });

    await expect(dispatch('ordinary dispatch')).resolves.toBe(true);
    await ordinaryStarted.promise;
    const ordinaryLease = acquireSpy.mock.results[0]?.value;
    expect(ordinaryLease).toBeDefined();

    const priorityService = createPriorityPromptDeliveryService({
      createControlPrompt: vi.fn(async () => ({ row: controlRow, replayed: false })),
      getTargetState: vi.fn(async () => running),
      hasStructuredPendingPrompt: vi.fn(async () => false),
      reserveInterrupt: vi.fn(async ({ generation, owner }) => {
        controlRow.interruptTargetGeneration = generation;
        controlRow.interruptReservationOwner = owner;
        return { row: controlRow, reserved: true };
      }),
      recordInterruptReceipt: vi.fn(async ({ receipt }: { receipt: PriorityInterruptReceipt }) => {
        controlRow.interruptReceipt = receipt;
        controlRow.deliveryReady = receipt.success;
        control.deliveryReady = receipt.success;
        return controlRow;
      }),
      // This is the AI interruption seam used by the real delivery service:
      // it revokes the active dispatcher guard before control delivery is triggered.
      interruptCurrentTurn: vi.fn(async () => {
        processingSet.delete(sessionId);
        return { success: true, method: 'native-interrupt', nativeEntered: true };
      }),
      triggerProcessing: vi.fn(async () => dispatch('priority delivery')),
      getControlPrompt: vi.fn(async () => controlRow),
      createControlPromptId: () => control.id,
      createReservationOwner: () => 'priority-owner',
    });

    await expect(priorityService.deliver({
      sessionId,
      workspacePath,
      prompt: control.prompt,
      idempotencyKey: 'handoff-1',
      producer: 'send_prompt_now:test',
      controlOperation: 'operator_directive',
      interruptWaitingForInput: false,
    })).resolves.toMatchObject({ action: 'interrupt_attempted', processingTriggerAccepted: true });
    await priorityStarted.promise;

    const replacementLease = acquireSpy.mock.results[1]?.value;
    expect(replacementLease).toBeDefined();
    expect(replacementLease).not.toBe(ordinaryLease);

    // The ordinary deferred send settles only after the priority service has
    // installed its replacement lease. Its finally must become a no-op.
    ordinaryTurn.reject(new Error('interrupted ordinary turn'));
    await vi.waitFor(() => expect(queueStore.fail).toHaveBeenCalledWith(ordinary.id, 'interrupted ordinary turn'));
    expect(processingSet.releaseIfOwner(sessionId, ordinaryLease!)).toBe(false);
    expect(processingSet.has(sessionId)).toBe(true);
    expect(continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(queueRows.get(control.id)?.status).toBe('executing');

    priorityTurn.resolve();
    await vi.waitFor(() => expect(queueStore.complete).toHaveBeenCalledWith(control.id));
    expect(processingSet.has(sessionId)).toBe(false);
    expect(continueQueuedPromptChain).toHaveBeenCalledTimes(1);
  });
});
