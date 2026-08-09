import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderFactory } from '../ProviderFactory';

function providerMap(): Map<string, { destroy: () => void }> {
  return (ProviderFactory as unknown as {
    providers: Map<string, { destroy: () => void }>;
  }).providers;
}

function providerOwnerMap(): Map<string, string> {
  return (ProviderFactory as unknown as {
    providerOwners: Map<string, string>;
  }).providerOwners;
}

function cacheProvider(key: string, sessionId: string, destroy: () => void): void {
  providerMap().set(key, fakeProvider(destroy));
  providerOwnerMap().set(key, sessionId);
}

function fakeProvider(destroy: () => void) {
  return { destroy } as never;
}

describe('ProviderFactory lifecycle cleanup', () => {
  beforeEach(() => {
    providerMap().clear();
    providerOwnerMap().clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    providerMap().clear();
    providerOwnerMap().clear();
    vi.restoreAllMocks();
  });

  it('destroys only providers owned by the exact session id', () => {
    const codexDestroy = vi.fn();
    const claudeDestroy = vi.fn();
    const otherDestroy = vi.fn();
    const suffixCollisionDestroy = vi.fn();
    cacheProvider('openai-codex-session-1', 'session-1', codexDestroy);
    cacheProvider('claude-session-1', 'session-1', claudeDestroy);
    cacheProvider('openai-codex-session-10', 'session-10', otherDestroy);
    cacheProvider('openai-codex-prefix-session-1', 'prefix-session-1', suffixCollisionDestroy);

    ProviderFactory.destroyProvider('session-1');

    expect(codexDestroy).toHaveBeenCalledTimes(1);
    expect(claudeDestroy).toHaveBeenCalledTimes(1);
    expect(otherDestroy).not.toHaveBeenCalled();
    expect(suffixCollisionDestroy).not.toHaveBeenCalled();
    expect(providerMap().has('openai-codex-session-1')).toBe(false);
    expect(providerMap().has('claude-session-1')).toBe(false);
    expect(providerMap().has('openai-codex-session-10')).toBe(true);
    expect(providerMap().has('openai-codex-prefix-session-1')).toBe(true);
  });

  it('is an idempotent no-op when a typed provider is not cached', () => {
    expect(() => {
      ProviderFactory.destroyProvider('missing-session', 'openai-codex');
      ProviderFactory.destroyProvider('missing-session', 'openai-codex');
    }).not.toThrow();
    expect(providerMap().size).toBe(0);
  });

  it('bounds provider destroy errors, removes the failed entry, and continues', () => {
    const throwingDestroy = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const nextDestroy = vi.fn();
    cacheProvider('openai-codex-session-1', 'session-1', throwingDestroy);
    cacheProvider('claude-session-1', 'session-1', nextDestroy);

    expect(() => ProviderFactory.destroyProvider('session-1')).not.toThrow();

    expect(throwingDestroy).toHaveBeenCalledTimes(1);
    expect(nextDestroy).toHaveBeenCalledTimes(1);
    expect(providerMap().has('openai-codex-session-1')).toBe(false);
    expect(providerMap().has('claude-session-1')).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Error destroying provider'),
      expect.any(Error),
    );
  });

  it('keeps app shutdown cleanup bounded and clears every cached provider', () => {
    const throwingDestroy = vi.fn(() => {
      throw new Error('shutdown cleanup failed');
    });
    const nextDestroy = vi.fn();
    cacheProvider('openai-codex-session-1', 'session-1', throwingDestroy);
    cacheProvider('claude-session-2', 'session-2', nextDestroy);

    expect(() => ProviderFactory.destroyAll()).not.toThrow();

    expect(throwingDestroy).toHaveBeenCalledTimes(1);
    expect(nextDestroy).toHaveBeenCalledTimes(1);
    expect(providerMap().size).toBe(0);
  });
});

describe('ProviderFactory.listExtensionAgentProvidersForSession', () => {
  beforeEach(() => {
    providerMap().clear();
    providerOwnerMap().clear();
  });

  afterEach(() => {
    providerMap().clear();
    providerOwnerMap().clear();
  });

  it('finds a live extension-agent provider and parses its extension/contribution id', () => {
    const agentProvider = { abort: vi.fn() };
    cacheProvider('extension-agent:com.example.agent/example-agent-session-1', 'session-1', vi.fn());
    providerMap().set('extension-agent:com.example.agent/example-agent-session-1', agentProvider as never);

    const result = ProviderFactory.listExtensionAgentProvidersForSession('session-1');

    expect(result).toEqual([{
      extensionId: 'com.example.agent',
      contributionId: 'example-agent',
      provider: agentProvider,
    }]);
  });

  it('excludes a suffix-colliding entry actually owned by a longer session id (NIM-590 batch item 5)', () => {
    // 'extension-agent:.../example-agent-prefix-session-1' ends with the same
    // '-session-1' suffix a naive string match on 'session-1' would accept --
    // only the ownership check (providerOwners.get(key) === sessionId) tells
    // these apart. If that check were ever "simplified" away as redundant
    // with the suffix check, this collision would silently hand back another
    // session's live agent provider.
    const collidingProvider = { abort: vi.fn() };
    cacheProvider(
      'extension-agent:com.example.agent/example-agent-prefix-session-1',
      'prefix-session-1',
      vi.fn(),
    );
    providerMap().set('extension-agent:com.example.agent/example-agent-prefix-session-1', collidingProvider as never);

    expect(ProviderFactory.listExtensionAgentProvidersForSession('session-1')).toEqual([]);
    expect(ProviderFactory.listExtensionAgentProvidersForSession('prefix-session-1')).toEqual([{
      extensionId: 'com.example.agent',
      contributionId: 'example-agent',
      provider: collidingProvider,
    }]);
  });

  it('excludes a same-suffix built-in provider key that is not extension-agent-prefixed', () => {
    cacheProvider('openai-codex-session-1', 'session-1', vi.fn());

    expect(ProviderFactory.listExtensionAgentProvidersForSession('session-1')).toEqual([]);
  });

  it('excludes a malformed extension-agent key with no contribution separator', () => {
    cacheProvider('extension-agent:malformed-session-1', 'session-1', vi.fn());

    expect(ProviderFactory.listExtensionAgentProvidersForSession('session-1')).toEqual([]);
  });

  it('returns every distinct extension-agent entry for the session and none for others', () => {
    const first = { abort: vi.fn() };
    const second = { abort: vi.fn() };
    const other = { abort: vi.fn() };
    cacheProvider('extension-agent:com.example.one/agent-one-session-1', 'session-1', vi.fn());
    providerMap().set('extension-agent:com.example.one/agent-one-session-1', first as never);
    cacheProvider('extension-agent:com.example.two/agent-two-session-1', 'session-1', vi.fn());
    providerMap().set('extension-agent:com.example.two/agent-two-session-1', second as never);
    cacheProvider('extension-agent:com.example.one/agent-one-session-2', 'session-2', vi.fn());
    providerMap().set('extension-agent:com.example.one/agent-one-session-2', other as never);

    const result = ProviderFactory.listExtensionAgentProvidersForSession('session-1');

    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([
      { extensionId: 'com.example.one', contributionId: 'agent-one', provider: first },
      { extensionId: 'com.example.two', contributionId: 'agent-two', provider: second },
    ]));
  });
});
