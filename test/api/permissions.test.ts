import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { and, or, createPermissionRegistry } from '../../src/api/permissions.js';
import type { PermissionPredicate } from '../../src/api/permissions.js';
import type { RequestContext } from '../../src/contracts/http.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function context(url = 'https://x.test/api'): RequestContext {
  const request = new Request(url);
  return { request, url: new URL(url), params: {}, session: null };
}

const allow: PermissionPredicate = async () => true;
const deny: PermissionPredicate = async () => false;

// ---------------------------------------------------------------------------
// createPermissionRegistry
// ---------------------------------------------------------------------------

describe('createPermissionRegistry', () => {
  it('registers a predicate and retrieves it by name', () => {
    const registry = createPermissionRegistry();
    registry.register('edit', allow);
    assert.strictEqual(registry.get('edit'), allow);
    assert.strictEqual(registry.has('edit'), true);
  });

  it('returns undefined for an unknown name', () => {
    const registry = createPermissionRegistry();
    assert.strictEqual(registry.get('missing'), undefined);
    assert.strictEqual(registry.has('missing'), false);
  });

  it('returns registered names in insertion order', () => {
    const registry = createPermissionRegistry();
    registry.register('edit', allow);
    registry.register('delete', deny);
    registry.register('view', allow);
    assert.deepStrictEqual(registry.names(), ['edit', 'delete', 'view']);
  });

  it('names() returns a frozen array', () => {
    const registry = createPermissionRegistry();
    registry.register('edit', allow);
    assert.throws(() => {
      (registry.names() as string[]).push('extra');
    }, TypeError);
  });

  it('seeds from an initial record', () => {
    const registry = createPermissionRegistry({ edit: allow, view: deny });
    assert.strictEqual(registry.get('edit'), allow);
    assert.strictEqual(registry.get('view'), deny);
    assert.strictEqual(registry.has('edit'), true);
    assert.deepStrictEqual(registry.names(), ['edit', 'view']);
  });

  it('rejects a duplicate name at register time', () => {
    const registry = createPermissionRegistry();
    registry.register('edit', allow);
    assert.throws(() => registry.register('edit', deny), TypeError);
  });

  it('rejects a duplicate name from the initial record', () => {
    assert.throws(() => {
      const r = createPermissionRegistry({ edit: allow });
      r.register('edit', deny);
    }, TypeError);
  });

  it('rejects an empty name at register time', () => {
    const registry = createPermissionRegistry();
    assert.throws(() => registry.register('', allow), TypeError);
  });

  it('rejects an empty name from the initial record', () => {
    assert.throws(() => createPermissionRegistry({ '': allow }), TypeError);
  });

  it('a registered predicate composes with and()', async () => {
    const registry = createPermissionRegistry({ pass: allow, fail: deny });
    const combined = and(registry.get('pass')!, registry.get('fail')!);
    const result = await combined(context(), 'list');
    assert.strictEqual(result, false);
  });

  it('a registered predicate composes with or()', async () => {
    const registry = createPermissionRegistry({ pass: allow, fail: deny });
    const combined = or(registry.get('pass')!, registry.get('fail')!);
    const result = await combined(context(), 'list');
    assert.strictEqual(result, true);
  });

  it('get returns the same predicate identity', () => {
    const registry = createPermissionRegistry({ edit: allow });
    assert.strictEqual(registry.get('edit'), allow);
  });

  it('has returns true only for registered names', () => {
    const registry = createPermissionRegistry();
    registry.register('view', allow);
    assert.strictEqual(registry.has('view'), true);
    assert.strictEqual(registry.has('edit'), false);
  });
});
