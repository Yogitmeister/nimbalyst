// [ASTRA-ORCH]
import { afterEach, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { initWorkstreamState, workstreamStateAtom } from '../workstreamState';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('retains a pre-init edit without persistence, then persists it on a later routed edit', async () => {
  vi.useFakeTimers();
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', { electronAPI: { invoke } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const state = workstreamStateAtom('pre-init-session');
  expect(() => store.set(state, { activeChildId: 'child-1' })).not.toThrow();
  expect(store.get(state).activeChildId).toBe('child-1');
  await vi.runAllTimersAsync();
  expect(invoke).not.toHaveBeenCalled();
  initWorkstreamState('D:/test-workspace');
  store.set(state, { activeChildId: 'child-2' });
  await vi.runAllTimersAsync();
  expect(invoke).toHaveBeenCalledWith('workspace:set-workstream-state', expect.objectContaining({
    workspacePath: 'D:/test-workspace', workstreamId: 'pre-init-session',
    state: expect.objectContaining({ activeChildId: 'child-2' }),
  }));
});
