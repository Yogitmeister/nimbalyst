import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateMcpAuthToken,
  issueMcpSessionCredential,
  setMcpAuthTokenForTest,
} from "../mcpAuth";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "C:\\user-data"), getName: vi.fn(() => "test"), getVersion: vi.fn(() => "1.0.0"), isPackaged: false, on: vi.fn(), once: vi.fn(), whenReady: vi.fn(async () => undefined) },
  BrowserWindow: class BrowserWindow { static getAllWindows = vi.fn(() => []); static getFocusedWindow = vi.fn(() => null); static fromWebContents = vi.fn(() => null); },
  clipboard: { writeText: vi.fn() }, dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn() }, ipcMain: { emit: vi.fn() }, nativeImage: { createFromDataURL: vi.fn() }, shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}));
vi.mock("../../window/WindowManager", () => ({ getMostRecentlyFocusedWorkspaceWindow: vi.fn(() => null), windowStates: new Map(), windowFocusOrder: new Map() }));
vi.mock("../../window/windowState", () => ({ windows: new Map() }));
vi.mock("electron-log", () => ({ default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), transports: { file: {}, console: {} } } }));
vi.mock("electron-log/main", () => ({ default: { initialize: vi.fn(), scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), transports: { file: {}, console: {} } } }));
vi.mock("electron-store", () => ({ default: class ElectronStore { get = vi.fn(); set = vi.fn(); delete = vi.fn(); } }));
vi.mock("../../utils/logger", () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, store: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock("../../utils/store", () => ({ getProviderApiKeyFromSettings: vi.fn(), getProjectSettings: vi.fn(() => ({})), getAppSettings: vi.fn(() => ({})) }));

describe("MCP HTTP authority boundary", () => {
  afterEach(async () => {
    const http = await import("../httpServer");
    await http.shutdownHttpServer();
    setMcpAuthTokenForTest(null);
  });

  it("rejects an unauthorized scoped credential with the same refusal as an unknown transport", async () => {
    const http = await import("../httpServer");
    generateMcpAuthToken();
    const credentialA = issueMcpSessionCredential("actor-a", "C:\\repo");
    const credentialB = issueMcpSessionCredential("actor-b", "c:/REPO");
    http.updateDocumentState({ workspacePath: "C:\\repo" }, "actor-a");
    http.registerStreamableTransportForTest("known-transport", {
      authority: { actorSessionId: "actor-a", workspacePath: "C:\\repo", workspaceComparisonPath: "c:/repo" },
      nimbalystSessionId: "actor-a",
      transport: { handleRequest: vi.fn(async (_req, res) => { res.writeHead(204); res.end(); }), close: vi.fn(async () => undefined) },
    });
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host`;
    const request = async (transportId: string, credential: string, method: "GET" | "POST" | "DELETE") => {
      const response = await fetch(endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          "mcp-session-id": transportId,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      return { status: response.status, body: await response.text() };
    };
    for (const method of ["GET", "POST", "DELETE"] as const) {
      expect(await request("unknown-transport", credentialB, method)).toEqual(
        await request("known-transport", credentialB, method),
      );
      expect(await request("known-transport", credentialB, method)).toEqual({ status: 404, body: "Not found" });
    }
    expect(await request("known-transport", credentialA, "GET")).toEqual({ status: 204, body: "" });
  });

  it("invalidates a moved host transport and revokes credentials on deletion", async () => {
    const http = await import("../httpServer");
    generateMcpAuthToken();
    http.updateDocumentState({ workspacePath: "c:/repo/" }, "actor-a");
    const credential = issueMcpSessionCredential("actor-a", "C:\\Repo");
    const close = vi.fn(async () => undefined);
    const handleRequest = vi.fn(async (_req, res) => { res.writeHead(204); res.end(); });
    http.registerStreamableTransportForTest("transport-a", {
      authority: { actorSessionId: "actor-a", workspacePath: "c:/repo/", workspaceComparisonPath: "c:/repo" },
      nimbalystSessionId: "actor-a",
      transport: { handleRequest, close },
    });
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host`;
    const request = async () => {
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${credential}`, "mcp-session-id": "transport-a" } });
      return { status: response.status, body: await response.text() };
    };
    expect(await request()).toEqual({ status: 204, body: "" });
    http.updateDocumentState({ workspacePath: "C:/Repo" }, "actor-a");
    expect(await request()).toEqual({ status: 404, body: "Not found" });
    expect(close).toHaveBeenCalledTimes(1);
    await http.revokeHostBoundMcpAuthority("actor-a");
    const revoked = await fetch(endpoint, { headers: { Authorization: `Bearer ${credential}`, "mcp-session-id": "transport-a" } });
    expect(revoked.status).toBe(401);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });
});
