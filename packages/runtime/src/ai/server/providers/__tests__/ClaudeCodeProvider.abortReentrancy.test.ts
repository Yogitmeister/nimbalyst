import { afterEach, describe, expect, it, vi } from 'vitest';

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

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import { ClaudeCodeDeps } from '../claudeCode/dependencyInjection';
import { buildSdkOptions } from '../claudeCode/sdkOptionsBuilder';

vi.mock('../claudeCode/sdkOptionsBuilder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claudeCode/sdkOptionsBuilder')>();
  return { ...actual, buildSdkOptions: vi.fn(actual.buildSdkOptions) };
});

type ProviderInternals = {
  abortController: AbortController | null;
  turnSettled: Promise<void>;
  waitForCurrentTurnSettled(timeoutMs?: number): Promise<'settled' | 'timeout'>;
};

function internals(provider: ClaudeCodeProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

async function makeProvider(): Promise<ClaudeCodeProvider> {
  const provider = new ClaudeCodeProvider();
  await provider.initialize({ model: 'claude-code:haiku' });
  return provider;
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
  vi.mocked(buildSdkOptions).mockClear();
  ClaudeCodeDeps.claudeSettingsEnvLoader = null;
  delete process.env.NIMBALYST_CC_STREAM_STALL_MS;
  vi.restoreAllMocks();
});

describe('ClaudeCodeProvider reentrancy (NIM-591)', () => {
  it('1. reentrant call supersedes correctly: B aborts A\'s controller, A never touches B\'s', async () => {
    const provider = await makeProvider();
    const sessionId = 'reentrancy-supersede';

    const genA = startTurnPausedAfterSetup(provider, 'turn A', sessionId);
    const firstA = await genA.next();
    expect(firstA.done).toBe(false);
    const controllerA = internals(provider).abortController;
    expect(controllerA).not.toBeNull();

    const genB = startTurnPausedAfterSetup(provider, 'turn B', sessionId);
    const firstB = await genB.next();
    expect(firstB.done).toBe(false);
    const controllerB = internals(provider).abortController;
    expect(controllerB).not.toBeNull();
    expect(controllerB).not.toBe(controllerA);

    // B's start must supersede A ...
    expect(controllerA!.signal.aborted).toBe(true);
    // ... but never touch B's own, freshly created controller.
    expect(controllerB!.signal.aborted).toBe(false);
    expect(internals(provider).abortController).toBe(controllerB);

    await drain(genA);
    await drain(genB);
  });

  it('2. CORE REGRESSION: a superseded turn\'s finally must not null out a newer turn\'s controller', async () => {
    const provider = await makeProvider();
    const sessionId = 'reentrancy-finally-identity';

    // Turn A: reach turn-start, pause before A's own finally runs.
    const genA = startTurnPausedAfterSetup(provider, 'turn A', sessionId);
    await genA.next();
    const controllerA = internals(provider).abortController;

    // Turn B: reentrant supersede. Also pause before B's own finally runs --
    // this leaves `this.abortController` pointed at B while A is still
    // sitting mid-generator, not yet torn down.
    const genB = startTurnPausedAfterSetup(provider, 'turn B', sessionId);
    await genB.next();
    const controllerB = internals(provider).abortController;
    expect(controllerB).not.toBe(controllerA);

    // Drive A the rest of the way to completion now -- this is what runs
    // A's finally block, AFTER B has already repointed the shared field.
    await drain(genA);

    // The regression this guards: a finally that unconditionally did
    // `this.abortController = null` (instead of identity-checking against
    // its own local capture) would clobber B's live controller here.
    expect(internals(provider).abortController).toBe(controllerB);
    expect(internals(provider).abortController).not.toBeNull();

    await drain(genB);
    // Once B's own finally has also run (identity matches), the field
    // clears normally -- confirms the fix doesn't just "never clear".
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

    // Reentrant supersede while A is still parked in its streaming loop.
    const genB = startTurnPausedAfterSetup(provider, 'turn B', sessionId);
    await genB.next();
    const controllerB = internals(provider).abortController;
    expect(controllerB).not.toBe(controllerA);
    // B's own turn-start already aborted A's controller (unrelated to the
    // watchdog -- this is the ordinary supersede path from test 1).
    expect(controllerA!.signal.aborted).toBe(true);

    // Let A's stall watchdog actually fire (~20ms) and unwind.
    await nextA;

    // Core assertion: the stall watchdog's `myAbortController.abort()` call
    // reads A's OWN local capture. If it had instead read `this.abortController`
    // (the shared, now-repointed field), B's controller would be aborted here.
    expect(controllerB!.signal.aborted).toBe(false);
    expect(internals(provider).abortController).toBe(controllerB);

    await drain(genA);
    await drain(genB);
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

    // B fully supersedes -- including repointing this.abortController --
    // entirely WHILE A is still parked inside that await.
    const genB = startTurnPausedAfterSetup(provider, 'turn B', sessionId);
    await genB.next();
    const controllerB = internals(provider).abortController;
    expect(controllerB).not.toBe(controllerA);

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
    await drain(genB);
  });
});
