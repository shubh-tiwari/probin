export interface ChartSeries {
  labels: Record<string, string>;
  /** `[unix seconds, value]`, oldest first. */
  points: [number, number][];
}
