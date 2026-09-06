import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getExtensionAgentProvider: vi.fn(),
  listContributions: vi.fn(),
  listExtensionAgentProvidersForSession: vi.fn(),
  terminalActive: vi.fn(),
  terminalWrite: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  AI_PROVIDER_TYPES: ['claude', 'claude-code-cli', 'openai-codex', 'opencode'],
  ProviderFactory: {
    getProvider: mocks.getProvider,
    getExtensionAgentProvider: mocks.getExtensionAgentProvider,
    listExtensionAgentProvidersForSession: mocks.listExtensionAgentProvidersForSession,
  },
}));

vi.mock('../../../extensions/AgentProviderRegistry', () => ({
  getAgentProviderRegistry: () => ({ list: mocks.listContributions }),
}));

vi.mock('../../TerminalSessionManager', () => ({
  getTerminalSessionManager: () => ({
    isTerminalActive: mocks.terminalActive,
    writeToTerminal: mocks.terminalWrite,
  }),
}));

import {
  cancelAllNativeSessionOwners,
  censusNativeSessionOwners,
} from '../nativeSessionOwnerCensus';

function currentTarget() {
  return { generation: 'cancel-1', isCurrent: () => true };
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    abort: vi.fn(),
    interruptCurrentTurn: vi.fn(async () => ({ method: 'abort' as const })),
    ...overrides,
  };
}

describe('native session owner census', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProvider.mockReturnValue(null);
    mocks.getExtensionAgentProvider.mockReturnValue(null);
    mocks.listContributions.mockReturnValue([]);
    mocks.listExtensionAgentProvidersForSession.mockReturnValue([]);
    mocks.terminalActive.mockReturnValue(false);
  });

  it('proves no owner only when built-in, extension, and terminal registries are all empty', async () => {
    expect(censusNativeSessionOwners('session-1')).toEqual([]);
    await expect(cancelAllNativeSessionOwners(
      'session-1',
      currentTarget(),
      'abort',
    )).resolves.toEqual({
      state: 'proven-no-owner',
      method: 'all-native-owner-registries-empty',
    });
  });

  it('finds and cancels an extension-only owner by its current contribution id', async () => {
    // Ground truth is the live provider cache (ProviderFactory), not the
    // AgentProviderRegistry catalog -- see NIM-590 batch item 5. A provider
    // instance can outlive its registry entry, so census must not depend on
    // the contribution still being listed.
    const extensionProvider = provider();
    mocks.listExtensionAgentProvidersForSession.mockImplementation((sessionId: string) =>
      sessionId === 'session-1'
        ? [{ extensionId: 'com.example.agent', contributionId: 'example-agent', provider: extensionProvider }]
        : [],
    );

    await expect(cancelAllNativeSessionOwners(
      'session-1',
      currentTarget(),
      'abort',
    )).resolves.toMatchObject({
      state: 'native-entered',
      method: 'extension:com.example.agent/example-agent:abort',
    });
    expect(extensionProvider.abort).toHaveBeenCalledTimes(1);
    // The registry catalog is never consulted -- proves the import removal
    // was real, not just an unused mock left dangling. NIM-590 batch item 5.
    expect(mocks.listContributions).not.toHaveBeenCalled();
  });

  it('cancels a built-in provider and terminal together instead of choosing one', async () => {
    const builtIn = provider();
    mocks.getProvider.mockImplementation((providerType: string) =>
      providerType === 'openai-codex' ? builtIn : null,
    );
    mocks.terminalActive.mockReturnValue(true);

    const outcome = await cancelAllNativeSessionOwners(
      'session-1',
      currentTarget(),
      'abort',
    );

    expect(outcome).toMatchObject({ state: 'native-entered' });
    expect((outcome as { method: string }).method).toContain('built-in:openai-codex:abort');
    expect((outcome as { method: string }).method).toContain('terminal:ctrl-c');
    expect(builtIn.abort).toHaveBeenCalledTimes(1);
    expect(mocks.terminalWrite).toHaveBeenCalledWith('session-1', '\x03');
  });

  it('attempts every provider and terminal but returns unknown when any owner fails entry', async () => {
    const broken = provider({ abort: vi.fn(() => { throw new Error('abort failed'); }) });
    const healthy = provider();
    mocks.getProvider.mockImplementation((providerType: string) => {
      if (providerType === 'openai-codex') return broken;
      if (providerType === 'opencode') return healthy;
      return null;
    });
    mocks.terminalActive.mockReturnValue(true);

    await expect(cancelAllNativeSessionOwners(
      'session-1',
      currentTarget(),
      'abort',
    )).resolves.toMatchObject({
      state: 'unknown',
      error: expect.stringContaining('entered 2/3 owner(s)'),
    });
    expect(broken.abort).toHaveBeenCalledTimes(1);
    expect(healthy.abort).toHaveBeenCalledTimes(1);
    expect(mocks.terminalWrite).toHaveBeenCalledTimes(1);
  });

  it('quarantines an incomplete census but still cancels every owner it discovers', async () => {
    const healthy = provider();
    mocks.getProvider.mockImplementation((providerType: string) => {
      if (providerType === 'claude') throw new Error('registry unavailable');
      if (providerType === 'openai-codex') return healthy;
      return null;
    });

    await expect(cancelAllNativeSessionOwners(
      'session-1',
      currentTarget(),
      'abort',
    )).resolves.toMatchObject({
      state: 'unknown',
      error: expect.stringContaining('built-in:claude: registry unavailable'),
    });
    expect(healthy.abort).toHaveBeenCalledTimes(1);
  });

  it('never reports proven-no-owner when a registry could not be inspected', async () => {
    mocks.terminalActive.mockImplementation(() => {
      throw new Error('terminal registry unavailable');
    });

    await expect(cancelAllNativeSessionOwners(
      'session-1',
      currentTarget(),
      'abort',
    )).resolves.toMatchObject({
      state: 'unknown',
      error: expect.stringContaining('terminal: terminal registry unavailable'),
    });
  });

  it('generation-fences every owner and does not touch later owners after the target becomes stale', async () => {
    const first = provider();
    const second = provider();
    mocks.getProvider.mockImplementation((providerType: string) => {
      if (providerType === 'openai-codex') return first;
      if (providerType === 'opencode') return second;
      return null;
    });
    const isCurrent = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(cancelAllNativeSessionOwners(
      'session-1',
      { generation: 'cancel-1', isCurrent },
      'abort',
    )).resolves.toMatchObject({ state: 'unknown' });
    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(second.abort).not.toHaveBeenCalled();
  });
});
