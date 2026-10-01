/**
 * Inertia page adapter tests.
 *
 * Exercises page-object validation, JSON-vs-HTML response branching,
 * HTML-attribute escaping, and version-hash determinism. No ports, no
 * filesystem, no external services.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  createInertiaPage,
  errorsFor,
  inertiaVersion,
  mergeSharedProps,
  renderInertiaPage,
  resolveDeferredProps,
  resolveErrorBag,
  resolveInertiaProps,
  withFlash,
} from '../../src/inertia/inertia.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode common HTML entities back to characters for parsing embedded JSON. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

// ---------------------------------------------------------------------------
// createInertiaPage
// ---------------------------------------------------------------------------

describe('createInertiaPage', () => {
  it('builds a valid page object with all fields', () => {
    const page = createInertiaPage({
      component: 'Dashboard',
      props: { user: 'alice', count: 3 },
      url: '/dashboard',
      version: 'abc12345',
    });
    assert.equal(page.component, 'Dashboard');
    assert.deepStrictEqual(page.props, { user: 'alice', count: 3 });
    assert.equal(page.url, '/dashboard');
    assert.equal(page.version, 'abc12345');
  });

  it('defaults props to {} and version to null', () => {
    const page = createInertiaPage({ component: 'Home', url: '/' });
    assert.deepStrictEqual(page.props, {});
    assert.equal(page.version, null);
  });

  it('rejects a missing component with a value-free error', () => {
    assert.throws(() => createInertiaPage({ component: '', url: '/' }), {
      message: 'Inertia page requires a non-empty "component".',
    });
    assert.throws(() => createInertiaPage({ component: '', url: '/' }), {
      message: 'Inertia page requires a non-empty "component".',
    });
  });

  it('rejects a missing url with a value-free error', () => {
    assert.throws(() => createInertiaPage({ component: 'Home', url: '' }), {
      message: 'Inertia page requires a non-empty "url".',
    });
  });

  it('the error does not embed the input value', () => {
    try {
      createInertiaPage({ component: '', url: '/secret' });
    } catch (e) {
      const msg = (e as Error).message;
      assert.ok(msg.includes('component'), 'mentions the field name');
      assert.ok(!msg.includes('secret'), 'never echoes the url value');
    }
  });
});

// ---------------------------------------------------------------------------
// renderInertiaPage — JSON branch
// ---------------------------------------------------------------------------

describe('renderInertiaPage (JSON / X-Inertia)', () => {
  const page = createInertiaPage({
    component: 'Tasks',
    props: { title: 'Hello' },
    url: '/tasks',
    version: 'v1',
  });

  function inertiaRequest(): Request {
    return new Request('http://localhost/tasks', {
      headers: { 'X-Inertia': 'true' },
    });
  }

  it('returns JSON with X-Inertia response header', async () => {
    const response = renderInertiaPage(page, { request: inertiaRequest() });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('Content-Type') ?? '').includes('application/json'));
    assert.equal(response.headers.get('X-Inertia'), 'true');
  });

  it('responds with the full page object as JSON', async () => {
    const response = renderInertiaPage(page, { request: inertiaRequest() });
    const body = await response.json();
    assert.equal(body.component, 'Tasks');
    assert.equal(body.url, '/tasks');
    assert.equal(body.version, 'v1');
    assert.deepStrictEqual(body.props, { title: 'Hello' });
  });

  it('sets Vary: X-Inertia so proxies cache correctly', () => {
    const response = renderInertiaPage(page, { request: inertiaRequest() });
    assert.equal(response.headers.get('Vary'), 'X-Inertia');
  });
});

// ---------------------------------------------------------------------------
// renderInertiaPage — HTML branch (full page load)
// ---------------------------------------------------------------------------

describe('renderInertiaPage (HTML / full page load)', () => {
  const page = createInertiaPage({
    component: 'Dashboard',
    props: { items: ['a', 'b'] },
    url: '/dashboard',
  });

  function plainRequest(): Request {
    return new Request('http://localhost/dashboard');
  }

  it('returns HTML for a plain request', () => {
    const response = renderInertiaPage(page, { request: plainRequest() });
    assert.equal(response.status, 200);
    const ct = response.headers.get('Content-Type') ?? '';
    assert.ok(ct.includes('text/html'));
  });

  it('embeds the page object in a data-page attribute', async () => {
    const response = renderInertiaPage(page, { request: plainRequest() });
    const html = await response.text();
    // The div id="app" must be present with a data-page attribute.
    assert.ok(html.includes('<div id="app"'), 'contains app div');
    assert.ok(html.includes('data-page="'), 'contains data-page attribute');
  });

  it('the embedded JSON is parsable and matches the page', async () => {
    const response = renderInertiaPage(page, { request: plainRequest() });
    const html = await response.text();
    const match = html.match(/data-page="([^"]*)"/);
    assert.ok(match, 'data-page attribute found');
    // HTML entities must be decoded before JSON.parse: the attribute value
    // uses entity encoding so it never breaks the HTML attribute boundary.
    const decoded = JSON.parse(decodeHtmlEntities(match[1]!));
    assert.equal(decoded.component, 'Dashboard');
    assert.deepStrictEqual(decoded.props, { items: ['a', 'b'] });
  });

  it('HTML-escapes characters that break an attribute boundary', async () => {
    const tricky = createInertiaPage({
      component: 'Alert',
      props: { message: '<script>alert("&")</script>' },
      url: '/alert',
    });
    const response = renderInertiaPage(tricky, { request: plainRequest() });
    const html = await response.text();
    // `data-page="..."` must stay a single well-formed attribute.
    // The `<` in the JSON must be escaped to `\u003c` or `&lt;`.
    const match = html.match(/data-page="([^"]*)"/);
    assert.ok(match, 'attribute boundary is intact');
    const raw = match[1]!;
    assert.ok(!raw.includes('<script>'), '< is escaped, no raw <script>');
    assert.ok(!raw.includes('alert("'), '&quot; or \\" escapes quotes');
    // Re-parse after decoding HTML entities to confirm the value round-trips.
    const decoded = JSON.parse(decodeHtmlEntities(raw));
    assert.equal(decoded.props.message, '<script>alert("&")</script>');
  });

  it('uses the default HTML shell', async () => {
    const response = renderInertiaPage(page, { request: plainRequest() });
    const html = await response.text();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'includes doctype');
    assert.ok(html.includes('<meta charset="utf-8">'), 'includes charset meta');
  });

  it('accepts a custom shell via the shell option', async () => {
    const customShell = '<html><head></head><body>{{page}}</body></html>';
    const response = renderInertiaPage(page, {
      request: plainRequest(),
      shell: customShell,
    });
    const html = await response.text();
    assert.ok(html.startsWith('<html><head></head>'), 'uses custom shell');
    assert.ok(html.includes('<div id="app"'), 'page div is injected');
  });

  it('rejects a shell without the {{page}} placeholder', () => {
    assert.throws(
      () =>
        renderInertiaPage(page, {
          request: plainRequest(),
          shell: '<html></html>',
        }),
      { message: 'Shell must include the "{{page}}" placeholder.' },
    );
  });

  it('a full page load response does not include the X-Inertia header', () => {
    const response = renderInertiaPage(page, { request: plainRequest() });
    assert.equal(response.headers.get('X-Inertia'), null);
  });
});

// ---------------------------------------------------------------------------
// inertiaVersion
// ---------------------------------------------------------------------------

describe('inertiaVersion', () => {
  it('produces a deterministic hash for a given asset map', () => {
    const assets = { 'app.js': 'abc123', 'app.css': 'def456' };
    const v1 = inertiaVersion(assets);
    const v2 = inertiaVersion(assets);
    assert.equal(v1, v2, 'same assets produce the same version');
    assert.equal(typeof v1, 'string');
    assert.equal(v1!.length, 8);
  });

  it('different asset maps produce different hashes', () => {
    const vA = inertiaVersion({ 'app.js': 'abc' });
    const vB = inertiaVersion({ 'app.js': 'def' });
    assert.notEqual(vA, vB);
  });

  it('returns null for undefined input', () => {
    assert.equal(inertiaVersion(undefined), null);
  });

  it('returns null for an empty map', () => {
    assert.equal(inertiaVersion({}), null);
  });

  it('is deterministic regardless of key insertion order', () => {
    // Build objects with different insertion orders.
    const a: Record<string, string> = {};
    a['app.js'] = 'hash1';
    a['app.css'] = 'hash2';
    const b: Record<string, string> = {};
    b['app.css'] = 'hash2';
    b['app.js'] = 'hash1';
    assert.equal(inertiaVersion(a), inertiaVersion(b));
  });

  it('matches a manually computed hash', () => {
    // Keys sorted, then values concatenated: 'def' (app.css) + 'abc' (app.js) = 'defabc'.
    const assets = { 'app.js': 'abc', 'app.css': 'def' };
    const expected = createHash('sha256').update('defabc').digest('hex').slice(0, 8);
    assert.equal(inertiaVersion(assets), expected);
  });
});

// ---------------------------------------------------------------------------
// resolveInertiaProps — partial reloads
// ---------------------------------------------------------------------------

describe('resolveInertiaProps', () => {
  const page = createInertiaPage({
    component: 'Dashboard',
    props: {
      title: 'Hello',
      count: 42,
      user: { name: 'Alice', email: 'alice@example.com' },
      settings: { theme: 'dark' },
    },
    url: '/dashboard',
  });

  it('returns full props when no partial headers are present', () => {
    const request = new Request('http://localhost/dashboard');
    const result = resolveInertiaProps(page, request);
    assert.deepStrictEqual(result, page.props);
  });

  it('keeps only listed top-level keys when X-Inertia-Partial-Data is set', () => {
    const request = new Request('http://localhost/dashboard', {
      headers: { 'X-Inertia-Partial-Data': 'title,count' },
    });
    const result = resolveInertiaProps(page, request);
    assert.deepStrictEqual(result, { title: 'Hello', count: 42 });
  });

  it('selects nested dot-paths from X-Inertia-Partial-Data', () => {
    const request = new Request('http://localhost/dashboard', {
      headers: { 'X-Inertia-Partial-Data': 'user.name, settings' },
    });
    const result = resolveInertiaProps(page, request);
    assert.deepStrictEqual(result, {
      user: { name: 'Alice' },
      settings: { theme: 'dark' },
    });
  });

  it('handles sibling keys under the same ancestor in only mode', () => {
    const request = new Request('http://localhost/dashboard', {
      headers: { 'X-Inertia-Partial-Data': 'user.name, user.email' },
    });
    const result = resolveInertiaProps(page, request);
    assert.deepStrictEqual(result, {
      user: { name: 'Alice', email: 'alice@example.com' },
    });
  });

  it('drops exception paths when X-Inertia-Partial-Except is set', () => {
    const request = new Request('http://localhost/dashboard', {
      headers: { 'X-Inertia-Partial-Except': 'count' },
    });
    const result = resolveInertiaProps(page, request);
    // 'count' is removed; everything else stays.
    assert.deepStrictEqual(result, {
      title: 'Hello',
      user: { name: 'Alice', email: 'alice@example.com' },
      settings: { theme: 'dark' },
    });
  });

  it('drops nested dot-paths on except', () => {
    const request = new Request('http://localhost/dashboard', {
      headers: { 'X-Inertia-Partial-Except': 'user.email' },
    });
    const result = resolveInertiaProps(page, request);
    assert.deepStrictEqual(result, {
      title: 'Hello',
      count: 42,
      user: { name: 'Alice' },
      settings: { theme: 'dark' },
    });
  });

  it('only takes precedence over except (Partial-Data header wins)', () => {
    const request = new Request('http://localhost/dashboard', {
      headers: {
        'X-Inertia-Partial-Data': 'title',
        'X-Inertia-Partial-Except': 'user',
      },
    });
    const result = resolveInertiaProps(page, request);
    assert.deepStrictEqual(result, { title: 'Hello' });
  });

  it('returns a new object — never mutates page.props', () => {
    const originalProps = page.props;
    const request = new Request('http://localhost/dashboard', {
      headers: { 'X-Inertia-Partial-Data': 'title' },
    });
    const result = resolveInertiaProps(page, request);
    assert.notStrictEqual(result, originalProps);
    assert.deepStrictEqual(originalProps, {
      title: 'Hello',
      count: 42,
      user: { name: 'Alice', email: 'alice@example.com' },
      settings: { theme: 'dark' },
    });
  });

  it('returns empty object when only list is empty string', () => {
    const request = new Request('http://localhost/dashboard', {
      headers: { 'X-Inertia-Partial-Data': '' },
    });
    const result = resolveInertiaProps(page, request);
    assert.deepStrictEqual(result, {});
  });

  it('ignores whitespace-only header values', () => {
    const request = new Request('http://localhost/dashboard', {
      headers: { 'X-Inertia-Partial-Data': ' title ,  count ' },
    });
    const result = resolveInertiaProps(page, request);
    assert.deepStrictEqual(result, { title: 'Hello', count: 42 });
  });
});

// ---------------------------------------------------------------------------
// mergeSharedProps
// ---------------------------------------------------------------------------

describe('mergeSharedProps', () => {
  const page = createInertiaPage({
    component: 'Home',
    props: { title: 'Page Title', auth: { user: 'page-user' } },
    url: '/',
  });

  it('merges shared props under page props (page wins on collision)', () => {
    const shared = { title: 'Shared Title', locale: 'en', auth: { user: 'shared-user' } };
    const merged = mergeSharedProps(page, shared);
    assert.equal(merged.component, 'Home');
    assert.deepStrictEqual(merged.props, {
      title: 'Page Title',
      locale: 'en',
      auth: { user: 'page-user' },
    });
  });

  it('returns a new page object (never mutates the original)', () => {
    const original = page;
    const shared = { locale: 'en' };
    const merged = mergeSharedProps(page, shared);
    assert.notStrictEqual(merged, original);
    assert.notStrictEqual(merged.props, original.props);
    assert.deepStrictEqual(original.props, { title: 'Page Title', auth: { user: 'page-user' } });
  });

  it('shared props with only new keys are all added', () => {
    const shared = { locale: 'en', csrf: 'token' };
    const merged = mergeSharedProps(page, shared);
    assert.deepStrictEqual(merged.props, {
      title: 'Page Title',
      auth: { user: 'page-user' },
      locale: 'en',
      csrf: 'token',
    });
  });

  it('rejects non-plain-object shared with a value-free error', () => {
    assert.throws(() => mergeSharedProps(page, null as unknown as Record<string, unknown>), {
      message: 'Shared props must be a plain object.',
    });
    assert.throws(() => mergeSharedProps(page, [] as unknown as Record<string, unknown>), {
      message: 'Shared props must be a plain object.',
    });
    assert.throws(() => mergeSharedProps(page, 'string' as unknown as Record<string, unknown>), {
      message: 'Shared props must be a plain object.',
    });
  });
});

// ---------------------------------------------------------------------------
// resolveErrorBag / errorsFor
// ---------------------------------------------------------------------------

describe('resolveErrorBag', () => {
  it('returns undefined when the header is absent', () => {
    const request = new Request('http://localhost/login');
    assert.equal(resolveErrorBag(request), undefined);
  });

  it('returns the trimmed header value', () => {
    const request = new Request('http://localhost/login', {
      headers: { 'X-Inertia-Error-Bag': 'login' },
    });
    assert.equal(resolveErrorBag(request), 'login');
  });

  it('trims surrounding whitespace', () => {
    const request = new Request('http://localhost/login', {
      headers: { 'X-Inertia-Error-Bag': '  login  ' },
    });
    assert.equal(resolveErrorBag(request), 'login');
  });

  it('returns undefined for an empty-string header', () => {
    const request = new Request('http://localhost/login', {
      headers: { 'X-Inertia-Error-Bag': '' },
    });
    assert.equal(resolveErrorBag(request), undefined);
  });

  it('returns undefined for a whitespace-only header', () => {
    const request = new Request('http://localhost/login', {
      headers: { 'X-Inertia-Error-Bag': '   ' },
    });
    assert.equal(resolveErrorBag(request), undefined);
  });
});

describe('errorsFor', () => {
  const errors = {
    email: 'Email is required.',
    login: { email: 'Not found.', password: 'Wrong password.' },
  };

  it('returns the full errors object when bag is undefined', () => {
    const result = errorsFor(errors, undefined);
    assert.deepStrictEqual(result, errors);
  });

  it('returns the full errors object when bag is empty string', () => {
    const result = errorsFor(errors, '');
    assert.deepStrictEqual(result, errors);
  });

  it('scopes to the named bag', () => {
    const result = errorsFor(errors, 'login');
    assert.deepStrictEqual(result, { email: 'Not found.', password: 'Wrong password.' });
  });

  it('returns {} when the bag key does not exist', () => {
    const result = errorsFor(errors, 'nonexistent');
    assert.deepStrictEqual(result, {});
  });

  it('returns {} when the bag value is not an object', () => {
    const result = errorsFor({ email: 'Email is required.' }, 'email');
    assert.deepStrictEqual(result, {});
  });
});

// ---------------------------------------------------------------------------
// createInertiaPage — flash data
// ---------------------------------------------------------------------------

describe('createInertiaPage flash', () => {
  it('includes flash when provided', () => {
    const page = createInertiaPage({
      component: 'Dashboard',
      url: '/',
      flash: { notice: 'Saved successfully.' },
    });
    assert.deepStrictEqual(page.flash, { notice: 'Saved successfully.' });
  });

  it('omits the flash key when not provided', () => {
    const page = createInertiaPage({ component: 'Home', url: '/' });
    assert.ok(!('flash' in page));
  });

  it('flash does not leak into props', () => {
    const page = createInertiaPage({
      component: 'Dashboard',
      url: '/',
      props: { title: 'Hello' },
      flash: { notice: 'Done' },
    });
    assert.deepStrictEqual(page.props, { title: 'Hello' });
    assert.deepStrictEqual(page.flash, { notice: 'Done' });
  });
});

// ---------------------------------------------------------------------------
// withFlash
// ---------------------------------------------------------------------------

describe('withFlash', () => {
  const page = createInertiaPage({
    component: 'Dashboard',
    props: { title: 'Hello' },
    url: '/',
  });

  it('returns a new page with flash set', () => {
    const result = withFlash(page, { notice: 'Saved.' });
    assert.deepStrictEqual(result.flash, { notice: 'Saved.' });
    assert.equal(result.component, 'Dashboard');
    assert.deepStrictEqual(result.props, { title: 'Hello' });
  });

  it('does not mutate the original page', () => {
    const original = page;
    withFlash(page, { notice: 'Saved.' });
    assert.ok(!('flash' in original));
    assert.notStrictEqual(page, withFlash(page, { notice: 'Saved.' }));
  });

  it('overwrites existing flash on the returned page', () => {
    const withExisting = createInertiaPage({
      component: 'Tasks',
      url: '/tasks',
      flash: { old: true },
    });
    const result = withFlash(withExisting, { notice: 'Updated' });
    assert.deepStrictEqual(result.flash, { notice: 'Updated' });
    // original page is unchanged
    assert.deepStrictEqual(withExisting.flash, { old: true });
  });
});

// ---------------------------------------------------------------------------
// resolveDeferredProps
// ---------------------------------------------------------------------------

describe('resolveDeferredProps', () => {
  it('resolves sync props into a flat map', async () => {
    const deferred = {
      user: { resolve: () => ({ name: 'Alice' }) },
      count: { resolve: () => 42 },
    };
    const result = await resolveDeferredProps(deferred, null);
    assert.deepStrictEqual(result, { user: { name: 'Alice' }, count: 42 });
  });

  it('resolves async props', async () => {
    const deferred = {
      data: { resolve: async () => Promise.resolve([1, 2, 3]) },
    };
    const result = await resolveDeferredProps(deferred, {});
    assert.deepStrictEqual(result, { data: [1, 2, 3] });
  });

  it('resolves mixed sync and async props in parallel', async () => {
    const resolved: string[] = [];
    const deferred = {
      a: {
        resolve: () => {
          resolved.push('a');
          return 'A';
        },
      },
      b: {
        resolve: async () => {
          resolved.push('b');
          return 'B';
        },
      },
      c: {
        resolve: () => {
          resolved.push('c');
          return 'C';
        },
      },
    };
    const result = await resolveDeferredProps(deferred, null);
    assert.deepStrictEqual(result, { a: 'A', b: 'B', c: 'C' });
    assert.equal(resolved.length, 3);
  });

  it('groups with default "default" group (group metadata is preserved on prop)', async () => {
    const deferred = {
      header: { resolve: () => 'nav' },
      footer: { group: 'lazy', resolve: () => 'foot' },
      main: { resolve: () => 'body' },
    };
    // Groups do not affect the flat result; they are metadata.
    const result = await resolveDeferredProps(deferred, null);
    assert.deepStrictEqual(result, { header: 'nav', footer: 'foot', main: 'body' });
  });

  it('passes context to each resolver', async () => {
    const deferred = {
      session: { resolve: (ctx: unknown) => (ctx as { id: number }).id },
    };
    const result = await resolveDeferredProps(deferred, { id: 7 });
    assert.deepStrictEqual(result, { session: 7 });
  });

  it('a throwing resolver propagates (unwrapped)', async () => {
    const deferred = {
      ok: { resolve: () => 'good' },
      bad: {
        resolve: () => {
          throw new Error('boom');
        },
      },
    };
    await assert.rejects(() => resolveDeferredProps(deferred, null), { message: 'boom' });
  });

  it('an async throwing resolver propagates', async () => {
    const deferred = {
      bad: {
        resolve: async () => {
          throw new Error('async boom');
        },
      },
    };
    await assert.rejects(() => resolveDeferredProps(deferred, null), { message: 'async boom' });
  });

  it('returns an empty object for empty input', async () => {
    const result = await resolveDeferredProps({}, null);
    assert.deepStrictEqual(result, {});
  });
});
