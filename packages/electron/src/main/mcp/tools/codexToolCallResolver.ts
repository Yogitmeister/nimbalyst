import { AgentMessagesRepository } from "@nimbalyst/runtime";
import { getCodexToolLookupAliases } from "@nimbalyst/runtime/ai/server/toolLookupIds";
import { extractCodexTurnMetadataFromRequest } from "./mcpRequestMetadata";

export { extractCodexTurnMetadataFromRequest } from "./mcpRequestMetadata";

export interface RequestUserInputPromptTargets {
  promptId: string;
  rawPromptId?: string;
  waiterPromptIds: string[];
}

/**
 * Extract a transport-specific tool invocation ID from MCP request metadata.
 *
 * Claude, OpenAI, and local bridges do not agree on one field name, so we
 * normalize the known variants here before falling back to the request id.
 */
export function extractToolUseIdFromMcpRequest(request: unknown): string | undefined {
  const params =
    request && typeof request === "object"
      ? (request as { params?: unknown }).params
      : undefined;
  const meta =
    params && typeof params === "object"
      ? (params as { _meta?: unknown })._meta
      : undefined;
  const requestMeta = meta && typeof meta === "object"
    ? (meta as Record<string, unknown>)
    : undefined;
  const requestId =
    request && typeof request === "object"
      ? (request as { id?: unknown }).id
      : undefined;

  return [
    requestMeta?.["claudecode/toolUseId"],
    requestMeta?.["openai/toolUseId"],
    requestMeta?.["openai/toolCallId"],
    requestMeta?.["toolUseId"],
    requestMeta?.["tool_use_id"],
    requestMeta?.["toolCallId"],
    typeof requestId === "string" || typeof requestId === "number"
      ? String(requestId)
      : undefined,
  ].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function findCodexAppServerToolCallId(
  rawMessageContents: string[],
  turnId: string,
  toolName: string,
): string | null {
  if (!turnId || !toolName) return null;

  for (const content of rawMessageContents) {
    try {
      const parsed = JSON.parse(content);
      const params = parsed?.params;
      const item = params?.item;

      if (
        parsed?.method === "item/started"
        && params?.turnId === turnId
        && item?.type === "mcpToolCall"
        && item?.tool === toolName
        && typeof item?.id === "string"
        && item.id.length > 0
      ) {
        return item.id;
      }
    } catch {
      // Ignore malformed rows while scanning recent messages.
    }
  }

  return null;
}

/**
 * Resolve the prompt/tool id that the MCP waiter should block on.
 *
 * Codex normally passes a raw `call_...` tool id in `_meta`, but some
 * app-server flows only include turn metadata. In that case, recover the
 * just-started tool-call id from recent agent messages for the same turn.
 */
export async function resolveToolUseIdFromMcpRequest(
  request: unknown,
  sessionId: string | undefined,
  toolName: string,
): Promise<string | undefined> {
  const direct = extractToolUseIdFromMcpRequest(request);
  if (direct) return direct;

  if (!sessionId) return undefined;

  const codexTurn = extractCodexTurnMetadataFromRequest(request);
  if (!codexTurn?.turnId) return undefined;

  try {
    const messages = await AgentMessagesRepository.list(sessionId, { limit: 50 });
    return findCodexAppServerToolCallId(
      messages.map((msg) => msg.content),
      codexTurn.turnId,
      toolName,
    ) ?? undefined;
  } catch (error) {
    console.warn("[MCP Server] Failed to resolve Codex tool call id from recent messages:", error);
    return undefined;
  }
}

/**
 * Expand a renderer prompt id into every prompt id the waiter/DB may know.
 *
 * For Codex, widgets may submit the synthetic `nimtc|...` id while the MCP
 * waiter and persisted response row also need to recognize the raw `call_...`
 * id behind it.
 */
export function resolveRequestUserInputPromptTargets(
  promptId: string,
): RequestUserInputPromptTargets {
  const waiterPromptIds = getCodexToolLookupAliases(promptId);
  const rawPromptId = waiterPromptIds.find((id) => id !== promptId);

  return {
    promptId,
    ...(rawPromptId ? { rawPromptId } : {}),
    waiterPromptIds,
  };
}
