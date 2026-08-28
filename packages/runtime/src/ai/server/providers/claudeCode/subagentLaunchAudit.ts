import type { SubagentLaunchParameter } from '../../transcript/types';

export interface SubagentLaunchConfigMetadata {
  provider: 'claude-code';
  parameters: SubagentLaunchParameter[];
}

function setParameter(
  config: SubagentLaunchConfigMetadata,
  parameter: SubagentLaunchParameter,
): void {
  const index = config.parameters.findIndex(item => item.key === parameter.key);
  if (index === -1) {
    config.parameters.push(parameter);
  } else {
    config.parameters[index] = parameter;
  }
}

export function createSubagentLaunchConfigMetadata(
  options: Record<string, any>,
  config: { effortLevel?: string; thinkingMode?: 'enabled' | 'disabled' },
): SubagentLaunchConfigMetadata {
  const launchConfig: SubagentLaunchConfigMetadata = {
    provider: 'claude-code',
    parameters: [{
      key: 'provider',
      label: 'Provider',
      value: 'claude-code',
      source: 'effective_session',
    }],
  };
  const add = (
    key: string,
    label: string,
    value: string | number | boolean | null | undefined,
    source: SubagentLaunchParameter['source'] = 'requested',
  ) => {
    if (value === undefined || value === '') return;
    setParameter(launchConfig, { key, label, value, source });
  };

  add('modelRequested', 'Requested model', options.model);
  add('model', 'Model', options.model);
  add('fallbackModel', 'Fallback model', options.fallbackModel);
  add('agent', 'Agent persona', options.agent);

  const requestedEffort = options.effort
    ?? options.env?.CLAUDE_CODE_EFFORT_LEVEL
    ?? config.effortLevel;
  add('reasoningEffortRequested', 'Requested reasoning effort', requestedEffort);
  add('reasoningEffort', 'Reasoning effort', requestedEffort);

  const thinkingType = options.thinking?.type;
  if (thinkingType === 'disabled') {
    add('extendedThinking', 'Extended reasoning', 'off');
  } else if (thinkingType === 'enabled') {
    add('extendedThinking', 'Extended reasoning', 'on');
  } else if (thinkingType === 'adaptive') {
    add('extendedThinking', 'Extended reasoning', 'adaptive');
  } else if (config.thinkingMode === 'enabled') {
    add('extendedThinking', 'Extended reasoning', 'on');
  } else if (config.thinkingMode === 'disabled') {
    add('extendedThinkingRequested', 'Requested extended reasoning', 'off');
    add('extendedThinking', 'Extended reasoning', 'provider default', 'effective_session');
  }
  add('thinkingBudgetTokens', 'Thinking budget (tokens)', options.thinking?.budgetTokens);
  add('maximumThinkingTokens', 'Maximum thinking tokens', options.maxThinkingTokens);
  add('maximumTurns', 'Maximum turns', options.maxTurns);
  add('maximumBudgetUsd', 'Maximum budget (USD)', options.maxBudgetUsd);
  add('permissionMode', 'Permission mode', options.permissionMode);
  if (Array.isArray(options.betas) && options.betas.length > 0) {
    add('betas', 'Model betas', options.betas.join(', '));
  }

  return launchConfig;
}

export function applyClaudeInitToSubagentLaunchConfig(
  config: SubagentLaunchConfigMetadata,
  chunk: Record<string, any>,
): void {
  if (typeof chunk.model === 'string' && chunk.model) {
    setParameter(config, {
      key: 'model',
      label: 'Model',
      value: chunk.model,
      source: 'effective_session',
    });
  }
  if (Object.prototype.hasOwnProperty.call(chunk, 'effort')) {
    setParameter(config, {
      key: 'reasoningEffort',
      label: 'Reasoning effort',
      value: chunk.effort ?? null,
      source: 'effective_session',
    });
  }
  if (typeof chunk.permissionMode === 'string' && chunk.permissionMode) {
    setParameter(config, {
      key: 'permissionMode',
      label: 'Permission mode',
      value: chunk.permissionMode,
      source: 'effective_session',
    });
  }
  if (Array.isArray(chunk.betas) && chunk.betas.length > 0) {
    setParameter(config, {
      key: 'betas',
      label: 'Model betas',
      value: chunk.betas.join(', '),
      source: 'effective_session',
    });
  }
}

export function shouldAttachSubagentLaunchConfig(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const message = chunk as Record<string, any>;
  if (typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id) {
    return true;
  }
  if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) {
    return false;
  }
  return message.message.content.some((block: any) =>
    block?.type === 'tool_use'
    && (block.name === 'Agent' || block.name === 'Task')
  );
}
