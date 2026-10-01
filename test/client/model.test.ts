/**
 * `createModel` primitive tests (Node-import safe, browser-safe).
 *
 * These tests exercise the Livewire-style model layer: a one-way projection of
 * a server-owned state snapshot into `@preact/signals`. They run under plain
 * Node with no DOM because the model imports only `@preact/signals` (which has
 * no DOM dependency), so `signal`, `batch`, `.value`, and `.peek()` are all the
 * transport this module needs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createModel, ModelError, type ModelDefinition } from '../../src/client/model/index.js';

function assertModelError(block: () => unknown, code: ModelError['code']): void {
  assert.throws(block, (err: unknown) => {
    if (!(err instanceof ModelError)) {
      return false;
    }
    return err.name === 'ModelError' && err.code === code;
  });
}

// ---------------------------------------------------------------------------
// createModel — construction and surface
// ---------------------------------------------------------------------------

describe('createModel', () => {
  it('exposes the full Model surface', () => {
    const model = createModel({ fields: { name: {} } });
    assert.equal(typeof model.signal, 'function');
    assert.equal(typeof model.value, 'function');
    assert.equal(typeof model.set, 'function');
    assert.equal(typeof model.project, 'function');
    assert.equal(typeof model.snapshot, 'function');
    assert.equal(typeof model.dispose, 'function');
  });

  it('is frozen', () => {
    const model = createModel({ fields: { name: {} } });
    assert.ok(Object.isFrozen(model));
  });

  it('starts with every field unprojected (undefined)', () => {
    const model = createModel({ fields: { name: {}, draft: { ephemeral: true } } });
    assert.equal(model.value('name'), undefined);
    assert.equal(model.value('draft'), undefined);
  });

  it('returns the same read-only signal for a field on every call', () => {
    const model = createModel({ fields: { name: {} } });
    const first = model.signal('name');
    const second = model.signal('name');
    assert.equal(first, second);
    assert.equal(typeof first.value, 'undefined');
    assert.equal(typeof first.peek, 'function');
    assert.equal(typeof first.subscribe, 'function');
  });
});

// ---------------------------------------------------------------------------
// set / value / signal — local edits
// ---------------------------------------------------------------------------

describe('set', () => {
  it('updates the value and the backing signal', () => {
    const model = createModel({ fields: { name: {} } });
    model.set('name', 'Alice');
    assert.equal(model.value('name'), 'Alice');
    assert.equal(model.signal('name').value, 'Alice');
  });

  it('overwrites a previous edit in place', () => {
    const model = createModel({ fields: { count: {} } });
    model.set('count', 1);
    model.set('count', 2);
    assert.equal(model.value('count'), 2);
  });

  it('accepts an ephemeral field for `set`/`value`/`signal`', () => {
    const model = createModel({ fields: { draft: { ephemeral: true } } });
    model.set('draft', 'scratch');
    assert.equal(model.value('draft'), 'scratch');
    assert.equal(model.signal('draft').value, 'scratch');
  });
});

// ---------------------------------------------------------------------------
// project — strictly one-way snapshot → signals
// ---------------------------------------------------------------------------

describe('project', () => {
  it('projects a snapshot into the signals', () => {
    const model = createModel({ fields: { name: {}, age: {} } });
    model.project({ name: 'Bob', age: 42 });
    assert.equal(model.value('name'), 'Bob');
    assert.equal(model.value('age'), 42);
  });

  it('never mutates the input state object', () => {
    const model = createModel({ fields: { name: {} } });
    const state = { name: 'Carol' };
    model.project(state);
    assert.deepEqual(state, { name: 'Carol' });
    assert.equal(Object.isFrozen(state), false);
  });

  it('replaces synced state (keys absent from the snapshot become undefined)', () => {
    const model = createModel({ fields: { name: {}, age: {} } });
    model.project({ name: 'Dana', age: 30 });
    model.project({ name: 'Eve' });
    assert.equal(model.value('name'), 'Eve');
    assert.equal(model.value('age'), undefined);
  });

  it('ignores extra snapshot keys it does not declare', () => {
    const model = createModel({ fields: { name: {} } });
    model.project({ name: 'Grace', unknown: 'ignored' });
    assert.equal(model.value('name'), 'Grace');
    assert.deepEqual(model.snapshot(), { name: 'Grace' });
  });

  it('does not project ephemeral fields even when they appear in state', () => {
    const model = createModel({ fields: { title: {}, draft: { ephemeral: true } } });
    model.set('draft', 'scratch');
    model.project({ title: 'T', draft: 'SERVER VALUE' });
    assert.equal(model.value('title'), 'T');
    assert.equal(model.value('draft'), 'scratch');
  });

  it('rejects a non-object state value-free', () => {
    const model = createModel({ fields: { name: {} } });
    assertModelError(
      () => model.project(null as unknown as Record<string, unknown>),
      'invalid_state',
    );
    assertModelError(
      () => model.project('nope' as unknown as Record<string, unknown>),
      'invalid_state',
    );
    assertModelError(
      () => model.project([] as unknown as Record<string, unknown>),
      'invalid_state',
    );
  });
});

// ---------------------------------------------------------------------------
// snapshot — serializable synced fields only
// ---------------------------------------------------------------------------

describe('snapshot', () => {
  it('returns only synced fields, excluding ephemeral', () => {
    const model = createModel({ fields: { name: {}, draft: { ephemeral: true } } });
    model.project({ name: 'Frank' });
    model.set('draft', 'scratch');
    assert.deepEqual(model.snapshot(), { name: 'Frank' });
  });

  it('excludes ephemeral fields regardless of their value', () => {
    const model = createModel({ fields: { a: {}, b: { ephemeral: true }, c: {} } });
    model.project({ a: 1, c: 3 });
    model.set('b', 999);
    assert.deepEqual(model.snapshot(), { a: 1, c: 3 });
  });

  it('reflects local edits made after projection', () => {
    const model = createModel({ fields: { name: {} } });
    model.project({ name: 'Grace' });
    model.set('name', 'Heidi');
    assert.deepEqual(model.snapshot(), { name: 'Heidi' });
  });

  it('returns a fresh object on every call', () => {
    const model = createModel({ fields: { name: {} } });
    model.project({ name: 'Ivy' });
    const first = model.snapshot();
    const second = model.snapshot();
    assert.notEqual(first, second);
    assert.deepEqual(first, second);
  });

  it('returns an empty object for an empty field list', () => {
    const model = createModel({ fields: {} });
    assert.deepEqual(model.snapshot(), {});
  });
});

// ---------------------------------------------------------------------------
// unknown fields — value-free ModelError
// ---------------------------------------------------------------------------

describe('unknown fields', () => {
  it('throws ModelError (unknown_field) from signal/value/set', () => {
    const model = createModel({ fields: { name: {} } });
    assertModelError(() => model.signal('nope'), 'unknown_field');
    assertModelError(() => model.value('nope'), 'unknown_field');
    assertModelError(() => model.set('nope', 1), 'unknown_field');
  });

  it('only project/snapshot never consult unknown field names', () => {
    const model = createModel({ fields: { name: {} } });
    assert.doesNotThrow(() => model.project({ extra: true }));
    assert.doesNotThrow(() => model.snapshot());
  });

  it('never echoes the offending field name in the error message', () => {
    const model = createModel({ fields: { name: {} } });
    try {
      model.value('internal-hidden-field');
      assert.fail('expected an unknown-field error');
    } catch (err) {
      assert.ok(err instanceof ModelError);
      assert.equal(err.message.includes('internal-hidden-field'), false);
    }
  });
});

// ---------------------------------------------------------------------------
// immutability — definition and derived descriptors
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('freezes the definition object, its fields, and each field option', () => {
    const definition: ModelDefinition = {
      fields: { name: {}, draft: { ephemeral: true } },
    };
    createModel(definition);

    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.fields));
    assert.ok(Object.isFrozen(definition.fields.name));
    assert.ok(Object.isFrozen(definition.fields.draft));
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe('dispose', () => {
  it('is idempotent', () => {
    const model = createModel({ fields: { name: {} } });
    assert.doesNotThrow(() => model.dispose());
    assert.doesNotThrow(() => model.dispose());
  });

  it('rejects every operation with a disposed error afterwards', () => {
    const model = createModel({ fields: { name: {} } });
    model.dispose();

    assertModelError(() => model.signal('name'), 'disposed');
    assertModelError(() => model.value('name'), 'disposed');
    assertModelError(() => model.set('name', 1), 'disposed');
    assertModelError(() => model.project({ name: 1 }), 'disposed');
    assertModelError(() => model.snapshot(), 'disposed');
  });
});

// ---------------------------------------------------------------------------
// invalid definitions
// ---------------------------------------------------------------------------

describe('invalid definitions', () => {
  it('rejects a non-object definition', () => {
    assertModelError(() => createModel(null as unknown as ModelDefinition), 'invalid_definition');
    assertModelError(() => createModel('nope' as unknown as ModelDefinition), 'invalid_definition');
  });

  it('rejects a missing fields object', () => {
    assertModelError(() => createModel({} as unknown as ModelDefinition), 'invalid_definition');
  });

  it('rejects a non-object field option', () => {
    assertModelError(
      () =>
        createModel({
          fields: { name: 'x' } as unknown as Record<string, ModelDefinition['fields'][string]>,
        }),
      'invalid_definition',
    );
  });

  it('rejects a non-boolean ephemeral flag', () => {
    assertModelError(
      () => createModel({ fields: { name: { ephemeral: 'yes' as unknown as boolean } } }),
      'invalid_definition',
    );
  });

  it('rejects an empty field name', () => {
    assertModelError(() => createModel({ fields: { '': {} } }), 'invalid_definition');
  });

  it('never echoes the offending value in definition errors', () => {
    try {
      createModel({ fields: { name: 'shh-secret' } as unknown as ModelDefinition['fields'] });
      assert.fail('expected a definition error');
    } catch (err) {
      assert.ok(err instanceof ModelError);
      assert.equal(err.message.includes('shh-secret'), false);
    }
  });
});

// ---------------------------------------------------------------------------
// ModelError — exported class + code union
// ---------------------------------------------------------------------------

describe('ModelError', () => {
  it('is an Error with a name and a code', () => {
    const err = new ModelError('boom', 'unknown_field');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ModelError');
    assert.equal(err.code, 'unknown_field');
  });
});
