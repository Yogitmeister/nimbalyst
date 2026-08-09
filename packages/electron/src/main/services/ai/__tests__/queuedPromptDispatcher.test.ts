import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionPromptDispatchPreflight,
  dispatchClaimedQueuedPrompt,
  tryClaimAndDispatchNextQueuedPrompt,
  type ClaimedQueuedPrompt,
  type QueuedPromptStoreLike,
} from '../queuedPromptDispatcher';
import { runQueueAwareSessionSettlement } from '../MessageStreamingHandler';

const settled = { outcome: 'settled' as const };

function claimed(id = 'prompt-1', prompt = 'continue'): ClaimedQueuedPrompt {
  return { id, prompt, claimToken: `token-${id}`, attachments: null, documentContext: null };
}

function queueStoreFor(row: ClaimedQueuedPrompt): QueuedPromptStoreLike {
  return {
    listPending: vi.fn(async () => [row]),
    claim: vi.fn(async () => row),
    beginDispatch: vi.fn(async () => settled),
    releaseClaim: vi.fn(async () => settled),
    completeAfterDispatch: vi.fn(async () => settled),
    failAfterDispatch: vi.fn(async () => settled),
  };
}

function windowFixture(): Electron.BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn(), mainFrame: {} },
  } as unknown as Electron.BrowserWindow;
}

function optionsFor(queueStore: QueuedPromptStoreLike, overrides: Record<string, unknown> = {}) {
  return {
    claimReservations: new Map<string, symbol>(),
    continueQueuedPromptChain: vi.fn(async () => {}),
    isTurnAdmissionBlocked: vi.fn(() => false),
    logError: vi.fn(),
    logInfo: vi.fn(),
    onChainSettled: vi.fn(async () => {}),
    onPromptClaimed: vi.fn(),
    preflight: vi.fn(async () => true),
    processingLeases: new Map<string, symbol>(),
    queueStore,
    sendMessageHandler: vi.fn(async () => ({ content: 'ok' })),
    sessionDispatchCommitments: new Map<string, symbol>(),
    sessionId: 'session-1',
    source: 'test queue',
    startSession: vi.fn(async () => {}),
    targetWindow: windowFixture(),
    workspacePath: '/workspace/project',
    ...overrides,
  };
}

describe('queuedPromptDispatcher token owner', () => {
  afterEach(() => vi.useRealTimers());

  it('declines a directly supplied claim with no ownership token without a doomed durable release', async () => {
    const row = { ...claimed('direct-missing-token'), claimToken: undefined };
    const store = queueStoreFor(row);
    const options = optionsFor(store);

    await expect(dispatchClaimedQueuedPrompt({
      ...options,
      claimed: row,
      targetWindow: options.targetWindow,
    })).resolves.toBe(false);

    // queueStore.claim() always sets a randomUUID token; this branch is
    // unreachable in production. releaseClaim('') can never match a real
    // row's token, so calling it would only give false confidence that
    // something was cleaned up -- NIM-590 batch item 8.
    expect(store.releaseClaim).not.toHaveBeenCalled();
    expect(options.logError).toHaveBeenCalledWith(
      expect.stringContaining('has no ownership token'),
      expect.any(Error),
    );
    expect(options.startSession).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
  });

  it('persists intent before send and settles the exact token before continuing', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const row = claimed();
    const store = queueStoreFor(row);
    vi.mocked(store.beginDispatch).mockImplementation(async () => {
      order.push('begin');
      return settled;
    });
    vi.mocked(store.completeAfterDispatch).mockImplementation(async () => {
      order.push('complete');
      return settled;
    });
    const options = optionsFor(store, {
      startSession: vi.fn(async () => { order.push('start'); }),
      onPromptClaimed: vi.fn(() => { order.push('notify'); }),
      sendMessageHandler: vi.fn(async () => { order.push('send'); return { content: 'ok' }; }),
      continueQueuedPromptChain: vi.fn(async () => { order.push('continue'); }),
    });

    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    await expect(attempt).resolves.toBe(true);
    expect(order).toEqual(['start', 'notify', 'begin', 'send', 'complete', 'continue']);
    expect(store.beginDispatch).toHaveBeenCalledWith('prompt-1', 'session-1', 'token-prompt-1');
    expect(store.completeAfterDispatch).toHaveBeenCalledWith(
      'prompt-1', 'session-1', 'token-prompt-1',
    );
    expect(options.onChainSettled).toHaveBeenCalledTimes(1);
  });

  it('makes notification best-effort without releasing or wedging the claim', async () => {
    vi.useFakeTimers();
    const store = queueStoreFor(claimed());
    const options = optionsFor(store, {
      onPromptClaimed: vi.fn(() => { throw new Error('destroyed window'); }),
    });
    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    await expect(attempt).resolves.toBe(true);
    expect(options.sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(store.completeAfterDispatch).toHaveBeenCalledTimes(1);
    expect(store.releaseClaim).not.toHaveBeenCalled();
  });

  it('releases the exact undispatched token when session start fails', async () => {
    const row = claimed();
    const store = queueStoreFor(row);
    const options = optionsFor(store, {
      startSession: vi.fn(async () => { throw new Error('start failed'); }),
    });
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).rejects.toThrow('start failed');
    expect(store.releaseClaim).toHaveBeenCalledWith(row.id, 'session-1', row.claimToken);
    expect(store.beginDispatch).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(options.processingLeases.has('session-1')).toBe(false);
  });

  it('releases instead of failing when the production send handler is unavailable', async () => {
    const row = claimed();
    const store = queueStoreFor(row);
    const options = optionsFor(store, { sendMessageHandler: null });
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);
    expect(store.releaseClaim).toHaveBeenCalledWith(row.id, 'session-1', row.claimToken);
    expect(store.beginDispatch).not.toHaveBeenCalled();
  });

  it.each([
    'stale_owner',
    'recovery_blocked',
    'terminal_conflict',
  ] as const)('ends the locally started lifecycle when begin-dispatch returns %s', async (outcome) => {
    vi.useFakeTimers();
    const store = queueStoreFor(claimed());
    vi.mocked(store.beginDispatch).mockResolvedValue({ outcome });
    const options = optionsFor(store);
    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    await expect(attempt).resolves.toBe(false);
    expect(options.startSession).toHaveBeenCalledTimes(1);
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(store.completeAfterDispatch).not.toHaveBeenCalled();
    expect(store.failAfterDispatch).not.toHaveBeenCalled();
    expect(options.continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(options.onChainSettled).toHaveBeenCalledTimes(1);
  });

  it('preserves a replacement lease instead of settling its lifecycle after begin rejection', async () => {
    vi.useFakeTimers();
    const store = queueStoreFor(claimed());
    const processingLeases = new Map<string, symbol>();
    const replacementLease = Symbol('replacement-dispatch');
    vi.mocked(store.beginDispatch).mockImplementation(async () => {
      processingLeases.set('session-1', replacementLease);
      return { outcome: 'stale_owner' };
    });
    const options = optionsFor(store, { processingLeases });

    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    await expect(attempt).resolves.toBe(false);

    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(options.onChainSettled).not.toHaveBeenCalled();
    expect(processingLeases.get('session-1')).toBe(replacementLease);
  });

  it('dispatches once to a replacement window when the original window is destroyed', async () => {
    vi.useFakeTimers();

    // Regression: a long guarded/streaming prompt retains its original
    // BrowserWindow. If that renderer dies or reloads, FIFO continuation must
    // not bail just because the passed window is gone — a replacement window
    // for the same workspace should receive the next queued prompt exactly once.
    const store = queueStoreFor(claimed());

    // The original window is destroyed (renderer died/reloaded mid-stream).
    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    // The replacement window for the same workspace is live.
    const replacementWindow = windowFixture();

    let dispatchedSender: Electron.WebContents | undefined;
    const resolveLiveWindow = vi.fn((_workspacePath: string) => replacementWindow);
    const options = optionsFor(store, {
      targetWindow: destroyedWindow,
      resolveLiveWindow,
      sendMessageHandler: vi.fn(async (event: Electron.IpcMainInvokeEvent) => {
        dispatchedSender = event.sender;
        return { content: 'ok' };
      }),
    });

    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    const processed = await attempt;

    // Without the fix the dispatcher bails on the destroyed window and never
    // resolves a replacement, so nothing is dispatched.
    expect(processed).toBe(true);
    expect(resolveLiveWindow).toHaveBeenCalledWith('/workspace/project');

    // Exactly-once after the deferred dispatch settles. The replacement
    // window's webContents, not the destroyed original, is the IPC sender.
    expect(options.sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(dispatchedSender).toBe(replacementWindow.webContents);
    expect(store.completeAfterDispatch).toHaveBeenCalledTimes(1);
    expect(store.failAfterDispatch).not.toHaveBeenCalled();
    expect(options.processingLeases.has('session-1')).toBe(false);
  });

  it('bails (without dispatching) when the window is destroyed and no replacement exists', async () => {
    vi.useFakeTimers();

    const store = queueStoreFor(claimed());

    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn(), mainFrame: {} },
    } as unknown as Electron.BrowserWindow;

    const options = optionsFor(store, {
      targetWindow: destroyedWindow,
      resolveLiveWindow: vi.fn(() => null),
    });

    const processed = await tryClaimAndDispatchNextQueuedPrompt(options);

    expect(processed).toBe(false);
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(options.processingLeases.has('session-1')).toBe(false);
  });

  it('does NOT fire onChainSettled when a follow-on prompt is dispatched', async () => {
    vi.useFakeTimers();

    const store = queueStoreFor(claimed());
    const onChainSettled = vi.fn(async () => {});
    const processingLeases = new Map<string, symbol>();
    // continueQueuedPromptChain dispatches a follow-on by re-acquiring the lease.
    const continueQueuedPromptChain = vi.fn(async (sessionId: string) => {
      processingLeases.set(sessionId, Symbol('follow-on'));
    });
    const options = optionsFor(store, {
      onChainSettled,
      processingLeases,
      continueQueuedPromptChain,
    });

    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    await attempt;

    expect(onChainSettled).not.toHaveBeenCalled();
  });

  it('fails the same begun token on send error and only then continues', async () => {
    vi.useFakeTimers();
    const row = claimed();
    const store = queueStoreFor(row);
    const options = optionsFor(store, {
      sendMessageHandler: vi.fn(async () => { throw new Error('provider failed'); }),
    });
    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    await attempt;
    expect(store.failAfterDispatch).toHaveBeenCalledWith(
      row.id,
      'provider failed',
      'session-1',
      row.claimToken,
    );
    expect(options.continueQueuedPromptChain).toHaveBeenCalledTimes(1);
  });

  it('settles the local lifecycle after an incompatible begun completion', async () => {
    vi.useFakeTimers();
    const store = queueStoreFor(claimed());
    vi.mocked(store.completeAfterDispatch).mockResolvedValue({ outcome: 'stale_owner' });
    const options = optionsFor(store);
    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.runAllTimersAsync();
    await attempt;
    expect(options.continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(options.onChainSettled).toHaveBeenCalledTimes(1);
  });

  it('preserves a replacement lease after an incompatible begun completion', async () => {
    const store = queueStoreFor(claimed('incompatible-replaced'));
    const processingLeases = new Map<string, symbol>();
    const replacementLease = Symbol('replacement-after-send');
    vi.mocked(store.completeAfterDispatch).mockImplementation(async () => {
      processingLeases.set('session-1', replacementLease);
      return { outcome: 'stale_owner' };
    });
    const options = optionsFor(store, { processingLeases });

    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(true);
    await vi.waitFor(() => expect(store.completeAfterDispatch).toHaveBeenCalledTimes(1));

    expect(options.onChainSettled).not.toHaveBeenCalled();
    expect(options.continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(processingLeases.get('session-1')).toBe(replacementLease);
  });

  it('lets a late same-token owner settle but not continue after its lease was revoked', async () => {
    let finishSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { finishSend = resolve; });
    const row = claimed('owner-a');
    const store = queueStoreFor(row);
    const leases = new Map<string, symbol>();
    const options = optionsFor(store, {
      processingLeases: leases,
      sendMessageHandler: vi.fn(async () => { await sendGate; return { content: 'late' }; }),
    });
    await tryClaimAndDispatchNextQueuedPrompt(options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    leases.set('session-1', Symbol('owner-b'));
    finishSend();
    await vi.waitFor(() => expect(store.completeAfterDispatch).toHaveBeenCalledTimes(1));
    expect(options.continueQueuedPromptChain).not.toHaveBeenCalled();
    expect(leases.has('session-1')).toBe(true);
  });

  it.each([
    ['missing', null],
    ['pending marker', { metadata: { modelChangeReconciliation: { status: 'pending' } } }],
    ['malformed metadata', { metadata: '{not-json' }],
  ])('fails closed before list/claim/send for %s', async (_label, session) => {
    const preflight = createSessionPromptDispatchPreflight(async () => session as any);
    const store = queueStoreFor(claimed());
    const options = optionsFor(store, { preflight });
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);
    expect(store.listPending).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
  });

  it('delegates a marker installed after listing to the atomic claim', async () => {
    const row = claimed('race');
    const store = queueStoreFor(row);
    vi.mocked(store.claim).mockResolvedValue(null);
    const options = optionsFor(store);
    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);
    expect(store.claim).toHaveBeenCalledWith('race', 'session-1', 'test queue');
    expect(store.beginDispatch).not.toHaveBeenCalled();
  });
});

describe('queuedPromptDispatcher claim reservation (NIM-590)', () => {
  afterEach(() => vi.useRealTimers());

  it('admits only one concurrent claim attempt for a session', async () => {
    let resolvePending!: (rows: ClaimedQueuedPrompt[]) => void;
    const pendingGate = new Promise<ClaimedQueuedPrompt[]>((resolve) => {
      resolvePending = resolve;
    });
    const store = queueStoreFor(claimed());
    vi.mocked(store.listPending).mockImplementation(() => pendingGate);
    const claimReservations = new Map<string, symbol>();
    const processingLeases = new Map<string, symbol>();

    const first = tryClaimAndDispatchNextQueuedPrompt(optionsFor(store, {
      claimReservations,
      processingLeases,
    }));
    await vi.waitFor(() => expect(store.listPending).toHaveBeenCalledTimes(1));

    const second = tryClaimAndDispatchNextQueuedPrompt(optionsFor(store, {
      claimReservations,
      processingLeases,
    }));
    expect(second).toBe(first);
    expect(store.listPending).toHaveBeenCalledTimes(1);
    expect(store.claim).not.toHaveBeenCalled();
    expect(processingLeases.has('session-1')).toBe(false);

    resolvePending([]);
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(claimReservations.has('session-1')).toBe(false);
  });

  it.each([
    ['preflight throws', 'preflight', new Error('preflight failed')],
    ['listPending throws', 'listPending', new Error('list failed')],
    ['claim throws', 'claim', new Error('claim failed')],
  ] as const)('releases its reservation when %s', async (_label, seam, error) => {
    const store = queueStoreFor(claimed());
    const claimReservations = new Map<string, symbol>();
    const overrides: Record<string, unknown> = { claimReservations };
    if (seam === 'preflight') {
      overrides.preflight = vi.fn(async () => { throw error; });
    } else {
      vi.mocked(store[seam]).mockRejectedValue(error);
    }

    await expect(tryClaimAndDispatchNextQueuedPrompt(optionsFor(store, overrides))).rejects.toThrow(error.message);
    expect(claimReservations.has('session-1')).toBe(false);
  });

  it.each([
    ['preflight declines', (store: QueuedPromptStoreLike) => ({ preflight: vi.fn(async () => false) })],
    ['nothing is pending', (store: QueuedPromptStoreLike) => {
      vi.mocked(store.listPending).mockResolvedValue([]);
      return {};
    }],
    ['claim is lost', (store: QueuedPromptStoreLike) => {
      vi.mocked(store.claim).mockResolvedValue(null);
      return {};
    }],
  ] as const)('releases its reservation when %s', async (_label, arrange) => {
    const store = queueStoreFor(claimed());
    const claimReservations = new Map<string, symbol>();
    const overrides = arrange(store);

    await expect(tryClaimAndDispatchNextQueuedPrompt(optionsFor(store, {
      claimReservations,
      ...overrides,
    }))).resolves.toBe(false);
    expect(claimReservations.has('session-1')).toBe(false);
  });

  it('hands off from tentative reservation to a distinct active dispatch lease', async () => {
    const store = queueStoreFor(claimed());
    const claimReservations = new Map<string, symbol>();
    const processingLeases = new Map<string, symbol>();
    let finishSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      finishSend = resolve;
    });

    const attempt = tryClaimAndDispatchNextQueuedPrompt(optionsFor(store, {
      claimReservations,
      processingLeases,
      sendMessageHandler: vi.fn(async () => {
        await sendGate;
        return { content: 'ok' };
      }),
    }));
    await expect(attempt).resolves.toBe(true);

    expect(claimReservations.has('session-1')).toBe(false);
    expect(processingLeases.has('session-1')).toBe(true);
    finishSend();
    await vi.waitFor(() => expect(processingLeases.has('session-1')).toBe(false));
  });

  it('releases a DB claim and does not dispatch when cancel revokes the reservation during claim', async () => {
    let resolveClaim!: (row: ClaimedQueuedPrompt) => void;
    const claimGate = new Promise<ClaimedQueuedPrompt>((resolve) => {
      resolveClaim = resolve;
    });
    const row = claimed('cancelled-before-handoff');
    const store = queueStoreFor(row);
    vi.mocked(store.claim).mockImplementation(() => claimGate);
    const claimReservations = new Map<string, symbol>();
    const processingLeases = new Map<string, symbol>();
    const options = optionsFor(store, { claimReservations, processingLeases });

    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.waitFor(() => expect(store.claim).toHaveBeenCalledTimes(1));
    claimReservations.delete('session-1');
    resolveClaim(row);

    await expect(attempt).resolves.toBe(false);
    expect(store.releaseClaim).toHaveBeenCalledWith(row.id, 'session-1', row.claimToken);
    expect(options.startSession).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(processingLeases.has('session-1')).toBe(false);
  });

  it('returns false when cancellation revokes the dispatch lease before durable begin', async () => {
    let finishStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const store = queueStoreFor(claimed('revoked-before-begin'));
    const processingLeases = new Map<string, symbol>();
    const options = optionsFor(store, {
      processingLeases,
      startSession: vi.fn(() => startGate),
    });

    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.waitFor(() => expect(options.startSession).toHaveBeenCalledTimes(1));
    processingLeases.delete('session-1');
    finishStart();

    await expect(attempt).resolves.toBe(false);
    expect(store.beginDispatch).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
  });

  it('declines without a doomed durable release when a claimed row has no token', async () => {
    const row = { ...claimed('missing-token'), claimToken: undefined };
    const store = queueStoreFor(row);
    const options = optionsFor(store);

    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);

    // See the identical case in dispatchClaimedQueuedPrompt -- NIM-590 batch
    // item 8: this branch is unreachable in production, and a durable
    // releaseClaim('') call can never match a real row's token.
    expect(store.releaseClaim).not.toHaveBeenCalled();
    expect(options.logError).toHaveBeenCalledWith(
      expect.stringContaining('has no ownership token'),
      expect.any(Error),
    );
    expect(options.startSession).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
  });

  it('does not let stale cleanup remove a newer reservation', async () => {
    let resolvePending!: (rows: ClaimedQueuedPrompt[]) => void;
    const pendingGate = new Promise<ClaimedQueuedPrompt[]>((resolve) => {
      resolvePending = resolve;
    });
    const store = queueStoreFor(claimed());
    vi.mocked(store.listPending).mockImplementation(() => pendingGate);
    const claimReservations = new Map<string, symbol>();
    const attempt = tryClaimAndDispatchNextQueuedPrompt(optionsFor(store, { claimReservations }));
    await vi.waitFor(() => expect(store.listPending).toHaveBeenCalledTimes(1));

    const replacement = Symbol('newer-reservation');
    claimReservations.set('session-1', replacement);
    resolvePending([]);

    await expect(attempt).resolves.toBe(false);
    expect(claimReservations.get('session-1')).toBe(replacement);
  });

  it('settles direct completion exactly once when a competing reservation finds no dispatchable row', async () => {
    let resolvePending!: (rows: ClaimedQueuedPrompt[]) => void;
    const pendingGate = new Promise<ClaimedQueuedPrompt[]>((resolve) => {
      resolvePending = resolve;
    });
    const store = queueStoreFor(claimed());
    vi.mocked(store.listPending).mockImplementation(() => pendingGate);
    const claimReservations = new Map<string, symbol>();
    const processingLeases = new Map<string, symbol>();
    const options = optionsFor(store, { claimReservations, processingLeases });
    const reservationAttempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.waitFor(() => expect(store.listPending).toHaveBeenCalledTimes(1));

    const endSession = vi.fn(async () => {});
    const settlementPromise = runQueueAwareSessionSettlement({
      hasOtherDeferral: false,
      hasActiveQueueLease: () => processingLeases.has('session-1'),
      hasQueueDispatchAdmission: () =>
        processingLeases.has('session-1') || claimReservations.has('session-1'),
      tryDispatch: () => tryClaimAndDispatchNextQueuedPrompt(optionsFor(store, {
        claimReservations,
        processingLeases,
      })),
      endSession,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(endSession).not.toHaveBeenCalled();
    resolvePending([]);
    await expect(reservationAttempt).resolves.toBe(false);
    await expect(settlementPromise).resolves.toEqual({
      deferred: false,
      dispatched: false,
      activeLease: false,
      admissionBlocked: false,
    });
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(claimReservations.has('session-1')).toBe(false);
    expect(processingLeases.has('session-1')).toBe(false);
  });
});
