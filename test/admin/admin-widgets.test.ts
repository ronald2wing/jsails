/**
 * Admin widgets + notices tests: dashboard stat cards and flash messages.
 *
 * These drive the real admin plugin over an in-process `Application`. The
 * dashboard renders each declared widget's trusted `render` value (escaped)
 * inside a stat card, and the `?_notice=<code>` query maps through the notice
 * registry to an escaped message — an unknown code is dropped, and a hostile
 * widget value or message never reaches the document raw.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WidgetError,
  defineWidget,
  defineListWidget,
  defineProgressWidget,
  type AdminWidgetContext,
  type Widget,
} from '../../src/admin/widgets.js';
import { NoticeError, defineNotice, type Notice } from '../../src/admin/notices.js';
import { AdminPanelError, adminPlugin, defineAdminPanel } from '../../src/admin/index.js';
import type { Session } from '../../src/contracts/http.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

interface PanelFixture {
  readonly widgets?: readonly Widget[];
  readonly notices?: readonly Notice[];
}

function makeApp(fixture: PanelFixture = {}): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: () => true,
            ...(fixture.widgets === undefined ? {} : { widgets: fixture.widgets }),
            ...(fixture.notices === undefined ? {} : { notices: fixture.notices }),
          }),
        ),
      ],
    },
  });
}

describe('admin widget descriptor validation', () => {
  it('rejects an empty name, empty label, or missing render', () => {
    assert.throws(() => defineWidget({ name: ' ', label: 'x', render: () => 1 }), WidgetError);
    assert.throws(() => defineWidget({ name: 'x', label: ' ', render: () => 1 }), WidgetError);
    assert.throws(
      () =>
        defineWidget({
          name: 'x',
          label: 'x',
          // @ts-expect-error — a missing `render` must be rejected at runtime.
          render: undefined,
        }),
      WidgetError,
    );
  });

  it('freezes a valid descriptor', () => {
    const widget = defineWidget({ name: 'count', label: 'Count', render: () => 1 });
    assert.equal(Object.isFrozen(widget), true);
  });
});

describe('admin dashboard widgets', () => {
  it('renders each widget label and its escaped value', async () => {
    const app = await makeApp({
      widgets: [
        defineWidget({ name: 'count', label: 'Articles', render: () => 42 }),
        defineWidget({ name: 'recent', label: 'Recent', render: () => 'First post' }),
      ],
    });

    const body = await (await app.request('/admin')).text();
    assert.match(body, /admin-widget/);
    assert.match(body, /Articles/);
    assert.match(body, />42</);
    assert.match(body, /Recent/);
    assert.match(body, /First post/);

    await app.close();
  });

  it('escapes a hostile widget value instead of emitting it raw', async () => {
    const app = await makeApp({
      widgets: [
        defineWidget({ name: 'evil', label: 'Evil', render: () => '<script>alert(1)</script>' }),
      ],
    });

    const body = await (await app.request('/admin')).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);

    await app.close();
  });

  it('renders an empty value when a widget render throws, without failing the page', async () => {
    const app = await makeApp({
      widgets: [
        defineWidget({
          name: 'broken',
          label: 'Broken',
          render: () => {
            throw new Error('boom');
          },
        }),
        defineWidget({ name: 'fine', label: 'Fine', render: () => 'ok' }),
      ],
    });

    const response = await app.request('/admin');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Fine/);
    assert.match(body, />ok</);

    await app.close();
  });

  it('passes the session and panel path to the render callback', async () => {
    const seen: AdminWidgetContext[] = [];
    const app = await makeApp({
      widgets: [
        defineWidget({
          name: 'ctx',
          label: 'Context',
          render: (context) => {
            seen.push(context);
            return context.path;
          },
        }),
      ],
    });

    await (await app.request('/admin')).text();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.session.id, SESSION.id);
    assert.equal(seen[0]!.path, '/admin');

    await app.close();
  });

  it('rejects a non-array widgets value and duplicate widget names', () => {
    assert.throws(
      () => makeApp({ widgets: 'nope' as unknown as readonly Widget[] }),
      AdminPanelError,
    );
    const widgets = [
      defineWidget({ name: 'dup', label: 'A', render: () => 1 }),
      defineWidget({ name: 'dup', label: 'B', render: () => 2 }),
    ];
    assert.throws(() => makeApp({ widgets }), AdminPanelError);
  });
});

describe('admin notice descriptor validation', () => {
  it('rejects an invalid code, level, or empty message', () => {
    assert.throws(() => defineNotice('bad/code', { level: 'success', message: 'x' }), NoticeError);
    assert.throws(() => defineNotice('ok', { level: 'bogus' as never, message: 'x' }), NoticeError);
    assert.throws(() => defineNotice('ok', { level: 'success', message: '  ' }), NoticeError);
  });

  it('freezes a valid descriptor', () => {
    const notice = defineNotice('saved', { level: 'success', message: 'Saved.' });
    assert.equal(Object.isFrozen(notice), true);
    assert.equal(notice.code, 'saved');
    assert.equal(notice.level, 'success');
  });
});

describe('admin notice rendering', () => {
  it('maps a registered notice code to its message on the dashboard', async () => {
    const app = await makeApp({
      notices: [
        defineNotice('saved', { level: 'success', message: 'Record saved.' }),
        defineNotice('deleted', { level: 'warning', message: 'Record deleted.' }),
      ],
    });

    const saved = await (await app.request('/admin?_notice=saved')).text();
    assert.match(saved, /admin-notice/);
    assert.match(saved, /Record saved\./);
    assert.match(saved, /role="status"/);

    await app.close();
  });

  it('drops an unknown notice code without rendering a message', async () => {
    const app = await makeApp({
      notices: [defineNotice('saved', { level: 'success', message: 'Record saved.' })],
    });

    const body = await (await app.request('/admin?_notice=forged')).text();
    assert.doesNotMatch(body, /admin-notice/);

    await app.close();
  });

  it('escapes a hostile notice message', async () => {
    const app = await makeApp({
      notices: [defineNotice('x', { level: 'info', message: '<b>bold</b>' })],
    });

    const body = await (await app.request('/admin?_notice=x')).text();
    assert.doesNotMatch(body, /<b>bold<\/b>/);
    assert.match(body, /&lt;b>bold&lt;\/b>/);

    await app.close();
  });

  it('rejects a non-array notices value and duplicate notice codes', () => {
    assert.throws(
      () => makeApp({ notices: 'nope' as unknown as readonly Notice[] }),
      AdminPanelError,
    );
    const notices = [
      defineNotice('dup', { level: 'success', message: 'A' }),
      defineNotice('dup', { level: 'info', message: 'B' }),
    ];
    assert.throws(() => makeApp({ notices }), AdminPanelError);
  });
});

describe('widget kinds', () => {
  it('defineProgressWidget renders a bounded percentage', async () => {
    const w = defineProgressWidget({ name: 'p', label: 'P', value: () => 5, max: 10 });
    assert.equal(await w.render({ session: SESSION, path: '/admin' }), '50%');
  });

  it('defineListWidget renders a joined list', async () => {
    const w = defineListWidget({ name: 'l', label: 'L', items: () => ['a', 'b'] });
    assert.equal(await w.render({ session: SESSION, path: '/admin' }), 'a, b');
  });

  it('rejects a progress widget with a non-positive max', () => {
    assert.throws(
      () => defineProgressWidget({ name: 'p', label: 'P', value: () => 1, max: 0 }),
      WidgetError,
    );
  });
});
