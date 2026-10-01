/**
 * `bindModel` pull-only binding helper tests (Node-import safe, browser-safe).
 *
 * These tests exercise the coupling of a `createModel` projection to the object
 * that owns the authoritative state. `bindModel` is deliberately pull-only: it
 * never subscribes to the source and never writes a `model.set` edit back into
 * it — the binding layer owns the push side by calling `project()` when the
 * source changes. They run under plain Node because both `model.ts` and
 * `bind-model.ts` import only `@preact/signals` (which has no DOM dependency).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bindModel,
  ModelError,
  type BoundModel,
  type ModelDefinition,
  type ModelSource,
} from '../../src/client/model/index.js';

function assertModelError(block: () => unknown, code: ModelError['code']): void {
  assert.throws(block, (err: unknown) => {
    if (!(err instanceof ModelError)) {
      return false;
    }
    return err.name === 'ModelError' && err.code === code;
  });
}

const definition: ModelDefinition = {
  fields: { title: {}, draft: { ephemeral: true } },
};

// ---------------------------------------------------------------------------
// construction and projection
// ---------------------------------------------------------------------------

describe('bindModel', () => {
  it('projects the source initial state at construction', () => {
    const bound = bindModel({ state: { title: 'Hello' } }, definition);
    assert.equal(bound.model.value('title'), 'Hello');
  });

  it('project() re-reads a mutated source.state', () => {
    const state: Record<string, unknown> = { title: 'One' };
    const bound = bindModel({ state }, definition);
    assert.equal(bound.model.value('title'), 'One');

    state.title = 'Two';
    bound.project();
    assert.equal(bound.model.value('title'), 'Two');
  });

  it('is one-way: model.set never mutates source.state', () => {
    const state: Record<string, unknown> = { title: 'Server' };
    const bound = bindModel({ state }, definition);

    bound.model.set('title', 'Local edit');
    assert.equal(bound.model.value('title'), 'Local edit');
    assert.equal(state.title, 'Server');

    // A later pull overwrites the local edit from the authoritative source,
    // proving the model is only ever a downstream projection.
    bound.project();
    assert.equal(bound.model.value('title'), 'Server');
  });

  it('excludes ephemeral fields from snapshot after projection', () => {
    const bound = bindModel({ state: { title: 'T', draft: 'SERVER VALUE' } }, definition);
    bound.model.set('draft', 'scratch');
    assert.deepEqual(bound.model.snapshot(), { title: 'T' });
  });

  it('returns a frozen BoundModel', () => {
    const bound: BoundModel = bindModel({ state: { title: 'T' } }, definition);
    assert.ok(Object.isFrozen(bound));
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe('dispose', () => {
  it('disposes the model and is idempotent', () => {
    const bound = bindModel({ state: { title: 'T' } }, definition);
    bound.dispose();
    assertModelError(() => bound.model.value('title'), 'disposed');
    assert.doesNotThrow(() => bound.dispose());
  });
});

// ---------------------------------------------------------------------------
// invalid source
// ---------------------------------------------------------------------------

describe('invalid source', () => {
  it('rejects a null source value-free', () => {
    assertModelError(
      () => bindModel(null as unknown as ModelSource, definition),
      'invalid_definition',
    );
  });

  it('rejects a source with no state object', () => {
    assertModelError(
      () => bindModel({} as unknown as ModelSource, definition),
      'invalid_definition',
    );
  });

  it('rejects a non-object state', () => {
    assertModelError(
      () => bindModel({ state: 5 } as unknown as ModelSource, definition),
      'invalid_definition',
    );
    assertModelError(
      () => bindModel({ state: [] } as unknown as ModelSource, definition),
      'invalid_definition',
    );
  });

  it('never echoes the source value in the error message', () => {
    try {
      bindModel({ state: 'shh-secret' } as unknown as ModelSource, definition);
      assert.fail('expected a source error');
    } catch (err) {
      assert.ok(err instanceof ModelError);
      assert.equal(err.message.includes('shh-secret'), false);
    }
  });
});
