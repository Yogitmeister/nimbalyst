import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setSessionStore: vi.fn(),
  clearSessionStore: vi.fn(),
  setAgentStore: vi.fn(),
  clearAgentStore: vi.fn(),
  clearSessionFileStore: vi.fn(),
  clearTranscript: vi.fn(),
  reinitializeSync: vi.fn(),
  shutdownSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@nimbalyst/runtime", () => ({
  AISessionsRepository: {
    setStore: mocks.setSessionStore,
    clearStore: mocks.clearSessionStore,
  },
  SessionFilesRepository: {
    setStore: vi.fn(),
    clearStore: mocks.clearSessionFileStore,
  },
  AgentMessagesRepository: {
    setStore: mocks.setAgentStore,
    clearStore: mocks.clearAgentStore,
  },
  TranscriptMigrationRepository: {
    setService: vi.fn(),
    clearService: mocks.clearTranscript,
  },
}));
vi.mock("../SyncManager", () => ({
  initializeSync: vi.fn(),
  reinitializeSync: mocks.reinitializeSync,
  shutdownSync: mocks.shutdownSync,
  isSyncEnabled: () => false,
}));
vi.mock("../TrackerSyncManager", () => ({
  shutdownTrackerSync: vi.fn(),
  initializeTrackerSync: vi.fn(),
}));
vi.mock("../../window/WindowManager", () => ({
  windows: new Map(),
  windowStates: new Map(),
}));
vi.mock("../SyncedAgentMessagesStore", () => ({
  createSyncedAgentMessagesStore: vi.fn(),
}));
vi.mock("../PGLiteSessionStore", () => ({ createPGLiteSessionStore: vi.fn() }));
vi.mock("../PGLiteSessionFileStore", () => ({
  createPGLiteSessionFileStore: vi.fn(),
}));
vi.mock("../PGLiteAgentMessagesStore", () => ({
  createPGLiteAgentMessagesStore: vi.fn(),
}));
vi.mock("../PGLiteWorkspaceRepository", () => ({
  createPGLiteWorkspaceRepository: vi.fn(),
}));
vi.mock("../PGLiteDocumentsRepository", () => ({
  createPGLiteDocumentsRepository: vi.fn(),
}));
vi.mock("../PGLiteQueuedPromptsStore", () => ({
  createPGLiteQueuedPromptsStore: vi.fn(),
}));
vi.mock("../PGLiteSessionWakeupsStore", () => ({
  createPGLiteSessionWakeupsStore: vi.fn(),
}));
vi.mock("../AgentMessagesBackfill", () => ({
  runAgentMessagesBackfill: vi.fn(),
}));
vi.mock("../startupMaintenanceGate", () => ({ runWhenFirstUsable: vi.fn() }));
vi.mock("../healArchivedWorkstreamChildren", () => ({
  healArchivedWorkstreamChildren: vi.fn(),
}));
vi.mock("../LegacyPendingUpdateDrainService", () => ({
  drainAllLegacyPendingUpdates: vi.fn(),
}));
vi.mock("../tracker/ensureWorkspaceLocalNumbers", () => ({
  ensureWorkspaceLocalNumbersInBackground: vi.fn(),
}));
vi.mock("../../database/PGLiteDatabaseWorker", () => ({ database: {} }));
vi.mock("../../database/sqlite/SQLiteStoreAdapter", () => ({
  createSQLiteStoreAdapter: vi.fn(),
}));
vi.mock("../../utils/logger", () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock("../StytchAuthService", () => ({ onAuthStateChange: vi.fn() }));
vi.mock(
  "@nimbalyst/runtime/ai/server/transcript/TranscriptMigrationService",
  () => ({ TranscriptMigrationService: class {} })
);
vi.mock("../TranscriptMigrationAdapters", () => ({
  createRawMessageStoreAdapter: vi.fn(),
}));

import { repositoryManager } from "../RepositoryManager";

function seedManager(): any {
  const manager = repositoryManager as any;
  manager.initialized = true;
  manager.baseSessionStore = { name: "base-session" };
  manager.sessionStore = { name: "old-session" };
  manager.baseAgentMessagesStore = { name: "base-agent" };
  manager.agentMessagesStore = { name: "old-agent" };
  manager.lifecycleGeneration = 0;
  manager.activeLifecycleCancellation = null;
  return manager;
}

afterEach(() => {
  const manager = repositoryManager as any;
  manager.initialized = false;
  manager.baseSessionStore = manager.sessionStore = null;
  manager.baseAgentMessagesStore = manager.agentMessagesStore = null;
  manager.lifecycleGeneration = 0;
  manager.activeLifecycleCancellation = null;
  vi.clearAllMocks();
});

describe("RepositoryManager host-visibility publication lifetime", () => {
  it("publishes a replacement only after the current sync lifetime settles", async () => {
    const manager = seedManager();
    const replacement = { name: "current-session" };
    let release!: () => void;
    mocks.reinitializeSync.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return replacement;
    });
    const reinitializing = manager.reinitializeSyncWithNewConfig();
    await Promise.resolve();
    expect(mocks.setSessionStore).not.toHaveBeenCalled();
    expect(manager.sessionStore).toEqual({ name: "old-session" });
    release();
    await reinitializing;
    expect(mocks.setSessionStore).toHaveBeenCalledWith(replacement);
    expect(manager.sessionStore).toBe(replacement);
  });

  it("cancels a stalled reinitialization before cleanup can resurrect repository ownership", async () => {
    const manager = seedManager();
    mocks.reinitializeSync.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    const reinitializing = manager.reinitializeSyncWithNewConfig();
    await Promise.resolve();
    const cleaning = manager.cleanup();
    await expect(reinitializing).resolves.toBeUndefined();
    await expect(cleaning).resolves.toBeUndefined();
    expect(mocks.setSessionStore).not.toHaveBeenCalled();
    expect(mocks.clearSessionStore).toHaveBeenCalledTimes(1);
    expect(manager.sessionStore).toBeNull();
  });
});
