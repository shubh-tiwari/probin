// Glowing line charts in the site's style, drawn as SVG from real series.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, parent) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    parent.appendChild(node);
    return node;
  };
  // A smooth curve through the points (Catmull-Rom as cubic Béziers).
  const smooth = (points) => {
    let d = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      d += ` C ${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6}, ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  };
  const paints = (svg, id) => {
    const defs = el('defs', {}, svg);
    const line = el('linearGradient', { id: `${id}-line`, x1: 0, x2: 1 }, defs);
    el('stop', { offset: 0, 'stop-color': '#4f8cff' }, line);
    el('stop', { offset: 1, 'stop-color': '#a855f7' }, line);
    const area = el('linearGradient', { id: `${id}-area`, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
    el('stop', { offset: 0, 'stop-color': '#7c6bff', 'stop-opacity': 0.45 }, area);
    el('stop', { offset: 1, 'stop-color': '#4f7dff', 'stop-opacity': 0 }, area);
    const glow = el(
      'filter',
      { id: `${id}-glow`, x: '-5%', y: '-30%', width: '110%', height: '160%' },
      defs,
    );
    el('feGaussianBlur', { stdDeviation: 4, result: 'b' }, glow);
    const merge = el('feMerge', {}, glow);
    el('feMergeNode', { in: 'b' }, merge);
    el('feMergeNode', { in: 'SourceGraphic' }, merge);
  };

  /** The big chart: axes in ms and minutes ago, the peak marked with its value. */
  window.drawChart = (svg, data, size = { w: 900, h: 300 }) => {
    const L = 64,
      R = size.w - 20,
      T = 24,
      B = size.h - 40,
      max = 1500;
    const x = (i) => L + (i / (data.length - 1)) * (R - L);
    const y = (v) => B - (v / max) * (B - T);
    paints(svg, 'c');
    for (const v of [0, 500, 1000, 1500]) {
      el('line', { x1: L, x2: R, y1: y(v), y2: y(v), stroke: 'rgba(150,160,255,0.12)' }, svg);
      el('text', { x: L - 12, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent =
        v === 0 ? '0 ms' : v >= 1000 ? `${v / 1000} s` : `${v} ms`;
    }
    for (const minutes of [60, 45, 30, 15, 0]) {
      const i = data.length - 1 - minutes * 2;
      el(
        'text',
        { x: x(i), y: B + 26, 'text-anchor': minutes === 0 ? 'end' : 'middle' },
        svg,
      ).textContent = minutes === 0 ? 'now' : `${minutes} min ago`;
    }
    const path = smooth(data.map((v, i) => [x(i), y(v)]));
    el('path', { d: `${path} L ${R} ${B} L ${L} ${B} Z`, fill: 'url(#c-area)' }, svg);
    el(
      'path',
      {
        d: path,
        fill: 'none',
        stroke: 'url(#c-line)',
        'stroke-width': 3.2,
        filter: 'url(#c-glow)',
      },
      svg,
    );
    const peak = data.indexOf(Math.max(...data));
    el(
      'line',
      {
        x1: x(peak),
        x2: x(peak),
        y1: y(data[peak]),
        y2: B,
        stroke: 'rgba(200,190,255,0.5)',
        'stroke-dasharray': '3 4',
      },
      svg,
    );
    el(
      'circle',
      { cx: x(peak), cy: y(data[peak]), r: 6, fill: '#fff', stroke: '#8b5cf6', 'stroke-width': 3 },
      svg,
    );
    const tip = el('g', { transform: `translate(${x(peak) - 92}, ${y(data[peak]) - 22})` }, svg);
    el(
      'rect',
      {
        width: 78,
        height: 44,
        rx: 10,
        fill: 'rgba(14,18,48,0.95)',
        stroke: 'rgba(150,160,255,0.35)',
      },
      tip,
    );
    el(
      'text',
      { x: 39, y: 20, 'text-anchor': 'middle', style: 'fill:#fff;font-weight:600;font-size:15px' },
      tip,
    ).textContent = `${(data[peak] / 1000).toFixed(2)} s`;
    el(
      'text',
      { x: 39, y: 36, 'text-anchor': 'middle', style: 'font-size:12px' },
      tip,
    ).textContent = `${Math.round((data.length - 1 - peak) / 2)} min ago`;
  };

  /** A small chart with a dashed threshold line. */
  window.drawSpark = (svg, data, threshold) => {
    paints(svg, 's');
    const x = (i) => (i / (data.length - 1)) * 400;
    const y = (v) => 66 - ((v - 400) / 1100) * 60;
    const path = smooth(data.map((v, i) => [x(i), y(v)]));
    el(
      'line',
      {
        x1: 0,
        x2: 400,
        y1: y(threshold),
        y2: y(threshold),
        stroke: '#f5b544',
        'stroke-dasharray': '4 4',
        opacity: 0.7,
      },
      svg,
    );
    el('path', { d: `${path} L 400 70 L 0 70 Z`, fill: 'url(#s-area)' }, svg);
    el('path', { d: path, fill: 'none', stroke: 'url(#s-line)', 'stroke-width': 2.4 }, svg);
  };
})();
