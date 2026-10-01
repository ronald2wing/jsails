/**
 * Unit tests for the per-route middleware contract. Composition and execution
 * are now owned by Hono (see `server.test.ts` for the live chain); this module
 * covers only the structural validator for a route module's `middleware` export
 * — the one surface JSails still owns.
 *
 * The former hand-rolled chain (`runMiddleware`, `MiddlewareRegistry`,
 * `createMiddlewareRegistry`, `resolveMiddlewareRefs`, `MiddlewareError`) is
 * deleted: Hono's `MiddlewareHandler` inputs are composed by `app.use`/`app.on`,
 * `next()` is single-use by construction, and string refs are resolved at
 * assembly time by the application/config layers (covered in `server.test.ts`
 * and `app-config.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateMiddlewareList, type RouteMiddleware } from '../../src/routing/middleware.js';

describe('validateMiddlewareList', () => {
  const fail = (message: string): Error => new Error(message);

  it('returns undefined for an absent export', () => {
    assert.equal(validateMiddlewareList(undefined, fail), undefined);
  });

  it('accepts an array of functions by identity', () => {
    const handlers: RouteMiddleware[] = [async (_c, next) => next()];
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
    const handler: RouteMiddleware = async (_c, next) => next();
    assert.throws(
      () => validateMiddlewareList([handler, 42], fail),
      /exports a non-function middleware entry at index 1/,
    );
  });

  it('accepts a string entry (named middleware ref)', () => {
    const result = validateMiddlewareList(['auth'], fail);
    assert.ok(Array.isArray(result));
    assert.equal(result?.length, 1);
  });

  it('rejects an empty string entry (invalid name ref)', () => {
    assert.throws(
      () => validateMiddlewareList([''], fail),
      /exports an empty middleware name at index 0/,
    );
  });

  it('rejects an object entry value-free', () => {
    const handler: RouteMiddleware = async (_c, next) => next();
    assert.throws(
      () => validateMiddlewareList([handler, {}], fail),
      /exports a non-function middleware entry at index 1/,
    );
  });
});
