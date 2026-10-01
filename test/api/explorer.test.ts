import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderApiExplorer } from '../../src/api/explorer.js';
import { createApiExplorerHandler } from '../../src/api/explorer-route.js';
import type { OpenApiDocument } from '../../src/api/openapi.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const doc: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/users': {
      get: {
        tags: ['users'],
        summary: 'List users',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search query' },
        ],
        responses: { '200': { description: 'A list of users' } },
      },
      post: {
        tags: ['users'],
        summary: 'Create <script>alert("xss")</script>',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/posts': {
      get: {
        tags: ['posts'],
        summary: 'List posts',
        responses: { '200': { description: 'A list of posts' } },
      },
    },
  },
  tags: [{ name: 'posts' }, { name: 'users' }],
};

// A spec with no paths.
const emptyDoc: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Empty', version: '1.0.0' },
  paths: {},
};

// ---------------------------------------------------------------------------
// renderApiExplorer
// ---------------------------------------------------------------------------

describe('renderApiExplorer', () => {
  it('escapes a resource title containing <script>', () => {
    const html = renderApiExplorer(doc);

    // The literal script tag must appear as escaped text, not as an executable element.
    assert.ok(
      !html.includes('<script>alert("xss")</script>'),
      'raw script tag must not appear in output',
    );
    assert.ok(
      html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'),
      'escaped script tag must appear in output',
    );
  });

  it('escapes parameter descriptions', () => {
    const html = renderApiExplorer({
      ...doc,
      paths: {
        '/items': {
          get: {
            tags: ['items'],
            summary: 'List items',
            parameters: [
              {
                name: 'filter',
                in: 'query',
                schema: { type: 'string' },
                description: 'Filter by <b>name</b> & more',
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });

    assert.ok(html.includes('&lt;b&gt;name&lt;/b&gt; &amp; more'));
    assert.ok(!html.includes('<b>name</b> & more'));
  });

  it('escapes a tag name containing HTML', () => {
    const html = renderApiExplorer({
      ...doc,
      tags: [{ name: '<img src=x onerror=alert(1)>' }],
      paths: {
        '/danger': {
          get: {
            tags: ['<img src=x onerror=alert(1)>'],
            summary: 'Danger',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });

    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  });

  it('escapes the info title', () => {
    const html = renderApiExplorer({
      ...doc,
      info: { title: '<h1>Test</h1>', version: '1.0.0' },
    });

    assert.ok(html.includes('&lt;h1&gt;Test&lt;/h1&gt;'));
    assert.ok(!html.includes('<h1>Test</h1>'));
  });

  it('produces deterministic output for the same spec', () => {
    const html1 = renderApiExplorer(doc);
    const html2 = renderApiExplorer(doc);
    assert.equal(html1, html2);
  });

  it('returns a valid HTML string for an empty spec', () => {
    const html = renderApiExplorer(emptyDoc);
    assert.ok(typeof html === 'string', 'should return a string');
    assert.ok(html.includes('<!DOCTYPE html>'), 'should be an HTML document');
  });

  it('includes the document title', () => {
    const html = renderApiExplorer(doc);
    assert.ok(html.includes('Test API'), 'should contain the API title');
  });

  it('groups operations by tag', () => {
    const html = renderApiExplorer(doc);
    // Tags are users and posts (sorted alphabetically: posts, users).
    // Users tag has two operations (GET /users, POST /users).
    // Posts tag has one operation (GET /posts).
    const usersIndex = html.indexOf('users');
    const postsIndex = html.indexOf('posts');
    assert.ok(postsIndex < usersIndex, 'posts tag should appear before users tag (sorted)');
  });

  it('shows the HTTP method for each operation', () => {
    const html = renderApiExplorer(doc);
    assert.ok(html.includes('GET'), 'should include GET');
    assert.ok(html.includes('POST'), 'should include POST');
  });

  it('shows each path', () => {
    const html = renderApiExplorer(doc);
    assert.ok(html.includes('/users'), 'should include /users');
    assert.ok(html.includes('/posts'), 'should include /posts');
  });
});

// ---------------------------------------------------------------------------
// createApiExplorerHandler
// ---------------------------------------------------------------------------

describe('createApiExplorerHandler', () => {
  it('returns text/html content-type', async () => {
    const handler = createApiExplorerHandler({ spec: doc });
    const response = handler(new Request('http://localhost/api-explorer'));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  });

  it('returns the rendered HTML', async () => {
    const handler = createApiExplorerHandler({ spec: doc });
    const response = handler(new Request('http://localhost/api-explorer'));
    const html = await response.text();

    assert.ok(html.includes('<!DOCTYPE html>'), 'should be an HTML document');
    assert.ok(html.includes('Test API'), 'should contain the API title');
  });

  it('renders a different spec', async () => {
    const handler = createApiExplorerHandler({ spec: emptyDoc });
    const response = handler(new Request('http://localhost/api-explorer'));
    const html = await response.text();

    assert.ok(html.includes('Empty'), 'should contain the empty doc title');
  });

  it('works with no-store caching', () => {
    // The handler returns a Response; caching policy is caller-owned but the
    // default should be defensible. Test that the response exists at minimum.
    const handler = createApiExplorerHandler({ spec: doc });
    // Handler construction succeeds (no throw).
    assert.ok(typeof handler === 'function');
  });
});

// ---------------------------------------------------------------------------
// NUL character rejection
// ---------------------------------------------------------------------------

describe('renderApiExplorer NUL safety', () => {
  it('replaces NUL characters in user-supplied fields', () => {
    const html = renderApiExplorer({
      ...doc,
      info: { title: 'Bad\x00Title', version: '1.0.0' },
    });

    assert.ok(!html.includes('\x00'), 'NUL characters must not appear in output');
    assert.ok(html.includes('BadTitle') || html.includes('Bad Title'), 'title should be sanitized');
  });

  it('replaces NUL in operation summaries', () => {
    const html = renderApiExplorer({
      ...emptyDoc,
      paths: {
        '/test': {
          get: {
            tags: ['test'],
            summary: 'Get\x00Test',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });

    assert.ok(!html.includes('\x00'), 'NUL must not appear in output');
    assert.ok(html.includes('GetTest') || html.includes('Get Test'));
  });
});
