// @vitest-environment jsdom
/**
 * Renderer-boundary coverage for per-model weekly limits.
 *
 * The parser tests prove `scopedLimits` is produced correctly, but the defect
 * this feature fixes was a limit that rendered as *nothing*. A green parser
 * with a broken panel reproduces it exactly, so these tests assert on what the
 * user actually sees: a 100% Fable row, present and labelled.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { ClaudeUsagePopover } from '../ClaudeUsagePopover';
import { claudeUsageAtom, type ClaudeUsageData } from '../../../store/atoms/claudeUsageAtoms';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: () => null,
}));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({
  ProviderIcon: () => null,
}));
vi.mock('../../../hooks/useFloatingMenu', () => ({
  useFloatingMenu: () => ({
    refs: { setReference: () => {}, setFloating: () => {} },
    floatingStyles: {},
    getFloatingProps: () => ({}),
  }),
  FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => cleanup());

const BASE: ClaudeUsageData = {
  fiveHour: { utilization: 86, resetsAt: '2026-09-13T07:29:59Z' },
  sevenDay: { utilization: 57, resetsAt: '2026-09-13T14:59:59Z' },
  lastUpdated: Date.now(),
};

function renderPopover(usage: ClaudeUsageData) {
  const store = createStore();
  store.set(claudeUsageAtom, usage);
  return render(
    <Provider store={store}>
      <ClaudeUsagePopover
        anchorRef={{ current: null }}
        onClose={() => {}}
        onRefresh={async () => {}}
      />
    </Provider>
  );
}

describe('ClaudeUsagePopover - per-model weekly limits', () => {
  it('renders a bar for a 100% model-scoped weekly limit', () => {
    renderPopover({
      ...BASE,
      scopedLimits: [
        {
          id: 'weekly_scoped:fable',
          label: 'Fable',
          utilization: 100,
          resetsAt: '2026-09-13T14:59:59Z',
          severity: 'critical',
          isActive: true,
        },
      ],
    });

    // The row exists at all - this is the assertion the original bug would fail.
    screen.getByText('Fable (Weekly)');
    expect(screen.getByText('100%')).toBeTruthy();
    // And it says why it matters right now.
    screen.getByText('7-day window · limiting you now');
  });

  it('still shows the account-wide Session and Weekly rows alongside it', () => {
    renderPopover({
      ...BASE,
      scopedLimits: [
        {
          id: 'weekly_scoped:fable',
          label: 'Fable',
          utilization: 100,
          resetsAt: null,
          severity: 'critical',
          isActive: true,
        },
      ],
    });

    screen.getByText('Session');
    screen.getByText('Weekly');
    screen.getByText('Fable (Weekly)');
  });

  it('renders an unknown percentage as a dash rather than hiding the limit', () => {
    renderPopover({
      ...BASE,
      scopedLimits: [
        {
          id: 'weekly_scoped:fable',
          label: 'Fable',
          utilization: null,
          resetsAt: null,
          severity: 'warning',
          isActive: false,
        },
      ],
    });

    screen.getByText('Fable (Weekly)');
    screen.getByText('—');
  });

  it('omits an idle 0% limit', () => {
    renderPopover({
      ...BASE,
      scopedLimits: [
        {
          id: 'weekly_scoped:quill',
          label: 'Nimbus Quill',
          utilization: 0,
          resetsAt: null,
          severity: 'normal',
          isActive: false,
        },
      ],
    });

    expect(screen.queryByText('Nimbus Quill (Weekly)')).toBeNull();
  });

  it('renders nothing extra when the payload carries no scoped limits', () => {
    renderPopover(BASE);

    screen.getByText('Session');
    expect(screen.queryByText(/\(Weekly\)$/)).toBeNull();
  });
});
