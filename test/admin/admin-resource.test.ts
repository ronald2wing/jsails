/**
 * Admin resource CRUD tests.
 *
 * These drive an in-memory fixture resource (no ORM, no database, no listener)
 * through the real admin plugin mounted on an in-process `Application`. The
 * fixture resource exercises every field kind the descriptor supports — `text`,
 * `textarea`, `select` (with options), `toggle`, and `number` — so the derived
 * Zod schema's coercion (number strings to numbers, absent checkbox to `false`,
 * unknown-key rejection) and the panel's route surface are proven against real
 * requests:
 *
 * - the paginated list renders rows, columns, the create/edit links, and the
 *   page footer;
 * - create rejects required-missing and unknown fields with a 422 that
 *   repopulates submitted values, and a valid create saves the coerced, typed
 *   values then 303-redirects to the list;
 * - update loads the existing record into the form and saves the new values;
 * - mutations enforce same-origin `Origin` and a constant-time `_csrf` check;
 * - per-action `authorize` and the panel auth gate are default-deny;
 * - a read-only resource (no `save`) rejects mutations with a 405;
 * - unknown ids are 404;
 * - invalid slugs and fields are rejected at `defineResource` time with
 *   value-free `ResourceError`s.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ResourceError,
  adminPlugin,
  defineAdminPanel,
  defineRelationManager,
  defineResource,
  type RelationManagerCreateContext,
  type RelationManagerDeleteContext,
  type RelationManagerListContext,
  type Resource,
  type ResourceAction,
  type ResourceColumn,
  type ResourceField,
  type ResourceGetContext,
  type ResourceListContext,
  type ResourceDefinition,
} from '../../src/admin/index.js';
import type { Session } from '../../src/contracts/http.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};
const CSRF = SESSION.csrfToken;

// ---------------------------------------------------------------------------
// In-memory fixture resource
// ---------------------------------------------------------------------------

type Article = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: string;
  readonly active: boolean;
  readonly priority: number;
};

interface SaveRecord {
  readonly id: string | null;
  readonly values: Record<string, unknown>;
}

interface ArticleStore {
  rows: Article[];
  nextId: number;
  saves: SaveRecord[];
  listCalls: Array<{ page: number; pageSize: number }>;
  getCalls: Array<{ id: string }>;
}

const ARTICLE_FIELDS: readonly ResourceField[] = [
  { name: 'title', label: 'Title', type: 'text' },
  { name: 'description', label: 'Description', type: 'textarea', required: false },
  {
    name: 'status',
    label: 'Status',
    type: 'select',
    options: [
      { value: 'draft', label: 'Draft' },
      { value: 'published', label: 'Published' },
    ],
  },
  { name: 'active', label: 'Active', type: 'toggle' },
  { name: 'priority', label: 'Priority', type: 'number' },
];

const ARTICLE_COLUMNS: readonly ResourceColumn[] = [
  { name: 'id', label: 'ID' },
  { name: 'title', label: 'Title' },
  { name: 'status', label: 'Status' },
  { name: 'priority', label: 'Priority' },
  { name: 'active', label: 'Active' },
];

function makeStore(rows: Article[] = []): ArticleStore {
  return { rows: [...rows], nextId: rows.length + 1, saves: [], listCalls: [], getCalls: [] };
}

function makeArticleResource(
  store: ArticleStore,
  overrides: Partial<ResourceDefinition> = {},
): Resource {
  return defineResource({
    slug: 'articles',
    label: 'Articles',
    columns: ARTICLE_COLUMNS,
    fields: ARTICLE_FIELDS,
    list: async ({ page, pageSize }: ResourceListContext) => {
      store.listCalls.push({ page, pageSize });
      const start = (page - 1) * pageSize;
      return { rows: store.rows.slice(start, start + pageSize), total: store.rows.length };
    },
    get: async ({ id }: ResourceGetContext) => {
      store.getCalls.push({ id });
      return store.rows.find((row) => row.id === id) ?? null;
    },
    save: async ({ id, values }) => {
      store.saves.push({ id, values });
      const record: Article = {
        id: id ?? String(store.nextId++),
        title: values['title'] as string,
        description: values['description'] as string | undefined,
        status: values['status'] as string,
        active: values['active'] as boolean,
        priority: values['priority'] as number,
      };
      if (id === null) {
        store.rows.push(record);
      } else {
        const index = store.rows.findIndex((row) => row.id === id);
        if (index >= 0) store.rows[index] = record;
      }
    },
    ...overrides,
  });
}

interface PanelOverrides {
  readonly authorize?: (session: Session | null) => boolean | Promise<boolean>;
  readonly resolveSession?: (request: Request) => Session | null | Promise<Session | null>;
}

async function makeApp(
  resource: Resource,
  overrides: PanelOverrides = {},
): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: overrides.resolveSession ?? (() => SESSION),
            authorize: overrides.authorize ?? (() => true),
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

const article = (id: string, overrides: Partial<Article> = {}): Article => ({
  id,
  title: `Article ${id}`,
  status: 'draft',
  active: false,
  priority: 1,
  ...overrides,
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('admin resource list', () => {
  it('renders rows, columns, the create link, and edit actions', async () => {
    const store = makeStore([
      article('1', { title: 'First', status: 'published', priority: 5, active: true }),
      article('2', { title: 'Second', status: 'draft' }),
      article('3', { title: 'Third', status: 'draft' }),
    ]);
    const app = await makeApp(makeArticleResource(store));

    const response = await app.request('/admin/articles');
    assert.equal(response.status, 200);
    const body = await response.text();

    // Rows and column cells.
    assert.match(body, /First/);
    assert.match(body, /Second/);
    assert.match(body, /Third/);
    assert.match(body, /ID/);
    assert.match(body, /Status/);
    // The create link (a `save` callback is present) and the edit action.
    assert.match(body, /New Articles/);
    assert.match(body, /Edit/);
    // Default pagination: page 1, pageSize 20, three total.
    assert.match(body, /Page 1 of 1 \(3 total\)/);
    assert.deepEqual(store.listCalls, [{ page: 1, pageSize: 20 }]);

    await app.close();
  });

  it('paginates by page and pageSize, showing only the requested slice', async () => {
    const store = makeStore([
      article('1', { title: 'First' }),
      article('2', { title: 'Second' }),
      article('3', { title: 'Third' }),
    ]);
    const app = await makeApp(makeArticleResource(store));

    const response = await app.request('/admin/articles?page=2&pageSize=2');
    assert.equal(response.status, 200);
    const body = await response.text();

    assert.match(body, /Page 2 of 2 \(3 total\)/);
    assert.match(body, /Third/);
    assert.doesNotMatch(body, /First/);
    assert.doesNotMatch(body, /Second/);
    assert.match(body, /Previous/);
    assert.doesNotMatch(body, /Next/);
    assert.deepEqual(store.listCalls, [{ page: 2, pageSize: 2 }]);

    await app.close();
  });

  it('falls back to page 1 and the default page size for invalid query params', async () => {
    const store = makeStore([article('1', { title: 'First' })]);
    const app = await makeApp(makeArticleResource(store));

    const response = await app.request('/admin/articles?page=zero&pageSize=999999');
    assert.equal(response.status, 200);
    assert.deepEqual(store.listCalls, [{ page: 1, pageSize: 100 }]);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('admin resource create', () => {
  it('renders the empty create form', async () => {
    const app = await makeApp(makeArticleResource(makeStore()));

    const response = await app.request('/admin/articles/new');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /New Articles/);
    assert.match(body, /name="_csrf"/);
    assert.match(body, /form/);

    await app.close();
  });

  it('rejects a required-missing field with 422 and repopulates submitted values', async () => {
    const store = makeStore();
    const app = await makeApp(makeArticleResource(store));

    // `priority` (required number) is omitted.
    const response = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'Hello',
      status: 'draft',
    });
    assert.equal(response.status, 422);
    const body = await response.text();
    assert.match(body, /This field is required/);
    // The submitted title is repopulated into the form.
    assert.match(body, /value="Hello"/);
    // Save must not have run.
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('rejects an unknown field with 422 and never echoes it', async () => {
    const store = makeStore();
    const app = await makeApp(makeArticleResource(store));

    const response = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'Hello',
      status: 'draft',
      priority: '7',
      hacker: 'injected',
    });
    assert.equal(response.status, 422);
    const body = await response.text();
    // The strict schema rejects the unknown key, the known values are
    // repopulated, and the unknown value is never echoed back.
    assert.match(body, /value="Hello"/);
    assert.match(body, /value="7"/);
    assert.doesNotMatch(body, /injected/);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('saves coerced, typed values and 303-redirects to the list', async () => {
    const store = makeStore();
    const app = await makeApp(makeArticleResource(store));

    const response = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'Hello World',
      status: 'published',
      priority: '7',
      active: 'on',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/admin/articles');

    assert.equal(store.saves.length, 1);
    const saved = store.saves[0]!;
    assert.equal(saved.id, null);
    assert.equal(saved.values['title'], 'Hello World');
    // The numeric string is coerced to a real number.
    assert.equal(saved.values['priority'], 7);
    assert.equal(typeof saved.values['priority'], 'number');
    assert.equal(saved.values['status'], 'published');
    // The toggle submission coerces to a boolean true.
    assert.equal(saved.values['active'], true);
    // The omitted optional field parses to undefined.
    assert.equal(saved.values['description'], undefined);
    // The record was appended to the in-memory store.
    assert.equal(store.rows.length, 1);

    await app.close();
  });

  it('coerces an absent toggle to false', async () => {
    const store = makeStore();
    const app = await makeApp(makeArticleResource(store));

    const response = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'No Toggle',
      status: 'draft',
      priority: '1',
    });
    assert.equal(response.status, 303);
    assert.equal(store.saves[0]!.values['active'], false);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('admin resource update', () => {
  it('loads the existing record into the edit form and saves new values', async () => {
    const store = makeStore([
      article('1', { title: 'First', status: 'draft', priority: 1, active: false }),
    ]);
    const app = await makeApp(makeArticleResource(store));

    const edit = await app.request('/admin/articles/1');
    assert.equal(edit.status, 200);
    const editBody = await edit.text();
    assert.match(editBody, /Edit Articles/);
    // The existing values are loaded into the form inputs.
    assert.match(editBody, /value="First"/);
    assert.match(editBody, /value="1"/);
    assert.deepEqual(store.getCalls, [{ id: '1' }]);

    const update = await postForm(app, '/admin/articles/1', {
      _csrf: CSRF,
      title: 'First Updated',
      status: 'published',
      priority: '9',
      active: 'on',
    });
    assert.equal(update.status, 303);
    assert.equal(update.headers.get('location'), '/admin/articles');

    assert.equal(store.saves.length, 1);
    const saved = store.saves[0]!;
    assert.equal(saved.id, '1');
    assert.equal(saved.values['title'], 'First Updated');
    assert.equal(saved.values['priority'], 9);
    assert.equal(saved.values['status'], 'published');
    assert.equal(saved.values['active'], true);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Mutation guards (same-origin Origin + CSRF)
// ---------------------------------------------------------------------------

describe('admin resource mutation guards', () => {
  it('rejects a POST without an Origin header', async () => {
    const store = makeStore();
    const app = await makeApp(makeArticleResource(store));

    const response = await app.request('/admin/articles', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: CSRF,
        title: 'x',
        status: 'draft',
        priority: '1',
      }).toString(),
    });
    assert.equal(response.status, 403);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('rejects a cross-origin POST', async () => {
    const store = makeStore();
    const app = await makeApp(makeArticleResource(store));

    const response = await postForm(
      app,
      '/admin/articles',
      { _csrf: CSRF, title: 'x', status: 'draft', priority: '1' },
      { origin: 'https://evil.example' },
    );
    assert.equal(response.status, 403);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('rejects a missing or invalid CSRF token', async () => {
    const store = makeStore();
    const app = await makeApp(makeArticleResource(store));

    const missing = await postForm(app, '/admin/articles', {
      title: 'x',
      status: 'draft',
      priority: '1',
    });
    assert.equal(missing.status, 403);

    const invalid = await postForm(app, '/admin/articles', {
      _csrf: 'wrong-token',
      title: 'x',
      status: 'draft',
      priority: '1',
    });
    assert.equal(invalid.status, 403);
    assert.equal(store.saves.length, 0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('admin resource authorization', () => {
  it('denies each action independently when the resource authorize rejects it', async () => {
    const cases: ReadonlyArray<{ action: ResourceAction; method: 'GET' | 'POST'; path: string }> = [
      { action: 'list', method: 'GET', path: '/admin/articles' },
      { action: 'create', method: 'POST', path: '/admin/articles' },
      { action: 'view', method: 'GET', path: '/admin/articles/1' },
      { action: 'update', method: 'POST', path: '/admin/articles/1' },
    ];

    for (const c of cases) {
      const store = makeStore([article('1', { title: 'First' })]);
      const resource = makeArticleResource(store, {
        authorize: (ctx) => ctx.action !== c.action,
      });
      const app = await makeApp(resource);

      const response =
        c.method === 'GET'
          ? await app.request(c.path)
          : await postForm(app, c.path, {
              _csrf: CSRF,
              title: 'x',
              status: 'draft',
              priority: '1',
            });
      assert.equal(response.status, 403, `action ${c.action} must be denied`);
      assert.equal(store.saves.length, 0);

      await app.close();
    }
  });

  it('default-allows when no resource authorize is declared', async () => {
    const store = makeStore([article('1', { title: 'First' })]);
    const app = await makeApp(makeArticleResource(store));

    assert.equal((await app.request('/admin/articles')).status, 200);

    await app.close();
  });

  it('denies when the resource authorize callback throws', async () => {
    const store = makeStore([article('1', { title: 'First' })]);
    const resource = makeArticleResource(store, {
      authorize: () => {
        throw new Error('boom');
      },
    });
    const app = await makeApp(resource);

    assert.equal((await app.request('/admin/articles')).status, 403);

    await app.close();
  });

  it('denies a resource route for a non-admin session', async () => {
    const store = makeStore([article('1', { title: 'First' })]);
    const app = await makeApp(makeArticleResource(store), { authorize: () => false });

    assert.equal((await app.request('/admin/articles')).status, 403);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Read-only resource
// ---------------------------------------------------------------------------

describe('admin resource read-only', () => {
  it('rejects create and update posts with 405 when save is absent', async () => {
    const store = makeStore([article('1', { title: 'First' })]);
    const resource = makeArticleResource(store, { save: undefined });
    const app = await makeApp(resource);

    const create = await postForm(app, '/admin/articles', {
      _csrf: CSRF,
      title: 'x',
      status: 'draft',
      priority: '1',
    });
    assert.equal(create.status, 405);
    assert.match(await create.text(), /read-only/);

    const update = await postForm(app, '/admin/articles/1', {
      _csrf: CSRF,
      title: 'x',
      status: 'draft',
      priority: '1',
    });
    assert.equal(update.status, 405);

    // The list still renders (read-only lists are allowed).
    assert.equal((await app.request('/admin/articles')).status, 200);
    assert.equal(store.saves.length, 0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Unknown ids
// ---------------------------------------------------------------------------

describe('admin resource unknown id', () => {
  it('returns 404 for an unknown edit id and an unknown update id', async () => {
    const store = makeStore([article('1', { title: 'First' })]);
    const app = await makeApp(makeArticleResource(store));

    const edit = await app.request('/admin/articles/999');
    assert.equal(edit.status, 404);

    const update = await app.request('/admin/articles/999', {
      method: 'POST',
      headers: { origin: app.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: 'x', status: 'draft', priority: '1' }).toString(),
    });
    assert.equal(update.status, 404);
    assert.equal(store.saves.length, 0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// defineResource validation
// ---------------------------------------------------------------------------

describe('defineResource validation', () => {
  const base = () => ({
    slug: 'ok',
    label: 'Label',
    columns: [{ name: 'id', label: 'ID' }],
    fields: [] as ResourceField[],
    list: async () => ({ rows: [], total: 0 }),
  });

  it('rejects a malformed or reserved slug', () => {
    for (const slug of ['', 'bad/slug', 'bad slug', 'bad.slug', '-lead', 'trail-', 'plugins']) {
      assert.throws(() => defineResource({ ...base(), slug }), ResourceError, `slug ${slug}`);
    }
  });

  it('rejects a missing or blank label', () => {
    for (const label of ['', '   ']) {
      assert.throws(() => defineResource({ ...base(), label }), ResourceError);
    }
  });

  it('rejects a missing list function', () => {
    assert.throws(() => defineResource({ ...base(), list: undefined } as never), ResourceError);
  });

  it('rejects empty or duplicate columns', () => {
    assert.throws(() => defineResource({ ...base(), columns: [] }), ResourceError);
    assert.throws(
      () =>
        defineResource({
          ...base(),
          columns: [
            { name: 'id', label: 'ID' },
            { name: 'id', label: 'ID Again' },
          ],
        }),
      ResourceError,
    );
  });

  it('rejects an invalid field type, duplicate names, and options on a non-select', () => {
    assert.throws(
      () =>
        defineResource({ ...base(), fields: [{ name: 'f', label: 'F', type: 'bogus' as never }] }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [
            { name: 'f', label: 'F', type: 'text' },
            { name: 'f', label: 'G', type: 'text' },
          ],
        }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [{ name: 'f', label: 'F', type: 'text', options: [{ value: 'a', label: 'A' }] }],
        }),
      ResourceError,
    );
  });

  it('rejects select options that are empty or have duplicate values', () => {
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [{ name: 'f', label: 'F', type: 'select', options: [] }],
        }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [
            {
              name: 'f',
              label: 'F',
              type: 'select',
              options: [
                { value: 'a', label: 'A' },
                { value: 'a', label: 'A2' },
              ],
            },
          ],
        }),
      ResourceError,
    );
  });

  it('rejects a field name shadowing an inherited property', () => {
    for (const name of ['toString', 'constructor', '__proto__']) {
      assert.throws(
        () => defineResource({ ...base(), fields: [{ name, label: 'F', type: 'text' }] }),
        ResourceError,
        `field name ${name}`,
      );
    }
  });

  it('accepts a valid spec and freezes the descriptor', () => {
    const resource = defineResource({
      ...base(),
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
    });
    assert.equal(Object.isFrozen(resource), true);
    assert.equal(Object.isFrozen(resource.columns), true);
    assert.equal(Object.isFrozen(resource.fields), true);
    assert.equal(resource.slug, 'ok');
  });

  it('accepts a valid spec with a relationManagers entry and freezes it', () => {
    const related = defineResource({
      slug: 'comments',
      label: 'Comments',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'text', label: 'Text', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'comments',
      label: 'Comments',
      related,
      foreignKey: 'post_id',
      list: async () => ({ rows: [], total: 0 }),
      create: async () => {},
      delete: async () => {},
    });
    const resource = defineResource({ ...base(), relationManagers: [rm] });
    assert.equal(Array.isArray(resource.relationManagers), true);
    assert.equal(resource.relationManagers!.length, 1);
    assert.equal(Object.isFrozen(resource.relationManagers![0]!), true);
  });

  it('rejects a radio field without options and options on an unsupported field', () => {
    assert.throws(
      () => defineResource({ ...base(), fields: [{ name: 'p', label: 'P', type: 'radio' }] }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [
            { name: 'n', label: 'N', type: 'number', options: [{ value: 'a', label: 'A' }] },
          ],
        }),
      ResourceError,
    );
  });

  it('rejects an unsupported column format and colors on a non-badge/boolean column', () => {
    assert.throws(
      () =>
        defineResource({
          ...base(),
          columns: [{ name: 'x', label: 'X', format: 'bogus' as never }],
        }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          columns: [{ name: 'x', label: 'X', format: 'date', colors: { a: 'b' } }],
        }),
      ResourceError,
    );
  });
});

// ---------------------------------------------------------------------------
// Field types: date, datetime, checkbox, radio
// ---------------------------------------------------------------------------

describe('admin resource field types', () => {
  const EVENT_FIELDS: readonly ResourceField[] = [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'eventDate', label: 'Event date', type: 'date' },
    { name: 'startsAt', label: 'Starts at', type: 'datetime', required: false },
    { name: 'approved', label: 'Approved', type: 'checkbox' },
    {
      name: 'priority',
      label: 'Priority',
      type: 'radio',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
      ],
    },
  ];

  function makeEventResource(saves: Record<string, unknown>[]): Resource {
    return defineResource({
      slug: 'events',
      label: 'Events',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: EVENT_FIELDS,
      list: async () => ({ rows: [], total: 0 }),
      save: async ({ values }) => {
        saves.push(values);
      },
    });
  }

  async function makeEventApp(resource: Resource): Promise<TestApplication> {
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

  it('renders the date, datetime, checkbox, and radio input kinds', async () => {
    const app = await makeEventApp(makeEventResource([]));
    const response = await app.request('/admin/events/new');
    const body = await response.text();
    assert.match(body, /type="date"/);
    assert.match(body, /type="datetime-local"/);
    assert.match(body, /type="checkbox"/);
    assert.match(body, /type="radio"/);
    assert.match(body, /value="high"/);
    await app.close();
  });

  it('coerces date, datetime, checkbox, and radio submissions into typed values', async () => {
    const saves: Record<string, unknown>[] = [];
    const app = await makeEventApp(makeEventResource(saves));

    const response = await postForm(app, '/admin/events', {
      _csrf: CSRF,
      title: 'Launch',
      eventDate: '2024-01-15',
      startsAt: '2024-01-15T13:45',
      approved: '1',
      priority: 'high',
    });
    assert.equal(response.status, 303);
    assert.deepEqual(saves[0], {
      title: 'Launch',
      eventDate: '2024-01-15',
      startsAt: '2024-01-15T13:45',
      approved: true,
      priority: 'high',
    });

    await app.close();
  });

  it('coerces an absent checkbox to false and a blank optional datetime to undefined', async () => {
    const saves: Record<string, unknown>[] = [];
    const app = await makeEventApp(makeEventResource(saves));

    const response = await postForm(app, '/admin/events', {
      _csrf: CSRF,
      title: 'No approval',
      eventDate: '2024-01-15',
      priority: 'low',
    });
    assert.equal(response.status, 303);
    assert.equal(saves[0]!['approved'], false);
    assert.equal(saves[0]!['startsAt'], undefined);

    await app.close();
  });

  it('rejects an invalid date and an invalid radio option with 422', async () => {
    const saves: Record<string, unknown>[] = [];
    const app = await makeEventApp(makeEventResource(saves));

    const badDate = await postForm(app, '/admin/events', {
      _csrf: CSRF,
      title: 'x',
      eventDate: 'not-a-date',
      priority: 'low',
    });
    assert.equal(badDate.status, 422);
    assert.match(await badDate.text(), /Invalid value/);

    const badRadio = await postForm(app, '/admin/events', {
      _csrf: CSRF,
      title: 'x',
      eventDate: '2024-01-15',
      priority: 'urgent',
    });
    assert.equal(badRadio.status, 422);
    assert.equal(saves.length, 0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Column formats: badge, boolean, date (escaped rendering)
// ---------------------------------------------------------------------------

describe('admin resource column formats', () => {
  const REPORT_COLUMNS: readonly ResourceColumn[] = [
    { name: 'id', label: 'ID' },
    { name: 'title', label: 'Title' },
    {
      name: 'status',
      label: 'Status',
      format: 'badge',
      colors: { published: 'green', draft: 'gray' },
    },
    { name: 'active', label: 'Active', format: 'boolean', colors: { true: 'green', false: 'red' } },
    { name: 'created', label: 'Created', format: 'date' },
  ];

  function makeReportResource(rows: readonly Record<string, unknown>[]): Resource {
    return defineResource({
      slug: 'reports',
      label: 'Reports',
      columns: REPORT_COLUMNS,
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows, total: rows.length }),
    });
  }

  async function makeReportApp(resource: Resource): Promise<TestApplication> {
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

  it('renders badge colors, boolean yes/no, and the date portion', async () => {
    const app = await makeReportApp(
      makeReportResource([
        {
          id: '1',
          title: 'Report',
          status: 'published',
          active: true,
          created: '2024-01-15T09:00:00.000Z',
        },
      ]),
    );

    const body = await (await app.request('/admin/reports')).text();
    assert.match(body, /admin-badge/);
    assert.match(body, /green/);
    assert.match(body, /admin-boolean/);
    assert.match(body, /Yes/);
    assert.match(body, /admin-date/);
    assert.match(body, /2024-01-15/);

    await app.close();
  });

  it('escapes hostile cell values and never emits them raw', async () => {
    const app = await makeReportApp(
      makeReportResource([
        {
          id: '1',
          title: '<script>alert(1)</script>',
          status: 'draft',
          active: false,
          created: '',
        },
      ]),
    );

    const body = await (await app.request('/admin/reports')).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Table state: sort, search, filters, whitelisting, clamping, preservation
// ---------------------------------------------------------------------------

describe('admin resource table state', () => {
  type Product = {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly price: number;
  };

  const PRODUCT_COLUMNS: readonly ResourceColumn[] = [
    { name: 'id', label: 'ID' },
    { name: 'name', label: 'Name', sortable: true, searchable: true },
    {
      name: 'status',
      label: 'Status',
      filter: [
        { value: 'published', label: 'Published' },
        { value: 'draft', label: 'Draft' },
      ],
    },
    { name: 'price', label: 'Price', sortable: true },
  ];

  function makeProductResource(calls: ResourceListContext[], rows: Product[] = []): Resource {
    return defineResource({
      slug: 'products',
      label: 'Products',
      columns: PRODUCT_COLUMNS,
      fields: [{ name: 'name', label: 'Name', type: 'text' }],
      list: async (context) => {
        calls.push(context);
        return { rows, total: rows.length };
      },
      save: async () => {},
    });
  }

  async function makeProductApp(resource: Resource): Promise<TestApplication> {
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

  it('passes a whitelisted sort and direction through to list', async () => {
    const calls: ResourceListContext[] = [];
    const app = await makeProductApp(makeProductResource(calls));

    await app.request('/admin/products?sort=name&direction=desc');
    assert.equal(calls[0]?.sort, 'name');
    assert.equal(calls[0]?.direction, 'desc');

    // A non-sortable column name is dropped (whitelisted).
    await app.request('/admin/products?sort=id&direction=desc');
    assert.equal(calls[1]?.sort, undefined);

    await app.close();
  });

  it('passes a clamped search term and whitelisted filters to list', async () => {
    const calls: ResourceListContext[] = [];
    const app = await makeProductApp(makeProductResource(calls));

    await app.request('/admin/products?search=abc&f_status=published&f_status=nope');
    assert.equal(calls[0]?.search, 'abc');
    assert.deepEqual(calls[0]?.filters, { status: 'published' });

    // A search term longer than the clamp is truncated before reaching list.
    await app.request(`/admin/products?search=${'a'.repeat(300)}`);
    assert.equal(calls[1]?.search, 'a'.repeat(200));

    await app.close();
  });

  it('preserves sort/search/filter state through pagination links', async () => {
    const rows: Product[] = Array.from({ length: 25 }, (_, i) => ({
      id: String(i + 1),
      name: `Product ${i + 1}`,
      status: 'draft',
      price: i,
    }));
    const calls: ResourceListContext[] = [];
    const app = await makeProductApp(makeProductResource(calls, rows));

    const body = await (
      await app.request('/admin/products?sort=name&search=x&f_status=published&pageSize=10')
    ).text();
    // The Next link must carry the current state so it survives navigation.
    assert.match(body, /sort=name/);
    assert.match(body, /search=x/);
    assert.match(body, /f_status=published/);
    assert.match(body, /Next/);

    await app.close();
  });

  it('escapes a hostile search term in the filter form and never echoes it raw', async () => {
    const calls: ResourceListContext[] = [];
    const app = await makeProductApp(makeProductResource(calls));

    const body = await (
      await app.request('/admin/products?search=<script>alert(1)</script>')
    ).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);

    await app.close();
  });

  it('preserves table state through a create-form save redirect', async () => {
    const calls: ResourceListContext[] = [];
    const app = await makeProductApp(makeProductResource(calls));

    const form = await app.request('/admin/products/new?sort=name');
    const formBody = await form.text();
    assert.match(formBody, /name="_back"/);
    assert.match(formBody, /sort=name/);

    const response = await postForm(app, '/admin/products', {
      _csrf: CSRF,
      name: 'New product',
      _back: 'sort=name',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/admin/products?sort=name');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Field kinds — key-value / tags / color / slider / code
// ---------------------------------------------------------------------------

describe('field kinds', () => {
  it('coerces a slider field to a bounded number', () => {
    const resource = defineResource({
      slug: 's',
      label: 'S',
      columns: [{ name: 'level', label: 'Level' }],
      fields: [{ name: 'level', label: 'Level', type: 'slider', min: 0, max: 10, step: 1 }],
      list: async () => ({ rows: [], total: 0 }),
      save: async () => {},
    });
    const parsed = resource.schema.safeParse({ level: '5' });
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.level, 5);
  });

  it('rejects a slider value outside its bounds', () => {
    const resource = defineResource({
      slug: 's2',
      label: 'S2',
      columns: [{ name: 'level', label: 'Level' }],
      fields: [{ name: 'level', label: 'Level', type: 'slider', min: 0, max: 10 }],
      list: async () => ({ rows: [], total: 0 }),
    });
    assert.equal(resource.schema.safeParse({ level: '99' }).success, false);
  });

  it('parses a keyvalue field into an object', () => {
    const resource = defineResource({
      slug: 'kv',
      label: 'KV',
      columns: [{ name: 'meta', label: 'Meta' }],
      fields: [{ name: 'meta', label: 'Meta', type: 'keyvalue' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const parsed = resource.schema.safeParse({ meta: '{"a":"1"}' });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.meta, { a: '1' });
  });
});

// ---------------------------------------------------------------------------
// Markdown field — sanitized HTML via `createRichText`
// ---------------------------------------------------------------------------

describe('markdown field', () => {
  it('stores sanitized HTML through the caller sanitizer', () => {
    const resource = defineResource({
      slug: 'md',
      label: 'MD',
      columns: [{ name: 'body', label: 'Body' }],
      fields: [
        {
          name: 'body',
          label: 'Body',
          type: 'markdown',
          sanitize: (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, ''),
        },
      ],
      list: async () => ({ rows: [], total: 0 }),
    });
    const parsed = resource.schema.safeParse({ body: '<p>hi</p><script>alert(1)</script>' });
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.body, '<p>hi</p>');
  });

  it('rejects a markdown field without a sanitize function', () => {
    assert.throws(
      () =>
        defineResource({
          slug: 'md2',
          label: 'MD2',
          columns: [{ name: 'body', label: 'Body' }],
          fields: [{ name: 'body', label: 'Body', type: 'markdown' }],
          list: async () => ({ rows: [], total: 0 }),
        }),
      ResourceError,
    );
  });
});

// ---------------------------------------------------------------------------
// Relation manager routes
// ---------------------------------------------------------------------------

describe('relation manager routes', () => {
  interface RMStore {
    rows: { readonly id: string; readonly text: string }[];
    creates: Array<{ parentId: string; values: Record<string, unknown> }>;
    deletes: Array<{ parentId: string; relatedId: string }>;
    listCalls: Array<{ parentId: string; page: number; pageSize: number }>;
  }

  function makeRMStore(rows: { readonly id: string; readonly text: string }[] = []): RMStore {
    return { rows: [...rows], creates: [], deletes: [], listCalls: [] };
  }

  function makeCommentRM(
    store: RMStore,
    overrides?: {
      create?: (ctx: RelationManagerCreateContext) => Promise<void>;
      delete?: (ctx: RelationManagerDeleteContext) => Promise<void>;
    },
  ) {
    const related = defineResource({
      slug: 'comments',
      label: 'Comments',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'text', label: 'Text' },
      ],
      fields: [{ name: 'text', label: 'Text', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    return defineRelationManager({
      name: 'post-comments',
      label: 'Comments',
      related,
      foreignKey: 'post_id',
      list: async ({ parentId, page, pageSize }: RelationManagerListContext) => {
        store.listCalls.push({ parentId, page, pageSize });
        return { rows: store.rows, total: store.rows.length };
      },
      create:
        overrides?.create ??
        (async ({ parentId, values }) => {
          store.creates.push({ parentId, values });
        }),
      delete:
        overrides?.delete ??
        (async ({ parentId, relatedId }) => {
          store.deletes.push({ parentId, relatedId });
        }),
    });
  }

  async function makeRMApp(
    resource: Resource,
    overrides?: { authorize?: (session: Session | null) => boolean },
  ): Promise<TestApplication> {
    return createTestApp({
      config: {
        port: 0,
        extensions: [
          adminPlugin(
            defineAdminPanel({
              resolveSession: () => SESSION,
              authorize: overrides?.authorize ?? (() => true),
              resources: [resource],
            }),
          ),
        ],
      },
    });
  }

  function postRMForm(
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

  it('GET lists related rows (escaped) for a parent', async () => {
    const store = makeRMStore([{ id: '1', text: '<script>alert(1)</script>' }]);
    const rm = makeCommentRM(store);
    const resource = makeArticleResource(makeStore(), { relationManagers: [rm] });
    const app = await makeRMApp(resource);

    const response = await app.request('/admin/articles/post-comments?parent=p1');
    assert.equal(response.status, 200);
    const body = await response.text();

    assert.match(body, /Comments/);
    assert.match(body, /Text/);
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script/);

    assert.equal(store.listCalls.length, 1);
    assert.equal(store.listCalls[0]!.parentId, 'p1');
    assert.equal(store.listCalls[0]!.page, 1);
    assert.equal(store.listCalls[0]!.pageSize, 20);

    await app.close();
  });

  it('POST create calls manager.create with session, CSRF, and parent', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = makeArticleResource(makeStore(), { relationManagers: [rm] });
    const app = await makeRMApp(resource);

    const response = await postRMForm(app, '/admin/articles/post-comments', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /parent=p1/);

    assert.equal(store.creates.length, 1);
    assert.equal(store.creates[0]!.parentId, 'p1');

    await app.close();
  });

  it('POST delete calls manager.delete with session, CSRF, parent, and relatedId', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = makeArticleResource(makeStore(), { relationManagers: [rm] });
    const app = await makeRMApp(resource);

    const response = await postRMForm(app, '/admin/articles/post-comments/42/delete', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /parent=p1/);

    assert.equal(store.deletes.length, 1);
    assert.equal(store.deletes[0]!.parentId, 'p1');
    assert.equal(store.deletes[0]!.relatedId, '42');

    await app.close();
  });

  it('rejects anon GET and POST with 403', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = makeArticleResource(makeStore(), { relationManagers: [rm] });
    const app = await makeRMApp(resource, { authorize: () => false });

    const listResponse = await app.request('/admin/articles/post-comments?parent=p1');
    assert.equal(listResponse.status, 403);

    const createResponse = await postRMForm(app, '/admin/articles/post-comments', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(createResponse.status, 403);

    const deleteResponse = await postRMForm(app, '/admin/articles/post-comments/1/delete', {
      _csrf: CSRF,
      _parent: 'p1',
    });
    assert.equal(deleteResponse.status, 403);

    assert.equal(store.creates.length, 0);
    assert.equal(store.deletes.length, 0);

    await app.close();
  });

  it('rejects create/delete POST without CSRF token', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = makeArticleResource(makeStore(), { relationManagers: [rm] });
    const app = await makeRMApp(resource);

    const noCsrf = await postRMForm(app, '/admin/articles/post-comments', {
      _parent: 'p1',
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(store.creates.length, 0);

    const wrongCsrf = await postRMForm(app, '/admin/articles/post-comments', {
      _csrf: 'wrong',
      _parent: 'p1',
    });
    assert.equal(wrongCsrf.status, 403);
    assert.equal(store.creates.length, 0);

    await app.close();
  });

  it('rejects a missing parent id with 400', async () => {
    const store = makeRMStore();
    const rm = makeCommentRM(store);
    const resource = makeArticleResource(makeStore(), { relationManagers: [rm] });
    const app = await makeRMApp(resource);

    const listResponse = await app.request('/admin/articles/post-comments');
    assert.equal(listResponse.status, 400);

    const createResponse = await postRMForm(app, '/admin/articles/post-comments', {
      _csrf: CSRF,
    });
    assert.equal(createResponse.status, 400);

    await app.close();
  });

  it('renders no create/delete forms when callbacks are absent', async () => {
    const store = makeRMStore();
    // Build a manager with no create/delete in the spec so the descriptor
    // carries undefined for both. The rendered forms must not appear.
    const related = defineResource({
      slug: 'plain-comments',
      label: 'Comments',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'text', label: 'Text' },
      ],
      fields: [{ name: 'text', label: 'Text', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'plain-comments',
      label: 'Comments',
      related,
      foreignKey: 'post_id',
      list: async ({ parentId, page, pageSize }: RelationManagerListContext) => {
        store.listCalls.push({ parentId, page, pageSize });
        return { rows: store.rows, total: store.rows.length };
      },
    });
    const resource = makeArticleResource(makeStore(), { relationManagers: [rm] });
    const app = await makeRMApp(resource);

    const listResponse = await app.request('/admin/articles/plain-comments?parent=p1');
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.text();
    assert.doesNotMatch(listBody, /admin-relation-create/);
    assert.doesNotMatch(listBody, /admin-relation-delete/);

    await app.close();
  });
});
