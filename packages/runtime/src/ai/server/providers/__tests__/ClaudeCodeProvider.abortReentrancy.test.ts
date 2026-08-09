import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/**
 * NIM-591 regression coverage for the reentrancy fix in ClaudeCodeProvider's
 * sendMessage() turn lifecycle (local-capture abortController + identity-
 * checked finally + turnSettled) and BaseAgentProvider's waitForCurrentTurnSettled().
 *
 * These tests drive the REAL sendMessage() generator (not a reimplementation).
 * To keep the harness light, most cases omit `workspacePath`, which makes
 * sendMessage() throw its own "workspacePath is required" error very early --
 * AFTER turn-start (abortController/turnSettled setup) but BEFORE buildSdkOptions()
 * / the SDK's query(). That thrown error is caught internally and yielded as an
 * `{type:'error'}` chunk, so the first `.next()` call reaches a real, stable
 * pause point: turn-start has run, but THIS call's own finally has not yet.
 * Draining the generator the rest of the way runs the finally block for real.
 *
 * Tests that need to reach buildSdkOptions()/query() (stall watchdog, the
 * claudeSettingsEnvLoader await window) provide a workspacePath and mock the
 * SDK's `query` export instead.
 */

const { queryMock, spawnMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  spawnMock: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import { ClaudeCodeDeps } from '../claudeCode/dependencyInjection';
import { buildSdkOptions } from '../claudeCode/sdkOptionsBuilder';

vi.mock('../claudeCode/sdkOptionsBuilder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claudeCode/sdkOptionsBuilder')>();
  return { ...actual, buildSdkOptions: vi.fn(actual.buildSdkOptions) };
});

type ProviderInternals = {
  abortController: AbortController | null;
  leadQuery: ControlledQuery | null;
  mcpQuery: ControlledQuery | null;
  currentSessionId: string | undefined;
  mcpServerStatuses: Map<string, {
    name: string;
    status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  }>;
  mcpStatusesLastCheckedAt: number | null;
  turnSettled: Promise<void>;
  waitForCurrentTurnSettled(timeoutMs?: number): Promise<'settled' | 'timeout'>;
  captureCurrentTurnTermination(): {
    id: string;
    waitForTermination(timeoutMs: number): Promise<'terminated' | 'timeout'>;
    hardClose(reason: string): void;
    acquireSettlementHold(): { release(): void };
  } | null;
  captureLatestTurnTermination(): {
    id: string;
    waitForTermination(timeoutMs: number): Promise<'terminated' | 'timeout'>;
    hardClose(reason: string): void;
    acquireSettlementHold(): { release(): void };
  } | null;
  hasExactSerializedReplacementAdmission(): boolean;
  isTurnCurrentForSettlement(turnId: string): boolean;
  getHardRecoveryProviderType(turnId: string): 'claude-code' | null;
};

function internals(provider: ClaudeCodeProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

async function makeProvider(): Promise<ClaudeCodeProvider> {
  const provider = new ClaudeCodeProvider();
  await provider.initialize({ model: 'claude-code:haiku' });
  return provider;
}

const originalBuildSdkOptions = vi.mocked(buildSdkOptions).getMockImplementation()!;

class ControlledProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    this.killed = true;
    this.signalCode = signal;
    return true;
  });

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }

  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

type ControlledQuery = {
  close: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator](): ControlledQuery;
};

function createControlledQuery(): ControlledQuery {
  let closed = false;
  let resolveNext: ((value: IteratorResult<unknown, void>) => void) | null = null;
  const controlled: ControlledQuery = {
    close: vi.fn(() => {
      closed = true;
      resolveNext?.({ done: true, value: undefined });
    }),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    next: vi.fn(() => {
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise<IteratorResult<unknown, void>>((resolve) => {
        resolveNext = resolve;
      });
    }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return controlled;
}

function installControlledSdk(): {
  processes: ControlledProcess[];
  queries: ControlledQuery[];
} {
  const processes: ControlledProcess[] = [];
  const queries: ControlledQuery[] = [];
  vi.mocked(buildSdkOptions).mockImplementation(async (...args) => {
    const result = await originalBuildSdkOptions(...args);
    result.options.spawnClaudeCodeProcess = () => {
      const child = new ControlledProcess();
      processes.push(child);
      return child as any;
    };
    return result;
  });
  queryMock.mockImplementation(({ options }) => {
    options.spawnClaudeCodeProcess({
      command: 'controlled-claude',
      args: [],
      cwd: '/tmp/nim591-workspace',
      env: {},
      signal: new AbortController().signal,
    });
    const controlled = createControlledQuery();
    queries.push(controlled);
    return controlled;
  });
  return { processes, queries };
}

function installDefaultLocalSpawn(child: ControlledProcess): {
  queries: ControlledQuery[];
  spawnSignal: AbortSignal;
} {
  const queries: ControlledQuery[] = [];
  const spawnSignal = new AbortController().signal;
  spawnMock.mockReturnValue(child as any);
  queryMock.mockImplementation(({ options }) => {
    options.spawnClaudeCodeProcess({
      command: 'default-local-claude',
      args: ['--sdk-test'],
      cwd: '/tmp/nim591-default-spawn',
      env: { NIM591_DEFAULT_SPAWN: '1' },
      signal: spawnSignal,
    });
    const controlled = createControlledQuery();
    queries.push(controlled);
    return controlled;
  });
  return { queries, spawnSignal };
}

/**
 * Poll a condition on a tight (1ms) real-timer step. Deliberately NOT
 * `vi.waitFor` -- that polls on a ~50ms-default real-timer interval, slower
 * than the 20ms NIMBALYST_CC_STREAM_STALL_MS window these tests use, so it
 * could observe state AFTER the stall timer already fired instead of
 * before/during the intended race window. Also deliberately NOT a pure
 * `await Promise.resolve()` microtask loop -- buildSdkOptions() does real
 * async work that needs actual event-loop turns (e.g. fs/timer-bound), and a
 * microtask-only loop starves those out indefinitely (observed empirically:
 * it never completed within a 1000-tick budget). A 1ms real timer step
 * yields to the full event loop (microtasks, I/O callbacks, and timers)
 * every iteration, so it reliably observes state changes from either kind of
 * async work while still resolving fast relative to the 20ms stall window.
 */
async function waitForCondition(check: () => boolean, maxWaitMs = 5000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('waitForCondition: condition never became true within the time budget');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Fully drain an async generator (runs it to `done: true`, i.e. through its finally). */
async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  // Guard against a genuinely wedged drain hanging the whole test file.
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('drain() timed out -- generator never reached done:true')), 5000)
  );
  await Promise.race([
    (async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await gen.next();
        if (done) return;
      }
    })(),
    timeout,
  ]);
}

/**
 * Starts a turn deliberately missing `workspacePath`, and returns after the
 * FIRST yielded chunk. By that point turn-start (myAbortController capture,
 * this.abortController/this.turnSettled assignment) has already run -- it
 * happens unconditionally before the try block -- but THIS call's own
 * finally has not: the generator is paused sitting on the `yield {type:
 * 'error', ...}` statement inside the catch block, deep inside the same
 * try/finally that turn-start feeds into.
 */
function startTurnPausedAfterSetup(provider: ClaudeCodeProvider, message: string, sessionId: string) {
  const gen = provider.sendMessage(message, undefined, sessionId, [], undefined, []) as AsyncGenerator<{
    type: string;
  }>;
  return gen;
}

afterEach(() => {
  queryMock.mockReset();
  spawnMock.mockReset();
  vi.mocked(buildSdkOptions).mockReset();
  vi.mocked(buildSdkOptions).mockImplementation(originalBuildSdkOptions);
  ClaudeCodeDeps.claudeSettingsEnvLoader = null;
  delete process.env.NIMBALYST_CC_STREAM_STALL_MS;
  vi.restoreAllMocks();
});

describe('ClaudeCodeProvider reentrancy (NIM-591)', () => {
  it('1. replacement turn aborts A but publishes no new controller until A finishes teardown', async () => {
    const provider = await makeProvider();
    const sessionId = 'reentrancy-supersede';

    const genA = startTurnPausedAfterSetup(provider, 'turn A', sessionId);
    await genA.next();
    const controllerA = internals(provider).abortController;
    expect(controllerA).not.toBeNull();

    const genB = startTurnPausedAfterSetup(provider, 'turn B', sessionId);
    const nextB = genB.next();

    await waitForCondition(() => controllerA!.signal.aborted);
    expect(internals(provider).abortController).toBe(controllerA);

    await drain(genA);
    const firstB = await nextB;
    expect(firstB.done).toBe(false);
    const controllerB = internals(provider).abortController;
    expect(controllerB).not.toBeNull();
    expect(controllerB).not.toBe(controllerA);
    expect(controllerB!.signal.aborted).toBe(false);
    expect(internals(provider).abortController).toBe(controllerB);

    await drain(genB);
  });

  it('1b. serializes two simultaneous replacements instead of admitting both behind the same predecessor', async () => {
    const provider = await makeProvider();
    const sessionId = 'reentrancy-fifo-admission';

    const genA = startTurnPausedAfterSetup(provider, 'turn A', sessionId);
    await genA.next();
    const controllerA = internals(provider).abortController;
    expect(controllerA).not.toBeNull();

    const genB = startTurnPausedAfterSetup(provider, 'turn B', sessionId);
    const genC = startTurnPausedAfterSetup(provider, 'turn C', sessionId);
    const nextB = genB.next();
    const nextC = genC.next();
    let cAdmitted = false;
    void nextC.then(() => { cAdmitted = true; });

    await waitForCondition(() => controllerA!.signal.aborted);
    expect(internals(provider).abortController).toBe(controllerA);

    await drain(genA);
    await nextB;
    const controllerB = internals(provider).abortController;
    expect(controllerB).not.toBeNull();
    expect(controllerB).not.toBe(controllerA);

    // C may now signal B, but it remains behind B's settlement and cannot
    // publish its own controller yet.
    await waitForCondition(() => controllerB!.signal.aborted);
    expect(cAdmitted).toBe(false);
    expect(internals(provider).abortController).toBe(controllerB);

    await drain(genB);
    await nextC;
    const controllerC = internals(provider).abortController;
    expect(controllerC).not.toBeNull();
    expect(controllerC).not.toBe(controllerB);
    expect(controllerC!.signal.aborted).toBe(false);

    await drain(genC);
  });

  it('2. CORE REGRESSION: a superseded turn\'s finally must not null out a newer turn\'s controller', async () => {
    const provider = await makeProvider();
    const sessionId = 'reentrancy-finally-identity';

    // Turn A: reach turn-start, pause before A's own finally runs.
    const genA = startTurnPausedAfterSetup(provider, 'turn A', sessionId);
    await genA.next();
    const controllerA = internals(provider).abortController;

    // The serialized start gate prevents a real B from publishing before A's
    // finally. Repoint the shared field directly to retain focused coverage of
    // the identity-safe cleanup invariant against any external/future writer.
    const controllerB = new AbortController();
    internals(provider).abortController = controllerB;

    // Drive A the rest of the way to completion now -- this is what runs
    // A's finally block, AFTER B has already repointed the shared field.
    await drain(genA);

    // The regression this guards: a finally that unconditionally did
    // `this.abortController = null` (instead of identity-checking against
    // its own local capture) would clobber B's live controller here.
    expect(internals(provider).abortController).toBe(controllerB);
    expect(internals(provider).abortController).not.toBeNull();

    provider.abort();
    expect(internals(provider).abortController).toBeNull();
  });

  it("5a. waitForCurrentTurnSettled resolves 'settled' once the turn's finally block runs", async () => {
    const provider = await makeProvider();
    const sessionId = 'turn-settled-resolves';

    const gen = startTurnPausedAfterSetup(provider, 'turn A', sessionId);
    await gen.next(); // turn-start done; finally has not run yet

    const waiter = internals(provider).waitForCurrentTurnSettled(5000);
    let settled = false;
    void waiter.then(() => { settled = true; });

    // Flush a few microtasks: must NOT have settled before finally runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    await drain(gen); // runs the finally block -> resolveTurnSettled()

    await expect(waiter).resolves.toBe('settled');
  });

  it("5b. waitForCurrentTurnSettled resolves 'timeout' (not indefinitely) when the turn never settles in time", async () => {
    const provider = await makeProvider();
    const sessionId = 'turn-settled-timeout';

    const gen = startTurnPausedAfterSetup(provider, 'turn A', sessionId);
    await gen.next(); // turn-start done; finally deliberately left un-run

    await expect(internals(provider).waitForCurrentTurnSettled(20)).resolves.toBe('timeout');

    // Cleanup: don't leave a live generator dangling past the test.
    await drain(gen);
  });

  it('5c. fails closed after the bounded start wait instead of spawning over a wedged predecessor', async () => {
    const provider = await makeProvider();
    const sessionId = 'turn-start-timeout';

    const genA = startTurnPausedAfterSetup(provider, 'turn A', sessionId);
    await genA.next();
    const controllerA = internals(provider).abortController;
    expect(controllerA).not.toBeNull();

    const genB = startTurnPausedAfterSetup(provider, 'turn B', sessionId);
    await expect(genB.next()).rejects.toThrow(
      'Previous turn did not terminate and release its settlement hold within 3000ms; replacement turn was not started',
    );

    expect(controllerA!.signal.aborted).toBe(true);
    expect(internals(provider).abortController).toBe(controllerA);
    expect(queryMock).not.toHaveBeenCalled();

    await drain(genA);
  }, 10_000);

  it('5d. B and C cannot call query() until the exact predecessor process exit event', async () => {
    const { processes, queries } = installControlledSdk();
    const provider = await makeProvider();
    const sessionId = 'process-exit-fifo';

    const genA = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextA = genA.next();
    await waitForCondition(() => queries.length === 1 && processes.length === 1);

    const genB = provider.sendMessage(
      'turn B', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextB = genB.next();
    await waitForCondition(() => queries[0].close.mock.calls.length === 1);
    await nextA;
    const drainA = drain(genA);

    await Promise.resolve();
    expect(queryMock).toHaveBeenCalledTimes(1);
    processes[0].emitExit();
    await drainA;
    await waitForCondition(() => queries.length === 2 && processes.length === 2);

    const genC = provider.sendMessage(
      'turn C', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextC = genC.next();
    await waitForCondition(() => queries[1].close.mock.calls.length === 1);
    await nextB;
    const drainB = drain(genB);

    await Promise.resolve();
    expect(queryMock).toHaveBeenCalledTimes(2);
    processes[1].emitExit();
    await drainB;
    await waitForCondition(() => queries.length === 3 && processes.length === 3);

    provider.abort();
    await nextC;
    const drainC = drain(genC);
    processes[2].emitExit();
    await drainC;
  }, 15_000);

  it('5e. a terminated provider finally is insufficient: replacement timeout spawns nothing until OS exit', async () => {
    const { processes, queries } = installControlledSdk();
    const provider = await makeProvider();
    const sessionId = 'process-exit-timeout';

    const genA = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextA = genA.next();
    await waitForCondition(() => queries.length === 1 && processes.length === 1);

    const genB = provider.sendMessage(
      'turn B', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextB = genB.next();
    await waitForCondition(() => queries[0].close.mock.calls.length === 1);
    await nextA;
    const drainA = drain(genA);

    await expect(nextB).rejects.toThrow(
      'Previous turn did not terminate and release its settlement hold within 3000ms; replacement turn was not started',
    );
    expect(queryMock).toHaveBeenCalledTimes(1);

    processes[0].emitExit();
    await drainA;
  }, 10_000);

  it('5f. hardClose targets the captured query and sends SIGKILL to its exact process', async () => {
    const { processes, queries } = installControlledSdk();
    const provider = await makeProvider();
    const sessionId = 'hard-close-exact-process';
    const gen = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const next = gen.next();
    await waitForCondition(() => queries.length === 1 && processes.length === 1);

    const handle = internals(provider).captureCurrentTurnTermination();
    expect(handle).not.toBeNull();
    handle!.hardClose('test-recovery');

    expect(queries[0].close).toHaveBeenCalledTimes(1);
    expect(processes[0].kill).toHaveBeenCalledWith('SIGKILL');
    await next;
    const draining = drain(gen);
    processes[0].emitExit(null, 'SIGKILL');
    await draining;
    await expect(handle!.waitForTermination(100)).resolves.toBe('terminated');
  });

  it('5g. production local spawn forwards the SDK contract, decodes stderr, and hard-recovers before generator finish', async () => {
    const child = new ControlledProcess(4321);
    const { queries, spawnSignal } = installDefaultLocalSpawn(child);
    const stderrWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = await makeProvider();
    const sessionId = 'default-local-spawn-hard-close';
    const gen = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const next = gen.next();
    await waitForCondition(() => queries.length === 1);

    expect(spawnMock).toHaveBeenCalledWith(
      'default-local-claude',
      ['--sdk-test'],
      expect.objectContaining({
        cwd: '/tmp/nim591-default-spawn',
        env: { NIM591_DEFAULT_SPAWN: '1' },
        signal: spawnSignal,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );

    const euro = Buffer.from('€');
    child.stderr.write(euro.subarray(0, 1));
    child.stderr.write(euro.subarray(1));
    await waitForCondition(() => stderrWarn.mock.calls.some(
      ([message]) => String(message).includes('€'),
    ));

    const handle = internals(provider).captureCurrentTurnTermination();
    expect(handle).not.toBeNull();
    handle!.hardClose('default-spawn-recovery');
    expect(queries[0].close).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(handle!.waitForTermination(10)).resolves.toBe('timeout');

    // Do not drain (or even await the first yielded chunk) before the process
    // receipt. The hard-detached lifecycle must terminate independently of
    // sendMessage reaching its ordinary finish() path.
    child.emitExit(null, 'SIGKILL');
    await expect(handle!.waitForTermination(20)).resolves.toBe('timeout');
    child.stderr.emit('close');
    await expect(handle!.waitForTermination(100)).resolves.toBe('terminated');

    await next;
    await drain(gen);
  });

  it('5h. production local spawn treats a pre-pid spawn error as an exact terminal receipt', async () => {
    const child = new ControlledProcess();
    const { queries } = installDefaultLocalSpawn(child);
    const provider = await makeProvider();
    const gen = provider.sendMessage(
      'turn A', undefined, 'default-local-spawn-error', [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const next = gen.next();
    await waitForCondition(() => queries.length === 1);
    const handle = internals(provider).captureCurrentTurnTermination();
    expect(handle).not.toBeNull();

    (queries[0].close as () => void)();
    await next;
    const draining = drain(gen);
    await Promise.resolve();
    child.emit('error', new Error('spawn failed before pid'));

    await draining;
    await expect(handle!.waitForTermination(100)).resolves.toBe('terminated');
    expect(child.exitCode).toBeNull();
    expect(child.pid).toBeUndefined();
  });

  it('5h2. production local spawn matches the SDK stderr-drain exit ceiling', async () => {
    const child = new ControlledProcess(4322);
    const { queries } = installDefaultLocalSpawn(child);
    const provider = await makeProvider();
    const gen = provider.sendMessage(
      'turn A', undefined, 'default-local-spawn-drain-ceiling', [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const next = gen.next();
    await waitForCondition(() => queries.length === 1);
    const handle = internals(provider).captureCurrentTurnTermination();

    handle!.hardClose('stderr-drain-ceiling');
    child.emitExit(null, 'SIGKILL');
    await expect(handle!.waitForTermination(50)).resolves.toBe('timeout');
    // Pinned SDK 0.3.221 waits for stderr close but caps that wait at 200ms.
    // Leave stderr open: the mirrored ceiling must still surface exact exit.
    await expect(handle!.waitForTermination(500)).resolves.toBe('terminated');
    await next;
    await drain(gen);
  });

  it('5i. exact normal exit clears and emits the user-facing MCP status cache', async () => {
    const { processes, queries } = installControlledSdk();
    const provider = await makeProvider();
    const sessionId = 'normal-exit-mcp-truth';
    const statusEvents: any[] = [];
    provider.on('mcpServerStatus:changed', (event) => statusEvents.push(event));
    const gen = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const next = gen.next();
    await waitForCondition(() => queries.length === 1 && processes.length === 1);

    const state = internals(provider);
    state.mcpQuery = queries[0];
    state.currentSessionId = sessionId;
    state.mcpServerStatuses = new Map([[
      'memory', { name: 'memory', status: 'connected' },
    ]]);
    state.mcpStatusesLastCheckedAt = 123;

    (queries[0].close as () => void)();
    await next;
    const draining = drain(gen);
    await Promise.resolve();
    expect(provider.getMcpSessionStatus()).toMatchObject({
      servers: [{ name: 'memory', status: 'connected' }],
      lastCheckedAt: 123,
    });
    processes[0].emitExit();
    await draining;

    expect(provider.getMcpSessionStatus()).toMatchObject({
      servers: [],
      lastCheckedAt: null,
    });
    expect(statusEvents).toContainEqual(expect.objectContaining({
      sessionId,
      servers: [],
      lastCheckedAt: null,
    }));
  });

  it('5j. hard exit clears its own MCP cache but exact exit from an older query cannot clobber a newer query', async () => {
    const { processes, queries } = installControlledSdk();
    const provider = await makeProvider();
    const sessionId = 'hard-exit-mcp-truth';
    const statusEvents: any[] = [];
    provider.on('mcpServerStatus:changed', (event) => statusEvents.push(event));
    const gen = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const next = gen.next();
    await waitForCondition(() => queries.length === 1 && processes.length === 1);

    const state = internals(provider);
    state.mcpQuery = queries[0];
    state.currentSessionId = sessionId;
    state.mcpServerStatuses = new Map([[
      'memory', { name: 'memory', status: 'connected' },
    ]]);
    state.mcpStatusesLastCheckedAt = 456;
    const handle = state.captureCurrentTurnTermination();
    handle!.hardClose('mcp-hard-exit');
    processes[0].emitExit(null, 'SIGKILL');
    await expect(handle!.waitForTermination(100)).resolves.toBe('terminated');
    expect(state.captureCurrentTurnTermination()).toBeNull();
    expect(provider.getMcpSessionStatus()).toMatchObject({ servers: [], lastCheckedAt: null });
    expect(statusEvents).toContainEqual(expect.objectContaining({
      sessionId,
      servers: [],
      lastCheckedAt: null,
    }));
    await next;
    await drain(gen);

    state.mcpQuery = queries[0];
    state.currentSessionId = 'newer-session';
    state.mcpServerStatuses = new Map([[
      'crossed-session-memory', { name: 'crossed-session-memory', status: 'connected' },
    ]]);
    state.mcpStatusesLastCheckedAt = 700;
    (provider as any).clearMcpStatusForTerminatedQuery(queries[0], sessionId);
    expect(provider.getMcpSessionStatus()).toMatchObject({
      servers: [{ name: 'crossed-session-memory', status: 'connected' }],
      lastCheckedAt: 700,
    });
    expect(state.currentSessionId).toBe('newer-session');

    const newerQuery = createControlledQuery();
    state.mcpQuery = newerQuery;
    state.currentSessionId = 'newer-session';
    state.mcpServerStatuses = new Map([[
      'newer-memory', { name: 'newer-memory', status: 'connected' },
    ]]);
    state.mcpStatusesLastCheckedAt = 789;
    // Replaying the old query's identity-scoped cleanup is a no-op.
    (provider as any).clearMcpStatusForTerminatedQuery(queries[0], sessionId);
    expect(provider.getMcpSessionStatus()).toMatchObject({
      servers: [{ name: 'newer-memory', status: 'connected' }],
      lastCheckedAt: 789,
    });
    expect(state.mcpQuery).toBe(newerQuery);
    expect(state.currentSessionId).toBe('newer-session');
  });

  it('5j2. failed hard kill keeps MCP status until an exact later exit proves teardown', async () => {
    const { processes, queries } = installControlledSdk();
    const provider = await makeProvider();
    const sessionId = 'hard-kill-failure-mcp-truth';
    const gen = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const next = gen.next();
    await waitForCondition(() => queries.length === 1 && processes.length === 1);
    const state = internals(provider);
    state.mcpQuery = queries[0];
    state.currentSessionId = sessionId;
    state.mcpServerStatuses = new Map([[
      'memory', { name: 'memory', status: 'connected' },
    ]]);
    state.mcpStatusesLastCheckedAt = 654;
    processes[0].kill.mockImplementationOnce(() => {
      throw new Error('SIGKILL failed');
    });
    const handle = state.captureCurrentTurnTermination();

    handle!.hardClose('failed-kill-truth');
    await expect(handle!.waitForTermination(20)).resolves.toBe('timeout');
    expect(provider.getMcpSessionStatus()).toMatchObject({
      servers: [{ name: 'memory', status: 'connected' }],
      lastCheckedAt: 654,
    });

    processes[0].emitExit(null, 'SIGKILL');
    await expect(handle!.waitForTermination(100)).resolves.toBe('terminated');
    expect(provider.getMcpSessionStatus()).toMatchObject({ servers: [], lastCheckedAt: null });
    await next;
    await drain(gen);
  });

  it('5k. a settlement hold keeps B behind A through hardClose and the retired provider never publishes B', async () => {
    const { processes, queries } = installControlledSdk();
    const provider = await makeProvider();
    const sessionId = 'hard-close-b-waiting';
    const genA = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextA = genA.next();
    await waitForCondition(() => queries.length === 1 && processes.length === 1);
    const handleA = internals(provider).captureCurrentTurnTermination();
    expect(handleA).not.toBeNull();
    const settlementHold = handleA!.acquireSettlementHold();

    const genB = provider.sendMessage(
      'turn B', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextB = genB.next();
    await waitForCondition(() => queries[0].close.mock.calls.length === 1);

    handleA!.hardClose('B is already waiting at FIFO');
    processes[0].emitExit(null, 'SIGKILL');
    await expect(handleA!.waitForTermination(100)).resolves.toBe('terminated');
    await Promise.resolve();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(internals(provider).captureCurrentTurnTermination()).toBeNull();
    expect(internals(provider).getHardRecoveryProviderType(handleA!.id)).toBe('claude-code');

    settlementHold.release();
    await expect(nextB).rejects.toThrow('Provider was retired after hard recovery');
    expect(queryMock).toHaveBeenCalledTimes(1);

    await nextA;
    await drain(genA);
  });

  it('5k1b. captureLatestTurnTermination fallback on a hard-retired turn is harmless -- acquire/release still succeeds and nothing ever waits on it', async () => {
    // NIM-591 pressure-test finding (DeepSeek Flash): does AIService's null-capture fallback
    // (captureCurrentTurnTermination() ?? captureLatestTurnTermination()) ever acquire a hold on
    // an ALREADY HARD-RETIRED turn, and if so is that hold ever stuck / does anything assume a
    // retired provider has zero holds? Reuses 5k's exact retirement trigger (hardClose while a
    // replacement is already waiting at FIFO) then exercises the fallback capture independently.
    const { processes, queries } = installControlledSdk();
    const provider = await makeProvider();
    const sessionId = 'hard-retired-fallback-capture';
    const genA = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextA = genA.next();
    await waitForCondition(() => queries.length === 1 && processes.length === 1);
    const handleA = internals(provider).captureCurrentTurnTermination();
    expect(handleA).not.toBeNull();
    const originalHold = handleA!.acquireSettlementHold();

    const genB = provider.sendMessage(
      'turn B', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextB = genB.next();
    await waitForCondition(() => queries[0].close.mock.calls.length === 1);

    handleA!.hardClose('retiring A while B waits, for the fallback-capture pressure-test');
    processes[0].emitExit(null, 'SIGKILL');
    await expect(handleA!.waitForTermination(100)).resolves.toBe('terminated');
    await Promise.resolve();
    // Retirement confirmed (mirrors 5k): the active capture is null, but the provider is now
    // hard-retired -- any future turn start throws before it would ever wait on our fallback hold.
    expect(internals(provider).captureCurrentTurnTermination()).toBeNull();

    // The claim under test: AIService's fallback ordering
    // (captureCurrentTurnTermination() ?? captureLatestTurnTermination()) still resolves to
    // handleA -- the retired turn -- rather than null, so beginQueueSettlement can still acquire
    // *a* hold (even though nothing will ever contend it, since startSerializedTurn's
    // hardRetiredTurnId check throws before it would reach previousTurn.waitForAdmission()).
    const fallbackCapture =
      internals(provider).captureCurrentTurnTermination() ?? internals(provider).captureLatestTurnTermination();
    expect(fallbackCapture).toBe(handleA);

    const fallbackHold = fallbackCapture!.acquireSettlementHold();
    // Acquiring and releasing a second hold on an already-retired, already-terminated turn must
    // not throw and must not hang -- it is inert bookkeeping, not a live fence, once retired.
    expect(() => fallbackHold.release()).not.toThrow();

    originalHold.release();
    await expect(nextB).rejects.toThrow('Provider was retired after hard recovery');

    await nextA;
    await drain(genA);
  });

  it('5k2. a normal exited A remains the FIFO predecessor until its settlement sweep releases the hold', async () => {
    const { processes, queries } = installControlledSdk();
    const provider = await makeProvider();
    const sessionId = 'normal-exit-settlement-hold';
    const genA = provider.sendMessage(
      'turn A', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextA = genA.next();
    await waitForCondition(() => queries.length === 1 && processes.length === 1);
    const handleA = internals(provider).captureCurrentTurnTermination();
    const settlementHold = handleA!.acquireSettlementHold();

    (queries[0].close as () => void)();
    await nextA;
    const drainingA = drain(genA);
    processes[0].emitExit();
    await drainingA;
    await expect(handleA!.waitForTermination(100)).resolves.toBe('terminated');
    expect(internals(provider).captureCurrentTurnTermination()).toBeNull();
    expect(internals(provider).isTurnCurrentForSettlement(handleA!.id)).toBe(true);

    const genB = provider.sendMessage(
      'turn B', undefined, sessionId, [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const nextB = genB.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(queryMock).toHaveBeenCalledTimes(1);

    settlementHold.release();
    await waitForCondition(() => queries.length === 2 && processes.length === 2);
    expect(internals(provider).isTurnCurrentForSettlement(handleA!.id)).toBe(false);
    provider.abort();
    await nextB;
    const drainingB = drain(genB);
    processes[1].emitExit();
    await drainingB;
  });

  it('5k3. captureLatestTurnTermination exposes the FIFO predecessor even after captureCurrentTurnTermination goes null on natural exit', async () => {
    const provider = await makeProvider();
    const sessionId = 'latest-turn-termination-fallback';

    // Before any turn has ever started, there is genuinely nothing to
    // fence -- both captures agree on null.
    expect(internals(provider).captureCurrentTurnTermination()).toBeNull();
    expect(internals(provider).captureLatestTurnTermination()).toBeNull();

    const gen = startTurnPausedAfterSetup(provider, 'turn A', sessionId);
    await gen.next();
    const handle = internals(provider).captureCurrentTurnTermination();
    expect(handle).not.toBeNull();
    expect(internals(provider).captureLatestTurnTermination()).toBe(handle);

    await drain(gen);
    // A clean finish clears the "actively running" capture...
    expect(internals(provider).captureCurrentTurnTermination()).toBeNull();
    // ...but NOT the FIFO-predecessor capture: it is the same identity
    // startSerializedTurn() fences the next admission against, and
    // AIService's null-capture settlement path (NIM-591) depends on it
    // still being reachable here to acquire a settlement hold.
    expect(internals(provider).captureLatestTurnTermination()).toBe(handle);
  });

  it('5l. hardClose before SDK spawn terminates exactly and seals every late-spawn path', async () => {
    let releaseSettings!: () => void;
    let loaderEntered = false;
    ClaudeCodeDeps.claudeSettingsEnvLoader = async () => {
      loaderEntered = true;
      await new Promise<void>((resolve) => { releaseSettings = resolve; });
      return {};
    };
    const provider = await makeProvider();
    const gen = provider.sendMessage(
      'turn A', undefined, 'hard-close-before-spawn', [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const next = gen.next();
    await waitForCondition(() => loaderEntered);
    const handle = internals(provider).captureCurrentTurnTermination();
    expect(handle).not.toBeNull();

    handle!.hardClose('pre-spawn recovery');
    await expect(handle!.waitForTermination(100)).resolves.toBe('terminated');
    expect(internals(provider).captureCurrentTurnTermination()).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();

    releaseSettings();
    await next;
    await drain(gen);
    expect(queryMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('5l2. hardClose settles a defensive Query-present/process-absent turn exactly', async () => {
    const queryWithoutProcess = createControlledQuery();
    queryMock.mockReturnValue(queryWithoutProcess);
    const provider = await makeProvider();
    const gen = provider.sendMessage(
      'turn A', undefined, 'query-without-process', [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const next = gen.next();
    await waitForCondition(() => queryMock.mock.calls.length === 1);
    const handle = internals(provider).captureCurrentTurnTermination();
    expect(handle).not.toBeNull();

    handle!.hardClose('defensive lazy-spawn recovery');

    expect(queryWithoutProcess.close).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(handle!.waitForTermination(100)).resolves.toBe('terminated');
    await next;
    await drain(gen);
  });

  it('5m. a setup error immediately after FIFO admission still finishes and clears the exact turn', async () => {
    const provider = await makeProvider();
    (provider as any).createToolHooksService = vi.fn(() => {
      throw new Error('post-admission setup failed');
    });
    const gen = provider.sendMessage(
      'turn A', undefined, 'post-admission-setup-error', [], '/tmp/nim591-workspace', [],
    ) as AsyncGenerator<{ type: string }>;
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: 'error' });
    const handle = internals(provider).captureCurrentTurnTermination();
    expect(handle).not.toBeNull();

    await drain(gen);
    await expect(handle!.waitForTermination(100)).resolves.toBe('terminated');
    expect(internals(provider).captureCurrentTurnTermination()).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('3. stall watchdog targets only its own turn\'s controller, never a newer superseding turn\'s', async () => {
    process.env.NIMBALYST_CC_STREAM_STALL_MS = '20';
    // A query iterator whose next() never resolves -- the stall watchdog is
    // the ONLY thing that can ever move this turn forward. Count next() calls
    // so the test can synchronize on "A is genuinely inside the stall race"
    // rather than just "A's turn-start ran" (turn-start happens much earlier,
    // well before buildSdkOptions()/query() -- syncing on it would let B
    // supersede before A ever reaches the loop, in which case A would exit
    // via the ORDINARY top-of-loop abort check and never reach the stall
    // watchdog code at all, silently making this test pass for the wrong
    // reason regardless of whether the watchdog's own fix is present).
    let iteratorNextCallCount = 0;
    queryMock.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          iteratorNextCallCount += 1;
          return new Promise(() => {});
        },
      }),
    });

    const provider = await makeProvider();
    const sessionId = 'stall-watchdog-session';

    const genA = provider.sendMessage('turn A', undefined, sessionId, [], '/tmp/nim591-workspace', []) as AsyncGenerator<{
      type: string;
    }>;
    const nextA = genA.next(); // fired; won't resolve until the 20ms stall timer wins the race

    // Wait until A has actually entered the race (iterator.next() called,
    // which arms the stall timer synchronously in the same tick) before
    // letting B touch anything. This is well after turn-start, which runs
    // much earlier.
    await waitForCondition(() => iteratorNextCallCount >= 1);
    const controllerA = internals(provider).abortController;
    expect(controllerA).not.toBeNull();

    // Simulate another owner of the shared field while A remains parked. A's
    // watchdog must still target its local controller, never this replacement.
    const controllerB = new AbortController();
    internals(provider).abortController = controllerB;

    // Let A's stall watchdog actually fire (~20ms) and unwind.
    await nextA;

    // Core assertion: the stall watchdog's `myAbortController.abort()` call
    // reads A's OWN local capture. If it had instead read `this.abortController`
    // (the shared, now-repointed field), B's controller would be aborted here.
    expect(controllerB!.signal.aborted).toBe(false);
    expect(internals(provider).abortController).toBe(controllerB);

    await drain(genA);
    provider.abort();
  });

  it("4. the claudeSettingsEnvLoader() await window: A's SDK options end up wired to A's OWN controller, not B's", async () => {
    const sessionId = 'settings-env-window-session';
    let releaseA: (() => void) | null = null;
    let loaderCallCount = 0;
    ClaudeCodeDeps.claudeSettingsEnvLoader = async () => {
      loaderCallCount += 1;
      if (loaderCallCount === 1) {
        // A's call lands first (textually before B even starts) -- suspend
        // here until the test explicitly releases it. This IS the exact
        // await window the regression targets: turn-start has already run
        // (this.abortController = A's controller), but buildSdkOptions()
        // has not been reached yet.
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
      }
      return {};
    };

    const provider = await makeProvider();

    const genA = provider.sendMessage('turn A', undefined, sessionId, [], '/tmp/nim591-workspace', []) as AsyncGenerator<{
      type: string;
    }>;
    const nextA = genA.next(); // fired; suspends inside claudeSettingsEnvLoader()

    await waitForCondition(() => loaderCallCount >= 1);
    const controllerA = internals(provider).abortController;
    expect(controllerA).not.toBeNull();

    // Simulate a future/external field writer while A is suspended in this
    // exact await window. The real reentrant send path is now serialized.
    const controllerB = new AbortController();
    internals(provider).abortController = controllerB;

    // Release A's paused await; A now resumes and proceeds toward buildSdkOptions().
    expect(releaseA).not.toBeNull();
    releaseA!();
    await nextA; // A errors out downstream (query() is a bare mock) -- irrelevant to this assertion

    expect(vi.mocked(buildSdkOptions)).toHaveBeenCalledTimes(1);
    const [depsPassedToA] = vi.mocked(buildSdkOptions).mock.calls[0];
    // The regression this guards: if A's setup re-read `this.abortController`
    // after the await instead of using its own local capture, this would be
    // controllerB (wrong turn's controller wired into the SDK options).
    expect(depsPassedToA.abortController).toBe(controllerA);
    expect(depsPassedToA.abortController).not.toBe(controllerB);

    await drain(genA);
    provider.abort();
  });
});
