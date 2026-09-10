// [ASTRA-ORCH]
import { afterEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("../claudeCode/cliPathResolver", () => ({
  resolveClaudeAgentCliPath: vi.fn(async () => "test-claude-cli"),
}));

import { ClaudeCodeProvider } from "../ClaudeCodeProvider";
import { TeammateManager } from "../TeammateManager";
import { AISessionsRepository } from "../../../../storage/repositories/AISessionsRepository";
import { buildSdkOptions } from "../claudeCode/sdkOptionsBuilder";
import { ClaudeCodeDeps } from "../claudeCode/dependencyInjection";
import { PROVIDER_CATALOG_RESOLUTION } from "../claudeCode/customBackends";
import {
  CLAUDEX_SOL_ENTRY_ID,
} from "../claudeCode/providerCatalogDefaults";
import { persistProviderRuntimeRouteSnapshot } from "../claudeCode/providerRuntimeRoutePersistence";
import {
  ProviderRuntimeRouteError,
  resolveClaudeAgentRuntimeRoutes,
  type ClaudeAgentRuntimeRouteBundle,
  type ProviderRuntimeSessionSnapshot,
} from "../claudeCode/runtimeRouteResolver";

// This is generated test material, not an external credential fixture.
const TEST_CREDENTIAL = "x".repeat(64);
const WORKSPACE_CREDENTIAL = "w".repeat(64);
const GLOBAL_CREDENTIAL = "g".repeat(64);
const WORKSPACE_PATH = "D:/workspace-only";

function resolvedRoutes(): Readonly<ClaudeAgentRuntimeRouteBundle> {
  const entry = PROVIDER_CATALOG_RESOLUTION.entries.find(
    (candidate) => candidate.id === CLAUDEX_SOL_ENTRY_ID
  );
  if (!entry) throw new Error("missing Claudex Sol provider route");
  const credentialReferences = Object.fromEntries(
    entry.interfaces.map((candidate) => [candidate.credentialRef, true])
  );
  const routes = resolveClaudeAgentRuntimeRoutes(
    PROVIDER_CATALOG_RESOLUTION,
    { model: entry.model.persistedId },
    credentialReferences
  );
  if (!routes) throw new Error("expected catalog-owned runtime routes");
  return routes;
}

function createTeammateManager() {
  return {
    resolveTeamContext: vi.fn(async () => undefined),
  } as {
    lastUsedCwd?: string;
    lastUsedSessionId?: string;
    lastUsedPermissionsPath?: string;
    packagedBuildOptions?: unknown;
    runtimeRouteOptions?: {
      env: Record<string, string | undefined>;
      exactModel: string;
      routeReceipt: ProviderRuntimeSessionSnapshot["receipt"];
      thinking?: Readonly<{ type: string }>;
    };
    resolveTeamContext: (sessionId?: string) => Promise<string | undefined>;
  };
}

async function buildOptionsWithRoutes(
  mainRouteSnapshot: Readonly<ProviderRuntimeSessionSnapshot>,
  subagentRouteSnapshot: Readonly<ProviderRuntimeSessionSnapshot>,
  teammateManager = createTeammateManager(),
) {
  const result = await buildSdkOptions(
    {
      resolveModelVariant: () => "ambient-model-must-not-win",
      getMcpServersSnapshot: async () => ({}),
      createCanUseToolHandler: () => vi.fn(),
      toolHooksService: {
        createPreToolUseHook: () => vi.fn(),
        createPostToolUseHook: () => vi.fn(),
        createPermissionDeniedHook: () => vi.fn(),
      },
      teammateManager,
      sessions: { getSessionId: () => undefined },
      config: {
        model: mainRouteSnapshot.plan.model.persistedId,
        apiKey: TEST_CREDENTIAL,
      },
      abortController: new AbortController(),
      mainRouteSnapshot,
      subagentRouteSnapshot,
      mainRouteCredential: TEST_CREDENTIAL,
      subagentRouteCredential: TEST_CREDENTIAL,
    },
    {
      message: "test route",
      workspacePath: "D:/workspace",
      sessionId: "runtime-route-session",
      settingsEnv: {
        ANTHROPIC_BASE_URL: "https://ambient.invalid",
        ANTHROPIC_MODEL: "ambient-model-must-not-win",
      },
      shellEnv: {
        ANTHROPIC_AUTH_TOKEN: TEST_CREDENTIAL,
        CLAUDE_CODE_SUBAGENT_MODEL: "ambient-model-must-not-win",
      },
      systemPrompt: "test",
      currentMode: "agent",
      imageContentBlocks: [],
      documentContentBlocks: [],
    }
  );
  return { result, teammateManager };
}

afterEach(() => {
  ClaudeCodeDeps.setProviderCredentialResolver(null);
  ClaudeCodeDeps.setProviderCatalogResolutionLoader(null);
  queryMock.mockReset();
  vi.restoreAllMocks();
});

describe("ClaudeCodeProvider runtime route consumers", () => {
  it("fails closed before mutation when workspace credential context is missing", async () => {
    ClaudeCodeDeps.setProviderCredentialResolver(
      (_credentialRef, context) =>
        context?.workspacePath === WORKSPACE_PATH
          ? WORKSPACE_CREDENTIAL
          : undefined
    );
    const provider = new ClaudeCodeProvider();
    await provider.initialize({
      model: "claude-code:claudex-sol",
      workspacePath: WORKSPACE_PATH,
    });

    const providerInternals = provider as unknown as Record<string, unknown>;
    providerInternals.config = {
      ...((providerInternals.config as Record<string, unknown>) || {}),
      workspacePath: undefined,
    };
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");
    providerInternals.abortController = abortController;
    const hookSpy = vi.spyOn(
      provider as unknown as { createToolHooksService: () => unknown },
      "createToolHooksService"
    );

    await expect(
      provider
        .sendMessage("test", undefined, "revoked-route", [], "D:/workspace")
        .next()
    ).rejects.toMatchObject({
      name: "ProviderRuntimeRouteError",
      code: "credential-unavailable",
      stage: "pre-mutation",
    });
    expect(abortSpy).not.toHaveBeenCalled();
    expect(hookSpy).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(providerInternals.abortController).toBe(abortController);
  });

  it("uses the passed workspace context at initialization and per-turn preflight", async () => {
    const resolveCredential = vi.fn(
      (_credentialRef: string, context?: Readonly<{ workspacePath?: string }>) =>
        context?.workspacePath === WORKSPACE_PATH
          ? WORKSPACE_CREDENTIAL
          : GLOBAL_CREDENTIAL
    );
    ClaudeCodeDeps.setProviderCredentialResolver(resolveCredential);
    const provider = new ClaudeCodeProvider();
    await provider.initialize({
      model: "claude-code:claudex-sol",
      workspacePath: WORKSPACE_PATH,
    });
    const installSpy = vi
      .spyOn(AISessionsRepository, "installMetadataValueIfAbsent")
      .mockRejectedValue(new Error("test persistence stop"));

    await expect(
      provider
        .sendMessage("test", undefined, "workspace-context", [], "D:/ignored")
        .next()
    ).rejects.toMatchObject({
      name: "ProviderRuntimeRouteError",
      code: "immutable-session-route",
      stage: "pre-mutation",
    });

    expect(installSpy).toHaveBeenCalledOnce();
    expect(resolveCredential).toHaveBeenCalledTimes(2);
    for (const [, context] of resolveCredential.mock.calls) {
      expect(context).toEqual({ workspacePath: WORKSPACE_PATH });
    }
    expect(
      resolveCredential.mock.results.map((result) => result.value)
    ).toEqual([WORKSPACE_CREDENTIAL, WORKSPACE_CREDENTIAL]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("uses the persisted main and teammate plans exactly and scrubs ambient fallbacks", async () => {
    const routes = resolvedRoutes();
    let persisted: unknown;
    const durableRoutes = await persistProviderRuntimeRouteSnapshot(
      "runtime-route-session",
      routes,
      {
        installSessionMetadataValueIfAbsent: async (_sessionId, _key, value) => {
          persisted ??= value;
          return persisted;
        },
      }
    );
    const { result, teammateManager } = await buildOptionsWithRoutes(
      durableRoutes.main,
      durableRoutes.subagent
    );
    const { options } = result;

    expect(options.model).toBe(durableRoutes.main.plan.selectedInterface.modelAlias);
    expect(options.env!.ANTHROPIC_BASE_URL).toBe(
      durableRoutes.main.plan.selectedInterface.endpoint
    );
    expect(options.env!.ANTHROPIC_MODEL).toBe(
      durableRoutes.main.plan.selectedInterface.modelAlias
    );
    expect(options.env!.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe("1");
    expect(options.env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env!.OPENAI_API_KEY).toBeUndefined();
    expect(teammateManager.runtimeRouteOptions).toMatchObject({
      exactModel: durableRoutes.subagent.plan.selectedInterface.modelAlias,
      routeReceipt: durableRoutes.subagent.receipt,
    });
    expect(teammateManager.runtimeRouteOptions?.env.ANTHROPIC_BASE_URL).toBe(
      durableRoutes.subagent.plan.selectedInterface.endpoint
    );
    expect(teammateManager.runtimeRouteOptions?.env.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe("1");
    expect(durableRoutes.main.receipt.fallbackUsed).toBe(false);
    expect(durableRoutes.subagent.receipt.fallbackUsed).toBe(false);
    expect(JSON.stringify(durableRoutes)).not.toContain(TEST_CREDENTIAL);

    const logNonBlocking = vi.fn();
    const consumer = new TeammateManager({
      logNonBlocking,
      emit: vi.fn(),
      createPreToolUseHook: () => vi.fn(),
      createPostToolUseHook: () => vi.fn(),
      getAbortSignal: () => undefined,
      interruptWithMessage: async () => undefined,
      createCanUseToolHandler: () => vi.fn(),
    });
    consumer.runtimeRouteOptions = teammateManager.runtimeRouteOptions;
    queryMock.mockImplementation(() =>
      (async function* () {
        return undefined;
      })()
    );
    await (
      consumer as unknown as {
        streamTeammateOutput: (...args: unknown[]) => Promise<unknown>;
      }
    ).streamTeammateOutput(
      "runtime-route-session",
      "teammate@runtime-route-session",
      "runtime-route-session",
      "teammate",
      "test",
      "general-purpose",
      "ambient-model-must-not-win",
      "blue",
      new AbortController()
    );
    const childLaunch = queryMock.mock.calls[0]?.[0] as { options?: any };
    expect(childLaunch.options.model).toBe(
      durableRoutes.subagent.plan.selectedInterface.modelAlias
    );
    expect(childLaunch.options.env.ANTHROPIC_BASE_URL).toBe(
      durableRoutes.subagent.plan.selectedInterface.endpoint
    );
    expect(childLaunch.options.env.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe("1");
    const serializedReceipt = JSON.stringify(durableRoutes.subagent.receipt);
    expect(logNonBlocking).toHaveBeenCalledWith(
      "runtime-route-session",
      "claude-code",
      "output",
      serializedReceipt,
      expect.objectContaining({
        messageType: "teammate_provider_runtime_route",
      })
    );
    expect(serializedReceipt).not.toContain(TEST_CREDENTIAL);
  });

  it("rejects a lead/teammate route identity mismatch before SDK launch", async () => {
    const routes = resolvedRoutes();
    const durableRoutes = await persistProviderRuntimeRouteSnapshot(
      "route-mismatch-session",
      routes,
      { installSessionMetadataValueIfAbsent: async (_sessionId, _key, value) => value }
    );
    const mismatchedSubagent = {
      ...durableRoutes.subagent,
      plan: {
        ...durableRoutes.subagent.plan,
        selectedInterface: {
          ...durableRoutes.subagent.plan.selectedInterface,
          endpoint: "https://mismatch.invalid/v1",
        },
      },
    } as Readonly<ProviderRuntimeSessionSnapshot>;

    await expect(
      buildOptionsWithRoutes(durableRoutes.main, mismatchedSubagent)
    ).rejects.toBeInstanceOf(ProviderRuntimeRouteError);
  });
});
