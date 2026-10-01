/**
 * Unit tests for the per-route middleware chain (`runMiddleware`) and its
 * structural validator (`validateMiddlewareList`). These cover the mechanics
 * every route kind shares — declared-order execution, short-circuiting,
 * at-most-once `next()`, error propagation, and value-free validation — without
 * touching the HTTP layer. Integration behavior for API and page routes is
 * exercised in `server.test.ts` and `pages.test.ts` respectively.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequestContext } from '../../src/contracts/http.js';
import {
  createMiddlewareRegistry,
  MiddlewareError,
  resolveMiddlewareRefs,
  runMiddleware,
  validateMiddlewareList,
  type MiddlewareRegistry,
  type RouteMiddleware,
} from '../../src/routing/middleware.js';

function makeContext(): RequestContext {
  const url = new URL('http://localhost/test');
  return { request: new Request(url), url, params: {}, session: null };
}

describe('runMiddleware', () => {
  it('runs handlers in declared order and reaches the terminal handler', async () => {
    const order: string[] = [];
    const outer: RouteMiddleware = async (_context, next) => {
      order.push('outer:before');
      const response = await next();
      order.push('outer:after');
      return response;
    };
    const inner: RouteMiddleware = (_context, next) => {
      order.push('inner');
      return next();
    };

    const response = await runMiddleware([outer, inner], makeContext(), () => {
      order.push('final');
      return new Response('done');
    });

    assert.equal(await response.text(), 'done');
    assert.deepEqual(order, ['outer:before', 'inner', 'final', 'outer:after']);
  });

  it('short-circuits when a handler returns a Response without calling next', async () => {
    const reached: string[] = [];
    const guard: RouteMiddleware = () => {
      reached.push('guard');
      return new Response('blocked', { status: 403 });
    };

    const response = await runMiddleware([guard], makeContext(), () => {
      reached.push('final');
      return new Response('never');
    });

    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'blocked');
    assert.deepEqual(reached, ['guard']);
  });

  it('awaits a handler that returns a promise of a Response', async () => {
    const response = await runMiddleware(
      [async () => new Response('async')],
      makeContext(),
      () => new Response('final'),
    );
    assert.equal(await response.text(), 'async');
  });

  it('rejects a second call to next()', async () => {
    const handler: RouteMiddleware = async (_context, next) => {
      await next();
      await next();
      return new Response('never');
    };

    await assert.rejects(
      runMiddleware([handler], makeContext(), () => new Response('final')),
      (error: unknown) => error instanceof MiddlewareError && /more than once/.test(error.message),
    );
  });

  it('propagates a thrown handler', async () => {
    await assert.rejects(
      runMiddleware(
        [
          () => {
            throw new Error('boom');
          },
        ],
        makeContext(),
        () => new Response('final'),
      ),
      /boom/,
    );
  });

  it('propagates a rejected handler', async () => {
    await assert.rejects(
      runMiddleware(
        [
          async () => {
            throw new Error('rejected');
          },
        ],
        makeContext(),
        () => new Response('final'),
      ),
      /rejected/,
    );
  });

  it('rejects a thrown final handler', async () => {
    await assert.rejects(
      runMiddleware([], makeContext(), () => {
        throw new Error('final-boom');
      }),
      /final-boom/,
    );
  });
});

describe('validateMiddlewareList', () => {
  const fail = (message: string): Error => new Error(message);

  it('returns undefined for an absent export', () => {
    assert.equal(validateMiddlewareList(undefined, fail), undefined);
  });

  it('accepts an array of functions by identity', () => {
    const handlers: RouteMiddleware[] = [() => new Response('ok')];
    assert.equal(validateMiddlewareList(handlers, fail), handlers);
  });

  it('rejects a non-array export without echoing the value', () => {
    assert.throws(
      () => validateMiddlewareList('not-an-array', fail),
      /exports "middleware" as a non-array value/,
    );
    assert.throws(
      () => validateMiddlewareList(42, fail),
      (error: unknown) => !(error as Error).message.includes('42'),
    );
  });

  it('rejects a non-function entry without echoing the value', () => {
    assert.throws(
      () => validateMiddlewareList([() => new Response(), 42], fail),
      /exports a non-function middleware entry at index 1/,
    );
  });

  it('accepts a string entry (named middleware ref)', () => {
    const result = validateMiddlewareList(['auth'], fail);
    assert.ok(Array.isArray(result));
    assert.equal(result?.length, 1);
  });

  it('rejects an object entry value-free', () => {
    assert.throws(
      () => validateMiddlewareList([() => new Response(), {}], fail),
      /exports a non-function middleware entry at index 1/,
    );
  });
});

describe('createMiddlewareRegistry', () => {
  const fail = (message: string): Error => new Error(message);

  it('builds a registry from a map of names to handlers', () => {
    const handler: RouteMiddleware = () => new Response('ok');
    const registry = createMiddlewareRegistry({ auth: handler }, fail);
    assert.equal(registry.has('auth'), true);
    assert.equal(registry.get('auth'), handler);
    assert.equal(registry.has('unknown'), false);
    assert.equal(registry.get('unknown'), undefined);
  });

  it('rejects a non-function handler value-free', () => {
    assert.throws(
      () =>
        createMiddlewareRegistry({ auth: 'not-a-function' as unknown as RouteMiddleware }, fail),
      /middleware entry is not a function/,
    );
  });

  it('rejects an empty name value-free', () => {
    // ECMAScript normal objects cannot have zero-length keys (they are coerced
    // to strings, and "" is valid), but the validation guards against it.
    const entries: Record<string, RouteMiddleware> = { '': () => new Response('ok') };
    assert.throws(
      () => createMiddlewareRegistry(entries, fail),
      /a middleware entry has an empty name/,
    );
  });

  it('preserves handler identity through get()', () => {
    const handler: RouteMiddleware = () => new Response('ok');
    const registry = createMiddlewareRegistry({ h: handler }, fail);
    assert.equal(registry.get('h'), handler);
  });

  it('names() returns sorted names for a populated map', () => {
    const handler: RouteMiddleware = () => new Response('ok');
    // Insert in non-alphabetical order to verify sorting is deterministic.
    const registry = createMiddlewareRegistry(
      { zebra: handler, alpha: handler, gamma: handler },
      fail,
    );
    const names = registry.names();
    assert.deepStrictEqual(names, ['alpha', 'gamma', 'zebra']);
  });

  it('names() returns empty array for an empty map', () => {
    const registry = createMiddlewareRegistry({}, fail);
    const names = registry.names();
    assert.ok(Array.isArray(names));
    assert.equal(names.length, 0);
  });
});

describe('resolveMiddlewareRefs', () => {
  const fail = (message: string): Error => new Error(message);
  const handler: RouteMiddleware = () => new Response('ok');
  const registry: MiddlewareRegistry = {
    has: (name) => name === 'auth',
    get: (name) => (name === 'auth' ? handler : undefined),
    names: () => ['auth'],
  };

  it('passes inline functions through by identity', () => {
    const fn: RouteMiddleware = () => new Response('inline');
    const resolved = resolveMiddlewareRefs([fn], registry, fail);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0], fn);
  });

  it('resolves a known name to the registered handler', () => {
    const resolved = resolveMiddlewareRefs(['auth'], registry, fail);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0], handler);
  });

  it('preserves order in a mixed list (function + string + function)', () => {
    const first: RouteMiddleware = () => new Response('first');
    const last: RouteMiddleware = () => new Response('last');
    const resolved = resolveMiddlewareRefs([first, 'auth', last], registry, fail);
    assert.equal(resolved.length, 3);
    assert.equal(resolved[0], first);
    assert.equal(resolved[1], handler);
    assert.equal(resolved[2], last);
  });

  it('rejects an unknown name without echoing the name in the message', () => {
    const unknownName = 'secret-middleware-that-does-not-exist';
    // The message must name the index, never the value.
    assert.throws(
      () => resolveMiddlewareRefs(['auth', unknownName], registry, fail),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        return (
          /an unregistered middleware at index 1/.test(error.message) &&
          !error.message.includes(unknownName)
        );
      },
    );
  });

  it('rejects an unknown name with index but no value in the message (string)', () => {
    assert.throws(
      () => resolveMiddlewareRefs(['missing'], registry, fail),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        return (
          /an unregistered middleware at index 0/.test(error.message) &&
          !error.message.includes('missing')
        );
      },
    );
  });
});
