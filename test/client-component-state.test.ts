/**
 * Browser-safe component-state controller tests.
 *
 * These exercise the pure client model and wire protocol against injected
 * fetch doubles; no DOM, Preact, or live server is involved. Snapshot tokens
 * are hand-built base64url bodies (signatures are never verified client-side).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../src/contracts/http.js';
import {
  COMPONENT_CSRF_HEADER,
  COMPONENT_UPDATE_ENDPOINT,
} from '../src/server-components/protocol.js';
import {
  ComponentControllerError,
  ComponentSnapshotError,
  createComponentController,
  decodePublicSnapshot,
  type ComponentFetch,
  type ComponentFetchInit,
  type ComponentRender,
} from '../src/client/component-state.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost';

function makeToken(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${'A'.repeat(43)}`;
}

function snapshotPayload(
  state: JsonObject = { title: 'hello', count: 0 },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    component: 'Counter',
    id: 'id-1',
    state,
    page: { path: '/Counter', params: {} },
    origin: ORIGIN,
    subject: null,
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function tokenFor(state: JsonObject): string {
  return makeToken(snapshotPayload(state));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function successResponse(sequence: number, state: JsonObject, html = '<p>ok</p>'): Response {
  return jsonResponse(200, { sequence, snapshot: tokenFor(state), html });
}

interface FetchCall {
  readonly url: string;
  readonly init: ComponentFetchInit;
  readonly body: Record<string, unknown>;
}

function makeFetch(
  handler: (
    body: Record<string, unknown>,
    init: ComponentFetchInit,
  ) => Promise<Response> | Response,
): { fetch: ComponentFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: ComponentFetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, init, body });
    return handler(body, init);
  };
  return { fetch, calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function baseOptions(overrides: Partial<Parameters<typeof createComponentController>[0]> = {}) {
  return {
    snapshot: tokenFor({ title: 'hello', count: 0 }),
    csrfToken: 'csrf-token-1',
    origin: ORIGIN,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decodePublicSnapshot
// ---------------------------------------------------------------------------

describe('decodePublicSnapshot', () => {
  it('decodes state and provenance without verifying the signature', () => {
    const payload = snapshotPayload();
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const first = decodePublicSnapshot(`${encoded}.${'A'.repeat(43)}`);
    const second = decodePublicSnapshot(`${encoded}.${'B'.repeat(43)}`);
    assert.deepEqual(first.state, { title: 'hello', count: 0 });
    assert.equal(first.component, 'Counter');
    assert.equal(first.origin, ORIGIN);
    assert.deepEqual(second.state, first.state);
  });

  it('rejects a token with no separator', () => {
    assert.throws(() => decodePublicSnapshot('not-a-token'), ComponentSnapshotError);
  });

  it('rejects non-base64url payload bytes', () => {
    assert.throws(() => decodePublicSnapshot('not base64!.AAAA'), ComponentSnapshotError);
  });

  it('rejects a payload that is not JSON', () => {
    const token = `${Buffer.from('plain text', 'utf8').toString('base64url')}.${'A'.repeat(43)}`;
    assert.throws(() => decodePublicSnapshot(token), ComponentSnapshotError);
  });

  it('rejects a snapshot with an unexpected version', () => {
    assert.throws(
      () => decodePublicSnapshot(makeToken(snapshotPayload({}, { v: 2 }))),
      ComponentSnapshotError,
    );
  });

  it('rejects prototype-polluting keys in the snapshot body', () => {
    const state = JSON.parse('{"__proto__":{"polluted":true}}') as JsonObject;
    assert.throws(
      () => decodePublicSnapshot(makeToken(snapshotPayload(state))),
      ComponentSnapshotError,
    );
  });

  it('rejects a snapshot body nested past the depth bound', () => {
    let nested: unknown = {};
    for (let i = 0; i < 70; i += 1) {
      nested = { a: nested };
    }
    assert.throws(
      () => decodePublicSnapshot(makeToken(snapshotPayload(nested as JsonObject))),
      ComponentSnapshotError,
    );
  });

  it('rejects an oversized token before decoding it', () => {
    const huge = `${'A'.repeat(600 * 1024)}.${'A'.repeat(43)}`;
    assert.throws(() => decodePublicSnapshot(huge), ComponentSnapshotError);
  });
});

// ---------------------------------------------------------------------------
// createComponentController
// ---------------------------------------------------------------------------

describe('createComponentController', () => {
  it('rejects a cross-origin endpoint at construction', () => {
    const { fetch } = makeFetch(() => successResponse(1, {}));
    assert.throws(
      () =>
        createComponentController(baseOptions({ endpoint: 'https://evil.example/update', fetch })),
      (error: unknown) =>
        error instanceof ComponentControllerError && error.code === 'invalid_options',
    );
  });

  it('rejects an invalid origin', () => {
    assert.throws(
      () => createComponentController(baseOptions({ origin: 'not-an-origin' })),
      (error: unknown) =>
        error instanceof ComponentControllerError && error.code === 'invalid_options',
    );
  });

  it('exposes the decoded initial state and updates it via setField', () => {
    const { fetch } = makeFetch(() => successResponse(1, {}));
    const controller = createComponentController(baseOptions({ fetch }));
    assert.deepEqual(controller.state, { title: 'hello', count: 0 });
    controller.setField('title', 'world');
    assert.deepEqual(controller.state, { title: 'world', count: 0 });
  });

  it('rejects a field key that shadows an inherited property', () => {
    const { fetch } = makeFetch(() => successResponse(1, {}));
    const controller = createComponentController(baseOptions({ fetch }));
    for (const key of ['__proto__', 'constructor', 'toString']) {
      assert.throws(
        () => controller.setField(key, 1),
        (error: unknown) =>
          error instanceof ComponentControllerError && error.code === 'invalid_args',
      );
    }
  });

  it('diffs state, sends one same-origin CSRF request, and applies the server state', async () => {
    const { fetch, calls } = makeFetch((body) =>
      successResponse(body.sequence as number, { title: 'bye', count: 0 }),
    );
    const renders: ComponentRender[] = [];
    const controller = createComponentController(
      baseOptions({ fetch, onRender: (render) => void renders.push(render) }),
    );
    const initialToken = controller.snapshot;

    controller.setField('title', 'bye');
    const result = await controller.commit('save', { by: 2 });

    assert.equal(result.status, 'applied');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, COMPONENT_UPDATE_ENDPOINT);
    assert.equal(calls[0]!.init.credentials, 'same-origin');
    assert.equal(calls[0]!.init.headers[COMPONENT_CSRF_HEADER], 'csrf-token-1');
    // Args are separate from the updates diff.
    assert.deepEqual(calls[0]!.body.updates, { title: 'bye' });
    assert.deepEqual(calls[0]!.body.action, { name: 'save', args: { by: 2 } });
    assert.equal(calls[0]!.body.snapshot, initialToken);
    assert.equal(calls[0]!.body.sequence, 1);
    // The applied server state replaces canonical, and onRender sees it.
    assert.deepEqual(controller.state, { title: 'bye', count: 0 });
    assert.equal(renders.length, 1);
    assert.equal(renders[0]!.html, '<p>ok</p>');
    assert.deepEqual(renders[0]!.state, { title: 'bye', count: 0 });
  });

  it('serializes actions, dispatching the next only after the prior settles', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const pending = [first, second];
    let index = 0;
    const { fetch, calls } = makeFetch(() => pending[index++]!.promise);
    const controller = createComponentController(baseOptions({ fetch }));

    const p1 = controller.commit('first');
    const p2 = controller.commit('second');
    await flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body.sequence, 1);
    assert.deepEqual(calls[0]!.body.action, { name: 'first', args: {} });

    first.resolve(successResponse(1, { title: 'hello', count: 0 }, '<p>1</p>'));
    await p1;
    await flush();

    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body.sequence, 2);
    assert.deepEqual(calls[1]!.body.action, { name: 'second', args: {} });

    second.resolve(successResponse(2, { title: 'hello', count: 0 }, '<p>2</p>'));
    await p2;
    assert.equal(p1 instanceof Promise, true);
  });

  it('preserves newer edits across success, including fields the server changed', async () => {
    const pending = deferred<Response>();
    const { fetch } = makeFetch(() => pending.promise);
    const controller = createComponentController(baseOptions({ fetch }));

    controller.setField('title', 'submitted');
    const commit = controller.commit('save');
    await flush();
    controller.setField('title', 'newer');
    controller.setField('count', 99);

    pending.resolve(successResponse(1, { title: 'submitted', count: 5 }));
    const result = await commit;

    assert.equal(result.status, 'applied');
    // Both newer edits survive: the server is authoritative only for the state
    // it actually received, and these edits were made after the request was
    // sent, so the next action will carry them.
    assert.deepEqual(controller.state, { title: 'newer', count: 99 });
  });

  it('keeps a newer edit when the server clears a field that was unchanged at send', async () => {
    const pending = deferred<Response>();
    const { fetch, calls } = makeFetch(() => pending.promise);
    const controller = createComponentController(baseOptions({ fetch }));

    // `title` is unchanged at send, so it is NOT part of the updates diff.
    const commit = controller.commit('save');
    await flush();
    assert.deepEqual(calls[0]!.body.updates, {});

    // The user edits `title` while the request is in flight; the server then
    // clears it. The newer local edit must survive rather than be discarded as
    // a "server-owned" field.
    controller.setField('title', 'typed-while-pending');
    pending.resolve(successResponse(1, { title: '', count: 0 }));
    const result = await commit;

    assert.equal(result.status, 'applied');
    assert.deepEqual(controller.state, { title: 'typed-while-pending', count: 0 });
  });

  it('keeps submitted and newer edits on 422 and exposes field errors', async () => {
    const pending = deferred<Response>();
    const { fetch } = makeFetch(() => pending.promise);
    const controller = createComponentController(baseOptions({ fetch }));

    controller.setField('title', 'submitted');
    const commit = controller.commit('save');
    await flush();
    controller.setField('title', 'newer');

    pending.resolve(
      jsonResponse(422, { sequence: 1, errors: { title: 'Too long' }, html: '<p>err</p>' }),
    );
    const result = await commit;

    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.errors, { title: 'Too long' });
    assert.deepEqual(controller.errors, { title: 'Too long' });
    assert.deepEqual(controller.state, { title: 'newer', count: 0 });
  });

  it('blocks on an unexpected status and never retries or accepts new actions', async () => {
    const errors: ComponentControllerError[] = [];
    const { fetch, calls } = makeFetch(() =>
      jsonResponse(403, { sequence: 1, error: { code: 'csrf_mismatch', message: 'nope' } }),
    );
    const controller = createComponentController(
      baseOptions({ fetch, onError: (error) => void errors.push(error) }),
    );

    await assert.rejects(
      controller.commit('a'),
      (error: unknown) =>
        error instanceof ComponentControllerError && error.code === 'unexpected_status',
    );
    assert.equal(controller.blocked, true);
    await assert.rejects(
      controller.commit('b'),
      (error: unknown) => error instanceof ComponentControllerError && error.code === 'blocked',
    );
    assert.equal(calls.length, 1);
    assert.equal(errors.length, 1);
  });

  it('blocks on a network failure and reports a value-free error', async () => {
    const errors: ComponentControllerError[] = [];
    const { fetch } = makeFetch(() => {
      throw new Error('connection refused at https://internal.example/secret');
    });
    const controller = createComponentController(
      baseOptions({ fetch, onError: (error) => void errors.push(error) }),
    );

    await assert.rejects(
      controller.commit('a'),
      (error: unknown) =>
        error instanceof ComponentControllerError &&
        error.code === 'network' &&
        !error.message.includes('internal.example') &&
        !error.message.includes('secret'),
    );
    assert.equal(controller.blocked, true);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message.includes('internal.example'), false);
  });

  it('blocks on a malformed response body', async () => {
    const { fetch } = makeFetch(() => new Response('not json', { status: 200 }));
    const controller = createComponentController(baseOptions({ fetch }));
    await assert.rejects(
      controller.commit('a'),
      (error: unknown) =>
        error instanceof ComponentControllerError && error.code === 'malformed_response',
    );
    assert.equal(controller.blocked, true);
  });

  it('blocks when the echoed sequence does not match the request', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse(200, { sequence: 99, snapshot: tokenFor({}), html: '<p>x</p>' }),
    );
    const controller = createComponentController(baseOptions({ fetch }));
    await assert.rejects(
      controller.commit('a'),
      (error: unknown) =>
        error instanceof ComponentControllerError && error.code === 'sequence_mismatch',
    );
    assert.equal(controller.blocked, true);
  });

  it('never embeds the endpoint, CSRF token, or snapshot in errors', async () => {
    const csrfToken = 'csrf-super-secret-value';
    const token = tokenFor({ title: 'secret-state' });
    const errors: ComponentControllerError[] = [];
    const { fetch } = makeFetch(() =>
      jsonResponse(500, { sequence: 1, error: { code: 'internal_error', message: 'x' } }),
    );
    const controller = createComponentController({
      snapshot: token,
      csrfToken,
      origin: ORIGIN,
      endpoint: '/custom/secret-endpoint',
      fetch,
      onError: (error) => void errors.push(error),
    });

    await assert.rejects(controller.commit('a'));
    assert.equal(errors.length, 1);
    const message = errors[0]!.message;
    assert.equal(message.includes('/custom/secret-endpoint'), false);
    assert.equal(message.includes(csrfToken), false);
    assert.equal(message.includes(token), false);
    assert.equal(message.includes('secret-state'), false);
  });

  it('bounds the queue and rejects excess actions', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const pending = [first, second];
    let index = 0;
    const { fetch, calls } = makeFetch(() => pending[index++]!.promise);
    const controller = createComponentController(baseOptions({ fetch, maxQueue: 1 }));

    const p1 = controller.commit('a');
    const p2 = controller.commit('b');
    await assert.rejects(
      controller.commit('c'),
      (error: unknown) => error instanceof ComponentControllerError && error.code === 'queue_full',
    );
    await flush();
    assert.equal(calls.length, 1);

    first.resolve(successResponse(1, { title: 'hello', count: 0 }));
    await p1;
    await flush();
    assert.equal(calls.length, 2);

    second.resolve(successResponse(2, { title: 'hello', count: 0 }));
    await p2;
  });

  it('dispose aborts in-flight and queued work without stale UI callbacks', async () => {
    const calls: FetchCall[] = [];
    const signals: AbortSignal[] = [];
    const fetch: ComponentFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        calls.push({ url: _url, init, body: JSON.parse(init.body) as Record<string, unknown> });
        signals.push(init.signal);
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const renders: ComponentRender[] = [];
    const errors: ComponentControllerError[] = [];
    const controller = createComponentController(
      baseOptions({
        fetch,
        onRender: (render) => void renders.push(render),
        onError: (error) => void errors.push(error),
      }),
    );

    const p1 = controller.commit('a');
    const p2 = controller.commit('b');
    await flush();
    assert.equal(calls.length, 1);

    controller.dispose();
    await assert.rejects(
      p1,
      (error: unknown) => error instanceof ComponentControllerError && error.code === 'disposed',
    );
    await assert.rejects(
      p2,
      (error: unknown) => error instanceof ComponentControllerError && error.code === 'disposed',
    );
    assert.equal(signals[0]!.aborted, true);

    await flush();
    assert.equal(renders.length, 0);
    assert.equal(errors.length, 0);
    assert.equal(calls.length, 1);

    await assert.rejects(
      controller.commit('c'),
      (error: unknown) => error instanceof ComponentControllerError && error.code === 'disposed',
    );
    controller.dispose(); // idempotent
  });
});
