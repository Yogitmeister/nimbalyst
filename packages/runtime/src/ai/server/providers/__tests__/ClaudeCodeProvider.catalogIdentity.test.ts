// [ASTRA-ORCH]
import { expect, it } from 'vitest';
import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import { ClaudeCodeCliProvider } from '../ClaudeCodeCliProvider';
import { resolveClaudeCodeModelVariant } from '../../types';
it('removes SDK duplicate rows while retaining CLI extended choices and persisted SDK sessions', async () => {
  const sdk = await ClaudeCodeProvider.getModels();
  const cli = await ClaudeCodeCliProvider.getModels();
  expect(sdk.some(model => model.id === 'claude-code:opus-1m')).toBe(false);
  expect(sdk.find(model => model.id === 'claude-code:opus')?.contextWindow).toBe(1_000_000);
  expect(cli.some(model => model.id === 'claude-code-cli:opus-1m')).toBe(true);
  expect(cli.some(model => model.id === 'claude-code-cli:fable-1m')).toBe(true);
  expect(resolveClaudeCodeModelVariant('claude-code:opus-1m', 'claude-code:sonnet')).toBe('opus[1m]');
});
