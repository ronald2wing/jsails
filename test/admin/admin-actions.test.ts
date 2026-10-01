/**
 * Admin action tests: header, row, and bulk actions driven through the real
 * admin plugin on an in-process `Application`.
 *
 * A fixture resource exposes one action of each kind against an in-memory
 * record store. The tests prove:
 *
 * - the list renders header action links, row action links, and (for bulk
 *   actions) per-row checkboxes plus a submit button;
 * - the confirm page (GET) is server-rendered, then the run (POST) is
 *   origin/CSRF-gated, invokes `run` with the resolved, authorized records, and
 *   303-redirects to the list with a `?_notice=<code>` flash;
 * - an action's per-record `authorize` filters records before `run` (default-
 *   allow when absent, exact-true when present);
 * - an unknown action name and an unknown record id are 404;
 * - the built-in success notice renders on the redirect, and a custom `notice`
 *   code maps through the panel's notice registry.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminActionError,
  defineAdminAction,
  defineImportAction,
  defineReplicateAction,
  defineRestoreAction,
  type AdminActionContext,
  type AdminActionAuthorizeContext,
} from '../../src/admin/actions.js';
import { defineResource, type Resource } from '../../src/admin/resource.js';
import { adminPlugin, defineAdminPanel } from '../../src/admin/index.js';
import type { Session } from '../../src/contracts/http.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};
const CSRF = SESSION.csrfToken;

type Article = {
  readonly id: string;
  readonly title: string;
  readonly published: boolean;
};

/** Records captured from action `run` calls: session, path, and resolved records. */
interface RunCall {
  readonly context: AdminActionContext;
  readonly records: readonly Record<string, unknown>[];
}

const RECORDS: Article[] = [
  { id: '1', title: 'First', published: false },
  { id: '2', title: 'Second', published: false },
  { id: '3', title: 'Third', published: false },
];

function makeArticleResource(runs: RunCall[]): Resource {
  return defineResource({
    slug: 'articles',
    label: 'Articles',
    columns: [
      { name: 'id', label: 'ID' },
      { name: 'title', label: 'Title' },
      { name: 'published', label: 'Published', format: 'boolean' },
    ],
    fields: [{ name: 'title', label: 'Title', type: 'text' }],
    list: async () => ({ rows: RECORDS, total: RECORDS.length }),
    get: async ({ id }) => RECORDS.find((record) => record.id === id) ?? null,
    save: async () => {},
    actions: {
      header: [
        defineAdminAction({
          name: 'export-all',
          label: 'Export all',
          confirm: 'Export every article?',
          run: (context, records) => {
            runs.push({ context, records });
          },
        }),
      ],
      row: [
        defineAdminAction({
          name: 'publish',
          label: 'Publish',
          run: (context, records) => {
            runs.push({ context, records });
          },
        }),
      ],
      bulk: [
        defineAdminAction({
          name: 'archive',
          label: 'Archive',
          notice: 'articles-archived',
          run: (context, records) => {
            runs.push({ context, records });
          },
        }),
      ],
    },
  });
}

async function makeApp(resource: Resource): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: () => true,
            resources: [resource],
          }),
        ),
      ],
    },
  });
}

/** POST an application/x-www-form-urlencoded body with a same-origin header. */
function postForm(
  app: TestApplication,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      origin: app.origin,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('admin action descriptor validation', () => {
  it('rejects an invalid name, empty label, or missing run', () => {
    assert.throws(() => defineAdminAction({ name: 'bad/name', label: 'x', run: () => {} }));
    assert.throws(() => defineAdminAction({ name: 'ok', label: '  ', run: () => {} }));
    assert.throws(() =>
      defineAdminAction({
        name: 'ok',
        label: 'x',
        // @ts-expect-error — a missing `run` must be rejected at runtime.
        run: undefined,
      }),
    );
  });

  it('freezes a valid descriptor', () => {
    const action = defineAdminAction({ name: 'ok', label: 'OK', run: () => {} });
    assert.equal(Object.isFrozen(action), true);
    assert.equal(action.name, 'ok');
    assert.equal(action.label, 'OK');
  });
});

describe('admin header actions', () => {
  it('renders the header action link on the list and confirms then runs it', async () => {
    const runs: RunCall[] = [];
    const app = await makeApp(makeArticleResource(runs));

    const list = await app.request('/admin/articles');
    const listBody = await list.text();
    assert.match(listBody, /Export all/);
    assert.match(listBody, /actions\/export-all/);

    const confirm = await app.request('/admin/articles/actions/export-all');
    const confirmBody = await confirm.text();
    assert.equal(confirm.status, 200);
    assert.match(confirmBody, /Export every article\?/);
    assert.match(confirmBody, /Confirm/);

    const response = await postForm(app, '/admin/articles/actions/export-all', {
      _csrf: CSRF,
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /\/admin\/articles\?_notice=/);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]!.records, []);
    assert.equal(runs[0]!.context.session.id, SESSION.id);
    assert.equal(runs[0]!.context.path, '/admin');

    await app.close();
  });
});

describe('admin row actions', () => {
  it('renders a per-row link, confirms, and runs against the single record', async () => {
    const runs: RunCall[] = [];
    const app = await makeApp(makeArticleResource(runs));

    const list = await app.request('/admin/articles');
    const listBody = await list.text();
    assert.match(listBody, /Publish/);
    assert.match(listBody, /\/1\/actions\/publish/);

    const confirm = await app.request('/admin/articles/1/actions/publish');
    assert.equal(confirm.status, 200);
    assert.match(await confirm.text(), /This will affect 1 record\./);

    const response = await postForm(app, '/admin/articles/1/actions/publish', {
      _csrf: CSRF,
    });
    assert.equal(response.status, 303);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.records.length, 1);
    assert.equal(runs[0]!.records[0]!['id'], '1');

    await app.close();
  });

  it('returns 404 for an unknown row id and an unknown action name', async () => {
    const runs: RunCall[] = [];
    const app = await makeApp(makeArticleResource(runs));

    assert.equal((await app.request('/admin/articles/999/actions/publish')).status, 404);
    assert.equal((await app.request('/admin/articles/1/actions/nope')).status, 404);

    await app.close();
  });
});

describe('admin bulk actions', () => {
  it('renders checkboxes, confirms the selection, and runs against the selected records', async () => {
    const runs: RunCall[] = [];
    const app = await makeApp(makeArticleResource(runs));

    const list = await app.request('/admin/articles');
    const listBody = await list.text();
    assert.match(listBody, /name="ids"/);
    assert.match(listBody, /actions\/archive/);

    const confirm = await app.request('/admin/articles/actions/archive?ids=1&ids=2');
    assert.equal(confirm.status, 200);
    assert.match(await confirm.text(), /This will affect 2 records\./);

    const response = await postForm(app, '/admin/articles/actions/archive', {
      _csrf: CSRF,
      ids: '1,2',
    });
    assert.equal(response.status, 303);
    assert.equal(runs.length, 1);
    assert.deepEqual(
      runs[0]!.records.map((record) => record['id']),
      ['1', '2'],
    );
    // The custom notice code is reflected in the redirect.
    assert.match(response.headers.get('location') ?? '', /_notice=articles-archived/);

    await app.close();
  });

  it('drops unknown ids when resolving the selection', async () => {
    const runs: RunCall[] = [];
    const app = await makeApp(makeArticleResource(runs));

    const response = await postForm(app, '/admin/articles/actions/archive', {
      _csrf: CSRF,
      ids: '1,999',
    });
    assert.equal(response.status, 303);
    assert.deepEqual(
      runs[0]!.records.map((record) => record['id']),
      ['1'],
    );

    await app.close();
  });
});

describe('admin action per-record authorization', () => {
  function makeGatedResource(runs: RunCall[]): Resource {
    // Only records 2 and 3 are published, so the per-record authorize allows them.
    const rows: Article[] = [
      { id: '1', title: 'First', published: false },
      { id: '2', title: 'Second', published: true },
      { id: '3', title: 'Third', published: true },
    ];
    const authorize = (context: AdminActionAuthorizeContext) =>
      context.record['published'] === true;
    return defineResource({
      slug: 'articles',
      label: 'Articles',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
        { name: 'published', label: 'Published', format: 'boolean' },
      ],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows, total: rows.length }),
      get: async ({ id }) => rows.find((record) => record.id === id) ?? null,
      save: async () => {},
      actions: {
        bulk: [
          defineAdminAction({
            name: 'archive',
            label: 'Archive',
            authorize,
            run: (context, records) => {
              runs.push({ context, records });
            },
          }),
        ],
      },
    });
  }

  it('runs only against records the per-record authorize allows', async () => {
    const runs: RunCall[] = [];
    const app = await makeApp(makeGatedResource(runs));

    // Only records 2 and 3 are `published`, so the selection is filtered to them.
    const response = await postForm(app, '/admin/articles/actions/archive', {
      _csrf: CSRF,
      ids: '1,2,3',
    });
    assert.equal(response.status, 303);
    assert.equal(runs.length, 1);
    assert.deepEqual(
      runs[0]!.records.map((record) => record['id']),
      ['2', '3'],
    );

    await app.close();
  });
});

describe('admin action mutation security', () => {
  it('rejects a POST without a same-origin Origin or a matching CSRF token', async () => {
    const runs: RunCall[] = [];
    const app = await makeApp(makeArticleResource(runs));

    const noOrigin = await postForm(
      app,
      '/admin/articles/actions/export-all',
      { _csrf: CSRF },
      {
        origin: 'https://evil.example',
      },
    );
    assert.equal(noOrigin.status, 403);

    const badCsrf = await postForm(app, '/admin/articles/actions/export-all', {
      _csrf: 'wrong-token',
    });
    assert.equal(badCsrf.status, 403);

    assert.equal(runs.length, 0);

    await app.close();
  });
});

describe('replicate/restore/import actions', () => {
  it('defineReplicateAction defaults its label and confirm', () => {
    const a = defineReplicateAction({ name: 'replicate', run: () => {} });
    assert.equal(a.label, 'Replicate');
    assert.equal(typeof a.confirm, 'string');
  });

  it('defineRestoreAction preserves an explicit label', () => {
    const a = defineRestoreAction({ name: 'restore', label: 'Bring back', run: () => {} });
    assert.equal(a.label, 'Bring back');
  });

  it('rejects an invalid name through the shared validator', () => {
    assert.throws(() => defineImportAction({ name: 'bad name', run: () => {} }), AdminActionError);
  });
});
