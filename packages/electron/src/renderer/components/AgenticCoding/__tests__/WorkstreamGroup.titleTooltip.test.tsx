// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('jotai', () => ({
  useAtomValue: (target: { __testValue?: unknown }) => target?.__testValue ?? null,
  useSetAtom: () => () => {},
}));
vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: () => null,
  ProviderIcon: () => null,
  copyToClipboard: () => {},
}));
vi.mock('../../../store', () => ({
  sessionRegistryAtom: { __testValue: new Map() },
  sessionListTitleAtom: () => ({ __testValue: null }),
  sessionProcessingAtom: () => ({ __testValue: false }),
  sessionUnreadAtom: () => ({ __testValue: false }),
  sessionPendingPromptAtom: () => ({ __testValue: false }),
  sessionHasPendingInteractivePromptAtom: () => ({ __testValue: false }),
  groupSessionStatusAtom: () => ({
    __testValue: {
      hasPendingInteractivePrompt: false,
      hasProcessing: false,
      hasPendingPrompt: false,
      hasUnread: false,
    },
  }),
  reparentSessionAtom: () => ({}),
  refreshSessionListAtom: () => ({}),
  sessionShareAtom: () => ({ __testValue: null }),
  removeSessionShareAtom: () => ({}),
  shareKeysAtom: { __testValue: new Map() },
  buildShareUrl: () => '',
}));
vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showInfo: () => {}, showError: () => {} },
}));
vi.mock('../../../dialogs', () => ({
  dialogRef: { current: null },
  DIALOG_IDS: { SHARE: 'share' },
}));
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../SessionRelativeTime', () => ({ SessionRelativeTime: () => null }));

import { WorkstreamGroup } from '../WorkstreamGroup';

const groupTitle = 'A workstream name that is long enough to be clipped by the session pane';
const childTitle = 'A child session name that is long enough to be clipped by the session pane';

afterEach(() => cleanup());

describe('WorkstreamGroup - full name on hover', () => {
  it('exposes complete workstream and child session names in native tooltips', () => {
    const { container } = render(
      <WorkstreamGroup
        type="workstream"
        id="workstream-1"
        title={groupTitle}
        isExpanded
        isActive={false}
        onToggle={() => {}}
        onSelect={() => {}}
        sessions={[{ id: 'session-1', title: childTitle, createdAt: 1_700_000_000_000 } as any]}
        activeSessionId={null}
        onSessionSelect={() => {}}
      />,
    );

    expect(container.querySelector('.workstream-group-name')?.getAttribute('title')).toBe(groupTitle);
    expect(container.querySelector('.workstream-session-item-title')?.getAttribute('title')).toBe(childTitle);
  });
});
