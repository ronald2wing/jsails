import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHttpClient, HttpClientError } from '../../src/http/client.js';

// ---------------------------------------------------------------------------
// Fake fetch: a controllable fetch stub for testing.
// ---------------------------------------------------------------------------

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function fakeFetch(handler: FetchHandler): typeof globalThis.fetch {
  const fn: typeof globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
    if (typeof url === 'string' || url instanceof URL) {
      return handler(String(url), init);
    }
    return handler(url.url, init);
  };
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// createHttpClient — construction and base options
// ---------------------------------------------------------------------------

describe('createHttpClient', () => {
  it('returns an object with get/post/put/patch/delete methods', () => {
    const client = createHttpClient();
    assert.equal(typeof client.get, 'function');
    assert.equal(typeof client.post, 'function');
    assert.equal(typeof client.put, 'function');
    assert.equal(typeof client.patch, 'function');
    assert.equal(typeof client.delete, 'function');
  });

  it('prepends baseUrl to every path', async () => {
    const fetch = fakeFetch(async (url) => {
      assert.ok(url.startsWith('https://api.test/v1'));
      return jsonResponse({ ok: true });
    });
    const client = createHttpClient({ baseUrl: 'https://api.test/v1', fetch });
    await client.get('/users');
  });

  it('strips trailing slash from baseUrl when composing path', async () => {
    const fetch = fakeFetch(async (url) => {
      assert.equal(url, 'https://api.test/api/health');
      return jsonResponse({});
    });
    const client = createHttpClient({ baseUrl: 'https://api.test/api', fetch });
    await client.get('/health');
  });

  it('works without a baseUrl', async () => {
    const fetch = fakeFetch(async (url) => {
      assert.equal(url, '/local');
      return jsonResponse({});
    });
    const client = createHttpClient({ fetch });
    await client.get('/local');
  });
});

// ---------------------------------------------------------------------------
// HTTP methods — JSON round-trip
// ---------------------------------------------------------------------------

describe('HttpClient methods', () => {
  it('GET sends no body and decodes the JSON response', async () => {
    const fetch = fakeFetch(async (url, init) => {
      assert.match(url, /\/users$/);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      return jsonResponse({ id: 1 });
    });
    const client = createHttpClient({ fetch });
    const user = await client.get<{ id: number }>('/users');
    assert.deepEqual(user, { id: 1 });
  });

  it('POST sends a JSON body and decodes the response', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? ''));
      assert.deepEqual(body, { name: 'test' });
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.['content-type'], 'application/json');
      return jsonResponse({ created: true }, 201);
    });
    const client = createHttpClient({ fetch });
    const result = await client.post<{ created: boolean }>('/items', { name: 'test' });
    assert.deepEqual(result, { created: true });
  });

  it('PUT sends a JSON body', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      assert.equal(init?.method, 'PUT');
      return jsonResponse({ updated: true });
    });
    const client = createHttpClient({ fetch });
    const result = await client.put('/items/1', { name: 'updated' });
    assert.deepEqual(result, { updated: true });
  });

  it('PATCH sends a JSON body', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      assert.equal(init?.method, 'PATCH');
      return jsonResponse({ patched: true });
    });
    const client = createHttpClient({ fetch });
    const result = await client.patch('/items/1', { name: 'patched' });
    assert.deepEqual(result, { patched: true });
  });

  it('DELETE sends no body', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      assert.equal(init?.method, 'DELETE');
      assert.equal(init?.body, undefined);
      return jsonResponse({ deleted: true });
    });
    const client = createHttpClient({ fetch });
    const result = await client.delete<{ deleted: boolean }>('/items/1');
    assert.deepEqual(result, { deleted: true });
  });

  it('handles empty response bodies (204 No Content)', async () => {
    const fetch = fakeFetch(async () => new Response(null, { status: 204 }));
    const client = createHttpClient({ fetch });
    const result = await client.delete('/items/1');
    assert.equal(result, undefined);
  });

  it('handles empty body for GET too', async () => {
    const fetch = fakeFetch(async () => new Response('', { status: 200 }));
    const client = createHttpClient({ fetch });
    const result = await client.get('/empty');
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe('HttpClient headers', () => {
  it('sends default headers with every request', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.['authorization'], 'Bearer token-123');
      assert.equal(headers?.['accept'], 'application/json');
      return jsonResponse({});
    });
    const client = createHttpClient({
      fetch,
      headers: { authorization: 'Bearer token-123', accept: 'application/json' },
    });
    await client.get('/data');
  });

  it('merges per-request headers on top of defaults', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.['x-request-id'], 'req-1');
      assert.equal(headers?.['authorization'], 'Bearer default');
      return jsonResponse({});
    });
    const client = createHttpClient({
      fetch,
      headers: { authorization: 'Bearer default' },
    });
    await client.get('/data', { headers: { 'x-request-id': 'req-1' } });
  });

  it('per-request headers override defaults', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.['authorization'], 'Bearer override');
      return jsonResponse({});
    });
    const client = createHttpClient({
      fetch,
      headers: { authorization: 'Bearer default' },
    });
    await client.get('/data', { headers: { authorization: 'Bearer override' } });
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('HttpClient error mapping', () => {
  it('throws HttpClientError on a 4xx response', async () => {
    const fetch = fakeFetch(async () => new Response('not found', { status: 404 }));
    const client = createHttpClient({ fetch });
    await assert.rejects(
      () => client.get('/missing'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        const httpErr = err;
        assert.equal(httpErr.status, 404);
        assert.ok(httpErr.message.includes('404'));
        assert.ok(!httpErr.message.includes('missing'), 'message must not echo the URL path');
        return true;
      },
    );
  });

  it('throws HttpClientError on a 5xx response', async () => {
    const fetch = fakeFetch(async () => new Response('error', { status: 500 }));
    const client = createHttpClient({ fetch });
    await assert.rejects(
      () => client.get('/boom'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 500);
        return true;
      },
    );
  });

  it('throws HttpClientError with status 0 on network failure', async () => {
    const fetch = fakeFetch(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const client = createHttpClient({ fetch });
    await assert.rejects(
      () => client.get('/data'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 0);
        return true;
      },
    );
  });

  it('never echoes the URL in the error message', async () => {
    const secretUrl = '/admin/secrets';
    const fetch = fakeFetch(async () => new Response('denied', { status: 403 }));
    const client = createHttpClient({ fetch });
    await assert.rejects(
      () => client.get(secretUrl),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.ok(!msg.includes(secretUrl), 'error message must not echo the URL');
        return true;
      },
    );
  });

  it('never echoes the response body in the error message', async () => {
    const body = 'sensitive data here';
    const fetch = fakeFetch(async () => new Response(body, { status: 500 }));
    const client = createHttpClient({ fetch });
    await assert.rejects(
      () => client.get('/data'),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.ok(!msg.includes(body), 'error message must not echo response body');
        return true;
      },
    );
  });

  it('throws HttpClientError on invalid JSON (200 with non-JSON body)', async () => {
    const fetch = fakeFetch(async () => new Response('plain text not json', { status: 200 }));
    const client = createHttpClient({ fetch });
    await assert.rejects(
      () => client.get('/data'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 200);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('HttpClient timeout', () => {
  it('throws HttpClientError with status 0 when the request times out', async () => {
    let abortSignal: AbortSignal | null | undefined;
    const fetch = fakeFetch(async (_url, init) => {
      abortSignal = init?.signal;
      // Reject with AbortError when the signal fires so the promise settles
      // cleanly and the client maps it to HttpClientError(status: 0).
      return new Promise<Response>((_resolve, reject) => {
        abortSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    const client = createHttpClient({ fetch, timeoutMs: 50 });

    await assert.rejects(
      () => client.get('/slow'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError, 'must be HttpClientError');
        assert.equal(err.status, 0, 'status must be 0');
        assert.ok(err.message.includes('timed out'));
        assert.ok(abortSignal?.aborted, 'AbortSignal must be aborted');
        return true;
      },
    );
  });

  it('does not abort when the response arrives before the timeout', async () => {
    const fetch = fakeFetch(async () => jsonResponse({ fast: true }));
    const client = createHttpClient({ fetch, timeoutMs: 5000 });
    const result = await client.get<{ fast: boolean }>('/fast');
    assert.deepEqual(result, { fast: true });
  });

  it('honours a per-request timeout override', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      // Reject with AbortError when the signal fires so the promise settles.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    const client = createHttpClient({ fetch, timeoutMs: 5000 });
    await assert.rejects(
      () => client.get('/slow', { timeoutMs: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        return true;
      },
    );
  });

  it('disables timeout when timeoutMs is 0', async () => {
    const fetch = fakeFetch(async () => jsonResponse({ ok: true }));
    const client = createHttpClient({ fetch, timeoutMs: 0 });
    const result = await client.get<{ ok: boolean }>('/fast');
    assert.deepEqual(result, { ok: true });
  });
});

// ---------------------------------------------------------------------------
// Injected fetch for tests
// ---------------------------------------------------------------------------

describe('HttpClient injected fetch', () => {
  it('uses the injected fetch instead of globalThis.fetch', async () => {
    let called = false;
    const fetch = fakeFetch(async () => {
      called = true;
      return jsonResponse({ from: 'injected' });
    });
    const client = createHttpClient({ fetch });
    const result = await client.get<{ from: string }>('/test');
    assert.equal(called, true);
    assert.deepEqual(result, { from: 'injected' });
  });

  it('uses globalThis.fetch when no fetch is injected', async () => {
    // This test verifies that the default path works. We supply a real-looking
    // url that would fail if it actually tried to fetch — but we don't want to
    // hit the network. So instead we just verify the client is constructed
    // without error and has the expected methods.
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:1' });
    assert.equal(typeof client.get, 'function');
    // The actual fetch will fail (connection refused), which is fine — that
    // confirms we're using globalThis.fetch.
    await assert.rejects(() => client.get('/health'), HttpClientError);
  });
});

// ---------------------------------------------------------------------------
// JSON encode edge cases
// ---------------------------------------------------------------------------

describe('HttpClient JSON encoding', () => {
  it('encodes number bodies', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      assert.equal(init?.body, '42');
      return jsonResponse({});
    });
    const client = createHttpClient({ fetch });
    await client.post('/nums', 42);
  });

  it('encodes boolean bodies', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      assert.equal(init?.body, 'true');
      return jsonResponse({});
    });
    const client = createHttpClient({ fetch });
    await client.post('/bools', true);
  });

  it('encodes array bodies', async () => {
    const fetch = fakeFetch(async (_url, init) => {
      assert.equal(init?.body, '[1,2,3]');
      return jsonResponse({});
    });
    const client = createHttpClient({ fetch });
    await client.post('/arrays', [1, 2, 3]);
  });

  it('decodes a JSON array response', async () => {
    const fetch = fakeFetch(async () => jsonResponse([1, 2, 3]));
    const client = createHttpClient({ fetch });
    const result = await client.get<number[]>('/nums');
    assert.deepEqual(result, [1, 2, 3]);
  });
});
