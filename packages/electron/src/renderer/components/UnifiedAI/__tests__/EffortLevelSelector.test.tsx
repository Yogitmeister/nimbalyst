// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EffortLevelSelector } from '../EffortLevelSelector';

vi.mock('@nimbalyst/runtime', () => ({ MaterialSymbol: () => null }));

afterEach(() => cleanup());

describe('EffortLevelSelector Auto controls', () => {
  it('offers Auto and Auto+ only when the Claude Agent control enables them', () => {
    render(
      <EffortLevelSelector level="high" onLevelChange={vi.fn()} allowAuto={false} />,
    );
    fireEvent.click(screen.getByTestId('effort-level-selector'));
    expect(screen.queryByText('Auto')).toBeNull();
    expect(screen.queryByText('Auto+')).toBeNull();

    cleanup();
    render(<EffortLevelSelector level="high" onLevelChange={vi.fn()} allowAuto />);
    fireEvent.click(screen.getByTestId('effort-level-selector'));
    expect(screen.getByText('Auto')).toBeTruthy();
    expect(screen.getByText('Auto+')).toBeTruthy();
  });

  it('keeps Auto selected while showing the default actual effort before the first turn', () => {
    render(<EffortLevelSelector level="auto" onLevelChange={vi.fn()} allowAuto />);

    expect(screen.getByTestId('effort-level-selector').textContent).toContain('Auto');
    expect(screen.getByTestId('auto-effort-resolved-badge').textContent).toBe('High');
    expect(screen.getByLabelText('Actual effort: High')).toBeTruthy();
  });

  it('shows Auto+ as selected while the badge reflects recorded concrete effort', () => {
    render(
      <EffortLevelSelector
        level="auto-plus"
        onLevelChange={vi.fn()}
        allowAuto
        resolvedEffort="max"
      />,
    );

    expect(screen.getByTestId('effort-level-selector').textContent).toContain('Auto+');
    expect(screen.getByTestId('auto-effort-resolved-badge').textContent).toBe('Max');
  });

  it('emits the Auto mode without replacing the selector with a concrete level', () => {
    const onChange = vi.fn();
    render(<EffortLevelSelector level="high" onLevelChange={onChange} allowAuto />);
    fireEvent.click(screen.getByTestId('effort-level-selector'));
    fireEvent.click(screen.getByText('Auto'));

    expect(onChange).toHaveBeenCalledWith('auto');
  });
});
