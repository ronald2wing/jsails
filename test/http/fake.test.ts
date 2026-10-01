import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeHttp } from '../../src/http/fake.js';
import { HttpClientError } from '../../src/http/client.js';

// ---------------------------------------------------------------------------
// createFakeHttp
// ---------------------------------------------------------------------------

describe('createFakeHttp', () => {
  it('returns an object with get/post/put/patch/delete and respond', () => {
    const fake = createFakeHttp();
    assert.equal(typeof fake.get, 'function');
    assert.equal(typeof fake.post, 'function');
    assert.equal(typeof fake.put, 'function');
    assert.equal(typeof fake.patch, 'function');
    assert.equal(typeof fake.delete, 'function');
    assert.equal(typeof fake.respond, 'function');
  });
});

// ---------------------------------------------------------------------------
// respond — round-trip
// ---------------------------------------------------------------------------

describe('fakeHttp respond', () => {
  it('round-trips a GET response through the handler', async () => {
    const fake = createFakeHttp();
    fake.respond(({ method, path }) => {
      assert.equal(method, 'GET');
      assert.equal(path, '/users/1');
      return { status: 200, body: { id: 1, name: 'Alice' } };
    });

    const user = await fake.get<{ id: number; name: string }>('/users/1');
    assert.deepEqual(user, { id: 1, name: 'Alice' });
  });

  it('round-trips a POST with a body', async () => {
    const fake = createFakeHttp();
    fake.respond(({ method, path, body }) => {
      assert.equal(method, 'POST');
      assert.equal(path, '/users');
      assert.deepEqual(body, { name: 'Bob' });
      return { status: 201, body: { id: 2 } };
    });

    const result = await fake.post<{ id: number }>('/users', { name: 'Bob' });
    assert.deepEqual(result, { id: 2 });
  });

  it('round-trips a PUT with a body', async () => {
    const fake = createFakeHttp();
    fake.respond(() => ({ status: 200, body: { updated: true } }));

    const result = await fake.put<{ updated: boolean }>('/items/1', { x: 1 });
    assert.deepEqual(result, { updated: true });
  });

  it('round-trips a PATCH with a body', async () => {
    const fake = createFakeHttp();
    fake.respond(() => ({ status: 200, body: { patched: true } }));

    const result = await fake.patch<{ patched: boolean }>('/items/1', { x: 1 });
    assert.deepEqual(result, { patched: true });
  });

  it('round-trips a DELETE', async () => {
    const fake = createFakeHttp();
    fake.respond(({ method }) => {
      assert.equal(method, 'DELETE');
      return { status: 204 };
    });

    const result = await fake.delete('/items/1');
    // 204 with no body → undefined
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// respond — handler replacement
// ---------------------------------------------------------------------------

describe('fakeHttp handler replacement', () => {
  it('replaces the handler on a second respond call', async () => {
    const fake = createFakeHttp();
    fake.respond(() => ({ status: 200, body: { v: 1 } }));
    const first = await fake.get<{ v: number }>('/a');
    assert.deepEqual(first, { v: 1 });

    fake.respond(() => ({ status: 200, body: { v: 2 } }));
    const second = await fake.get<{ v: number }>('/a');
    assert.deepEqual(second, { v: 2 });
  });
});

// ---------------------------------------------------------------------------
// respond — async handler
// ---------------------------------------------------------------------------

describe('fakeHttp async handler', () => {
  it('awaits a Promise-returning handler', async () => {
    const fake = createFakeHttp();
    fake.respond(async ({ path }) => {
      if (path === '/async') {
        return { status: 200, body: { async: true } };
      }
      return { status: 404 };
    });

    const result = await fake.get<{ async: boolean }>('/async');
    assert.deepEqual(result, { async: true });
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('fakeHttp error paths', () => {
  it('throws HttpClientError when no handler is configured', async () => {
    const fake = createFakeHttp();
    await assert.rejects(
      () => fake.get('/anything'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 0);
        return true;
      },
    );
  });

  it('throws HttpClientError for a non-2xx handler response', async () => {
    const fake = createFakeHttp();
    fake.respond(() => ({ status: 404 }));

    await assert.rejects(
      () => fake.get('/missing'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 404);
        assert.ok(err.message.includes('404'));
        assert.ok(!err.message.includes('missing'), 'message must not echo the path');
        return true;
      },
    );
  });

  it('throws HttpClientError for a 500 handler response', async () => {
    const fake = createFakeHttp();
    fake.respond(() => ({ status: 500 }));

    await assert.rejects(
      () => fake.get('/break'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 500);
        return true;
      },
    );
  });

  it('throws HttpClientError when the handler itself throws', async () => {
    const fake = createFakeHttp();
    fake.respond(() => {
      throw new Error('handler crashed');
    });

    await assert.rejects(
      () => fake.get('/crash'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 0);
        return true;
      },
    );
  });

  it('error message never echoes the path', async () => {
    const fake = createFakeHttp();
    fake.respond(() => ({ status: 403 }));

    await assert.rejects(
      () => fake.get('/admin/secret'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes('secret'), 'error message must not echo the path');
        return true;
      },
    );
  });

  it('does not echo the request body on error', async () => {
    const fake = createFakeHttp();
    fake.respond(() => ({ status: 400 }));

    await assert.rejects(
      () => fake.post('/submit', { password: 'secret' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes('secret'), 'error message must not echo the body');
        return true;
      },
    );
  });
});
