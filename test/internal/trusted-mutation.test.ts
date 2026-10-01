import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from '../../src/contracts/http.js';
import {
  checkTrustedMutation,
  csrfTokenValid,
  isSameOriginRequest,
} from '../../src/internal/trusted-mutation.js';

/**
 * Tests for the trusted-mutation guard. No I/O — same-origin is a pure string
 * comparison and CSRF delegates to the constant-time `safeEqualStrings`.
 */

const SESSION: Session = { id: 'a', csrfToken: 'secret-abc', data: {}, expiresAt: 0 };

function requestWithOrigin(origin: string, url = 'https://app.example.com/foo'): Request {
  return new Request(url, { headers: { origin } });
}

function requestWithoutOrigin(url = 'https://app.example.com/foo'): Request {
  return new Request(url);
}

describe('isSameOriginRequest', () => {
  it('matches when Origin equals the expected origin', () => {
    const req = requestWithOrigin('https://app.example.com');
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), true);
  });

  it('rejects when Origin differs in scheme', () => {
    const req = requestWithOrigin('http://app.example.com');
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), false);
  });

  it('rejects when Origin differs in host', () => {
    const req = requestWithOrigin('https://evil.example.com');
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), false);
  });

  it('rejects when Origin differs in port', () => {
    const req = requestWithOrigin('https://app.example.com:8080');
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), false);
  });

  it('rejects when Origin header is absent', () => {
    const req = requestWithoutOrigin();
    assert.equal(isSameOriginRequest(req, 'https://app.example.com'), false);
  });

  it('falls back to the request URL origin when no expectedOrigin is given', () => {
    const req = requestWithOrigin('https://app.example.com', 'https://app.example.com/page');
    assert.equal(isSameOriginRequest(req), true);
  });

  it('rejects against fallback when Origin differs', () => {
    const req = requestWithOrigin('https://evil.example.com', 'https://app.example.com/page');
    assert.equal(isSameOriginRequest(req), false);
  });
});

describe('csrfTokenValid', () => {
  it('matches when the supplied token equals the session token', () => {
    assert.equal(csrfTokenValid(SESSION, 'secret-abc'), true);
  });

  it('rejects a mismatched token', () => {
    assert.equal(csrfTokenValid(SESSION, 'wrong-token'), false);
  });

  it('rejects an undefined value', () => {
    assert.equal(csrfTokenValid(SESSION, undefined), false);
  });

  it('rejects a null value', () => {
    assert.equal(csrfTokenValid(SESSION, null), false);
  });

  it('rejects an empty string', () => {
    assert.equal(csrfTokenValid(SESSION, ''), false);
  });

  it('rejects a non-string value', () => {
    assert.equal(csrfTokenValid(SESSION, 123), false);
  });
});

describe('checkTrustedMutation', () => {
  it('allows when same-origin and CSRF both pass', () => {
    const req = requestWithOrigin('https://app.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
      csrfValue: SESSION.csrfToken,
    });
    assert.deepEqual(result, { allowed: true });
  });

  it('denies with origin_mismatch when Origin differs', () => {
    const req = requestWithOrigin('https://evil.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
      csrfValue: SESSION.csrfToken,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'origin_mismatch');
    assert.equal(result.status, 403);
    assert.equal(typeof result.message, 'string');
    // The message must not echo the submitted origin.
    assert.equal(result.message.includes('evil.example.com'), false);
  });

  it('denies with csrf_mismatch when CSRF token is wrong', () => {
    const req = requestWithOrigin('https://app.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
      csrfValue: 'wrong-token',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'csrf_mismatch');
    assert.equal(result.status, 403);
    // The message must not echo the submitted token.
    assert.equal(result.message.includes('wrong-token'), false);
  });

  it('allows when session is null (the caller decides anonymous policy)', () => {
    const req = requestWithOrigin('https://evil.example.com');
    const result = checkTrustedMutation(req, null);
    assert.deepEqual(result, { allowed: true });
  });

  it('denies with origin_mismatch when csrfValue is not provided and Origin mismatches', () => {
    const req = requestWithOrigin('https://evil.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'origin_mismatch');
  });

  it('denies with csrf_mismatch when csrfValue is absent but Origin matches', () => {
    const req = requestWithOrigin('https://app.example.com');
    const result = checkTrustedMutation(req, SESSION, {
      expectedOrigin: 'https://app.example.com',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'csrf_mismatch');
  });
});
