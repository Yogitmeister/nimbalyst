// [ASTRA-ORCH]
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { get: vi.fn() },
}));
vi.mock('../../../utils/store', () => ({
  getDefaultEffortLevel: () => 'high',
  getDefaultThinkingMode: () => 'enabled',
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { ClaudeCodeProvider, ProviderFactory } from '@nimbalyst/runtime/ai/server';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { ProviderRuntimeRouteError } from '@nimbalyst/runtime/ai/server/providers/claudeCode/runtimeRouteResolver';
import {
  buildClaudeCodeRuntimeConfigForTurn,
  prepareClaudeCodeProviderTurn,
} from '../ClaudeCodeTurnLifecycle';

const SESSION_ID = 'claudex-lifecycle-session';
const PROVIDER_SESSION_ID = 'stable-provider-session-id';
const MODEL = 'claude-code:claudex-sol';
const WORKSPACE_PATH = 'D:/workspace-only';
const CALLER_WORKSPACE_PATH = 'D:/caller-derived-workspace';
const WORKSPACE_CREDENTIAL = 'w'.repeat(64);
const GLOBAL_CREDENTIAL = 'g'.repeat(64);

function persistedSession(): SessionData {
  return {
    id: SESSION_ID,
    provider: 'claude-code',
    model: MODEL,
    workspacePath: WORKSPACE_PATH,
    providerConfig: {},
    metadata: {},
  } as SessionData;
}

describe('Claude Code turn lifecycle', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.get).mockReset();
    ProviderFactory.destroyProvider(SESSION_ID, 'claude-code');
    ClaudeCodeProvider.setProviderCredentialResolver(
      (_credentialRef, context) =>
        context?.workspacePath === WORKSPACE_PATH
          ? WORKSPACE_CREDENTIAL
          : GLOBAL_CREDENTIAL,
    );
  });

  afterEach(() => {
    ProviderFactory.destroyProvider(SESSION_ID, 'claude-code');
    ClaudeCodeProvider.setProviderCredentialResolver(null);
  });

  it('uses the exact persisted workspace route for fresh, cached, and restored lifecycle preparation', async () => {
    let reads = 0;
    vi.mocked(AISessionsRepository.get).mockImplementation(async () => {
      reads += 1;
      return {
        id: SESSION_ID,
        provider: 'claude-code',
        model: MODEL,
        workspacePath: WORKSPACE_PATH,
        metadata: {},
      } as any;
    });
    const firstSession = persistedSession();
    const firstProvider = ProviderFactory.createProvider('claude-code', SESSION_ID);
    const firstInitialize = vi.spyOn(firstProvider, 'initialize');

    const firstConfig = await prepareClaudeCodeProviderTurn(
      firstProvider,
      firstSession,
      () => buildClaudeCodeRuntimeConfigForTurn(firstSession, undefined, CALLER_WORKSPACE_PATH),
    );
    expect(firstConfig).toMatchObject({ model: MODEL, workspacePath: WORKSPACE_PATH });
    expect(firstInitialize).toHaveBeenCalledOnce();

    firstProvider.setProviderSessionData?.(SESSION_ID, {
      providerSessionId: PROVIDER_SESSION_ID,
    });
    const cachedSession = {
      ...firstSession,
      providerSessionId: PROVIDER_SESSION_ID,
    } as SessionData;
    await prepareClaudeCodeProviderTurn(
      firstProvider,
      cachedSession,
      () => buildClaudeCodeRuntimeConfigForTurn(cachedSession),
    );
    expect(firstInitialize).toHaveBeenCalledTimes(2);

    ProviderFactory.destroyProvider(SESSION_ID, 'claude-code');
    const restoredProvider = ProviderFactory.createProvider('claude-code', SESSION_ID);
    const restoredConfig = await prepareClaudeCodeProviderTurn(
      restoredProvider,
      cachedSession,
      () => buildClaudeCodeRuntimeConfigForTurn(cachedSession),
    );
    expect(restoredConfig).toMatchObject({ model: MODEL, workspacePath: WORKSPACE_PATH });
    expect(restoredProvider.getProviderSessionData?.(SESSION_ID)).toMatchObject({
      claudeSessionId: PROVIDER_SESSION_ID,
    });
    expect(reads).toBe(3);
  });

  it('fails closed before provider-session restoration when the named workspace credential is revoked', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: SESSION_ID,
      provider: 'claude-code',
      model: MODEL,
      workspacePath: WORKSPACE_PATH,
      metadata: {},
    } as any);
    ClaudeCodeProvider.setProviderCredentialResolver(() => undefined);
    const provider = ProviderFactory.createProvider('claude-code', SESSION_ID);
    const restoreSpy = vi.spyOn(provider, 'setProviderSessionData');
    const session = {
      ...persistedSession(),
      providerSessionId: PROVIDER_SESSION_ID,
    } as SessionData;

    await expect(
      prepareClaudeCodeProviderTurn(
        provider,
        session,
        () => buildClaudeCodeRuntimeConfigForTurn(session),
      ),
    ).rejects.toBeInstanceOf(ProviderRuntimeRouteError);
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('uses the caller-derived workspace when the persisted session has no workspace path', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: SESSION_ID,
      provider: 'claude-code',
      model: MODEL,
      metadata: {},
    } as any);
    const session = {
      ...persistedSession(),
      workspacePath: undefined,
    } as SessionData;
    const provider = ProviderFactory.createProvider('claude-code', SESSION_ID);

    const config = await prepareClaudeCodeProviderTurn(
      provider,
      session,
      () => buildClaudeCodeRuntimeConfigForTurn(session, undefined, CALLER_WORKSPACE_PATH),
    );

    expect(config).toMatchObject({
      model: MODEL,
      workspacePath: CALLER_WORKSPACE_PATH,
    });
  });

  it('rejects persisted identity drift before provider initialization', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: SESSION_ID,
      provider: 'claude-code',
      model: 'claude-code:openrouter-deepseek-v4-flash',
      workspacePath: WORKSPACE_PATH,
      metadata: {},
    } as any);
    const provider = ProviderFactory.createProvider('claude-code', SESSION_ID);
    const initializeSpy = vi.spyOn(provider, 'initialize');
    const session = persistedSession();

    await expect(
      prepareClaudeCodeProviderTurn(
        provider,
        session,
        () => buildClaudeCodeRuntimeConfigForTurn(session),
      ),
    ).rejects.toThrow('persisted model identity changed or was lost');
    expect(initializeSpy).not.toHaveBeenCalled();
  });
});
