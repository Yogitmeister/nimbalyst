// [ASTRA-ORCH]
/**
 * Single entry point for asking the sync server to push a notification to the
 * user's phone.
 *
 * `force` marks an explicit attention alert and bypasses the server's presence
 * suppression. Never gate a forced call site on local presence: the whole point
 * is that the server owns that decision, and a local gate stops `force` ever
 * reaching it.
 *
 * The server acknowledges accepted requests and delivery outcomes.
 */

import type { MobilePushOptions, MobilePushResult } from '@nimbalyst/runtime/sync/types';

import { getSyncProvider } from '../SyncManager';
import { AnalyticsService } from '../analytics/AnalyticsService';
import { logger } from '../../utils/logger';

/**
 * Request a mobile push and report the outcome.
 *
 * Returns null when sync is unavailable; otherwise the server acknowledgement
 * or a no_ack result. Reporting happens here even when callers ignore it.
 */
export async function requestMobilePush(
  sessionId: string,
  title: string,
  body: string,
  options: MobilePushOptions = {},
): Promise<MobilePushResult | null> {
  const syncProvider = getSyncProvider();
  if (!syncProvider?.requestMobilePush) return null;

  try {
    const result = await syncProvider.requestMobilePush(sessionId, title, body, options);

    AnalyticsService.getInstance().sendEvent('mobile_push_requested', {
      reason: options.reason ?? 'unspecified',
      forced: options.force === true,
      accepted: result.accepted,
      attemptedCount: result.attemptedCount,
      deliveredCount: result.deliveredCount,
      rejection: result.rejection ?? null,
    });

    return result;
  } catch (err) {
    logger.main.warn(`[mobilePushRequest] Push request failed for session ${sessionId}:`, err);
    return null;
  }
}
