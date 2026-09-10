// [ASTRA-ORCH]
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import * as workspaceDetection from '../../utils/workspaceDetection';

// session_get_visibility / session_set_visibility (NIM-366): the smallest
// real slice of "agent session visibility controls" — an MCP-exposed
// pin/unpin toggle backed by the existing isPinned field, gated by the same
// workspace-binding authorization boundary as update_session_board /
// get_session_summary. Never let an actor read or mutate a session outside
// its (or an opted-in target's) workspace.
const getMock = vi.fn();
const updateMetadataMock = vi.fn();

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AISessionsRepository: {
      get: (...args: unknown[]) => getMock(...args),
      updateMetadata: (...args: unknown[]) => updateMetadataMock(...args),
      getMany: vi.fn(async () => []),
    },
  };
});

import { dispatchSessionContextTool } from '../sessionContextServer';

const OWN_WS = path.normalize('/workspaces/own');
const FOREIGN_WS = path.normalize('/workspaces/foreign');

function sessionIn(workspacePath: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'target-1',
    title: 'a session',
    workspacePath,
    isPinned: false,
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  getMock.mockReset();
  updateMetadataMock.mockReset();
});

describe('session_get_visibility', () => {
  it('reports a foreign-workspace session as not found', async () => {
    getMock.mockResolvedValue(sessionIn(FOREIGN_WS));

    const result = await dispatchSessionContextTool(
      'session_get_visibility',
      { sessionId: 'target-1' },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('returns the pinned state for a same-workspace session', async () => {
    getMock.mockResolvedValue(sessionIn(OWN_WS, { isPinned: true, title: 'my session' }));

    const result = await dispatchSessionContextTool(
      'session_get_visibility',
      { sessionId: 'target-1' },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ sessionId: 'target-1', title: 'my session', pinned: true });
  });

  it('defaults an unset isPinned to false', async () => {
    getMock.mockResolvedValue(sessionIn(OWN_WS, { isPinned: undefined }));

    const result = await dispatchSessionContextTool(
      'session_get_visibility',
      { sessionId: 'target-1' },
      'caller-1',
      OWN_WS,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pinned).toBe(false);
  });

  it('falls back to the current session when sessionId is omitted', async () => {
    getMock.mockResolvedValue(sessionIn(OWN_WS, { id: 'caller-1' }));

    await dispatchSessionContextTool('session_get_visibility', {}, 'caller-1', OWN_WS);

    expect(getMock).toHaveBeenCalledWith('caller-1');
  });
});

describe('session_set_visibility', () => {
  it('refuses to mutate a foreign-workspace session', async () => {
    getMock.mockResolvedValue(sessionIn(FOREIGN_WS));

    const result = await dispatchSessionContextTool(
      'session_set_visibility',
      { sessionId: 'target-1', pinned: true },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(updateMetadataMock).not.toHaveBeenCalled();
  });

  it('pins a same-workspace session', async () => {
    getMock.mockResolvedValue(sessionIn(OWN_WS, { title: 'my session' }));
    updateMetadataMock.mockResolvedValue(undefined);

    const result = await dispatchSessionContextTool(
      'session_set_visibility',
      { sessionId: 'target-1', pinned: true },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('pinned=true');
    expect(updateMetadataMock).toHaveBeenCalledWith('target-1', { isPinned: true });
  });

  it('unpins a same-workspace session', async () => {
    getMock.mockResolvedValue(sessionIn(OWN_WS, { isPinned: true }));
    updateMetadataMock.mockResolvedValue(undefined);

    const result = await dispatchSessionContextTool(
      'session_set_visibility',
      { sessionId: 'target-1', pinned: false },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(false);
    expect(updateMetadataMock).toHaveBeenCalledWith('target-1', { isPinned: false });
  });

  it('rejects a call missing sessionId', async () => {
    const result = await dispatchSessionContextTool(
      'session_set_visibility',
      { pinned: true },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sessionId is required');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('rejects a call missing pinned', async () => {
    const result = await dispatchSessionContextTool(
      'session_set_visibility',
      { sessionId: 'target-1' },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('pinned is required');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean pinned value', async () => {
    const result = await dispatchSessionContextTool(
      'session_set_visibility',
      { sessionId: 'target-1', pinned: 'yes' },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('pinned is required');
  });
});

describe('visibility project path binding', () => {
  it.each(['session_get_visibility', 'session_set_visibility'])(
    '%s resolves the stored worktree path with the same rule as the requested path',
    async (tool) => {
      const stored = '/worktrees/owned-session';
      const foreign = '/worktrees/foreign-session';
      vi.spyOn(workspaceDetection, 'resolveProjectPath').mockImplementation((value) =>
        value === stored ? OWN_WS : value === foreign ? FOREIGN_WS : path.normalize(value),
      );
      getMock.mockResolvedValue(sessionIn(stored));
      const args = { sessionId: 'target-1', pinned: true, targetWorkspacePath: stored };
      const result = await dispatchSessionContextTool(tool, args, 'caller-1', OWN_WS);
      expect(result.isError).toBe(false);
      if (tool === 'session_set_visibility') {
        expect(updateMetadataMock).toHaveBeenCalledWith('target-1', { isPinned: true });
      }

      updateMetadataMock.mockClear();
      getMock.mockResolvedValue(sessionIn(foreign));
      const rejected = await dispatchSessionContextTool(tool, args, 'caller-1', OWN_WS);
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain('not found');
      expect(updateMetadataMock).not.toHaveBeenCalled();
    },
  );

  it('normalizes a persisted equivalent path without changing the stored session', async () => {
    const stored = OWN_WS + path.sep + 'child' + path.sep + '..';
    const session = sessionIn(stored);
    getMock.mockResolvedValue(session);
    const result = await dispatchSessionContextTool('session_get_visibility', {}, 'target-1', OWN_WS);
    expect(result.isError).toBe(false);
    expect(session.workspacePath).toBe(stored);
    expect(updateMetadataMock).not.toHaveBeenCalled();
  });
});


it.each(['session_get_visibility', 'session_set_visibility'])('%s rejects a session without a workspace', async (tool) => {
  getMock.mockResolvedValue(sessionIn(OWN_WS, { workspacePath: undefined }));
  const result = await dispatchSessionContextTool(tool, { sessionId: 'target-1', pinned: true }, 'caller-1', OWN_WS);
  expect(result.isError).toBe(true);
  expect(updateMetadataMock).not.toHaveBeenCalled();
});
