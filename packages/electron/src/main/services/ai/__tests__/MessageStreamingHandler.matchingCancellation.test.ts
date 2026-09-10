// [ASTRA-ORCH]
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SessionMatchRunCoordinator } from '../MessageStreamingHandler';

describe('MessageStreamingHandler matcher cancellation', () => {
  it('aborts the superseded run and retains the current run signal through finalization', () => {
    const coordinator = new SessionMatchRunCoordinator();
    const incremental = coordinator.replace('session-1');
    const final = coordinator.replace('session-1');

    expect(incremental.signal.aborted).toBe(true);
    expect(final.signal.aborted).toBe(false);

    // Completion of the old promise must not release the final controller.
    coordinator.release('session-1', incremental);
    const superseding = coordinator.replace('session-1');

    expect(final.signal.aborted).toBe(true);
    expect(superseding.signal.aborted).toBe(false);
  });
});
