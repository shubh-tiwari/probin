import type { PanelSpec } from '@app/specs';
import { describeRange, displayUnit, formatValue, seriesName } from './format.js';
import type { ChartSeries } from './types.js';

/**
 * The one-line reading of a chart, written in code from the data. No model is
 * involved, so it is safe to show next to every chart and on every refresh.
 *
 *   "p95 latency was 812 ms most recently, between 640 ms and 1.9 s over the last 5 hours."
 */
export function readChart(panel: PanelSpec, series: ChartSeries[], range: string): string {
  const unit = displayUnit(panel.unit, panel.display_unit);
  const withData = series.filter((one) => one.points.length > 0);
  const when = describeRange(panel.range ?? range);
  if (withData.length === 0) return `No data in ${when}.`;

  const subject = panel.title.split(' · ').at(-1) ?? panel.title;
  if (withData.length === 1) {
    const values = withData[0]!.points.map((point) => point[1]);
    const last = values.at(-1)!;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const now = `${capitalise(subject)} was ${formatValue(last, unit)} most recently`;
    if (panel.type === 'stat' || min === max) return `${now}.`;
    return `${now}, between ${formatValue(min, unit)} and ${formatValue(max, unit)} over ${when}.`;
  }

  // Several lines: name the highest and lowest by their latest value.
  const latest = withData
    .map((one) => ({ name: seriesName(one.labels), value: one.points.at(-1)![1] }))
    .sort((a, b) => b.value - a.value);
  const top = latest[0]!;
  const bottom = latest.at(-1)!;
  return (
    `${withData.length} lines over ${when}. Highest most recently: ${top.name} at ${formatValue(top.value, unit)}; ` +
    `lowest: ${bottom.name} at ${formatValue(bottom.value, unit)}.`
  );
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
