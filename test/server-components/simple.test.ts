/**
 * `defineSimpleComponent` tests.
 *
 * Covers: validation (name, fields, render), field → stateSchema derivation,
 * writableKeys defaults and overrides, run → 'submit' action delegation,
 * authorize default, initialState derivation, and pass-through of computed,
 * lifecycle hooks, urlBinding, and staticFallback.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import {
  defineSimpleComponent,
  ServerComponentDefinitionError,
} from '../../src/server-components/simple.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const titleField = z.string().min(1).max(200);
const countField = z.number().int().min(0);
const activeField = z.boolean();

const counterFields = {
  title: titleField,
  count: countField,
  active: activeField,
};

function counterRender(_state: any, _tools: any) {
  return 'counter';
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

describe('defineSimpleComponent name validation', () => {
  it('rejects empty name', () => {
    assert.throws(
      () => defineSimpleComponent('', { fields: counterFields, render: counterRender } as any),
      ServerComponentDefinitionError,
    );
  });

  it('rejects whitespace-only name', () => {
    assert.throws(
      () => defineSimpleComponent('   ', { fields: counterFields, render: counterRender } as any),
      ServerComponentDefinitionError,
    );
  });

  it('rejects non-string name', () => {
    assert.throws(
      () =>
        defineSimpleComponent(
          42 as unknown as string,
          {
            fields: counterFields,
            render: counterRender,
          } as any,
        ),
      ServerComponentDefinitionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

describe('defineSimpleComponent spec validation', () => {
  it('rejects null spec', () => {
    assert.throws(
      () => defineSimpleComponent('counter', null as unknown as any),
      ServerComponentDefinitionError,
    );
  });

  it('rejects non-object spec', () => {
    assert.throws(
      () => defineSimpleComponent('counter', 42 as unknown as any),
      ServerComponentDefinitionError,
    );
  });

  it('rejects missing fields', () => {
    assert.throws(
      () =>
        defineSimpleComponent('counter', {
          render: counterRender,
        } as any),
      ServerComponentDefinitionError,
    );
  });

  it('rejects null fields', () => {
    assert.throws(
      () =>
        defineSimpleComponent('counter', {
          fields: null,
          render: counterRender,
        } as any),
      ServerComponentDefinitionError,
    );
  });

  it('rejects array fields', () => {
    assert.throws(
      () =>
        defineSimpleComponent('counter', {
          fields: [],
          render: counterRender,
        } as any),
      ServerComponentDefinitionError,
    );
  });

  it('rejects empty fields object', () => {
    assert.throws(
      () =>
        defineSimpleComponent('counter', {
          fields: {},
          render: counterRender,
        } as any),
      ServerComponentDefinitionError,
    );
  });

  it('rejects missing render', () => {
    assert.throws(
      () =>
        defineSimpleComponent('counter', {
          fields: counterFields,
        } as any),
      ServerComponentDefinitionError,
    );
  });

  it('rejects non-function render', () => {
    assert.throws(
      () =>
        defineSimpleComponent('counter', {
          fields: counterFields,
          render: 'not a function',
        } as any),
      ServerComponentDefinitionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Field entry validation
// ---------------------------------------------------------------------------

describe('defineSimpleComponent field entry validation', () => {
  it('rejects null field entry', () => {
    assert.throws(
      () =>
        defineSimpleComponent('f', {
          fields: { x: null as any },
          render: counterRender,
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects string field entry', () => {
    assert.throws(
      () =>
        defineSimpleComponent('f', {
          fields: { x: 'not a schema' as any },
          render: counterRender,
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects object entry without schema', () => {
    assert.throws(
      () =>
        defineSimpleComponent('f', {
          fields: { x: { writable: true } as any },
          render: counterRender,
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects object entry with non-Zod schema', () => {
    assert.throws(
      () =>
        defineSimpleComponent('f', {
          fields: { x: { schema: { parse: () => ({}) } } as any },
          render: counterRender,
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects object entry with non-boolean writable', () => {
    assert.throws(
      () =>
        defineSimpleComponent('f', {
          fields: { x: { schema: z.string(), writable: 'yes' as any } },
          render: counterRender,
        }),
      ServerComponentDefinitionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Field → stateSchema derivation
// ---------------------------------------------------------------------------

describe('defineSimpleComponent stateSchema derivation', () => {
  it('derives strict stateSchema from bare field schemas', () => {
    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
    });

    assert.ok(def.stateSchema instanceof z.ZodObject);

    // Should be strict — unknown keys rejected.
    assert.throws(() => def.stateSchema.parse({ title: 'X', count: 1, active: true, extra: 1 }));
    // Valid keys pass.
    const parsed = def.stateSchema.parse({ title: 'Hello', count: 5, active: false });
    assert.equal(parsed.title, 'Hello');
    assert.equal(parsed.count, 5);
    assert.equal(parsed.active, false);
  });

  it('derives stateSchema from mixed bare and object field entries', () => {
    const def = defineSimpleComponent('mixed', {
      fields: {
        name: z.string(),
        level: { schema: z.number(), writable: false },
      },
      render: counterRender,
    });

    const parsed = def.stateSchema.parse({ name: 'A', level: 3 });
    assert.equal(parsed.name, 'A');
    assert.equal(parsed.level, 3);
  });
});

// ---------------------------------------------------------------------------
// writableKeys derivation
// ---------------------------------------------------------------------------

describe('defineSimpleComponent writableKeys', () => {
  it('bare schemas are all writable', () => {
    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
    });

    assert.deepStrictEqual(def.writableKeys, ['title', 'count', 'active']);
  });

  it('{ schema, writable: true } is writable', () => {
    const def = defineSimpleComponent('f', {
      fields: {
        x: { schema: z.string(), writable: true },
      },
      render: counterRender,
    });

    assert.deepStrictEqual(def.writableKeys, ['x']);
  });

  it('{ schema, writable: false } is NOT writable', () => {
    const def = defineSimpleComponent('f', {
      fields: {
        x: { schema: z.string(), writable: false },
      },
      render: counterRender,
    });

    assert.deepStrictEqual(def.writableKeys, []);
  });

  it('{ schema } without explicit writable defaults to NOT writable', () => {
    const def = defineSimpleComponent('f', {
      fields: {
        readOnlyField: { schema: z.string() },
      },
      render: counterRender,
    });

    assert.deepStrictEqual(def.writableKeys, []);
  });

  it('mixed writable and non-writable fields', () => {
    const def = defineSimpleComponent('mixed', {
      fields: {
        name: z.string(),
        role: { schema: z.string(), writable: false },
        score: { schema: z.number(), writable: true },
        note: { schema: z.string() },
      },
      render: counterRender,
    });

    assert.deepStrictEqual(def.writableKeys, ['name', 'score']);
  });
});

// ---------------------------------------------------------------------------
// run → 'submit' action
// ---------------------------------------------------------------------------

describe('defineSimpleComponent run action', () => {
  it('creates actions.submit when run is provided', () => {
    let called = false;
    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
      run(_state: any, _context: any) {
        called = true;
      },
    });

    assert.ok(def.actions);
    assert.ok(def.actions.submit);
    assert.equal(typeof def.actions.submit.run, 'function');

    // Call the action's run — it should delegate to the provided run.
    const state = { title: 'X', count: 0, active: false };
    def.actions.submit.run(state, {}, {} as any);
    assert.equal(called, true);
  });

  it('does NOT create actions when run is absent', () => {
    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
    });

    assert.equal(def.actions, undefined);
  });

  it('action input is an empty object schema', () => {
    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
      run() {},
    });

    const action = (def.actions as Record<string, any>).submit;
    assert.ok(action.input instanceof z.ZodObject);
    action.input.parse({});
  });

  it('run receives state and context (not input)', () => {
    let receivedState: any;
    let receivedContext: any;
    const ctx = { session: 'fake' } as any;

    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
      run(state: any, context: any) {
        receivedState = state;
        receivedContext = context;
      },
    });

    const state = { title: 'X', count: 0, active: false };
    const actions = def.actions;
    assert.ok(actions);
    actions.submit!.run(state, { ignored: true }, ctx);
    assert.equal(receivedState, state);
    assert.equal(receivedContext, ctx);
  });
});

// ---------------------------------------------------------------------------
// authorize default
// ---------------------------------------------------------------------------

describe('defineSimpleComponent authorize', () => {
  it('defaults to () => true when no authorize is provided', async () => {
    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
    });

    assert.equal(typeof def.authorize, 'function');
    assert.equal(await def.authorize({} as any), true);
  });

  it('passes through explicit authorize', async () => {
    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
      authorize(ctx: any) {
        return ctx.session !== null;
      },
    });

    assert.equal(await def.authorize({ session: 'x' } as any), true);
    assert.equal(await def.authorize({ session: null } as any), false);
  });
});

// ---------------------------------------------------------------------------
// initialState derivation
// ---------------------------------------------------------------------------

describe('defineSimpleComponent initialState', () => {
  it('derives defaults from field Zod types', async () => {
    const def = defineSimpleComponent('f', {
      fields: {
        s: z.string(),
        n: z.number(),
        b: z.boolean(),
        a: z.array(z.string()),
        o: z.object({ x: z.string() }),
      },
      render: counterRender,
    });

    assert.equal(typeof def.initialState, 'function');
    const state = await def.initialState({} as any);
    assert.equal(state.s, '');
    assert.equal(state.n, 0);
    assert.equal(state.b, false);
    assert.deepStrictEqual(state.a, []);
    assert.deepStrictEqual(state.o, {});
  });

  it('uses Zod .default() when present', async () => {
    const def = defineSimpleComponent('f', {
      fields: {
        role: z.string().default('guest'),
      },
      render: counterRender,
    });

    const state = await def.initialState({} as any);
    assert.equal(state.role, 'guest');
  });

  it('passes through explicit initialState', async () => {
    const def = defineSimpleComponent('f', {
      fields: { count: z.number() },
      render: counterRender,
      initialState(_ctx: any) {
        return { count: 99 };
      },
    });

    const state = await def.initialState({} as any);
    assert.equal(state.count, 99);
  });
});

// ---------------------------------------------------------------------------
// Pass-through options
// ---------------------------------------------------------------------------

describe('defineSimpleComponent pass-through', () => {
  it('passes through computed', () => {
    const upper = (_state: any, _ctx: any) => 'UPPER';
    const def = defineSimpleComponent('f', {
      fields: { name: z.string() },
      render: counterRender,
      computed: { upper },
    });

    assert.ok(def.computed);
    assert.equal(def.computed.upper, upper);
  });

  it('passes through staticFallback', () => {
    const fallback = () => 'static';
    const def = defineSimpleComponent('f', {
      fields: { name: z.string() },
      render: counterRender,
      staticFallback: fallback,
    });

    assert.equal(def.staticFallback, fallback);
  });

  it('passes through urlBinding', () => {
    const def = defineSimpleComponent('f', {
      fields: { name: z.string(), page: z.number() },
      render: counterRender,
      urlBinding: ['page'],
    });

    assert.deepStrictEqual(def.urlBinding, ['page']);
  });

  it('passes through lifecycle hooks', () => {
    const hydrate = (_state: any, _ctx: any) => {};
    const updating = (_state: any, _ctx: any) => {};
    const updated = (_state: any, _ctx: any) => {};
    const mount = (_ctx: any) => {};

    const def = defineSimpleComponent('f', {
      fields: { name: z.string() },
      render: counterRender,
      hydrate,
      updating,
      updated,
      mount,
    });

    assert.equal(def.hydrate, hydrate);
    assert.equal(def.updating, updating);
    assert.equal(def.updated, updated);
    assert.equal(def.mount, mount);
  });
});

// ---------------------------------------------------------------------------
// Returns same shape as defineServerComponent
// ---------------------------------------------------------------------------

describe('defineSimpleComponent return value', () => {
  it('returns a ServerComponentDefinition with expected shape', () => {
    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
      run() {},
    });

    // All required fields of ServerComponentDefinition are present.
    assert.equal(typeof def.name, 'string');
    assert.ok(def.stateSchema instanceof z.ZodObject);
    assert.ok(Array.isArray(def.writableKeys));
    assert.equal(typeof def.initialState, 'function');
    assert.equal(typeof def.authorize, 'function');
    assert.equal(typeof def.render, 'function');
    assert.ok(def.actions);
    assert.equal(typeof (def.actions as any).submit.run, 'function');
  });

  it('is frozen (via defineServerComponent normalization)', () => {
    const def = defineSimpleComponent('counter', {
      fields: counterFields,
      render: counterRender,
    });

    // writableKeys is frozen.
    assert.throws(() => {
      (def.writableKeys as string[]).push('extra');
    }, TypeError);
  });

  it('name matches', () => {
    const def = defineSimpleComponent('my-counter', {
      fields: counterFields,
      render: counterRender,
    });

    assert.equal(def.name, 'my-counter');
  });
});

// ---------------------------------------------------------------------------
// Unsupported field types get undefined initialState (schema will catch it)
// ---------------------------------------------------------------------------

describe('defineSimpleComponent initialState for unsupported types', () => {
  it('derives undefined for ZodEnum fields', async () => {
    const def = defineSimpleComponent('f', {
      fields: {
        role: z.enum(['admin', 'user']),
      },
      render: counterRender,
    });

    const state = await def.initialState({} as any);
    assert.equal(state.role, undefined);
  });

  it('derives undefined for ZodUnion fields', async () => {
    const def = defineSimpleComponent('f', {
      fields: {
        val: z.union([z.string(), z.number()]),
      },
      render: counterRender,
    });

    const state = await def.initialState({} as any);
    assert.equal(state.val, undefined);
  });
});
