/**
 * Store resource tests: verify `defineStoreResource` synthesises working
 * `list`/`get`/`save` callbacks from a `ResourceStore` + `Serializer`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineStoreResource, StoreResourceError } from '../../src/admin/index.js';
import type { ResourceStore } from '../../src/api/resource.js';
import type { Serializer } from '../../src/api/serialization.js';
import type { RequestContext, Session } from '../../src/contracts/http.js';
import type {
  ResourceListContext,
  ResourceGetContext,
  ResourceSaveContext,
} from '../../src/admin/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION: Session = {
  id: 'test-session',
  csrfToken: 'csrf-token',
  data: {},
  expiresAt: 2_000_000_000_000,
};

function listContext(overrides: Partial<ResourceListContext> = {}): ResourceListContext {
  return {
    session: SESSION,
    page: 1,
    pageSize: 10,
    ...overrides,
  };
}

function getContext(id: string): ResourceGetContext {
  return { session: SESSION, id };
}

function saveContext(id: string | null, values: Record<string, unknown>): ResourceSaveContext {
  return { session: SESSION, id, values };
}

interface TestRecord {
  id: number;
  name: string;
  active: boolean;
}

interface SpyStore {
  countCalls: number;
  listCalls: Array<{ offset: number; limit: number; context: RequestContext }>;
  getCalls: Array<{ id: string; context: RequestContext }>;
  createCalls: Array<{ data: unknown; context: RequestContext }>;
  updateCalls: Array<{ id: string; data: unknown; context: RequestContext }>;
  rows: TestRecord[];
}

function makeStore(): { store: ResourceStore<TestRecord, any, any>; spy: SpyStore } {
  const spy: SpyStore = {
    countCalls: 0,
    listCalls: [],
    getCalls: [],
    createCalls: [],
    updateCalls: [],
    rows: [],
  };

  const store: ResourceStore<TestRecord, any, any> = {
    async count(_context: RequestContext): Promise<number> {
      spy.countCalls++;
      return spy.rows.length;
    },
    async list(offset: number, limit: number, context: RequestContext): Promise<TestRecord[]> {
      spy.listCalls.push({ offset, limit, context });
      return spy.rows.slice(offset, offset + limit);
    },
    async get(id: string, context: RequestContext): Promise<TestRecord | null> {
      spy.getCalls.push({ id, context });
      const numId = Number(id);
      return spy.rows.find((r) => r.id === numId) ?? null;
    },
    async create(data: any, context: RequestContext): Promise<TestRecord> {
      spy.createCalls.push({ data, context });
      const record = { ...data, id: spy.rows.length + 1 };
      spy.rows.push(record);
      return record;
    },
    async update(id: string, data: any, context: RequestContext): Promise<TestRecord | null> {
      spy.updateCalls.push({ id, data, context });
      const idx = spy.rows.findIndex((r) => r.id === Number(id));
      if (idx === -1) return null;
      spy.rows[idx] = { ...spy.rows[idx]!, ...data };
      return spy.rows[idx]!;
    },
    async delete(_id: string, _context: RequestContext): Promise<void> {
      // noop
    },
  };

  return { store, spy };
}

function makeSerializer(): Serializer<any, any> {
  return {
    fields: {},
    validate(input: unknown): any {
      return input;
    },
    toRepresentation(data: unknown): any {
      return data;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defineStoreResource', () => {
  it('synthesises list that derives offset from page/pageSize', async () => {
    const { store, spy } = makeStore();
    spy.rows.push(
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false },
      { id: 3, name: 'Carol', active: true },
    );

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    const result = await resource.list(listContext({ page: 2, pageSize: 2 }));

    assert.equal(result.total, 3);
    assert.equal(result.rows.length, 1);
    assert.equal((result.rows[0] as any).name, 'Carol');
    assert.equal(spy.listCalls.length, 1);
    const listCall = spy.listCalls[0]!;
    assert.equal(listCall.offset, 2); // (page 2 - 1) * 2 = 2
    assert.equal(listCall.limit, 2);
    assert.equal(spy.countCalls, 1);
  });

  it('synthesises list that defaults pageSize when zero', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.list(listContext({ page: 1, pageSize: 0 }));

    assert.ok(spy.listCalls.length > 0);
    assert.equal(spy.listCalls[0]!.offset, 0);
    assert.equal(spy.listCalls[0]!.limit, 25); // DEFAULT_PAGE_SIZE
  });

  it('list offset is zero-based from page 1', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.list(listContext({ page: 1, pageSize: 10 }));

    assert.ok(spy.listCalls.length > 0);
    assert.equal(spy.listCalls[0]!.offset, 0);
    assert.equal(spy.listCalls[0]!.limit, 10);
  });

  it('synthesises get that delegates to store.get', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 42, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    const record = await resource.get!(getContext('42'));

    assert.notEqual(record, null);
    assert.equal(record!.name, 'Alice');
    assert.equal(spy.getCalls.length, 1);
    assert.equal(spy.getCalls[0]!.id, '42');
  });

  it('get returns null when store.get returns null', async () => {
    const { store } = makeStore();

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    const record = await resource.get!(getContext('99'));

    assert.equal(record, null);
  });

  it('synthesises save that dispatches create when id is null', async () => {
    const { store, spy } = makeStore();

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.save!(saveContext(null, { name: 'Dave', active: true }));

    assert.equal(spy.createCalls.length, 1);
    assert.equal(spy.updateCalls.length, 0);
    assert.deepEqual(spy.createCalls[0]!.data, { name: 'Dave', active: true });
    assert.equal(spy.rows.length, 1);
    assert.equal(spy.rows[0]!.name, 'Dave');
  });

  it('synthesises save that dispatches update when id is a string', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.save!(saveContext('1', { name: 'Alicia' }));

    assert.equal(spy.createCalls.length, 0);
    assert.equal(spy.updateCalls.length, 1);
    assert.equal(spy.updateCalls[0]!.id, '1');
    assert.deepEqual(spy.updateCalls[0]!.data, { name: 'Alicia' });
  });

  it('synthesised save passes request context with session', async () => {
    const { store, spy } = makeStore();

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.save!(saveContext(null, { name: 'Eve' }));

    assert.ok(spy.createCalls.length > 0);
    assert.equal(spy.createCalls[0]!.context.session, SESSION);
  });

  it('synthesised list passes request context with session', async () => {
    const { store, spy } = makeStore();

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.list(listContext());

    assert.ok(spy.listCalls.length > 0);
    assert.equal(spy.listCalls[0]!.context.session, SESSION);
  });

  it('synthesised get passes request context with session', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    await resource.get!(getContext('1'));

    assert.ok(spy.getCalls.length > 0);
    assert.equal(spy.getCalls[0]!.context.session, SESSION);
  });

  it('throws StoreResourceError for a missing store', () => {
    assert.throws(
      () =>
        defineStoreResource({
          slug: 'users',
          store: null as unknown as ResourceStore<any, any, any>,
          serializer: makeSerializer(),
        }),
      StoreResourceError,
    );
  });

  it('throws StoreResourceError for a store missing required methods', () => {
    assert.throws(
      () =>
        defineStoreResource({
          slug: 'users',
          store: { get: () => null } as unknown as ResourceStore<any, any, any>,
          serializer: makeSerializer(),
        }),
      StoreResourceError,
    );
  });

  it('throws StoreResourceError for a missing serializer', () => {
    const { store } = makeStore();
    assert.throws(
      () =>
        defineStoreResource({
          slug: 'users',
          store,
          serializer: null as unknown as Serializer<any, any>,
        }),
      StoreResourceError,
    );
  });

  it('throws StoreResourceError for a non-object spec', () => {
    assert.throws(() => defineStoreResource(null as unknown as any), StoreResourceError);
    assert.throws(() => defineStoreResource('not an object' as unknown as any), StoreResourceError);
  });

  it('throws StoreResourceError for an empty slug', () => {
    const { store } = makeStore();
    assert.throws(
      () =>
        defineStoreResource({
          slug: '',
          store,
          serializer: makeSerializer(),
        }),
      StoreResourceError,
    );
    assert.throws(
      () =>
        defineStoreResource({
          slug: '   ',
          store,
          serializer: makeSerializer(),
        }),
      StoreResourceError,
    );
  });

  it('returns a frozen Resource', () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    assert.ok(Object.isFrozen(resource));
  });

  it('uses serializer toRepresentation for list rows', async () => {
    const { store } = makeStore();
    store.list = async () => [{ id: 1, name: 'Alice', active: true }];
    store.count = async () => 1;

    const wrapped = makeSerializer();
    const calls: unknown[] = [];
    wrapped.toRepresentation = (data: unknown) => {
      calls.push(data);
      return { name: (data as TestRecord).name.toUpperCase() };
    };

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: wrapped,
    });
    const result = await resource.list(listContext());

    assert.equal(calls.length, 1);
    assert.equal((result.rows[0] as any).name, 'ALICE');
  });

  it('uses serializer toRepresentation for get', async () => {
    const { store } = makeStore();
    store.get = async () => ({ id: 1, name: 'Alice', active: true });

    const wrapped = makeSerializer();
    wrapped.toRepresentation = (data: unknown) => ({
      name: (data as TestRecord).name.toUpperCase(),
    });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: wrapped,
    });
    const record = await resource.get!(getContext('1'));

    assert.notEqual(record, null);
    assert.equal(record!.name, 'ALICE');
  });

  it('gracefully ignores sort, direction, search, and filters in list (value-free)', async () => {
    const { store, spy } = makeStore();
    spy.rows.push({ id: 1, name: 'Alice', active: true });

    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });

    // These should not throw — the store.list signature has no sort/filter params
    const result = await resource.list(
      listContext({
        sort: 'name',
        direction: 'desc',
        search: 'Alice',
        filters: { status: 'active' },
      }),
    );

    assert.equal(result.total, 1);
    assert.ok(spy.listCalls.length > 0);
  });

  it('defaults label to slug when omitted', () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'my-resource',
      store,
      serializer: makeSerializer(),
    });
    assert.equal(resource.label, 'my-resource');
  });

  it('uses explicit label when provided', () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'my-resource',
      label: 'My Resource',
      store,
      serializer: makeSerializer(),
    });
    assert.equal(resource.label, 'My Resource');
  });

  it('uses explicit columns when provided', async () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
      columns: [{ name: 'name', label: 'Name' }],
    });
    assert.equal(resource.columns.length, 1);
    assert.equal(resource.columns[0]!.name, 'name');
  });

  it('defaults columns to a single id column when omitted', () => {
    const { store } = makeStore();
    const resource = defineStoreResource({
      slug: 'users',
      store,
      serializer: makeSerializer(),
    });
    assert.equal(resource.columns.length, 1);
    assert.equal(resource.columns[0]!.name, 'id');
    assert.equal(resource.columns[0]!.label, 'ID');
  });
});
