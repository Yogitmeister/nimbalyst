import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchSessionMetaMcpRequest,
  dispatchSessionMetaTool,
  setGetSessionPhaseFn,
  setGetSessionMetaAuthorityContextFn,
  setGetSessionTagsFn,
  setGetSessionTitleFn,
  setUpdateSessionMetadataFn,
  setUpdateSessionTagsFn,
  setUpdateSessionTitleIfNotNamedFn,
} from "../sessionNamingServer";

function codexRequest(threadId: string) {
  return {
    params: {
      _meta: {
        "x-codex-turn-metadata": {
          session_id: threadId,
          thread_id: threadId,
          turn_id: `turn-${threadId}`,
        },
      },
    },
  };
}

describe("update_session_meta authority and serialization", () => {
  const updateTitleIfNotNamed = vi.fn(async () => true);
  const updateMetadata = vi.fn(async () => {});
  let persistedTags: string[] = [];
  const updateTags = vi.fn(async (_sessionId: string, add: string[], remove: string[]) => {
    persistedTags = persistedTags.filter((tag) => !remove.includes(tag));
    for (const tag of add) {
      if (!persistedTags.includes(tag)) persistedTags.push(tag);
    }
    return [...persistedTags];
  });

  beforeEach(() => {
    vi.clearAllMocks();
    persistedTags = [];
    setUpdateSessionTitleIfNotNamedFn(updateTitleIfNotNamed);
    setUpdateSessionMetadataFn(updateMetadata);
    setUpdateSessionTagsFn(updateTags);
    setGetSessionTitleFn(async () => null);
    setGetSessionTagsFn(async () => [...persistedTags]);
    setGetSessionPhaseFn(async () => "implementing");
    setGetSessionMetaAuthorityContextFn(async () => ({
      provider: "openai-codex",
      providerSessionId: "codex-parent-thread",
      hasBeenNamed: false,
    }));
  });

  it("rejects a Codex collaboration child whose thread does not own the bound Nimbalyst session", async () => {
    const result = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { name: "Child overwrote parent" },
      "nimbalyst-parent",
      codexRequest("codex-child-thread"),
    );

    expect(result.isError).toBe(true);
    expect(updateTitleIfNotNamed).not.toHaveBeenCalled();
  });

  it("rejects incomplete or internally inconsistent Codex caller metadata", async () => {
    const missingTurn = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { phase: "validating" },
      "nimbalyst-parent",
      {
        params: {
          _meta: {
            "x-codex-turn-metadata": {
              session_id: "codex-parent-thread",
              thread_id: "codex-parent-thread",
            },
          },
        },
      },
    );
    const splitIdentity = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { phase: "validating" },
      "nimbalyst-parent",
      {
        params: {
          _meta: {
            "x-codex-turn-metadata": {
              session_id: "codex-child-thread",
              thread_id: "codex-parent-thread",
              turn_id: "turn-parent",
            },
          },
        },
      },
    );

    expect(missingTurn.isError).toBe(true);
    expect(splitIdentity.isError).toBe(true);
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it("fails closed until the bound Codex provider thread has been persisted", async () => {
    setGetSessionMetaAuthorityContextFn(async () => ({
      provider: "openai-codex",
      hasBeenNamed: false,
    }));

    const result = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { phase: "validating" },
      "nimbalyst-parent",
      codexRequest("codex-parent-thread"),
    );

    expect(result.isError).toBe(true);
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it("fails closed for Codex ACP until it exposes verified MCP caller identity", async () => {
    setGetSessionMetaAuthorityContextFn(async () => ({
      provider: "openai-codex-acp",
      providerSessionId: "codex-acp-parent-thread",
      hasBeenNamed: false,
    }));

    const missing = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { phase: "validating" },
      "nimbalyst-acp-parent",
    );
    const assertedOwner = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { phase: "validating" },
      "nimbalyst-acp-parent",
      codexRequest("codex-acp-parent-thread"),
    );

    expect(missing.isError).toBe(true);
    expect(assertedOwner.isError).toBe(true);
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it("allows the Codex thread that owns the bound session", async () => {
    const result = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { phase: "validating" },
      "nimbalyst-parent",
      codexRequest("codex-parent-thread"),
    );

    expect(result.isError).toBe(false);
    expect(updateMetadata).toHaveBeenCalledWith("nimbalyst-parent", {
      phase: "validating",
    });
  });

  it("does not rename an already-named session without an explicit rename request", async () => {
    setGetSessionTitleFn(async () => "Stable parent title");
    setGetSessionMetaAuthorityContextFn(async () => ({
      provider: "openai-codex",
      providerSessionId: "codex-parent-thread",
      hasBeenNamed: true,
    }));

    const result = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { name: "Accidental child title" },
      "nimbalyst-parent",
      codexRequest("codex-parent-thread"),
    );

    expect(result.isError).toBe(true);
    expect(updateTitleIfNotNamed).not.toHaveBeenCalled();
  });

  it("rejects model-asserted rename even from the authorized root thread", async () => {
    setGetSessionTitleFn(async () => "Stable parent title");
    setGetSessionMetaAuthorityContextFn(async () => ({
      provider: "openai-codex",
      providerSessionId: "codex-parent-thread",
      hasBeenNamed: true,
    }));

    const result = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { name: "User-requested title", rename: true },
      "nimbalyst-parent",
      codexRequest("codex-parent-thread"),
    );

    expect(result.isError).toBe(true);
    expect(updateTitleIfNotNamed).not.toHaveBeenCalled();
  });

  it("uses compare-and-set for the first session name", async () => {
    const result = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { name: "First stable title" },
      "nimbalyst-parent",
      codexRequest("codex-parent-thread"),
    );

    expect(result.isError).toBe(false);
    expect(updateTitleIfNotNamed).toHaveBeenCalledWith(
      "nimbalyst-parent",
      "First stable title",
    );
  });

  it("serializes concurrent tag patches so neither caller loses the other's addition", async () => {
    const [first, second] = await Promise.all([
      (dispatchSessionMetaTool as any)(
        "update_session_meta",
        { add: ["alpha"] },
        "nimbalyst-parent",
        codexRequest("codex-parent-thread"),
      ),
      (dispatchSessionMetaTool as any)(
        "update_session_meta",
        { add: ["beta"] },
        "nimbalyst-parent",
        codexRequest("codex-parent-thread"),
      ),
    ]);

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(persistedTags.sort()).toEqual(["alpha", "beta"]);
    expect(updateTags).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid tag shapes without writing", async () => {
    const invalidValues = [
      "not-an-array",
      [null],
      [{}],
      ["   "],
      ["x".repeat(65)],
      ["line\nbreak"],
    ];

    for (const add of invalidValues) {
      const result = await (dispatchSessionMetaTool as any)(
        "update_session_meta",
        { add },
        "nimbalyst-parent",
        codexRequest("codex-parent-thread"),
      );
      expect(result.isError).toBe(true);
    }

    expect(updateTags).not.toHaveBeenCalled();
  });

  it("rejects malformed and blank names and normalizes surrounding whitespace", async () => {
    const nonString = await (dispatchSessionMetaTool as any)(
      "update_session_meta",
      { name: 0, phase: "validating" },
      "nimbalyst-parent",
      codexRequest("codex-parent-thread"),
    );
    expect(nonString.isError).toBe(true);

    const blank = await dispatchSessionMetaTool(
      "update_session_meta",
      { name: "   " },
      "nimbalyst-parent",
      codexRequest("codex-parent-thread"),
    );
    expect(blank.isError).toBe(true);

    updateTitleIfNotNamed.mockResolvedValueOnce(true);
    const normalized = await dispatchSessionMetaTool(
      "update_session_meta",
      { name: "  Stable title  " },
      "nimbalyst-parent",
      codexRequest("codex-parent-thread"),
    );
    expect(normalized.isError).toBe(false);
    expect(updateTitleIfNotNamed).toHaveBeenCalledWith(
      "nimbalyst-parent",
      "Stable title",
    );
  });

  it("routes the complete production MCP request into the authority check", async () => {
    const request = {
      ...codexRequest("codex-parent-thread"),
      params: {
        ...codexRequest("codex-parent-thread").params,
        name: "update_session_meta",
        arguments: { phase: "validating" },
      },
    };

    const result = await dispatchSessionMetaMcpRequest(request, "nimbalyst-parent");

    expect(result.isError).toBe(false);
    expect(updateMetadata).toHaveBeenCalledWith("nimbalyst-parent", {
      phase: "validating",
    });
  });

  it("keeps non-Codex providers compatible while still requiring a real bound session", async () => {
    setGetSessionMetaAuthorityContextFn(async () => ({
      provider: "claude-code",
      providerSessionId: "claude-session",
      hasBeenNamed: false,
    }));

    const allowed = await dispatchSessionMetaTool(
      "update_session_meta",
      { phase: "validating" },
      "nimbalyst-claude",
    );
    setGetSessionMetaAuthorityContextFn(async () => null);
    const missing = await dispatchSessionMetaTool(
      "update_session_meta",
      { phase: "validating" },
      "missing-session",
    );

    expect(allowed.isError).toBe(false);
    expect(missing.isError).toBe(true);
  });
});
