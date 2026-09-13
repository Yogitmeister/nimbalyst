/**
 * Atoms for Claude Code usage tracking
 *
 * These atoms store the current usage data from Anthropic's API,
 * including 5-hour session and 7-day weekly utilization percentages.
 */

import { atom } from 'jotai';

export interface ClaudeUsageWindow {
  utilization: number; // 0-100 percentage
  resetsAt: string | null; // ISO timestamp
}

export type ClaudeUsageSeverity = 'normal' | 'warning' | 'critical';

/**
 * A weekly limit scoped to one model (e.g. "Fable", "Opus"), mirrored from
 * ClaudeUsageService. Sent over IPC alongside the account-wide windows.
 *
 * `utilization: null` means the API sent no usable percentage — render it as
 * unknown, never as 0%, which would hide a limit that may already be full.
 */
export interface ClaudeScopedLimit {
  id: string;
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  severity: ClaudeUsageSeverity;
  isActive: boolean;
}

/**
 * Whether a scoped limit earns a row in the panel. Shared so the popover and
 * any other consumer of these limits agree on one rule.
 *
 * A 0% limit is noise, but "unknown" and "the API says this one is limiting you
 * right now" are exactly the cases the user opened the panel to see.
 */
export function shouldDisplayScopedLimit(limit: ClaudeScopedLimit): boolean {
  return limit.utilization === null || limit.isActive || limit.utilization > 0;
}

export interface ClaudeUsageData {
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
  sevenDayOpus?: ClaudeUsageWindow;
  scopedLimits?: ClaudeScopedLimit[];
  lastUpdated: number; // Unix timestamp
  error?: string;
}

/**
 * Current Claude usage data from the API.
 * Updated by the centralized IPC listener when main process sends updates.
 */
export const claudeUsageAtom = atom<ClaudeUsageData | null>(null);

// Rail visibility of the usage indicator is governed by the NavigationGutter
// customization set (the single source of truth). Read it with
// `useAtomValue(hiddenGutterItemsAtom)` and toggle it with
// `useSetAtom(toggleGutterItemHiddenAtom)({ id: 'claude-usage', hidden })` from
// `store/atoms/appSettings`. The gutter's right-click "Show Claude Usage" /
// "Customize Gutter…" / "Show All" affordances read the same set, so hiding the
// indicator always has a matching rail-side restore. (The legacy
// `ai.showUsageIndicator` setting is inert -- kept only for the one-shot
// `usageIndicatorsMigratedToGutter` migration in main/utils/store.ts.)

/**
 * Derived atom: whether usage data is available to display.
 * Shows the indicator whenever we have received any usage payload from main process.
 * Error payloads still render the indicator so users can hover/click for the reason.
 */
export const claudeUsageAvailableAtom = atom((get) => {
  const usage = get(claudeUsageAtom);
  return Boolean(usage);
});

/**
 * Derived atom: color for the session (5-hour) indicator
 */
export const claudeUsageSessionColorAtom = atom((get) => {
  const usage = get(claudeUsageAtom);
  if (!usage) return 'muted';
  const util = usage.fiveHour.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});

/**
 * Derived atom: color for the weekly (7-day) indicator
 */
export const claudeUsageWeeklyColorAtom = atom((get) => {
  const usage = get(claudeUsageAtom);
  if (!usage) return 'muted';
  const util = usage.sevenDay.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});

/**
 * Helper to format reset time as human-readable string
 */
export function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return 'Unknown';

  const resetDate = new Date(resetsAt);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();

  if (diffMs < 0) return 'Now';

  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    const remainingHours = diffHours % 24;
    return `${diffDays}d ${remainingHours}h`;
  }
  if (diffHours > 0) {
    const remainingMinutes = diffMinutes % 60;
    return `${diffHours}h ${remainingMinutes}m`;
  }
  return `${diffMinutes}m`;
}
