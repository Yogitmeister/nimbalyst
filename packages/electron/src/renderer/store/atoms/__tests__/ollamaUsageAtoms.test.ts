// [ASTRA-ORCH]
/**
 * Pins the one deliberate behavior difference from the copied Gemini
 * pattern: "never configured" (no explicit Ollama key) stays hidden, while a
 * transient failure with a key configured stays visible with the error
 * surfaced. See ollamaUsageAtoms.ts's module doc for the Gemini bug this
 * avoids (an indicator stuck permanently visible after one early failure).
 */
import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai';
import { ollamaUsageAtom, ollamaUsageAvailableAtom, OllamaUsageData } from '../ollamaUsageAtoms';

function baseData(overrides: Partial<OllamaUsageData> = {}): OllamaUsageData {
  return {
    limitsAvailable: false,
    proxyReachable: false,
    configuredAliases: [],
    planTiers: [],
    lastUpdated: Date.now(),
    ...overrides,
  };
}

describe('ollamaUsageAvailableAtom', () => {
  it('is hidden before any data has been fetched', () => {
    const store = createStore();
    expect(store.get(ollamaUsageAvailableAtom)).toBe(false);
  });

  it('stays hidden when no Ollama API key is configured', () => {
    const store = createStore();
    store.set(ollamaUsageAtom, baseData({ error: 'Ollama API key not configured in settings.' }));
    expect(store.get(ollamaUsageAvailableAtom)).toBe(false);
  });

  it('becomes visible on a transient failure once a key IS configured', () => {
    const store = createStore();
    store.set(ollamaUsageAtom, baseData({ error: 'Ollama usage API returned HTTP 503' }));
    expect(store.get(ollamaUsageAvailableAtom)).toBe(true);
  });

  it('is visible once real session/weekly usage comes back', () => {
    const store = createStore();
    store.set(
      ollamaUsageAtom,
      baseData({
        limitsAvailable: true,
        session: { utilization: 0, resetsAt: null, models: [] },
        weekly: { utilization: 5.1, resetsAt: null, models: [] },
      })
    );
    expect(store.get(ollamaUsageAvailableAtom)).toBe(true);
  });

  it('is visible when only the local proxy is reachable, even with no account data', () => {
    const store = createStore();
    store.set(ollamaUsageAtom, baseData({ proxyReachable: true, configuredAliases: ['claude-ollama-gpt-oss-20b'] }));
    expect(store.get(ollamaUsageAvailableAtom)).toBe(true);
  });
});
