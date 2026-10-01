import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OnDemandTlsAllowlistError,
  createOnDemandTlsAllowlist,
} from '../../src/jamal/on-demand-tls.js';

/**
 * Tests for the on-demand TLS allowlist endpoint. The handler is exercised
 * against native `Request` objects (no HTTP server): the kamal-proxy contract
 * (`GET <path>?host=<hostname>` with a matching `Host` header -> 200 only for
 * an allowlisted host), the case-insensitive/trailing-dot matching, the
 * malformed-request and shared-secret rejections, and the construction-time
 * option validation. Every denial is an empty body with no hostname leak.
 */

function request(
  url: string,
  init: { method?: string; host?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.host !== undefined) {
    headers.host = init.host;
  }
  return new Request(url, { method: init.method ?? 'GET', headers });
}

describe('createOnDemandTlsAllowlist: allow/deny', () => {
  const handler = createOnDemandTlsAllowlist({ domains: ['example.com', 'www.example.com'] });

  it('allows an allowlisted hostname with a matching Host header', async () => {
    const response = handler(
      request('https://tls.example.com/check?host=example.com', { host: 'example.com' }),
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });

  it('denies a non-allowlisted hostname', async () => {
    const response = handler(
      request('https://tls.example.com/check?host=evil.com', { host: 'evil.com' }),
    );
    assert.equal(response.status, 403);
    assert.equal(await response.text(), '');
  });

  it('matches case-insensitively and tolerates a trailing dot on both sides', () => {
    const domains = createOnDemandTlsAllowlist({ domains: ['example.com'] });
    assert.equal(
      domains(request('https://tls.example.com/check?host=EXAMPLE.COM.', { host: 'Example.Com.' }))
        .status,
      200,
    );
  });

  it('denies when the Host header does not match the hostname', () => {
    assert.equal(
      handler(
        request('https://tls.example.com/check?host=example.com', { host: 'other.example.com' }),
      ).status,
      403,
    );
  });

  it('denies when the Host header is absent', () => {
    assert.equal(handler(request('https://tls.example.com/check?host=example.com')).status, 403);
  });

  it('grants via the allow callback only on exactly true', () => {
    const withAllow = createOnDemandTlsAllowlist({
      domains: [],
      allow: (hostname) => hostname === 'dynamic.example.com',
    });
    assert.equal(
      withAllow(
        request('https://tls.example.com/check?host=dynamic.example.com', {
          host: 'dynamic.example.com',
        }),
      ).status,
      200,
    );
    assert.equal(
      withAllow(
        request('https://tls.example.com/check?host=other.example.com', {
          host: 'other.example.com',
        }),
      ).status,
      403,
    );
  });

  it('passes the normalized hostname to the allow callback', () => {
    const seen: string[] = [];
    const withAllow = createOnDemandTlsAllowlist({
      domains: [],
      allow: (h) => (seen.push(h), false),
    });
    withAllow(request('https://tls.example.com/check?host=EXAMPLE.COM.', { host: 'Example.Com.' }));
    assert.deepEqual(seen, ['example.com']);
  });
});

describe('createOnDemandTlsAllowlist: malformed requests', () => {
  const handler = createOnDemandTlsAllowlist({ domains: ['example.com'] });

  it('rejects a non-GET method', () => {
    assert.equal(
      handler(
        request('https://tls.example.com/check?host=example.com', {
          method: 'POST',
          host: 'example.com',
        }),
      ).status,
      405,
    );
  });

  it('rejects a missing, empty, or repeated host parameter', () => {
    assert.equal(handler(request('https://tls.example.com/check')).status, 400);
    assert.equal(handler(request('https://tls.example.com/check?host=')).status, 400);
    assert.equal(
      handler(
        request('https://tls.example.com/check?host=a.example.com&host=b.example.com', {
          host: 'a.example.com',
        }),
      ).status,
      400,
    );
  });

  it('rejects a malformed hostname without leaking it', async () => {
    for (const bad of ['has space', 'https://example.com', 'example.com/path', '* .example.com']) {
      const response = handler(
        request(`https://tls.example.com/check?host=${encodeURIComponent(bad)}`),
      );
      assert.equal(response.status, 400);
      assert.equal(await response.text(), '');
    }
  });
});

describe('createOnDemandTlsAllowlist: shared secret', () => {
  const handler = createOnDemandTlsAllowlist({
    domains: ['example.com'],
    headerName: 'x-tls-secret',
    secret: 's3cret-value',
  });

  it('allows an allowlisted host when the secret matches', () => {
    assert.equal(
      handler(
        request('https://tls.example.com/check?host=example.com', {
          host: 'example.com',
          headers: { 'x-tls-secret': 's3cret-value' },
        }),
      ).status,
      200,
    );
  });

  it('denies when the secret header is missing or wrong', () => {
    assert.equal(
      handler(request('https://tls.example.com/check?host=example.com', { host: 'example.com' }))
        .status,
      403,
    );
    assert.equal(
      handler(
        request('https://tls.example.com/check?host=example.com', {
          host: 'example.com',
          headers: { 'x-tls-secret': 'wrong' },
        }),
      ).status,
      403,
    );
  });
});

describe('createOnDemandTlsAllowlist: construction validation', () => {
  it('rejects a non-object options value', () => {
    assert.throws(() => createOnDemandTlsAllowlist(null as never), OnDemandTlsAllowlistError);
    assert.throws(() => createOnDemandTlsAllowlist([] as never), OnDemandTlsAllowlistError);
  });

  it('rejects a non-array domains field', () => {
    assert.throws(
      () => createOnDemandTlsAllowlist({ domains: 'example.com' as never }),
      OnDemandTlsAllowlistError,
    );
  });

  it('rejects non-string or invalid domain entries, value-free', () => {
    assert.throws(
      () => createOnDemandTlsAllowlist({ domains: [42 as never] }),
      OnDemandTlsAllowlistError,
    );
    assert.throws(() => createOnDemandTlsAllowlist({ domains: [''] }), OnDemandTlsAllowlistError);
    for (const bad of ['has space', '*.example.com', 'https://example.com', '.example.com']) {
      assert.throws(
        () => createOnDemandTlsAllowlist({ domains: [bad] }),
        (error: unknown) => {
          assert.ok(error instanceof OnDemandTlsAllowlistError);
          assert.ok(!error.message.includes(bad), `${JSON.stringify(bad)} must not leak`);
          return true;
        },
      );
    }
  });

  it('rejects a non-function allow', () => {
    assert.throws(
      () => createOnDemandTlsAllowlist({ domains: [], allow: 'yes' as never }),
      OnDemandTlsAllowlistError,
    );
  });

  it('requires a secret when headerName is set and vice versa', () => {
    assert.throws(
      () => createOnDemandTlsAllowlist({ domains: [], headerName: 'x-secret' }),
      OnDemandTlsAllowlistError,
    );
    assert.throws(
      () => createOnDemandTlsAllowlist({ domains: [], headerName: '' }),
      OnDemandTlsAllowlistError,
    );
    assert.throws(
      () => createOnDemandTlsAllowlist({ domains: [], secret: 's3cret' }),
      OnDemandTlsAllowlistError,
    );
  });
});
