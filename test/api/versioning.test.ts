import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveApiVersion,
  versionedNotFound,
  versionedNotAcceptable,
} from '../../src/api/versioning.js';
import type { VersionResult, VersionOk, VersionFailure } from '../../src/api/versioning.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(version: string): VersionOk {
  return { ok: true, version };
}

function error(code: VersionFailure['code']): VersionFailure {
  return { ok: false, code };
}

// ---------------------------------------------------------------------------
// Tests — resolveApiVersion
// ---------------------------------------------------------------------------

describe('resolveApiVersion', () => {
  // --- Validation ---

  it('returns invalid_versions when versions array is empty', () => {
    const result: VersionResult = resolveApiVersion({
      versions: [],
      default: '1',
    });
    assert.deepEqual(result, error('invalid_versions'));
  });

  it('returns invalid_versions when default is not in versions', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '3',
    });
    assert.deepEqual(result, error('invalid_versions'));
  });

  it('returns invalid_versions when a version is empty string', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', ''],
      default: '1',
    });
    assert.deepEqual(result, error('invalid_versions'));
  });

  it('returns invalid_versions when a version is not a string', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', 2 as unknown as string],
      default: '1',
    });
    assert.deepEqual(result, error('invalid_versions'));
  });

  // --- URL prefix resolution (highest precedence) ---

  it('resolves version from URL prefix /v2/path', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      url: '/v2/users',
    });
    assert.deepEqual(result, ok('2'));
  });

  it('resolves URL version even when Accept header also signals a different version', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2', '3'],
      default: '1',
      url: '/v2/users',
      headers: { accept: 'application/vnd.jsails.v3+json' },
    });
    assert.deepEqual(result, ok('2'));
  });

  it('returns unknown_version for a URL version not in the list', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      url: '/v99/users',
    });
    assert.deepEqual(result, error('unknown_version'));
  });

  it('returns unknown_version for a URL version not in list (value-free — no version echoed)', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      url: '/v99/x',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'unknown_version');
    }
  });

  it('skips URL matching when url is undefined', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      headers: { accept: 'application/vnd.jsails.v2+json' },
    });
    assert.deepEqual(result, ok('2'));
  });

  it('falls through URL when path has no /vN/ prefix', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '2',
      url: '/api/users',
    });
    assert.deepEqual(result, ok('2'));
  });

  it('does not match a bare /v1 without a following slash', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '2',
      url: '/v1',
    });
    assert.deepEqual(result, ok('2'));
  });

  it('matches a version segment with numbers and letters', () => {
    // The URL prefix /v2.beta/ extracts "2.beta" (without the leading "v"
    // that is part of the URL convention, not the version string itself).
    const result: VersionResult = resolveApiVersion({
      versions: ['1.2', '2.beta'],
      default: '1.2',
      url: '/v2.beta/users',
    });
    assert.deepEqual(result, ok('2.beta'));
  });

  // --- Accept header resolution ---

  it('resolves version from Accept vendor media type', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      headers: { accept: 'application/vnd.jsails.v2+json' },
    });
    assert.deepEqual(result, ok('2'));
  });

  it('handles Accept with quality parameter', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      headers: { accept: 'application/vnd.jsails.v2+json;q=0.9' },
    });
    assert.deepEqual(result, ok('2'));
  });

  it('handles Accept with whitespace before semicolon', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      headers: { accept: 'application/vnd.jsails.v2+json; q=0.9' },
    });
    assert.deepEqual(result, ok('2'));
  });

  it('returns unknown_version for an Accept version not in the list', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      headers: { accept: 'application/vnd.jsails.v99+json' },
    });
    assert.deepEqual(result, error('unknown_version'));
  });

  it('silently skips a non-matching Accept media type', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      headers: { accept: 'application/json' },
    });
    assert.deepEqual(result, ok('1'));
  });

  it('handles Accept header with case-insensitive key lookup', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      headers: { ACCEPT: 'application/vnd.jsails.v2+json' },
    });
    assert.deepEqual(result, ok('2'));
  });

  it('trims whitespace from Accept header value', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      headers: { accept: '  application/vnd.jsails.v2+json  ' },
    });
    assert.deepEqual(result, ok('2'));
  });

  it('handles empty Accept header as absent (falls to default)', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      headers: { accept: '' },
    });
    assert.deepEqual(result, ok('1'));
  });

  // --- Default ---

  it('returns default version when no signal is present', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '2',
    });
    assert.deepEqual(result, ok('2'));
  });

  it('returns default when headers is undefined', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '1',
      url: '/api/users',
    });
    assert.deepEqual(result, ok('1'));
  });

  it('returns default when both url and headers are undefined', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2'],
      default: '2',
    });
    assert.deepEqual(result, ok('2'));
  });

  // --- Header key resolution (non-standard keys) ---

  it('matches Accept from a header record with mixed case keys', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '3'],
      default: '1',
      headers: { 'Content-Type': 'application/json', AcCePt: 'application/vnd.jsails.v3+json' },
    });
    assert.deepEqual(result, ok('3'));
  });

  it('finds Accept when it is the only header key', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '5'],
      default: '1',
      headers: { accept: 'application/vnd.jsails.v5+json' },
    });
    assert.deepEqual(result, ok('5'));
  });

  // --- Edge cases ---

  it('handles a single-version list', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1'],
      default: '1',
      url: '/v1/users',
    });
    assert.deepEqual(result, ok('1'));
  });

  it('returns unknown_version when the single version does not match URL', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1'],
      default: '1',
      url: '/v2/users',
    });
    assert.deepEqual(result, error('unknown_version'));
  });

  it('handles numeric version strings', () => {
    const result: VersionResult = resolveApiVersion({
      versions: ['1', '2', '3'],
      default: '2',
      url: '/v3/items',
    });
    assert.deepEqual(result, ok('3'));
  });

  it('handles semver-like version strings', () => {
    // URL prefix /v2.0-beta/ extracts "2.0-beta" without the leading "v".
    const result: VersionResult = resolveApiVersion({
      versions: ['1.0', '2.0-beta'],
      default: '1.0',
      url: '/v2.0-beta/items',
    });
    assert.deepEqual(result, ok('2.0-beta'));
  });
});

// ---------------------------------------------------------------------------
// Tests — response helpers
// ---------------------------------------------------------------------------

describe('versionedNotFound', () => {
  it('returns a 404 Response with no body', async () => {
    const response = versionedNotFound();
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), null);
    assert.equal(await response.text(), '');
  });
});

describe('versionedNotAcceptable', () => {
  it('returns a 406 Response with no body', async () => {
    const response = versionedNotAcceptable();
    assert.equal(response.status, 406);
    assert.equal(response.headers.get('content-type'), null);
    assert.equal(await response.text(), '');
  });
});
