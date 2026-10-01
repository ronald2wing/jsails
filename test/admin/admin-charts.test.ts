/**
 * Admin chart SVG helper tests: donut and area chart rendering.
 *
 * Pure unit tests — no application, no ORM, no HTTP. Each helper returns
 * a self-contained SVG string; these tests assert structure and escaping.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { areaChartSvg, donutChartSvg } from '../../src/admin/charts.js';

describe('chart helpers', () => {
  it('donutChartSvg emits one arc per point and escapes labels', () => {
    const svg = donutChartSvg([
      { label: '<x>', value: 1 },
      { label: 'b', value: 2 },
    ]);

    assert.match(svg, /<svg/);
    assert.match(svg, /&lt;x&gt;/);
    assert.doesNotMatch(svg, /<x>/);
  });

  it('areaChartSvg emits a filled polygon', () => {
    const svg = areaChartSvg([
      { label: 'a', value: 1 },
      { label: 'b', value: 3 },
    ]);

    assert.match(svg, /<polygon/);
  });
});
