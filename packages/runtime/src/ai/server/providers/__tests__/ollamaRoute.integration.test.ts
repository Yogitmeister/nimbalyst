// [ASTRA-ORCH]
import { afterEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: vi.fn(async () => 'synthetic-claude-cli'),
}));

import { TeammateManager } from '../TeammateManager';
import { buildSdkOptions } from '../claudeCode/sdkOptionsBuilder';
import { resolveProviderCatalog } from '../claudeCode/providerCatalog';
import { BUILT_IN_PROVIDER_CATALOG } from '../claudeCode/providerCatalogDefaults';
import { persistProviderRuntimeRouteSnapshot } from '../claudeCode/providerRuntimeRoutePersistence';
import {
  resolveClaudeAgentRuntimeRoutes,
  type ProviderRuntimeSessionSnapshot,
} from '../claudeCode/runtimeRouteResolver';

// Generated test material only; it is never written into a receipt or log.
const TEST_CREDENTIAL = 'x'.repeat(64);
const catalogResolution = resolveProviderCatalog(BUILT_IN_PROVIDER_CATALOG, undefined);

function createManager(logNonBlocking = vi.fn()) {
  return new TeammateManager({
    logNonBlocking,
    emit: vi.fn(),
    createPreToolUseHook: () => vi.fn(),
    createPostToolUseHook: () => vi.fn(),
    getAbortSignal: () => undefined,
    interruptWithMessage: async () => undefined,
    createCanUseToolHandler: () => vi.fn(),
  });
}

async function createDurableRoutes(entryId: string) {
  const entry = catalogResolution.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error(`missing synthetic catalog entry ${entryId}`);
  const credentialReferences = Object.fromEntries(
    entry.interfaces.map((candidate) => [candidate.credentialRef, true]),
  );
  const routes = resolveClaudeAgentRuntimeRoutes(
    catalogResolution,
    { model: entry.model.persistedId },
    credentialReferences,
  );
  if (!routes) throw new Error(`missing runtime routes for ${entry.id}`);
  let stored: unknown;
  const durable = await persistProviderRuntimeRouteSnapshot(
    `synthetic-${entry.id}`,
    routes,
    {
      installSessionMetadataValueIfAbsent: async (_sessionId, _key, value) => {
        stored ??= value;
        return stored;
      },
    },
  );
  return { entry, durable };
}

async function buildCatalogTurn(
  mainRouteSnapshot: Readonly<ProviderRuntimeSessionSnapshot>,
  subagentRouteSnapshot: Readonly<ProviderRuntimeSessionSnapshot>,
  teammateManager: TeammateManager,
  providerSessionId?: string,
) {
  return buildSdkOptions(
    {
      resolveModelVariant: () => 'ambient-model-must-not-win',
      getMcpServersSnapshot: async () => ({}),
      createCanUseToolHandler: () => vi.fn(),
      toolHooksService: {
        createPreToolUseHook: () => vi.fn(),
        createPostToolUseHook: () => vi.fn(),
        createPermissionDeniedHook: () => vi.fn(),
      },
      teammateManager,
      sessions: { getSessionId: () => providerSessionId },
      config: { model: mainRouteSnapshot.plan.model.persistedId },
      abortController: new AbortController(),
      mainRouteSnapshot,
      subagentRouteSnapshot,
      mainRouteCredential: TEST_CREDENTIAL,
      subagentRouteCredential: TEST_CREDENTIAL,
    },
    {
      message: 'synthetic route proof',
      workspacePath: 'D:/synthetic-workspace',
      sessionId: 'synthetic-runtime-session',
      settingsEnv: {
        ANTHROPIC_BASE_URL: 'https://ambient.invalid',
        ANTHROPIC_MODEL: 'ambient-model-must-not-win',
      },
      shellEnv: {
        ANTHROPIC_API_KEY: 'synthetic-ambient-key',
        OPENAI_API_KEY: 'synthetic-openai-key',
        CLAUDE_CODE_SUBAGENT_MODEL: 'ambient-model-must-not-win',
        FALLBACK_FOR_ALL_PRIMARY_MODELS: 'ambient-fallback-model',
      },
      systemPrompt: 'synthetic route proof',
      currentMode: 'agent',
      imageContentBlocks: [],
      documentContentBlocks: [],
    },
  );
}

afterEach(() => {
  queryMock.mockReset();
  vi.restoreAllMocks();
});

describe('catalog-owned Ollama runtime route integration', () => {
  it('uses every reviewed Ollama route exactly and excludes ambient fallback selectors', async () => {
    const ollamaEntries = catalogResolution.entries.filter(
      (entry) => entry.provider === 'ollama',
    );
    expect(ollamaEntries.length).toBeGreaterThan(0);

    for (const entry of ollamaEntries) {
      const { durable } = await createDurableRoutes(entry.id);
      const manager = createManager();
      const { options } = await buildCatalogTurn(
        durable.main,
        durable.subagent,
        manager,
      );

      expect(options.model).toBe(durable.main.plan.selectedInterface.modelAlias);
      expect(options.env!.ANTHROPIC_BASE_URL).toBe(
        durable.main.plan.selectedInterface.endpoint,
      );
      expect(options.env!.ANTHROPIC_MODEL).toBe(
        durable.main.plan.selectedInterface.modelAlias,
      );
      expect(options.env!.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe('1');
      expect(options.env!.ANTHROPIC_API_KEY).toBeUndefined();
      expect(options.env!.OPENAI_API_KEY).toBeUndefined();
      expect(options.env!.FALLBACK_FOR_ALL_PRIMARY_MODELS).toBeUndefined();
      expect(manager.runtimeRouteOptions).toMatchObject({
        exactModel: durable.subagent.plan.selectedInterface.modelAlias,
        routeReceipt: durable.subagent.receipt,
      });
      expect(JSON.stringify(durable)).not.toContain(TEST_CREDENTIAL);
    }
  });

  it('keeps first, cached, and restored turns on the same immutable route', async () => {
    const entry = catalogResolution.entries.find(
      (candidate) => candidate.provider === 'ollama',
    );
    if (!entry) throw new Error('missing synthetic Ollama entry');
    const { durable } = await createDurableRoutes(entry.id);
    const providerSessionId = 'synthetic-provider-session';
    const first = await buildCatalogTurn(
      durable.main,
      durable.subagent,
      createManager(),
    );
    const cached = await buildCatalogTurn(
      durable.main,
      durable.subagent,
      createManager(),
      providerSessionId,
    );
    const restored = await buildCatalogTurn(
      durable.main,
      durable.subagent,
      createManager(),
      providerSessionId,
    );

    for (const turn of [first, cached, restored]) {
      expect(turn.options.model).toBe(durable.main.plan.selectedInterface.modelAlias);
      expect(turn.options.env!.CLAUDE_CODE_SUBAGENT_MODEL).toBe(
        durable.subagent.plan.selectedInterface.modelAlias,
      );
      expect(turn.options.env!.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe('1');
    }
    expect(first.options.resume).toBeUndefined();
    expect(cached.options.resume).toBe(providerSessionId);
    expect(restored.options.resume).toBe(providerSessionId);
  });

  it('pins native teammate and Agent receipts to the persisted subagent route before query launch', async () => {
    const entry = catalogResolution.entries.find(
      (candidate) => candidate.provider === 'ollama',
    );
    if (!entry) throw new Error('missing synthetic Ollama entry');
    const { durable } = await createDurableRoutes(entry.id);
    const preparedManager = createManager();
    await buildCatalogTurn(durable.main, durable.subagent, preparedManager);

    const logNonBlocking = vi.fn();
    const consumer = createManager(logNonBlocking);
    consumer.runtimeRouteOptions = preparedManager.runtimeRouteOptions;
    queryMock.mockImplementation(() => (async function* () {})());

    await (consumer as unknown as {
      streamTeammateOutput: (...args: unknown[]) => Promise<unknown>;
    }).streamTeammateOutput(
      'synthetic-runtime-session',
      'worker@synthetic-team',
      'synthetic-team',
      'worker',
      'synthetic prompt',
      'general-purpose',
      'task-model-must-not-win',
      'blue',
      new AbortController(),
    );
    const childOptions = queryMock.mock.calls[0]?.[0]?.options;
    expect(childOptions.model).toBe(durable.subagent.plan.selectedInterface.modelAlias);
    expect(childOptions.env.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe('1');
    expect(childOptions.env.ANTHROPIC_API_KEY).toBeUndefined();

    consumer.recordNativeAgentToolResult(
      'synthetic-runtime-session',
      'Agent',
      { name: 'worker' },
      [{ type: 'text', text: 'agentId: worker@synthetic-team' }],
      false,
    );
    expect(logNonBlocking).toHaveBeenLastCalledWith(
      'synthetic-runtime-session',
      'claude-code',
      'output',
      JSON.stringify(durable.subagent.receipt),
      expect.objectContaining({
        messageType: 'native_agent_provider_runtime_route',
        nativeAgentId: 'worker@synthetic-team',
      }),
    );
    expect(JSON.stringify(logNonBlocking.mock.calls)).not.toContain(TEST_CREDENTIAL);

    queryMock.mockClear();
    consumer.runtimeRouteOptions = {
      ...consumer.runtimeRouteOptions!,
      exactModel: 'task-model-must-not-win',
    };
    await expect(
      (consumer as unknown as {
        streamTeammateOutput: (...args: unknown[]) => Promise<unknown>;
      }).streamTeammateOutput(
        'synthetic-runtime-session',
        'worker@synthetic-team',
        'synthetic-team',
        'worker',
        'synthetic prompt',
        'general-purpose',
        'task-model-must-not-win',
        'blue',
        new AbortController(),
      ),
    ).rejects.toMatchObject({
      name: 'ProviderRuntimeRouteError',
      code: 'identity-mismatch',
      stage: 'pre-mutation',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
