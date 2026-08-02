import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  projectOllamaUsageSidecar,
  publishOllamaUsageSidecar,
} from '../ProviderUsageSidecar';

describe('ProviderUsageSidecar', () => {
  it('projects only redacted Ollama session and weekly percentages with null reset fields', () => {
    const sidecar = projectOllamaUsageSidecar({
      limitsAvailable: true,
      session: { utilization: 0, resetsAt: null },
      weekly: { utilization: 5.1, resetsAt: null },
      lastUpdated: Date.now(),
    });

    expect(sidecar).toEqual({
      schema_version: 1,
      provider: 'ollama',
      source: 'nimbalyst-ollama',
      fetched_at: expect.any(Number),
      windows: [
        { slot: 'session', label: 'session', used_percentage: 0, window_seconds: null, resets_at: null },
        { slot: 'weekly', label: 'weekly', used_percentage: 5.1, window_seconds: null, resets_at: null },
      ],
      error_code: null,
    });
    expect(JSON.stringify(sidecar)).not.toContain('OLLAMA_API_KEY');
    expect(JSON.stringify(sidecar)).not.toContain('resetsAt');
  });

  it('rejects unavailable, invalid, or future usage without replacing last-known-good data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nimbalyst-ollama-sidecar-'));
    const target = join(directory, 'ollama-usage.json');
    try {
      expect(publishOllamaUsageSidecar({
        limitsAvailable: true,
        session: { utilization: 12, resetsAt: null },
        lastUpdated: Date.now(),
      }, target)).toBe(true);
      const prior = readFileSync(target, 'utf8');

      expect(publishOllamaUsageSidecar({
        limitsAvailable: true,
        weekly: { utilization: 101, resetsAt: null },
        lastUpdated: Date.now(),
      }, target)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe(prior);

      expect(publishOllamaUsageSidecar({
        limitsAvailable: false,
        session: { utilization: 2, resetsAt: null },
        lastUpdated: Date.now(),
      }, target)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe(prior);

      expect(projectOllamaUsageSidecar({
        limitsAvailable: true,
        session: { utilization: 2, resetsAt: null },
        lastUpdated: Date.now() + 1,
      })).toBeNull();

      const fresherAt = Date.now();
      expect(publishOllamaUsageSidecar({
        limitsAvailable: true,
        session: { utilization: 40, resetsAt: null },
        lastUpdated: fresherAt,
      }, target)).toBe(true);
      const freshBytes = readFileSync(target, 'utf8');
      expect(publishOllamaUsageSidecar({
        limitsAvailable: true,
        session: { utilization: 10, resetsAt: null },
        lastUpdated: fresherAt - 1,
      }, target)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe(freshBytes);

      const lockPath = `${target}.lock`;
      writeFileSync(lockPath, 'owned-by-standalone\n', 'utf8');
      expect(publishOllamaUsageSidecar({
        limitsAvailable: true,
        session: { utilization: 50, resetsAt: null },
        lastUpdated: Date.now(),
      }, target)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe(freshBytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
