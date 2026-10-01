import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defineDeclarativeResource,
  DeclarativeResourceError,
} from '../../src/api/declarative-resource.js';
import { integer, optional, string } from '../../src/api/validation.js';
import type { ResourceStore } from '../../src/api/resource.js';
import type { RouteEntry } from '../../src/api/router.js';
import type { SerializerFields } from '../../src/api/serialization.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface PostRow {
  id: number;
  title: string;
  body?: string;
}

type PostInput = { title: string; body?: string };

function createStubStore(): ResourceStore<PostRow, PostInput> {
  const rows = new Map<string, PostRow>();
  let nextId = 1;

  return {
    async count() {
      return rows.size;
    },
    async list(offset, limit) {
      return [...rows.values()].slice(offset, offset + limit);
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async create(data) {
      const row: PostRow = { id: nextId++, title: data.title };
      rows.set(String(row.id), row);
      return row;
    },
    async update(id, data) {
      const existing = rows.get(id);
      if (!existing) return null;
      Object.assign(existing, data);
      return existing;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

const serializerFields: SerializerFields = {
  id: { schema: integer(), readOnly: true },
  title: string({ min: 1 }),
  body: optional(string()),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defineDeclarativeResource', () => {
  it('produces handlers, routes, serializer, and authorize from a single spec', () => {
    const store = createStubStore();
    const resource = defineDeclarativeResource({
      name: 'post',
      serializer: serializerFields,
      store,
      authorize: async () => true,
    });

    // Structural assertions: the returned object has the expected shape.
    assert.equal(resource.name, 'post');
    assert.ok(typeof resource.serializer === 'object' && resource.serializer !== null);
    assert.ok(typeof resource.serializer.validate === 'function');
    assert.ok(typeof resource.serializer.toRepresentation === 'function');

    assert.ok(typeof resource.authorize === 'function');

    // Handlers
    assert.ok(typeof resource.handlers === 'object' && resource.handlers !== null);
    assert.ok(typeof resource.handlers.collection === 'object');
    assert.ok(typeof resource.handlers.collection.GET === 'function');
    assert.ok(typeof resource.handlers.collection.POST === 'function');
    assert.ok(typeof resource.handlers.detail === 'object');
    assert.ok(typeof resource.handlers.detail.GET === 'function');
    assert.ok(typeof resource.handlers.detail.PATCH === 'function');
    assert.ok(typeof resource.handlers.detail.DELETE === 'function');

    // Routes: non-empty manifest with the expected shape.
    assert.ok(Array.isArray(resource.routes));
    assert.ok(resource.routes.length > 0);
    const firstRoute = resource.routes[0];
    assert.ok(typeof firstRoute.method === 'string');
    assert.ok(typeof firstRoute.path === 'string');
    assert.ok(typeof firstRoute.resource === 'string');
    assert.ok(typeof firstRoute.handlerKey === 'string');

    // Routes should be at /post and /post/:id
    const paths = resource.routes.map((r: RouteEntry) => `${r.method} ${r.path}`);
    assert.ok(paths.includes('GET /post'));
    assert.ok(paths.includes('POST /post'));
    assert.ok(paths.includes('GET /post/:id'));
    assert.ok(paths.includes('PATCH /post/:id'));
    assert.ok(paths.includes('DELETE /post/:id'));
  });

  it('returns a frozen object', () => {
    const store = createStubStore();
    const resource = defineDeclarativeResource({
      name: 'post',
      serializer: serializerFields,
      store,
      authorize: async () => true,
    });

    assert.throws(() => {
      (resource as unknown as Record<string, unknown>).newProp = true;
    }, TypeError);
  });

  it('throws DeclarativeResourceError for an empty name', () => {
    const store = createStubStore();
    assert.throws(
      () =>
        defineDeclarativeResource({
          name: '',
          serializer: serializerFields,
          store,
          authorize: async () => true,
        }),
      DeclarativeResourceError,
    );
  });

  it('throws DeclarativeResourceError for a name with a slash', () => {
    const store = createStubStore();
    assert.throws(
      () =>
        defineDeclarativeResource({
          name: 'bad/name',
          serializer: serializerFields,
          store,
          authorize: async () => true,
        }),
      DeclarativeResourceError,
    );
  });

  it('throws DeclarativeResourceError for a name with whitespace', () => {
    const store = createStubStore();
    assert.throws(
      () =>
        defineDeclarativeResource({
          name: 'bad name',
          serializer: serializerFields,
          store,
          authorize: async () => true,
        }),
      DeclarativeResourceError,
    );
  });

  it('throws DeclarativeResourceError when serializer is missing', () => {
    const store = createStubStore();
    assert.throws(
      () =>
        defineDeclarativeResource({
          name: 'post',
          serializer: undefined as unknown as SerializerFields,
          store,
          authorize: async () => true,
        }),
      DeclarativeResourceError,
    );
  });

  it('throws DeclarativeResourceError when store is missing', () => {
    assert.throws(
      () =>
        defineDeclarativeResource({
          name: 'post',
          serializer: serializerFields,
          store: undefined as unknown as ResourceStore,
          authorize: async () => true,
        }),
      DeclarativeResourceError,
    );
  });

  it('throws DeclarativeResourceError when authorize is missing', () => {
    const store = createStubStore();
    assert.throws(
      () =>
        defineDeclarativeResource({
          name: 'post',
          serializer: serializerFields,
          store,
          authorize: undefined as unknown as () => boolean,
        }),
      DeclarativeResourceError,
    );
  });

  it('handlers.list is a function that calls through to the store (end-to-end smoke)', async () => {
    const store = createStubStore();
    const resource = defineDeclarativeResource({
      name: 'post',
      serializer: serializerFields,
      store,
      authorize: async () => true,
    });

    // Create a post via the POST handler.
    const createReq = new Request('http://localhost/post', {
      method: 'POST',
      body: JSON.stringify({ title: 'hello' }),
      headers: { 'content-type': 'application/json' },
    });
    const ctx = {
      request: createReq,
      url: new URL(createReq.url),
      params: {},
      session: null,
    };
    const createResp = await resource.handlers.collection.POST(createReq, ctx);
    assert.equal(createResp.status, 201);

    // List via GET handler.
    const listReq = new Request('http://localhost/post', { method: 'GET' });
    const listCtx = {
      request: listReq,
      url: new URL(listReq.url),
      params: {},
      session: null,
    };
    const listResp = await resource.handlers.collection.GET(listReq, listCtx);
    assert.equal(listResp.status, 200);

    const body = await listResp.json();
    assert.ok(Array.isArray(body.results));
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].title, 'hello');
    assert.equal(typeof body.results[0].id, 'number');
    // password / body should NOT leak as writeOnly
    assert.equal(body.results[0].body, undefined);
  });

  it('handlers deny an unauthorized request (default-deny)', async () => {
    const store = createStubStore();
    const resource = defineDeclarativeResource({
      name: 'post',
      serializer: serializerFields,
      store,
      authorize: async () => false,
    });

    const req = new Request('http://localhost/post', { method: 'GET' });
    const ctx = {
      request: req,
      url: new URL(req.url),
      params: {},
      session: null,
    };
    const resp = await resource.handlers.collection.GET(req, ctx);
    assert.equal(resp.status, 403);
  });

  it('value-free error messages never echo the input name', () => {
    const store = createStubStore();
    try {
      defineDeclarativeResource({
        name: 'bad/name',
        serializer: serializerFields,
        store,
        authorize: async () => true,
      });
      assert.fail('Expected DeclarativeResourceError');
    } catch (e: unknown) {
      assert.ok(e instanceof DeclarativeResourceError);
      assert.ok(!e.message.includes('bad/name'), `message must not echo input, got: ${e.message}`);
    }
  });
});
