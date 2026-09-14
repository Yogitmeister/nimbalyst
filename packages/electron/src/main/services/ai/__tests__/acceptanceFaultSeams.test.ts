import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StreamChunk } from '@nimbalyst/runtime/ai/server/types';
import {
  resolveAcceptanceFault,
  withAcceptanceSyncDisconnect,
  wrapProviderStreamForAcceptance,
} from '../acceptanceFaultSeams';

async function* chunks(values: StreamChunk[]): AsyncGenerator<StreamChunk> {
  yield* values;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const values: StreamChunk[] = [];
  for await (const chunk of stream) values.push(chunk);
  return values;
}

const isolatedRoot = path.resolve('D:/acceptance/run-1');
const userData = path.join(isolatedRoot, 'profile', 'electron');

describe('acceptance fault seams', () => {
  it('is unreachable for ordinary launches, wrong roots, and unknown modes', () => {
    expect(resolveAcceptanceFault({}, userData)).toBeNull();
    expect(resolveAcceptanceFault({
      NIMBALYST_TEST_ACCEPT: '1',
      NIMBALYST_ACCEPT_FAULT: 'drop-terminal-after-final',
      NIMBALYST_ACCEPT_ROOT: path.resolve('D:/other'),
    }, userData)).toBeNull();
    expect(resolveAcceptanceFault({
      NIMBALYST_TEST_ACCEPT: '1',
      NIMBALYST_ACCEPT_FAULT: 'unknown',
      NIMBALYST_ACCEPT_ROOT: isolatedRoot,
    }, userData)).toBeNull();
    expect(resolveAcceptanceFault({
      NIMBALYST_TEST_ACCEPT: '1',
      NIMBALYST_ACCEPT_FAULT: 'drop-terminal-after-final',
      NIMBALYST_ACCEPT_ROOT: path.parse(isolatedRoot).root,
    }, userData)).toBeNull();
  });

  it('passes final text but suppresses one terminal after durable ownership', async () => {
    const order: string[] = [];
    const recordApplied = vi.fn(async () => { order.push('applied'); });
    const stream = wrapProviderStreamForAcceptance({
      stream: chunks([
        { type: 'turn_started', providerTurn: { threadId: 'thread-1', turnId: 'turn-1' } },
        { type: 'text', content: 'final nonce' },
        { type: 'complete' },
      ]),
      sessionId: 'session-1',
      env: {
        NIMBALYST_TEST_ACCEPT: '1',
        NIMBALYST_ACCEPT_FAULT: 'drop-terminal-after-final',
        NIMBALYST_ACCEPT_ROOT: isolatedRoot,
      },
      userDataPath: () => userData,
      claimFault: async () => { order.push('claimed-after-turn-started'); return true; },
      recordApplied,
      onTerminalSuppressed: async () => { order.push('reconciled'); },
    });

    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('turn_started');
    order.push('ownership-cas-complete');
    const remainder: StreamChunk[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remainder.push(next.value);
    }
    expect(order).toEqual(['ownership-cas-complete', 'claimed-after-turn-started', 'applied', 'reconciled']);
    expect(remainder).toEqual([{ type: 'text', content: 'final nonce' }]);
    expect(recordApplied).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'drop-terminal-after-final' }),
      'session-1',
      { finalSuppressed: false, terminalSuppressed: true },
    );
  });

  it('suppresses both final text and terminal after durable ownership', async () => {
    const recordApplied = vi.fn(async () => undefined);
    const result = await collect(wrapProviderStreamForAcceptance({
      stream: chunks([
        { type: 'turn_started', providerTurn: { threadId: 'thread-1', turnId: 'turn-1' } },
        { type: 'text', content: 'must not escape' },
        { type: 'complete' },
      ]),
      sessionId: 'session-1',
      env: {
        NIMBALYST_TEST_ACCEPT: '1',
        NIMBALYST_ACCEPT_FAULT: 'drop-terminal-without-final',
        NIMBALYST_ACCEPT_ROOT: isolatedRoot,
      },
      userDataPath: () => userData,
      claimFault: async () => true,
      recordApplied,
      onTerminalSuppressed: async () => undefined,
    }));

    expect(result).toEqual([
      { type: 'turn_started', providerTurn: { threadId: 'thread-1', turnId: 'turn-1' } },
    ]);
    expect(recordApplied).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'drop-terminal-without-final' }),
      'session-1',
      { finalSuppressed: true, terminalSuppressed: true },
    );
  });

  it('runs one authoritative mutation disconnected and reconnects before returning', async () => {
    let connected = true;
    const order: string[] = [];
    const provider = {
      isConnected: vi.fn(() => connected),
      disconnect: vi.fn(() => { connected = false; order.push('disconnect'); }),
      connect: vi.fn(async () => { connected = true; order.push('reconnect'); }),
    };
    const result = await withAcceptanceSyncDisconnect({
      sessionId: 'session-1',
      env: {
        NIMBALYST_TEST_ACCEPT: '1',
        NIMBALYST_ACCEPT_FAULT: 'sync-disconnect',
        NIMBALYST_ACCEPT_ROOT: isolatedRoot,
      },
      userDataPath: () => userData,
      getSyncProvider: () => provider,
      claimFault: async () => true,
      recordApplied: async (_config, _sessionId, details) => {
        order.push(`receipt:${JSON.stringify(details)}`);
      },
      run: async () => {
        expect(connected).toBe(false);
        order.push('mutation');
        return 'committed';
      },
    });

    expect(result).toBe('committed');
    expect(connected).toBe(true);
    expect(order).toEqual([
      'disconnect',
      'mutation',
      'reconnect',
      'receipt:{"disconnected":true,"reconnected":true,"mutationSucceeded":true}',
    ]);
  });
});
