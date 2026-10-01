import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isValidSemverRange,
  isValidSemverVersion,
  parsePluginManifest,
  parseSemver,
  PluginManifestError,
  satisfiesRange,
} from '../../src/plugins/manifest.js';

/** A minimal valid manifest fixture. */
function validManifest(): Record<string, unknown> {
  return {
    id: 'acme-tasks',
    version: '1.2.3',
    jsailsCompat: '^0.1.0',
    entry: './index.js',
  };
}

describe('parsePluginManifest', () => {
  it('parses a valid manifest and defaults permissions to []', () => {
    const manifest = parsePluginManifest(validManifest());
    assert.equal(manifest.id, 'acme-tasks');
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.jsailsCompat, '^0.1.0');
    assert.deepEqual(manifest.permissions, []);
    assert.equal(manifest.entry, './index.js');
  });

  it('carries optional fields through verbatim', () => {
    const manifest = parsePluginManifest({
      ...validManifest(),
      permissions: ['db.read', 'http.fetch'],
      settingsSchema: { retries: { type: 'integer' } },
      checksums: { 'dist/index.js': 'sha256-deadbeef' },
      signature: 'sig',
    });
    assert.deepEqual(manifest.permissions, ['db.read', 'http.fetch']);
    assert.deepEqual(manifest.settingsSchema, { retries: { type: 'integer' } });
    assert.deepEqual(manifest.checksums, {
      'dist/index.js': 'sha256-deadbeef',
    });
    assert.equal(manifest.signature, 'sig');
  });

  it('accepts a valid plugins array with multiple entries', () => {
    const manifest = parsePluginManifest({
      ...validManifest(),
      plugins: [
        { id: 'acme-core', range: '^1.0.0' },
        { id: 'acme-utils', range: '>=2.0.0 <3.0.0' },
      ],
    });
    assert.deepEqual(manifest.plugins, [
      { id: 'acme-core', range: '^1.0.0' },
      { id: 'acme-utils', range: '>=2.0.0 <3.0.0' },
    ]);
  });

  it('defaults plugins to [] when omitted', () => {
    const manifest = parsePluginManifest(validManifest());
    assert.deepEqual(manifest.plugins, []);
  });

  it('rejects a plugins entry with an invalid id', () => {
    assert.throws(
      () =>
        parsePluginManifest({
          ...validManifest(),
          plugins: [{ id: 'Bad Id!', range: '^1.0.0' }],
        }),
      (error: unknown) =>
        error instanceof PluginManifestError &&
        error.issues.some(
          (i) => i.code === 'invalid_format' && i.path.join('.') === 'plugins.0.id',
        ),
    );
  });

  it('rejects a plugins entry with an invalid range', () => {
    assert.throws(
      () =>
        parsePluginManifest({
          ...validManifest(),
          plugins: [{ id: 'acme-core', range: 'not-a-range' }],
        }),
      (error: unknown) =>
        error instanceof PluginManifestError &&
        error.issues.some(
          (i) => i.code === 'invalid_range' && i.path.join('.') === 'plugins.0.range',
        ),
    );
  });

  it('rejects duplicate plugins ids', () => {
    assert.throws(
      () =>
        parsePluginManifest({
          ...validManifest(),
          plugins: [
            { id: 'acme-core', range: '^1.0.0' },
            { id: 'acme-core', range: '^2.0.0' },
          ],
        }),
      (error: unknown) =>
        error instanceof PluginManifestError &&
        error.issues.some((i) => i.code === 'duplicate_id' && i.path.join('.') === 'plugins.1.id'),
    );
  });

  it('still validates existing fields alongside plugins', () => {
    const manifest = parsePluginManifest({
      ...validManifest(),
      permissions: ['db.read'],
      entry: './main.js',
      plugins: [{ id: 'acme-core', range: '^1.0.0' }],
    });
    assert.equal(manifest.id, 'acme-tasks');
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.jsailsCompat, '^0.1.0');
    assert.deepEqual(manifest.permissions, ['db.read']);
    assert.equal(manifest.entry, './main.js');
    assert.deepEqual(manifest.plugins, [{ id: 'acme-core', range: '^1.0.0' }]);
  });

  it('rejects a missing id with a value-free issue', () => {
    const raw = { ...validManifest(), id: undefined };
    assert.throws(
      () => parsePluginManifest(raw),
      (error: unknown) => {
        assert.ok(error instanceof PluginManifestError);
        const issue = error.issues.find((i) => i.path.join('.') === 'id');
        assert.ok(issue);
        return true;
      },
    );
  });

  it('rejects an id that does not match the pattern', () => {
    assert.throws(
      () => parsePluginManifest({ ...validManifest(), id: 'Bad Name!' }),
      (error: unknown) =>
        error instanceof PluginManifestError &&
        error.issues.some((i) => i.code === 'invalid_format' && i.path.join('.') === 'id'),
    );
  });

  it('rejects a version that is not valid semver', () => {
    assert.throws(
      () => parsePluginManifest({ ...validManifest(), version: 'one-point-oh' }),
      (error: unknown) =>
        error instanceof PluginManifestError &&
        error.issues.some((i) => i.code === 'invalid_version'),
    );
  });

  it('rejects a jsailsCompat that is not a valid range', () => {
    assert.throws(
      () =>
        parsePluginManifest({
          ...validManifest(),
          jsailsCompat: 'not-a-range',
        }),
      (error: unknown) =>
        error instanceof PluginManifestError &&
        error.issues.some((i) => i.code === 'invalid_range'),
    );
  });

  it('rejects unknown fields (strict schema)', () => {
    assert.throws(
      () => parsePluginManifest({ ...validManifest(), typo: true }),
      (error: unknown) =>
        error instanceof PluginManifestError &&
        error.issues.some((i) => i.code === 'unrecognized_keys'),
    );
  });

  it('rejects a non-array permissions field', () => {
    assert.throws(
      () => parsePluginManifest({ ...validManifest(), permissions: 'everything' }),
      (error: unknown) => error instanceof PluginManifestError,
    );
  });

  it('never echoes raw input values in its message', () => {
    try {
      parsePluginManifest({
        id: 'SECRET-CREDENTIAL',
        version: 'password123',
        jsailsCompat: 'supersecret',
        entry: '',
      });
      assert.fail('expected a PluginManifestError');
    } catch (error) {
      assert.ok(error instanceof PluginManifestError);
      const message = error.message;
      assert.ok(!message.includes('SECRET-CREDENTIAL'), message);
      assert.ok(!message.includes('password123'), message);
      assert.ok(!message.includes('supersecret'), message);
    }
  });
});

describe('semver helpers', () => {
  it('parses a full version into components', () => {
    assert.deepEqual(parseSemver('1.2.3'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    assert.deepEqual(parseSemver('0.10.0-beta.1'), {
      major: 0,
      minor: 10,
      patch: 0,
      prerelease: ['beta', '1'],
    });
    assert.deepEqual(parseSemver('1.2.3+build.7'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it('rejects malformed versions', () => {
    for (const bad of ['', '1', '1.2', 'v1.2.3', '01.2.3', '1.2.3.4', '1.2.3-']) {
      assert.equal(parseSemver(bad), null, bad);
      assert.equal(isValidSemverVersion(bad), false, bad);
    }
  });

  it('accepts valid versions', () => {
    for (const good of ['0.0.0', '1.2.3', '10.20.30', '1.2.3-beta', '1.2.3-beta.1.2']) {
      assert.equal(isValidSemverVersion(good), true, good);
    }
  });

  it('validates ranges', () => {
    for (const good of ['*', '1.2.x', '^1.2.3', '~1.2', '>=1.0.0 <2.0.0', '1.2.3 - 2.0.0']) {
      assert.equal(isValidSemverRange(good), true, good);
    }
    for (const bad of ['', 'not-a-range', '>=', '1.2.3.4', '>=']) {
      assert.equal(isValidSemverRange(bad), false, bad);
    }
  });

  it('satisfies ranges per node-semver semantics', () => {
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ['1.2.3', '^1.2.0', true],
      ['2.0.0', '^1.2.0', false],
      ['0.2.3', '^0.2.0', true],
      ['0.3.0', '^0.2.0', false],
      ['0.0.3', '^0.0.3', true],
      ['0.0.4', '^0.0.3', false],
      ['1.4.9', '~1.4', true],
      ['1.5.0', '~1.4.0', false],
      ['1.0.0', '~1', true],
      ['2.0.0', '~1', false],
      ['1.2.3', '1.2.x', true],
      ['1.2.3', '*', true],
      ['1.2.3', '1.2.3 - 2.0.0', true],
      ['1.2.3', '>=1.2.3 || <1.0.0', true],
      ['1.2.3', '>=1.0.0 <2.0.0', true],
      ['3.0.0', '>=1.0.0 <2.0.0', false],
      // Prerelease rule: a prerelease only matches a comparator pinning the
      // same [major,minor,patch] tuple AND carrying its own prerelease.
      ['1.2.3-beta', '^1.2.3', false],
      ['1.2.3-beta', '>=1.2.3-beta', true],
      ['3.4.5-alpha.9', '>1.2.3-alpha.3', false],
      ['1.2.3-alpha.7', '>1.2.3-alpha.3', true],
      ['1.2.3', '>1.2.3-alpha.3', true],
      ['1.2.3-beta.1', '~1.2.3-beta', true],
      ['1.2.3', '~1.2.3-beta', true],
      ['1.2.3-beta', '*', false],
      ['1.2.3-beta', '>=1.0.0', false],
      ['1.2.4', '^1.2.3-beta', true],
    ];
    for (const [version, range, expected] of cases) {
      assert.equal(satisfiesRange(version, range), expected, `${version} satisfies ${range}`);
    }
  });

  it('returns false for a bad version or range input', () => {
    assert.equal(satisfiesRange('nope', '^1.0.0'), false);
    assert.equal(satisfiesRange('1.2.3', 'nope'), false);
  });
});
