import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachNoStore,
  badRequestResponse,
  forbiddenResponse,
  notFoundResponse,
} from '../../src/internal/responses.js';

/**
 * Tests for the value-free response factories. Every body must be a stable,
 * hardcoded string — no input is ever echoed.
 */

describe('forbiddenResponse', () => {
  it('returns status 403 with a value-free text/plain body', async () => {
    const res = forbiddenResponse();
    assert.equal(res.status, 403);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const text = await res.text();
    assert.equal(text, 'Forbidden');
  });
});

describe('badRequestResponse', () => {
  it('returns status 400 with a value-free text/plain body', async () => {
    const res = badRequestResponse();
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const text = await res.text();
    assert.equal(text, 'Bad Request');
  });
});

describe('notFoundResponse', () => {
  it('returns status 404 with a value-free text/plain body', async () => {
    const res = notFoundResponse();
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const text = await res.text();
    assert.equal(text, 'Not Found');
  });
});

describe('attachNoStore', () => {
  it('adds cache-control: no-store to a plain response', () => {
    const original = new Response('OK', { status: 200, headers: { 'x-custom': 'abc' } });
    const wrapped = attachNoStore(original);
    assert.equal(wrapped.status, 200);
    assert.equal(wrapped.headers.get('cache-control'), 'no-store');
    assert.equal(wrapped.headers.get('x-custom'), 'abc');
  });

  it('overwrites an existing cache-control header', () => {
    const original = new Response('OK', { status: 200, headers: { 'cache-control': 'public' } });
    const wrapped = attachNoStore(original);
    assert.equal(wrapped.headers.get('cache-control'), 'no-store');
  });

  it('preserves the response body', async () => {
    const original = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const wrapped = attachNoStore(original);
    const text = await wrapped.text();
    assert.equal(text, '{"ok":true}');
    assert.equal(wrapped.headers.get('content-type'), 'application/json');
  });

  it('returns a new Response without mutating the original', () => {
    const original = new Response('OK', { status: 200 });
    attachNoStore(original);
    // Original must be unchanged.
    assert.equal(original.headers.has('cache-control'), false);
  });
});
