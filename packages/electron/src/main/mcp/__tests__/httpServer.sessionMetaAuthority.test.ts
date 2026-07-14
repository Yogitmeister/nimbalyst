import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createSharedMcpServer } from "../httpServer";
import {
  setGetSessionMetaAuthorityContextFn,
  setGetSessionPhaseFn,
  setGetSessionTagsFn,
  setGetSessionTitleFn,
  setUpdateSessionMetadataFn,
  setUpdateSessionTagsFn,
  setUpdateSessionTitleIfNotNamedFn,
} from "../sessionNamingServer";

describe("unified MCP update_session_meta authority boundary", () => {
  const updateMetadata = vi.fn(async () => {});
  let client: Client | null = null;
  let server: ReturnType<typeof createSharedMcpServer> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    setUpdateSessionTitleIfNotNamedFn(async () => true);
    setUpdateSessionMetadataFn(updateMetadata);
    setUpdateSessionTagsFn(async () => []);
    setGetSessionTitleFn(async () => null);
    setGetSessionTagsFn(async () => []);
    setGetSessionPhaseFn(async () => "implementing");
    setGetSessionMetaAuthorityContextFn(async () => ({
      provider: "openai-codex",
      providerSessionId: "codex-parent-thread",
      hasBeenNamed: false,
    }));
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = null;
    server = null;
  });

  it("preserves request metadata and the bound Nimbalyst session through the real Server callback", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createSharedMcpServer(
      "D:\\workspace",
      "nimbalyst-parent",
      { kind: "legacy" },
    );
    client = new Client(
      { name: "session-meta-boundary-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "update_session_meta",
      arguments: { phase: "validating" },
      _meta: {
        "x-codex-turn-metadata": {
          session_id: "codex-parent-thread",
          thread_id: "codex-parent-thread",
          turn_id: "turn-parent",
        },
      },
    } as any);

    expect(result.isError).not.toBe(true);
    expect(updateMetadata).toHaveBeenCalledWith("nimbalyst-parent", {
      phase: "validating",
    });
  });

  it("rejects a foreign Codex thread at the same unified Server boundary", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createSharedMcpServer(
      "D:\\workspace",
      "nimbalyst-parent",
      { kind: "legacy" },
    );
    client = new Client(
      { name: "session-meta-boundary-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "update_session_meta",
      arguments: { phase: "validating" },
      _meta: {
        "x-codex-turn-metadata": {
          session_id: "codex-child-thread",
          thread_id: "codex-child-thread",
          turn_id: "turn-child",
        },
      },
    } as any);

    expect(result.isError).toBe(true);
    expect(updateMetadata).not.toHaveBeenCalled();
  });
});
