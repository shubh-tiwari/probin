import type { PanelSpec } from '@app/specs';
import { displayUnit, formatNumber, formatValue, seriesName, type DisplayUnit } from './format.js';
import type { ChartSeries } from './types.js';

/**
 * Draws a panel as SVG. One renderer for the Slack images and the web tool,
 * so a chart looks the same in both.
 *
 * Series differ by more than colour: each line also has its own dash pattern
 * and each bar its own fill pattern, and the legend shows both.
 */

export interface ChartTheme {
  background: string;
  text: string;
  muted: string;
  grid: string;
  /** One per series, in order. */
  colors: string[];
  font: string;
}

export const LIGHT: ChartTheme = {
  background: '#ffffff',
  text: '#1f2328',
  muted: '#59636e',
  grid: '#e4e7eb',
  colors: ['#2463eb', '#d9480f', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#495057'],
  font: "Inter, 'DejaVu Sans', Helvetica, Arial, sans-serif",
};

export const DARK: ChartTheme = {
  background: '#16181d',
  text: '#e6e8eb',
  muted: '#9aa4af',
  grid: '#2c3038',
  colors: ['#6ea8fe', '#ff8c5a', '#69db7c', '#da77f2', '#f783ac', '#3bc9db', '#ffc078', '#ced4da'],
  font: LIGHT.font,
};

const DASHES = ['', '6 4', '2 3', '10 4 2 4', '1 5', '12 6', '4 2 1 2', '8 3 3 3'];

export interface SvgOptions {
  width?: number;
  height?: number;
  theme?: ChartTheme;
  /** The dashboard range, used when the panel has none of its own. */
  range?: string;
  /** Unix seconds. Defaults to the last point's time. */
  now?: number;
  /** Draw the title inside the image. Off where the page shows it already. Default on. */
  title?: boolean;
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Round numbers for an axis from `min` to `max`. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return niceTicks(min - pad, max + pad, count);
  }
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const first = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= max + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  if (ticks.at(-1)! < max) ticks.push(Number((ticks.at(-1)! + step).toPrecision(12)));
  return ticks;
}

function timeLabel(seconds: number, spanSeconds: number): string {
  const date = new Date(seconds * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  const clock = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
  if (spanSeconds <= 36 * 3600) return clock;
  const month = date.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return `${date.getUTCDate()} ${month}`;
}

function header(panel: PanelSpec, theme: ChartTheme, width: number, show = true): string {
  if (!show) return '';
  return (
    `<text x="20" y="30" font-size="16" font-weight="600" fill="${theme.text}">${escape(panel.title)}</text>` +
    `<text x="${width - 20}" y="30" font-size="12" text-anchor="end" fill="${theme.muted}">UTC</text>`
  );
}

function legend(
  series: ChartSeries[],
  theme: ChartTheme,
  y: number,
  width: number,
  kind: 'line' | 'bar',
): string {
  if (series.length < 2) return '';
  let x = 20;
  let row = y;
  const parts: string[] = [];
  series.forEach((one, index) => {
    const name = seriesName(one.labels);
    const itemWidth = 34 + name.length * 7;
    if (x + itemWidth > width - 20) {
      x = 20;
      row += 18;
    }
    const color = theme.colors[index % theme.colors.length]!;
    if (kind === 'line') {
      const dash = DASHES[index % DASHES.length];
      parts.push(
        `<line x1="${x}" y1="${row - 4}" x2="${x + 22}" y2="${row - 4}" stroke="${color}" stroke-width="2.5"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
      );
    } else {
      parts.push(
        `<rect x="${x + 4}" y="${row - 10}" width="12" height="12" fill="url(#p${index})"/>`,
      );
    }
    parts.push(
      `<text x="${x + 28}" y="${row}" font-size="12" fill="${theme.text}">${escape(name)}</text>`,
    );
    x += itemWidth;
  });
  return parts.join('');
}

/** Hatch patterns so bars differ by more than colour. */
function patterns(count: number, theme: ChartTheme): string {
  const defs: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const color = theme.colors[index % theme.colors.length]!;
    const kind = index % 4;
    const marks =
      kind === 0
        ? ''
        : kind === 1
          ? `<path d="M0 6 L6 0" stroke="${theme.background}" stroke-width="1.5"/>`
          : kind === 2
            ? `<circle cx="3" cy="3" r="1.2" fill="${theme.background}"/>`
            : `<path d="M0 3 H6" stroke="${theme.background}" stroke-width="1.5"/>`;
    defs.push(
      `<pattern id="p${index}" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="${color}"/>${marks}</pattern>`,
    );
  }
  return `<defs>${defs.join('')}</defs>`;
}

function stat(
  panel: PanelSpec,
  series: ChartSeries[],
  unit: DisplayUnit,
  theme: ChartTheme,
  w: number,
  h: number,
) {
  const values = series.filter((one) => one.points.length > 0);
  if (values.length === 0) {
    return `<text x="${w / 2}" y="${h / 2 + 10}" font-size="22" text-anchor="middle" fill="${theme.muted}">No data</text>`;
  }
  const cell = (w - 40) / values.length;
  return values
    .map((one, index) => {
      const value = formatValue(one.points.at(-1)![1], unit);
      const cx = 20 + cell * index + cell / 2;
      const name = values.length > 1 ? seriesName(one.labels) : '';
      return (
        `<text x="${cx}" y="${h / 2 + 18}" font-size="${values.length > 2 ? 32 : 48}" font-weight="600" text-anchor="middle" fill="${theme.text}">${escape(value)}</text>` +
        (name
          ? `<text x="${cx}" y="${h / 2 + 46}" font-size="13" text-anchor="middle" fill="${theme.muted}">${escape(name)}</text>`
          : '')
      );
    })
    .join('');
}

/** Draw a panel and its data as an SVG document. */
export function renderSvg(
  panel: PanelSpec,
  input: ChartSeries[],
  options: SvgOptions = {},
): string {
  const width = options.width ?? 800;
  const height = options.height ?? 360;
  const theme = options.theme ?? LIGHT;
  const unit = displayUnit(panel.unit, panel.display_unit);
  const series = input.slice(0, 20);
  const open =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escape(theme.font)}">` +
    `<rect width="${width}" height="${height}" fill="${theme.background}"/>`;

  if (panel.type === 'stat') {
    return `${open}${header(panel, theme, width, options.title !== false)}${stat(panel, series, unit, theme, width, height)}</svg>`;
  }

  const legendRows = series.length > 1 ? Math.ceil(series.length / 4) : 0;
  const plot = {
    left: 64,
    right: width - 20,
    top: options.title === false ? 14 : 52,
    bottom: height - 34 - legendRows * 18,
  };
  const all = series.flatMap((one) => one.points);
  if (all.length === 0) {
    return `${open}${header(panel, theme, width, options.title !== false)}<text x="${width / 2}" y="${height / 2}" font-size="16" text-anchor="middle" fill="${theme.muted}">No data in this range</text></svg>`;
  }

  if (panel.type === 'bar') {
    // One bar per series: its latest value. Bars answer "which is biggest now".
    const values = series.map((one) => one.points.at(-1)?.[1] ?? 0);
    const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
    const lo = ticks[0]!;
    const hi = ticks.at(-1)!;
    const y = (v: number) => plot.bottom - ((v - lo) / (hi - lo)) * (plot.bottom - plot.top);
    const slot = (plot.right - plot.left) / Math.max(1, values.length);
    const bars = values
      .map((value, index) => {
        const x = plot.left + slot * index + slot * 0.15;
        const top = Math.min(y(value), y(0));
        return (
          `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(slot * 0.7).toFixed(1)}" height="${Math.abs(y(value) - y(0)).toFixed(1)}" fill="url(#p${index})"/>` +
          `<text x="${(x + slot * 0.35).toFixed(1)}" y="${(top - 6).toFixed(1)}" font-size="12" text-anchor="middle" fill="${theme.text}">${escape(formatValue(value, unit))}</text>` +
          `<text x="${(x + slot * 0.35).toFixed(1)}" y="${plot.bottom + 18}" font-size="12" text-anchor="middle" fill="${theme.muted}">${escape(seriesName(series[index]!.labels))}</text>`
        );
      })
      .join('');
    return (
      open +
      patterns(series.length, theme) +
      header(panel, theme, width, options.title !== false) +
      axis(ticks, y, plot, unit, theme) +
      bars +
      '</svg>'
    );
  }

  // Time series.
  const times = all.map((point) => point[0]);
  const t0 = Math.min(...times);
  const t1 = options.now ?? Math.max(...times);
  const span = Math.max(1, t1 - t0);
  const ticks = niceTicks(Math.min(0, ...all.map((p) => p[1])), Math.max(...all.map((p) => p[1])));
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const x = (t: number) => plot.left + ((t - t0) / span) * (plot.right - plot.left);
  const y = (v: number) => plot.bottom - ((v - lo) / (hi - lo)) * (plot.bottom - plot.top);

  const lines = series
    .map((one, index) => {
      if (one.points.length === 0) return '';
      const color = theme.colors[index % theme.colors.length]!;
      const dash = DASHES[index % DASHES.length];
      // Break the line where a point is missing, rather than draw across the gap.
      const step = one.points.length > 1 ? one.points[1]![0] - one.points[0]![0] : 0;
      const path = one.points
        .map((point, i) => {
          const gap = i > 0 && step > 0 && point[0] - one.points[i - 1]![0] > step * 1.5;
          return `${i === 0 || gap ? 'M' : 'L'}${x(point[0]).toFixed(1)} ${y(point[1]).toFixed(1)}`;
        })
        .join(' ');
      const single =
        one.points.length === 1
          ? `<circle cx="${x(one.points[0]![0]).toFixed(1)}" cy="${y(one.points[0]![1]).toFixed(1)}" r="3" fill="${color}"/>`
          : '';
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>${single}`;
    })
    .join('');

  const timeTicks = Array.from({ length: 6 }, (_, i) => t0 + (span * i) / 5);
  const xAxis = timeTicks
    .map(
      (t) =>
        `<text x="${x(t).toFixed(1)}" y="${plot.bottom + 18}" font-size="11" text-anchor="middle" fill="${theme.muted}">${timeLabel(t, span)}</text>`,
    )
    .join('');

  return (
    open +
    header(panel, theme, width, options.title !== false) +
    axis(ticks, y, plot, unit, theme) +
    xAxis +
    lines +
    legend(series, theme, plot.bottom + 40, width, 'line') +
    '</svg>'
  );
}

function axis(
  ticks: number[],
  y: (v: number) => number,
  plot: { left: number; right: number },
  unit: DisplayUnit,
  theme: ChartTheme,
): string {
  return ticks
    .map((tick) => {
      const ty = y(tick).toFixed(1);
      const label = unit.suffix ? formatValue(tick, unit) : formatNumber(tick * unit.factor);
      return (
        `<line x1="${plot.left}" y1="${ty}" x2="${plot.right}" y2="${ty}" stroke="${theme.grid}" stroke-width="1"/>` +
        `<text x="${plot.left - 8}" y="${Number(ty) + 4}" font-size="11" text-anchor="end" fill="${theme.muted}">${escape(label)}</text>`
      );
    })
    .join('');
}
