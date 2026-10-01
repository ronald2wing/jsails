/**
 * Admin breadth (part 2) tests: relation columns, repeater fields, infolists,
 * dashboard charts, and file fields.
 *
 * These drive the real admin plugin over an in-process `Application`, the same
 * way `admin-resource.test.ts` does. Each fixture resource is in-memory (no
 * ORM, no database, no listener) and exercises one breadth feature end to end:
 *
 * - a relation column resolves per-row labels (escaped) through its `resolve`;
 * - a repeater renders add/remove buttons, applies add/remove intents without
 *   saving, enforces `maxItems`, and validates through value-free messages;
 * - an infolist renders badge/boolean/date entries above the edit form;
 * - a chart renders its trusted SVG raw inside a dashboard card;
 * - a file field writes an uploaded part through a `resolveFileDisk` disk and
 *   stores the resulting key (or the basename when no disk is wired).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminPanelError,
  ChartError,
  ResourceError,
  adminPlugin,
  barChartSvg,
  defineAdminPanel,
  defineChart,
  defineResource,
  lineChartSvg,
  type Resource,
  type ResourceColumn,
  type ResourceField,
  type ResourceGetContext,
  type ResourceInfolist,
} from '../../src/admin/index.js';
import { defineAttachAction, defineDetachAction } from '../../src/admin/relation-actions.js';
import {
  defineRelationManager,
  RelationManagerError,
  renderRelationManager,
} from '../../src/admin/relation-manager.js';
import { createMemoryDisk } from '../../src/filesystem/index.js';
import type { Session } from '../../src/contracts/http.js';
import { renderFormPage } from '../../src/admin/resource/render.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};
const CSRF = SESSION.csrfToken;

interface PanelOverrides {
  readonly resources?: readonly Resource[];
  readonly charts?: Parameters<typeof defineAdminPanel>[0]['charts'];
}

async function makeApp(overrides: PanelOverrides = {}): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: () => true,
            ...(overrides.resources === undefined ? {} : { resources: overrides.resources }),
            ...(overrides.charts === undefined ? {} : { charts: overrides.charts }),
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

// ---------------------------------------------------------------------------
// Relation columns
// ---------------------------------------------------------------------------

describe('admin relation columns', () => {
  const RELATION_COLUMNS: readonly ResourceColumn[] = [
    { name: 'id', label: 'ID' },
    { name: 'title', label: 'Title' },
    {
      name: 'tags',
      label: 'Tags',
      type: 'relation',
      resolve: async (row) => (row['tags'] as string[]) ?? [],
    },
  ];

  function makeRelationResource(rows: readonly Record<string, unknown>[]): Resource {
    return defineResource({
      slug: 'posts',
      label: 'Posts',
      columns: RELATION_COLUMNS,
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows, total: rows.length }),
    });
  }

  it('renders resolved relation labels inside an admin-relation list', async () => {
    const app = await makeApp({
      resources: [
        makeRelationResource([
          { id: '1', title: 'First', tags: ['a', 'b'] },
          { id: '2', title: 'Second', tags: [] },
        ]),
      ],
    });

    const body = await (await app.request('/admin/posts')).text();
    assert.match(body, /admin-relation/);
    assert.match(body, /<li>a<\/li>/);
    assert.match(body, /<li>b<\/li>/);

    await app.close();
  });

  it('escapes hostile relation labels and renders empty for a resolver failure', async () => {
    const resource = defineResource({
      slug: 'posts',
      label: 'Posts',
      columns: [
        { name: 'id', label: 'ID' },
        {
          name: 'tags',
          label: 'Tags',
          type: 'relation',
          resolve: async (row) => {
            if (row['id'] === 'boom') throw new Error('boom');
            return [row['tags'] as string];
          },
        },
      ],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({
        rows: [
          { id: '1', tags: '<script>alert(1)</script>' },
          { id: 'boom', tags: 'nope' },
        ],
        total: 2,
      }),
    });
    const app = await makeApp({ resources: [resource] });

    const body = await (await app.request('/admin/posts')).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);
    assert.doesNotMatch(body, /nope/);

    await app.close();
  });

  it('rejects a relation column without resolve and resolve on a plain column', () => {
    const base = {
      slug: 'posts',
      label: 'Posts',
      fields: [{ name: 'title', label: 'Title', type: 'text' }] as readonly ResourceField[],
      list: async () => ({ rows: [], total: 0 }),
    };
    assert.throws(
      () =>
        defineResource({
          ...base,
          columns: [{ name: 'tags', label: 'Tags', type: 'relation' as const }],
        }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          columns: [{ name: 'title', label: 'Title', resolve: async () => [] }],
        }),
      ResourceError,
    );
  });
});

// ---------------------------------------------------------------------------
// Repeater fields
// ---------------------------------------------------------------------------

describe('admin repeater fields', () => {
  interface RepeaterStore {
    saves: Array<{ id: string | null; values: Record<string, unknown> }>;
  }

  const REPEATER_FIELDS: readonly ResourceField[] = [
    { name: 'title', label: 'Title', type: 'text' },
    {
      name: 'tags',
      label: 'Tags',
      type: 'repeater',
      repeater: {
        fields: [
          { name: 'name', label: 'Name', type: 'text' },
          { name: 'count', label: 'Count', type: 'number' },
        ],
      },
    },
  ];

  function makeRepeaterResource(store: RepeaterStore, maxItems?: number): Resource {
    return defineResource({
      slug: 'tags',
      label: 'Tags',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: REPEATER_FIELDS.map((field) =>
        field.type === 'repeater' && maxItems !== undefined
          ? { ...field, repeater: { ...field.repeater!, maxItems } }
          : field,
      ),
      list: async () => ({ rows: [], total: 0 }),
      save: async ({ id, values }) => {
        store.saves.push({ id, values });
      },
    });
  }

  it('renders the repeater with an item input, a Remove button, and an Add button', async () => {
    const app = await makeApp({ resources: [makeRepeaterResource({ saves: [] })] });

    const body = await (await app.request('/admin/tags/new')).text();
    assert.match(body, /name="tags\[0\]\.name"/);
    assert.match(body, /name="_repeater_add" value="tags"/);
    assert.match(body, /name="_repeater_remove" value="tags\.0"/);

    await app.close();
  });

  it('applies an add intent without saving, rendering a second item', async () => {
    const store: RepeaterStore = { saves: [] };
    const app = await makeApp({ resources: [makeRepeaterResource(store)] });

    const response = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': '1',
      _repeater_add: 'tags',
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /name="tags\[1\]\.name"/);
    assert.match(body, /value="a"/);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('applies a remove intent, renumbering the remaining items without saving', async () => {
    const store: RepeaterStore = { saves: [] };
    const app = await makeApp({ resources: [makeRepeaterResource(store)] });

    const response = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': '1',
      'tags[1].name': 'b',
      'tags[1].count': '2',
      _repeater_remove: 'tags.0',
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /name="tags\[0\]\.name"/);
    assert.match(body, /value="b"/);
    assert.match(body, /value="2"/);
    assert.doesNotMatch(body, /tags\[1\]\.name/);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('omits the Add button at maxItems and rejects an over-bound submission', async () => {
    const store: RepeaterStore = { saves: [] };
    const app = await makeApp({ resources: [makeRepeaterResource(store, 1)] });

    const form = await (await app.request('/admin/tags/new')).text();
    assert.doesNotMatch(form, /_repeater_add/);

    const response = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': '1',
      'tags[1].name': 'b',
      'tags[1].count': '2',
    });
    assert.equal(response.status, 422);
    assert.match(await response.text(), /Must have at most 1 items/);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('validates a repeater item value-free and coerces a valid save to an array', async () => {
    const store: RepeaterStore = { saves: [] };
    const app = await makeApp({ resources: [makeRepeaterResource(store)] });

    const invalid = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': 'not-a-number',
    });
    assert.equal(invalid.status, 422);
    assert.match(await invalid.text(), /Expected a number/);
    assert.equal(store.saves.length, 0);

    const valid = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': '5',
    });
    assert.equal(valid.status, 303);
    assert.deepEqual(store.saves[0]!.values['tags'], [{ name: 'a', count: 5 }]);

    await app.close();
  });

  it('rejects an empty, out-of-bounds, or non-scalar repeater config at defineResource time', () => {
    const base = {
      slug: 'tags',
      label: 'Tags',
      columns: [{ name: 'id', label: 'ID' }],
      list: async () => ({ rows: [], total: 0 }),
    };
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [{ name: 'tags', label: 'Tags', type: 'repeater', repeater: { fields: [] } }],
        }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'tags',
              label: 'Tags',
              type: 'repeater',
              repeater: {
                fields: [{ name: 'name', label: 'Name', type: 'text' }],
                maxItems: 0,
              },
            },
          ],
        }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'tags',
              label: 'Tags',
              type: 'repeater',
              repeater: {
                fields: [{ name: 'name', label: 'Name', type: 'file' as never }],
              },
            },
          ],
        }),
      ResourceError,
    );
    // `repeater` on a non-repeater field is rejected too.
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'x',
              label: 'X',
              type: 'text',
              repeater: { fields: [{ name: 'n', label: 'N', type: 'text' }] },
            },
          ],
        }),
      ResourceError,
    );
  });
});

// ---------------------------------------------------------------------------
// Infolists
// ---------------------------------------------------------------------------

describe('admin infolists', () => {
  const INFOLIST: ResourceInfolist = {
    label: 'Details',
    entries: [
      {
        name: 'status',
        label: 'Status',
        format: 'badge',
        colors: { open: 'green', closed: 'gray' },
      },
      {
        name: 'active',
        label: 'Active',
        format: 'boolean',
        colors: { true: 'green', false: 'red' },
      },
      { name: 'created', label: 'Created', format: 'date' },
    ],
  };

  function makeInfolistResource(): Resource {
    return defineResource({
      slug: 'items',
      label: 'Items',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
      get: async ({ id }: ResourceGetContext) => {
        if (id !== '1') return null;
        return {
          id: '1',
          title: 'Item',
          status: 'open',
          active: true,
          created: '2024-01-15T09:00:00.000Z',
        };
      },
      infolist: INFOLIST,
    });
  }

  it('renders badge, boolean, and date infolist entries above the edit form', async () => {
    const app = await makeApp({ resources: [makeInfolistResource()] });

    const body = await (await app.request('/admin/items/1')).text();
    assert.match(body, /admin-infolist/);
    assert.match(body, /Details/);
    assert.match(body, /admin-badge/);
    assert.match(body, />open</);
    assert.match(body, /green/);
    assert.match(body, /admin-boolean/);
    assert.match(body, /Yes/);
    assert.match(body, /admin-date/);
    assert.match(body, /2024-01-15/);

    await app.close();
  });

  it('omits the infolist from the create form (no record)', async () => {
    const app = await makeApp({ resources: [makeInfolistResource()] });

    const body = await (await app.request('/admin/items/new')).text();
    assert.doesNotMatch(body, /admin-infolist/);

    await app.close();
  });

  it('rejects an invalid infolist (empty entries, bad format, colors on date)', () => {
    const base = {
      slug: 'items',
      label: 'Items',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }] as readonly ResourceField[],
      list: async () => ({ rows: [], total: 0 }),
    };
    assert.throws(
      () => defineResource({ ...base, infolist: { label: 'D', entries: [] } }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          infolist: {
            label: 'D',
            entries: [{ name: 'x', label: 'X', format: 'bogus' as never }],
          },
        }),
      ResourceError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          infolist: {
            label: 'D',
            entries: [{ name: 'x', label: 'X', format: 'date', colors: { a: 'b' } }],
          },
        }),
      ResourceError,
    );
  });
});

// ---------------------------------------------------------------------------
// Column formats — image, icon, color, tags
// ---------------------------------------------------------------------------

describe('column formats', () => {
  it('renders an image cell as an <img> with the resolved src', async () => {
    const resource = defineResource({
      slug: 'media',
      label: 'Media',
      columns: [{ name: 'thumb', label: 'Thumb', format: 'image', imageBaseUrl: '/uploads/' }],
      fields: [{ name: 'thumb', label: 'Thumb', type: 'text' }],
      list: async () => ({ rows: [{ id: '1', thumb: 'a.png' }], total: 1 }),
    });
    const app = await makeApp({ resources: [resource] });
    const html = await (await app.request('/admin/media')).text();
    assert.match(html, /<img[^>]+src="\/uploads\/a\.png"/);
    await app.close();
  });

  it('renders a tags cell as one element per separator-split value', async () => {
    const resource = defineResource({
      slug: 'posts',
      label: 'Posts',
      columns: [{ name: 'tags', label: 'Tags', format: 'tags' }],
      fields: [{ name: 'tags', label: 'Tags', type: 'text' }],
      list: async () => ({ rows: [{ id: '1', tags: 'a,b' }], total: 1 }),
    });
    const app = await makeApp({ resources: [resource] });
    const html = await (await app.request('/admin/posts')).text();
    assert.match(html, /admin-tag[^>]*>a</);
    assert.match(html, /admin-tag[^>]*>b</);
    await app.close();
  });

  it('rejects an image format without imageBaseUrl', () => {
    assert.throws(
      () =>
        defineResource({
          slug: 'x',
          label: 'X',
          columns: [{ name: 'i', label: 'I', format: 'image' }],
          fields: [{ name: 'i', label: 'I', type: 'text' }],
          list: async () => ({ rows: [], total: 0 }),
        }),
      ResourceError,
    );
  });
});

// ---------------------------------------------------------------------------
// Dashboard charts
// ---------------------------------------------------------------------------

describe('admin dashboard charts', () => {
  it('renders a line chart SVG with its series labels inside a chart card', async () => {
    const app = await makeApp({
      charts: [
        defineChart({
          name: 'signups',
          label: 'Signups',
          render: () =>
            lineChartSvg([
              { label: 'Mon', value: 3 },
              { label: 'Tue', value: 7 },
            ]),
        }),
      ],
    });

    const body = await (await app.request('/admin')).text();
    assert.match(body, /admin-chart-card/);
    assert.match(body, /Signups/);
    assert.match(body, /<svg class="admin-chart"/);
    assert.match(body, /<polyline/);
    assert.match(body, />Mon</);
    assert.match(body, />Tue</);

    await app.close();
  });

  it('renders a bar chart SVG with rect bars', async () => {
    const app = await makeApp({
      charts: [
        defineChart({
          name: 'sales',
          label: 'Sales',
          render: () =>
            barChartSvg([
              { label: 'Jan', value: 4 },
              { label: 'Feb', value: 9 },
            ]),
        }),
      ],
    });

    const body = await (await app.request('/admin')).text();
    assert.match(body, /<svg class="admin-chart"/);
    assert.match(body, /<rect/);
    assert.match(body, />Jan</);
    assert.match(body, />Feb</);

    await app.close();
  });

  it('escapes hostile series labels in the SVG helpers', () => {
    const svg = lineChartSvg([{ label: '<b>X</b>', value: 1 }]);
    assert.doesNotMatch(svg, /<b>/);
    assert.match(svg, /&lt;b&gt;X&lt;\/b&gt;/);
  });

  it('renders an empty card when a chart render throws, without failing the page', async () => {
    const app = await makeApp({
      charts: [
        defineChart({
          name: 'broken',
          label: 'Broken',
          render: () => {
            throw new Error('boom');
          },
        }),
        defineChart({
          name: 'ok',
          label: 'Fine',
          render: () => lineChartSvg([{ label: 'A', value: 1 }]),
        }),
      ],
    });

    const response = await app.request('/admin');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Fine/);
    assert.match(body, /<svg class="admin-chart"/);

    await app.close();
  });

  it('rejects an invalid chart spec and duplicate chart names', async () => {
    assert.throws(() => defineChart({ name: ' ', label: 'x', render: () => '' }), ChartError);
    assert.throws(() => defineChart({ name: 'x', label: ' ', render: () => '' }), ChartError);
    assert.throws(
      () => defineChart({ name: 'x', label: 'x', render: undefined as never }),
      ChartError,
    );

    const charts = [
      defineChart({ name: 'dup', label: 'A', render: () => '' }),
      defineChart({ name: 'dup', label: 'B', render: () => '' }),
    ];
    await assert.rejects(() => makeApp({ charts }), AdminPanelError);
  });
});

// ---------------------------------------------------------------------------
// File fields
// ---------------------------------------------------------------------------

describe('admin file fields', () => {
  interface FileStore {
    saves: Array<{ id: string | null; values: Record<string, unknown> }>;
  }

  const FILE_FIELDS: readonly ResourceField[] = [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'attachment', label: 'Attachment', type: 'file', accept: 'image/*' },
  ];

  function makeFileResource(
    store: FileStore,
    resolveFileDisk?: Resource['resolveFileDisk'],
  ): Resource {
    return defineResource({
      slug: 'files',
      label: 'Files',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: FILE_FIELDS,
      list: async () => ({ rows: [], total: 0 }),
      save: async ({ id, values }) => {
        store.saves.push({ id, values });
      },
      ...(resolveFileDisk === undefined ? {} : { resolveFileDisk }),
    });
  }

  function fileForm(
    fields: Record<string, string>,
    file?: { name: string; type: string; bytes: Buffer },
  ): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    if (file !== undefined) {
      form.set(
        'attachment',
        new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
      );
    }
    return form;
  }

  it('renders a file input with its accept hint', async () => {
    const app = await makeApp({ resources: [makeFileResource({ saves: [] })] });

    const body = await (await app.request('/admin/files/new')).text();
    assert.match(body, /type="file"/);
    assert.match(body, /name="attachment"/);
    assert.match(body, /accept="image\/\*"/);

    await app.close();
  });

  it('writes the upload through the disk seam and stores the resulting key', async () => {
    const disk = createMemoryDisk();
    const store: FileStore = { saves: [] };
    const app = await makeApp({
      resources: [makeFileResource(store, () => disk)],
    });

    const response = await app.request('/admin/files', {
      method: 'POST',
      headers: { origin: app.origin },
      body: fileForm(
        { _csrf: CSRF, title: 'Report' },
        { name: 'report.txt', type: 'text/plain', bytes: Buffer.from('hello world') },
      ),
    });
    assert.equal(response.status, 303);

    assert.equal(store.saves.length, 1);
    assert.equal(store.saves[0]!.values['attachment'], 'attachment/report.txt');
    assert.deepEqual(await disk.list(), ['attachment/report.txt']);
    assert.deepEqual(
      await disk.get('attachment/report.txt'),
      new Uint8Array(Buffer.from('hello world')),
    );

    await app.close();
  });

  it('stores the sanitized basename when no disk is wired', async () => {
    const store: FileStore = { saves: [] };
    const app = await makeApp({ resources: [makeFileResource(store)] });

    const response = await app.request('/admin/files', {
      method: 'POST',
      headers: { origin: app.origin },
      body: fileForm(
        { _csrf: CSRF, title: 'Report' },
        { name: '../../etc/report.txt', type: 'text/plain', bytes: Buffer.from('x') },
      ),
    });
    assert.equal(response.status, 303);
    // The basename is kept (path separators are stripped), never a traversal path.
    assert.equal(store.saves[0]!.values['attachment'], 'report.txt');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Relation managers
// ---------------------------------------------------------------------------

describe('relation managers', () => {
  it('defineRelationManager validates and freezes its descriptor', () => {
    const related = defineResource({
      slug: 'comments',
      label: 'Comments',
      columns: [{ name: 'body', label: 'Body' }],
      fields: [{ name: 'body', label: 'Body', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'comments',
      label: 'Comments',
      related,
      foreignKey: 'postId',
      list: async () => ({ rows: [{ id: 'c1', body: 'hi' }], total: 1 }),
    });
    assert.equal(Object.isFrozen(rm), true);
    assert.equal(rm.foreignKey, 'postId');
  });

  it('rejects a relation manager with an empty foreignKey', () => {
    const related = defineResource({
      slug: 'r',
      label: 'R',
      columns: [{ name: 'x', label: 'X' }],
      fields: [{ name: 'x', label: 'X', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    assert.throws(
      () =>
        defineRelationManager({
          name: 'r',
          label: 'R',
          related,
          foreignKey: '',
          list: async () => ({ rows: [], total: 0 }),
        }),
      RelationManagerError,
    );
  });

  it('renderRelationManager escapes related cell values', () => {
    const related = defineResource({
      slug: 'r2',
      label: 'R2',
      columns: [{ name: 'x', label: 'X' }],
      fields: [{ name: 'x', label: 'X', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'r2',
      label: 'R2',
      related,
      foreignKey: 'p',
      list: async () => ({ rows: [], total: 0 }),
    });
    const html = renderRelationManager(rm, [{ id: '1', x: '<script>' }], 'p1', {
      panelPath: '/admin',
      resourceSlug: 'test',
      csrfToken: 'csrf-test',
    });
    // Preact entity-encodes `<` and `&` in text content; `>` is safe in
    // non-attribute contexts and may remain literal. Verify the critical
    // guard: the raw `<script>` tag is never emitted.
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});

// ---------------------------------------------------------------------------
// Attach/detach actions
// ---------------------------------------------------------------------------

describe('attach/detach actions', () => {
  it('defineAttachAction defaults name/label and calls attach with record ids', async () => {
    const related = defineResource({
      slug: 'tags',
      label: 'Tags',
      columns: [{ name: 'name', label: 'Name' }],
      fields: [{ name: 'name', label: 'Name', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const manager = defineRelationManager({
      name: 'tags',
      label: 'Tags',
      related,
      foreignKey: 'postId',
      list: async () => ({ rows: [], total: 0 }),
    });
    const seen: string[][] = [];
    const action = defineAttachAction({
      manager,
      attach: async ({ relatedIds }) => {
        seen.push([...relatedIds]);
      },
    });
    assert.equal(action.name, 'attach');
    await action.run({ session: SESSION, path: '/admin' }, [{ id: 't1' }, { id: 't2' }]);
    assert.deepEqual(seen, [['t1', 't2']]);
  });

  it('defineDetachAction defaults its label', () => {
    const related = defineResource({
      slug: 'tags2',
      label: 'Tags2',
      columns: [{ name: 'name', label: 'Name' }],
      fields: [{ name: 'name', label: 'Name', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const manager = defineRelationManager({
      name: 'tags2',
      label: 'Tags2',
      related,
      foreignKey: 'postId',
      list: async () => ({ rows: [], total: 0 }),
    });
    assert.equal(defineDetachAction({ manager, detach: async () => {} }).label, 'Detach');
  });
});

// ---------------------------------------------------------------------------
// Autocomplete fields
// ---------------------------------------------------------------------------

describe('admin autocomplete fields', () => {
  const BASE = {
    slug: 'items',
    label: 'Items',
    columns: [{ name: 'id', label: 'ID' }] as readonly ResourceColumn[],
    list: async () => ({ rows: [], total: 0 }),
  };

  it('validates the autocomplete config: search must be a function, minChars >= 1', () => {
    // No autocomplete config on an autocomplete field
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [{ name: 'tag', label: 'Tag', type: 'autocomplete' }] as readonly ResourceField[],
        }),
      ResourceError,
    );
    // search not a function
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [
            {
              name: 'tag',
              label: 'Tag',
              type: 'autocomplete',
              autocomplete: { search: 'not-a-function' as never },
            },
          ] as readonly ResourceField[],
        }),
      ResourceError,
    );
    // minChars < 1
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [
            {
              name: 'tag',
              label: 'Tag',
              type: 'autocomplete',
              autocomplete: { search: async () => [], minChars: 0 },
            },
          ] as readonly ResourceField[],
        }),
      ResourceError,
    );
    // minChars non-integer
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [
            {
              name: 'tag',
              label: 'Tag',
              type: 'autocomplete',
              autocomplete: { search: async () => [], minChars: 1.5 },
            },
          ] as readonly ResourceField[],
        }),
      ResourceError,
    );
    // Valid spec (defaults minChars to 2)
    const r = defineResource({
      ...BASE,
      fields: [
        {
          name: 'tag',
          label: 'Tag',
          type: 'autocomplete',
          autocomplete: { search: async () => [] },
        },
      ] as readonly ResourceField[],
    });
    assert.equal(r.fields[0]!.type, 'autocomplete');
    assert.equal(r.fields[0]!.autocomplete!.search !== undefined, true);
    // Valid spec with explicit minChars
    const r2 = defineResource({
      ...BASE,
      fields: [
        {
          name: 'tag',
          label: 'Tag',
          type: 'autocomplete',
          autocomplete: { search: async () => [], minChars: 3 },
        },
      ] as readonly ResourceField[],
    });
    assert.equal(r2.fields[0]!.autocomplete!.minChars, 3);
  });

  it('rejects autocomplete config on a non-autocomplete field', () => {
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [
            {
              name: 'tag',
              label: 'Tag',
              type: 'text',
              autocomplete: { search: async () => [] },
            },
          ] as readonly ResourceField[],
        }),
      ResourceError,
    );
  });

  it('renders an autocomplete field as a text input with the data marker', async () => {
    const resource = defineResource({
      ...BASE,
      fields: [
        {
          name: 'tag',
          label: 'Tag',
          type: 'autocomplete',
          autocomplete: { search: async () => [], minChars: 3 },
        },
      ] as readonly ResourceField[],
    });
    const app = await makeApp({ resources: [resource] });

    const body = await (await app.request('/admin/items/new')).text();
    assert.match(body, /type="text"/);
    assert.match(body, /name="tag"/);
    assert.match(body, /data-jsails-autocomplete/);

    await app.close();
  });

  it('escapes a hostile query value in the autocomplete input', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = defineResource({
      ...BASE,
      fields: [
        {
          name: 'tag',
          label: 'Tag',
          type: 'autocomplete',
          autocomplete: { search: async () => [] },
        },
      ] as readonly ResourceField[],
    });
    const html = renderFormPage(panel, resource, {
      id: null,
      values: { tag: '<script>alert(1)</script>' },
      errors: {},
      csrf: 'csrf-test',
      action: '/admin/items',
      back: '',
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});

// ---------------------------------------------------------------------------
// Formsets
// ---------------------------------------------------------------------------

describe('admin formsets', () => {
  const FORMSET_FIELDS: readonly ResourceField[] = [
    { name: 'title', label: 'Title', type: 'text' },
    {
      name: 'addresses',
      label: 'Addresses',
      type: 'repeater',
      formset: {
        fields: [
          { name: 'street', label: 'Street', type: 'text' },
          { name: 'city', label: 'City', type: 'text' },
          { name: 'zip', label: 'ZIP', type: 'number' },
        ],
      },
    },
  ];

  function makeFormsetResource(saveStore: Array<Record<string, unknown>>): Resource {
    return defineResource({
      slug: 'contacts',
      label: 'Contacts',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: FORMSET_FIELDS,
      list: async () => ({ rows: [], total: 0 }),
      save: async ({ values }) => {
        saveStore.push(values);
      },
    });
  }

  it('rejects minItems > maxItems at defineResource time', () => {
    const base = {
      slug: 'c',
      label: 'C',
      columns: [{ name: 'id', label: 'ID' }] as readonly ResourceColumn[],
      list: async () => ({ rows: [], total: 0 }),
    };
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'addrs',
              label: 'Addrs',
              type: 'repeater',
              formset: {
                fields: [{ name: 'street', label: 'Street', type: 'text' }],
                minItems: 5,
                maxItems: 2,
              },
            },
          ] as readonly ResourceField[],
        }),
      ResourceError,
    );
    // formset on a non-repeater field is rejected.
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'x',
              label: 'X',
              type: 'text',
              formset: { fields: [{ name: 'n', label: 'N', type: 'text' }] },
            },
          ] as readonly ResourceField[],
        }),
      ResourceError,
    );
    // both repeater and formset on the same field is rejected.
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'addrs',
              label: 'Addrs',
              type: 'repeater',
              repeater: {
                fields: [{ name: 'street', label: 'Street', type: 'text' }],
              },
              formset: {
                fields: [{ name: 'street', label: 'Street', type: 'text' }],
              },
            },
          ] as readonly ResourceField[],
        }),
      ResourceError,
    );
    // empty formset fields is rejected.
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'addrs',
              label: 'Addrs',
              type: 'repeater',
              formset: { fields: [] },
            },
          ] as readonly ResourceField[],
        }),
      ResourceError,
    );
  });

  it('renders formset rows with flat-key inputs, an Add button, and a Remove button', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = makeFormsetResource([]);
    const html = renderFormPage(panel, resource, {
      id: null,
      values: {},
      errors: {},
      csrf: 'csrf-test',
      action: '/admin/contacts',
      back: '',
    });
    assert.match(html, /name="addresses\[0\]\.street"/);
    assert.match(html, /name="addresses\[0\]\.city"/);
    assert.match(html, /name="addresses\[0\]\.zip"/);
    assert.match(html, /name="_repeater_add" value="addresses"/);
    assert.match(html, /name="_repeater_remove" value="addresses\.0"/);
  });

  it('reuses flat-key lifting: submitted formset keys are lifted into an array', () => {
    const resource = defineResource({
      slug: 'contacts',
      label: 'Contacts',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ] as readonly ResourceColumn[],
      fields: FORMSET_FIELDS,
      list: async () => ({ rows: [], total: 0 }),
    });
    const result = resource.schema.parse({
      title: 'T',
      'addresses[0].street': 'Main',
      'addresses[0].city': 'Springfield',
      'addresses[0].zip': '12345',
    });
    assert.deepEqual(result, {
      title: 'T',
      addresses: [{ street: 'Main', city: 'Springfield', zip: 12345 }],
    });
  });

  it('escapes a hostile value in a formset item input', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = makeFormsetResource([]);
    const html = renderFormPage(panel, resource, {
      id: null,
      values: { 'addresses[0].street': '<script>alert(1)</script>' },
      errors: {},
      csrf: 'csrf-test',
      action: '/admin/contacts',
      back: '',
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});

// ---------------------------------------------------------------------------
// Inline relation managers on the edit page
// ---------------------------------------------------------------------------

describe('admin inline relation managers', () => {
  const INLINE_COLUMNS: readonly ResourceColumn[] = [
    { name: 'id', label: 'ID' },
    { name: 'title', label: 'Title' },
  ];

  it('renderFormPage embeds relationManagerHtml strings with admin-relation-inline class', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = defineResource({
      slug: 'articles',
      label: 'Articles',
      columns: INLINE_COLUMNS,
      fields: [{ name: 'title', label: 'Title', type: 'text' }] as readonly ResourceField[],
      list: async () => ({ rows: [], total: 0 }),
    });
    const inlineHtml = renderRelationManager(
      defineRelationManager({
        name: 'comments',
        label: 'Comments',
        related: defineResource({
          slug: 'comments',
          label: 'Comments',
          columns: [{ name: 'body', label: 'Body' }],
          fields: [{ name: 'body', label: 'Body', type: 'text' }],
          list: async () => ({ rows: [], total: 0 }),
        }),
        foreignKey: 'articleId',
        list: async () => ({ rows: [{ id: 'c1', body: 'Great post' }], total: 1 }),
      }),
      [{ id: 'c1', body: 'Great post' }],
      'a1',
      {
        panelPath: '/admin',
        resourceSlug: 'articles',
        csrfToken: 'csrf-test',
      },
    );

    const html = renderFormPage(panel, resource, {
      id: 'a1',
      record: { id: 'a1', title: 'My Article' },
      values: {},
      errors: {},
      csrf: 'csrf-test',
      action: '/admin/articles/a1',
      back: '',
      relationManagerHtml: [inlineHtml],
    });
    assert.match(html, /admin-relation-inline/);
    assert.match(html, /admin-relation-manager/);
    assert.match(html, /Great post/);
  });

  it('renderFormPage escapes hostile relation manager content passed inline', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = defineResource({
      slug: 'articles',
      label: 'Articles',
      columns: INLINE_COLUMNS,
      fields: [{ name: 'title', label: 'Title', type: 'text' }] as readonly ResourceField[],
      list: async () => ({ rows: [], total: 0 }),
    });
    // renderRelationManager already escapes cell values (tested earlier), so a
    // hostile value becomes &lt;script&gt; in the HTML string. When we embed
    // that via dangerouslySetInnerHTML the raw <script> is never present.
    const inlineHtml = renderRelationManager(
      defineRelationManager({
        name: 'comments',
        label: 'Comments',
        related: defineResource({
          slug: 'comments',
          label: 'Comments',
          columns: [{ name: 'body', label: 'Body' }],
          fields: [{ name: 'body', label: 'Body', type: 'text' }],
          list: async () => ({ rows: [], total: 0 }),
        }),
        foreignKey: 'articleId',
        list: async () => ({ rows: [{ id: 'c1', body: '<script>alert(1)</script>' }], total: 1 }),
      }),
      [{ id: 'c1', body: '<script>alert(1)</script>' }],
      'a1',
      {
        panelPath: '/admin',
        resourceSlug: 'articles',
        csrfToken: 'csrf-test',
      },
    );
    // renderRelationManager already escapes — verify the inline wrapper still
    // produces safe output.
    assert.doesNotMatch(inlineHtml, /<script>/);
    assert.match(inlineHtml, /&lt;script/);

    const html = renderFormPage(panel, resource, {
      id: 'a1',
      record: { id: 'a1', title: 'My Article' },
      values: {},
      errors: {},
      csrf: 'csrf-test',
      action: '/admin/articles/a1',
      back: '',
      relationManagerHtml: [inlineHtml],
    });
    assert.match(html, /admin-relation-inline/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});
