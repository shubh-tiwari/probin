import type { ChartTheme } from '@app/charts';

/**
 * The look from the design canvas. Text colours pass 4.5:1 on their
 * backgrounds (checked in theme.test.ts); series differ in dash pattern as
 * well as colour.
 */
export const COLORS = {
  page: '#F4F5F7',
  surface: '#FFFFFF',
  text: '#1B1F27',
  secondary: '#3B4252',
  muted: '#5B6170',
  border: '#DADDE4',
  control: '#B9BECA',
  divider: '#ECEEF2',
  accent: '#1F5FD0',
  accentHover: '#174AA6',
  accentSoft: '#E9EEF9',
  accentSoftText: '#16233F',
  warning: '#B4540A',
  pendingBg: '#FCEFD9',
  pendingText: '#7A3A05',
  danger: '#A61B1B',
};

export const CHART_THEME: ChartTheme = {
  background: COLORS.surface,
  text: COLORS.text,
  muted: COLORS.muted,
  grid: COLORS.divider,
  colors: [
    COLORS.accent,
    COLORS.warning,
    '#5E6578',
    '#0F6E56',
    '#7A3FB8',
    '#A61B5C',
    '#5F4B00',
    '#1B1F27',
  ],
  font: "Inter, system-ui, 'DejaVu Sans', sans-serif",
};

/** WCAG contrast ratio of two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
