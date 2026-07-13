import React, { useState } from 'react';
import {
  FloatingPortal,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { EffortLevel } from '../../utils/modelUtils';
import { EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL } from '../../utils/modelUtils';

export type EffortSetting = EffortLevel | 'auto' | 'auto-plus';

interface EffortLevelSelectorProps {
  level: EffortSetting;
  onLevelChange: (level: EffortSetting) => void;
  /** Model-supported subset of EFFORT_LEVELS; without it, 'ultra' (Codex-5.6-only) is hidden. */
  supportedLevels?: { key: EffortLevel; label: string }[];
  allowAuto?: boolean;
  resolvedEffort?: string | null;
}

const AUTO_LEVELS: Array<{ key: EffortSetting; label: string }> = [
  { key: 'auto', label: 'Auto' },
  { key: 'auto-plus', label: 'Auto+' },
];

function effortLabel(value: string): string {
  return EFFORT_LEVELS.find((level) => level.key === value)?.label
    ?? value.charAt(0).toUpperCase() + value.slice(1);
}

export function EffortLevelSelector({
  level,
  onLevelChange,
  supportedLevels,
  allowAuto = false,
  resolvedEffort,
}: EffortLevelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'top-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  const fixedLevels = supportedLevels ?? EFFORT_LEVELS.filter(l => l.key !== 'ultra');
  const availableLevels: Array<{ key: EffortSetting; label: string }> = allowAuto
    ? [...fixedLevels, ...AUTO_LEVELS]
    : fixedLevels;
  const currentLevel = availableLevels.find(l => l.key === level)
    ?? EFFORT_LEVELS.find(l => l.key === DEFAULT_EFFORT_LEVEL)!;
  const isAuto = level === 'auto' || level === 'auto-plus';
  const actualEffort = resolvedEffort ?? (level === 'auto-plus' ? 'xhigh' : 'high');

  return (
    <div className="effort-level-control inline-flex items-center gap-1" data-component="EffortLevelSelector">
      <button
        ref={refs.setReference}
        data-testid="effort-level-selector"
        className="effort-level-selector flex items-center gap-1 px-2 py-[3px] rounded-xl text-[11px] font-medium cursor-pointer transition-all duration-200 outline-none whitespace-nowrap bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)]"
        aria-label={`Effort level: ${currentLevel.label}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        {...getReferenceProps()}
      >
        <MaterialSymbol icon="psychology" size={12} />
        <span>{currentLevel.label}</span>
        <MaterialSymbol icon="expand_more" size={14} className={`transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isAuto && (
        <span
          className="auto-effort-resolved-badge rounded-full border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] px-1.5 py-[2px] text-[10px] font-medium text-[var(--nim-text-faint)]"
          data-testid="auto-effort-resolved-badge"
          aria-label={`Actual effort: ${effortLabel(actualEffort)}`}
          title={`Actual effort for the latest turn: ${effortLabel(actualEffort)}`}
        >
          {effortLabel(actualEffort)}
        </span>
      )}

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="effort-level-menu min-w-[120px] rounded-lg p-1 z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
            data-testid="effort-level-menu"
            {...getFloatingProps()}
          >
            {availableLevels.map(l => (
              <button
                key={l.key}
                role="menuitemradio"
                aria-checked={l.key === level}
                className={`effort-level-option flex items-center justify-between gap-2 px-2 py-1.5 w-full border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left ${l.key === level ? 'bg-[var(--nim-bg-secondary)] text-[var(--nim-primary)]' : 'text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'}`}
                onClick={() => { onLevelChange(l.key); setIsOpen(false); }}
              >
                <span>{l.label}</span>
                {l.key === level && <MaterialSymbol icon="check" size={14} />}
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
