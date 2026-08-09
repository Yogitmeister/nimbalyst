// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { sessionCancelIncompleteAtom } from '../../../store/atoms/sessions';
import { CancelIncompleteBanner } from '../CancelIncompleteBanner';

/**
 * NIM-590 batch item 6: `ai:sessionCancelIncomplete` was stored in
 * `sessionCancelIncompleteAtom` (sessionStateListeners.ts) but had zero
 * renderer component reading it -- an independent review pass confirmed the
 * atom was otherwise orphaned in production. This is that consumer.
 */
describe('CancelIncompleteBanner', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders nothing when there is no incomplete cancellation for the session', () => {
    store.set(sessionCancelIncompleteAtom('s-none'), null);
    render(
      <Provider store={store}>
        <CancelIncompleteBanner sessionId="s-none" />
      </Provider>,
    );
    expect(screen.queryByTestId('cancel-incomplete-banner')).toBeNull();
  });

  it('surfaces the incomplete-cancellation warning and clears it on a successful retry', async () => {
    // ai:cancelRequest is a direct invoke, not a broadcast -- nothing else
    // will ever clear this banner for a desktop-initiated retry, so the
    // handler's own use of the invoke's return value is load-bearing.
    const invoke = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    store.set(sessionCancelIncompleteAtom('s-incomplete'), {
      error: 'The desktop could not prove every agent process stopped.',
      retryRequired: true,
    });

    render(
      <Provider store={store}>
        <CancelIncompleteBanner sessionId="s-incomplete" />
      </Provider>,
    );

    screen.getByTestId('cancel-incomplete-banner');
    screen.getByText(/could not prove every agent process stopped/);
    fireEvent.click(screen.getByTestId('cancel-incomplete-banner-retry'));
    // Flush the awaited invoke() plus React's commit phase: a macrotask tick
    // guarantees both, unlike a fixed count of microtask-only Promise.resolve().
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).toHaveBeenCalledWith('ai:cancelRequest', 's-incomplete', 0);
    expect(store.get(sessionCancelIncompleteAtom('s-incomplete'))).toBeNull();
    expect(screen.queryByTestId('cancel-incomplete-banner')).toBeNull();
  });

  it('keeps the warning visible when a retry fails', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: false, error: 'still unresolved' });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    store.set(sessionCancelIncompleteAtom('s-retry-fails'), {
      error: 'The desktop could not prove every agent process stopped.',
      retryRequired: true,
    });

    render(
      <Provider store={store}>
        <CancelIncompleteBanner sessionId="s-retry-fails" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('cancel-incomplete-banner-retry'));
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('ai:cancelRequest', 's-retry-fails', 0);
    expect(store.get(sessionCancelIncompleteAtom('s-retry-fails'))).not.toBeNull();
    screen.getByTestId('cancel-incomplete-banner');
  });

  it('omits the retry action when retryRequired is false', () => {
    store.set(sessionCancelIncompleteAtom('s-no-retry'), {
      error: 'Recoverable only by a full app restart.',
      retryRequired: false,
    });
    render(
      <Provider store={store}>
        <CancelIncompleteBanner sessionId="s-no-retry" />
      </Provider>,
    );
    screen.getByTestId('cancel-incomplete-banner');
    expect(screen.queryByTestId('cancel-incomplete-banner-retry')).toBeNull();
  });

  it('does not leak one session\'s incomplete flag into another session\'s banner', () => {
    store.set(sessionCancelIncompleteAtom('s-flagged'), {
      error: 'flagged',
      retryRequired: true,
    });
    render(
      <Provider store={store}>
        <CancelIncompleteBanner sessionId="s-bystander" />
      </Provider>,
    );
    expect(screen.queryByTestId('cancel-incomplete-banner')).toBeNull();
  });
});
