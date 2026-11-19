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
  /** Primary buttons: background and the text on it. */
  accentButton: '#1F5FD0',
  onAccent: '#FFFFFF',
  accentSoft: '#E9EEF9',
  accentSoftText: '#16233F',
  warning: '#B4540A',
  pendingBg: '#FCEFD9',
  pendingText: '#7A3A05',
  danger: '#A61B1B',
  onWarning: '#FFFFFF',
};

/** The dark look, in the product site's language: night navy, violet light. */
export const DARK_COLORS: typeof COLORS = {
  page: '#070A1A',
  surface: '#10153A',
  text: '#EEF0FF',
  secondary: '#C3C8E8',
  muted: '#9AA3C7',
  border: '#2A3166',
  control: '#3B4382',
  divider: '#1C2250',
  accent: '#A99CFF',
  accentHover: '#C4BBFF',
  accentButton: '#6A4CE0',
  onAccent: '#FFFFFF',
  accentSoft: '#262066',
  accentSoftText: '#DCD6FF',
  warning: '#F5B544',
  pendingBg: '#3A2C10',
  pendingText: '#F8D58A',
  danger: '#FF8A8A',
  onWarning: '#1A1300',
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

export const DARK_CHART_THEME: ChartTheme = {
  background: DARK_COLORS.surface,
  text: DARK_COLORS.text,
  muted: DARK_COLORS.muted,
  grid: '#232B5E',
  colors: ['#A99CFF', '#F5A35C', '#4FD1A5', '#5EC8FF', '#F472B6', '#FFD166', '#C084FC', '#CBD5F5'],
  font: CHART_THEME.font,
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
