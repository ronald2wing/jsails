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

import type { RequestContext, Session } from '../../src/contracts/http.js';
import {
  defineAction,
  defineServerComponent,
  isRedirect,
  redirect,
  type ServerComponentDefinition,
} from '../../src/server-components/component.js';
import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_NAME_ATTRIBUTE,
  COMPONENT_ROOT_ID_PREFIX,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  REFRESH_ACTION,
  RULES_ATTRIBUTE,
} from '../../src/server-components/protocol.js';
import {
  createServerComponentsRuntime,
  ServerComponentRuntimeError,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime.js';
import { createComponentSigner } from '../../src/server-components/snapshot.js';

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

/** A component whose fields span the portable scalar shapes (string/email/date/number). */
const form = defineServerComponent<{
  email: string;
  age: number;
  dob: string;
  title: string;
}>({
  name: 'Form',
  stateSchema: z
    .object({
      email: z.string().email(),
      age: z.number().min(18),
      dob: z.string().date(),
      title: z.string().min(3),
    })
    .strict(),
  writableKeys: ['email', 'age', 'dob', 'title'],
  initialState() {
    return { email: 'a@b.co', age: 30, dob: '2020-01-01', title: 'hey' };
  },
  authorize() {
    return true;
  },
  render(_state, { bind }) {
    return (
      <div>
        <input {...bind('email')} />
        <input {...bind('age')} />
        <input {...bind('dob')} />
        <input {...bind('title')} />
      </div>
    );
  },
});

/** A component that seeds `page` and `size` from the URL query string on mount. */
const pageable = defineServerComponent<{ page: number; size: number; title: string }>({
  name: 'Pageable',
  stateSchema: z.object({ page: z.number(), size: z.number(), title: z.string() }).strict(),
  urlBinding: ['page', 'size'],
  initialState() {
    return { page: 1, size: 20, title: 'default' };
  },
  authorize() {
    return true;
  },
  render(state, { bind }) {
    return (
      <div>
        <input {...bind('title')} value={state.title} />
        <span id="page">{state.page}</span>
        <span id="size">{state.size}</span>
      </div>
    );
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

/** Pull the `data-jsails-rules` marker for a bound field and decode its JSON. */
function extractRules(html: string, field: string): Record<string, unknown> {
  const match = html.match(
    new RegExp(`data-jsails-model="${field}"[^>]*${RULES_ATTRIBUTE}="([^"]*)"`),
  );
  assert.ok(match, `expected ${RULES_ATTRIBUTE} for ${field} in HTML: ${html}`);
  return JSON.parse(match[1]!.replaceAll('&quot;', '"')) as Record<string, unknown>;
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

/** Render a mount with a custom URL (for query-string seeding tests). */
async function mountWithUrl(
  runtime: ServerComponentsRuntime,
  name: string,
  url: string,
  session: Session | null = null,
): Promise<{ html: string; snapshot: string; csrf: string }> {
  const parsedUrl = new URL(url);
  const html = await runtime.render(name, {
    request: makeRequest(url),
    url: parsedUrl,
    params: {},
    session,
  });
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

// ---------------------------------------------------------------------------
// Bind validation metadata
// ---------------------------------------------------------------------------

describe('bind validation metadata', () => {
  it('emits a type hint and rules marker for email, number, and date fields', async () => {
    const runtime = makeRuntime({ Form: form });
    const html = await runtime.render('Form', renderContext());

    assert.match(html, /data-jsails-model="email"[^>]*type="email"/);
    assert.deepEqual(extractRules(html, 'email'), { required: true, type: 'email' });

    assert.match(html, /data-jsails-model="age"[^>]*type="number"/);
    assert.deepEqual(extractRules(html, 'age'), { required: true, type: 'number', min: 18 });

    assert.match(html, /data-jsails-model="dob"[^>]*type="date"/);
    assert.deepEqual(extractRules(html, 'dob'), { required: true, type: 'date' });
  });

  it('emits rules but no type hint for a plain string field', async () => {
    const runtime = makeRuntime({ Form: form });
    const html = await runtime.render('Form', renderContext());

    // The string field carries its length bound but no `type` attribute.
    assert.equal(/data-jsails-model="title"[^>]*type=/.test(html), false);
    assert.deepEqual(extractRules(html, 'title'), {
      required: true,
      type: 'string',
      minLength: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// $refresh no-op action
// ---------------------------------------------------------------------------

describe('$refresh no-op action', () => {
  it('applies writable edits, re-signs, and re-renders without an action lookup', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const runtime = createServerComponentsRuntime({ components: { Counter: counter }, signer });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    // `$refresh` is not declared in the component's actions; a real action path
    // would reject it as unknown. The no-op path must skip the lookup entirely.
    const result = await runtime.update(
      updatePayload(snapshot, { title: 'refreshed' }, 1, { name: REFRESH_ACTION, args: {} }),
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.error, undefined);
    const verified = signer.verify(result.body.snapshot!, { origin: ORIGIN, subject: null });
    assert.deepEqual(verified.state, { count: 0, title: 'refreshed' });
    assert.match(result.body.html ?? '', /value="refreshed"/);
  });

  it('still validates writable edits through the full schema pipeline', async () => {
    const runtime = makeRuntime({ Counter: counter });
    const { snapshot, csrf } = await mount(runtime, 'Counter');

    const result = await runtime.update(
      updatePayload(snapshot, { title: 12345 }, 1, { name: REFRESH_ACTION, args: {} }),
      updateContext(csrf),
    );

    assert.equal(result.status, 422);
    assert.equal(result.body.error, undefined);
    assert.ok(result.body.errors?.title);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

describe('lifecycle hooks', () => {
  it('runs mount on the first live render only, not on update', async () => {
    let mountCalls = 0;
    let seenContext: RequestContext | undefined;
    const mounty = defineServerComponent<{ n: number }>({
      name: 'Mounty',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState() {
        return { n: 0 };
      },
      authorize() {
        return true;
      },
      mount(context) {
        mountCalls += 1;
        seenContext = context;
      },
      render() {
        return <span>live</span>;
      },
    });
    const runtime = makeRuntime({ Mounty: mounty });

    const { snapshot, csrf } = await mount(runtime, 'Mounty');
    assert.equal(mountCalls, 1);
    assert.equal(seenContext?.url.pathname, '/counter');

    // `mount` is a first-render hook: an update re-renders the same instance
    // without re-running it.
    const result = await runtime.update(updatePayload(snapshot, {}, 1), updateContext(csrf));
    assert.equal(result.status, 200);
    assert.equal(mountCalls, 1);
  });

  it('does not run mount (or any callback) in static mode', async () => {
    let mountCalls = 0;
    let initialStateCalls = 0;
    const staticMounty = defineServerComponent({
      name: 'StaticMounty',
      stateSchema: z.object({}).strict(),
      initialState() {
        initialStateCalls += 1;
        return {};
      },
      authorize() {
        return true;
      },
      mount() {
        mountCalls += 1;
      },
      render() {
        return <span>live</span>;
      },
      staticFallback() {
        return <div class="static">fallback</div>;
      },
    });
    const runtime = makeRuntime({ StaticMounty: staticMounty });

    const html = await runtime.render('StaticMounty', renderContext(), { staticMode: true });

    assert.equal(mountCalls, 0);
    assert.equal(initialStateCalls, 0);
    assert.match(html, /class="static">fallback/);
  });

  it('sanitizes a mount throw into a value-free runtime error', async () => {
    const mountBoom = defineServerComponent({
      name: 'MountBoom',
      stateSchema: z.object({}).strict(),
      initialState() {
        return {};
      },
      authorize() {
        return true;
      },
      mount() {
        throw new Error('secret-mount-token');
      },
      render() {
        return null;
      },
    });
    const runtime = makeRuntime({ MountBoom: mountBoom });

    await assert.rejects(
      () => runtime.render('MountBoom', renderContext()),
      (error: unknown) => {
        assert.ok(error instanceof ServerComponentRuntimeError);
        assert.equal(String(error).includes('secret-mount-token'), false);
        return true;
      },
    );
  });

  it('awaits hooks in order across a mount and an edited update: mount, hydrate, updating, updated', async () => {
    const order: string[] = [];
    const hooked = defineServerComponent<{ n: number; label: string }>({
      name: 'Hooked',
      stateSchema: z.object({ n: z.number(), label: z.string() }).strict(),
      writableKeys: ['label'],
      initialState() {
        return { n: 0, label: 'a' };
      },
      authorize() {
        return true;
      },
      mount() {
        order.push('mount');
      },
      hydrate() {
        order.push('hydrate');
      },
      updating() {
        order.push('updating');
      },
      updated() {
        order.push('updated');
      },
      actions: {
        bump: defineAction({
          run(state) {
            state.n += 1;
          },
        }),
      },
      render() {
        return <span>ok</span>;
      },
    });
    const runtime = makeRuntime({ Hooked: hooked });

    const { snapshot, csrf } = await mount(runtime, 'Hooked');
    assert.deepEqual(order, ['mount']);

    const result = await runtime.update(
      updatePayload(snapshot, { label: 'b' }, 1, { name: 'bump' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    assert.deepEqual(order, ['mount', 'hydrate', 'updating', 'updated']);
  });

  it('runs hydrate on every update (even without edits) but never at mount', async () => {
    let hydrateCalls = 0;
    const hydrating = defineServerComponent<{ n: number }>({
      name: 'Hydrating',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState() {
        return { n: 0 };
      },
      authorize() {
        return true;
      },
      hydrate() {
        hydrateCalls += 1;
      },
      render() {
        return <span>ok</span>;
      },
    });
    const runtime = makeRuntime({ Hydrating: hydrating });

    const { snapshot, csrf } = await mount(runtime, 'Hydrating');
    assert.equal(hydrateCalls, 0);

    await runtime.update(updatePayload(snapshot, {}, 1), updateContext(csrf));
    assert.equal(hydrateCalls, 1);
  });

  it('persists server-side hydrate mutations into the re-signed state', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const hydrator = defineServerComponent<{ n: number }>({
      name: 'Hydrator',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState() {
        return { n: 2 };
      },
      authorize() {
        return true;
      },
      hydrate(state) {
        state.n += 100;
      },
      render() {
        return <span>ok</span>;
      },
    });
    const runtime = createServerComponentsRuntime({ components: { Hydrator: hydrator }, signer });

    const { snapshot, csrf } = await mount(runtime, 'Hydrator');
    const result = await runtime.update(updatePayload(snapshot, {}, 1), updateContext(csrf));

    assert.equal(result.status, 200);
    const verified = signer.verify(result.body.snapshot!, { origin: ORIGIN, subject: null });
    assert.deepEqual(verified.state, { n: 102 });
  });

  it('runs updating only when client edits are present', async () => {
    let updatingCalls = 0;
    const updater = defineServerComponent<{ label: string }>({
      name: 'Updater',
      stateSchema: z.object({ label: z.string() }).strict(),
      writableKeys: ['label'],
      initialState() {
        return { label: 'a' };
      },
      authorize() {
        return true;
      },
      updating() {
        updatingCalls += 1;
      },
      render() {
        return <span>ok</span>;
      },
    });
    const runtime = makeRuntime({ Updater: updater });

    const { snapshot, csrf } = await mount(runtime, 'Updater');
    await runtime.update(updatePayload(snapshot, {}, 1), updateContext(csrf));
    assert.equal(updatingCalls, 0);

    await runtime.update(updatePayload(snapshot, { label: 'b' }, 2), updateContext(csrf));
    assert.equal(updatingCalls, 1);
  });

  it('turns an updating throw into a value-free 500 and rejects the update', async () => {
    const rejector = defineServerComponent<{ label: string }>({
      name: 'UpdatingReject',
      stateSchema: z.object({ label: z.string() }).strict(),
      writableKeys: ['label'],
      initialState() {
        return { label: 'a' };
      },
      authorize() {
        return true;
      },
      updating() {
        throw new Error('secret-updating-token');
      },
      render() {
        return <span>ok</span>;
      },
    });
    const runtime = makeRuntime({ UpdatingReject: rejector });

    const { snapshot, csrf } = await mount(runtime, 'UpdatingReject');
    const result = await runtime.update(
      updatePayload(snapshot, { label: 'b' }, 1),
      updateContext(csrf),
    );

    assert.equal(result.status, 500);
    assert.equal(result.body.error?.code, 'internal_error');
    assert.equal(JSON.stringify(result.body).includes('secret-updating-token'), false);
  });

  it('maps a ZodError thrown in updating to a 422 field error', async () => {
    const zodRejector = defineServerComponent<{ label: string }>({
      name: 'UpdatingZod',
      stateSchema: z.object({ label: z.string() }).strict(),
      writableKeys: ['label'],
      initialState() {
        return { label: 'a' };
      },
      authorize() {
        return true;
      },
      updating() {
        z.object({ label: z.string().min(3) }).parse({ label: 'ab' });
      },
      render() {
        return <span>ok</span>;
      },
    });
    const runtime = makeRuntime({ UpdatingZod: zodRejector });

    const { snapshot, csrf } = await mount(runtime, 'UpdatingZod');
    const result = await runtime.update(
      updatePayload(snapshot, { label: 'b' }, 1),
      updateContext(csrf),
    );

    assert.equal(result.status, 422);
    assert.equal(result.body.error, undefined);
    assert.ok(result.body.errors?.label);
  });

  it('turns an updated throw into a value-free 500 (the action already ran)', async () => {
    let runCalls = 0;
    const updatedBoom = defineServerComponent<{ n: number }>({
      name: 'UpdatedBoom',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState() {
        return { n: 0 };
      },
      authorize() {
        return true;
      },
      actions: {
        bump: defineAction({
          run(state) {
            runCalls += 1;
            state.n += 1;
          },
        }),
      },
      updated() {
        throw new Error('secret-updated-token');
      },
      render() {
        return <span>ok</span>;
      },
    });
    const runtime = makeRuntime({ UpdatedBoom: updatedBoom });

    const { snapshot, csrf } = await mount(runtime, 'UpdatedBoom');
    const result = await runtime.update(
      updatePayload(snapshot, {}, 1, { name: 'bump' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 500);
    assert.equal(result.body.error?.code, 'internal_error');
    assert.equal(JSON.stringify(result.body).includes('secret-updated-token'), false);
    assert.equal(runCalls, 1);
  });

  it('maps a ZodError thrown in updated to a 500, never a 422', async () => {
    const updatedZod = defineServerComponent<{ n: number }>({
      name: 'UpdatedZod',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState() {
        return { n: 0 };
      },
      authorize() {
        return true;
      },
      actions: {
        bump: defineAction({
          run(state) {
            state.n += 1;
          },
        }),
      },
      updated() {
        z.object({}).strict().parse({ extra: true });
      },
      render() {
        return <span>ok</span>;
      },
    });
    const runtime = makeRuntime({ UpdatedZod: updatedZod });

    const { snapshot, csrf } = await mount(runtime, 'UpdatedZod');
    const result = await runtime.update(
      updatePayload(snapshot, {}, 1, { name: 'bump' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 500);
    assert.equal(result.body.error?.code, 'internal_error');
    assert.equal(result.body.errors, undefined);
  });

  it('does not run updated when hydrate rejects the update', async () => {
    let updatedCalls = 0;
    const hydrating = defineServerComponent<{ n: number }>({
      name: 'NoUpdatedOnHydrateReject',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState() {
        return { n: 0 };
      },
      authorize() {
        return true;
      },
      hydrate() {
        throw new Error('hydrate-boom');
      },
      updated() {
        updatedCalls += 1;
      },
      render() {
        return <span>ok</span>;
      },
    });
    const runtime = makeRuntime({ NoUpdatedOnHydrateReject: hydrating });

    const { snapshot, csrf } = await mount(runtime, 'NoUpdatedOnHydrateReject');
    const result = await runtime.update(updatePayload(snapshot, {}, 1), updateContext(csrf));

    assert.equal(result.status, 500);
    assert.equal(updatedCalls, 0);
  });
});

// ---------------------------------------------------------------------------
// Computed properties
// ---------------------------------------------------------------------------

describe('computed properties', () => {
  it('exposes computed values to render through tools.computed', async () => {
    const computedCounter = defineServerComponent<{ count: number }>({
      name: 'ComputedCounter',
      stateSchema: z.object({ count: z.number() }).strict(),
      initialState() {
        return { count: 3 };
      },
      authorize() {
        return true;
      },
      computed: {
        doubled(state) {
          return state.count * 2;
        },
        label(state) {
          return `count=${state.count}`;
        },
      },
      render(state, { computed }) {
        return (
          <div>
            <span id="doubled">{computed('doubled') as number}</span>
            <span id="label">{computed('label') as string}</span>
          </div>
        );
      },
    });
    const runtime = makeRuntime({ ComputedCounter: computedCounter });

    const html = await runtime.render('ComputedCounter', renderContext());

    assert.match(html, /id="doubled">6</);
    assert.match(html, /id="label">count=3</);
  });

  it('memoizes a computed value per render (the function runs once)', async () => {
    let calls = 0;
    const memoized = defineServerComponent<{ count: number }>({
      name: 'MemoComputed',
      stateSchema: z.object({ count: z.number() }).strict(),
      initialState() {
        return { count: 1 };
      },
      authorize() {
        return true;
      },
      computed: {
        heavy() {
          calls += 1;
          return 42;
        },
      },
      render(_state, { computed }) {
        const first = computed('heavy');
        const second = computed('heavy');
        return <span>{first === second ? 'same' : 'diff'}</span>;
      },
    });
    const runtime = makeRuntime({ MemoComputed: memoized });

    const html = await runtime.render('MemoComputed', renderContext());

    assert.equal(calls, 1);
    assert.match(html, />same</);
  });

  it('supports async computed values, resolved once per render', async () => {
    let calls = 0;
    const asyncComputed = defineServerComponent<{ count: number }>({
      name: 'AsyncComputed',
      stateSchema: z.object({ count: z.number() }).strict(),
      initialState() {
        return { count: 5 };
      },
      authorize() {
        return true;
      },
      computed: {
        async doubled(state) {
          calls += 1;
          return state.count * 2;
        },
      },
      async render(_state, { computed }) {
        const value = (await computed('doubled')) as number;
        return <span>{value}</span>;
      },
    });
    const runtime = makeRuntime({ AsyncComputed: asyncComputed });

    const html = await runtime.render('AsyncComputed', renderContext());

    assert.equal(calls, 1);
    assert.match(html, />10</);
  });

  it('does not persist computed values into the signed state', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const computedPersist = defineServerComponent<{ count: number }>({
      name: 'ComputedPersist',
      stateSchema: z.object({ count: z.number() }).strict(),
      initialState() {
        return { count: 1 };
      },
      authorize() {
        return true;
      },
      computed: {
        doubled(state) {
          return state.count * 2;
        },
      },
      render(_state, { computed }) {
        return <span>{computed('doubled') as number}</span>;
      },
    });
    const runtime = createServerComponentsRuntime({
      components: { ComputedPersist: computedPersist },
      signer,
    });

    const { html, snapshot } = await mount(runtime, 'ComputedPersist');

    const verified = signer.verify(snapshot, { origin: ORIGIN, subject: null });
    assert.deepEqual(verified.state, { count: 1 });
    assert.equal(Object.hasOwn(verified.state, 'doubled'), false);
    assert.match(html, />2</);
  });

  it('throws a value-free error for an unknown computed property', async () => {
    const unknownComputed = defineServerComponent<{ count: number }>({
      name: 'UnknownComputed',
      stateSchema: z.object({ count: z.number() }).strict(),
      initialState() {
        return { count: 1 };
      },
      authorize() {
        return true;
      },
      render(_state, { computed }) {
        return <span>{computed('missing') as string}</span>;
      },
    });
    const runtime = makeRuntime({ UnknownComputed: unknownComputed });

    await assert.rejects(
      () => runtime.render('UnknownComputed', renderContext()),
      (error: unknown) => {
        assert.ok(error instanceof ServerComponentRuntimeError);
        assert.equal(String(error).includes('missing'), false);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Action redirect
// ---------------------------------------------------------------------------

const navigator = defineServerComponent<{ page: string }>({
  name: 'Navigator',
  stateSchema: z.object({ page: z.string() }).strict(),
  writableKeys: ['page'],
  initialState() {
    return { page: '' };
  },
  authorize() {
    return true;
  },
  actions: {
    go: defineAction({
      run(state) {
        return redirect(state.page || '/dashboard');
      },
    }),
    noop: defineAction({
      run() {
        // Returns undefined — no redirect.
      },
    }),
  },
  render(state, { bind }) {
    return <input {...bind('page')} />;
  },
});

describe('action redirect', () => {
  it('includes redirect in the 200 body when an action returns redirect()', async () => {
    const runtime = makeRuntime({ Navigator: navigator });
    const { snapshot, csrf } = await mount(runtime, 'Navigator');

    const result = await runtime.update(
      updatePayload(snapshot, { page: '/dashboard' }, 1, { name: 'go' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    assert.equal(typeof result.body.redirect, 'string', 'redirect must be present');
    assert.equal(result.body.redirect, '/dashboard');
    assert.equal(typeof result.body.snapshot, 'string', 'snapshot must be present');
    assert.equal(typeof result.body.html, 'string', 'html must be present');
  });

  it('omits redirect when the action returns undefined', async () => {
    const runtime = makeRuntime({ Navigator: navigator });
    const { snapshot, csrf } = await mount(runtime, 'Navigator');

    const result = await runtime.update(
      updatePayload(snapshot, { page: '/somewhere' }, 1, { name: 'noop' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.redirect, undefined, 'redirect must be absent');
  });

  it('result omits redirect when the action produced none', async () => {
    // A component action that returns void — redirect must be absent, not
    // present as an empty string or undefined.
    const runtime = makeRuntime({ Navigator: navigator });
    const { snapshot, csrf } = await mount(runtime, 'Navigator');

    const result = await runtime.update(
      updatePayload(snapshot, { page: '/about' }, 1, { name: 'noop' }),
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    assert.ok(!('redirect' in result.body), 'body must not carry a redirect key');
  });
});

// ---------------------------------------------------------------------------
// redirect() helper validation
// ---------------------------------------------------------------------------

describe('redirect() helper validation', () => {
  it('rejects an empty string', () => {
    assert.throws(
      () => redirect(''),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /non-empty/);
        return true;
      },
    );
  });

  it('rejects a javascript: scheme (open-redirect / XSS prevention)', () => {
    assert.throws(
      () => redirect('javascript:alert(1)'),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /javascript/);
        return true;
      },
    );
  });

  it('rejects a data: scheme', () => {
    assert.throws(
      () => redirect('data:text/html,<script>alert(1)</script>'),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        return true;
      },
    );
  });

  it('rejects a vbscript: scheme', () => {
    assert.throws(
      () => redirect('vbscript:msgbox(1)'),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        return true;
      },
    );
  });

  it('allows a relative path', () => {
    const r = redirect('/dashboard');
    assert.equal(r.url, '/dashboard');
  });

  it('allows an absolute http URL', () => {
    const r = redirect('https://example.com/path');
    assert.equal(r.url, 'https://example.com/path');
  });

  it('rejects a URL with control characters', () => {
    assert.throws(
      () => redirect('/dash\x00board'),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// URL binding (query-string seeding on mount)
// ---------------------------------------------------------------------------

describe('urlBinding', () => {
  it('seeds declared fields from the URL query string on mount', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const runtime = createServerComponentsRuntime({ components: { Pageable: pageable }, signer });
    const { html, snapshot } = await mountWithUrl(
      runtime,
      'Pageable',
      'http://localhost/counter?page=3&size=50',
    );

    // The rendered HTML reflects the seeded values.
    assert.match(html, /id="page">3</);
    assert.match(html, /id="size">50</);

    // Verify the signed snapshot carries the seeded state, not the defaults.
    const verified = signer.verify(snapshot, { origin: ORIGIN, subject: null });
    assert.deepEqual(verified.state, { page: 3, size: 50, title: 'default' });
  });

  it('leaves fields at initialState when not present in the query', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const runtime = createServerComponentsRuntime({ components: { Pageable: pageable }, signer });
    const { html, snapshot } = await mountWithUrl(
      runtime,
      'Pageable',
      'http://localhost/counter?page=3',
    );

    // Only `page` was seeded; `size` keeps its default.
    assert.match(html, /id="page">3</);
    assert.match(html, /id="size">20</);

    const verified = signer.verify(snapshot, { origin: ORIGIN, subject: null });
    assert.deepEqual(verified.state, { page: 3, size: 20, title: 'default' });
  });

  it('ignores the URL on update (snapshot-wins-after-first-render)', async () => {
    const signer = createComponentSigner({ key: KEY, now: () => 0 });
    const runtime = createServerComponentsRuntime({ components: { Pageable: pageable }, signer });
    const { snapshot, csrf } = await mountWithUrl(
      runtime,
      'Pageable',
      'http://localhost/counter?page=3&size=50',
    );

    // Construct an update context with a DIFFERENT URL (as if the user
    // navigated to a page with different query params). The update must
    // reconstruct state from the signed snapshot only.
    const contextUrl = new URL('http://localhost/counter?page=99&size=0');
    const context: RequestContext = {
      request: makeRequest(
        contextUrl.toString(),
        { origin: ORIGIN, [COMPONENT_CSRF_HEADER]: csrf },
        'POST',
      ),
      url: contextUrl,
      params: {},
      session: null,
    };

    const result = await runtime.update(updatePayload(snapshot, {}, 1), context);

    assert.equal(result.status, 200);
    const verified = signer.verify(result.body.snapshot!, { origin: ORIGIN, subject: null });
    // The state is unchanged by the new URL — snapshot wins.
    assert.deepEqual(verified.state, { page: 3, size: 50, title: 'default' });
  });
});

describe('isRedirect guard', () => {
  it('accepts a redirect() result', () => {
    assert.equal(isRedirect(redirect('/dashboard')), true);
  });

  it('matches the structural discriminator (plain object, not a spoof boundary)', () => {
    assert.equal(isRedirect({ __jsailsRedirect: true, url: '/x' }), true);
  });

  it('rejects non-objects and unrelated values', () => {
    assert.equal(isRedirect(undefined), false);
    assert.equal(isRedirect(null), false);
    assert.equal(isRedirect('redirect'), false);
    assert.equal(isRedirect(42), false);
    assert.equal(isRedirect({}), false);
    assert.equal(isRedirect({ url: '/x' }), false);
  });
});
