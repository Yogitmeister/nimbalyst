/**
 * Effort-level clamping tests for sdkOptionsBuilder's Claude env path.
 *
 * 'ultra' is a Codex-5.6-only reasoning tier (see effortLevels.ts); the
 * Claude Code CLI's /model effort slider tops out at 'max'. Regression
 * coverage for a persisted/cross-provider 'ultra' value reaching the CLI as
 * an effort level it doesn't recognize.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { buildSdkOptions } from '../claudeCode/sdkOptionsBuilder';

function makeDeps(overrides: Partial<Parameters<typeof buildSdkOptions>[0]> = {}) {
  return {
    resolveModelVariant: () => 'opus',
    mcpConfigService: { getMcpServersConfig: async () => ({}) },
    createCanUseToolHandler: () => () => true,
    toolHooksService: {
      createPreToolUseHook: () => () => ({}),
      createPostToolUseHook: () => () => ({}),
      createPermissionDeniedHook: () => () => ({}),
    },
    teammateManager: {
      resolveTeamContext: async () => undefined,
      packagedBuildOptions: undefined as any,
    },
    sessions: { getSessionId: () => null },
    config: {},
    abortController: new AbortController(),
    ...overrides,
  } as Parameters<typeof buildSdkOptions>[0];
}

function makeParams(overrides: Partial<Parameters<typeof buildSdkOptions>[1]> = {}) {
  return {
    message: 'hello',
    workspacePath: '/tmp/workspace',
    settingsEnv: {},
    shellEnv: {},
    systemPrompt: '',
    currentMode: undefined,
    imageContentBlocks: [],
    documentContentBlocks: [],
    ...overrides,
  } as Parameters<typeof buildSdkOptions>[1];
}

describe('buildSdkOptions effort-level clamping', () => {
  // The agent harness running these tests sets CLAUDE_CODE_EFFORT_LEVEL in its
  // own process env to control its own effort; buildSdkOptions spreads
  // process.env as the base layer for options.env (see envKeys.test.ts), so
  // that ambient value leaks in unless each test isolates it.
  let originalEffortLevel: string | undefined;

  beforeEach(() => {
    originalEffortLevel = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  });

  afterEach(() => {
    if (originalEffortLevel === undefined) {
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    } else {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = originalEffortLevel;
    }
  });

  it('clamps the Codex-only "ultra"/Pro tier to "max" before setting CLAUDE_CODE_EFFORT_LEVEL', async () => {
    const { options } = await buildSdkOptions(
      makeDeps({ config: { effortLevel: 'ultra' } }),
      makeParams()
    );
    expect(options.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  it('passes through a level the Claude CLI already supports unchanged', async () => {
    const { options } = await buildSdkOptions(
      makeDeps({ config: { effortLevel: 'xhigh' } }),
      makeParams()
    );
    expect(options.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('xhigh');
  });

  it('omits CLAUDE_CODE_EFFORT_LEVEL when the effort level equals the app default', async () => {
    const { options } = await buildSdkOptions(
      makeDeps({ config: { effortLevel: 'high' } }),
      makeParams()
    );
    expect(options.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });
});
