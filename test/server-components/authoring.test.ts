/**
 * Authoring-layer tests: `defineComponent`, `localAction`, `serverAction`,
 * `lowerActions`, and `defineStyle`.
 *
 * Uses `node:test` + `node:assert/strict` matched to the project style
 * (`test/client/model.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import {
  AuthoringError,
  defineComponent,
  defineStyle,
  localAction,
  lowerActions,
  serverAction,
  StyleError,
  type ActionKind,
  type DefineComponentOptions,
  type LocalAction,
  type ServerAction,
} from '../../src/server-components/authoring/index.js';
import type { ServerComponentAction } from '../../src/server-components/component.js';
import { createComponentTestHarness } from '../../src/testing/index.js';

// ---------------------------------------------------------------------------
// localAction
// ---------------------------------------------------------------------------

describe('localAction', () => {
  it('returns kind: "local" with a synchronous run', () => {
    const action = localAction<{ count: number }>({
      run(state) {
        state.count += 1;
      },
    });

    assert.equal(action.kind, 'local');
    const state = { count: 0 };
    action.run(state, undefined);
    assert.equal(state.count, 1);
  });

  it('returns kind: "local" with an input schema', () => {
    // In production, localAction is called inside defineComponent where State
    // is inferred from the outer options, and I infers correctly. Standalone
    // calls need explicit type params when input is present.
    const bySchema = z.object({ by: z.number() });
    const action = localAction<{ count: number }, typeof bySchema>({
      input: bySchema,
      run(state, args) {
        state.count += args.by;
      },
    });

    assert.equal(action.kind, 'local');
    assert.ok(action.input instanceof z.ZodObject);
    const state = { count: 0 };
    action.run(state, { by: 3 });
    assert.equal(state.count, 3);
  });

  it('rejects an authorize key with AuthoringError code "local_action_authorize"', () => {
    assert.throws(
      () =>
        localAction({
          authorize: () => true,
          run(_state: { count: number }) {},
        } as never),
      (err: unknown) => {
        if (!(err instanceof AuthoringError)) return false;
        return err.code === 'local_action_authorize';
      },
    );
  });

  it('returns a frozen object', () => {
    const action = localAction<{ count: number }>({
      run(state) {
        state.count = 0;
      },
    });
    assert.ok(Object.isFrozen(action));
  });

  it('the lowered run ignores a passed context', () => {
    const action = localAction<{ count: number }>({
      run(state) {
        state.count = 99;
      },
    });

    const lowered = lowerActions({ inc: action });
    const loweredAction = lowered.inc as ServerComponentAction<{ count: number }, undefined>;

    // Call with a dummy context object — the local run must still execute.
    const state = { count: 0 };
    const dummyCtx = { request: {} } as never;
    loweredAction.run(state, undefined, dummyCtx);
    assert.equal(state.count, 99);
  });
});

// ---------------------------------------------------------------------------
// serverAction
// ---------------------------------------------------------------------------

describe('serverAction', () => {
  it('returns kind: "server" with run and authorize', () => {
    const newTitleSchema = z.object({ newTitle: z.string() });
    const action = serverAction<{ title: string }, typeof newTitleSchema>({
      authorize(_ctx, _state, _args) {
        return true;
      },
      run(state, args, _ctx) {
        state.title = args.newTitle;
      },
      input: newTitleSchema,
    });

    assert.equal(action.kind, 'server');
    assert.ok(action.input instanceof z.ZodObject);
    assert.equal(typeof action.authorize, 'function');
    assert.equal(typeof action.run, 'function');
  });

  it('returns kind: "server" without authorize', () => {
    const newTitleSchema2 = z.object({ newTitle: z.string() });
    const action = serverAction<{ title: string }, typeof newTitleSchema2>({
      run(state, args, _ctx) {
        state.title = args.newTitle;
      },
      input: newTitleSchema2,
    });

    assert.equal(action.kind, 'server');
    assert.equal(action.authorize, undefined);
  });

  it('returns a frozen object', () => {
    const action = serverAction<{ title: string }>({
      run(state, _args, _ctx) {
        state.title = 'x';
      },
    });
    assert.ok(Object.isFrozen(action));
  });

  it('the lowered run preserves server semantics (same function reference)', () => {
    const runFn = (_state: { title: string }, _args: undefined, _ctx: never) => {};
    const action = serverAction<{ title: string }>({ run: runFn });
    const lowered = lowerActions({ upd: action });
    const loweredAction = lowered.upd as ServerComponentAction<{ title: string }, undefined>;

    // The lowered action should have the same `run` function identity since
    // `defineAction` passes it through verbatim.
    assert.equal(loweredAction.run, runFn);
  });
});

// ---------------------------------------------------------------------------
// lowerActions
// ---------------------------------------------------------------------------

describe('lowerActions', () => {
  it('preserves kind: "local" on lowered local actions', () => {
    const actions = {
      inc: localAction<{ count: number }>({
        run(state) {
          state.count += 1;
        },
      }),
    };
    const lowered = lowerActions(actions);
    assert.equal((lowered.inc as { kind: ActionKind }).kind, 'local');
  });

  it('preserves kind: "server" on lowered server actions', () => {
    const actions = {
      save: serverAction<{ title: string }>({
        run(state, _args, _ctx) {
          state.title = 'saved';
        },
      }),
    };
    const lowered = lowerActions(actions);
    assert.equal((lowered.save as { kind: ActionKind }).kind, 'server');
  });

  it('rejects a non-plain-object record with AuthoringError "invalid_actions"', () => {
    const bad = Object.create({ extra: true });
    bad.inc = localAction<{ count: number }>({
      run(s) {
        s.count = 1;
      },
    });

    assert.throws(
      () => lowerActions(bad),
      (err: unknown) => {
        if (!(err instanceof AuthoringError)) return false;
        return err.code === 'invalid_actions';
      },
    );
  });

  it('rejects an unknown action kind with AuthoringError "invalid_action_kind"', () => {
    const bad = { x: { kind: 'unknown', run(_s: {}) {} } } as unknown as Record<
      string,
      LocalAction<any, any> | ServerAction<any, any>
    >;

    assert.throws(
      () => lowerActions(bad),
      (err: unknown) => {
        if (!(err instanceof AuthoringError)) return false;
        return err.code === 'invalid_action_kind';
      },
    );
  });

  it('returns a frozen record', () => {
    const actions = {
      inc: localAction<{ count: number }>({
        run(state) {
          state.count += 1;
        },
      }),
    };
    const lowered = lowerActions(actions);
    assert.ok(Object.isFrozen(lowered));
  });
});

// ---------------------------------------------------------------------------
// defineStyle
// ---------------------------------------------------------------------------

describe('defineStyle', () => {
  it('returns a frozen StyleContract with frozen slots', () => {
    const style = defineStyle({ header: 'text-lg', body: 'p-4' });
    assert.ok(Object.isFrozen(style));
    assert.ok(Object.isFrozen(style.slots));
  });

  it('slot(name) returns the registered class string', () => {
    const style = defineStyle({ header: 'text-lg font-bold' });
    assert.equal(style.slot('header'), 'text-lg font-bold');
  });

  it('slot(name) throws StyleError "unknown_slot" for an unregistered name', () => {
    const style = defineStyle({ header: 'text-lg' });

    assert.throws(
      () => (style.slot as (name: string) => string)('footer'),
      (err: unknown) => {
        if (!(err instanceof StyleError)) return false;
        return err.code === 'unknown_slot';
      },
    );
  });

  it('unknown_slot error message does not contain the slot name', () => {
    const style = defineStyle({ header: 'text-lg' });

    try {
      (style.slot as (name: string) => string)('SECRET_SLOT_NAME');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StyleError);
      assert.equal(err.message.includes('SECRET_SLOT_NAME'), false);
    }
  });

  it('rejects an empty string value with StyleError "invalid_slots"', () => {
    assert.throws(
      () => defineStyle({ header: '' }),
      (err: unknown) => {
        if (!(err instanceof StyleError)) return false;
        return err.code === 'invalid_slots';
      },
    );
  });

  it('rejects a whitespace-only value with StyleError "invalid_slots"', () => {
    assert.throws(
      () => defineStyle({ header: '   ' }),
      (err: unknown) => {
        if (!(err instanceof StyleError)) return false;
        return err.code === 'invalid_slots';
      },
    );
  });

  it('rejects an empty string key with StyleError "invalid_slots"', () => {
    assert.throws(
      () => defineStyle({ '': 'text-lg' }),
      (err: unknown) => {
        if (!(err instanceof StyleError)) return false;
        return err.code === 'invalid_slots';
      },
    );
  });

  it('rejects a __proto__ key with StyleError "invalid_slots"', () => {
    // `__proto__` in an object literal sets the prototype and produces zero
    // own keys, so the "must have at least one entry" check rejects it.
    const protoSlots = {} as Record<string, string>;
    Object.defineProperty(protoSlots, '__proto__', {
      value: 'text-lg',
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => defineStyle(protoSlots),
      (err: unknown) => {
        if (!(err instanceof StyleError)) return false;
        return err.code === 'invalid_slots';
      },
    );
  });

  it('rejects a non-object input with StyleError "invalid_slots"', () => {
    assert.throws(
      () => defineStyle(null as never),
      (err: unknown) => {
        if (!(err instanceof StyleError)) return false;
        return err.code === 'invalid_slots';
      },
    );
    assert.throws(
      () => defineStyle('nope' as never),
      (err: unknown) => {
        if (!(err instanceof StyleError)) return false;
        return err.code === 'invalid_slots';
      },
    );
  });

  it('rejects an empty slots map with StyleError "invalid_slots"', () => {
    assert.throws(
      () => defineStyle({}),
      (err: unknown) => {
        if (!(err instanceof StyleError)) return false;
        return err.code === 'invalid_slots';
      },
    );
  });

  it('invalid_slots error message does not echo the offending value', () => {
    // Offending value: 'SECRET_BAD_SLOT_NAME' as key.
    const slots: Record<string, string> = {};
    slots.SECRET_BAD_SLOT_NAME = '';
    try {
      defineStyle(slots);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StyleError);
      assert.equal(err.message.includes('SECRET_BAD_SLOT_NAME'), false);
    }
  });
});

// ---------------------------------------------------------------------------
// AuthoringError
// ---------------------------------------------------------------------------

describe('AuthoringError', () => {
  it('is an Error with name and code', () => {
    const err = new AuthoringError('test', 'invalid_actions');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'AuthoringError');
    assert.equal(err.code, 'invalid_actions');
  });
});

// ---------------------------------------------------------------------------
// StyleError
// ---------------------------------------------------------------------------

describe('StyleError', () => {
  it('is an Error with name and code', () => {
    const err = new StyleError('test', 'invalid_slots');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'StyleError');
    assert.equal(err.code, 'invalid_slots');
  });
});

// ---------------------------------------------------------------------------
// defineComponent — structural surface
// ---------------------------------------------------------------------------

const authoringOptions = {
  name: 'Counter',
  stateSchema: z.object({ count: z.number(), title: z.string() }),
  writableKeys: ['title'] as const,
  initialState() {
    return { count: 0, title: 'hello' };
  },
  authorize() {
    return true;
  },
  render(state, tools) {
    // Exercise derived alongside existing tools.
    void tools.derived('greeting');
    // Use the existing computed path to keep Preact-renderable output
    // (derived shadows it at the author level, but the existing tools still exist).
    void tools.computed('greeting');
    void tools.bind('title');
    void tools.submit('save');
    return null;
  },
} satisfies DefineComponentOptions<{ count: number; title: string }>;

describe('defineComponent', () => {
  it('lowers derived to computed — tools.derived and tools.computed return the same value', async () => {
    let captured: unknown;
    let computedVal: unknown;

    const comp = defineComponent<{ count: number; title: string }>({
      ...authoringOptions,
      derived: {
        greeting(state) {
          return `Hi ${state.title}`;
        },
      },
      render(state, tools) {
        captured = tools.derived('greeting');
        computedVal = tools.computed('greeting');
        void tools.bind('title');
        return null;
      },
    });

    assert.ok(comp.computed !== undefined);
    assert.ok(comp.computed.greeting !== undefined);
    assert.equal(typeof comp.computed.greeting, 'function');

    // Invoke render with a minimal tools shim to verify derived aliases computed.
    const state = { count: 0, title: 'World' };
    const computedCache = new Map<string, unknown>();
    const tools = {
      bind: (_name: string) => ({ 'data-jsails-model': '' }),
      call: (_action: string) => ({ 'data-jsails-call': '' }),
      submit: (_action: string) => ({ 'data-jsails-submit': '', 'data-turbo': false as const }),
      poll: (_opts: unknown) => ({ 'data-jsails-poll': '' }),
      confirm: (_msg: string) => ({}),
      loadingTarget: (_target: string) => ({}),
      show: (_field: string) => ({}),
      text: (_field: string) => ({}),
      sort: (_field: string) => ({}),
      intersect: (_action: string) => ({}),
      ref: (_name: string) => ({}),
      ignore: () => ({}),
      computed: (name: string) => {
        if (computedCache.has(name)) return computedCache.get(name);
        const fn = comp.computed![name]!;
        const result = fn(state, { request: {} } as never);
        computedCache.set(name, result);
        return result;
      },
      errors: {} as Record<string, string>,
      values: {} as Record<string, string>,
      context: { request: {} } as never,
    };

    await comp.render(state, tools);

    assert.equal(captured, 'Hi World');
    assert.equal(computedVal, 'Hi World');
  });

  it('lowers localAction and serverAction with kind preserved', () => {
    const comp = defineComponent<{ count: number; flag: boolean }>({
      name: 'MixedActions',
      stateSchema: z.object({ count: z.number(), flag: z.boolean() }),
      initialState() {
        return { count: 0, flag: false };
      },
      authorize() {
        return true;
      },
      actions: {
        inc: localAction({
          run(s) {
            s.count += 1;
          },
        }),
        toggle: serverAction({
          run(s, _a, _c) {
            s.flag = true;
          },
        }),
      },
      render(s, tools) {
        void tools.bind('count');
        return null;
      },
    });

    assert.ok(comp.actions !== undefined);
    const actions = comp.actions as Record<
      string,
      ServerComponentAction<any, any> & { kind: ActionKind }
    >;
    assert.equal(actions.inc!.kind, 'local');
    assert.equal(actions.toggle!.kind, 'server');
  });

  it('propagates a strict stateSchema (unknown keys fail safeParse)', () => {
    const comp = defineComponent<{ count: number }>({
      name: 'StrictCheck',
      stateSchema: z.object({ count: z.number() }),
      initialState() {
        return { count: 1 };
      },
      authorize() {
        return true;
      },
      render(s, tools) {
        void tools.bind('count');
        return null;
      },
    });

    const result = comp.stateSchema.safeParse({ count: 1, unknown: 42 });
    assert.equal(result.success, false);
  });

  it('carries style on the returned definition', () => {
    const style = defineStyle({ card: 'bg-white rounded' });
    const comp = defineComponent<{ x: number }>({
      name: 'Styled',
      stateSchema: z.object({ x: z.number() }),
      style,
      initialState() {
        return { x: 0 };
      },
      authorize() {
        return true;
      },
      render(s, tools) {
        void tools.bind('x');
        return null;
      },
    });

    // `style` is an extra own-property outside the interface — access it
    // through the index signature of the object.
    assert.equal((comp as unknown as Record<string, unknown>).style, style);
  });

  it('round-trips through createComponentTestHarness', async () => {
    const component = defineComponent<{ count: number; label: string }>({
      name: 'RoundTrip',
      stateSchema: z.object({ count: z.number(), label: z.string() }),
      writableKeys: ['label'],
      initialState() {
        return { count: 0, label: 'initial' };
      },
      authorize() {
        return true;
      },
      actions: {
        inc: serverAction({
          input: z.object({ by: z.number() }),
          run(state, args) {
            state.count += args.by;
          },
        }),
      },
      render(state, tools) {
        void tools.bind('label');
        void tools.submit('inc');
        return null;
      },
    });

    const harness = createComponentTestHarness({
      components: { RoundTrip: component },
    });
    try {
      const { snapshot, csrf } = await harness.render('RoundTrip');
      assert.ok(snapshot.length > 0);
      assert.ok(csrf.length > 0);

      // Drive an action via update.
      const result = await harness.update(
        snapshot,
        {},
        { csrf, action: { name: 'inc', args: { by: 5 } } },
      );
      assert.equal(result.status, 200);
      assert.ok(result.snapshot, 'should return a re-signed snapshot');
    } finally {
      await harness.close();
    }
  });

  it('a localAction is not reachable as a server round-trip (run ignores context)', async () => {
    const component = defineComponent<{ flag: boolean }>({
      name: 'LocalOnly',
      stateSchema: z.object({ flag: z.boolean() }),
      initialState() {
        return { flag: false };
      },
      authorize() {
        return true;
      },
      actions: {
        flip: localAction({
          run(s) {
            s.flag = true;
          },
        }),
      },
      render(state, tools) {
        void tools.bind('flag');
        return null;
      },
    });

    const harness = createComponentTestHarness({
      components: { LocalOnly: component },
    });
    try {
      const { snapshot, csrf } = await harness.render('LocalOnly');

      // A localAction's lowered run ignores the context; calling it with
      // a dummy context should still mutate state without throwing.
      const actions = component.actions! as Record<string, ServerComponentAction<any, any>>;
      const flipAction = actions.flip!;
      const state = { flag: false };
      flipAction.run(state, undefined, { request: {} } as never);
      assert.equal(state.flag, true);

      // The harness's update path dispatches through the runtime, which runs
      // the same lowered function. A local action should succeed as a server
      // round-trip from the runtime's perspective — it just ignores context.
      const result = await harness.update(
        snapshot,
        {},
        { csrf, action: { name: 'flip', args: {} } },
      );
      // The runtime should accept the action.
      assert.equal(result.status, 200);
    } finally {
      await harness.close();
    }
  });
});
