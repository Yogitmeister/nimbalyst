// [ASTRA-ORCH]
import type {
  ProviderCatalogControl,
  ProviderCatalogEntry,
} from './providerCatalog';
import { BUILT_IN_PROVIDER_CATALOG } from './providerCatalogDefaults';
import type {
  ProviderControlCatalogEntry,
  ProviderControlDefinition,
  ProviderControlMapping,
  ProviderControlTarget,
  ProviderControlValue,
} from './providerControlContract';

const ALL_PHASES = { launch: true, restart: true, 'mid-session': true } as const;
const START_PHASES = { launch: true, restart: true, 'mid-session': false } as const;

function mapping(
  interfaceId: string,
  target: ProviderControlTarget,
  values: readonly string[],
): ProviderControlMapping {
  return {
    interfaceId,
    target,
    values: values.map((value) => ({ storedValue: value, resolvedValue: value })),
  };
}

function effortControl(interfaceId: string, target: ProviderControlTarget, allowedValues: readonly string[]): ProviderControlDefinition {
  return {
    id: 'reasoning-effort',
    settingId: 'effort-level',
    type: 'enum',
    label: 'Reasoning effort',
    helpText: 'Controls the reviewed reasoning-effort parameter for this model route.',
    defaultValue: 'high',
    allowedValues,
    applicability: ALL_PHASES,
    mappings: [mapping(interfaceId, target, allowedValues)],
  };
}

function thinkingControl(interfaceId: string): ProviderControlDefinition {
  return {
    id: 'extended-thinking',
    settingId: 'thinking-mode',
    type: 'enum',
    label: 'Extended thinking',
    helpText: 'Keeps adaptive thinking enabled or explicitly disables it for supported Claude models.',
    defaultValue: 'enabled',
    allowedValues: ['enabled', 'disabled'],
    applicability: START_PHASES,
    mappings: [{
      interfaceId,
      target: 'sdk.thinking.type',
      values: [
        { storedValue: 'enabled', operation: 'omit' },
        { storedValue: 'disabled', resolvedValue: 'disabled' },
      ],
    }],
  };
}

function entry(input: {
  id: string;
  provider: string;
  modelId: string;
  interfaceId: string;
  controls: readonly ProviderControlDefinition[];
}): ProviderControlCatalogEntry {
  return {
    id: input.id,
    provider: input.provider,
    modelId: input.modelId,
    interfaces: [input.interfaceId],
    consumers: ['main-session', 'subagent', 'consultation'],
    controls: input.controls,
  };
}

function normalizeEntryId(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-');
}

/**
 * Projection of one provider-catalog control into the control contract the UI
 * and the SDK options builder read.
 *
 * The catalog is the single source of truth for *which* controls a brain-swap
 * route has and *what values* they accept; this only restates them in contract
 * terms so one selector definition drives the picker, the launch receipt and
 * the spawned environment. Before this existed the two lists drifted: the
 * catalog declared controls that the renderer never saw, so the picker was
 * simply absent for every non-Anthropic route.
 *
 * `off` maps to an omitted effort rather than a value, because the contract
 * only admits low|medium|high|xhigh|max there — off is carried by the thinking
 * target instead, which is the parameter that actually silences reasoning.
 */
function toContractControl(
  settingId: string,
  control: ProviderCatalogControl,
  interfaceId: string,
): ProviderControlDefinition | undefined {
  if (settingId === 'effort-level') {
    // Catalog control values are the wider string|number|boolean union; every
    // reasoning level is a string, so narrow once here rather than casting.
    const allowedValues = control.allowedValues.map((value) => String(value));
    return {
      id: 'reasoning-effort',
      settingId,
      type: 'enum',
      label: 'Reasoning',
      helpText: 'Reasoning effort for this route. "off" disables reasoning entirely.',
      defaultValue: String(control.defaultValue),
      allowedValues,
      applicability: START_PHASES,
      mappings: [
        {
          interfaceId,
          target: 'env.CLAUDE_CODE_EFFORT_LEVEL',
          values: allowedValues.map((value) =>
            value === 'off'
              ? { storedValue: value, operation: 'omit' as const }
              : { storedValue: value, resolvedValue: value }),
        },
        {
          interfaceId,
          target: 'sdk.thinking.type',
          values: allowedValues.map((value) =>
            value === 'off'
              ? { storedValue: value, resolvedValue: 'disabled' }
              : { storedValue: value, operation: 'omit' as const }),
        },
      ],
    };
  }
  if (settingId === 'thinking-mode') {
    return thinkingControl(interfaceId);
  }
  return undefined;
}

/**
 * Controls for a route the provider catalog owns, derived from that route's own
 * catalog entry rather than from a hardcoded model-name test.
 */
function getCatalogRouteControlEntry(modelId: string): ProviderControlCatalogEntry | undefined {
  const catalogEntry: ProviderCatalogEntry | undefined = BUILT_IN_PROVIDER_CATALOG.find(
    (candidate) => candidate.model.persistedId.toLowerCase() === modelId.toLowerCase(),
  );
  const interfaceId = catalogEntry?.interfaces[0]?.id;
  if (!catalogEntry || !interfaceId) return undefined;

  const controls = Object.entries(catalogEntry.controls)
    .map(([, control]) => toContractControl(control.persistenceKey, control, interfaceId))
    .filter((control): control is ProviderControlDefinition => control !== undefined);
  if (!controls.length) return undefined;

  return entry({
    id: normalizeEntryId(catalogEntry.model.persistedId),
    provider: catalogEntry.provider,
    modelId: catalogEntry.model.persistedId,
    interfaceId,
    controls,
  });
}

/**
 * Built-in reviewed controls. Unknown models intentionally receive no entry;
 * callers must not infer capabilities from a nearby provider or model.
 */
export function getBuiltInProviderControlEntry(modelId: string | undefined): ProviderControlCatalogEntry | undefined {
  if (!modelId) return undefined;
  const normalized = modelId.toLowerCase();

  const catalogRoute = getCatalogRouteControlEntry(modelId);
  if (catalogRoute) return catalogRoute;

  if (normalized.startsWith('claude-code:')) {
    const variant = normalized.slice('claude-code:'.length).replace(/-1m$/, '');
    const supportsEffort = variant === 'fable' || variant.startsWith('opus') || variant.startsWith('sonnet');
    if (!supportsEffort) return undefined;
    const controls: ProviderControlDefinition[] = [
      effortControl('claude-agent-sdk', 'env.CLAUDE_CODE_EFFORT_LEVEL', ['low', 'medium', 'high', 'xhigh', 'max']),
    ];
    if (variant.startsWith('opus') || variant.startsWith('sonnet')) {
      controls.push(thinkingControl('claude-agent-sdk'));
    }
    return entry({
      id: normalizeEntryId(normalized),
      provider: 'claude-code',
      modelId,
      interfaceId: 'claude-agent-sdk',
      controls,
    });
  }

  if (normalized === 'model-launcher:deepseek-pro' || normalized === 'model-launcher:deepseek-flash') {
    return entry({
      id: normalizeEntryId(normalized),
      provider: 'model-launcher',
      modelId,
      interfaceId: 'unified-model-launcher',
      controls: [effortControl('unified-model-launcher', 'launcher.effort', ['low', 'medium', 'high', 'xhigh'])],
    });
  }

  return undefined;
}

export function getBuiltInProviderControlCatalog(modelId: string | undefined): readonly ProviderControlCatalogEntry[] {
  const entry = getBuiltInProviderControlEntry(modelId);
  return entry ? [entry] : [];
}

export function reconcileBuiltInProviderControlValues(
  modelId: string | undefined,
  values: Readonly<Record<string, ProviderControlValue | undefined>>,
): { values: Record<string, ProviderControlValue>; resets: Array<{ settingId: string; from: ProviderControlValue; to: ProviderControlValue }> } {
  const entry = getBuiltInProviderControlEntry(modelId);
  if (!entry) return { values: {}, resets: [] };
  const resolved: Record<string, ProviderControlValue> = {};
  const resets: Array<{ settingId: string; from: ProviderControlValue; to: ProviderControlValue }> = [];
  for (const control of entry.controls) {
    const current = values[control.settingId];
    let valid = current !== undefined;
    if (control.type === 'boolean') valid = typeof current === 'boolean';
    if (control.type === 'enum' || control.type === 'profile') {
      valid = typeof current === 'string' && control.allowedValues.includes(current);
    }
    if (control.type === 'number') {
      valid = typeof current === 'number' && Number.isFinite(current)
        && current >= control.minimum && current <= control.maximum;
    }
    resolved[control.settingId] = valid ? current! : control.defaultValue;
    if (current !== undefined && !valid) {
      resets.push({ settingId: control.settingId, from: current, to: control.defaultValue });
    }
  }
  return { values: resolved, resets };
}
