import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  readProviderCatalog: vi.fn(),
  loadSession: vi.fn(),
  databaseQuery: vi.fn(),
  terminal: {
    isActive: vi.fn(),
    write: vi.fn(),
  },
  queueStore: {
    create: vi.fn(),
    get: vi.fn(),
    deletePending: vi.fn(),
    replacePending: vi.fn(),
    listPending: vi.fn(),
    claim: vi.fn(),
    sweepExecutingForSession: vi.fn(),
  },
}));

vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: { get: ipcMocks.loadSession },
}));

vi.mock("../../RepositoryManager", () => ({
  getQueuedPromptsStore: () => ipcMocks.queueStore,
}));

vi.mock("../../../database/PGLiteDatabaseWorker", () => ({
  database: { query: ipcMocks.databaseQuery },
}));

vi.mock("../../TerminalSessionManager", () => ({
  getTerminalSessionManager: () => ({
    isTerminalActive: ipcMocks.terminal.isActive,
    writeToTerminal: ipcMocks.terminal.write,
  }),
}));

vi.mock("../../../utils/ipcRegistry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/ipcRegistry")>()),
  safeHandle: vi.fn(
    (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcMocks.handlers.set(channel, handler);
    }
  ),
}));

vi.mock(
  "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogLoader",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogLoader")
    >()),
    readProviderCatalog: ipcMocks.readProviderCatalog,
  })
);

import { ModelRegistry, ProviderFactory } from "@nimbalyst/runtime/ai/server";
import { resolveProviderCatalog } from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalog";
import { BUILT_IN_PROVIDER_CATALOG } from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogDefaults";
import * as WindowManager from "../../../window/WindowManager";
import { AIService } from "../AIService";
import {
  tryClaimAndDispatchNextQueuedPrompt,
  type ClaimedQueuedPrompt,
  type QueuedPromptStoreLike,
} from "../queuedPromptDispatcher";

const queueSettled = { outcome: "settled" as const };

function queuedRow(id = "queued-1"): ClaimedQueuedPrompt {
  return {
    id,
    prompt: "continue",
    claimToken: `token-${id}`,
    attachments: null,
    documentContext: null,
  };
}

function dispatcherStore(row: ClaimedQueuedPrompt): QueuedPromptStoreLike {
  return {
    listPending: vi.fn(async () => [row]),
    claim: vi.fn(async () => row),
    beginDispatch: vi.fn(async () => queueSettled),
    releaseClaim: vi.fn(async () => queueSettled),
    completeAfterDispatch: vi.fn(async () => queueSettled),
    failAfterDispatch: vi.fn(async () => queueSettled),
  };
}

function liveWindow(): Electron.BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn(), mainFrame: {} },
  } as unknown as Electron.BrowserWindow;
}

beforeEach(() => {
  ipcMocks.handlers.clear();
  vi.restoreAllMocks();
  ipcMocks.loadSession.mockReset();
  ipcMocks.queueStore.create.mockReset();
  ipcMocks.queueStore.get.mockReset();
  ipcMocks.queueStore.deletePending.mockReset();
  ipcMocks.queueStore.replacePending.mockReset();
  ipcMocks.queueStore.listPending.mockReset();
  ipcMocks.queueStore.claim.mockReset();
  ipcMocks.queueStore.sweepExecutingForSession.mockReset();
  ipcMocks.databaseQuery.mockReset();
  ipcMocks.terminal.isActive.mockReset();
  ipcMocks.terminal.write.mockReset();
});

describe("AIService ai:getModels catalog projection", () => {
  it("captures the production handler and closes every catalog row for a fatal overlay", async () => {
    ipcMocks.readProviderCatalog.mockReturnValue({
      resolution: resolveProviderCatalog(BUILT_IN_PROVIDER_CATALOG, {
        schemaVersion: 999,
        entries: [],
      }),
      migration: { performed: false, sourcePreserved: false },
    });
    vi.spyOn(ModelRegistry, "getAllModels").mockResolvedValue([]);
    const service = Object.create(AIService.prototype) as any;
    service.streamingHandler = { handle: vi.fn() };
    service.getNormalizedProviderSettings = vi.fn(() => ({
      "claude-code": { enabled: true },
      "claude-code-cli": { enabled: false },
    }));
    service.getSettingsStore = vi.fn(() => ({
      get: vi.fn((_key: string, fallback: unknown) => fallback),
    }));

    service.setupIpcHandlers();
    const handler = ipcMocks.handlers.get("ai:getModels");
    expect(handler).toBeTypeOf("function");

    const result = (await handler!()) as {
      success: boolean;
      grouped: Record<
        string,
        Array<{
          catalog?: {
            availability: {
              selectable: boolean;
              code: string;
              reason?: string;
            };
          };
        }>
      >;
    };
    const catalogRows = Object.values(result.grouped)
      .flat()
      .filter((model) => model.catalog);

    expect(result.success).toBe(true);
    expect(ipcMocks.readProviderCatalog).toHaveBeenCalledWith(
      BUILT_IN_PROVIDER_CATALOG
    );
    expect(catalogRows).toHaveLength(BUILT_IN_PROVIDER_CATALOG.length);
    expect(catalogRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          catalog: expect.objectContaining({
            availability: {
              selectable: false,
              code: "invalid",
              reason:
                "The provider catalog source is invalid and cannot be used.",
            },
          }),
        }),
      ])
    );
    expect(
      catalogRows.every(
        (model) => model.catalog?.availability.selectable === false
      )
    ).toBe(true);
  });

  it("keeps local, meta-agent, direct-send, and delete rails inert until the durable marker clears", async () => {
    const pending = {
      status: "pending",
      targetModel: "model-b",
      targetControls: {},
      previousModel: "model-a",
      previousControls: {},
    };
    let metadata: Record<string, unknown> = {
      modelChangeReconciliation: pending,
    };
    ipcMocks.loadSession.mockImplementation(async () => ({ metadata }));
    ipcMocks.queueStore.get.mockResolvedValue({
      id: "q1",
      sessionId: "session-a",
      prompt: "pending",
    });
    ipcMocks.queueStore.create.mockResolvedValue({
      id: "q-created",
      prompt: "ready",
      createdAt: 1,
    });
    ipcMocks.queueStore.deletePending.mockResolvedValue(false);
    const service = Object.create(AIService.prototype) as any;
    service.streamingHandler = { handle: vi.fn() };
    service.sendMessageHandler = vi.fn();
    service.queueProcessingLeases = new Map();
    service.queueClaimReservations = new Map();
    service.directSendInFlight = new Set();
    service.rendererSendInFlight = new Set();
    service.setupIpcHandlers();

    const createHandler = ipcMocks.handlers.get("ai:createQueuedPrompt");
    const deleteHandler = ipcMocks.handlers.get("ai:deleteQueuedPrompt");
    const sendHandler = ipcMocks.handlers.get("ai:sendMessage");
    expect(createHandler).toBeTypeOf("function");
    expect(deleteHandler).toBeTypeOf("function");
    expect(sendHandler).toBeTypeOf("function");

    await expect(
      createHandler!({ sender: {} }, "session-a", "local prompt")
    ).rejects.toThrow("Session model recovery is pending");
    await expect(
      service.queuePromptForSession("session-a", "meta prompt")
    ).rejects.toThrow("Session model recovery is pending");
    await expect(
      service.sendMessageDirect("session-a", "D:\\repo", "direct prompt")
    ).rejects.toThrow("Session model recovery is pending");
    await expect(
      sendHandler!(
        {},
        "stale renderer prompt",
        undefined,
        "session-a",
        "D:\\repo"
      )
    ).rejects.toThrow("Session model recovery is pending");
    await expect(
      service.tryDispatchNextQueuedPrompt("session-a", "D:\\repo", null, "test")
    ).resolves.toBe(false);
    await expect(deleteHandler!({}, "session-a", "q1")).resolves.toEqual({
      success: false,
      error: "Queued prompt deletion was not admitted",
    });
    expect(ipcMocks.queueStore.create).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.deletePending).toHaveBeenCalledWith(
      "q1",
      "session-a"
    );
    expect(service.streamingHandler.handle).not.toHaveBeenCalled();

    metadata = { modelChangeReconciliation: null };
    await expect(
      service.queuePromptForSession("session-a", "meta prompt")
    ).resolves.toEqual({ id: "q-created", prompt: "ready", createdAt: 1 });
    expect(ipcMocks.queueStore.create).toHaveBeenCalledTimes(1);
  });

  it("does not register renderer claim or settlement authority", async () => {
    const service = Object.create(AIService.prototype) as any;
    service.streamingHandler = { handle: vi.fn() };
    service.setupIpcHandlers();
    expect(ipcMocks.handlers.has("ai:claimQueuedPrompt")).toBe(false);
    expect(ipcMocks.handlers.has("ai:completeQueuedPrompt")).toBe(false);
    expect(ipcMocks.handlers.has("ai:failQueuedPrompt")).toBe(false);
    expect(ipcMocks.handlers.has("ai:createQueuedPrompt")).toBe(true);
    expect(ipcMocks.handlers.has("ai:replaceQueuedPrompt")).toBe(true);
    expect(ipcMocks.handlers.has("ai:deleteQueuedPrompt")).toBe(true);
  });

  it("returns authoritative replace/delete CAS outcomes without optimistic success", async () => {
    const service = Object.create(AIService.prototype) as any;
    service.streamingHandler = { handle: vi.fn() };
    service.setupIpcHandlers();
    const replace = ipcMocks.handlers.get("ai:replaceQueuedPrompt")!;
    const remove = ipcMocks.handlers.get("ai:deleteQueuedPrompt")!;

    ipcMocks.queueStore.replacePending.mockResolvedValueOnce(null);
    await expect(
      replace({}, "session-a", "q1", "combined", [{ id: "a" }], {
        filePath: "a.ts",
      })
    ).resolves.toEqual({
      success: false,
      error: "Queued prompt replacement was not admitted",
    });
    expect(ipcMocks.queueStore.replacePending).toHaveBeenCalledWith({
      id: "q1",
      sessionId: "session-a",
      prompt: "combined",
      attachments: [{ id: "a" }],
      documentContext: { filePath: "a.ts" },
    });

    ipcMocks.queueStore.replacePending.mockResolvedValueOnce({
      id: "q1",
      prompt: "combined",
      createdAt: 7,
      attachments: [{ id: "a" }],
      documentContext: { filePath: "a.ts" },
    });
    await expect(
      replace({}, "session-a", "q1", "combined", [{ id: "a" }], {
        filePath: "a.ts",
      })
    ).resolves.toMatchObject({
      success: true,
      row: { id: "q1", timestamp: 7 },
    });

    ipcMocks.queueStore.deletePending
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(remove({}, "session-a", "q1")).resolves.toMatchObject({
      success: false,
    });
    await expect(remove({}, "session-a", "q1")).resolves.toEqual({
      success: true,
    });
    expect(ipcMocks.queueStore.deletePending).toHaveBeenLastCalledWith(
      "q1",
      "session-a"
    );
  });

  it("gates public SDK and CLI cancellation before every effect, then preserves recovered cancellation", async () => {
    const service = Object.create(AIService.prototype) as any;
    const analytics = vi.fn();
    const providerAbort = vi.fn();
    service.streamingHandler = { handle: vi.fn() };
    service.analytics = { sendEvent: analytics };
    service.queueProcessingLeases = new Map([
      ["blocked-sdk", Symbol("blocked-sdk")],
      ["blocked-cli", Symbol("blocked-cli")],
      ["recovered-sdk", Symbol("recovered-sdk")],
      ["recovered-cli", Symbol("recovered-cli")],
    ]);
    service.queueClaimReservations = new Map([
      ["blocked-sdk", Symbol("blocked-sdk-claim")],
      ["blocked-cli", Symbol("blocked-cli-claim")],
      ["recovered-sdk", Symbol("recovered-sdk-claim")],
      ["recovered-cli", Symbol("recovered-cli-claim")],
    ]);
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    ipcMocks.terminal.isActive.mockReturnValue(true);
    const providerLookup = vi
      .spyOn(ProviderFactory, "getProvider")
      .mockImplementation((providerType, sessionId) =>
        providerType === "claude-code" && sessionId === "recovered-sdk"
          ? ({ providerType: "claude-code", abort: providerAbort } as any)
          : null
      );

    service.setupIpcHandlers();
    const cancel = ipcMocks.handlers.get("ai:cancelRequest");
    expect(cancel).toBeTypeOf("function");

    const blockedStates: unknown[] = [
      null,
      { metadata: "{not-json" },
      { metadata: [] },
      { metadata: { modelChangeReconciliation: "malformed" } },
      { metadata: { modelChangeReconciliation: { status: "pending" } } },
    ];
    for (const state of blockedStates) {
      ipcMocks.loadSession.mockResolvedValueOnce(state);
      await expect(cancel!({}, "blocked-sdk", 3)).resolves.toEqual({
        success: false,
        error: "Session model recovery is pending",
      });
      ipcMocks.loadSession.mockResolvedValueOnce(state);
      await expect(cancel!({}, "blocked-cli", 4)).resolves.toEqual({
        success: false,
        error: "Session model recovery is pending",
      });
    }
    ipcMocks.loadSession.mockRejectedValueOnce(new Error("metadata down"));
    await expect(cancel!({}, "blocked-sdk")).resolves.toEqual({
      success: false,
      error: "Session model recovery is pending",
    });
    ipcMocks.loadSession.mockRejectedValueOnce(new Error("metadata down"));
    await expect(cancel!({}, "blocked-cli")).resolves.toEqual({
      success: false,
      error: "Session model recovery is pending",
    });

    expect(providerLookup).not.toHaveBeenCalled();
    expect(providerAbort).not.toHaveBeenCalled();
    expect(ipcMocks.terminal.isActive).not.toHaveBeenCalled();
    expect(ipcMocks.terminal.write).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(analytics).not.toHaveBeenCalled();
    expect(service.queueProcessingLeases.size).toBe(4);
    expect(service.queueClaimReservations.size).toBe(4);

    const recoveredSdk = {
      provider: "claude-code",
      metadata: { modelChangeReconciliation: null },
    };
    ipcMocks.loadSession
      .mockResolvedValueOnce(recoveredSdk)
      .mockResolvedValueOnce(recoveredSdk);
    await expect(cancel!({}, "recovered-sdk", 7)).resolves.toEqual({
      success: true,
    });
    expect(providerLookup).toHaveBeenCalledWith("claude-code", "recovered-sdk");
    expect(providerAbort).toHaveBeenCalledOnce();
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledWith(
      "recovered-sdk"
    );
    expect(service.queueProcessingLeases.has("recovered-sdk")).toBe(false);
    expect(service.queueClaimReservations.has("recovered-sdk")).toBe(false);

    const recoveredCli = {
      provider: "claude-code-cli",
      metadata: { modelChangeReconciliation: null },
    };
    ipcMocks.loadSession
      .mockResolvedValueOnce(recoveredCli)
      .mockResolvedValueOnce(recoveredCli);
    await expect(cancel!({}, "recovered-cli", 9)).resolves.toEqual({
      success: true,
    });
    expect(ipcMocks.terminal.isActive).toHaveBeenCalledWith("recovered-cli");
    expect(ipcMocks.terminal.write).toHaveBeenCalledWith(
      "recovered-cli",
      "\x03"
    );
    expect(
      ipcMocks.queueStore.sweepExecutingForSession
    ).toHaveBeenLastCalledWith("recovered-cli");
    expect(service.queueProcessingLeases.has("recovered-cli")).toBe(false);
    expect(service.queueClaimReservations.has("recovered-cli")).toBe(false);
    expect(analytics).toHaveBeenCalledTimes(4);
  });

  it("gates manual interrupts for every fail-closed metadata state and enters the provider exactly once after recovery", async () => {
    const service = Object.create(AIService.prototype) as any;
    service.queueProcessingLeases = new Map();
    service.queueClaimReservations = new Map([
      ["session-a", Symbol("session-a-claim")],
    ]);
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    const interruptCurrentTurn = vi.fn(async () => ({
      method: "provider-interrupt",
    }));
    vi.spyOn(ProviderFactory, "getProvider").mockImplementation(
      (providerType: string) => providerType === "openai-codex"
        ? ({ interruptCurrentTurn } as any)
        : null,
    );

    const blockedStates: unknown[] = [
      null,
      { metadata: "{not-json" },
      { metadata: [] },
      { metadata: { modelChangeReconciliation: "malformed" } },
      { metadata: { modelChangeReconciliation: { status: "pending" } } },
    ];
    for (const state of blockedStates) {
      ipcMocks.loadSession.mockResolvedValueOnce(state);
      await expect(
        service.interruptCurrentTurnForSession("session-a")
      ).resolves.toEqual({
        success: false,
        error: "Session model recovery is pending",
        nativeEntered: false,
      });
    }
    ipcMocks.loadSession.mockRejectedValueOnce(
      new Error("metadata unavailable")
    );
    await expect(
      service.interruptCurrentTurnForSession("session-a")
    ).resolves.toEqual({
      success: false,
      error: "Session model recovery is pending",
      nativeEntered: false,
    });
    expect(ipcMocks.databaseQuery).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();

    ipcMocks.loadSession.mockResolvedValueOnce({
      metadata: { modelChangeReconciliation: null },
    });
    ipcMocks.databaseQuery.mockResolvedValue({
      rows: [
        {
          provider: "openai-codex",
          status: "running",
          last_activity: 10,
          updated_at: 20,
        },
      ],
    });
    await expect(
      service.interruptCurrentTurnForSession("session-a")
    ).resolves.toEqual({
      success: true,
      method: "built-in:openai-codex:provider-interrupt",
      nativeEntered: true,
      forcedIdle: false,
    });
    expect(interruptCurrentTurn).toHaveBeenCalledTimes(1);
    expect(service.queueClaimReservations.has("session-a")).toBe(false);
  });
});

describe("AIService NIM-590 mixed-rail admission", () => {
  function setupCancelHarness() {
    const service = Object.create(AIService.prototype) as any;
    service.streamingHandler = { handle: vi.fn() };
    service.analytics = { sendEvent: vi.fn() };
    service.queueProcessingLeases = new Map<string, symbol>();
    service.queueClaimReservations = new Map<string, symbol>();
    service.queueDispatchCommitments = new Map<string, symbol>();
    service.queueCancellationFences = new Map();
    service.queueCancellationOperations = new Map();
    service.queueCancellationGeneration = 0;
    service.directSendInFlight = new Set<string>();
    service.rendererSendInFlight = new Set<string>();
    service.forceSessionIdleOnCancel = vi.fn(async () => true);
    service.publishQueueStateToSync = vi.fn(async () => undefined);
    service.setupIpcHandlers();
    return service;
  }

  function dispatchOptions(
    service: any,
    store: QueuedPromptStoreLike,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      claimReservations: service.queueClaimReservations,
      continueQueuedPromptChain: vi.fn(async () => undefined),
      isTurnAdmissionBlocked: (sessionId: string) => service.hasTurnAdmission(sessionId),
      logError: vi.fn(),
      logInfo: vi.fn(),
      onChainSettled: vi.fn(async () => undefined),
      onPromptClaimed: vi.fn(),
      processingLeases: service.queueProcessingLeases,
      preflight: vi.fn(async () => true),
      queueStore: store,
      sendMessageHandler: vi.fn(async () => ({ content: "ok" })),
      sessionDispatchCommitments: service.queueDispatchCommitments,
      sessionId: "session-cancel-race",
      source: "cancel race test",
      startSession: vi.fn(async () => undefined),
      targetWindow: liveWindow(),
      workspacePath: "D:\\repo",
      ...overrides,
    };
  }

  it("production cancel revokes a pending reservation with no cached provider", async () => {
    const service = setupCancelHarness();
    const row = queuedRow("reservation-pending");
    const store = dispatcherStore(row);
    let resolvePending!: (rows: ClaimedQueuedPrompt[]) => void;
    vi.mocked(store.listPending).mockImplementation(() => new Promise((resolve) => {
      resolvePending = resolve;
    }));
    const options = dispatchOptions(service, store);
    ipcMocks.loadSession.mockResolvedValue({
      provider: "claude-code",
      metadata: { modelChangeReconciliation: null },
    });
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    vi.spyOn(ProviderFactory, "getProvider").mockReturnValue(null);

    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.waitFor(() => expect(store.listPending).toHaveBeenCalledTimes(1));
    const cancel = ipcMocks.handlers.get("ai:cancelRequest");
    await expect(cancel!({}, "session-cancel-race", 0)).resolves.toEqual({ success: true });

    resolvePending([row]);
    await expect(attempt).resolves.toBe(false);
    expect(store.claim).not.toHaveBeenCalled();
    expect(store.beginDispatch).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledWith("session-cancel-race");
    expect(service.queueClaimReservations.has("session-cancel-race")).toBe(false);
  });

  it("production cancel revokes a post-claim lease while startSession awaits and no provider exists", async () => {
    const service = setupCancelHarness();
    const row = queuedRow("start-pending");
    const store = dispatcherStore(row);
    let resolveStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const options = dispatchOptions(service, store, {
      startSession: vi.fn(() => startGate),
    });
    ipcMocks.loadSession.mockResolvedValue({
      provider: "claude-code",
      metadata: { modelChangeReconciliation: null },
    });
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    vi.spyOn(ProviderFactory, "getProvider").mockReturnValue(null);

    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.waitFor(() => expect(options.startSession).toHaveBeenCalledTimes(1));
    expect(service.queueProcessingLeases.has("session-cancel-race")).toBe(true);

    const cancel = ipcMocks.handlers.get("ai:cancelRequest");
    await expect(cancel!({}, "session-cancel-race", 0)).resolves.toEqual({ success: true });
    expect(service.queueProcessingLeases.has("session-cancel-race")).toBe(false);

    resolveStart();
    await expect(attempt).resolves.toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.beginDispatch).not.toHaveBeenCalled();
    expect(options.sendMessageHandler).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledWith("session-cancel-race");
  });

  it("mobile cancel identity-fences a tentative claim through lifecycle settlement", async () => {
    const service = setupCancelHarness();
    const sessionId = "mobile-tentative";
    const tentativeOwner = Symbol("tentative-owner");
    service.queueClaimReservations.set(sessionId, tentativeOwner);
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 1,
      failed: 0,
      rolledBack: 2,
    });
    let releaseLifecycle!: () => void;
    const lifecycleGate = new Promise<void>((resolve) => {
      releaseLifecycle = resolve;
    });
    service.forceSessionIdleOnCancel.mockImplementation(async () => {
      expect(service.queueClaimReservations.has(sessionId)).toBe(false);
      expect(service.queueCancellationFences.has(sessionId)).toBe(true);
      await lifecycleGate;
    });

    const cancelNativeTurn = vi.fn(async (target) => {
      expect(target.isCurrent()).toBe(true);
      return { state: "native-entered" as const, method: "provider-abort" };
    });
    const cancel = service.cancelQueuedPromptTurnForMobile(sessionId, cancelNativeTurn);
    await vi.waitFor(() => expect(service.forceSessionIdleOnCancel).toHaveBeenCalledWith(sessionId));
    expect(service.queueCancellationFences.has(sessionId)).toBe(true);
    releaseLifecycle();

    await expect(cancel).resolves.toMatchObject({ rolledBack: 2, quarantined: false });
    expect(cancelNativeTurn).toHaveBeenCalledTimes(1);
    expect(service.queueClaimReservations.has(sessionId)).toBe(false);
    expect(service.publishQueueStateToSync).toHaveBeenCalledWith(sessionId);
  });

  it("mobile cancel revokes an active dispatch and settles lifecycle before reopening admission", async () => {
    const service = setupCancelHarness();
    const sessionId = "mobile-active";
    service.queueProcessingLeases.set(sessionId, Symbol("active-owner"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 1,
      rolledBack: 0,
    });
    let releaseLifecycle!: () => void;
    const lifecycleGate = new Promise<void>((resolve) => {
      releaseLifecycle = resolve;
    });
    service.forceSessionIdleOnCancel.mockImplementation(async () => {
      expect(service.queueProcessingLeases.has(sessionId)).toBe(false);
      expect(service.queueCancellationFences.has(sessionId)).toBe(true);
      await lifecycleGate;
    });

    const cancelNativeTurn = vi.fn(async (target) => {
      expect(target.isCurrent()).toBe(true);
      return { state: "native-entered" as const, method: "provider-abort" };
    });
    const cancel = service.cancelQueuedPromptTurnForMobile(sessionId, cancelNativeTurn);
    await vi.waitFor(() => expect(service.forceSessionIdleOnCancel).toHaveBeenCalledWith(sessionId));
    expect(service.hasTurnAdmission(sessionId)).toBe(true);
    releaseLifecycle();

    await expect(cancel).resolves.toMatchObject({ rolledBack: 0, quarantined: false });
    expect(cancelNativeTurn).toHaveBeenCalledTimes(1);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
    expect(service.publishQueueStateToSync).toHaveBeenCalledWith(sessionId);
  });

  it("mobile cancel fences real queue admission across deferred provider lookup and abort", async () => {
    const service = setupCancelHarness();
    const sessionId = "mobile-deferred-provider";
    service.queueProcessingLeases.set(sessionId, Symbol("active-native-owner"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 4,
    });

    let resolveProviderLookup!: (provider: { abort: () => void }) => void;
    const providerLookupGate = new Promise<{ abort: () => void }>((resolve) => {
      resolveProviderLookup = resolve;
    });
    const deferredProviderLookup = vi.fn(() => providerLookupGate);
    const abort = vi.fn();
    const cancel = service.cancelQueuedPromptTurnForMobile(sessionId, async (target: { isCurrent(): boolean }) => {
      const provider = await deferredProviderLookup();
      if (!target.isCurrent()) {
        return { state: "unknown" as const, error: "stale generation" };
      }
      provider.abort();
      return { state: "native-entered" as const, method: "provider-abort" };
    });

    await vi.waitFor(() => expect(deferredProviderLookup).toHaveBeenCalledTimes(1));
    expect(service.queueProcessingLeases.has(sessionId)).toBe(false);
    expect(service.queueCancellationFences.has(sessionId)).toBe(true);

    const blockedStore = dispatcherStore(queuedRow("blocked-during-provider-lookup"));
    await expect(tryClaimAndDispatchNextQueuedPrompt(dispatchOptions(service, blockedStore, {
      sessionId,
    }))).resolves.toBe(false);
    expect(blockedStore.listPending).not.toHaveBeenCalled();
    expect(blockedStore.claim).not.toHaveBeenCalled();

    resolveProviderLookup({ abort });
    await expect(cancel).resolves.toMatchObject({ rolledBack: 4, quarantined: false });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.invocationCallOrder[0])
      .toBeLessThan(ipcMocks.queueStore.sweepExecutingForSession.mock.invocationCallOrder[0]);
    expect(ipcMocks.queueStore.sweepExecutingForSession.mock.invocationCallOrder[0])
      .toBeLessThan(service.forceSessionIdleOnCancel.mock.invocationCallOrder[0]);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);

    const reopenedStore = dispatcherStore(queuedRow("after-mobile-cancel"));
    vi.mocked(reopenedStore.listPending).mockResolvedValue([]);
    await expect(tryClaimAndDispatchNextQueuedPrompt(dispatchOptions(service, reopenedStore, {
      sessionId,
    }))).resolves.toBe(false);
    expect(reopenedStore.listPending).toHaveBeenCalledWith(sessionId);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
  });

  it("mobile native cancellation failure quarantines without destructive sweep until explicit recovery", async () => {
    const service = setupCancelHarness();
    const sessionId = "mobile-native-failure";
    service.queueProcessingLeases.set(sessionId, Symbol("active-native-owner"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 2,
    });
    const nativeFailure = vi.fn(async () => {
      throw new Error("provider lookup failed");
    });

    await expect(service.cancelQueuedPromptTurnForMobile(
      sessionId,
      nativeFailure,
    )).resolves.toMatchObject({
      rolledBack: 0,
      quarantined: true,
      nativeOutcome: { state: "unknown", error: "provider lookup failed" },
    });

    expect(nativeFailure).toHaveBeenCalledTimes(1);
    expect(ipcMocks.queueStore.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(service.forceSessionIdleOnCancel).not.toHaveBeenCalled();
    expect(service.publishQueueStateToSync).not.toHaveBeenCalled();
    expect(service.hasTurnAdmission(sessionId)).toBe(true);

    const blockedStore = dispatcherStore(queuedRow("quarantined"));
    await expect(tryClaimAndDispatchNextQueuedPrompt(dispatchOptions(service, blockedStore, {
      sessionId,
    }))).resolves.toBe(false);
    expect(blockedStore.listPending).not.toHaveBeenCalled();
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });
    await expect(service.sendMessageDirect(
      sessionId,
      "D:\\repo",
      "must remain blocked",
    )).rejects.toThrow("already processing a turn");

    await expect(service.cancelQueuedPromptTurnForMobile(
      sessionId,
      async (target: { isCurrent(): boolean }) => {
        expect(target.isCurrent()).toBe(true);
        return { state: "proven-no-owner" as const, method: "explicit-liveness-proof" };
      },
    )).resolves.toMatchObject({ quarantined: false, rolledBack: 2 });
    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledTimes(1);
    expect(service.publishQueueStateToSync).toHaveBeenCalledWith(sessionId);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
  });

  it("renderer send reports incomplete cancellation and reopens only after explicit recovery", async () => {
    const service = setupCancelHarness();
    const sessionId = "renderer-quarantine-recovery";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });

    await service.cancelQueuedPromptTurnForMobile(
      sessionId,
      async () => ({ state: "unknown" as const, error: "owner still live" }),
    );
    const rendererSend = ipcMocks.handlers.get("ai:sendMessage");
    await expect(rendererSend!(
      {},
      "must remain blocked",
      undefined,
      sessionId,
      "D:\\repo",
    )).rejects.toThrow("Session cancellation is incomplete");
    expect(service.streamingHandler.handle).not.toHaveBeenCalled();

    await service.cancelQueuedPromptTurnForMobile(
      sessionId,
      async () => ({ state: "proven-no-owner" as const, method: "explicit-recovery" }),
    );
    await expect(rendererSend!(
      {},
      "now safe",
      undefined,
      sessionId,
      "D:\\repo",
    )).resolves.toBeUndefined();
    expect(service.streamingHandler.handle).toHaveBeenCalledTimes(1);
  });

  it("joins two concurrent mobile cancels and settles the captured generation exactly once", async () => {
    const service = setupCancelHarness();
    const sessionId = "mobile-double-cancel";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 1,
    });
    let finishNative!: () => void;
    const nativeGate = new Promise<void>((resolve) => {
      finishNative = resolve;
    });
    const firstNative = vi.fn(async (target: { isCurrent(): boolean }) => {
      await nativeGate;
      expect(target.isCurrent()).toBe(true);
      return { state: "native-entered" as const, method: "provider-abort" };
    });
    const lateNative = vi.fn(async () => ({
      state: "native-entered" as const,
      method: "must-not-run",
    }));

    const first = service.cancelQueuedPromptTurnForMobile(sessionId, firstNative);
    await vi.waitFor(() => expect(firstNative).toHaveBeenCalledTimes(1));
    const duplicate = service.cancelQueuedPromptTurnForMobile(sessionId, lateNative);
    expect(lateNative).not.toHaveBeenCalled();
    expect(service.hasTurnAdmission(sessionId)).toBe(true);

    finishNative();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult).toEqual(duplicateResult);
    expect(firstResult).toMatchObject({ rolledBack: 1, quarantined: false });
    expect(lateNative).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledTimes(1);
    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
  });

  it("mobile cancel and desktop cancel join one owner without a late replacement abort", async () => {
    const service = setupCancelHarness();
    const sessionId = "mobile-desktop-cross-rail";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });
    let finishNative!: () => void;
    const nativeGate = new Promise<void>((resolve) => {
      finishNative = resolve;
    });
    const mobileNative = vi.fn(async () => {
      await nativeGate;
      return { state: "native-entered" as const, method: "provider-abort" };
    });

    const mobileCancel = service.cancelQueuedPromptTurnForMobile(sessionId, mobileNative);
    await vi.waitFor(() => expect(mobileNative).toHaveBeenCalledTimes(1));
    const desktopHandler = ipcMocks.handlers.get("ai:cancelRequest");
    const desktopCancel = desktopHandler!({}, sessionId, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ipcMocks.queueStore.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(service.hasTurnAdmission(sessionId)).toBe(true);

    finishNative();
    await expect(mobileCancel).resolves.toMatchObject({ quarantined: false });
    await expect(desktopCancel).resolves.toEqual({ success: true });
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledTimes(1);
    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
  });

  it("mobile cancel and ordinary interrupt join one captured cancellation generation", async () => {
    const service = setupCancelHarness();
    const sessionId = "mobile-interrupt-cross-rail";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });
    ipcMocks.databaseQuery.mockResolvedValue({
      rows: [{
        provider: "openai-codex",
        status: "running",
        last_activity: 10,
        updated_at: 20,
      }],
    });
    const providerInterrupt = vi.fn(async () => ({
      method: "must-not-run",
      hadActiveTurn: true,
    }));
    vi.spyOn(ProviderFactory, "getProvider").mockImplementation(
      (providerType: string) => providerType === "openai-codex"
        ? ({ interruptCurrentTurn: providerInterrupt } as any)
        : null,
    );
    let finishMobile!: () => void;
    const mobileGate = new Promise<void>((resolve) => {
      finishMobile = resolve;
    });
    const mobileNative = vi.fn(async () => {
      await mobileGate;
      return { state: "native-entered" as const, method: "provider-abort" };
    });

    const mobileCancel = service.cancelQueuedPromptTurnForMobile(sessionId, mobileNative);
    await vi.waitFor(() => expect(mobileNative).toHaveBeenCalledTimes(1));
    const interrupt = service.interruptCurrentTurnForSession(sessionId);
    await vi.waitFor(() => expect(ipcMocks.databaseQuery).toHaveBeenCalled());
    expect(providerInterrupt).not.toHaveBeenCalled();

    finishMobile();
    await expect(mobileCancel).resolves.toMatchObject({ quarantined: false });
    await expect(interrupt).resolves.toEqual({
      success: true,
      method: "provider-abort",
      nativeEntered: true,
      // The mobile cancel that owns this joined operation always requests
      // forceLifecycleSettlement, so forceSessionIdleOnCancel genuinely ran --
      // forcedIdle must report that (via lifecycleSettled), not re-derive a
      // stale answer from this winning outcome's own settleLifecycle bit
      // (which is unrelated to whether a joiner forced settlement). NIM-590
      // batch item 9.
      forcedIdle: true,
    });
    expect(providerInterrupt).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledTimes(1);
    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
  });

  it("ordinary interrupt owns cancellation before a mobile duplicate and never runs the mobile callback", async () => {
    const service = setupCancelHarness();
    const sessionId = "interrupt-mobile-cross-rail";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });
    ipcMocks.databaseQuery.mockResolvedValue({
      rows: [{
        provider: "openai-codex",
        status: "running",
        last_activity: 10,
        updated_at: 20,
      }],
    });
    let finishInterrupt!: (result: { method: string; hadActiveTurn: boolean }) => void;
    const interruptGate = new Promise<{ method: string; hadActiveTurn: boolean }>((resolve) => {
      finishInterrupt = resolve;
    });
    const providerInterrupt = vi.fn(() => interruptGate);
    vi.spyOn(ProviderFactory, "getProvider").mockImplementation(
      (providerType: string) => providerType === "openai-codex"
        ? ({ interruptCurrentTurn: providerInterrupt } as any)
        : null,
    );
    const lateMobileNative = vi.fn(async () => ({
      state: "native-entered" as const,
      method: "must-not-run",
    }));

    const interrupt = service.interruptCurrentTurnForSession(sessionId);
    await vi.waitFor(() => expect(providerInterrupt).toHaveBeenCalledTimes(1));
    const mobileJoin = service.cancelQueuedPromptTurnForMobile(sessionId, lateMobileNative);
    expect(lateMobileNative).not.toHaveBeenCalled();
    expect(service.hasTurnAdmission(sessionId)).toBe(true);

    finishInterrupt({ method: "provider-interrupt", hadActiveTurn: true });
    await expect(interrupt).resolves.toEqual({
      success: true,
      method: "built-in:openai-codex:provider-interrupt",
      nativeEntered: true,
      // The late-joining mobile cancel flips the shared operation's
      // forceLifecycleSettlement to true before settlement runs, so
      // forceSessionIdleOnCancel genuinely executes -- forcedIdle must
      // reflect that (lifecycleSettled), not this outcome's own
      // settleLifecycle bit. See NIM-590 batch item 9.
      forcedIdle: true,
    });
    await expect(mobileJoin).resolves.toMatchObject({ quarantined: false });
    expect(lateMobileNative).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledTimes(1);
    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    expect(service.publishQueueStateToSync).toHaveBeenCalledWith(sessionId);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
  });

  it("a mobile cancel joins an already-owned cross-rail cancellation and never runs late", async () => {
    const service = setupCancelHarness();
    const sessionId = "desktop-mobile-cross-rail";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    let finishDesktop!: () => void;
    const desktopGate = new Promise<void>((resolve) => {
      finishDesktop = resolve;
    });
    const desktopNative = vi.fn(async () => {
      await desktopGate;
      return { state: "native-entered" as const, method: "desktop-provider-abort" };
    });
    const lateMobileNative = vi.fn(async () => ({
      state: "native-entered" as const,
      method: "must-not-run",
    }));

    const desktopOwner = service.runQueuedTurnCancellation(
      sessionId,
      "desktop-first test",
      desktopNative,
    );
    await vi.waitFor(() => expect(desktopNative).toHaveBeenCalledTimes(1));
    const mobileJoin = service.cancelQueuedPromptTurnForMobile(sessionId, lateMobileNative);
    expect(lateMobileNative).not.toHaveBeenCalled();

    finishDesktop();
    await expect(desktopOwner).resolves.toMatchObject({ quarantined: false });
    await expect(mobileJoin).resolves.toMatchObject({ quarantined: false });
    expect(lateMobileNative).not.toHaveBeenCalled();
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledTimes(1);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
  });

  it("quarantines instead of reporting success when lifecycle settlement throws", async () => {
    // NIM-590 batch item 4: a cleanup-stage failure (here, forceSessionIdleOnCancel
    // throwing) must not be reported as a clean success -- the local lifecycle
    // may still show 'running' even though native cancellation was entered, so
    // the fence must stay in place (retry required) rather than silently
    // declaring victory.
    //
    // lifecycleSettled: false (not true) is a 4th flipped-premise assertion,
    // found via an independent review pass AFTER the original 3: the pre-fix
    // code returned shouldSettleLifecycle (the pre-attempt intent) here, which
    // stayed true even though forceSessionIdleOnCancel threw and settled
    // nothing. See NIM-590 batch item 9's lifecycleSettled fix.
    const service = setupCancelHarness();
    const sessionId = "cancel-settlement-throws";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    service.forceSessionIdleOnCancel.mockRejectedValue(new Error("state manager unavailable"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });

    await expect(service.cancelQueuedPromptTurnForMobile(
      sessionId,
      async () => ({ state: "native-entered" as const, method: "provider-abort" }),
    )).resolves.toMatchObject({ quarantined: true, lifecycleSettled: false });

    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    // The operation itself always finishes (no leaked in-flight promise)...
    expect(service.queueCancellationOperations.has(sessionId)).toBe(false);
    // ...but the fence and admission quarantine remain, forcing a retry.
    expect(service.queueCancellationFences.has(sessionId)).toBe(true);
    expect(service.hasTurnAdmission(sessionId)).toBe(true);
  });

  it("provider-managed native settlement gets a safety-net replay that finds it genuinely stranded", async () => {
    // 5th flipped-premise test, found via the program-owner-directed bounded
    // investigation into finding 3's residual gap (2026-08-10) -- this test
    // previously asserted forceSessionIdleOnCancel was NEVER called for
    // provider-managed settlement (settleLifecycle: false). That was correct
    // under the old code, but it was exactly the blind spot finding 3
    // described: if the provider's own completion callback (onChainSettled /
    // onTeammatesAllCompleted / onSubagentsDrainSettled) already fired and
    // was discarded because this fence made hasQueueDispatchAdmission true
    // at the time, NOTHING would ever end the session -- a "clean" cancel
    // (quarantined: false) could silently leave it stuck 'running' forever.
    // forceSessionIdleOnCancel now returns true/false (round-2 correction:
    // a Codex delta-review finding -- the original void-returning version
    // swallowed real interruptSession failures, indistinguishable from a
    // clean no-op), so lifecycleSettled can now accurately report true when
    // the replay finds the session genuinely still 'running' (the harness's
    // default mock return) and forces it idle.
    const service = setupCancelHarness();
    const sessionId = "provider-managed-settlement";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });

    await expect(service.runQueuedTurnCancellation(
      sessionId,
      "provider managed test",
      async () => ({
        state: "native-entered" as const,
        method: "graceful-interrupt",
        settleLifecycle: false,
      }),
    )).resolves.toMatchObject({ quarantined: false, lifecycleSettled: true });

    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
  });

  it("provider-managed native settlement reports lifecycleSettled:false when the replay finds nothing stranded", async () => {
    // Companion to the test above: proves the true/false distinction is
    // real, not just the harness default -- when the replay's own
    // shouldForceIdleOnCancel check would find the session already
    // correctly settled (the provider's completion ran normally, nothing
    // was ever dropped), forceSessionIdleOnCancel returns false and
    // lifecycleSettled must accurately stay false, not just because the
    // primary branch never ran (the pre-existing distinction) but also
    // because the replay itself confirmed nothing needed forcing.
    const service = setupCancelHarness();
    const sessionId = "provider-managed-settlement-already-clean";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    service.forceSessionIdleOnCancel.mockResolvedValue(false);
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });

    await expect(service.runQueuedTurnCancellation(
      sessionId,
      "provider managed test",
      async () => ({
        state: "native-entered" as const,
        method: "graceful-interrupt",
        settleLifecycle: false,
      }),
    )).resolves.toMatchObject({ quarantined: false, lifecycleSettled: false });

    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    expect(service.hasTurnAdmission(sessionId)).toBe(false);
  });

  it("quarantines instead of clearing the fence when the deferred-settlement replay itself fails", async () => {
    // Codex delta-review finding (round 2 of the finding-3 fix): the
    // original replay call was unguarded on the (correct) premise that
    // forceSessionIdleOnCancel never threw -- but that premise made a real
    // repair failure INDISTINGUISHABLE from a clean no-op, since the old
    // void-returning version swallowed interruptSession errors internally.
    // Now that forceSessionIdleOnCancel rejects on a genuine failure instead
    // of swallowing it, a failed replay must quarantine (retry required),
    // not silently clear the fence and report a clean cancel.
    const service = setupCancelHarness();
    const sessionId = "provider-managed-settlement-replay-fails";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    service.forceSessionIdleOnCancel.mockRejectedValue(new Error("state manager unavailable"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });

    await expect(service.runQueuedTurnCancellation(
      sessionId,
      "provider managed test",
      async () => ({
        state: "native-entered" as const,
        method: "graceful-interrupt",
        settleLifecycle: false,
      }),
    )).resolves.toMatchObject({ quarantined: true, lifecycleSettled: false });

    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    expect(service.queueCancellationFences.has(sessionId)).toBe(true);
    expect(service.hasTurnAdmission(sessionId)).toBe(true);
  });

  it("sendMessageDirect rejects while a queued claim reservation owns admission", async () => {
    const service = Object.create(AIService.prototype) as any;
    service.sendMessageHandler = vi.fn(async () => ({ content: "unexpected" }));
    service.queueProcessingLeases = new Map<string, symbol>();
    service.queueClaimReservations = new Map([
      ["session-direct-race", Symbol("tentative-claim")],
    ]);
    service.directSendInFlight = new Set<string>();
    service.rendererSendInFlight = new Set<string>();
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });

    await expect(service.sendMessageDirect(
      "session-direct-race",
      "D:\\repo",
      "compact now",
    )).rejects.toThrow("already processing a turn");
    expect(service.sendMessageHandler).not.toHaveBeenCalled();
  });

  it("queued claim declines while a live sendMessageDirect turn owns admission", async () => {
    const service = Object.create(AIService.prototype) as any;
    service.queueProcessingLeases = new Map<string, symbol>();
    service.queueClaimReservations = new Map<string, symbol>();
    service.directSendInFlight = new Set<string>();
    service.rendererSendInFlight = new Set<string>();
    let finishDirect!: (result: { content: string }) => void;
    const directGate = new Promise<{ content: string }>((resolve) => {
      finishDirect = resolve;
    });
    service.sendMessageHandler = vi.fn(() => directGate);
    vi.spyOn(WindowManager, "findWindowByWorkspace").mockReturnValue(liveWindow());
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });

    const direct = service.sendMessageDirect(
      "session-direct-race",
      "D:\\repo",
      "compact now",
    );
    await vi.waitFor(() => expect(service.sendMessageHandler).toHaveBeenCalledTimes(1));
    expect(service.directSendInFlight.has("session-direct-race")).toBe(true);

    const store = dispatcherStore(queuedRow("direct-first"));
    const options = dispatchOptions(service, store, {
      sessionId: "session-direct-race",
    });

    await expect(tryClaimAndDispatchNextQueuedPrompt(options)).resolves.toBe(false);
    expect(store.listPending).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(service.queueClaimReservations.size).toBe(0);

    finishDirect({ content: "done" });
    await expect(direct).resolves.toEqual({ content: "done" });
    expect(service.directSendInFlight.has("session-direct-race")).toBe(false);
  });

  it("ordinary interrupt revokes queue ownership even when no provider is cached", async () => {
    const service = Object.create(AIService.prototype) as any;
    service.queueProcessingLeases = new Map([
      ["session-interrupt-race", Symbol("active-dispatch")],
    ]);
    service.queueClaimReservations = new Map([
      ["session-interrupt-race", Symbol("tentative-claim")],
    ]);
    service.forceSessionIdleOnCancel = vi.fn(async () => {
      expect(service.queueProcessingLeases.has("session-interrupt-race")).toBe(false);
      expect(service.queueClaimReservations.has("session-interrupt-race")).toBe(true);
      return true;
    });
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });
    ipcMocks.databaseQuery.mockResolvedValue({
      rows: [{
        provider: "openai-codex",
        status: "running",
        last_activity: 10,
        updated_at: 20,
      }],
    });
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
    vi.spyOn(ProviderFactory, "getProvider").mockReturnValue(null);

    await expect(service.interruptCurrentTurnForSession(
      "session-interrupt-race",
    )).resolves.toEqual({
      success: false,
      error: "No active native owner for session",
      nativeEntered: false,
    });
    expect(ipcMocks.queueStore.sweepExecutingForSession).toHaveBeenCalledWith("session-interrupt-race");
    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledWith("session-interrupt-race");
    expect(service.queueProcessingLeases.has("session-interrupt-race")).toBe(false);
    expect(service.queueClaimReservations.has("session-interrupt-race")).toBe(false);
  });

  it("priority interrupt leaves queue ownership intact until native entry", async () => {
    const activeLease = Symbol("active-dispatch");
    const claimReservation = Symbol("tentative-claim");
    const service = Object.create(AIService.prototype) as any;
    service.queueProcessingLeases = new Map([
      ["session-priority-race", activeLease],
    ]);
    service.queueClaimReservations = new Map([
      ["session-priority-race", claimReservation],
    ]);
    service.forceSessionIdleOnCancel = vi.fn(async () => true);
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });
    ipcMocks.databaseQuery.mockResolvedValue({
      rows: [{
        provider: "openai-codex",
        status: "running",
        last_activity: 10,
        updated_at: 20,
      }],
    });
    vi.spyOn(ProviderFactory, "getProvider").mockReturnValue(null);

    await expect(service.interruptCurrentTurnForSession(
      "session-priority-race",
      {
        status: "running",
        generation: "running:10:20",
        lastActivity: 10,
        updatedAt: 20,
      },
    )).resolves.toEqual({
      success: false,
      error: "No active native owner for session",
      nativeEntered: false,
    });
    expect(ipcMocks.queueStore.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(service.forceSessionIdleOnCancel).not.toHaveBeenCalled();
    expect(service.queueProcessingLeases.get("session-priority-race")).toBe(activeLease);
    expect(service.queueClaimReservations.get("session-priority-race")).toBe(claimReservation);
  });

  it("hasQueueDispatchAdmission is true under any single owner and false once all three clear (NIM-590 batch item 3)", () => {
    // onChainSettled (AIService.ts) and onTeammatesAllCompleted/
    // onSubagentsDrainSettled (MessageStreamingHandler.ts) all gate endSession
    // on this exact predicate so an unknown/quarantined cancellation or a
    // fresh claim can't be raced into idle underneath them. Each owner is
    // independently sufficient and independently necessary.
    const service = setupCancelHarness();
    const sessionId = "admission-predicate";
    expect(service.hasQueueDispatchAdmission(sessionId)).toBe(false);

    service.queueProcessingLeases.set(sessionId, Symbol("lease"));
    expect(service.hasQueueDispatchAdmission(sessionId)).toBe(true);
    service.queueProcessingLeases.delete(sessionId);
    expect(service.hasQueueDispatchAdmission(sessionId)).toBe(false);

    service.queueClaimReservations.set(sessionId, Symbol("reservation"));
    expect(service.hasQueueDispatchAdmission(sessionId)).toBe(true);
    service.queueClaimReservations.delete(sessionId);
    expect(service.hasQueueDispatchAdmission(sessionId)).toBe(false);

    service.queueCancellationFences.set(sessionId, {
      generation: "cancel-predicate-test",
      quarantined: false,
      targetLease: undefined,
      targetReservation: undefined,
      token: Symbol("fence-token"),
    });
    expect(service.hasQueueDispatchAdmission(sessionId)).toBe(true);
    service.queueCancellationFences.delete(sessionId);
    expect(service.hasQueueDispatchAdmission(sessionId)).toBe(false);
  });

  it("a queued dispatch past settleAdmission(true) is not declared proven-no-owner by a concurrent cancellation before it registers a native owner", async () => {
    // NIM-590 batch item 1, the deeper gap: exercises the REAL interaction
    // between queuedPromptDispatcher's sessionDispatchCommitments and
    // AIService's hasUncensusableAdmission -- not a synthetic map write.
    const service = setupCancelHarness();
    const sessionId = "session-cancel-race";
    const row = queuedRow("commit-gap");
    const store = dispatcherStore(row);
    let resolveSend!: () => void;
    const sendGate = new Promise<{ content: string }>((resolve) => {
      resolveSend = () => resolve({ content: "ok" });
    });
    const options = dispatchOptions(service, store, {
      sendMessageHandler: vi.fn(() => sendGate),
    });
    ipcMocks.loadSession.mockResolvedValue({
      provider: "claude-code",
      metadata: { modelChangeReconciliation: null },
    });
    vi.spyOn(ProviderFactory, "getProvider").mockReturnValue(null);

    const attempt = tryClaimAndDispatchNextQueuedPrompt(options);
    await vi.waitFor(() => expect(options.sendMessageHandler).toHaveBeenCalledTimes(1));
    // Past the point of no return: committed (settleAdmission(true) already
    // fired, resolving the admission receipt below), but sendMessageHandler
    // -- which will eventually register the real native owner -- has not
    // resolved yet.
    await expect(attempt).resolves.toBe(true);
    expect(service.queueDispatchCommitments.has(sessionId)).toBe(true);

    const censusFindsNothing = vi.fn(async (target: { isCurrent(): boolean }) => {
      expect(target.isCurrent()).toBe(true);
      return { state: "proven-no-owner" as const, method: "all-native-owner-registries-empty" };
    });
    await expect(service.cancelQueuedPromptTurnForMobile(
      sessionId,
      censusFindsNothing,
    )).resolves.toMatchObject({
      quarantined: true,
      nativeOutcome: {
        state: "unknown",
        error: expect.stringContaining("committed to starting"),
      },
    });
    expect(censusFindsNothing).toHaveBeenCalledTimes(1);
    // A cleanup sweep must not run against a session that might still be
    // about to start a real turn -- that would be the destructive-cleanup
    // half of this same bug.
    expect(ipcMocks.queueStore.sweepExecutingForSession).not.toHaveBeenCalled();
    // Falsely declaring idle here would let a new send race in underneath
    // committed work -- admission must still show busy.
    expect(service.hasTurnAdmission(sessionId)).toBe(true);

    resolveSend();
    await vi.waitFor(() => expect(service.queueDispatchCommitments.has(sessionId)).toBe(false));
    expect(store.completeAfterDispatch).toHaveBeenCalledTimes(1);
  });

  it("renderer admission blocks a concurrent cancellation from declaring proven-no-owner until the send settles", async () => {
    // NIM-590 batch item 1, renderer leg: ai:sendMessage is the real IPC
    // entry point wired by setupIpcHandlers(), not a synthetic call.
    const service = setupCancelHarness();
    const sessionId = "renderer-commit-gap";
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });
    let resolveHandle!: () => void;
    const handleGate = new Promise<void>((resolve) => {
      resolveHandle = resolve;
    });
    service.streamingHandler.handle.mockImplementation(() => handleGate);

    const rendererSend = ipcMocks.handlers.get("ai:sendMessage");
    const sendPromise = rendererSend!({}, "hello", undefined, sessionId, "D:\\repo");
    await vi.waitFor(() => expect(service.rendererSendInFlight.has(sessionId)).toBe(true));

    const censusFindsNothing = vi.fn(async (target: { isCurrent(): boolean }) => {
      expect(target.isCurrent()).toBe(true);
      return { state: "proven-no-owner" as const, method: "all-native-owner-registries-empty" };
    });
    await expect(service.cancelQueuedPromptTurnForMobile(
      sessionId,
      censusFindsNothing,
    )).resolves.toMatchObject({
      quarantined: true,
      nativeOutcome: {
        state: "unknown",
        error: expect.stringContaining("committed to starting"),
      },
    });
    expect(ipcMocks.queueStore.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(service.hasTurnAdmission(sessionId)).toBe(true);

    resolveHandle();
    await expect(sendPromise).resolves.toBeUndefined();
    expect(service.rendererSendInFlight.has(sessionId)).toBe(false);
  });

  it("quarantines when the durable sweep throws, even though native cancellation entered cleanly (NIM-590 batch item 4)", async () => {
    // Distinct cleanup-failure branch from forceSessionIdleOnCancel throwing
    // (covered by "quarantines instead of reporting success..." above) --
    // both must gate cleanupConfirmed independently.
    const service = setupCancelHarness();
    const sessionId = "cancel-sweep-throws";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.queueStore.sweepExecutingForSession.mockRejectedValue(new Error("db unavailable"));

    await expect(service.cancelQueuedPromptTurnForMobile(
      sessionId,
      async () => ({ state: "native-entered" as const, method: "provider-abort" }),
    )).resolves.toMatchObject({ quarantined: true, rolledBack: 0 });

    // Lifecycle settlement is still attempted despite the sweep failure --
    // one cleanup step failing must not skip the other.
    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
    expect(service.queueCancellationFences.has(sessionId)).toBe(true);
    expect(service.hasTurnAdmission(sessionId)).toBe(true);
  });

  it("forcedIdle reflects genuine lifecycle settlement, not the native outcome's own settleLifecycle bit, when a mobile cancel forces it (NIM-590 batch item 9)", async () => {
    // A native outcome can explicitly decline lifecycle settlement
    // (settleLifecycle: false, e.g. "the provider already handled its own
    // cleanup") while a joining mobile cancel still forces
    // forceSessionIdleOnCancel to run for an unrelated reason. The receipt
    // must reflect what genuinely happened (lifecycleSettled), not re-derive
    // from a bit that answers a different question.
    const service = setupCancelHarness();
    const sessionId = "cancel-settlement-divergence";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.queueStore.sweepExecutingForSession.mockResolvedValue({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });

    const result = await service.cancelQueuedPromptTurnForMobile(
      sessionId,
      async () => ({
        state: "native-entered" as const,
        method: "provider-managed-cleanup",
        settleLifecycle: false,
      }),
    );

    expect(result).toMatchObject({ quarantined: false, lifecycleSettled: true });
    expect(result.nativeOutcome).toMatchObject({ settleLifecycle: false });
    expect(service.forceSessionIdleOnCancel).toHaveBeenCalledTimes(1);
  });

  it("ai:cancelRequest reports failure, not success, when native cancellation enters but cleanup cannot be confirmed (NIM-590 batch item 4, independent-review finding)", async () => {
    // cancelRequest previously only checked nativeOutcome.state === 'unknown';
    // a clean native abort with a failed durable sweep afterward (quarantined:
    // true) was reported as success:true to the renderer.
    const service = setupCancelHarness();
    const sessionId = "cancel-request-quarantine";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });
    const abort = vi.fn();
    vi.spyOn(ProviderFactory, "getProvider").mockImplementation(
      (providerType: string) => providerType === "openai-codex" ? ({ abort } as any) : null,
    );
    ipcMocks.queueStore.sweepExecutingForSession.mockRejectedValue(new Error("db unavailable"));

    const cancelRequest = ipcMocks.handlers.get("ai:cancelRequest");
    await expect(cancelRequest!({}, sessionId, 0)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("cleanup could not be confirmed"),
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(service.hasTurnAdmission(sessionId)).toBe(true);
  });

  it("interruptCurrentTurnForSession reports failure, not success, when native interrupt enters but cleanup cannot be confirmed (NIM-590 batch item 4, independent-review finding)", async () => {
    const service = setupCancelHarness();
    const sessionId = "interrupt-quarantine";
    service.queueProcessingLeases.set(sessionId, Symbol("captured-turn"));
    ipcMocks.loadSession.mockResolvedValue({ metadata: { modelChangeReconciliation: null } });
    ipcMocks.databaseQuery.mockResolvedValue({
      rows: [{
        provider: "openai-codex",
        status: "running",
        last_activity: 10,
        updated_at: 20,
      }],
    });
    const providerInterrupt = vi.fn(async () => ({ method: "provider-interrupt", hadActiveTurn: true }));
    vi.spyOn(ProviderFactory, "getProvider").mockImplementation(
      (providerType: string) => providerType === "openai-codex" ? ({ interruptCurrentTurn: providerInterrupt } as any) : null,
    );
    // hadActiveTurn:true means the provider owns its own settlement
    // (shouldSettleLifecycle is false for an ordinary, non-forcing interrupt
    // here), so the sweep failure is what must gate the receipt.
    ipcMocks.queueStore.sweepExecutingForSession.mockRejectedValue(new Error("db unavailable"));

    await expect(service.interruptCurrentTurnForSession(sessionId)).resolves.toMatchObject({
      success: false,
      nativeEntered: true,
      method: "built-in:openai-codex:provider-interrupt",
      forcedIdle: false,
    });
    expect(providerInterrupt).toHaveBeenCalledTimes(1);
    expect(service.hasTurnAdmission(sessionId)).toBe(true);
  });
});
