import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import {
  ensureClaudeCliSession,
  type EnsureClaudeCliSessionInput,
  type EnsureClaudeCliSessionResult,
} from './claudeCliLauncherSingleton';
import type { ClaudeCliDocumentContext } from './claudeCliPromptComposer';
import { resolveClaudeCliPromptTarget } from './claudeCliPromptTarget';
import { submitClaudeCliPromptProduction } from './claudeCliSubmitSingleton';

export interface ClaudeCliPromptTargetIdentity {
  sessionId: string;
  continuedFromSessionId: string | null;
}

export type EnsureClaudeCliPromptTargetResult = EnsureClaudeCliSessionResult
  & ClaudeCliPromptTargetIdentity;

export interface SubmitClaudeCliPromptTargetInput {
  sessionId: string;
  workspacePath: string;
  prompt: string;
  attachments?: ChatAttachment[];
  documentContext?: ClaudeCliDocumentContext | null;
}

/** Main-process mount/start rail, routed before terminal identity or cwd choice. */
export async function ensureClaudeCliPromptTargetSession(
  input: EnsureClaudeCliSessionInput,
): Promise<EnsureClaudeCliPromptTargetResult> {
  const target = await resolveClaudeCliPromptTarget(input.sessionId, input.workspacePath);
  const result = await ensureClaudeCliSession({
    sessionId: target.sessionId,
    workspacePath: target.workspacePath,
    cwd: target.cwd,
    model: target.continuedFromSessionId
      ? target.session.model ?? undefined
      : input.model ?? target.session.model ?? undefined,
    resumeSessionId: target.continuedFromSessionId ? undefined : input.resumeSessionId,
    cols: input.cols,
    rows: input.rows,
  });

  return {
    ...result,
    sessionId: target.sessionId,
    continuedFromSessionId: target.continuedFromSessionId,
  };
}

/** Main-process direct prompt rail, including an idempotent target PTY ensure. */
export async function submitClaudeCliPromptToTarget(
  input: SubmitClaudeCliPromptTargetInput,
): Promise<{ success: boolean; submitted: boolean } & ClaudeCliPromptTargetIdentity> {
  const target = await resolveClaudeCliPromptTarget(input.sessionId, input.workspacePath);
  const ensured = await ensureClaudeCliSession({
    sessionId: target.sessionId,
    workspacePath: target.workspacePath,
    cwd: target.cwd,
    model: target.session.model ?? undefined,
  });
  if (!ensured.success) {
    throw new Error(ensured.error ?? `Failed to start Claude CLI session ${target.sessionId}`);
  }

  const result = await submitClaudeCliPromptProduction({
    sessionId: target.sessionId,
    workspacePath: target.workspacePath,
    prompt: input.prompt,
    attachments: input.attachments,
    documentContext: input.documentContext,
  });

  return {
    success: true,
    submitted: result.submitted,
    sessionId: target.sessionId,
    continuedFromSessionId: target.continuedFromSessionId,
  };
}
