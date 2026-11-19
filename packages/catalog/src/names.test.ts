import { describe, expect, it } from 'vitest';
import {
  HTTP_SERVER_DURATION,
  describeStoredSeries,
  storedLabelName,
  storedMetricName,
  storedSeriesNames,
  unitFromStoredName,
} from './names.js';

describe('stored names', () => {
  // Observed in the metrics store on 2026-11-18; see docs/decisions.md.
  it('match what the store actually holds for the demo service', () => {
    expect(storedMetricName('http.server.request.duration', 'histogram', 's')).toBe(
      'http_server_request_duration_seconds',
    );
    expect(storedSeriesNames(HTTP_SERVER_DURATION, 'histogram')).toEqual([
      'http_server_request_duration_seconds_bucket',
      'http_server_request_duration_seconds_sum',
      'http_server_request_duration_seconds_count',
    ]);
    expect(storedMetricName('orders.completed', 'counter', '{order}')).toBe(
      'orders_completed_total',
    );
    expect(storedLabelName('http.response.status_code')).toBe('http_response_status_code');
    expect(storedLabelName('payment.method')).toBe('payment_method');
  });

  it.each([
    ['queue.depth', 'gauge', '{job}', 'queue_depth'],
    ['cache.hit.ratio', 'gauge', '1', 'cache_hit_ratio'],
    ['upload.size', 'histogram', 'By', 'upload_size_bytes'],
    ['jobs.run.duration', 'histogram', 's', 'jobs_run_duration_seconds'],
    ['requests.total', 'counter', '', 'requests_total'],
    ['process.uptime.seconds', 'gauge', 's', 'process_uptime_seconds'],
    ['disk.io', 'counter', 'By/s', 'disk_io_bytes_per_second_total'],
  ] as const)('%s (%s, %s) is stored as %s', (name, type, unit, expected) => {
    expect(storedMetricName(name, type, unit)).toBe(expected);
  });

  it('reads a stored series name back', () => {
    expect(describeStoredSeries('jobs_run_duration_seconds_bucket')).toEqual({
      storedName: 'jobs_run_duration_seconds',
      type: 'histogram',
      part: 'bucket',
    });
    expect(describeStoredSeries('orders_completed_total')).toMatchObject({
      storedName: 'orders_completed_total',
      type: 'counter',
    });
    expect(describeStoredSeries('queue_depth')).toMatchObject({ type: 'gauge' });
    expect(unitFromStoredName('jobs_run_duration_seconds')).toBe('s');
    expect(unitFromStoredName('upload_size_bytes')).toBe('By');
    expect(unitFromStoredName('orders_completed_total')).toBe('');
  });
});
