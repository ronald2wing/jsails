import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchesSearch, parseFilters } from '../../src/api/filters.js';
import type { FilterOptions } from '../../src/api/filters.js';
import { ValidationError } from '../../src/api/validation.js';
import { and, or, require, resourcePolicy } from '../../src/api/permissions.js';
import type { PermissionPredicate } from '../../src/api/permissions.js';
import type { RequestContext } from '../../src/contracts/http.js';
import { throttle } from '../../src/api/throttling.js';
import { createMemoryCacheStore } from '../../src/cache/store.js';
import { generateOpenApi } from '../../src/api/openapi.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function context(url = 'https://x.test/api'): RequestContext {
  const request = new Request(url);
  return { request, url: new URL(url), params: {}, session: null };
}

function filterError(fn: () => unknown): ValidationError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    return error;
  }
  assert.fail('expected a ValidationError');
}

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const USER_FIELDS: FilterOptions['fields'] = {
  name: { type: 'string' },
  age: { type: 'integer' },
  active: { type: 'boolean' },
  createdAt: { type: 'string', filterable: false },
  password: { type: 'string', sortable: false },
};

const USER_OPTIONS: FilterOptions = { fields: USER_FIELDS };

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

describe('parseFilters', () => {
  it('parses search, sort, and bracket filters into a normalized query', () => {
    const query = parseFilters(
      new URL('https://x.test/users?search=ada&sort=-age&filter[name]=Ada&filter[age]=30'),
      USER_OPTIONS,
    );

    assert.equal(query.search, 'ada');
    assert.deepEqual(query.sorts, [{ field: 'age', direction: 'desc' }]);
    assert.deepEqual(query.filters, { name: 'Ada', age: 30 });
  });

  it('supports repeated and comma-separated sort params and deduplicates', () => {
    const query = parseFilters(
      new URL('https://x.test/users?sort=name&sort=-age,name'),
      USER_OPTIONS,
    );
    assert.deepEqual(query.sorts, [
      { field: 'name', direction: 'asc' },
      { field: 'age', direction: 'desc' },
    ]);
  });

  it('coerces boolean and integer filter values without coercion of unknown types', () => {
    const query = parseFilters(
      new URL('https://x.test/users?filter[active]=true&filter[age]=-5'),
      USER_OPTIONS,
    );
    assert.deepEqual(query.filters, { active: true, age: -5 });
  });

  it('keeps the last value when a filter field is repeated', () => {
    const query = parseFilters(
      new URL('https://x.test/users?filter[name]=A&filter[name]=B'),
      USER_OPTIONS,
    );
    assert.deepEqual(query.filters, { name: 'B' });
  });

  it('treats a blank search as absent', () => {
    assert.equal(parseFilters(new URL('https://x.test/users?search='), USER_OPTIONS).search, null);
    assert.equal(
      parseFilters(new URL('https://x.test/users?search=%20%20'), USER_OPTIONS).search,
      null,
    );
  });

  it('rejects unknown sort and filter fields', () => {
    assert.equal(
      filterError(() => parseFilters(new URL('https://x.test/u?sort=hax'), USER_OPTIONS)).issues[0]
        ?.code,
      'unknown_sort_field',
    );
    assert.equal(
      filterError(() => parseFilters(new URL('https://x.test/u?filter[hax]=1'), USER_OPTIONS))
        .issues[0]?.code,
      'unknown_filter_field',
    );
  });

  it('rejects unsortable and unfilterable fields', () => {
    assert.equal(
      filterError(() => parseFilters(new URL('https://x.test/u?sort=password'), USER_OPTIONS))
        .issues[0]?.code,
      'unsortable_field',
    );
    assert.equal(
      filterError(() => parseFilters(new URL('https://x.test/u?filter[createdAt]=x'), USER_OPTIONS))
        .issues[0]?.code,
      'unfilterable_field',
    );
  });

  it('rejects out-of-type filter values without echoing them', () => {
    for (const [value, code] of [
      ['filter[age]=abc', 'invalid_filter_value'],
      ['filter[age]=1.5', 'invalid_filter_value'],
      ['filter[active]=yes', 'invalid_filter_value'],
    ] as const) {
      const error = filterError(() =>
        parseFilters(new URL(`https://x.test/u?${value}`), USER_OPTIONS),
      );
      assert.equal(error.issues[0]?.code, code, value);
      assert.ok(!JSON.stringify(error.issues).includes(value.split('=')[1] ?? ''), value);
    }
  });

  it('bounds search, sort, and filter lengths', () => {
    assert.equal(
      filterError(() =>
        parseFilters(new URL('https://x.test/u?search=' + 'x'.repeat(201)), {
          fields: USER_FIELDS,
          maxSearchLength: 200,
        }),
      ).issues[0]?.code,
      'search_too_long',
    );

    assert.equal(
      filterError(() =>
        parseFilters(new URL('https://x.test/u?sort=a,b,c'), {
          fields: { a: {}, b: {}, c: {} },
          maxSorts: 2,
        }),
      ).issues[0]?.code,
      'too_many_sorts',
    );

    assert.equal(
      filterError(() =>
        parseFilters(new URL('https://x.test/u?filter[name]=1&filter[age]=2'), {
          fields: USER_FIELDS,
          maxFilters: 1,
        }),
      ).issues[0]?.code,
      'too_many_filters',
    );

    assert.equal(
      filterError(() =>
        parseFilters(new URL('https://x.test/u?filter[name]=' + 'y'.repeat(6)), {
          fields: USER_FIELDS,
          maxFilterValueLength: 5,
        }),
      ).issues[0]?.code,
      'filter_value_too_long',
    );
  });

  it('ignores parameters outside the documented forms', () => {
    const query = parseFilters(
      new URL('https://x.test/u?filter=x&f_name=Ada&page=2'),
      USER_OPTIONS,
    );
    assert.equal(query.search, null);
    assert.deepEqual(query.sorts, []);
    assert.deepEqual(query.filters, {});
  });
});

describe('matchesSearch', () => {
  it('matches case-insensitive substrings across declared fields', () => {
    const row = { name: 'Ada Lovelace', age: 36, active: true };
    assert.equal(matchesSearch(row, ['name', 'age'], 'love'), true);
    assert.equal(matchesSearch(row, ['name'], 'ADA'), true);
    assert.equal(matchesSearch(row, ['name', 'age'], '36'), true);
    assert.equal(matchesSearch(row, ['name'], 'zzz'), false);
  });

  it('returns true for a blank term and false for non-object rows', () => {
    assert.equal(matchesSearch({ name: 'Ada' }, ['name'], ''), true);
    assert.equal(matchesSearch({ name: 'Ada' }, ['name'], null), true);
    assert.equal(matchesSearch(null, ['name'], 'ada'), false);
    assert.equal(matchesSearch(['Ada'], ['0'], 'ada'), false);
  });
});

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

describe('permission predicates', () => {
  it('require coerces loose predicates to an exact boolean', async () => {
    const truthy = require<unknown>((async () => 'yes') as unknown as PermissionPredicate<unknown>);
    assert.equal(await truthy(context(), 'list'), false);

    const throwing = require<unknown>(async () => {
      throw new Error('boom');
    });
    assert.equal(await throwing(context(), 'list'), false);

    const allowed = require<unknown>(async () => true);
    assert.equal(await allowed(context(), 'list'), true);
  });

  it('and requires every predicate; or requires any', async () => {
    const yes: PermissionPredicate<unknown> = async () => true;
    const no: PermissionPredicate<unknown> = async () => false;

    assert.equal(await and(yes, yes)(context(), 'list'), true);
    assert.equal(await and(yes, no)(context(), 'list'), false);
    assert.equal(await or(yes, no)(context(), 'list'), true);
    assert.equal(await or(no, no)(context(), 'list'), false);
  });

  it('short-circuits and/or on the first decisive predicate', async () => {
    let called = 0;
    const spy: PermissionPredicate<unknown> = async () => {
      called += 1;
      return true;
    };
    const no: PermissionPredicate<unknown> = async () => false;

    await and(no, spy)(context(), 'list');
    assert.equal(called, 0, 'and must short-circuit after a denial');

    called = 0;
    await or(spy, no)(context(), 'list');
    assert.equal(called, 1, 'or must short-circuit after an allowance');
  });

  it('resourcePolicy maps CRUD to action names and denies missing actions', async () => {
    const policy = resourcePolicy<unknown>({
      list: async () => true,
      get: async () => true,
      update: async () => true,
    });

    assert.equal(await policy(context(), 'list'), true);
    assert.equal(await policy(context(), 'retrieve'), true);
    assert.equal(await policy(context(), 'update'), true);
    assert.equal(await policy(context(), 'create'), false, 'missing create must deny');
    assert.equal(await policy(context(), 'delete'), false, 'missing delete must deny');
  });
});

// ---------------------------------------------------------------------------
// throttling
// ---------------------------------------------------------------------------

describe('throttle', () => {
  it('allows under the limit and blocks over it with a value-free 429 + Retry-After', async () => {
    const { now } = fakeClock();
    const store = createMemoryCacheStore({ now });

    const first = await throttle({ key: 'ip:1', limit: 1, windowMs: 1000, store, now });
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 0);
    assert.equal(first.response, null);

    const second = await throttle({ key: 'ip:1', limit: 1, windowMs: 1000, store, now });
    assert.equal(second.allowed, false);
    assert.equal(second.remaining, 0);
    const response = second.response;
    assert.ok(response);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!(await response.text()).includes('ip:1'));
  });

  it('keeps independent keys in independent windows', async () => {
    const { now } = fakeClock();
    const store = createMemoryCacheStore({ now });

    const a = await throttle({ key: 'a', limit: 1, windowMs: 1000, store, now });
    const b = await throttle({ key: 'b', limit: 1, windowMs: 1000, store, now });
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
  });

  it('reuses a shared in-memory store when no store is supplied', async () => {
    const first = await throttle({ key: 'shared:default', limit: 1, windowMs: 60_000 });
    const second = await throttle({ key: 'shared:default', limit: 1, windowMs: 60_000 });
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, false);
  });

  it('rejects invalid options with a TypeError', async () => {
    await assert.rejects(throttle({ key: '', limit: 1, windowMs: 1000 }), TypeError);
    await assert.rejects(throttle({ key: 'k', limit: 0, windowMs: 1000 }), TypeError);
    await assert.rejects(throttle({ key: 'k', limit: 1, windowMs: 0 }), TypeError);
  });
});

// ---------------------------------------------------------------------------
// openapi
// ---------------------------------------------------------------------------

describe('generateOpenApi', () => {
  const options = {
    title: 'Test API',
    version: '1.2.3',
    resources: {
      users: {
        path: '/users',
        tag: 'users',
        description: 'users',
        queryParams: [
          { name: 'active', schema: { type: 'boolean' } },
          { name: 'q', schema: { type: 'string' } },
        ],
        requestSchema: { type: 'object', properties: { email: { type: 'string' } } },
        responseSchema: { type: 'object', properties: { id: { type: 'integer' } } },
      },
      posts: { path: '/posts' },
    },
  } as const;

  it('produces deterministic output across calls', () => {
    assert.equal(
      JSON.stringify(generateOpenApi(options)),
      JSON.stringify(generateOpenApi(options)),
    );
  });

  it('emits list/get/create/update/delete with sorted paths and methods', () => {
    const doc = generateOpenApi(options);
    assert.equal(doc.openapi, '3.0.3');
    assert.deepEqual(doc.info, { title: 'Test API', version: '1.2.3' });

    const pathKeys = Object.keys(doc.paths);
    assert.deepEqual(pathKeys, ['/posts', '/posts/{id}', '/users', '/users/{id}']);

    const users = doc.paths['/users'];
    assert.ok(users);
    assert.deepEqual(Object.keys(users), ['get', 'post']);
    const userDetail = doc.paths['/users/{id}'];
    assert.ok(userDetail);
    assert.deepEqual(Object.keys(userDetail), ['get', 'patch', 'delete']);
  });

  it('sorts query parameters and tags deterministically', () => {
    const doc = generateOpenApi(options);
    const list = doc.paths['/users']?.get;
    assert.ok(list);
    assert.deepEqual(
      (list.parameters ?? []).map((param) => param.name),
      ['active', 'q'],
    );
    assert.deepEqual(
      doc.tags?.map((tag) => tag.name),
      ['posts', 'users'],
    );
  });

  it('includes request/response shapes and a path parameter on detail routes', () => {
    const doc = generateOpenApi(options);
    const create = doc.paths['/users']?.post;
    assert.ok(create);
    assert.deepEqual(create.requestBody?.content['application/json'].schema.type, 'object');

    const detail = doc.paths['/users/{id}']?.get;
    assert.ok(detail);
    assert.deepEqual(detail.parameters?.[0], {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  });

  it('omits requestBody/content when no schema is declared', () => {
    const doc = generateOpenApi(options);
    const posts = doc.paths['/posts']?.post;
    assert.ok(posts);
    assert.equal(posts.requestBody, undefined);
    assert.equal(posts.responses['201']?.content, undefined);
  });
});
