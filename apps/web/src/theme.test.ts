import { describe, expect, it } from 'vitest';
import { COLORS, DARK_CHART_THEME, DARK_COLORS, contrast } from './theme.js';

/** Text and the surfaces it sits on, for both looks. Normal text needs 4.5:1. */
describe.each([
  ['light', COLORS],
  ['dark', DARK_COLORS],
])('the %s palette', (_name, c) => {
  it.each([
    ['text on page', c.text, c.page],
    ['text on surface', c.text, c.surface],
    ['secondary on surface', c.secondary, c.surface],
    ['muted on surface', c.muted, c.surface],
    ['muted on page', c.muted, c.page],
    ['links on surface', c.accent, c.surface],
    ['button text', c.onAccent, c.accentButton],
    ['selected tab', c.accentSoftText, c.accentSoft],
    ['pending badge', c.pendingText, c.pendingBg],
    ['firing badge', c.onWarning, c.warning],
    ['errors on surface', c.danger, c.surface],
  ])('%s passes 4.5:1', (_what, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('dark charts', () => {
  it('draw every series at 3:1 or more against the chart background', () => {
    for (const color of DARK_CHART_THEME.colors) {
      expect(contrast(color, DARK_CHART_THEME.background)).toBeGreaterThanOrEqual(3);
    }
  });
});
