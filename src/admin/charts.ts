/**
 * Admin charts: declarative dashboard charts plus small SVG helpers.
 *
 * `defineChart(spec)` validates a chart — a URL-safe `name`, a human `label`,
 * and a trusted `render` callback returning SVG markup (a string) for the
 * current admin session — and returns a frozen {@link Chart} descriptor. A panel
 * declares charts via `defineAdminPanel({ charts })`; the admin plugin renders
 * each as a dashboard card, injecting the trusted SVG markup raw (the chart
 * renderer owns all escaping/sanitizing of its own output).
 *
 * `lineChartSvg(points)` and `barChartSvg(points)` are convenience helpers that
 * build a small self-contained SVG from `ChartSeriesPoint`s, escaping every
 * label; they are the recommended building block for a chart `render` but are
 * not required — any string of SVG markup is accepted.
 *
 * The module is ORM-free: it imports only the session contract (a type) and
 * performs no I/O.
 */

import type { Session } from '../contracts/http.js';

/** Context handed to a chart's `render` callback. */
export interface ChartContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The panel base path (e.g. `/admin`). */
  readonly path: string;
}

/** A chart's trusted SVG renderer; returns markup for the current session. */
export type ChartRender = (context: ChartContext) => string | Promise<string>;

/** A frozen, validated chart descriptor consumed by {@link adminPlugin}. */
export interface Chart {
  /** Unique chart name within a panel. */
  readonly name: string;
  /** Human card label. */
  readonly label: string;
  /** Render the SVG markup for the current session. */
  readonly render: ChartRender;
}

/** Specification passed to {@link defineChart}. */
export interface ChartDefinition {
  /** Unique chart name within a panel. */
  readonly name: string;
  /** Human card label. */
  readonly label: string;
  /** Render the SVG markup. */
  readonly render: ChartRender;
}

/** Raised for invalid chart specs. Messages never embed input values. */
export class ChartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChartError';
  }
}

/** A single data point for the SVG helper charts. */
export interface ChartSeriesPoint {
  /** Category label rendered under the point/bar. */
  readonly label: string;
  /** Numeric value plotted against the series. */
  readonly value: number;
}

/** Validate a chart spec and return a frozen descriptor. */
export function defineChart(spec: ChartDefinition): Chart {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ChartError('defineChart requires a spec object');
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new ChartError('chart name must be a non-empty string');
  }
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw new ChartError('chart label must be a non-empty string');
  }
  if (typeof spec.render !== 'function') {
    throw new ChartError('chart must define a render function');
  }
  return Object.freeze({ name: spec.name, label: spec.label, render: spec.render });
}

// ---------------------------------------------------------------------------
// SVG helper charts
// ---------------------------------------------------------------------------

/** Fixed drawing canvas for the helper SVGs. */
const WIDTH = 400;
const HEIGHT = 200;
const PAD_LEFT = 40;
const PAD_BOTTOM = 24;
const PLOT_WIDTH = WIDTH - PAD_LEFT;
const PLOT_HEIGHT = HEIGHT - PAD_BOTTOM;

/** Escape a label for an XML text node/attribute. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** X coordinate for a series index (centered for a single point). */
function xFor(index: number, count: number): number {
  if (count <= 1) {
    return PAD_LEFT + PLOT_WIDTH / 2;
  }
  return PAD_LEFT + (index / (count - 1)) * PLOT_WIDTH;
}

/** Render category labels under the points/bars. */
function renderLabels(points: readonly ChartSeriesPoint[]): string {
  return points
    .map(
      (point, index) =>
        `<text x="${xFor(index, points.length).toFixed(1)}" y="${HEIGHT - 6}" ` +
        `text-anchor="middle" font-size="10">${escapeXml(point.label)}</text>`,
    )
    .join('');
}

/** Build a polyline chart over the points, normalized to the value range. */
export function lineChartSvg(points: readonly ChartSeriesPoint[]): string {
  const values = points.map((point) => point.value);
  const min = values.length === 0 ? 0 : Math.min(...values);
  const max = values.length === 0 ? 0 : Math.max(...values);
  const span = max - min || 1;
  const y = (value: number): number => HEIGHT - PAD_BOTTOM - ((value - min) / span) * PLOT_HEIGHT;
  const coords = points
    .map((point, index) => `${xFor(index, points.length).toFixed(1)},${y(point.value).toFixed(1)}`)
    .join(' ');
  return (
    `<svg class="admin-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
    `<polyline fill="none" stroke="currentColor" stroke-width="2" points="${coords}"/>` +
    renderLabels(points) +
    `</svg>`
  );
}

/** Build a bar chart over the points, positive-anchored at the bottom. */
export function barChartSvg(points: readonly ChartSeriesPoint[]): string {
  const max = Math.max(...points.map((point) => point.value), 1);
  const barWidth = PLOT_WIDTH / Math.max(points.length, 1);
  const bars = points
    .map((point, index) => {
      const height = (Math.max(point.value, 0) / max) * PLOT_HEIGHT;
      const x = PAD_LEFT + index * barWidth;
      const y = HEIGHT - PAD_BOTTOM - height;
      const width = Math.max(barWidth - 4, 0);
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
        `width="${width.toFixed(1)}" height="${height.toFixed(1)}" fill="currentColor"/>`
      );
    })
    .join('');
  return (
    `<svg class="admin-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
    bars +
    renderLabels(points) +
    `</svg>`
  );
}

/** Fixed HSL-based palette so each donut segment gets a distinct color. */
const DONUT_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
];

/**
 * Build a donut (ring) chart: one filled arc per point plus a legend.
 *
 * Arcs are centered in the left half of the canvas; escaped labels sit on the
 * right. Every label is escaped via {@link escapeXml} — raw values are never
 * injected.
 */
export function donutChartSvg(points: readonly ChartSeriesPoint[]): string {
  const total = points.reduce((sum, p) => sum + p.value, 0);
  if (total <= 0 || points.length === 0) {
    return `<svg class="admin-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}"></svg>`;
  }

  const cx = 120;
  const cy = 100;
  const outerR = 70;
  const innerR = 35;

  let currentAngle = -Math.PI / 2;
  const arcs: string[] = [];
  const legendItems: string[] = [];

  let i = 0;
  for (const point of points) {
    const sweepAngle = (point.value / total) * 2 * Math.PI;
    const startAngle = currentAngle;
    const endAngle = currentAngle + sweepAngle;

    const largeArc = sweepAngle > Math.PI ? 1 : 0;

    const outerStartX = cx + outerR * Math.cos(startAngle);
    const outerStartY = cy + outerR * Math.sin(startAngle);
    const outerEndX = cx + outerR * Math.cos(endAngle);
    const outerEndY = cy + outerR * Math.sin(endAngle);

    const innerStartX = cx + innerR * Math.cos(startAngle);
    const innerStartY = cy + innerR * Math.sin(startAngle);
    const innerEndX = cx + innerR * Math.cos(endAngle);
    const innerEndY = cy + innerR * Math.sin(endAngle);

    const color = DONUT_COLORS[i % DONUT_COLORS.length];

    arcs.push(
      `<path d="M ${outerStartX.toFixed(1)} ${outerStartY.toFixed(1)} ` +
        `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEndX.toFixed(1)} ${outerEndY.toFixed(1)} ` +
        `L ${innerEndX.toFixed(1)} ${innerEndY.toFixed(1)} ` +
        `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStartX.toFixed(1)} ${innerStartY.toFixed(1)} ` +
        `Z" fill="${color}"/>`,
    );

    const legendY = 40 + i * 22;
    legendItems.push(
      `<rect x="210" y="${legendY - 8}" width="12" height="12" fill="${color}"/>` +
        `<text x="228" y="${legendY + 2}" font-size="11">${escapeXml(point.label)}</text>`,
    );

    currentAngle = endAngle;
    i++;
  }

  return (
    `<svg class="admin-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
    arcs.join('') +
    legendItems.join('') +
    `</svg>`
  );
}

/**
 * Build an area chart: a filled polygon under the series line plus labels.
 *
 * Reuses the same coordinate math as {@link lineChartSvg}: the polygon connects
 * every series coordinate, then the bottom-right and bottom-left corners of the
 * plot area to close the fill. A polyline is drawn on top for the series edge.
 * Every label is escaped via {@link escapeXml}.
 */
export function areaChartSvg(points: readonly ChartSeriesPoint[]): string {
  const values = points.map((point) => point.value);
  const min = values.length === 0 ? 0 : Math.min(...values);
  const max = values.length === 0 ? 0 : Math.max(...values);
  const span = max - min || 1;
  const y = (value: number): number => HEIGHT - PAD_BOTTOM - ((value - min) / span) * PLOT_HEIGHT;

  const baselineY = HEIGHT - PAD_BOTTOM;
  const lineCoords = points
    .map((point, index) => `${xFor(index, points.length).toFixed(1)},${y(point.value).toFixed(1)}`)
    .join(' ');

  const firstX = xFor(0, points.length).toFixed(1);
  const lastX = xFor(points.length - 1, points.length).toFixed(1);
  const polygonPoints = `${lineCoords} ${lastX},${baselineY.toFixed(1)} ${firstX},${baselineY.toFixed(1)}`;

  return (
    `<svg class="admin-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
    `<polygon fill="currentColor" fill-opacity="0.2" points="${polygonPoints}"/>` +
    `<polyline fill="none" stroke="currentColor" stroke-width="2" points="${lineCoords}"/>` +
    renderLabels(points) +
    `</svg>`
  );
}
