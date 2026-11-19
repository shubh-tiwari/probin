/**
 * What every Review analysis produces. A finding always names the metric and
 * time window it rests on (`evidence`); a finding about code says where.
 */
export type FindingKind =
  | 'slow_endpoint'
  | 'error_prone_endpoint'
  | 'convention'
  | 'touches_measured_endpoint'
  | 'post_deploy_regression'
  | 'single_point_of_failure'
  | 'chatty_pair'
  | 'unused_endpoint';

export interface Evidence {
  /** The OpenTelemetry metric the finding rests on. */
  metric: string;
  /** The time window, e.g. "24h", or "this pull request" for a static check. */
  window: string;
  /** The query behind the numbers, when there is one. */
  query?: string;
  /** The numbers themselves. */
  values?: Record<string, number | string | null>;
  /** For convention findings: which rule. */
  rule?: string;
}

export interface Finding {
  kind: FindingKind;
  title: string;
  body: string;
  evidence: Evidence;
  service?: string;
  route?: string;
  path?: string;
  line?: number;
}
