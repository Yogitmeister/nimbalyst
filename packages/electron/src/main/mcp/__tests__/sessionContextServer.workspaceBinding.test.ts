// [ASTRA-ORCH]
// @vitest-environment node

import path from 'path';
vi.mock('../../utils/workspaceDetection', () => ({ resolveProjectPath: (value: string) => value }));

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getMock,
  listMock,
  updateMetadataMock,
  createWakeupMock,
  wakeupCreatedMock,
  getAllWindowsMock,
} = vi.hoisted(() => ({
  getMock: vi.fn(),
  listMock: vi.fn(),
  updateMetadataMock: vi.fn(),
  createWakeupMock: vi.fn(),
  wakeupCreatedMock: vi.fn(),
  getAllWindowsMock: vi.fn(() => []),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: (...args: unknown[]) => getMock(...args),
    list: (...args: unknown[]) => listMock(...args),
    search: vi.fn(),
    updateMetadata: (...args: unknown[]) => updateMetadataMock(...args),
    getMany: vi.fn(async () => []),
  },
  SessionFilesRepository: { getFilesBySession: vi.fn(), getFilesBySessionMany: vi.fn() },
}));
vi.mock('../../services/RepositoryManager', () => ({
  getSessionWakeupsStore: () => ({ create: createWakeupMock }),
}));
vi.mock('../../services/SessionWakeupScheduler', () => ({
  SessionWakeupScheduler: { getInstance: () => ({ onCreated: wakeupCreatedMock }) },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: getAllWindowsMock },
}));

import { dispatchSessionContextTool } from '../sessionContextServer';

const OWN_WS = path.resolve('own-workspace');
const FOREIGN_WS = path.resolve('foreign-workspace');

function foreignSession() {
  return { id: 'target-1', title: 'foreign session', workspacePath: FOREIGN_WS, metadata: {} };
}

beforeEach(() => {
  getMock.mockReset();
  listMock.mockReset();
  updateMetadataMock.mockReset();
  createWakeupMock.mockReset();
  wakeupCreatedMock.mockReset();
  getAllWindowsMock.mockReset().mockReturnValue([]);
});

describe('session-context target workspace binding', () => {
  it('keeps the default summary caller-bound and does not leak a foreign title', async () => {
    getMock.mockResolvedValue(foreignSession());

    const result = await dispatchSessionContextTool(
      'get_session_summary', { sessionId: 'target-1' }, 'caller-1', OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(result.content[0].text).not.toContain('foreign session');
  });

  it('schedule_wakeup refuses a foreign-workspace session before creating or broadcasting a wakeup', async () => {
    getMock.mockResolvedValue(foreignSession());

    const result = await dispatchSessionContextTool(
      'schedule_wakeup',
      { delaySeconds: 60, prompt: 'x', reason: 'y' },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(createWakeupMock).not.toHaveBeenCalled();
    expect(wakeupCreatedMock).not.toHaveBeenCalled();
    expect(getAllWindowsMock).not.toHaveBeenCalled();
  });

  it('keeps schedule_wakeup hard-bound despite a targetWorkspacePath argument', async () => {
    getMock.mockResolvedValue(foreignSession());

    const result = await dispatchSessionContextTool(
      'schedule_wakeup',
      { delaySeconds: 60, prompt: 'x', reason: 'y', targetWorkspacePath: FOREIGN_WS },
      'target-1',
      OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(createWakeupMock).not.toHaveBeenCalled();
    expect(wakeupCreatedMock).not.toHaveBeenCalled();
    expect(getAllWindowsMock).not.toHaveBeenCalled();
  });

  it('update_session_board refuses a foreign-workspace session without an explicit target opt-in', async () => {
    getMock.mockResolvedValue(foreignSession());

    const result = await dispatchSessionContextTool(
      'update_session_board', { sessionId: 'target-1', phase: 'complete' }, 'caller-1', OWN_WS,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(updateMetadataMock).not.toHaveBeenCalled();
    expect(getAllWindowsMock).not.toHaveBeenCalled();
  });

  it('update_session_board still mutates a same-workspace session', async () => {
    getMock.mockResolvedValue({ ...foreignSession(), workspacePath: OWN_WS });
    updateMetadataMock.mockResolvedValue(undefined);

    const result = await dispatchSessionContextTool(
      'update_session_board',
      { sessionId: 'target-1', phase: 'complete' },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(false);
    expect(updateMetadataMock).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit target workspace for session-list routing', async () => {
    listMock.mockResolvedValue([]);

    await dispatchSessionContextTool(
      'list_recent_sessions', { targetWorkspacePath: FOREIGN_WS }, 'caller-1', OWN_WS,
    );

    expect(listMock).toHaveBeenCalledWith(FOREIGN_WS, expect.any(Object));
  });

  it('verifies an explicit target session before board mutation or broadcast', async () => {
    getMock.mockResolvedValue(foreignSession());
    updateMetadataMock.mockResolvedValue(undefined);

    const result = await dispatchSessionContextTool(
      'update_session_board',
      { sessionId: 'target-1', phase: 'complete', targetWorkspacePath: FOREIGN_WS },
      'caller-1',
      OWN_WS,
    );

    expect(result.isError).toBe(false);
    expect(updateMetadataMock).toHaveBeenCalledOnce();
  });
});
