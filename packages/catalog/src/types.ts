import type { MetricType } from './names.js';

/** A metric as the catalog describes it to the agent and to people. */
export interface CatalogMetric {
  service: string;
  /** The OpenTelemetry name, or the stored name for metrics found only in the store. */
  metricName: string;
  /** The base name in the metrics store. */
  storedName: string;
  /** The series a query may select. A histogram has three. */
  series: string[];
  type: MetricType;
  unit: string;
  /** Label names as stored, without the pipeline's own labels. */
  labels: string[];
  description: string;
  /** When the metric was last seen in the store. Null: declared in a manifest, not yet seen. */
  lastSeen: Date | null;
}

export interface CatalogEndpoint {
  service: string;
  method: string;
  /** The route template. */
  route: string;
  description: string;
  lastSeen: Date | null;
  /** Requests per second over the last few minutes, when known. */
  requestRate: number | null;
  /** p95 duration in seconds over the last few minutes, when known. */
  p95: number | null;
}

/** One label set of one series, as the store returns it. */
export type SeriesLabels = Record<string, string>;

/**
 * What catalog sync needs from the metrics store. The Query API implements it,
 * already scoped to one workspace; the catalog never talks to the store itself.
 */
export interface StoreReader {
  /** Label sets of the series matching a selector that had samples recently. */
  series(selector: string): Promise<SeriesLabels[]>;
  /** An instant query: one value per label set. */
  instant(query: string): Promise<{ labels: SeriesLabels; value: number }[]>;
}
