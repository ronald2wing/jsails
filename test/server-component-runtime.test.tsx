/**
 * Server component runtime tests.
 *
 * These tests cover `src/server-components/runtime.ts` end to end: the mount
 * render (markers, snapshot, CSRF, id, bound values), the update pipeline
 * (writable edits, actions, re-signing, re-render), and every security seam —
 * tampered snapshots, subject/origin/CSRF mismatches, default-deny
 * authorization, action authorization, locked client keys, unknown actions,
 * strict validation with value-free field errors, server-side mutation of
 * non-writable fields, static fallback (no signing, no callbacks), and
 * `close()`.
 *
 * No HTTP server, database, Valkey, or browser is involved: `render` and
 * `update` are called directly against a `RequestContext` and a real in-memory
 * signer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import type { RequestContext, Session } from '../src/contracts/http.js';
import {
  defineAction,
  defineServerComponent,
  type ServerComponentDefinition,
} from '../src/server-components/component.js';
import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_NAME_ATTRIBUTE,
  COMPONENT_ROOT_ID_PREFIX,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
} from '../src/server-components/protocol.js';
import {
  createServerComponentsRuntime,
  ServerComponentRuntimeError,
  type ServerComponentsRuntime,
} from '../src/server-components/runtime.js';
import { createComponentSigner } from '../src/server-components/snapshot.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';

// ---------------------------------------------------------------------------
// Fixture components
// ---------------------------------------------------------------------------

type CounterState = { count: number; title: string };

const counter = defineServerComponent<CounterState>({
  name: 'Counter',
  stateSchema: z.object({ count: z.number(), title: z.string() }).strict(),
  writableKeys: ['title'],
  initialState() {
    return { count: 0, title: 'hello' };
  },
  authorize() {
    return true;
  },
  actions: {
    increment: defineAction({
      input: z.object({ by: z.number() }).strict(),
      run(state, input) {
        state.count += input.by;
      },
    }),
    // No client-writable key, yet it mutates `count` server-side.
    reset: defineAction({
      run(state) {
        state.count = 0;
      },
    }),
  },
  render(state, { bind, call, submit, values }) {
    return (
      <div>
        <input {...bind('title')} value={values.title ?? state.title} />
        <button {...call('increment', { by: 1 })}>+</button>
        <form {...submit('increment', { by: 1 })} />
        <span id="count">{state.count}</span>
        <span id="title">{state.title}</span>
      </div>
    );
  },
});

const toggler = defineServerComponent<{ active: boolean }>({
  name: 'Toggler',
  stateSchema: z.object({ active: z.boolean() }).strict(),
  initialState() {
    return { active: true };
  },
  authorize() {
    return true;
  },
  render(_state, { bind }) {
    return <input {...bind('active')} />;
  },
});

const denied = defineServerComponent({
  name: 'Denied',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return false;
  },
  render() {
    return null;
  },
});

const guarded = defineServerComponent<{ n: number }>({
  name: 'Guarded',
  stateSchema: z.object({ n: z.number() }).strict(),
  writableKeys: ['n'],
  initialState() {
    return { n: 0 };
  },
  authorize() {
    return true;
  },
  actions: {
    secret: defineAction({
      authorize() {
        return false;
      },
      run(state) {
        state.n += 1;
      },
    }),
  },
  render(state) {
    return <span>{state.n}</span>;
  },
});

/** Domain schema an action enforces at run time (blank state is still mountable). */
const addForm = z.object({ title: z.string().min(1) });

/**
 * A component whose `add` action requires a non-empty title only when adding:
 * the blank initial state is valid, so the failure surfaces inside `run`.
 */
const addable = defineServerComponent<{
  count: number;
  title: string;
  note: string;
  meta: any;
}>({
  name: 'Addable',
  stateSchema: z
    .object({
      count: z.number(),
      title: z.string(),
      note: z.string(),
      meta: z.any(),
    })
    .strict(),
  writableKeys: ['title', 'note'],
  initialState() {
    return { count: 0, title: '', note: '', meta: { hits: 0 } };
  },
  authorize() {
    return true;
  },
  actions: {
    add: defineAction({
      run(state) {
        addForm.parse({ title: state.title });
        state.count += 1;
      },
    }),
    // Mutates a nested (z.any) field, then fails domain validation.
    poison: defineAction({
      run(state) {
        state.meta.hits = 99;
        addForm.parse({ title: state.title });
      },
    }),
    boom: defineAction({
      run() {
        throw new Error('super-secret-token');
      },
    }),
  },
  render(state, { bind, values }) {
    return (
      <div>
        <input {...bind('title')} value={values.title ?? state.title} />
        <input {...bind('note')} value={values.note ?? state.note} />
        <span id="count">{state.count}</span>
        <span id="hits">{state.meta.hits}</span>
      </div>
    );
  },
});

/** A component whose initialState violates its own schema. */
const badState = defineServerComponent({
  name: 'BadState',
  stateSchema: z.object({ count: z.number() }).strict(),
  initialState() {
    return { count: 'nope' } as unknown as { count: number };
  },
  authorize() {
    return true;
  },
  render() {
    return null;
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(
  components: Readonly<Record<string, ServerComponentDefinition<any>>>,
): ServerComponentsRuntime {
  return createServerComponentsRuntime({
    components,
    signer: createComponentSigner({ key: KEY, now: () => 0 }),
  });
}

function makeRequest(url: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(url, { method, headers });
}

function renderContext(session: Session | null = null): RequestContext {
  const url = new URL(`${ORIGIN}/counter`);
  return {
    request: makeRequest(url.toString()),
    url,
    params: {},
    session,
  };
}

function updateContext(
  csrf: string,
  session: Session | null = null,
  origin = ORIGIN,
): RequestContext {
  const url = new URL(`${ORIGIN}/counter`);
  return {
    request: makeRequest(url.toString(), { origin, [COMPONENT_CSRF_HEADER]: csrf }, 'POST'),
    url,
    params: {},
    session,
  };
}

function extractAttr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected attribute ${name} in HTML: ${html}`);
  return match[1]!;
}

/** Render a mount and pull the snapshot token and CSRF token back out of the HTML. */
async function mount(
  runtime: ServerComponentsRuntime,
  name: string,
  session: Session | null = null,
): Promise<{ html: string; snapshot: string; csrf: string }> {
  const html = await runtime.render(name, renderContext(session));
  return {
    html,
    snapshot: extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
    csrf: extractAttr(html, COMPONENT_CSRF_ATTRIBUTE),
  };
}

function updatePayload(
  snapshot: string,
  updates: Record<string, unknown>,
  sequence = 1,
  action?: { name: string; args?: Record<string, unknown> },
): Record<string, unknown> {
  const payload: Record<string, unknown> = { snapshot, updates, sequence };
  if (action !== undefined) {
    payload.action = action;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Mount (render)
// ---------------------------------------------------------------------------

describe('render (mount)', () => {
  it('renders the root with name markers, id, snapshot, and csrf attributes', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { html, snapshot, csrf } = await mount(runtime, 'Counter');

    assert.match(html, new RegExp(`${COMPONENT_ATTRIBUTE}="Counter"`));
    assert.match(html, new RegExp(`${COMPONENT_NAME_ATTRIBUTE}="Counter"`));
    assert.match(html, new RegExp(`id="${COMPONENT_ROOT_ID_PREFIX}[^"]+"`));
    assert.ok(snapshot.length > 0);
    assert.ok(csrf.length > 0);
    // The anonymous CSRF token is the signed snapshot id (a possession token).
    assert.equal(csrf, extractAttr(html, 'id').slice(COMPONENT_ROOT_ID_PREFIX.length));
  });

  it('signs a verifiable snapshot bound to state, page, origin, and anonymous subject', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const runtime = createServerComponentsRuntime({ components: { Counter: counter }, signer });
    const { html, snapshot } = await mount(runtime, 'Counter');

    const verified = signer.verify(snapshot, { origin: ORIGIN, subject: null });
    assert.equal(verified.component, 'Counter');
    assert.deepEqual(verified.state, { count: 0, title: 'hello' });
    assert.deepEqual(verified.page, { path: '/counter', params: {} });
    assert.equal(verified.origin, ORIGIN);
    assert.equal(verified.subject, null);

    // The bound input renders its current value plus the model marker.
    assert.match(html, /data-jsails-model="title"/);
    assert.match(html, /value="hello"/);
    assert.match(html, />0<\/span>/);
  });

  it('renders a boolean binding as a bare checked attribute', async () => {
    const runtime = makeRuntime({ Toggler: toggler });
    const html = await runtime.render('Toggler', renderContext());
    assert.match(html, /data-jsails-model="active"/);
    assert.match(html, /\schecked/);
  });

  it('throws a clear, value-free error for an unknown component', async () => {
    const runtime = makeRuntime({ Counter: counter });
    await assert.rejects(
      () => runtime.render('Missing', renderContext()),
      ServerComponentRuntimeError,
    );
  });

  it('denies a component whose authorize does not resolve to exactly true', async () => {
    const runtime = makeRuntime({ Denied: denied });
    await assert.rejects(
      () => runtime.render('Denied', renderContext()),
      ServerComponentRuntimeError,
    );
  });

  it('rejects an initial state that fails the state schema', async () => {
    const runtime = makeRuntime({ BadState: badState });
    await assert.rejects(
      () => runtime.render('BadState', renderContext()),
      ServerComponentRuntimeError,
    );
  });

  it('does not sign, allocate state, or run authorize/initialState in static mode', async () => {
    let authorizeCalls = 0;
    let initialStateCalls = 0;
    const traced = defineServerComponent({
      name: 'Traced',
      stateSchema: z.object({}).strict(),
      initialState() {
        initialStateCalls += 1;
        return {};
      },
      authorize() {
        authorizeCalls += 1;
        return true;
      },
      render() {
        return <span>live</span>;
      },
      staticFallback() {
        return <div class="static">fallback</div>;
      },
    });
    const runtime = makeRuntime({ Traced: traced });

    const html = await runtime.render('Traced', renderContext(), { staticMode: true });

    assert.equal(authorizeCalls, 0);
    assert.equal(initialStateCalls, 0);
    assert.match(html, /class="static">fallback/);
    assert.match(html, new RegExp(`${COMPONENT_ATTRIBUTE}="Traced"`));
    // No signed state in static mode: no snapshot, csrf, or root id markers.
    assert.equal(html.includes(COMPONENT_SNAPSHOT_ATTRIBUTE), false);
    assert.equal(html.includes(COMPONENT_CSRF_ATTRIBUTE), false);
    assert.equal(html.includes('id="'), false);
  });

  it('throws in static mode when no staticFallback is declared', async () => {
    const runtime = makeRuntime({ Counter: counter });
    await assert.rejects(
      () => runtime.render('Counter', renderContext(), { staticMode: true }),
      ServerComponentRuntimeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('update', () => {
  it('applies a writable client edit, re-signs, and returns synchronized html', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const runtime = createServerComponentsRuntime({ components: { Counter: counter }, signer });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    const result = await runtime.update(
      updatePayload(snapshot, { title: 'changed' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.sequence, 1);
    assert.equal(result.body.error, undefined);
    assert.ok(result.body.snapshot);
    assert.match(result.body.html ?? '', /value="changed"/);

    // The re-signed snapshot reuses the same instance id and carries the edit.
    const verified = signer.verify(result.body.snapshot, { origin: ORIGIN, subject: null });
    assert.deepEqual(verified.state, { count: 0, title: 'changed' });
    assert.equal(verified.id, verified.id);
  });

  it('runs one action and re-signs the mutated state', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const runtime = createServerComponentsRuntime({ components: { Counter: counter }, signer });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    const result = await runtime.update(
      updatePayload(snapshot, {}, 2, { name: 'increment', args: { by: 5 } }),
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    const verified = signer.verify(result.body.snapshot!, { origin: ORIGIN, subject: null });
    assert.deepEqual(verified.state, { count: 5, title: 'hello' });
    assert.match(result.body.html ?? '', />5<\/span>/);
  });

  it('lets an action mutate a non-writable field server-side', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const runtime = createServerComponentsRuntime({ components: { Counter: counter }, signer });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    // Count starts at 0; bump it, then reset via the server-side action.
    await runtime.update(
      updatePayload(snapshot, {}, 1, { name: 'increment', args: { by: 9 } }),
      updateContext(csrf),
    );
    const result = await runtime.update(
      updatePayload(snapshot, {}, 2, { name: 'reset' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    const verified = signer.verify(result.body.snapshot!, { origin: ORIGIN, subject: null });
    assert.deepEqual(verified.state, { count: 0, title: 'hello' });
  });

  it('rejects a tampered snapshot', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot, csrf } = await mount(runtime, 'Counter');
    const tampered = `${snapshot.slice(0, -2)}AA`;

    const result = await runtime.update(updatePayload(tampered, {}), updateContext(csrf));

    assert.equal(result.status, 403);
    assert.equal(result.body.error?.code, 'invalid_snapshot');
  });

  it('rejects a snapshot whose subject does not match the request session', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot } = await mount(runtime, 'Counter', null);
    const session: Session = { id: 'someone', csrfToken: 'csrf', data: {}, expiresAt: 1 };

    const result = await runtime.update(
      updatePayload(snapshot, {}),
      updateContext(session.csrfToken, session),
    );

    assert.equal(result.status, 403);
    assert.equal(result.body.error?.code, 'invalid_snapshot');
  });

  it('rejects a cross-origin update', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    const result = await runtime.update(
      updatePayload(snapshot, {}),
      updateContext(csrf, null, 'https://evil.example'),
    );

    assert.equal(result.status, 403);
    assert.equal(result.body.error?.code, 'origin_mismatch');
  });

  it('rejects a missing or mismatched CSRF token', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot } = await mount(runtime, 'Counter');

    const result = await runtime.update(updatePayload(snapshot, {}), updateContext('wrong-token'));

    assert.equal(result.status, 403);
    assert.equal(result.body.error?.code, 'csrf_mismatch');
  });

  it('denies an update when component authorize does not resolve to true', async () => {
    const runtime = makeRuntime({ Denied: denied });
    await assert.rejects(
      () => runtime.render('Denied', renderContext()),
      ServerComponentRuntimeError,
    );
  });

  it('denies an action whose authorize does not resolve to true', async () => {
    const runtime = makeRuntime({ Guarded: guarded });
    const { snapshot, csrf } = await mount(runtime, 'Guarded');

    const result = await runtime.update(
      updatePayload(snapshot, {}, 1, { name: 'secret' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 403);
    assert.equal(result.body.error?.code, 'forbidden');
  });

  it('rejects a client edit to a non-writable key with a field error', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    const result = await runtime.update(
      updatePayload(snapshot, { count: 999 }),
      updateContext(csrf),
    );

    assert.equal(result.status, 422);
    assert.deepEqual(result.body.errors, { count: 'Field is read-only' });
    assert.equal(result.body.error, undefined);
  });

  it('rejects an unknown action', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    const result = await runtime.update(
      updatePayload(snapshot, {}, 1, { name: 'nope' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 400);
    assert.equal(result.body.error?.code, 'invalid_request');
  });

  it('rejects a structurally invalid request payload', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const result = await runtime.update('not-an-object', updateContext('csrf'));
    assert.equal(result.status, 400);
    assert.equal(result.body.error?.code, 'invalid_request');
  });

  it('returns value-free field errors on validation failure and preserves the submitted value', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    const result = await runtime.update(
      updatePayload(snapshot, { title: 12345 }),
      updateContext(csrf),
    );

    assert.equal(result.status, 422);
    assert.equal(result.body.error, undefined);
    assert.ok(result.body.errors);
    // The raw submitted value never leaks into the message.
    const titleError = result.body.errors.title;
    assert.ok(titleError);
    assert.equal(titleError.includes('12345'), false);
    // The 422 re-render preserves the submitted value for repopulation.
    assert.match(result.body.html ?? '', /value="12345"/);
  });

  it('rejects an action with invalid args', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    const result = await runtime.update(
      updatePayload(snapshot, {}, 1, { name: 'increment', args: { by: 'x' } }),
      updateContext(csrf),
    );

    assert.equal(result.status, 422);
    assert.ok(result.body.errors);
  });

  it('denies an action when a client edit pushes a writable field past the authorize limit, without running it', async () => {
    let runCalls = 0;
    const budget = defineServerComponent<{ amount: number }>({
      name: 'Budget',
      stateSchema: z.object({ amount: z.number() }).strict(),
      writableKeys: ['amount'],
      initialState() {
        return { amount: 0 };
      },
      authorize() {
        return true;
      },
      actions: {
        spend: defineAction({
          authorize(_context, state) {
            return state.amount <= 100;
          },
          run(state) {
            runCalls += 1;
            state.amount += 1;
          },
        }),
      },
      render(state) {
        return <span>{state.amount}</span>;
      },
    });
    const runtime = makeRuntime({ Budget: budget });
    const { snapshot, csrf } = await mount(runtime, 'Budget');

    const result = await runtime.update(
      updatePayload(snapshot, { amount: 500 }, 1, { name: 'spend' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 403);
    assert.equal(result.body.error?.code, 'forbidden');
    assert.equal(runCalls, 0);
  });

  it('rejects an invalid client edit with 422 before invoking action authorize or run', async () => {
    let authorizeCalls = 0;
    let runCalls = 0;
    const strictCount = defineServerComponent<{ count: number }>({
      name: 'StrictCount',
      stateSchema: z.object({ count: z.number() }).strict(),
      writableKeys: ['count'],
      initialState() {
        return { count: 0 };
      },
      authorize() {
        return true;
      },
      actions: {
        bump: defineAction({
          authorize() {
            authorizeCalls += 1;
            return true;
          },
          run(state) {
            runCalls += 1;
            state.count += 1;
          },
        }),
      },
      render(state) {
        return <span>{state.count}</span>;
      },
    });
    const runtime = makeRuntime({ StrictCount: strictCount });
    const { snapshot, csrf } = await mount(runtime, 'StrictCount');

    const result = await runtime.update(
      updatePayload(snapshot, { count: 'not-a-number' }, 1, { name: 'bump' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 422);
    assert.ok(result.body.errors);
    assert.equal(authorizeCalls, 0);
    assert.equal(runCalls, 0);
  });

  it('hands authorize and run the same schema-normalized candidate', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    let authorizedLabel: unknown;
    let executedLabel: unknown;
    const normalized = defineServerComponent<{ label: string }>({
      name: 'Normalized',
      stateSchema: z.object({ label: z.string().trim() }).strict(),
      writableKeys: ['label'],
      initialState() {
        return { label: 'hello' };
      },
      authorize() {
        return true;
      },
      actions: {
        save: defineAction({
          authorize(_context, state) {
            authorizedLabel = state.label;
            return state.label === 'hello';
          },
          run(state) {
            executedLabel = state.label;
          },
        }),
      },
      render(state) {
        return <span>{state.label}</span>;
      },
    });
    const runtime = createServerComponentsRuntime({
      components: { Normalized: normalized },
      signer,
    });
    const { snapshot, csrf } = await mount(runtime, 'Normalized');

    const result = await runtime.update(
      updatePayload(snapshot, { label: '  hello  ' }, 1, { name: 'save' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    assert.equal(authorizedLabel, 'hello');
    assert.equal(executedLabel, 'hello');
    const verified = signer.verify(result.body.snapshot!, { origin: ORIGIN, subject: null });
    assert.deepEqual(verified.state, { label: 'hello' });
  });

  it('rehydrates publicOrigin and renderMode into the update context', async () => {
    let seenPublicOrigin: string | undefined;
    let seenRenderMode: string | undefined;
    const traced = defineServerComponent<{ n: number }>({
      name: 'ContextTraced',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState() {
        return { n: 0 };
      },
      authorize() {
        return true;
      },
      actions: {
        ping: defineAction({
          run(_state, _input, context) {
            seenPublicOrigin = context.publicOrigin;
            seenRenderMode = context.renderMode;
          },
        }),
      },
      render() {
        return <span>traced</span>;
      },
    });
    const runtime = makeRuntime({ ContextTraced: traced });
    const { snapshot, csrf } = await mount(runtime, 'ContextTraced');

    const context: RequestContext = {
      ...updateContext(csrf),
      publicOrigin: 'https://public.example',
      renderMode: 'static',
    };

    const result = await runtime.update(updatePayload(snapshot, {}, 1, { name: 'ping' }), context);

    assert.equal(result.status, 200);
    assert.equal(seenPublicOrigin, 'https://public.example');
    assert.equal(seenRenderMode, 'static');
  });

  it('preserves storagePath into the reconstructed update context', async () => {
    let seenStoragePath: string | undefined;
    const traced = defineServerComponent<{ n: number }>({
      name: 'StorageTraced',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState() {
        return { n: 0 };
      },
      authorize() {
        return true;
      },
      actions: {
        ping: defineAction({
          run(_state, _input, context) {
            seenStoragePath = context.storagePath;
          },
        }),
      },
      render() {
        return <span>traced</span>;
      },
    });
    const runtime = makeRuntime({ StorageTraced: traced });
    const { snapshot, csrf } = await mount(runtime, 'StorageTraced');

    const context: RequestContext = {
      ...updateContext(csrf),
      storagePath: '/data/app/storage',
    };

    const result = await runtime.update(updatePayload(snapshot, {}, 1, { name: 'ping' }), context);

    assert.equal(result.status, 200);
    assert.equal(seenStoragePath, '/data/app/storage');
  });

  it('preserves snapshot.revision when re-signing', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const runtime = createServerComponentsRuntime({ components: { Counter: counter }, signer });

    // Sign a snapshot directly so it carries a revision the runtime must keep.
    const token = signer.sign({
      v: 1,
      component: 'Counter',
      id: 'fixed-id',
      state: { count: 0, title: 'hello' },
      page: { path: '/counter', params: {} },
      origin: ORIGIN,
      subject: null,
      revision: 7,
    });

    const result = await runtime.update(
      updatePayload(token, { title: 'changed' }, 1),
      updateContext('fixed-id'),
    );

    assert.equal(result.status, 200);
    const verified = signer.verify(result.body.snapshot!, { origin: ORIGIN, subject: null });
    assert.equal(verified.revision, 7);
  });

  it('throws after close', async () => {
    const runtime = makeRuntime({ Counter: counter });
    runtime.close();
    runtime.close(); // idempotent
    await assert.rejects(
      () => runtime.render('Counter', renderContext()),
      ServerComponentRuntimeError,
    );
    await assert.rejects(
      () => runtime.update(updatePayload('x', {}), updateContext('csrf')),
      ServerComponentRuntimeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Action failure handling
// ---------------------------------------------------------------------------

describe('action failure handling', () => {
  it('maps a blank domain validation raised in run to a 422 title error', async () => {
    const runtime = makeRuntime({ Addable: addable });
    const { snapshot, csrf } = await mount(runtime, 'Addable');

    const result = await runtime.update(
      updatePayload(snapshot, { note: 'kept' }, 1, { name: 'add' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 422);
    assert.equal(result.body.error, undefined);
    assert.ok(result.body.errors?.title);
    // The submitted sibling value is repopulated for the re-render.
    assert.match(result.body.html ?? '', /value="kept"/);
  });

  it('keeps the original token and state coherent when run mutates then fails', async () => {
    const runtime = makeRuntime({ Addable: addable });
    const { snapshot, csrf } = await mount(runtime, 'Addable');

    const result = await runtime.update(
      updatePayload(snapshot, {}, 1, { name: 'poison' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 422);
    assert.ok(result.body.errors?.title);
    // The action mutated a nested (z.any) field, but only on its own clone, so
    // the 422 re-render still shows the untouched signed state...
    assert.match(result.body.html ?? '', />0<\/span>/);
    assert.equal((result.body.html ?? '').includes('>99<'), false);
    // ...and re-emits the original token, so state and token agree.
    assert.equal(extractAttr(result.body.html ?? '', COMPONENT_SNAPSHOT_ATTRIBUTE), snapshot);
  });

  it('turns a generic throw into a value-free 500 without leaking the message', async () => {
    const runtime = makeRuntime({ Addable: addable });
    const { snapshot, csrf } = await mount(runtime, 'Addable');

    const result = await runtime.update(
      updatePayload(snapshot, {}, 1, { name: 'boom' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 500);
    assert.equal(result.body.error?.code, 'internal_error');
    assert.equal(result.body.error?.message, 'Internal Server Error');
    assert.equal(result.body.errors, undefined);
    assert.equal(JSON.stringify(result.body).includes('super-secret-token'), false);
  });

  it('rejects a nested forbidden key before the action runs', async () => {
    let runCalls = 0;
    const blobComponent = defineServerComponent<{ payload: any; touched: number }>({
      name: 'Blob',
      stateSchema: z.object({ payload: z.any(), touched: z.number() }).strict(),
      writableKeys: ['payload'],
      initialState() {
        return { payload: {}, touched: 0 };
      },
      authorize() {
        return true;
      },
      actions: {
        touch: defineAction({
          run(state) {
            runCalls += 1;
            state.touched += 1;
          },
        }),
      },
      render(state) {
        return <span>{state.touched}</span>;
      },
    });
    const runtime = makeRuntime({ Blob: blobComponent });
    const { snapshot, csrf } = await mount(runtime, 'Blob');

    // An own `__proto__` key survives JSON.parse and a `z.any` state field.
    const nested = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    assert.equal(Object.hasOwn(nested, '__proto__'), true);

    const result = await runtime.update(
      updatePayload(snapshot, { payload: nested }, 1, { name: 'touch' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 400);
    assert.equal(result.body.error?.code, 'invalid_request');
    assert.equal(runCalls, 0);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

// ---------------------------------------------------------------------------
// Response shape integrity
// ---------------------------------------------------------------------------

describe('update response contract', () => {
  it('always echoes the sequence and never mixes error with snapshot/errors', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    const ok = await runtime.update(
      updatePayload(snapshot, { title: 't' }, 7),
      updateContext(csrf),
    );
    assert.equal(ok.body.sequence, 7);
    assert.ok(ok.body.snapshot);
    assert.equal(ok.body.error, undefined);

    const bad = await runtime.update(updatePayload('tampered', {}, 8), updateContext(csrf));
    assert.equal(bad.body.sequence, 8);
    assert.equal(bad.body.error?.code, 'invalid_snapshot');
    assert.equal(bad.body.snapshot, undefined);
    assert.equal(bad.body.errors, undefined);
    assert.equal(bad.body.html, undefined);
  });
});
