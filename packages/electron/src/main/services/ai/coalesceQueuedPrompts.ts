/**
 * Drain-time coalescing of queued prompts.
 *
 * The queue drains one row per turn. That is correct when rows trickle in one at
 * a time, but it makes a backlog unbounded: every child report, every
 * [Child Session Update] and every follow-up the user typed while a turn was
 * running costs a whole turn, so a session that is queued behind falls further
 * behind with each row. Messages then arrive faster than they drain and the
 * session ends up acting on notes that later rows in the same queue already
 * corrected. "Interrupt and send now" has the same shape: it delivers whatever
 * the FIFO drain delivers, so with a human row at the head only that one row
 * went and the next press was needed for the next row.
 *
 * Merging at drain time rather than at enqueue time is deliberate. At drain we
 * have the freshest set, so supersession resolves for free -- the agent reads
 * "final, frozen", "frozen again", and "correction to last note" together and
 * acts once. Enqueue-time merging cannot know what is still coming, and the
 * renderer's composer-side merge additionally races the drain.
 *
 * Every pending row merges, user and agent alike, oldest first. Each message in
 * the merged turn is labelled with its author, so an agent report is never read
 * as an instruction from the person the session is working with. Two things end
 * a run, because merging across them would change what a row means:
 *
 * - A slash command (`/compact`, `/clear`, a skill) is parsed from the start of
 *   a turn, so it must open its own turn and nothing can follow it in one.
 * - A row that declares a different session mode (planning / agent / auto) than
 *   the run already has, because the mode applies to the whole turn.
 *
 * Precedent for the shape: ClaudeCodeProvider.drainAndFormatPendingTeammateMessages
 * and AgentMentionDispatchService's inbox-wake grouping both already collapse
 * many notifications into one turn. This applies the same idea to the queue.
 */

import type { DocumentContext, PromptProvenance } from '@nimbalyst/runtime/ai/server/types';

export interface CoalescibleQueuedPrompt {
  id: string;
  prompt: string;
  attachments?: unknown[] | null;
  documentContext?: DocumentContext | null;
}

/** One message of a merged turn, with the author label shown to the model. */
export interface CoalescedMessage {
  prompt: string;
  author: string;
}

/**
 * Upper bound on rows folded into one turn, so a queue that has been building
 * for an hour cannot produce a single prompt too large to act on. The remainder
 * stays pending and drains on the next turn.
 */
export const MAX_COALESCED_PROMPTS = 20;

function isSlashCommand(prompt: CoalescibleQueuedPrompt): boolean {
  return prompt.prompt.trim().startsWith('/');
}

/**
 * The mode a row asks for, or undefined when it names none and so inherits the
 * session's mode when it is sent (MessageStreamingHandler: `documentContext?.mode
 * ?? session.mode`). Agent, mobile and automation rows carry no mode; composer
 * rows do.
 */
function declaredMode(prompt: CoalescibleQueuedPrompt): DocumentContext['mode'] {
  return prompt.documentContext?.mode;
}

function isHumanAuthored(prompt: CoalescibleQueuedPrompt): boolean {
  const actor = prompt.documentContext?.promptProvenance?.actor;
  return actor === undefined || actor === 'human';
}

/**
 * Author label for a merged message. Uses the real provenance on the row; a row
 * with none was typed in a composer, which is the only source that omits it.
 */
export function describeAuthor(prompt: CoalescibleQueuedPrompt): string {
  const provenance = prompt.documentContext?.promptProvenance;
  switch (provenance?.actor) {
    case 'agent':
      return `agent: ${provenance.originSessionId ?? provenance.origin}`;
    case 'system':
      return 'system';
    default:
      return 'user';
  }
}

/**
 * The leading run of rows safe to deliver as a single turn, oldest first.
 *
 * A slash command at the head runs alone; one later in the queue ends the run
 * and waits for the next turn. A row that declares a mode different from the
 * run's ends it too. A row that declares no mode inherits the session's, so it
 * merges with any run; the run then takes the first mode any of its rows
 * declares (see `mergeClaimedRun`).
 */
export function selectCoalescibleRun<T extends CoalescibleQueuedPrompt>(
  pending: readonly T[],
  maxBatch: number = MAX_COALESCED_PROMPTS,
): T[] {
  const head = pending[0];
  if (!head) return [];
  if (isSlashCommand(head)) return [head];

  const run: T[] = [head];
  let runMode = declaredMode(head);
  for (let i = 1; i < pending.length && run.length < maxBatch; i++) {
    const next = pending[i];
    if (isSlashCommand(next)) break;

    const mode = declaredMode(next);
    if (mode !== undefined && runMode !== undefined && mode !== runMode) break;

    runMode ??= mode;
    run.push(next);
  }
  return run;
}

/**
 * Render a merged run. The header matters as much as the joining: without it an
 * agent reads a concatenation as one long instruction rather than as several
 * messages that arrived over time, and misses that the last one may retract the
 * first. Each message names its author so a report is not mistaken for the
 * user's instruction.
 */
export function formatCoalescedPrompt(messages: readonly CoalescedMessage[]): string {
  if (messages.length === 0) return '';
  if (messages.length === 1) return messages[0].prompt;

  const header =
    `[${messages.length} messages arrived while you were working, oldest first. ` +
    `Later messages may correct or supersede earlier ones -- read all of them before acting.]`;

  const body = messages.map(
    ({ prompt, author }, index) =>
      `--- message ${index + 1} of ${messages.length} (${author}) ---\n${prompt}`,
  );

  return [header, ...body].join('\n\n');
}

/**
 * The context the merged turn runs with. The head row supplies it because it is
 * the one whose id becomes the turn's `queuedPromptId`, with two corrections
 * for rows the head does not speak for:
 *
 * - mode: a head that declared none takes the first mode any row declared, so
 *   a later "planning" row is not run under the session default.
 * - provenance: only a human turn closes the session's unanswered questions
 *   (supersedeOpenQuestions), so a turn that includes a human row counts as one
 *   even when an agent row came first.
 */
function mergeDocumentContext(run: readonly CoalescibleQueuedPrompt[]): DocumentContext | null | undefined {
  const head = run[0];
  const base = head.documentContext;

  const mode = run.map(declaredMode).find((candidate) => candidate !== undefined);
  const modeChanged = mode !== undefined && mode !== base?.mode;

  const humanRow = isHumanAuthored(head) ? undefined : run.find(isHumanAuthored);

  if (!modeChanged && !humanRow) return base;

  const merged: DocumentContext = { ...(base ?? {}) };
  if (modeChanged) merged.mode = mode;
  if (humanRow) {
    const provenance: PromptProvenance = humanRow.documentContext?.promptProvenance ?? {
      actor: 'human',
      origin: 'composer',
    };
    merged.promptProvenance = { ...provenance, queuedPromptId: head.id };
  }
  return merged;
}

/**
 * Collapse a claimed run into the single prompt the turn will deliver. The head
 * row supplies the document context (see `mergeDocumentContext`); attachments
 * accumulate across the whole run so a merged row never silently drops a
 * child's or the user's uploaded file.
 */
export function mergeClaimedRun<T extends CoalescibleQueuedPrompt>(run: readonly T[]): T {
  const head = run[0];
  if (run.length === 1) return head;

  const attachments = run.flatMap((row) => row.attachments ?? []);

  return {
    ...head,
    prompt: formatCoalescedPrompt(
      run.map((row) => ({ prompt: row.prompt, author: describeAuthor(row) })),
    ),
    attachments: attachments.length > 0 ? attachments : head.attachments ?? null,
    documentContext: mergeDocumentContext(run),
  };
}
