import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCollabV3Sync: vi.fn(),
  createSyncedSessionStore: vi.fn(),
  createMessageSyncHandler: vi.fn(() => ({})),
  resolvePersonalUserId: vi.fn().mockResolvedValue("personal-user"),
  stopAllProjectFileSync: vi.fn(),
  projectFileShutdown: vi.fn(),
}));

vi.mock("@nimbalyst/collab-protocol", () => ({
  isRetainedSession: () => false,
}));
vi.mock("@nimbalyst/runtime", () => ({
  asPersonalMemberId: (value: string) => value,
}));
vi.mock("@nimbalyst/runtime/sync", () => ({
  setSyncClientInfo: vi.fn(),
  setSyncImageCompressor: vi.fn(),
  deriveEncryptionKey: vi.fn().mockResolvedValue({}),
  personalSyncEncryptionSalt: () => "salt",
  createCollabV3Sync: mocks.createCollabV3Sync,
  createSyncedSessionStore: mocks.createSyncedSessionStore,
  createMessageSyncHandler: mocks.createMessageSyncHandler,
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../utils/store", () => ({
  getSessionSyncConfig: () => ({
    enabled: true,
    environment: "production",
    personalOrgId: "personal-org",
    personalUserId: "personal-user",
  }),
  setSessionSyncConfig: vi.fn(),
  getReleaseChannel: () => "beta",
  getDefaultAIModel: vi.fn(),
  getAlphaFeatures: () => ({}),
  getPreferredAgentLanguage: () => "en",
  getAttachmentStagingConfig: vi.fn(),
  store: { get: () => ({ enabledProjects: [] }) },
}));
vi.mock("../../utils/privateSettingsStore", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("../../utils/logger", () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock("../../utils/gitUtils", () => ({ getGitRemoteIdentities: vi.fn() }));
vi.mock("../../utils/workspaceDetection", () => ({
  resolveProjectPath: (value: string) => value,
}));
vi.mock("../../utils/startupTiming", () => ({
  timeStartupPhase: async (_label: string, work: () => Promise<unknown>) =>
    work(),
}));
vi.mock("../../window/WindowManager", () => ({ windowStates: new Map() }));
vi.mock("../../file/WorkspaceWatcher", () => ({
  startProjectFileSync: vi.fn(),
  stopAllProjectFileSync: mocks.stopAllProjectFileSync,
}));
vi.mock("../ai/remoteSessions", () => ({
  remoteSessions: { setProvider: vi.fn() },
}));
vi.mock("../credentials/providerCredentials", () => ({
  getProviderCredentials: vi.fn(),
  subscribeProviderCredentialChanges: vi.fn(),
}));
vi.mock("../CredentialService", () => ({
  getCredentials: () => ({ encryptionKeySeed: "test-seed" }),
}));
vi.mock("../StytchAuthService", () => ({
  getStytchUserId: () => "personal-user",
  isAuthenticated: () => true,
  getPersonalOrgId: () => "personal-org",
  getPersonalUserId: () => "personal-user",
  resolvePersonalUserId: mocks.resolvePersonalUserId,
  getPersonalSessionJwt: () => "header.payload.signature",
  refreshPersonalSessionDetailed: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../auth/personalJwtFailure", () => ({
  describePersonalJwtFailure: vi.fn(),
}));
vi.mock("../ProjectFileSyncService", () => ({
  getProjectFileSyncService: () => ({
    initialize: vi.fn(),
    shutdown: mocks.projectFileShutdown,
  }),
}));
vi.mock("../PowerSaveService", () => ({
  setSleepPreventionMode: vi.fn(),
  setSyncConnected: vi.fn(),
  shutdownSleepPrevention: vi.fn(),
}));
vi.mock("../TrackerSyncManager", () => ({ reconnectAllTrackerSyncs: vi.fn() }));
vi.mock("../sync/projectConfigComposer", () => ({
  composeProjectConfig: vi.fn(),
  toSyncedActionPrompts: vi.fn(),
}));
vi.mock("../sync/missingSessionPolicy", () => ({
  decideMissingSession: vi.fn(),
}));
vi.mock("../mcp/mcpImageCompression", () => ({
  compressImageIfNeeded: (data: Uint8Array, mimeType: string) => ({
    data,
    mimeType,
  }),
}));
vi.mock("../attachments/attachmentStagingRoot", () => ({
  resolveWorkspaceAttachmentStagingDirectory: vi.fn(),
}));

import { initializeSync, shutdownSync } from "../SyncManager";

const baseStore = () =>
  ({
    ensureReady: vi.fn(),
    create: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
  } as any);
const provider = () =>
  ({ disconnectAll: vi.fn(), onDeviceStatusChange: vi.fn() } as any);

describe("SyncManager host-visibility lifetime", () => {
  beforeEach(() => {
    mocks.createCollabV3Sync.mockReset();
    mocks.createSyncedSessionStore.mockReset();
    mocks.resolvePersonalUserId.mockReset().mockResolvedValue("personal-user");
    vi.stubGlobal("crypto", {
      subtle: {
        importKey: vi.fn().mockResolvedValue({}),
        deriveKey: vi.fn().mockResolvedValue({}),
      },
    });
  });

  afterEach(async () => {
    await shutdownSync();
    vi.unstubAllGlobals();
  });

  it("prevents a superseded initializer from publishing after the newest owner starts", async () => {
    const base = baseStore();
    let releaseFirst!: (value: string) => void;
    const stalledFirst = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.resolvePersonalUserId
      .mockImplementationOnce(() => stalledFirst)
      .mockResolvedValueOnce("personal-user");
    const currentProvider = provider();
    const currentStore = { ...base, name: "current" };
    mocks.createCollabV3Sync.mockReturnValue(currentProvider);
    mocks.createSyncedSessionStore.mockReturnValue(currentStore);

    const stale = initializeSync(base);
    await Promise.resolve();
    await expect(initializeSync(base)).resolves.toBe(currentStore);
    releaseFirst("personal-user");
    await expect(stale).resolves.toBe(base);
    expect(mocks.createCollabV3Sync).toHaveBeenCalledTimes(1);
    expect(mocks.createSyncedSessionStore).toHaveBeenCalledTimes(1);
  });
});
