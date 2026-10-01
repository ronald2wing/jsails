/**
 * Admin panel/plugin foundation tests.
 *
 * These drive the admin plugin through a real in-process `Application`: the
 * plugin registers trusted Hono hook routes, and each request is routed through
 * the same pipeline `serve` uses. No browser, database, Valkey, or listener is
 * involved. The auth gate is proven default-deny per request (null session,
 * throwing/rejecting resolver, truthy non-boolean or throwing authorize all
 * yield a value-free 403), the page routes (GET render, POST origin/CSRF
 * gating, `handlePost` delegation, 404 catch-all) and the grouped/sorted
 * dashboard navigation are exercised, panel path validation is asserted to
 * throw `AdminPanelError`, and the public helper exports are proven to behave.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADMIN_THEMES,
  AdminPanelError,
  DEFAULT_ADMIN_PATH,
  DEFAULT_ADMIN_THEME,
  DEFAULT_ADMIN_TITLE,
  adminHtmlResponse,
  adminPlugin,
  adminRedirectResponse,
  assertAdminMutation,
  assertAdminSession,
  defineAdminPage,
  defineAdminPanel,
  defineResource,
  readFormBody,
  renderAdminDocument,
  renderAdminDocumentWithTheme,
  type AdminTheme,
  type AdminThemeCustomization,
  type Resource,
} from '../../src/admin/index.js';
import type { Session } from '../../src/contracts/http.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

interface PanelOptions {
  readonly path?: string;
  readonly title?: string;
  readonly theme?: AdminTheme;
  readonly resolveSession?: (request: Request) => Session | null | Promise<Session | null>;
  readonly authorize?: (session: Session | null) => boolean | Promise<boolean>;
  readonly pages?: Parameters<typeof defineAdminPage>[0][];
}

function makeApp(options: PanelOptions = {}): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: options.resolveSession ?? (() => SESSION),
            authorize: options.authorize ?? (() => true),
            ...(options.path === undefined ? {} : { path: options.path }),
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.theme === undefined ? {} : { theme: options.theme }),
            ...(options.pages === undefined ? {} : { pages: options.pages.map(defineAdminPage) }),
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

describe('admin auth gate', () => {
  it('denies when the session resolver returns null', async () => {
    const app = await makeApp({
      resolveSession: () => null,
      authorize: (session) => session !== null,
    });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('denies when the session resolver throws (fail closed)', async () => {
    const app = await makeApp({
      resolveSession: () => {
        throw new Error('boom');
      },
      authorize: () => true,
    });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('denies a truthy non-boolean authorize result', async () => {
    const app = await makeApp({
      // Cast a deliberately wrong return type through `unknown` so the gate's
      // runtime "exact true only" check is exercised against a truthy non-boolean.
      authorize: (() => 'yes') as unknown as (session: Session | null) => boolean,
    });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('denies when authorize throws', async () => {
    const app = await makeApp({
      authorize: () => {
        throw new Error('nope');
      },
    });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('denies a non-admin (authorize resolves false)', async () => {
    const app = await makeApp({ authorize: () => false });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('does not leak a distinguishing 404 for an unauthorized nested probe', async () => {
    const app = await makeApp({
      authorize: () => false,
      pages: [{ slug: 'settings', label: 'Settings', render: () => 'x' }],
    });
    const response = await app.request(`${DEFAULT_ADMIN_PATH}/settings`);
    assert.equal(response.status, 403);
    await app.close();
  });

  it('does not leak a session id in the forbidden body', async () => {
    const app = await makeApp({ authorize: () => false });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    const body = await response.text();
    assert.equal(body.includes(SESSION.id), false);
    await app.close();
  });
});

describe('admin page routes', () => {
  it('renders a page for an authorized request', async () => {
    const app = await makeApp({
      title: 'My Admin',
      pages: [{ slug: 'settings', label: 'Settings', render: () => '<h1>Settings page</h1>' }],
    });
    const response = await app.request(`${DEFAULT_ADMIN_PATH}/settings`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /Settings page/);
    await app.close();
  });

  it('serves the dashboard for an authorized request', async () => {
    const app = await makeApp({ title: 'My Admin' });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const body = await response.text();
    assert.match(body, /My Admin/);
    await app.close();
  });

  it('uses the default title when none is supplied', async () => {
    const app = await makeApp();
    const response = await app.request(DEFAULT_ADMIN_PATH);
    const body = await response.text();
    assert.match(body, new RegExp(DEFAULT_ADMIN_TITLE));
    await app.close();
  });

  it('returns a 404 for an authorized unknown path', async () => {
    const app = await makeApp();
    const response = await app.request(`${DEFAULT_ADMIN_PATH}/does-not-exist`);
    assert.equal(response.status, 404);
    await app.close();
  });

  it('rejects a POST to a page without a handlePost with 405', async () => {
    const app = await makeApp({
      pages: [{ slug: 'settings', label: 'Settings', render: () => 'x' }],
    });
    const response = await postForm(app, `${DEFAULT_ADMIN_PATH}/settings`, {
      _csrf: SESSION.csrfToken,
    });
    assert.equal(response.status, 405);
    await app.close();
  });

  it('rejects a page POST without a same-origin Origin or a valid CSRF token', async () => {
    const app = await makeApp({
      pages: [
        {
          slug: 'settings',
          label: 'Settings',
          render: () => 'x',
          handlePost: () => adminHtmlResponse('ok'),
        },
      ],
    });

    const noOrigin = await app.request(`${DEFAULT_ADMIN_PATH}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: SESSION.csrfToken }).toString(),
    });
    assert.equal(noOrigin.status, 403);

    const badCsrf = await postForm(app, `${DEFAULT_ADMIN_PATH}/settings`, {
      _csrf: 'wrong-token',
    });
    assert.equal(badCsrf.status, 403);

    await app.close();
  });

  it('delegates a page POST to handlePost with the parsed body', async () => {
    const app = await makeApp({
      pages: [
        {
          slug: 'echo',
          label: 'Echo',
          render: () => 'x',
          handlePost: (context) => adminHtmlResponse(`<p>got ${context.body['name'] ?? ''}</p>`),
        },
      ],
    });

    const response = await postForm(app, `${DEFAULT_ADMIN_PATH}/echo`, {
      _csrf: SESSION.csrfToken,
      name: 'world',
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /got world/);

    await app.close();
  });

  it('mounts under a custom path and leaves the default unmatched', async () => {
    const app = await makeApp({ path: '/panel' });
    assert.equal((await app.request('/panel')).status, 200);
    assert.equal((await app.request(DEFAULT_ADMIN_PATH)).status, 404);
    await app.close();
  });
});

describe('admin navigation', () => {
  it('renders grouped, sorted navigation with badges', async () => {
    const app = await makeApp({
      title: 'My Admin',
      pages: [
        { slug: 'overview', label: 'Overview', sort: 10, render: () => 'overview' },
        { slug: 'users', label: 'Users', group: 'Configuration', sort: 5, render: () => 'users' },
        {
          slug: 'settings',
          label: 'Settings',
          group: 'Configuration',
          sort: 0,
          render: () => 'settings',
        },
        { slug: 'badges', label: 'Badges', badge: 'NEW', render: () => 'badges' },
      ],
    });

    const response = await app.request(DEFAULT_ADMIN_PATH);
    const body = await response.text();

    assert.match(body, /<h2>Configuration<\/h2>/);
    assert.match(body, /NEW/);
    // Within a group, entries sort by weight then label.
    assert.ok(body.indexOf('Settings') < body.indexOf('Users'), 'Settings before Users');
    assert.ok(body.indexOf('Badges') < body.indexOf('Overview'), 'Badges before Overview');
    assert.ok(body.indexOf('Overview') < body.indexOf('Configuration'), 'top-level before groups');

    await app.close();
  });
});

describe('admin helpers', () => {
  it('renders a full document with a title', () => {
    const html = renderAdminDocument('Hello');
    assert.match(html, /<title>Hello<\/title>/);
  });

  it('wraps HTML in a no-store response with the given status', () => {
    const response = adminHtmlResponse('<p>x</p>', 201);
    assert.equal(response.status, 201);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('produces a 303 redirect by default', () => {
    const response = adminRedirectResponse('/somewhere');
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/somewhere');
  });

  it('parses a form body and drops dangerous prototype keys', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ a: '1', __proto__: 'evil' }).toString(),
    });
    const body = await readFormBody(request);
    assert.deepEqual(body, { a: '1' });
  });

  it('asserts a same-origin, CSRF-matching mutation', () => {
    const request = new Request('http://localhost/x', {
      headers: { origin: 'http://localhost' },
    });
    assert.equal(assertAdminMutation(request, SESSION, { _csrf: SESSION.csrfToken }), true);
    assert.equal(assertAdminMutation(request, SESSION, { _csrf: 'wrong' }), false);
    assert.equal(assertAdminMutation(request, SESSION, {}), false);
  });

  it('resolves and authorizes the admin session, failing closed', async () => {
    const request = new Request('http://localhost/x');
    const allow = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    assert.deepEqual(await assertAdminSession(allow, request), SESSION);

    const deny = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => false,
    });
    assert.equal(await assertAdminSession(deny, request), null);
  });
});

describe('admin theme', () => {
  it('sets the requested data-theme on the dashboard document', async () => {
    const app = await makeApp({ theme: 'dark' });
    const body = await (await app.request(DEFAULT_ADMIN_PATH)).text();
    assert.match(body, /<html[^>]*data-theme="dark"/);
    assert.match(body, /--jsails-bg/);
    await app.close();
  });

  it('defaults the theme to system when omitted', async () => {
    const app = await makeApp();
    const body = await (await app.request(DEFAULT_ADMIN_PATH)).text();
    assert.match(body, new RegExp(`data-theme="${DEFAULT_ADMIN_THEME}"`));
    await app.close();
  });

  it('threads the theme into a page render context and the 404 catch-all', async () => {
    let capturedTheme: AdminTheme | undefined;
    const app = await makeApp({
      theme: 'light',
      pages: [
        {
          slug: 'settings',
          label: 'Settings',
          render: (context) => {
            capturedTheme = context.theme;
            return '<h1>Settings</h1>';
          },
        },
      ],
    });

    // A page receives the resolved theme on its render context (the page owns
    // its own document shell; the framework does not wrap arbitrary page HTML).
    const page = await (await app.request(`${DEFAULT_ADMIN_PATH}/settings`)).text();
    assert.match(page, /Settings/);
    assert.equal(capturedTheme, 'light');

    // The framework-owned 404 catch-all is themed.
    const missing = await (await app.request(`${DEFAULT_ADMIN_PATH}/nope`)).text();
    assert.match(missing, /<html[^>]*data-theme="light"/);

    await app.close();
  });

  it('accepts every recognized theme value and rejects anything else', () => {
    const valid = { resolveSession: () => SESSION, authorize: () => true };
    for (const theme of ADMIN_THEMES) {
      assert.doesNotThrow(() => defineAdminPanel({ ...valid, theme }));
    }
    assert.throws(() => defineAdminPanel({ ...valid, theme: 'neon' as never }), AdminPanelError);
    assert.throws(() => defineAdminPanel({ ...valid, theme: 3 as never }), AdminPanelError);
  });

  it('renderAdminDocument omits the attribute when theme is undefined', () => {
    const html = renderAdminDocument('Hi', undefined);
    assert.doesNotMatch(html, /<html[^>]*data-theme/);
    assert.match(html, /--jsails-bg/);
  });
});

describe('admin panel option validation', () => {
  const valid = {
    resolveSession: () => SESSION,
    authorize: () => true,
  };

  it('rejects a missing options object', () => {
    assert.throws(() => defineAdminPanel(undefined as never), AdminPanelError);
  });

  it('rejects a missing resolveSession', () => {
    assert.throws(() => defineAdminPanel({ authorize: () => true }), AdminPanelError);
  });

  it('rejects a missing authorize', () => {
    assert.throws(
      () => defineAdminPanel({ resolveSession: () => SESSION } as never),
      AdminPanelError,
    );
  });

  it('rejects a reserved, malformed, or relative path', () => {
    for (const path of [
      '/',
      '/admin/',
      '/_jsails',
      '/_jsails/x',
      'admin',
      '/admin//x',
      '/ad\nmin',
      '/ad\\min',
    ]) {
      assert.throws(
        () => defineAdminPanel({ ...valid, path }),
        AdminPanelError,
        `path ${JSON.stringify(path)} must be rejected`,
      );
    }
  });

  it('accepts a valid custom path', () => {
    assert.doesNotThrow(() => defineAdminPanel({ ...valid, path: '/panel/admin' }));
  });

  it('returns a deeply frozen descriptor', () => {
    const panel = defineAdminPanel({
      ...valid,
      pages: [defineAdminPage({ slug: 'x', label: 'X', render: () => 'x' })],
    });
    assert.equal(Object.isFrozen(panel), true);
    assert.equal(Object.isFrozen(panel.pages), true);
  });
});

// ---------------------------------------------------------------------------
// Global search
// ---------------------------------------------------------------------------

describe('admin global search', () => {
  type Article = {
    readonly id: string;
    readonly title: string;
  };

  const ARTICLES: Article[] = [
    { id: '1', title: 'First post' },
    { id: '2', title: 'Second post' },
    { id: '3', title: 'Hidden post' },
  ];

  function makeSearchableArticles(
    rows: Article[] = ARTICLES,
    authorize?: (session: Session, action: string, recordId?: string) => boolean,
  ): Resource {
    return defineResource({
      slug: 'articles',
      label: 'Articles',
      columns: [
        { name: 'title', label: 'Title', searchable: true },
        { name: 'id', label: 'ID' },
      ],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async ({ search }) => {
        const term = search ?? '';
        const filtered = term === '' ? rows : rows.filter((r) => r.title.includes(term));
        return { rows: filtered, total: filtered.length };
      },
      get: async ({ id }) => rows.find((r) => r.id === id) ?? null,
      ...(authorize === undefined
        ? {}
        : {
            authorize: (context: { session: Session; action: string; recordId?: string }) =>
              authorize(context.session, context.action, context.recordId),
          }),
    });
  }

  function makeNonSearchableNotes(): Resource {
    return defineResource({
      slug: 'notes',
      label: 'Notes',
      columns: [{ name: 'title', label: 'Title' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: [{ id: 'n1', title: 'A note' }], total: 1 }),
    });
  }

  async function makeSearchApp(resources: Resource[]): Promise<TestApplication> {
    return createTestApp({
      config: {
        port: 0,
        extensions: [
          adminPlugin(
            defineAdminPanel({
              resolveSession: () => SESSION,
              authorize: () => true,
              resources,
            }),
          ),
        ],
      },
    });
  }

  it('searches searchable resources and links matching rows', async () => {
    const app = await makeSearchApp([makeSearchableArticles()]);

    const body = await (await app.request('/admin/_search?q=Second')).text();
    assert.match(body, /Articles/);
    assert.match(body, /Second post/);
    assert.match(body, /\/admin\/articles\/2/);
    assert.doesNotMatch(body, /First post/);

    await app.close();
  });

  it('skips resources without a searchable column', async () => {
    const app = await makeSearchApp([makeSearchableArticles(), makeNonSearchableNotes()]);

    const body = await (await app.request('/admin/_search?q=post')).text();
    assert.match(body, /Articles/);
    assert.doesNotMatch(body, /Notes/);
    assert.doesNotMatch(body, /A note/);

    await app.close();
  });

  it('excludes rows the session may not view', async () => {
    const app = await makeSearchApp([
      makeSearchableArticles(ARTICLES, (_session, action, recordId) =>
        action === 'view' ? recordId !== '3' : true,
      ),
    ]);

    const body = await (await app.request('/admin/_search?q=post')).text();
    assert.match(body, /First post/);
    assert.doesNotMatch(body, /Hidden post/);

    await app.close();
  });

  it('skips a resource whose list throws instead of failing the page', async () => {
    const throwing = defineResource({
      slug: 'broken',
      label: 'Broken',
      columns: [{ name: 'title', label: 'Title', searchable: true }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => {
        throw new Error('boom');
      },
    });
    const app = await makeSearchApp([throwing, makeSearchableArticles()]);

    const response = await app.request('/admin/_search?q=post');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Articles/);
    assert.doesNotMatch(body, /Broken/);

    await app.close();
  });

  it('escapes a hostile search term in the form and never echoes it raw', async () => {
    const app = await makeSearchApp([makeSearchableArticles()]);

    const body = await (await app.request('/admin/_search?q=<script>alert(1)</script>')).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Admin theme customization seam
// ---------------------------------------------------------------------------

describe('admin theme customization', () => {
  it('renders byte-identical to the default when no themeCustomization is set', () => {
    const normal = renderAdminDocument('Test', 'system');
    const withTheme = renderAdminDocumentWithTheme({ title: 'Test', theme: 'system' });
    assert.equal(normal, withTheme);
    // The default theme CSS is always present.
    assert.match(normal, /--jsails-bg/);
    assert.match(withTheme, /--jsails-bg/);
  });

  it('appends custom CSS after the default theme CSS', () => {
    const html = renderAdminDocumentWithTheme({
      title: 'X',
      themeCustomization: { css: 'body { font-size: 20px; }' },
    });
    const styleContent = html.match(/<style>(.*?)<\/style>/s)?.[1] ?? '';
    const defaultIndex = styleContent.indexOf('--jsails-bg');
    const customIndex = styleContent.indexOf('font-size: 20px');
    assert.ok(customIndex > defaultIndex, 'custom CSS must appear after default theme CSS');
  });

  it('serializes a token map as a :root rule after the default CSS', () => {
    const html = renderAdminDocumentWithTheme({
      title: 'X',
      themeCustomization: { tokens: { '--jsails-bg': '#123456' } },
    });
    const styleContent = html.match(/<style>(.*?)<\/style>/s)?.[1] ?? '';
    assert.match(styleContent, /:root \{ --jsails-bg: #123456; \}/);
    const defaultEnd = styleContent.indexOf('body { margin');
    const tokenStart = styleContent.indexOf(':root { --jsails-bg: #123456; }');
    assert.ok(tokenStart > defaultEnd, 'token rule must appear after default theme CSS');
  });

  it('merges both css and tokens, with tokens last', () => {
    const html = renderAdminDocumentWithTheme({
      title: 'X',
      themeCustomization: {
        css: 'body { font-size: 20px; }',
        tokens: { '--my-color': 'red' },
      },
    });
    const styleContent = html.match(/<style>(.*?)<\/style>/s)?.[1] ?? '';
    const cssIndex = styleContent.indexOf('font-size: 20px');
    const tokenIndex = styleContent.indexOf('--my-color: red');
    assert.ok(cssIndex > 0, 'css must be present');
    assert.ok(tokenIndex > cssIndex, 'token rule must appear after custom css');
  });
});

describe('admin theme customization validation', () => {
  const valid = { resolveSession: () => ({}) as never, authorize: () => true };

  it('rejects a non-object themeCustomization', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: 'bad' as never }),
      AdminPanelError,
    );
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: [] as never }),
      AdminPanelError,
    );
  });

  it('rejects a non-string css', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: { css: 42 as never } }),
      AdminPanelError,
    );
  });

  it('rejects css containing a control character', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: { css: 'a\nb' } }),
      AdminPanelError,
    );
  });

  it('rejects css containing </style>', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          ...valid,
          themeCustomization: { css: 'body { color: red; } </style><script>alert(1)</script>' },
        }),
      AdminPanelError,
    );
  });

  it('rejects non-object tokens', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: { tokens: 'nope' as never } }),
      AdminPanelError,
    );
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: { tokens: [] as never } }),
      AdminPanelError,
    );
  });

  it('rejects a token key that is not a CSS custom property', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          ...valid,
          themeCustomization: { tokens: { bg: 'red' } },
        }),
      AdminPanelError,
    );
  });

  it('rejects a non-string token value', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          ...valid,
          themeCustomization: { tokens: { '--ok': 42 as never } },
        }),
      AdminPanelError,
    );
  });

  it('rejects a token value containing </style>', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          ...valid,
          themeCustomization: { tokens: { '--bad': '</style><script>' } },
        }),
      AdminPanelError,
    );
  });

  it('accepts an empty css string (no-op)', () => {
    assert.doesNotThrow(() => defineAdminPanel({ ...valid, themeCustomization: { css: '' } }));
  });

  it('accepts an empty tokens object (no rule emitted, treated as undefined)', () => {
    const panel = defineAdminPanel({ ...valid, themeCustomization: { tokens: {} } });
    assert.equal(panel.themeCustomization, undefined);
  });

  it('returns a frozen descriptor and deep-frozen tokens', () => {
    const panel = defineAdminPanel({
      ...valid,
      themeCustomization: { css: 'body { color: red; }', tokens: { '--bg': '#fff' } },
    });
    assert.equal(Object.isFrozen(panel), true);
    const tc = panel.themeCustomization;
    assert.ok(tc !== undefined);
    assert.equal(Object.isFrozen(tc), true);
    assert.ok(tc.tokens !== undefined);
    assert.equal(Object.isFrozen(tc.tokens), true);
  });
});

describe('admin theme customization page context threading', () => {
  it('threads themeCustomization into the page render context', async () => {
    let capturedCustom: AdminThemeCustomization | undefined;
    const app = await createTestApp({
      config: {
        port: 0,
        extensions: [
          adminPlugin(
            defineAdminPanel({
              resolveSession: () => ({
                id: 's1',
                csrfToken: 't',
                data: {},
                expiresAt: 2_000_000_000_000,
              }),
              authorize: () => true,
              themeCustomization: { css: 'body { color: red; }' },
              pages: [
                defineAdminPage({
                  slug: 'test',
                  label: 'Test',
                  render: (ctx) => {
                    capturedCustom = ctx.themeCustomization;
                    return '<p>ok</p>';
                  },
                }),
              ],
            }),
          ),
        ],
      },
    });
    await app.request('/admin/test');
    assert.ok(capturedCustom !== undefined);
    assert.equal(capturedCustom.css, 'body { color: red; }');
    await app.close();
  });

  it('renderAdminDocument output is byte-identical to renderAdminDocumentWithTheme with same args', () => {
    const fromLegacy = renderAdminDocument('Hi', 'light');
    const fromNew = renderAdminDocumentWithTheme({ title: 'Hi', theme: 'light' });
    assert.equal(fromLegacy, fromNew);
  });
});
