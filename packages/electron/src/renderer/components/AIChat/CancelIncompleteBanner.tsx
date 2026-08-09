import React, { useCallback, useState } from 'react';
import { useAtomValue } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { sessionCancelIncompleteAtom } from '../../store/atoms/sessions';

interface CancelIncompleteBannerProps {
  sessionId?: string | null;
}

/**
 * A cancellation this window did not necessarily request itself (e.g. a
 * mobile-initiated cancel, or this window's own cancel/interrupt when native
 * cleanup could not be confirmed) could not prove every native process
 * stopped. Without this banner the `ai:sessionCancelIncomplete` broadcast was
 * stored in `sessionCancelIncompleteAtom` but had zero visible consumer --
 * see NIM-590 batch item 6.
 */
export function CancelIncompleteBanner({ sessionId }: CancelIncompleteBannerProps) {
  const effectiveSessionId = sessionId || '__no_session__';
  const incomplete = useAtomValue(sessionCancelIncompleteAtom(effectiveSessionId));
  const [busy, setBusy] = useState(false);

  const handleRetry = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      // ai:cancelRequest is a direct invoke, not a broadcast -- unlike the
      // mobile-cancellation rail, nothing emits ai:sessionCancelled back to
      // THIS window on a desktop-initiated retry, so this handler is the
      // only signal that will ever clear the banner on success. Clear it
      // from the invoke's own return value rather than waiting for an event
      // that never arrives for this path.
      const result = await window.electronAPI.invoke('ai:cancelRequest', sessionId, 0);
      if (result?.success) {
        store.set(sessionCancelIncompleteAtom(sessionId), null);
      }
    } catch (error) {
      console.error('[CancelIncompleteBanner] retry cancel failed', error);
    } finally {
      setBusy(false);
    }
  }, [sessionId, busy]);

  if (!sessionId) return null;
  if (!incomplete) return null;

  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-2 bg-amber-400/10 border-b border-amber-400/30"
      data-testid="cancel-incomplete-banner"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <MaterialSymbol icon="warning" size={16} className="text-nim-warning" />
        <span className="text-xs font-medium text-nim-warning truncate">
          {incomplete.error}
        </span>
      </div>
      {incomplete.retryRequired && (
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={handleRetry}
            disabled={busy}
            className="flex items-center gap-1 px-2.5 py-1 bg-transparent border border-current rounded text-[11px] font-medium cursor-pointer transition-all duration-200 hover:enabled:bg-current/10 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="cancel-incomplete-banner-retry"
            title="Retry cancellation for this session"
          >
            <MaterialSymbol icon="refresh" size={14} />
            Retry cancel
          </button>
        </div>
      )}
    </div>
  );
}
