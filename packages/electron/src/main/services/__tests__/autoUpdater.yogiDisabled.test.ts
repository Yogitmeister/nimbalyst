// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  build: { appId: 'com.nimbalyst.electron.yogi' },
  handles: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  updater: {
    on: vi.fn(), setFeedURL: vi.fn(), checkForUpdates: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
    autoDownload: true, autoInstallOnAppQuit: true,
  },
  send: vi.fn(), subscribe: vi.fn(),
}));
vi.mock('../../../../package.json', () => ({ default: { build: mocks.build } }));
vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }));
vi.mock('electron-log/main', () => ({ default: {
  transports: { file: {} }, info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} }));
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.78.0.17' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => ({
    isDestroyed: () => false, isVisible: () => true,
    webContents: { send: mocks.send, getURL: () => 'workspace' },
  }) },
  dialog: {},
}));
vi.mock('../../utils/store', () => ({ getReleaseChannel: () => 'stable', store: { get: vi.fn() } }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (name: string, handler: (...args: any[]) => any) => mocks.handles.set(name, handler),
  safeOn: (name: string, handler: (...args: any[]) => any) => mocks.listeners.set(name, handler),
}));
vi.mock('../analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) } }));
vi.mock('../../ipc/SessionStateHandlers', () => ({ hasActiveStreamingSessions: () => false }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('../../database/initialize', () => ({ getDatabase: vi.fn() }));
vi.mock('../electronUpdaterPatch', () => ({ installAtomFeedFilter: vi.fn() }));

import { AutoUpdaterService } from '../autoUpdater';

describe('disabled Yogi updater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.build.appId = 'com.nimbalyst.electron.yogi';
    mocks.handles.clear();
    mocks.listeners.clear();
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('stays silent through startup, periodic, manual and channel-change checks', async () => {
    const service = new AutoUpdaterService();
    service.startAutoUpdateCheck();
    service.reconfigureFeedURL();
    await service.checkForUpdates();
    await service.checkForUpdatesWithUI();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(mocks.updater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.updater.on).not.toHaveBeenCalled();
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects stale renderer check/download/install actions without network, quit or toasts', async () => {
    new AutoUpdaterService();
    expect(await mocks.handles.get('check-for-updates')!()).toEqual({ disabled: true });
    expect(await mocks.handles.get('download-update')!()).toEqual({ success: false, disabled: true });
    mocks.handles.get('quit-and-install')!();
    for (const name of ['update-toast:download', 'update-toast:install', 'update-toast:install-when-idle']) {
      await mocks.listeners.get(name)!();
    }
    await vi.runAllTimersAsync();
    expect(mocks.updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.updater.autoDownload).toBe(false);
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false);
    expect(mocks.handles.get('get-current-version')!()).toBe('0.78.0.17');
  });

  it('keeps official checks, feed configuration and manual feedback active', async () => {
    mocks.build.appId = 'com.nimbalyst.electron';
    const service = new AutoUpdaterService();
    service.startAutoUpdateCheck();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.updater.checkForUpdatesAndNotify).toHaveBeenCalledOnce();
    await service.checkForUpdatesWithUI();
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.updater.setFeedURL).toHaveBeenCalledOnce();
    expect(mocks.updater.on).toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith('update-toast:checking', undefined);
    service.stopAutoUpdateCheck();
  });
});
