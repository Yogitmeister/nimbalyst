// [ASTRA-ORCH]
import { describe, it, expect } from 'vitest';
import { listLaunchableCatalogRoutes } from '@nimbalyst/runtime/ai/server';

// The legacy CLAUDE_CODE_BACKENDS projection only ever held local-proxy routes
// and is empty now that Ollama goes direct, so the picker gates are asserted
// against the catalog routes they actually read.
const CATALOG_ROUTES = listLaunchableCatalogRoutes();
import { isModelEnabled } from '../modelEnablementFilter';
import {
  claudeCodeCatalogModelIds,
  reconcileClaudeCodeModels,
} from '../claudeCodeModelReconcile';

/**
 * Regression cover for the V14C smoke failure: the catalog-backed brain-swap
 * routes existed and were launchable, but never reached the picker as Claude
 * Agent rows. Two independent gates had to hold, and each was broken in turn --
 * first the provider never exported them, then an existing install's exclusive
 * allow-list filtered them out. A source read proved neither; only composing
 * both does.
 */
describe('catalog brain-swap routes reach the Claude Agent picker', () => {
  // The real allow-list read from an existing install on 2026-08-14. Exclusive,
  // and predating every catalog route.
  const EXISTING_INSTALL_ALLOWLIST = [
    'claude-code:fable',
    'claude-code:opus',
    'claude-code:sonnet-5',
    'claude-code:fable-5',
    'claude-code:opus-4-7',
    'claude-code:opus-4-6',
    'claude-code:sonnet',
    'claude-code:haiku',
    'claude-code:sonnet-4-6',
    'claude-code:deepseek',
    'claude-code:opus-4-8',
  ];

  it('exposes at least one catalog route to reconcile', () => {
    expect(CATALOG_ROUTES.length).toBeGreaterThan(0);
  });

  it('includes every catalog route in the reconciliation catalog', () => {
    const catalog = claudeCodeCatalogModelIds();
    for (const backend of CATALOG_ROUTES) {
      expect(catalog).toContain(backend.model.persistedId);
    }
  });

  it('back-fills catalog routes into an existing exclusive allow-list', () => {
    const result = reconcileClaudeCodeModels(EXISTING_INSTALL_ALLOWLIST, undefined);
    expect(result.changed).toBe(true);
    for (const backend of CATALOG_ROUTES) {
      expect(result.models).toContain(backend.model.persistedId);
    }
    // A user's existing choices are never dropped.
    for (const id of EXISTING_INSTALL_ALLOWLIST) {
      expect(result.models).toContain(id);
    }
  });

  it('passes the enablement filter once reconciled', () => {
    const { models } = reconcileClaudeCodeModels(EXISTING_INSTALL_ALLOWLIST, undefined);
    const entry = { enabled: true, models };
    for (const backend of CATALOG_ROUTES) {
      expect(
        isModelEnabled({ id: backend.model.persistedId, provider: 'claude-code' }, entry),
      ).toBe(true);
    }
  });

  it('would have hidden every catalog route before the fix', () => {
    // Guards the regression itself: with the pre-fix allow-list and no
    // back-fill, the enablement gate rejects all of them.
    const entry = { enabled: true, models: EXISTING_INSTALL_ALLOWLIST };
    for (const backend of CATALOG_ROUTES) {
      expect(
        isModelEnabled({ id: backend.model.persistedId, provider: 'claude-code' }, entry),
      ).toBe(false);
    }
  });

  it('respects a deliberate opt-out via the known snapshot', () => {
    const removed = CATALOG_ROUTES[0].model.persistedId;
    const known = claudeCodeCatalogModelIds();
    const result = reconcileClaudeCodeModels(EXISTING_INSTALL_ALLOWLIST, known);
    expect(result.models).not.toContain(removed);
  });
});
