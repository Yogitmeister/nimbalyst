/**
 * OllamaResetTimeScraper - Reads session/weekly reset timestamps from
 * ollama.com/settings.
 *
 * Ollama Cloud's account-usage API (see OllamaUsageService.ts) returns live
 * session/weekly percentages but no reset timestamp -- confirmed absent from
 * the payload as of 2026-08-06. The ollama.com/settings dashboard renders a
 * "Resets in ..." countdown for both windows, backed (per third-party tools
 * that already do this against the live site -- CodexBar's
 * OllamaUsageFetcher.swift and hrbrmstr/ollama-usage, a Go CLI) by a
 * `data-time` ISO-8601 attribute on the countdown element. That page
 * requires a browser SESSION COOKIE (ollama.com runs on WorkOS AuthKit;
 * current cookie name is `wos-session`, legacy Ollama/NextAuth cookie names
 * are also accepted) -- NOT the OLLAMA_API_KEY used for the live percentage.
 * See OllamaCookieService.ts for how that cookie is acquired and stored.
 *
 * CAVEAT: the exact markup shape below is built from those third-party
 * tools' documented behavior, not from a live fetch against real HTML (no
 * ollama.com session cookie was available to test with while writing this).
 * Treat this as unverified until the first live run against a real logged-in
 * cookie -- mirrors OllamaUsageService.ts's own "verified live 2026-07-30"
 * precedent, which this file has not yet earned. `extractResetTimestamps`
 * degrades to nulls (never throws) on a parse-shape surprise, and logs a
 * warning so a live mismatch surfaces immediately instead of silently.
 *
 * Session window is ~5h, weekly window is ~7d (ollama.com/pricing), but this
 * module never assumes/computes a value on its own -- it only ever returns
 * what it actually parsed from the page this call, or null. Per Yogev
 * (2026-08-06): the 5h session window may be activity-anchored (starts on
 * the first call after the previous window expired, not at a fixed clock
 * instant) rather than a fixed periodic reset -- this module doesn't need to
 * know which is true, since it always reads the server's own current answer
 * rather than predicting one. See OllamaUsageService.ts for the lazy
 * trigger that decides WHEN to call this (only when the previously known
 * resetsAt is missing or has already passed).
 *
 * PROVENANCE: authored 2026-08-06 in session c0c47ba8 ("Ollama usage-reset-
 * time feasibility"), left uncommitted in the nimbalyst-usagepoll worktree.
 * Recovered and ported verbatim into this dedicated branch 2026-08-07 by
 * ChiChi (ef4b16e3) rather than re-derived, per Yogev's direct instruction
 * not to re-do work that was already decided.
 */

import { logger } from '../utils/logger';

const SETTINGS_URL = 'https://ollama.com/settings';
const FETCH_TIMEOUT_MS = 10_000;
// How far to search around a "Resets in" label for its data-time attribute.
// The attribute's exact placement relative to the label (same tag vs.
// sibling/parent) isn't confirmed -- see module doc caveat.
const DATA_TIME_WINDOW_CHARS = 600;

export type OllamaResetTimeResult =
  | { status: 'ok'; session: string | null; weekly: string | null }
  | { status: 'cookie-expired' }
  | { status: 'error'; error: string };

/**
 * Find every `data-time="..."` value that appears near a "Resets in" label,
 * in document order. Ollama's dashboard renders session before weekly, which
 * this module relies on positionally (first match = session, second =
 * weekly) rather than trying to key off surrounding label text that hasn't
 * been directly observed.
 */
function extractResetTimestamps(html: string): string[] {
  const results: string[] = [];
  const labelPattern = /Resets in/g;
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(html)) !== null) {
    const start = Math.max(0, match.index - DATA_TIME_WINDOW_CHARS);
    const end = Math.min(html.length, match.index + DATA_TIME_WINDOW_CHARS);
    const window = html.slice(start, end);
    const dataTimeMatch = /data-time="([^"]+)"/.exec(window);
    if (dataTimeMatch) {
      results.push(dataTimeMatch[1]);
    }
  }
  return results;
}

/**
 * Fetch ollama.com/settings with the given session cookie and extract the
 * session/weekly reset timestamps. Never throws -- all failure modes are
 * represented in the returned status.
 */
export async function fetchOllamaResetTimes(cookie: string): Promise<OllamaResetTimeResult> {
  if (!cookie) {
    return { status: 'error', error: 'No Ollama session cookie provided.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    try {
      response = await fetch(SETTINGS_URL, {
        method: 'GET',
        headers: {
          Cookie: cookie,
          'User-Agent': 'Mozilla/5.0 (compatible; Nimbalyst)',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.main.warn('[OllamaResetTimeScraper] Failed to reach ollama.com/settings:', error);
    return { status: 'error', error: `Failed to reach ollama.com/settings: ${message}` };
  }

  // A redirect away from /settings (to /signin, WorkOS AuthKit, etc.) means
  // the cookie is dead. Matches CodexBar's documented detection approach:
  // "Redirects from settings to /signin or the WorkOS AuthKit authorization
  // page are treated as expired sessions."
  if (!response.url.startsWith(SETTINGS_URL)) {
    logger.main.info(`[OllamaResetTimeScraper] Redirected to ${response.url} -- treating cookie as expired.`);
    return { status: 'cookie-expired' };
  }

  if (!response.ok) {
    logger.main.warn(`[OllamaResetTimeScraper] ollama.com/settings returned HTTP ${response.status}`);
    return { status: 'error', error: `ollama.com/settings returned HTTP ${response.status}` };
  }

  const html = await response.text();
  const timestamps = extractResetTimestamps(html);

  if (timestamps.length === 0) {
    logger.main.warn('[OllamaResetTimeScraper] No "Resets in" data-time attributes found -- page markup may have changed.');
    return { status: 'ok', session: null, weekly: null };
  }

  const [session = null, weekly = null] = timestamps;
  return { status: 'ok', session, weekly };
}
