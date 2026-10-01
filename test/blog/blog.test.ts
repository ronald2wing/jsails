import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Hono } from 'hono';

import { definePlugin, runExtensions, type ExtensionRuntime } from '../../src/extensions/index.js';
import type { AdminPlugin } from '../../src/admin/admin-plugin.js';
import type { Resource } from '../../src/admin/resource.js';
import type { Session } from '../../src/contracts/http.js';
import {
  BlogValidationError,
  blogPostsToken,
  blogAdmin,
  blogPlugin,
  createBlogStore,
  createPostOperation,
  postCreatedEvent,
  type BlogPost,
  type BlogPostCreatedEvent,
  type BlogPostInput,
  type BlogPostStore,
} from '../../src/blog/index.js';

/**
 * Tests for the first-party blog plugin and its admin surface. The plugin runs
 * through the real extension runner, its collected HTTP hooks mount on a fresh
 * Hono app, and requests are driven in-process (no listener, no database, no
 * service). The admin surface is exercised through its descriptor: the
 * resource callbacks (`list`/`get`/`save`) are invoked directly with the same
 * shape `adminPlugin` hands them, so the CRUD contract is covered without a
 * live panel.
 */

interface TestApp {
  app: Hono;
  runtime: ExtensionRuntime;
  store: BlogPostStore;
}

/** Build the plugin through the runner and mount its hooks on a fresh Hono app. */
async function makeApp(store?: BlogPostStore): Promise<TestApp> {
  const runtime = await runExtensions([blogPlugin(store === undefined ? {} : { store })]);
  const app = new Hono();
  for (const hook of runtime.httpHooks) {
    await hook(app);
  }
  return { app, runtime, store: runtime.services.get(blogPostsToken) };
}

/** An `application/x-www-form-urlencoded` POST body. */
function postBody(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

/** A small store fixture for the injection test, mirroring the default behavior. */
function fixtureStore(): BlogPostStore {
  const posts: Array<{ id: number; title: string; body: string; createdAt: string }> = [];
  const created: BlogPostCreatedEvent[] = [];
  let nextId = 1;
  return {
    async list() {
      return posts;
    },
    async get(id) {
      return posts.find((post) => post.id === id);
    },
    async create(input) {
      const post = { id: nextId, title: input.title, body: input.body, createdAt: '' };
      nextId += 1;
      posts.push(post);
      return post;
    },
    async update(id, input) {
      const post = posts.find((candidate) => candidate.id === id);
      if (post === undefined) {
        return undefined;
      }
      post.title = input.title;
      post.body = input.body;
      return post;
    },
    events: () => created,
    recordEvent(event) {
      created.push(event);
    },
  };
}

describe('blog plugin HTTP routes', () => {
  it('renders an empty-state message when no posts exist', async () => {
    const { app, runtime } = await makeApp();

    const response = await app.request('/blog');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /No posts yet/);
    assert.doesNotMatch(html, /<ul>/);

    await runtime.close();
  });

  it('creates a post through the interceptor path and 303-redirects', async () => {
    const { app, runtime, store } = await makeApp();

    const response = await app.request(
      '/blog/posts',
      postBody({ title: '  Hello  ', body: 'world' }),
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/blog');

    const posts = await store.list();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.title, 'Hello'); // before interceptor trimmed the title
    assert.equal(posts[0]?.body, 'world');
    assert.match(posts[0]?.createdAt ?? '', /^\d{4}-\d{2}-\d{2}T/); // after interceptor stamped it

    await runtime.close();
  });

  it('lists created posts with escaped titles', async () => {
    const { app, runtime } = await makeApp();
    await app.request('/blog/posts', postBody({ title: '<b>Hi</b>', body: 'x' }));

    const response = await app.request('/blog');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /&lt;b&gt;Hi&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<b>Hi<\/b>/);

    await runtime.close();
  });

  it('fires another plugin observer on postCreatedEvent through the shared registry', async () => {
    // Regression: the blog plugin used to run its operation through a private
    // registry, so observers registered by other plugins never fired for posts
    // created over HTTP. It now runs through the shared registry.
    const seen: BlogPostCreatedEvent[] = [];
    const observerPlugin = definePlugin({
      name: 'post-observer',
      setup({ observe }) {
        observe(postCreatedEvent, (payload) => {
          seen.push(payload);
        });
      },
    });

    const runtime = await runExtensions([blogPlugin(), observerPlugin]);
    const app = new Hono();
    for (const hook of runtime.httpHooks) {
      await hook(app);
    }

    const response = await app.request('/blog/posts', postBody({ title: 'Shared', body: 'x' }));
    assert.equal(response.status, 303);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.post.title, 'Shared');

    await runtime.close();
  });

  it('rejects an empty title with a value-free 422 and no post', async () => {
    const { app, runtime, store } = await makeApp();

    const response = await app.request(
      '/blog/posts',
      postBody({ title: '   ', body: 'SECRET_BODY' }),
    );
    assert.equal(response.status, 422);
    const html = await response.text();
    assert.match(html, /Title is required/);
    assert.doesNotMatch(html, /SECRET_BODY/);
    assert.equal((await store.list()).length, 0);

    await runtime.close();
  });
});

describe('blog plugin service and contract', () => {
  it('resolves the blogPosts token to the store used by the routes', async () => {
    const { app, runtime, store } = await makeApp();

    assert.equal(runtime.services.get(blogPostsToken), store);

    await app.request('/blog/posts', postBody({ title: 'Hello', body: 'x' }));
    assert.equal((await store.list()).length, 1);

    await runtime.close();
  });

  it('accepts an injected store and resolves it through the token', async () => {
    const injected = fixtureStore();
    const { runtime, store } = await makeApp(injected);

    assert.equal(store, injected);
    assert.equal(runtime.services.get(blogPostsToken), injected);

    await runtime.close();
  });

  it('before interceptor trims and rejects an empty title with a fixed message', async () => {
    const { runtime } = await makeApp();

    const args: BlogPostInput = { title: '  Hello  ', body: 'x' };
    await runtime.interceptors.runBefore(createPostOperation, args);
    assert.equal(args.title, 'Hello');

    await assert.rejects(
      runtime.interceptors.runBefore(createPostOperation, { title: '   ', body: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof BlogValidationError);
        assert.equal(error.message, 'blog post title must be a non-empty string');
        return true;
      },
    );

    await runtime.close();
  });

  it('after interceptor stamps createdAt in place', async () => {
    const { runtime } = await makeApp();

    const args: BlogPostInput = { title: 'Hello', body: 'x' };
    const post: BlogPost = { id: 1, title: 'Hello', body: 'x', createdAt: '' };
    const result = await runtime.interceptors.runAfter(createPostOperation, args, post);

    assert.equal(result, post);
    assert.match(result.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(post.createdAt, result.createdAt);

    await runtime.close();
  });

  it('observer records the created event in the store', async () => {
    const { runtime, store } = await makeApp();

    const post: BlogPost = {
      id: 1,
      title: 'Hello',
      body: 'x',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const errors = await runtime.interceptors.emit(postCreatedEvent, { post });

    assert.equal(errors.length, 0);
    assert.equal(store.events().length, 1);
    assert.equal(store.events()[0]?.post, post);

    await runtime.close();
  });

  it('closes idempotently and leaves no global state behind', async () => {
    const { app, runtime, store } = await makeApp();

    await app.request('/blog/posts', postBody({ title: 'Hello', body: 'x' }));
    assert.equal((await store.list()).length, 1);

    await runtime.close();
    await runtime.close(); // idempotent

    // The store is caller-owned in-memory data; closing the runtime removes
    // nothing global and does not wipe it.
    assert.equal((await store.list()).length, 1);
  });
});

describe('blog store', () => {
  it('assigns monotonically increasing ids and reads them back', async () => {
    const store = createBlogStore();

    const first = await store.create({ title: 'a', body: '1' });
    const second = await store.create({ title: 'b', body: '2' });

    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    assert.equal(await store.get(1), first);
    assert.equal(await store.get(2), second);
    assert.equal(await store.get(3), undefined);
  });

  it('updates an existing post in place and ignores unknown ids', async () => {
    const store = createBlogStore();
    await store.create({ title: 'a', body: '1' });

    const updated = await store.update(1, { title: 'renamed', body: '2' });
    assert.ok(updated);
    assert.equal(updated?.title, 'renamed');
    assert.equal(updated?.body, '2');
    assert.equal((await store.get(1))?.title, 'renamed');

    assert.equal(await store.update(99, { title: 'x', body: 'y' }), undefined);
  });
});

describe('blog admin', () => {
  /** Capture the resource contribution from the admin plugin's register. */
  function captureResource(plugin: AdminPlugin): Resource {
    let captured: Resource | undefined;
    plugin.register({
      addPage() {},
      addNavigationItem() {},
      addResource(resource) {
        captured = resource;
      },
    });
    assert.ok(captured, 'blog admin must contribute a resource');
    return captured;
  }

  /** Capture the resource and narrow its optional `get`/`save` to required. */
  function blogResource(plugin: AdminPlugin): {
    list: Resource['list'];
    get: NonNullable<Resource['get']>;
    save: NonNullable<Resource['save']>;
  } {
    const resource = captureResource(plugin);
    assert.ok(resource.get, 'resource must define get');
    assert.ok(resource.save, 'resource must define save');
    return { list: resource.list, get: resource.get, save: resource.save };
  }

  const session: Session = { id: 's', csrfToken: 't', data: {}, expiresAt: 0 };

  it('has id "blog" and a "posts" resource', () => {
    const plugin = blogAdmin();
    assert.equal(plugin.id, 'blog');
    const resource = captureResource(plugin);
    assert.equal(resource.slug, 'posts');
    assert.ok(resource.list);
    assert.ok(resource.get);
    assert.ok(resource.save);
  });

  it('lists, gets, creates, and updates posts over a shared store', async () => {
    const store = createBlogStore();
    const resource = blogResource(blogAdmin({ store }));

    // Create through the admin save path.
    await resource.save({ session, id: null, values: { title: 'First', body: 'body 1' } });
    await resource.save({ session, id: null, values: { title: 'Second', body: 'body 2' } });

    const list = await resource.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.total, 2);
    assert.deepEqual(
      list.rows.map((row) => row.title),
      ['First', 'Second'],
    );

    const first = (await store.list())[0];
    assert.ok(first);

    const got = await resource.get({ session, id: String(first.id) });
    assert.deepEqual(got, { title: 'First', body: 'body 1' });

    await resource.save({
      session,
      id: String(first.id),
      values: { title: 'Renamed', body: 'new' },
    });
    assert.equal((await store.get(first.id))?.title, 'Renamed');
    assert.equal((await store.get(first.id))?.body, 'new');
  });

  it('returns null for an unknown or invalid id', async () => {
    const store = createBlogStore();
    const resource = blogResource(blogAdmin({ store }));

    assert.equal(await resource.get({ session, id: '99' }), null);
    assert.equal(await resource.get({ session, id: 'not-a-number' }), null);
  });

  it('shares one store between the plugin and the admin', async () => {
    const store = createBlogStore();
    const { app, runtime } = await makeApp(store);
    const resource = blogResource(blogAdmin({ store }));

    // Create through the plugin's HTTP route...
    await app.request('/blog/posts', postBody({ title: 'Shared', body: 'x' }));
    assert.equal((await store.list()).length, 1);

    // ...and it is visible through the admin list.
    const list = await resource.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0]?.title, 'Shared');

    await runtime.close();
  });
});
