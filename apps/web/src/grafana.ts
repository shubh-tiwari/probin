import type { DashboardSpec, PanelSpec } from '@app/specs';

/**
 * W12: a one-time export of a dashboard to Grafana's dashboard JSON. Nothing
 * stays in sync. The panels read from a Prometheus data source chosen on
 * import; our read-only Prometheus API (`/api/prom`, with an API token) works
 * as that data source.
 */
const UNITS: Record<string, string> = {
  s: 's',
  ms: 'ms',
  '1': 'percentunit',
  By: 'bytes',
  'req/s': 'reqps',
};

export function toGrafana(
  dashboard: { title: string; spec: DashboardSpec },
  panels: { id: string; spec: PanelSpec }[],
) {
  const datasource = { type: 'prometheus', uid: '${DS_PROMETHEUS}' };
  return {
    __inputs: [
      {
        name: 'DS_PROMETHEUS',
        label: 'Prometheus',
        type: 'datasource',
        pluginId: 'prometheus',
        pluginName: 'Prometheus',
      },
    ],
    title: dashboard.title,
    schemaVersion: 39,
    time: { from: `now-${dashboard.spec.default_range}`, to: 'now' },
    refresh: '30s',
    tags: ['exported'],
    panels: panels.map((panel, index) => {
      const place = dashboard.spec.layout.find((item) => item.panel_id === panel.id);
      const unit = UNITS[panel.spec.unit] ?? 'short';
      return {
        id: index + 1,
        title: panel.spec.title,
        description: `Asked for: ${panel.spec.request}${panel.spec.assumptions.length ? `\nAssumed: ${panel.spec.assumptions.join(' · ')}` : ''}`,
        type:
          panel.spec.type === 'bar'
            ? 'barchart'
            : panel.spec.type === 'stat'
              ? 'stat'
              : 'timeseries',
        datasource,
        gridPos: {
          x: (place?.x ?? 0) * 2,
          y: (place?.y ?? index * 4) * 2,
          w: (place?.w ?? 6) * 2,
          h: (place?.h ?? 4) * 2,
        },
        fieldConfig: { defaults: { unit }, overrides: [] },
        targets: [
          {
            refId: 'A',
            datasource,
            expr: panel.spec.query,
            range: panel.spec.type !== 'stat',
            instant: panel.spec.type === 'stat',
          },
        ],
        ...(panel.spec.range ? { timeFrom: panel.spec.range } : {}),
      };
    }),
  };
}
