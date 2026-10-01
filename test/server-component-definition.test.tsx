/**
 * Server component definition contract tests.
 *
 * These tests cover the foundation module only
 * (`src/server-components/component.ts`): definition validation, purity (no
 * callback runs at definition time), forced-strict state and input schemas,
 * `writableKeys` validation (unknown/prototype keys rejected, default locked),
 * the `staticFallback` seam, and compile-time type strength. The transport and
 * the real `bind`/`call`/`submit` implementations live in the runtime, not
 * here — so the render helpers are exercised through typed stubs that show how
 * the runtime hands them to `render`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VNode } from 'preact';
import { z } from 'zod';

import { renderToString } from '../src/render/render-to-string.js';
import {
  defineAction,
  defineServerComponent,
  ServerComponentDefinitionError,
  type ServerComponentAction,
  type ServerComponentDefinition,
  type ServerComponentRenderTools,
  type ServerComponentSubmitAttrs,
} from '../src/server-components/component.js';
import type { RequestContext } from '../src/contracts/http.js';

const fakeContext: RequestContext = {
  request: new Request('http://localhost/'),
  url: new URL('http://localhost/'),
  params: {},
  session: null,
};

const counterSchema = z.object({ count: z.number() });
type CounterState = { count: number };

/** Cast an invalid definition past the type checker to exercise runtime validation. */
function defineInvalid(definition: unknown): ServerComponentDefinition<any> {
  return defineServerComponent(definition as ServerComponentDefinition<any>);
}

// ---------------------------------------------------------------------------
// Compile-time type assertions (verified by `npm run typecheck`, never executed
// in a way that triggers validation).
// ---------------------------------------------------------------------------

// State flows from `stateSchema` into `initialState`, `render`, and action
// `run` bodies.
const typedCounter = defineServerComponent<CounterState>({
  name: 'Counter',
  stateSchema: counterSchema,
  initialState() {
    return { count: 0 };
  },
  authorize() {
    return true;
  },
  actions: {
    increment: defineAction({
      input: z.object({ by: z.number() }).strict(),
      run(state, input) {
        const by: number = input.by;
        const count: number = state.count;
        void by;
        void count;
      },
    }),
  },
  render(state, { bind, call, submit }) {
    const count: number = state.count;
    void count;
    const bound = bind('count');
    const called = call('increment', { by: 1 });
    const submitted = submit('save', { count: state.count });
    void bound;
    void called;
    void submitted;
    return null;
  },
});
void typedCounter;

// A blank initial title is valid: the schema is structural, and `''` satisfies
// `z.string()`. The definition does not run `initialState`, only type-check it.
defineServerComponent({
  name: 'BlankTitle',
  stateSchema: z.object({ title: z.string() }),
  initialState() {
    return { title: '' };
  },
  authorize() {
    return true;
  },
  render() {
    return null;
  },
});

// A misspelled input field is a type error.
defineAction({
  input: z.object({ by: z.number() }).strict(),
  run(_state, input) {
    // @ts-expect-error `byy` is not a field of the input schema
    input.byy; // eslint-disable-line @typescript-eslint/no-unused-expressions
  },
});

// A misspelled state field is a type error.
defineServerComponent<CounterState>({
  name: 'TypoState',
  stateSchema: counterSchema,
  initialState() {
    return { count: 0 };
  },
  authorize() {
    return true;
  },
  actions: {
    bump: defineAction({
      run(state) {
        // @ts-expect-error `countt` is not a field of CounterState
        state.countt; // eslint-disable-line @typescript-eslint/no-unused-expressions
      },
    }),
  },
  render() {
    return null;
  },
});

// A misspelled bound field is a type error.
defineServerComponent<CounterState>({
  name: 'TypoBind',
  stateSchema: counterSchema,
  initialState() {
    return { count: 0 };
  },
  authorize() {
    return true;
  },
  render(_state, { bind }) {
    // @ts-expect-error `countt` is not a top-level field of CounterState
    bind('countt');
    return null;
  },
});

// A writable key must be a top-level state field (type-level; never executed,
// since a runtime-invalid writable key would throw during definition).
const typoWritable: ServerComponentDefinition<CounterState> = {
  name: 'TypoWritable',
  stateSchema: counterSchema,
  // @ts-expect-error `countt` is not a top-level field of CounterState
  writableKeys: ['countt'],
  initialState() {
    return { count: 0 };
  },
  authorize() {
    return true;
  },
  render() {
    return null;
  },
};
void typoWritable;

// `authorize` is required.
// @ts-expect-error authorize is missing
const missingAuthorize: ServerComponentDefinition<CounterState> = {
  name: 'NoAuthorize',
  stateSchema: counterSchema,
  initialState() {
    return { count: 0 };
  },
  render() {
    return null;
  },
};
void missingAuthorize;

// `stateSchema` is required.
// @ts-expect-error stateSchema is missing
const missingStateSchema: ServerComponentDefinition<CounterState> = {
  name: 'NoSchema',
  initialState() {
    return { count: 0 };
  },
  authorize() {
    return true;
  },
  render() {
    return null;
  },
};
void missingStateSchema;

// An action must define `run`.
// @ts-expect-error run is missing
const missingRun: ServerComponentAction<CounterState, undefined> = {
  input: z.object({}).strict(),
};
void missingRun;

// `submit` always disables Turbo.
function assertTurboDisabled(): void {
  const submit: ServerComponentSubmitAttrs = {
    'data-jsails-submit': 'save',
    'data-turbo': false,
  };
  // @ts-expect-error data-turbo is a literal `false`, never `true`
  submit['data-turbo'] = true;
}
void assertTurboDisabled;

// ---------------------------------------------------------------------------
// Runtime tests
// ---------------------------------------------------------------------------

describe('defineServerComponent definition validation', () => {
  it('rejects an empty or non-string component name', () => {
    assert.throws(() => defineInvalid({ name: '' }), ServerComponentDefinitionError);
    assert.throws(() => defineInvalid({ name: '   ' }), ServerComponentDefinitionError);
    assert.throws(() => defineInvalid({ name: 42 }), ServerComponentDefinitionError);
  });

  it('rejects a missing or non-ZodObject stateSchema', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'NoSchema',
          initialState() {
            return {};
          },
          authorize() {
            return true;
          },
          render() {
            return null;
          },
        }),
      ServerComponentDefinitionError,
    );
    assert.throws(
      () =>
        defineInvalid({
          name: 'NonObjectSchema',
          stateSchema: z.string(),
          initialState() {
            return {};
          },
          authorize() {
            return true;
          },
          render() {
            return null;
          },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects a missing initialState', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'NoState',
          stateSchema: z.object({}),
          authorize() {
            return true;
          },
          render() {
            return null;
          },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('requires authorize (default-deny has no implicit public)', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'NoAuthorize',
          stateSchema: z.object({}),
          initialState() {
            return {};
          },
          render() {
            return null;
          },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects a missing render', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'NoRender',
          stateSchema: z.object({}),
          initialState() {
            return {};
          },
          authorize() {
            return true;
          },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects a non-function staticFallback', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'BadFallback',
          stateSchema: z.object({}),
          initialState() {
            return {};
          },
          authorize() {
            return true;
          },
          render() {
            return null;
          },
          staticFallback: 'not a function',
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects an action without a run function', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'BadAction',
          stateSchema: z.object({}),
          initialState() {
            return {};
          },
          authorize() {
            return true;
          },
          render() {
            return null;
          },
          actions: { bump: {} },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects an empty action name', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'BadActionName',
          stateSchema: z.object({}),
          initialState() {
            return {};
          },
          authorize() {
            return true;
          },
          render() {
            return null;
          },
          actions: { '': { run() {} } },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects an inherited action name such as constructor', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'ShadowingAction',
          stateSchema: z.object({}),
          initialState() {
            return {};
          },
          authorize() {
            return true;
          },
          render() {
            return null;
          },
          actions: { constructor: { run() {} } },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects a __proto__ action key', () => {
    // A `__proto__` literal key sets the prototype instead of becoming an own
    // key, so it must be rejected rather than silently dropped.
    assert.throws(
      () =>
        defineInvalid({
          name: 'ProtoAction',
          stateSchema: z.object({}),
          initialState() {
            return {};
          },
          authorize() {
            return true;
          },
          render() {
            return null;
          },
          actions: { __proto__: { run() {} } },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects a non-ZodObject input schema', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'BadInput',
          stateSchema: z.object({}),
          initialState() {
            return {};
          },
          authorize() {
            return true;
          },
          render() {
            return null;
          },
          actions: { bump: { input: z.number(), run() {} } },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('accepts a valid definition and keeps action/name metadata', () => {
    const definition = defineServerComponent({
      name: 'Counter',
      stateSchema: counterSchema,
      initialState() {
        return { count: 0 };
      },
      authorize() {
        return true;
      },
      actions: {
        increment: defineAction({
          input: z.object({ by: z.number() }).strict(),
          run() {},
        }),
      },
      render() {
        return null;
      },
    });
    assert.equal(definition.name, 'Counter');
    assert.deepEqual(Object.keys(definition.actions ?? {}), ['increment']);
  });
});

describe('writableKeys', () => {
  it('defaults to a frozen empty list when omitted', () => {
    const definition = defineServerComponent({
      name: 'NoWritable',
      stateSchema: counterSchema,
      initialState() {
        return { count: 0 };
      },
      authorize() {
        return true;
      },
      render() {
        return null;
      },
    });
    assert.deepEqual(definition.writableKeys, []);
    assert.ok(Object.isFrozen(definition.writableKeys));
  });

  it('rejects a writable key that is not a top-level schema field', () => {
    assert.throws(
      () =>
        defineInvalid({
          name: 'UnknownWritable',
          stateSchema: counterSchema,
          writableKeys: ['nope'],
          initialState() {
            return { count: 0 };
          },
          authorize() {
            return true;
          },
          render() {
            return null;
          },
        }),
      ServerComponentDefinitionError,
    );
  });

  it('rejects a writable key that shadows an inherited property', () => {
    for (const key of ['__proto__', 'constructor']) {
      assert.throws(
        () =>
          defineInvalid({
            name: 'ProtoWritable',
            stateSchema: counterSchema,
            writableKeys: [key],
            initialState() {
              return { count: 0 };
            },
            authorize() {
              return true;
            },
            render() {
              return null;
            },
          }),
        ServerComponentDefinitionError,
      );
    }
  });

  it('preserves declared writable keys as a frozen copy', () => {
    const definition = defineServerComponent({
      name: 'Writable',
      stateSchema: counterSchema,
      writableKeys: ['count'],
      initialState() {
        return { count: 0 };
      },
      authorize() {
        return true;
      },
      render() {
        return null;
      },
    });
    assert.deepEqual(definition.writableKeys, ['count']);
    assert.ok(Object.isFrozen(definition.writableKeys));
  });
});

describe('definition is inert', () => {
  it('runs no initialState, authorize, action, render, or staticFallback at definition time', () => {
    let initialStateCalls = 0;
    let authorizeCalls = 0;
    let runCalls = 0;
    let renderCalls = 0;
    let fallbackCalls = 0;

    defineServerComponent({
      name: 'Inert',
      stateSchema: z.object({ n: z.number() }),
      initialState() {
        initialStateCalls += 1;
        return { n: 0 };
      },
      authorize() {
        authorizeCalls += 1;
        return true;
      },
      actions: {
        bump: defineAction({
          run() {
            runCalls += 1;
          },
        }),
      },
      render() {
        renderCalls += 1;
        return null;
      },
      staticFallback() {
        fallbackCalls += 1;
        return null;
      },
    });

    assert.equal(initialStateCalls, 0);
    assert.equal(authorizeCalls, 0);
    assert.equal(runCalls, 0);
    assert.equal(renderCalls, 0);
    assert.equal(fallbackCalls, 0);
  });
});

describe('forced strict state schema', () => {
  it('rejects undeclared state fields even when the author did not call .strict()', () => {
    const definition = defineServerComponent({
      name: 'StrictState',
      stateSchema: z.object({ title: z.string() }),
      initialState() {
        return { title: 'x' };
      },
      authorize() {
        return true;
      },
      render() {
        return null;
      },
    });

    const schema = definition.stateSchema;
    assert.ok(schema instanceof z.ZodObject);
    assert.equal(schema.safeParse({ title: 'x' }).success, true);
    assert.equal(schema.safeParse({ title: 'x', secret: 'leak' }).success, false);
  });
});

describe('forced strict input', () => {
  it('rejects unknown keys even when the author did not call .strict()', () => {
    const definition = defineServerComponent({
      name: 'Strict',
      stateSchema: z.object({}),
      initialState() {
        return {};
      },
      authorize() {
        return true;
      },
      actions: {
        submit: defineAction({
          input: z.object({ a: z.number() }),
          run() {},
        }),
      },
      render() {
        return null;
      },
    });

    const input = definition.actions?.submit?.input;
    assert.ok(input instanceof z.ZodObject);

    assert.equal(input.safeParse({ a: 1 }).success, true);
    assert.equal(input.safeParse({ a: 1, extra: 2 }).success, false);
  });
});

describe('staticFallback', () => {
  it('is optional and absent when not declared', () => {
    const definition = defineServerComponent({
      name: 'NoFallback',
      stateSchema: z.object({}),
      initialState() {
        return {};
      },
      authorize() {
        return true;
      },
      render() {
        return null;
      },
    });
    assert.equal(definition.staticFallback, undefined);
  });

  it('is preserved and may be async', async () => {
    const definition = defineServerComponent({
      name: 'WithFallback',
      stateSchema: z.object({}),
      initialState() {
        return {};
      },
      authorize() {
        return true;
      },
      render() {
        return null;
      },
      async staticFallback() {
        return <div>static shell</div>;
      },
    });

    assert.equal(typeof definition.staticFallback, 'function');
    const result = await definition.staticFallback!(fakeContext);
    assert.match(renderToString(result as VNode), /static shell/);
  });
});

describe('render helpers', () => {
  it('hands render typed bind/call/submit helpers plus errors, values, and context', async () => {
    const tools: ServerComponentRenderTools<CounterState> = {
      bind(name) {
        return { 'data-jsails-model': name };
      },
      call(action, args) {
        return {
          'data-jsails-call': action,
          ...(args === undefined ? {} : { 'data-jsails-args': JSON.stringify(args) }),
        };
      },
      submit(action, args) {
        return {
          'data-jsails-submit': action,
          'data-turbo': false,
          ...(args === undefined ? {} : { 'data-jsails-args': JSON.stringify(args) }),
        };
      },
      errors: { count: 'too big' },
      values: { count: '4' },
      context: fakeContext,
    };

    const definition = defineServerComponent<CounterState>({
      name: 'Counter',
      stateSchema: counterSchema,
      initialState() {
        return { count: 3 };
      },
      authorize() {
        return true;
      },
      render(state, { bind, call, submit, errors, values }) {
        return (
          <div>
            <input {...bind('count')} />
            <button {...call('increment', { by: 1 })}>+</button>
            <form {...submit('save', { count: state.count })} />
            <span>{errors.count}</span>
            <span>{values.count}</span>
          </div>
        );
      },
    });

    const html = renderToString((await definition.render({ count: 3 }, tools)) as VNode);
    assert.match(html, /data-jsails-model="count"/);
    assert.match(html, /data-jsails-call="increment"/);
    assert.match(html, /data-jsails-submit="save"/);
    assert.match(html, /data-turbo="false"/);
    assert.match(html, /too big/);
    assert.match(html, />4<\/span>/);
  });
});
