import { Resvg } from '@resvg/resvg-js';

/**
 * Turn an SVG into a PNG, on the server. Used for the Slack images, which
 * are snapshots and do not refresh. Needs a sans-serif font on the system;
 * the services image installs DejaVu Sans.
 */
export function svgToPng(svg: string, scale = 2): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: scale },
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
  });
  return Buffer.from(resvg.render().asPng());
}
