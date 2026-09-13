/**
 * Tests for per-model weekly limits in the Claude usage payload.
 *
 * The usage API used to expose a dedicated `seven_day_opus` object, and the
 * panel read only that field. The API now reports `seven_day_opus: null` and
 * publishes per-model limits in the generic `limits[]` array as
 * `kind: "weekly_scoped"` entries carrying `scope.model.display_name`. With
 * only the old field wired up, a user sitting at 100% on a model-scoped weekly
 * limit saw no bar at all - the panel showed session and weekly and nothing
 * else, which is exactly the number they needed.
 *
 * Because the original defect was "a limit rendered as nothing", most of what
 * follows pins the *invisibility* cases rather than the happy path: an absent
 * percentage, a zero percentage on an actively-limiting entry, and a scoped
 * entry we cannot label must never silently vanish.
 */
import { describe, it, expect } from 'vitest';
import { parseScopedLimits, extractScopedLimits } from '../claudeUsageLimits';
import { shouldDisplayScopedLimit } from '../../../renderer/store/atoms/claudeUsageAtoms';

/** Trimmed copy of a real response: legacy field null, scoped limit in limits[]. */
const CURRENT_PAYLOAD = {
  five_hour: { utilization: 86.0, resets_at: '2026-09-13T07:29:59.864341+00:00' },
  seven_day: { utilization: 57.0, resets_at: '2026-09-13T14:59:59.864361+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 86,
      severity: 'warning',
      resets_at: '2026-09-13T07:29:59.864341+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 57,
      severity: 'normal',
      resets_at: '2026-09-13T14:59:59.864361+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      severity: 'critical',
      resets_at: '2026-09-13T14:59:59.864559+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
};

describe('parseScopedLimits', () => {
  it('surfaces a model-scoped weekly limit that the legacy field no longer reports', () => {
    const { limits } = parseScopedLimits(CURRENT_PAYLOAD);

    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      label: 'Fable',
      utilization: 100,
      resetsAt: '2026-09-13T14:59:59.864559+00:00',
      severity: 'critical',
      isActive: true,
    });
    expect(shouldDisplayScopedLimit(limits[0])).toBe(true);
  });

  it('ignores account-wide session and weekly entries', () => {
    expect(extractScopedLimits(CURRENT_PAYLOAD).map((l) => l.label)).toEqual(['Fable']);
  });

  describe('a limit must never be silently invisible', () => {
    it('reports an absent percent as unknown, not as 0%, and still shows it', () => {
      const [limit] = extractScopedLimits({
        limits: [
          {
            kind: 'weekly_scoped',
            severity: 'critical',
            scope: { model: { display_name: 'Fable' } },
            is_active: true,
          },
        ],
      });

      expect(limit.utilization).toBeNull();
      expect(limit.severity).toBe('critical');
      expect(shouldDisplayScopedLimit(limit)).toBe(true);
    });

    it('treats an unknown percent as at least a warning, never normal', () => {
      const [limit] = extractScopedLimits({
        limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } } }],
      });

      expect(limit.utilization).toBeNull();
      expect(limit.severity).toBe('warning');
    });

    it('keeps a 0% limit that the API says is limiting you right now', () => {
      const [limit] = extractScopedLimits({
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 0,
            scope: { model: { display_name: 'Nimbus Quill' } },
            is_active: true,
          },
        ],
      });

      expect(limit.utilization).toBe(0);
      expect(shouldDisplayScopedLimit(limit)).toBe(true);
    });

    it('hides only a genuinely idle 0% limit', () => {
      const [limit] = extractScopedLimits({
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 0,
            scope: { model: { display_name: 'Nimbus Quill' } },
            is_active: false,
          },
        ],
      });

      expect(shouldDisplayScopedLimit(limit)).toBe(false);
    });

    it('reports a scoped entry it cannot label instead of dropping it in silence', () => {
      const { limits, discarded } = parseScopedLimits({
        limits: [{ kind: 'weekly_scoped', percent: 50, scope: { surface: { id: 'web' } } }],
      });

      expect(limits).toEqual([]);
      expect(discarded).toEqual([
        { reason: 'no-model-name', kind: 'weekly_scoped', surfaceScoped: true },
      ]);
    });

    it('still shows a model-scoped limit if the server renames the kind', () => {
      const [limit] = extractScopedLimits({
        limits: [
          {
            kind: 'weekly_model_quota',
            percent: 77,
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      });

      expect(limit).toMatchObject({ label: 'Fable', utilization: 77 });
    });
  });

  describe('percent coercion', () => {
    it('accepts a numeric string and clamps out-of-range values', () => {
      const limits = extractScopedLimits({
        limits: [
          { kind: 'weekly_scoped', percent: '64', scope: { model: { display_name: 'A' } } },
          { kind: 'weekly_scoped', percent: 140, scope: { model: { display_name: 'B' } } },
          { kind: 'weekly_scoped', percent: -5, scope: { model: { display_name: 'C' } } },
        ],
      });

      expect(limits.map((l) => l.utilization)).toEqual([64, 100, 0]);
    });

    it('treats a non-numeric percent as unknown rather than zero', () => {
      const [limit] = extractScopedLimits({
        limits: [
          { kind: 'weekly_scoped', percent: 'n/a', scope: { model: { display_name: 'Fable' } } },
        ],
      });

      expect(limit.utilization).toBeNull();
    });
  });

  describe('severity', () => {
    it('takes the worse of the API verdict and the percentage', () => {
      const [limit] = extractScopedLimits({
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 95,
            severity: 'normal',
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      });

      expect(limit.severity).toBe('critical');
    });

    it('keeps the API verdict when it is the worse of the two', () => {
      const [limit] = extractScopedLimits({
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 5,
            severity: 'critical',
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      });

      expect(limit.severity).toBe('critical');
    });

    it('derives one when the API omits it', () => {
      const [limit] = extractScopedLimits({
        limits: [
          { kind: 'weekly_scoped', percent: 91, scope: { model: { display_name: 'Fable' } } },
        ],
      });

      expect(limit.severity).toBe('critical');
    });
  });

  describe('ids', () => {
    it('keys on model identity, so a survivor keeps its id when a sibling disappears', () => {
      const twoModels = {
        limits: [
          { kind: 'weekly_scoped', percent: 100, scope: { model: { display_name: 'Fable' } } },
          {
            kind: 'weekly_scoped',
            percent: 12,
            scope: { model: { id: 'claude-opus-5', display_name: 'Opus' } },
          },
        ],
      };
      const oneModel = { limits: [twoModels.limits[1]] };

      const before = extractScopedLimits(twoModels);
      const after = extractScopedLimits(oneModel);

      expect(new Set(before.map((l) => l.id)).size).toBe(2);
      expect(after[0].id).toBe(before[1].id);
    });

    it('disambiguates a repeated model name', () => {
      const limits = extractScopedLimits({
        limits: [
          { kind: 'weekly_scoped', percent: 10, scope: { model: { display_name: 'Fable' } } },
          { kind: 'weekly_scoped', percent: 20, scope: { model: { display_name: 'Fable' } } },
        ],
      });

      expect(new Set(limits.map((l) => l.id)).size).toBe(2);
    });
  });

  describe('legacy seven_day_opus fallback', () => {
    it('stands in only when the payload carries no limits array at all', () => {
      const limits = extractScopedLimits({
        seven_day_opus: { utilization: 42, resets_at: '2026-09-13T14:59:59Z' },
      });

      expect(limits).toEqual([
        {
          id: 'weekly_scoped:opus:legacy',
          label: 'Opus',
          utilization: 42,
          resetsAt: '2026-09-13T14:59:59Z',
          severity: 'normal',
          isActive: false,
        },
      ]);
    });

    it('does not resurrect a stale Opus bar on a current payload with no scoped entries', () => {
      const limits = extractScopedLimits({
        seven_day_opus: { utilization: 42, resets_at: '2026-09-13T14:59:59Z' },
        limits: [{ kind: 'session', percent: 10, severity: 'normal', scope: null }],
      });

      expect(limits).toEqual([]);
    });
  });

  it('tolerates a missing or malformed payload', () => {
    expect(extractScopedLimits({})).toEqual([]);
    expect(extractScopedLimits(null)).toEqual([]);
    expect(extractScopedLimits({ limits: 'nope' })).toEqual([]);
  });
});
