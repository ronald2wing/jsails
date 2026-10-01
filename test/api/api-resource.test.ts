import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineSerializer } from '../../src/api/serialization.js';
import { integer, string } from '../../src/api/validation.js';
import type { RequestContext, Session } from '../../src/contracts/http.js';
import { createResourceHandlers } from '../../src/api/resource.js';
import type {
  Authorize,
  CollectionHandlers,
  DetailHandlers,
  ResourceAction,
  ResourceHandler,
  ResourceHandlers,
  ResourceStore,
} from '../../src/api/resource.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface UserRow {
  id: number;
  email: string;
  password: string;
  name?: string;
  ownerId?: string;
}

type UserInput = { email: string; password: string; name?: string };

/** A serializer with a readOnly id and a writeOnly password. */
const userSerializer = defineSerializer({
  id: { schema: integer(), readOnly: true },
  email: string({ min: 1 }),
  password: { schema: string({ min: 8 }), writeOnly: true },
  name: string({ optional: true }),
});

const SESSION: Session = {
  id: 'sess_1',
  csrfToken: 'csrf_1',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

const allowAll: Authorize<UserRow> = async () => true;
const denyAll: Authorize<UserRow> = async () => false;

function makeRequest(method: string, url: string, body?: string): Request {
  return new Request(url, { method, body });
}

function makeContext(
  request: Request,
  params: Record<string, string> = {},
  session: Session | null = null,
): RequestContext {
  return { request, url: new URL(request.url), params, session };
}

/** Unscoped in-memory store; records method calls for deny-path assertions. */
function createMemoryStore(seed: UserRow[] = []) {
  const rows = new Map<string, UserRow>();
  const calls: string[] = [];
  let nextId = 1;
  for (const row of seed) {
    rows.set(String(row.id), row);
    nextId = Math.max(nextId, row.id + 1);
  }

  const store: ResourceStore<UserRow, UserInput> = {
    async count() {
      calls.push('count');
      return rows.size;
    },
    async list(offset, limit) {
      calls.push('list');
      return [...rows.values()].slice(offset, offset + limit);
    },
    async get(id) {
      calls.push('get');
      return rows.get(id) ?? null;
    },
    async create(data) {
      calls.push('create');
      const row: UserRow = { id: nextId++, ...data };
      rows.set(String(row.id), row);
      return row;
    },
    async update(id, data) {
      calls.push('update');
      const existing = rows.get(id);
      if (existing === undefined) {
        return null;
      }
      const updated: UserRow = { ...existing, ...data, id: existing.id };
      rows.set(id, updated);
      return updated;
    },
    async delete(id) {
      calls.push('delete');
      rows.delete(id);
    },
  };

  return { store, rows, calls };
}

/** Store that scopes `count`/`list` to the session's userId. */
function createScopedStore(seed: UserRow[]) {
  const data = new Map<string, UserRow>();
  let nextId = 1;
  for (const row of seed) {
    data.set(String(row.id), row);
    nextId = Math.max(nextId, row.id + 1);
  }

  const ownerOf = (context: RequestContext): string | undefined =>
    typeof context.session?.data.userId === 'string' ? context.session.data.userId : undefined;

  const store: ResourceStore<UserRow, UserInput> = {
    async count(context) {
      const owner = ownerOf(context);
      return [...data.values()].filter((row) => owner === undefined || row.ownerId === owner)
        .length;
    },
    async list(offset, limit, context) {
      const owner = ownerOf(context);
      const scoped = [...data.values()].filter(
        (row) => owner === undefined || row.ownerId === owner,
      );
      return scoped.slice(offset, offset + limit);
    },
    async get(id) {
      return data.get(id) ?? null;
    },
    async create(input) {
      const row: UserRow = { id: nextId++, ...input };
      data.set(String(row.id), row);
      return row;
    },
    async update(id, input) {
      const existing = data.get(id);
      if (existing === undefined) {
        return null;
      }
      const updated: UserRow = { ...existing, ...input, id: existing.id };
      data.set(id, updated);
      return updated;
    },
    async delete(id) {
      data.delete(id);
    },
  };

  return store;
}

function userRow(id: number, overrides: Partial<UserRow> = {}): UserRow {
  return { id, email: `user${id}@example.com`, password: 'secret123', ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createResourceHandlers', () => {
  it('returns method-keyed handlers without needing an HTTP server', async () => {
    const { store } = createMemoryStore([userRow(1)]);
    const handlers: ResourceHandlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const collection: CollectionHandlers = handlers.collection;
    const detail: DetailHandlers = handlers.detail;
    const listHandler: ResourceHandler = collection.GET;

    assert.equal(typeof listHandler, 'function');
    assert.equal(typeof collection.POST, 'function');
    assert.equal(typeof detail.GET, 'function');
    assert.equal(typeof detail.PATCH, 'function');
    assert.equal(typeof detail.DELETE, 'function');
  });

  it('authorizes with the correct action names, general then object-level', async () => {
    const { store } = createMemoryStore([userRow(1)]);
    const actions: ResourceAction[] = [];
    const authorize: Authorize<UserRow> = async (_context, action) => {
      actions.push(action);
      return true;
    };
    const handlers = createResourceHandlers({ serializer: userSerializer, store, authorize });

    const list = makeRequest('GET', 'https://x.test/api/users');
    await handlers.collection.GET(list, makeContext(list));
    assert.deepEqual(actions.splice(0), ['list']);

    const detail = makeRequest('GET', 'https://x.test/api/users/1');
    await handlers.detail.GET(detail, makeContext(detail, { id: '1' }));
    assert.deepEqual(actions.splice(0), ['retrieve', 'retrieve']);

    const create = makeRequest(
      'POST',
      'https://x.test/api/users',
      JSON.stringify({ email: 'n@x.test', password: 'secret123' }),
    );
    await handlers.collection.POST(create, makeContext(create));
    assert.deepEqual(actions.splice(0), ['create']);
  });

  it('denies by default without touching the store', async () => {
    const { store, calls } = createMemoryStore([userRow(1)]);
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: denyAll,
    });

    const list = makeRequest('GET', 'https://x.test/api/users');
    assert.equal((await handlers.collection.GET(list, makeContext(list))).status, 403);

    const detail = makeRequest('GET', 'https://x.test/api/users/1');
    assert.equal((await handlers.detail.GET(detail, makeContext(detail, { id: '1' }))).status, 403);

    const create = makeRequest(
      'POST',
      'https://x.test/api/users',
      JSON.stringify({ email: 'n@x.test', password: 'secret123' }),
    );
    assert.equal((await handlers.collection.POST(create, makeContext(create))).status, 403);

    const remove = makeRequest('DELETE', 'https://x.test/api/users/1');
    assert.equal(
      (await handlers.detail.DELETE(remove, makeContext(remove, { id: '1' }))).status,
      403,
    );

    assert.deepEqual(calls, []);
  });

  it('denies when authorize resolves a truthy non-boolean value', async () => {
    for (const value of [1, 'yes', {}, []]) {
      const { store, calls } = createMemoryStore([userRow(1)]);
      const authorize = (async () => value) as unknown as Authorize<UserRow>;
      const handlers = createResourceHandlers({ serializer: userSerializer, store, authorize });

      const request = makeRequest('GET', 'https://x.test/api/users');
      const response = await handlers.collection.GET(request, makeContext(request));
      assert.equal(response.status, 403, JSON.stringify(value));
      assert.deepEqual(calls, [], `store touched for ${JSON.stringify(value)}`);
    }
  });

  it('denies when authorize throws, without touching the store', async () => {
    const { store, calls } = createMemoryStore([userRow(1)]);
    const authorize: Authorize<UserRow> = async () => {
      throw new Error('boom');
    };
    const handlers = createResourceHandlers({ serializer: userSerializer, store, authorize });

    const request = makeRequest('GET', 'https://x.test/api/users');
    const response = await handlers.collection.GET(request, makeContext(request));
    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
  });

  it('scopes list and count to the caller via the store context', async () => {
    const store = createScopedStore([
      { ...userRow(1), ownerId: 'u1' },
      { ...userRow(2), ownerId: 'u2' },
      { ...userRow(3), ownerId: 'u1' },
    ]);
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest('GET', 'https://x.test/api/users?page=1&pageSize=100');
    const response = await handlers.collection.GET(request, makeContext(request, {}, SESSION));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.count, 2);
    assert.equal(body.results.length, 2);
    assert.deepEqual(
      body.results.map((row: { id: number }) => row.id).sort((a: number, b: number) => a - b),
      [1, 3],
    );
    assert.ok(body.results.every((row: Record<string, unknown>) => !('password' in row)));
  });

  it('fetches then object-level authorizes before serializing on detail', async () => {
    const { store } = createMemoryStore([userRow(1), userRow(2)]);
    const authorize: Authorize<UserRow> = async (_context, _action, resource) =>
      resource === undefined || resource.id === 1;
    const handlers = createResourceHandlers({ serializer: userSerializer, store, authorize });

    const allowed = makeRequest('GET', 'https://x.test/api/users/1');
    assert.equal(
      (await handlers.detail.GET(allowed, makeContext(allowed, { id: '1' }))).status,
      200,
    );

    const denied = makeRequest('GET', 'https://x.test/api/users/2');
    assert.equal((await handlers.detail.GET(denied, makeContext(denied, { id: '2' }))).status, 403);
  });

  it('whitelists response fields and hides the writeOnly password', async () => {
    const { store } = createMemoryStore([
      { ...userRow(1), password: 'hunter2-secret', name: 'Ada', ownerId: 'u9' },
    ]);
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest('GET', 'https://x.test/api/users/1');
    const response = await handlers.detail.GET(request, makeContext(request, { id: '1' }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { id: 1, email: 'user1@example.com', name: 'Ada' });
    assert.ok(!('password' in body));
    assert.ok(!('ownerId' in body));
  });

  it('creates a record and returns 201 with the representation', async () => {
    const { store, rows } = createMemoryStore();
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest(
      'POST',
      'https://x.test/api/users',
      JSON.stringify({ email: 'new@example.com', password: 'hunter2-secret' }),
    );
    const response = await handlers.collection.POST(request, makeContext(request));

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.email, 'new@example.com');
    assert.equal(typeof body.id, 'number');
    assert.ok(!('password' in body));
    assert.equal(rows.get(String(body.id))?.password, 'hunter2-secret');
  });

  it('applies a partial update without defaulting or overwriting absent fields', async () => {
    const { store, rows } = createMemoryStore([{ ...userRow(1), name: 'Ada' }]);
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest(
      'PATCH',
      'https://x.test/api/users/1',
      JSON.stringify({ name: 'Grace' }),
    );
    const response = await handlers.detail.PATCH(request, makeContext(request, { id: '1' }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.name, 'Grace');
    assert.equal(body.email, 'user1@example.com');
    assert.ok(!('password' in body));
    assert.equal(rows.get('1')?.password, 'secret123');
  });

  it('rejects unknown fields with a 400 and value-free messages', async () => {
    const { store } = createMemoryStore();
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const secret = 'hunter2-secret';
    const request = makeRequest(
      'POST',
      'https://x.test/api/users',
      JSON.stringify({ email: 'a@b.c', password: secret, admin: true }),
    );
    const response = await handlers.collection.POST(request, makeContext(request));

    assert.equal(response.status, 400);
    const body = await response.json();
    const unknown = body.errors.find((issue: { code: string }) => issue.code === 'unknown_field');
    assert.deepEqual(unknown.path, ['admin']);
    assert.ok(!JSON.stringify(body).includes(secret));
  });

  it('rejects a missing required field with a 400', async () => {
    const { store } = createMemoryStore();
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest(
      'POST',
      'https://x.test/api/users',
      JSON.stringify({ email: 'a@b.c' }),
    );
    const response = await handlers.collection.POST(request, makeContext(request));

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body.errors.some((issue: { code: string }) => issue.code === 'required'));
  });

  it('returns a generic 400 for malformed JSON', async () => {
    const { store } = createMemoryStore();
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest('POST', 'https://x.test/api/users', '{ not json');
    const response = await handlers.collection.POST(request, makeContext(request));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid JSON' });
  });

  it('caps an oversized pageSize at the configured bound', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => userRow(index + 1));
    const { store } = createMemoryStore(rows);
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest('GET', 'https://x.test/api/users?page=1&pageSize=1000000');
    const response = await handlers.collection.GET(request, makeContext(request));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.count, 250);
    assert.equal(body.pageSize, 100);
    assert.equal(body.results.length, 100);
    assert.equal(body.next, 2);
    assert.equal(body.previous, null);
  });

  it('rejects non-canonical page/pageSize strings with a 400', async () => {
    const { store } = createMemoryStore([userRow(1)]);
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    for (const query of [
      'page=2.5',
      'page=1e3',
      'page=0',
      'page=-1',
      'page=Infinity',
      'page=NaN',
      'pageSize=abc',
      'pageSize=1.0',
      'pageSize=+10',
    ]) {
      const request = makeRequest('GET', `https://x.test/api/users?${query}`);
      const response = await handlers.collection.GET(request, makeContext(request));
      assert.equal(response.status, 400, `expected 400 for ${query}`);
    }
  });

  it('rejects bodies larger than maxJsonBytes via the streamed reader', async () => {
    const { store } = createMemoryStore();
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
      maxJsonBytes: 16,
    });

    const request = makeRequest(
      'POST',
      'https://x.test/api/users',
      JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(100) }),
    );
    const response = await handlers.collection.POST(request, makeContext(request));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Request body too large' });
  });

  it('rejects an oversized declared content-length before reading the body', async () => {
    const { store, calls } = createMemoryStore();
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const headers = new Headers({ 'content-length': '100000' });
    const request = new Request('https://x.test/api/users', {
      method: 'POST',
      headers,
      body: '{}',
    });
    const response = await handlers.collection.POST(request, makeContext(request));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Request body too large' });
    assert.ok(!calls.includes('create'));
  });

  it('maps unexpected store errors to a generic 500 without leaking details', async () => {
    const store: ResourceStore<UserRow, UserInput> = {
      async count() {
        throw new Error('secret db connection refused');
      },
      async list() {
        return [];
      },
      async get() {
        return null;
      },
      async create() {
        return userRow(1);
      },
      async update() {
        return null;
      },
      async delete() {},
    };
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest('GET', 'https://x.test/api/users');
    const response = await handlers.collection.GET(request, makeContext(request));

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: 'Internal server error' });
    assert.ok(!JSON.stringify(body).includes('secret'));
  });

  it('returns 404 for a missing record', async () => {
    const { store } = createMemoryStore([userRow(1)]);
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest('GET', 'https://x.test/api/users/999');
    const response = await handlers.detail.GET(request, makeContext(request, { id: '999' }));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  });

  it('deletes a record and returns 204 with no content', async () => {
    const { store, rows } = createMemoryStore([userRow(1)]);
    const handlers = createResourceHandlers({
      serializer: userSerializer,
      store,
      authorize: allowAll,
    });

    const request = makeRequest('DELETE', 'https://x.test/api/users/1');
    const response = await handlers.detail.DELETE(request, makeContext(request, { id: '1' }));

    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(rows.has('1'), false);
  });
});
