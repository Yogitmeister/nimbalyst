/**
 * Deterministic host-driven auto-naming for `claude-code-cli` sessions (NIM-822).
 *
 * The SDK path names sessions from inside the provider loop
 * (ClaudeCodeProvider.maybeFireSessionNamingSideQuestion). The PTY-spawned CLI
 * never enters that loop; its only naming hook is an --append-system-prompt
 * nudge asking the model to call update_session_meta — opportunistic and
 * usually ignored, leaving sessions stuck on "New Session".
 *
 * On the FIRST completed CLI turn (the launcher's PID idle transition), if the
 * agent hasn't named the session itself, derive a title from the first user
 * prompt. Deliberately heuristic — NO model call: CLI users may be
 * subscription-only with no API key configured, and reading keys from
 * process.env is forbidden (repo rule). The final write is still a compare-and-
 * set, so an agent or user title that wins after the initial read is preserved.
 */

const MAX_TITLE_CHARS = 48;
const MAX_TITLE_WORDS = 8;

/**
 * Derive a session title from the user's first prompt. Null when the prompt
 * isn't usable as a topic (empty, a /slash command, a # memory note).
 */
export function deriveSessionTitleFromPrompt(rawPrompt: string | null | undefined): string | null {
  const prompt = (rawPrompt ?? '').trim();
  if (!prompt) return null;
  if (prompt.startsWith('/') || prompt.startsWith('#')) return null;

  const flattened = prompt.replace(/\s+/g, ' ').trim();
  const words = flattened.split(' ');
  let truncated = words.length > MAX_TITLE_WORDS;
  let title = words.slice(0, MAX_TITLE_WORDS).join(' ');
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).replace(/\s+\S*$/, '');
    truncated = true;
  }
  title = title.replace(/[.,;:!?]+$/, '').trim();
  if (title.length < 3) return null;

  return truncated ? `${title}…` : title;
}

export type AutoNameOutcome = 'named' | 'already-named' | 'no-usable-prompt';

export interface AutoNameDeps {
  /** Whether the session already carries an agent/user-chosen name. */
  isAlreadyNamed: (sessionId: string) => Promise<boolean>;
  /** The CLEAN text of the session's first user prompt (null when none). */
  getFirstUserPrompt: (sessionId: string) => Promise<string | null>;
  /** Atomically write the title; false means another first-name writer won. */
  applyTitle: (sessionId: string, title: string) => Promise<boolean | void>;
}

export async function maybeAutoNameClaudeCliSession(
  sessionId: string,
  deps: AutoNameDeps,
): Promise<AutoNameOutcome> {
  if (await deps.isAlreadyNamed(sessionId)) {
    return 'already-named';
  }
  const title = deriveSessionTitleFromPrompt(await deps.getFirstUserPrompt(sessionId));
  if (!title) {
    return 'no-usable-prompt';
  }
  const applied = await deps.applyTitle(sessionId, title);
  return applied === false ? 'already-named' : 'named';
}
