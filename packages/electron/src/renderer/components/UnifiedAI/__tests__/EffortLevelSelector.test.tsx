// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { EffortLevelSelector } from '../EffortLevelSelector';
import { EFFORT_LEVELS } from '../../../utils/modelUtils';

vi.mock('@nimbalyst/runtime', () => ({ MaterialSymbol: () => null }));

afterEach(() => cleanup());

describe('EffortLevelSelector - model-aware supported levels (#829 follow-up)', () => {
  it('renders Pro when the caller passes a supportedLevels list that includes ultra (gpt-5.6-sol/terra)', () => {
    render(<EffortLevelSelector level="high" onLevelChange={() => {}} supportedLevels={EFFORT_LEVELS} />);
    fireEvent.click(screen.getByTestId('effort-level-selector'));
    expect(screen.getByText('Pro')).toBeTruthy();
  });

  it('hides Pro when the supportedLevels list excludes ultra (e.g. gpt-5.6-luna, pre-5.6, Claude)', () => {
    const nonProLevels = EFFORT_LEVELS.filter(l => l.key !== 'ultra');
    render(<EffortLevelSelector level="high" onLevelChange={() => {}} supportedLevels={nonProLevels} />);
    fireEvent.click(screen.getByTestId('effort-level-selector'));
    expect(screen.queryByText('Pro')).toBeNull();
  });

  it('defaults to hiding Pro when no supportedLevels prop is passed (unknown/non-Codex models never expose Pro)', () => {
    render(<EffortLevelSelector level="high" onLevelChange={() => {}} />);
    fireEvent.click(screen.getByTestId('effort-level-selector'));
    expect(screen.queryByText('Pro')).toBeNull();
  });

  it('reports the clicked level and closes the dropdown', () => {
    const onLevelChange = vi.fn();
    render(<EffortLevelSelector level="high" onLevelChange={onLevelChange} supportedLevels={EFFORT_LEVELS} />);
    fireEvent.click(screen.getByTestId('effort-level-selector'));
    fireEvent.click(screen.getByText('Pro'));
    expect(onLevelChange).toHaveBeenCalledWith('ultra');
    expect(screen.queryByText('Pro')).toBeNull();
  });

  it('exposes the current level via an accessible label', () => {
    render(<EffortLevelSelector level="xhigh" onLevelChange={() => {}} supportedLevels={EFFORT_LEVELS} />);
    expect(screen.getByTestId('effort-level-selector').getAttribute('aria-label')).toBe('Effort level: xHigh');
  });

  it('closes the dropdown on Escape', () => {
    render(<EffortLevelSelector level="high" onLevelChange={() => {}} supportedLevels={EFFORT_LEVELS} />);
    fireEvent.click(screen.getByTestId('effort-level-selector'));
    expect(screen.getByText('Pro')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Pro')).toBeNull();
  });
});
