/**
 * Tests for the read-only jobs dashboard admin page.
 *
 * `defineJobsDashboardPage(source)` / `jobsDashboard(source)` render a frozen
 * admin page over an injected {@link JobsDashboardSource}: per-job metrics from
 * `JobMetrics.snapshot()`, recent failures from `FailedJobStore.list()`, and
 * optional live queue counts from `readCounts`. The tests drive the real render
 * path (Preact to string) and assert:
 *
 * - per-job completed/failed counts, average duration, and last error appear in
 *   the metrics table, and `snapshot()` is read once (counters reset);
 * - the failed store renders newest-first and escapes error text;
 * - an absent (or throwing) `readCounts` renders `unavailable` rather than zeros;
 * - the source validator rejects malformed sources value-free, and `jobsPlugin`
 *   reuses it so a miswired `dashboard` fails at construction;
 * - `jobsDashboard` contributes exactly one read-only page (no `handlePost`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import type { Session } from '../../src/contracts/http.js';
import { InMemoryFailedJobStore } from '../../src/jobs/failed.js';
import { InMemoryJobMetrics, type JobMetrics } from '../../src/jobs/metrics.js';
import type { QueueCounts } from '../../src/jobs/runtime.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import { jobsPlugin } from '../../src/jobs/plugin.js';
import { defineJobsDashboardPage, jobsDashboard } from '../../src/jobs/dashboard.js';
import {
  validateJobsDashboardSource,
  JobsDashboardError,
  type JobsDashboardSource,
} from '../../src/jobs/dashboard-source.js';
import type { AdminPage } from '../../src/admin/page.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: {},
  expiresAt: 2_000_000_000_000,
};

function renderContext() {
  return {
    session: SESSION,
    path: '/admin',
    request: new Request('http://localhost/admin/jobs'),
    url: new URL('http://localhost/admin/jobs'),
  };
}

/** A dashboard source over counters/failures plus an optional queue reader. */
function buildSource(options?: { counts?: QueueCounts }): {
  source: JobsDashboardSource;
  metrics: InMemoryJobMetrics;
  failed: InMemoryFailedJobStore;
} {
  const metrics = new InMemoryJobMetrics();
  const failed = new InMemoryFailedJobStore();
  const counts = options?.counts;
  const readCounts = counts === undefined ? undefined : async (): Promise<QueueCounts> => counts;
  return {
    source: { metrics, failed, ...(readCounts === undefined ? {} : { readCounts }) },
    metrics,
    failed,
  };
}

/** A `JobMetrics` whose `snapshot()` throws, to exercise the fail-closed path. */
function metricsThatThrow(): JobMetrics {
  return {
    recordCompleted() {},
    recordFailed() {},
    recordWait() {},
    snapshot() {
      throw new Error('boom');
    },
    reset() {},
  };
}

describe('defineJobsDashboardPage', () => {
  it('renders per-job metric counts and the reset note from a single snapshot read', async () => {
    const { source, metrics } = buildSource();
    metrics.recordCompleted('sendEmail', 150);
    metrics.recordCompleted('sendEmail', 250);
    metrics.recordFailed('sendEmail', new Error('smtp down'));
    metrics.recordCompleted('generateReport', 900);

    const page = defineJobsDashboardPage(source);
    const html = await page.render(renderContext());

    assert.match(html, /Job metrics/);
    assert.match(html, />sendEmail</);
    assert.match(html, />generateReport</);
    // completed/failed counts and the average duration (150+250)/2 = 200.
    assert.match(html, /Counters reset on each read\./);
    assert.match(html, /smtp down/);
    assert.match(html, />200</);

    // snapshot() cleared the counters: a second render sees nothing recorded.
    const again = await page.render(renderContext());
    assert.match(again, /No jobs recorded since the last reset\./);
  });

  it('renders recent failures newest-first and escapes error text', async () => {
    const { source, failed } = buildSource();
    failed.add({
      id: 'older',
      name: 'sendEmail',
      error: '<script>alert(1)</script>',
      failedAt: new Date('2026-01-01T00:00:00.000Z'),
      attempts: 1,
      tags: ['mail'],
    });
    failed.add({
      id: 'newer',
      name: 'generateReport',
      error: 'disk full',
      failedAt: new Date('2026-01-02T00:00:00.000Z'),
      attempts: 3,
    });

    const html = await defineJobsDashboardPage(source).render(renderContext());

    assert.match(html, /Recent failed jobs/);
    // Newest first: generateReport before sendEmail.
    assert.ok(
      html.indexOf('>generateReport<') < html.indexOf('>sendEmail<'),
      'newest failure renders first',
    );
    // Error text is value-free and escaped by Preact's text rendering.
    assert.match(html, /disk full/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script>alert\(1\)&lt;\/script>/);
    // Tags render as admin-tag chips.
    assert.match(html, /admin-tag/);
    assert.match(html, />mail</);
  });

  it('renders queue counts when a reader is injected, unavailable otherwise', async () => {
    const withCounts = buildSource({
      counts: { waiting: 2, active: 1, completed: 10, failed: 3, delayed: 5 },
    });
    const html = await defineJobsDashboardPage(withCounts.source).render(renderContext());
    assert.match(html, />Queue</);
    assert.match(html, />Waiting</);
    assert.match(html, />2</);
    assert.match(html, />Delayed</);
    assert.match(html, />5</);

    const withoutCounts = buildSource();
    const noCountsHtml = await defineJobsDashboardPage(withoutCounts.source).render(
      renderContext(),
    );
    assert.match(noCountsHtml, /Queue counts are unavailable/);
  });

  it('fails closed to an unavailable note when a read throws', async () => {
    const { source } = buildSource();
    // A metrics collector whose snapshot() throws: the section degrades, never 500s.
    const throwing = defineJobsDashboardPage({
      metrics: metricsThatThrow(),
      failed: source.failed,
    });
    const html = await throwing.render(renderContext());
    assert.match(html, /Job metrics are unavailable\./);

    // A throwing readCounts reader degrades the queue section.
    const throwingCounts = defineJobsDashboardPage({
      metrics: source.metrics,
      failed: source.failed,
      readCounts: async () => {
        throw new Error('boom');
      },
    });
    const countsHtml = await throwingCounts.render(renderContext());
    assert.match(countsHtml, /Queue counts are unavailable/);
  });

  it('declares no handlePost, so the page is read-only', () => {
    const page = defineJobsDashboardPage(buildSource().source);
    assert.equal(page.slug, 'jobs');
    assert.equal(page.label, 'Jobs');
    assert.equal(page.handlePost, undefined);
  });
});

describe('jobsDashboard', () => {
  it('contributes exactly one jobs page through the admin plugin builder', () => {
    const pages: AdminPage[] = [];
    jobsDashboard(buildSource().source).register({
      addPage(page) {
        pages.push(page);
      },
      addNavigationItem() {},
      addResource() {},
    });
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.slug, 'jobs');
    assert.equal(pages[0]!.handlePost, undefined);
  });
});

describe('validateJobsDashboardSource', () => {
  it('accepts a valid source (metrics + failed, readCounts optional)', () => {
    const { source } = buildSource();
    validateJobsDashboardSource(source);
    validateJobsDashboardSource({
      ...source,
      readCounts: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    });
  });

  it('rejects malformed sources value-free', () => {
    const { source } = buildSource();
    assert.throws(() => validateJobsDashboardSource(null), JobsDashboardError);
    assert.throws(() => validateJobsDashboardSource([]), JobsDashboardError);
    assert.throws(() => validateJobsDashboardSource({}), JobsDashboardError);
    assert.throws(
      () => validateJobsDashboardSource({ metrics: {}, failed: source.failed }),
      JobsDashboardError,
    );
    assert.throws(
      () => validateJobsDashboardSource({ metrics: source.metrics, failed: {} }),
      JobsDashboardError,
    );
    assert.throws(
      () => validateJobsDashboardSource({ ...source, readCounts: 'nope' }),
      JobsDashboardError,
    );
  });
});

describe('jobsPlugin dashboard option', () => {
  const registry = createJobRegistry({
    sendEmail: defineJob(z.object({ to: z.string() }), async () => undefined),
  });

  it('accepts a valid dashboard source and rejects a malformed one at construction', () => {
    const { source } = buildSource();
    // Valid: constructs without throwing.
    assert.ok(jobsPlugin({ registry, dashboard: source }));

    assert.throws(() => jobsPlugin({ registry, dashboard: null } as never), JobsDashboardError);
    assert.throws(
      () => jobsPlugin({ registry, dashboard: { metrics: {}, failed: {} } } as never),
      JobsDashboardError,
    );
  });
});
