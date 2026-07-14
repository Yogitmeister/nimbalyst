/**
 * Session-naming / `update_session_meta` tool surface.
 *
 * MCP consolidation: `update_session_meta` is served by the unified internal MCP
 * HTTP server's eager core (`/mcp/core`, `nimbalyst`). This module exports the
 * dynamic schema builder + an endpoint-agnostic dispatch fn, and keeps the
 * setter-injected session-manager fns (the auto-namer also calls them); the
 * standalone HTTP server it used to run was retired in Phase 7.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { extractCodexTurnMetadataFromRequest } from "./tools/mcpRequestMetadata";

let updateSessionTitleIfNotNamedFn:
  | ((sessionId: string, title: string) => Promise<boolean>)
  | null = null;

let updateSessionMetadataFn:
  | ((sessionId: string, metadata: Record<string, unknown>) => Promise<void>)
  | null = null;

let getWorkspaceTagsFn:
  | ((sessionId: string) => Promise<{ name: string; count: number }[]>)
  | null = null;

let getSessionTagsFn:
  | ((sessionId: string) => Promise<string[]>)
  | null = null;

let getSessionTitleFn:
  | ((sessionId: string) => Promise<string | null>)
  | null = null;

let getSessionPhaseFn:
  | ((sessionId: string) => Promise<string | null>)
  | null = null;

let updateSessionTagsFn:
  | ((sessionId: string, add: string[], remove: string[]) => Promise<string[]>)
  | null = null;

interface SessionMetaAuthorityContext {
  provider: string;
  providerSessionId?: string;
  hasBeenNamed?: boolean;
}

let getSessionMetaAuthorityContextFn:
  | ((sessionId: string) => Promise<SessionMetaAuthorityContext | null>)
  | null = null;

const sessionMetaMutationTails = new Map<string, Promise<void>>();

/** Set the atomic first-name function used by the metadata tool. */
export function setUpdateSessionTitleIfNotNamedFn(
  updateTitleFn: (sessionId: string, title: string) => Promise<boolean>
) {
  updateSessionTitleIfNotNamedFn = updateTitleFn;
}

/**
 * Set the update function for session metadata (called once at startup)
 */
export function setUpdateSessionMetadataFn(
  updateMetadataFn: (sessionId: string, metadata: Record<string, unknown>) => Promise<void>
) {
  updateSessionMetadataFn = updateMetadataFn;
}

/** Set the authoritative store-level tag delta function. */
export function setUpdateSessionTagsFn(
  updateTagsFn: (sessionId: string, add: string[], remove: string[]) => Promise<string[]>
) {
  updateSessionTagsFn = updateTagsFn;
}

/**
 * Set the function to get workspace tags (called once at startup)
 */
export function setGetWorkspaceTagsFn(
  getTagsFn: (sessionId: string) => Promise<{ name: string; count: number }[]>
) {
  getWorkspaceTagsFn = getTagsFn;
}

/**
 * Set the function to get current tags for a session (called once at startup)
 */
export function setGetSessionTagsFn(
  getTagsFn: (sessionId: string) => Promise<string[]>
) {
  getSessionTagsFn = getTagsFn;
}

/**
 * Set the function to get current title for a session (called once at startup)
 */
export function setGetSessionTitleFn(
  getTitleFn: (sessionId: string) => Promise<string | null>
) {
  getSessionTitleFn = getTitleFn;
}

/**
 * Set the function to get current phase for a session (called once at startup)
 */
export function setGetSessionPhaseFn(
  getPhaseFn: (sessionId: string) => Promise<string | null>
) {
  getSessionPhaseFn = getPhaseFn;
}

/** Set the provider identity lookup used to fence mutating metadata calls. */
export function setGetSessionMetaAuthorityContextFn(
  getContextFn: (sessionId: string) => Promise<SessionMetaAuthorityContext | null>
) {
  getSessionMetaAuthorityContextFn = getContextFn;
}

// ─── Shared tool surface (served by the unified MCP server) ─────────
//
// `update_session_meta` rides on the eager core (`nimbalyst`) served by the
// unified internal HTTP server's `/mcp/core` endpoint. The dispatch + schema
// builder below are the single implementation; the IPC side effects live in the
// injected fns above.

/**
 * Build the `update_session_meta` tool schema, with the `add` description
 * augmented by the workspace's existing tags (looked up via the injected
 * `getWorkspaceTagsFn`). Async because the tag lookup is async.
 */
export async function buildSessionMetaToolSchemas(aiSessionId: string): Promise<any[]> {
  let addTagDescription = 'Tags to add: type of work (bug-fix, feature, refactor) and area/module (electron, runtime, ios).';
  if (getWorkspaceTagsFn) {
    try {
      const existingTags = await getWorkspaceTagsFn(aiSessionId);
      if (existingTags.length > 0) {
        const tagList = existingTags.slice(0, 20).map(t => `${t.name} (${t.count})`).join(', ');
        addTagDescription += ` Prefer existing workspace tags: ${tagList}.`;
      }
    } catch {
      // Ignore - just use default description
    }
  }

  return [
    {
      name: "update_session_meta",
      description:
        "Update session metadata. Set a write-once name, tags, and phase on the first call; update tags/phase on later calls. Agent calls cannot rename an already-named session. Returns the full current metadata.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'Concise session name (2-5 words), descriptive part first (e.g. "Dark mode implementation"). This field is write-once on the agent tool surface; use the host UI for a later rename.',
          },
          add: {
            type: "array",
            items: { type: "string" },
            description: addTagDescription,
          },
          remove: {
            type: "array",
            items: { type: "string" },
            description: "Tags to remove from the session",
          },
          phase: {
            type: "string",
            enum: ["backlog", "planning", "implementing", "validating", "complete"],
            description:
              'Kanban phase: "planning" for exploration/design, "implementing" for coding, "validating" for testing/review. NEVER set "complete" without explicit user approval — only the user decides when work is complete.',
          },
          workflowPreset: {
            type: "string",
            enum: ["default", "implement-review-test", "research"],
            description:
              'Meta-agent workflow mode: "default" autonomous loop, "implement-review-test" implement/review/test loop in one worktree, "research" decomposes across child sessions. Takes effect next turn.',
          },
        },
      },
    },
  ];
}

/** Snapshot the current session metadata state (uses the injected getter fns). */
async function snapshotSessionMeta(aiSessionId: string): Promise<{ name: string | null; tags: string[]; phase: string | null }> {
  const name = getSessionTitleFn ? await getSessionTitleFn(aiSessionId) : null;
  const tags: string[] = getSessionTagsFn ? await getSessionTagsFn(aiSessionId) : [];
  const phase = getSessionPhaseFn ? await getSessionPhaseFn(aiSessionId) : null;
  return { name, tags, phase };
}

/** Build the structured JSON response with before/after state for the widget. */
function buildSessionMetaResponse(
  notes: string[],
  before: { name: string | null; tags: string[]; phase: string | null },
  after: { name: string | null; tags: string[]; phase: string | null },
): string {
  const parts = [...notes];
  parts.push(`Name: ${after.name || '(not set)'}`);
  parts.push(`Tags: ${after.tags.length > 0 ? after.tags.map(t => `#${t}`).join(', ') : '(none)'}`);
  parts.push(`Phase: ${after.phase || '(not set)'}`);
  const summary = parts.join('\n');
  return JSON.stringify({ summary, before, after });
}

type SessionMetaToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

function sessionMetaError(message: string): SessionMetaToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

async function withSessionMetaMutationLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sessionMetaMutationTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionMetaMutationTails.set(sessionId, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionMetaMutationTails.get(sessionId) === tail) {
      sessionMetaMutationTails.delete(sessionId);
    }
  }
}

async function verifySessionMetaAuthority(
  aiSessionId: string,
  request: unknown,
): Promise<SessionMetaAuthorityContext | SessionMetaToolResult> {
  if (!aiSessionId) {
    return sessionMetaError("Session identity is missing; metadata mutation denied.");
  }
  if (!getSessionMetaAuthorityContextFn) {
    return sessionMetaError("Session authority verification is unavailable.");
  }

  const context = await getSessionMetaAuthorityContextFn(aiSessionId);
  if (!context) {
    return sessionMetaError("Bound session was not found; metadata mutation denied.");
  }

  if (context.provider === "openai-codex-acp") {
    return sessionMetaError(
      "Codex ACP does not expose a verified provider-thread identity to MCP; metadata mutation is disabled for this provider.",
    );
  }

  if (context.provider === "openai-codex") {
    const expectedThreadId = context.providerSessionId;
    const caller = extractCodexTurnMetadataFromRequest(request);
    if (!expectedThreadId) {
      return sessionMetaError("Codex session authority is not ready; retry after the provider thread is persisted.");
    }
    if (!caller?.turnId || !caller.threadId || !caller.sessionId) {
      return sessionMetaError("Codex caller identity is incomplete; metadata mutation denied.");
    }
    if (caller.threadId !== expectedThreadId || caller.sessionId !== expectedThreadId) {
      return sessionMetaError("Codex caller does not own the bound Nimbalyst session.");
    }
  }

  return context;
}

const MAX_TAG_PATCH_ITEMS = 32;
const MAX_SESSION_TAGS = 64;
const MAX_TAG_LENGTH = 64;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function parseTagList(value: unknown, field: "add" | "remove"): string[] | SessionMetaToolResult {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return sessionMetaError(`"${field}" must be an array of strings.`);
  }
  if (value.length > MAX_TAG_PATCH_ITEMS) {
    return sessionMetaError(`"${field}" accepts at most ${MAX_TAG_PATCH_ITEMS} tags per call.`);
  }

  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return sessionMetaError(`Every "${field}" tag must be a string.`);
    }
    const tag = item.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH || CONTROL_CHAR_RE.test(tag)) {
      return sessionMetaError(
        `Every "${field}" tag must be a non-empty string of at most ${MAX_TAG_LENGTH} characters without control characters.`,
      );
    }
    if (!normalized.includes(tag)) normalized.push(tag);
  }
  return normalized;
}

async function dispatchUpdateSessionMeta(
  args: Record<string, any> | undefined,
  aiSessionId: string,
  request: unknown,
): Promise<SessionMetaToolResult> {
  const authority = await verifySessionMetaAuthority(aiSessionId, request);
  if ("isError" in authority) return authority;

  let sessionName: string | undefined;
  if (args?.name !== undefined) {
    if (typeof args.name !== "string") {
      return sessionMetaError('"name" must be a string.');
    }
    sessionName = args.name.trim();
    if (!sessionName || CONTROL_CHAR_RE.test(sessionName)) {
      return sessionMetaError(
        '"name" must be a non-empty string without control characters.',
      );
    }
    if (sessionName.length > 100) {
      return sessionMetaError(`Session name too long (${sessionName.length} chars, max 100)`);
    }
  }
  if (args?.rename !== undefined) {
    return sessionMetaError(
      '"rename" is not available to agents. Rename an already-named session through a user-driven host/UI action.',
    );
  }
  const parsedAddTags = parseTagList(args?.add, "add");
  if (!Array.isArray(parsedAddTags)) return parsedAddTags;
  const parsedRemoveTags = parseTagList(args?.remove, "remove");
  if (!Array.isArray(parsedRemoveTags)) return parsedRemoveTags;
  const addTags = parsedAddTags;
  const removeTags = parsedRemoveTags;
  const overlappingTags = addTags.filter((tag) => removeTags.includes(tag));
  if (overlappingTags.length > 0) {
    return sessionMetaError('The same normalized tag cannot appear in both "add" and "remove".');
  }
  const phase = args?.phase as string | undefined;
  const rawWorkflowPreset = args?.workflowPreset;
  const workflowPreset =
    rawWorkflowPreset === "default" ||
    rawWorkflowPreset === "implement-review-test" ||
    rawWorkflowPreset === "research"
      ? rawWorkflowPreset as string
      : undefined;

  if (rawWorkflowPreset !== undefined && workflowPreset === undefined) {
    return sessionMetaError('"workflowPreset" must be one of "default", "implement-review-test", "research".');
  }
  if (
    phase !== undefined &&
    !["backlog", "planning", "implementing", "validating", "complete"].includes(phase)
  ) {
    return sessionMetaError('"phase" must be one of "backlog", "planning", "implementing", "validating", "complete".');
  }
  if (!sessionName && !addTags.length && !removeTags.length && !phase && !workflowPreset) {
    return sessionMetaError('At least one of "name", "add", "remove", "phase", or "workflowPreset" must be provided.');
  }

  const before = await snapshotSessionMeta(aiSessionId);
  const notes: string[] = [];

  if (sessionName) {
    try {
      if (authority.hasBeenNamed === true) {
        if (before.name === sessionName) {
          notes.push(`Name already set to "${sessionName}"`);
        } else {
          return sessionMetaError(
            "Session is already named. Agent-driven rename is disabled; use a user-driven host/UI action.",
          );
        }
      } else {
        if (!updateSessionTitleIfNotNamedFn) {
          return sessionMetaError("Atomic session naming is unavailable.");
        }
        const updated = await updateSessionTitleIfNotNamedFn(aiSessionId, sessionName);
        if (updated) {
          notes.push(`Set name: "${sessionName}"`);
        } else {
          const current = await snapshotSessionMeta(aiSessionId);
          if (current.name === sessionName) {
            notes.push(`Name already set to "${sessionName}"`);
          } else {
            return sessionMetaError("Session was named concurrently; refusing to overwrite it.");
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("[Session Naming MCP] Failed to update session title:", error);
      return sessionMetaError(`Error updating session title: ${errorMessage}`);
    }
  }

  if (addTags.length || removeTags.length) {
    if (!updateSessionTagsFn) {
      return sessionMetaError("Atomic session tag updates are unavailable.");
    }

    try {
      const tags = await updateSessionTagsFn(aiSessionId, addTags, removeTags);
      if (tags.length > MAX_SESSION_TAGS) {
        throw new Error(`Persisted session tag count exceeds ${MAX_SESSION_TAGS}`);
      }
      if (addTags.length) notes.push(`Added tags: ${addTags.map((tag) => `#${tag}`).join(", ")}`);
      if (removeTags.length) notes.push(`Removed tags: ${removeTags.map((tag) => `#${tag}`).join(", ")}`);
    } catch (error) {
      console.error("[Session Naming MCP] Failed to update tags:", error);
      return sessionMetaError(`Error updating tags: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  if (phase || workflowPreset) {
    if (!updateSessionMetadataFn) {
      return sessionMetaError("Session metadata update not available.");
    }

    try {
      const metadataUpdate: Record<string, unknown> = {};
      if (phase) metadataUpdate.phase = phase;
      if (workflowPreset) metadataUpdate.workflowPreset = workflowPreset;
      await updateSessionMetadataFn(aiSessionId, metadataUpdate);
      if (phase) notes.push(`Set phase: ${phase}`);
      if (workflowPreset) notes.push(`Set workflow preset: ${workflowPreset}`);
    } catch (error) {
      console.error("[Session Naming MCP] Failed to update session metadata:", error);
      return sessionMetaError(
        `Error updating session metadata: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  const after = await snapshotSessionMeta(aiSessionId);
  return {
    content: [{ type: "text", text: buildSessionMetaResponse(notes, before, after) }],
    isError: false,
  };
}

/** Route the complete MCP request so provider-authored request metadata cannot be dropped. */
export async function dispatchSessionMetaMcpRequest(
  request: unknown,
  aiSessionId: string,
): Promise<SessionMetaToolResult> {
  if (!request || typeof request !== "object") {
    return sessionMetaError("Malformed MCP request.");
  }
  const params = (request as { params?: unknown }).params;
  if (!params || typeof params !== "object") {
    return sessionMetaError("Malformed MCP request parameters.");
  }
  const name = (params as { name?: unknown }).name;
  const args = (params as { arguments?: unknown }).arguments;
  if (typeof name !== "string") {
    return sessionMetaError("MCP tool name is missing.");
  }
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return sessionMetaError("MCP tool arguments must be an object.");
  }
  return dispatchSessionMetaTool(name, args as Record<string, unknown> | undefined, aiSessionId, request);
}

/**
 * Dispatch `update_session_meta` and return the MCP `{content, isError}` shape.
 * Mutations are fenced to the provider thread bound to the Nimbalyst session
 * and serialized per session so concurrent tag patches cannot lose updates.
 */
export async function dispatchSessionMetaTool(
  name: string,
  args: Record<string, any> | undefined,
  aiSessionId: string,
  request?: unknown,
): Promise<SessionMetaToolResult> {
  const toolName = name.replace(/^mcp__nimbalyst(-session-naming)?__/, "");

  try {
    if (toolName !== "update_session_meta") {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    if (!aiSessionId) {
      return sessionMetaError("Session identity is missing; metadata mutation denied.");
    }
    return withSessionMetaMutationLock(aiSessionId, () =>
      dispatchUpdateSessionMeta(args, aiSessionId, request)
    );
  } catch (error) {
    if (error instanceof McpError) throw error;
    console.error(`[SessionMeta MCP] Tool "${name}" failed:`, error);
    throw error;
  }
}
