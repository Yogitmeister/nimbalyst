export interface CodexTurnMetadata {
  turnId?: string;
  threadId?: string;
  sessionId?: string;
}

/** Extract the provider-authored Codex turn identity attached to an MCP call. */
export function extractCodexTurnMetadataFromRequest(request: unknown): CodexTurnMetadata | null {
  if (!request || typeof request !== "object") return null;

  const params = (request as { params?: unknown }).params;
  if (!params || typeof params !== "object") return null;

  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return null;

  const codexMeta = (meta as Record<string, unknown>)["x-codex-turn-metadata"];
  if (!codexMeta || typeof codexMeta !== "object") return null;

  const record = codexMeta as Record<string, unknown>;
  const turnId = typeof record.turn_id === "string" ? record.turn_id : undefined;
  const threadId = typeof record.thread_id === "string" ? record.thread_id : undefined;
  const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;

  if (!turnId && !threadId && !sessionId) return null;
  return { turnId, threadId, sessionId };
}
