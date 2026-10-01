/**
 * Jobs dashboard: a read-only admin page over worker-owned job observability.
 *
 * `defineJobsDashboardPage(source)` builds a validated {@link AdminPage}
 * descriptor (slug `jobs`, label `Jobs`) whose `render` reads the injected
 * {@link JobsDashboardSource} and renders three sections:
 *
 * - **Job metrics** — per-job `completed`/`failed` counts, average duration,
 *   average and maximum wait, and the most recent error message, read from
 *   `JobMetrics.snapshot()`. `snapshot()` clears the counters, so the page shows
 *   counts accumulated since the previous read; that reset semantics is surfaced
 *   in the rendered note.
 * - **Recent failed jobs** — the newest-to-oldest entries from
 *   `FailedJobStore.list()` (the store is already bounded by its own `maxEntries`,
 *   so `list()` needs no further limit).
 * - **Queue counts** — the waiting/active/completed/failed/delayed totals from
 *   the optional `readCounts` reader (the runtime's transport capability). When
 *   the source has no `readCounts`, the section renders `unavailable` rather than
 *   inventing zeros.
 *
 * `jobsDashboard(source)` wraps that page in an {@link AdminPlugin} (id
 * `jobs-dashboard`) so it composes into `defineAdminPanel({ adminPlugins })`
 * exactly like the first-party plugin manager. The page is read-only: it declares
 * no `handlePost`, so the admin panel rejects `POST` with a 405 and, as a normal
 * admin page, the panel's existing default-deny authorization, same-origin, and
 * CSRF gates already apply — this module re-adds none of them.
 *
 * Fail-closed by construction: `metrics` and `failed` are required by the source
 * contract (`validateJobsDashboardSource`), and a throwing read (metrics/stores/
 * counts) degrades to an explicit `unavailable` note instead of a 500. The page
 * shows only what the application passed in.
 */

import { h, type ComponentChild } from 'preact';

import { defineAdminPlugin, type AdminPlugin } from '../admin/admin-plugin.js';
import { renderAdminDocumentWithTheme } from '../admin/document.js';
import { defineAdminPage, type AdminPage, type AdminPageRenderContext } from '../admin/page.js';
import { validateJobsDashboardSource, type JobsDashboardSource } from './dashboard-source.js';
import type { FailedJobEntry } from './failed.js';
import type { JobMetricsSnapshot } from './metrics.js';
import type { QueueCounts } from './runtime.js';

/** The admin page slug and label for the jobs dashboard. */
const PAGE_SLUG = 'jobs';
const PAGE_LABEL = 'Jobs';

/** Build a read-only jobs dashboard {@link AdminPage} over an injected source. */
export function defineJobsDashboardPage(source: JobsDashboardSource): AdminPage {
  validateJobsDashboardSource(source);
  return defineAdminPage({
    slug: PAGE_SLUG,
    label: PAGE_LABEL,
    render: (context) => renderJobsDashboard(context, source),
  });
}

/** Build a jobs dashboard {@link AdminPlugin} contributing the read-only page. */
export function jobsDashboard(source: JobsDashboardSource): AdminPlugin {
  return defineAdminPlugin({
    id: 'jobs-dashboard',
    register(builder) {
      builder.addPage(defineJobsDashboardPage(source));
    },
  });
}

/**
 * Render the full dashboard document. Every section is read once and rendered
 * from the returned value — `metricSnapshot()` is called a single time because
 * `snapshot()` clears the counters, and the failed store's `list()` is sliced
 * newest-first for display only.
 */
async function renderJobsDashboard(
  context: AdminPageRenderContext,
  source: JobsDashboardSource,
): Promise<string> {
  const body: ComponentChild[] = [
    h('h1', null, PAGE_LABEL),
    renderMetricsSection(readSnapshot(source)),
    renderQueueSection(await readQueueCounts(source)),
    renderFailedSection(readFailed(source)),
    h('a', { href: context.path }, 'Back to dashboard'),
  ];

  return renderAdminDocumentWithTheme(
    {
      title: PAGE_LABEL,
      theme: context.theme,
      themeCustomization: context.themeCustomization,
    },
    ...body,
  );
}

// ---------------------------------------------------------------------------
// Read helpers (fail-closed: a throwing read yields `undefined` → unavailable)
// ---------------------------------------------------------------------------

/**
 * Read a metrics snapshot once. `snapshot()` resets the counters, so this must be
 * called a single time per render; the result is frozen and safe to iterate.
 */
function readSnapshot(
  source: JobsDashboardSource,
): Readonly<Record<string, JobMetricsSnapshot>> | undefined {
  try {
    return source.metrics.snapshot();
  } catch {
    return undefined;
  }
}

/** Read the recent failures, newest first. The store is already size-bounded. */
function readFailed(source: JobsDashboardSource): readonly FailedJobEntry[] | undefined {
  try {
    return [...source.failed.list()].reverse();
  } catch {
    return undefined;
  }
}

/** Resolve the queue-counts section result: absent reader or a throw ⇒ unavailable. */
async function readQueueCounts(source: JobsDashboardSource): Promise<QueueCounts | undefined> {
  if (source.readCounts === undefined) {
    return undefined;
  }
  try {
    return await source.readCounts();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

/** The per-job metrics table, or an explicit empty/unavailable note. */
function renderMetricsSection(
  snapshot: Readonly<Record<string, JobMetricsSnapshot>> | undefined,
): ComponentChild {
  const heading = h('h2', null, 'Job metrics');
  if (snapshot === undefined) {
    return h('section', null, heading, h('p', null, 'Job metrics are unavailable.'));
  }
  const rows = Object.entries(snapshot);
  if (rows.length === 0) {
    return h('section', null, heading, h('p', null, 'No jobs recorded since the last reset.'));
  }
  rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return h(
    'section',
    null,
    heading,
    h(
      'table',
      null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Job'),
          h('th', null, 'Completed'),
          h('th', null, 'Failed'),
          h('th', null, 'Avg duration (ms)'),
          h('th', null, 'Avg wait (ms)'),
          h('th', null, 'Max wait (ms)'),
          h('th', null, 'Last error'),
        ),
      ),
      h(
        'tbody',
        null,
        ...rows.map(([name, entry]) =>
          h(
            'tr',
            null,
            h('td', null, name),
            h('td', null, String(entry.completed)),
            h('td', null, String(entry.failed)),
            h('td', null, String(entry.avgDurationMs)),
            h('td', null, String(entry.avgWaitMs)),
            h('td', null, String(entry.maxWaitMs)),
            h('td', null, entry.lastError ?? ''),
          ),
        ),
      ),
    ),
    h('p', null, 'Counters reset on each read.'),
  );
}

/** The live queue totals, or an explicit unavailable note. */
function renderQueueSection(counts: QueueCounts | undefined): ComponentChild {
  const heading = h('h2', null, 'Queue');
  if (counts === undefined) {
    return h(
      'section',
      null,
      heading,
      h('p', null, 'Queue counts are unavailable (no queue count provider).'),
    );
  }
  const cells: Array<readonly [string, number]> = [
    ['Waiting', counts.waiting],
    ['Active', counts.active],
    ['Completed', counts.completed],
    ['Failed', counts.failed],
    ['Delayed', counts.delayed],
  ];
  return h(
    'section',
    null,
    heading,
    h(
      'dl',
      null,
      ...cells.flatMap(([label, value]) => [h('dt', null, label), h('dd', null, String(value))]),
    ),
  );
}

/** The recent failures table, newest first, or an explicit empty/unavailable note. */
function renderFailedSection(entries: readonly FailedJobEntry[] | undefined): ComponentChild {
  const heading = h('h2', null, 'Recent failed jobs');
  if (entries === undefined) {
    return h('section', null, heading, h('p', null, 'Recent failures are unavailable.'));
  }
  if (entries.length === 0) {
    return h('section', null, heading, h('p', null, 'No recent failures.'));
  }
  return h(
    'section',
    null,
    heading,
    h(
      'table',
      null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Failed at'),
          h('th', null, 'Job'),
          h('th', null, 'Attempts'),
          h('th', null, 'Error'),
          h('th', null, 'Tags'),
        ),
      ),
      h(
        'tbody',
        null,
        ...entries.map((entry) =>
          h(
            'tr',
            null,
            h('td', { class: 'admin-date' }, entry.failedAt.toISOString()),
            h('td', null, entry.name),
            h('td', null, String(entry.attempts)),
            h('td', null, entry.error),
            h(
              'td',
              null,
              ...(entry.tags ?? []).map((tag) => h('span', { class: 'admin-tag' }, tag)),
            ),
          ),
        ),
      ),
    ),
  );
}
