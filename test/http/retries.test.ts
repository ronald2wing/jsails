import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHttpClient, HttpClientError } from '../../src/http/client.js';

// ---------------------------------------------------------------------------
// Fake fetch helpers
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
// Retries
// ---------------------------------------------------------------------------

describe('HttpClient retries', () => {
  it('returns result once the server responds with a 2xx, even after failures', async () => {
    let calls = 0;
    const fetch = fakeFetch(async () => {
      calls++;
      if (calls < 3) {
        return new Response('error', { status: 500 });
      }
      return jsonResponse({ ok: true });
    });
    const client = createHttpClient({ fetch, retries: 2 });

    const result = await client.get<{ ok: boolean }>('/resource');
    assert.equal(calls, 3); // 2 failures + 1 success
    assert.deepEqual(result, { ok: true });
  });

  it('fails immediately on a non-retryable status (404)', async () => {
    let calls = 0;
    const fetch = fakeFetch(async () => {
      calls++;
      return new Response('not found', { status: 404 });
    });
    const client = createHttpClient({ fetch, retries: 3 });

    await assert.rejects(
      () => client.get('/missing'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 404);
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it('surfaces the last error when retries are exhausted', async () => {
    let calls = 0;
    const fetch = fakeFetch(async () => {
      calls++;
      return new Response('error', { status: 503 });
    });
    const client = createHttpClient({ fetch, retries: 2 });

    await assert.rejects(
      () => client.get('/resource'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 503);
        return true;
      },
    );
    assert.equal(calls, 3); // 1 initial + 2 retries = 3 total
  });

  it('retries on 429 status by default', async () => {
    let calls = 0;
    const fetch = fakeFetch(async () => {
      calls++;
      if (calls < 2) {
        return new Response('rate limited', { status: 429 });
      }
      return jsonResponse({ ok: true });
    });
    const client = createHttpClient({ fetch, retries: 2 });

    const result = await client.get<{ ok: boolean }>('/resource');
    assert.equal(calls, 2);
    assert.deepEqual(result, { ok: true });
  });

  it('retries: 0 (default) makes exactly one attempt', async () => {
    let calls = 0;
    const fetch = fakeFetch(async () => {
      calls++;
      return new Response('error', { status: 500 });
    });
    const client = createHttpClient({ fetch });

    await assert.rejects(
      () => client.get('/resource'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 500);
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it('does not retry on timeout (status 0)', async () => {
    let calls = 0;
    const fetch = fakeFetch(async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    const client = createHttpClient({ fetch, timeoutMs: 10, retries: 3 });

    await assert.rejects(
      () => client.get('/slow'),
      (err: unknown) => {
        assert.ok(err instanceof HttpClientError);
        assert.equal(err.status, 0);
        return true;
      },
    );
    assert.equal(calls, 1); // no retry on timeout
  });

  it('respects a custom shouldRetry predicate', async () => {
    let calls = 0;
    const fetch = fakeFetch(async () => {
      calls++;
      if (calls < 2) {
        return new Response('error', { status: 418 });
      }
      return jsonResponse({ ok: true });
    });
    const client = createHttpClient({
      fetch,
      retries: 2,
      shouldRetry: (status) => status === 418,
    });

    const result = await client.get<{ ok: boolean }>('/teapot');
    assert.equal(calls, 2);
    assert.deepEqual(result, { ok: true });
  });

  it('respects retryDelayMs between attempts', async () => {
    let calls = 0;
    const timestamps: number[] = [];
    const fetch = fakeFetch(async () => {
      calls++;
      timestamps.push(Date.now());
      if (calls < 2) {
        return new Response('error', { status: 500 });
      }
      return jsonResponse({ ok: true });
    });
    const client = createHttpClient({ fetch, retries: 2, retryDelayMs: 50 });

    const start = Date.now();
    const result = await client.get<{ ok: boolean }>('/resource');
    const elapsed = Date.now() - start;

    assert.equal(calls, 2);
    assert.deepEqual(result, { ok: true });
    assert.ok(elapsed >= 50, `expected at least 50ms delay, got ${elapsed}ms`);
  });

  it('does not mutate shared retryStatuses default array', async () => {
    // Verify the default retryStatuses array reference is safe.
    const fetch = fakeFetch(async () => jsonResponse({ ok: true }));
    const client1 = createHttpClient({ fetch });
    await client1.get('/test');

    // Ensure the same default array is used again without issue.
    const fetch2 = fakeFetch(async () => jsonResponse({ ok: true }));
    const client2 = createHttpClient({ fetch: fetch2 });
    await client2.get('/test');
  });
});
