/**
 * Content versioning tests (`jsails/content`).
 *
 * Covers manifest validation (value-free), reference validation, duplicate
 * names, current/latest/default resolution, the latest===current edge case,
 * hidden vs private, alias resolution, versionPath URL rules, no-auto-sort,
 * banner derivation + override, freezing, memoization, and filesystem errors.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  ContentError,
  defineContentVersions,
  readContentVersions,
} from '../../src/content/index.js';

/** Create a fresh temp directory and register its cleanup on the test. */
function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-versions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a JSON file into a path relative to root. */
function writeJson(root: string, relPath: string, data: unknown): string {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, JSON.stringify(data), 'utf-8');
  return full;
}

/** Write fixture markdown files for content discovery. */
function writeContent(root: string, relBase: string, files: Record<string, string>): void {
  for (const [slug, body] of Object.entries(files)) {
    const full = join(root, relBase, `${slug}.md`);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }
}

/** Minimal markdown fixture for a page with a title. */
const PAGE = (title: string) => `---
title: ${title}
---
# ${title}
`;

/** Assert a ContentError with the expected code is thrown. */
function assertContentError(fn: () => void, expectedCode: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ContentError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

/** Assert a ContentError with expected code + message constraint. */
function assertContentErrorWithMessage(
  fn: () => void,
  expectedCode: string,
  messagePattern: string,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ContentError);
    assert.equal(error.code, expectedCode);
    assert.ok(error.message.includes(messagePattern));
    return true;
  });
}

// ---- Case 1: Manifest shape validation (value-free) ---- //

describe('readContentVersions validation', () => {
  it('rejects non-object root', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', []);
    assertContentError(() => readContentVersions(path), 'versions_invalid_manifest');
  });

  it('rejects null root', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', null);
    assertContentError(() => readContentVersions(path), 'versions_invalid_manifest');
  });

  it('rejects empty current', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '',
      versions: [{ name: '1.0', label: '1.0', path: '1.0' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_invalid_current');
  });

  it('rejects missing current', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      versions: [{ name: '1.0', label: '1.0', path: '1.0' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_invalid_current');
  });

  it('rejects empty versions array', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', { current: '1.0', versions: [] });
    assertContentError(() => readContentVersions(path), 'versions_invalid_versions');
  });

  it('rejects missing versions', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', { current: '1.0' });
    assertContentError(() => readContentVersions(path), 'versions_invalid_versions');
  });

  it('rejects entry missing name', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ label: '1.0', path: '1.0' }],
    });
    assertContentErrorWithMessage(
      () => readContentVersions(path),
      'versions_invalid_entry',
      'index 0',
    );
  });

  it('rejects entry with empty name', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '', label: '1.0', path: '1.0' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_invalid_entry');
  });

  it('rejects entry missing label', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', path: '1.0' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_invalid_entry');
  });

  it('rejects entry missing path', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_invalid_entry');
  });

  it('rejects invalid banner (value-free message)', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0', banner: 'beta' }],
    });
    assert.throws(
      () => readContentVersions(path),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'versions_invalid_banner');
        // The offending value "beta" must NOT appear in the message.
        assert.ok(!error.message.includes('beta'));
        return true;
      },
    );
  });

  it('rejects invalid noIndex flag (value-free message)', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0', noIndex: 'yes' }],
    });
    assert.throws(
      () => readContentVersions(path),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'versions_invalid_flag');
        assert.ok(!error.message.includes('yes'));
        return true;
      },
    );
  });

  it('rejects invalid hidden flag (value-free message)', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0', hidden: 1 }],
    });
    assert.throws(
      () => readContentVersions(path),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'versions_invalid_flag');
        assert.ok(!error.message.includes('1'));
        return true;
      },
    );
  });

  it('rejects empty tag', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0', tag: '' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_invalid_tag');
  });
});

// ---- Case 2: Reference validation ---- //

describe('reference validation', () => {
  it('rejects current not in versions', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '3.0',
      versions: [{ name: '1.0', label: 'v1', path: '1.0' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_unknown_reference');
  });

  it('rejects latest not in versions', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      latest: '2.0',
      versions: [{ name: '1.0', label: 'v1', path: '1.0' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_unknown_reference');
  });

  it('rejects default not in versions', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      default: '2.0',
      versions: [{ name: '1.0', label: 'v1', path: '1.0' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_unknown_reference');
  });

  it('rejects empty latest string', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      latest: '',
      versions: [{ name: '1.0', label: 'v1', path: '1.0' }],
    });
    assertContentError(() => readContentVersions(path), 'versions_unknown_reference');
  });
});

// ---- Case 3: Duplicate name ---- //

describe('duplicate name', () => {
  it('rejects duplicate version name', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [
        { name: '1.0', label: 'Version 1', path: '1.0' },
        { name: '1.0', label: 'Version 1 dup', path: '1.0-dup' },
      ],
    });
    assertContentError(() => readContentVersions(path), 'versions_duplicate_name');
  });
});

// ---- Case 4: current/latest/default resolution ---- //

describe('current/latest/default resolution', () => {
  it('defaults latest and default to current when unset', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '2.0',
      versions: [
        { name: '2.0', label: 'v2', path: '2.0' },
        { name: '1.0', label: 'v1', path: '1.0' },
      ],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/2.0', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { changes: PAGE('Changes') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    const latest = versions.latest()!;
    assert.equal(latest.name, '2.0');
    assert.equal(latest.isCurrent, true);
    assert.equal(latest.isLatest, true);
    assert.equal(latest.isDefault, true);

    const defaultV = versions.defaultVersion()!;
    assert.equal(defaultV.name, '2.0');

    const v1 = versions.forVersion('1.0')!;
    assert.equal(v1.isCurrent, false);
    assert.equal(v1.isLatest, false);
    assert.equal(v1.isDefault, false);
  });

  it('respects explicit latest and default', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '2.0',
      latest: '1.0',
      default: '1.0',
      versions: [
        { name: '2.0', label: 'v2', path: '2.0' },
        { name: '1.0', label: 'v1', path: '1.0' },
      ],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/2.0', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { changes: PAGE('Changes') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    const v1 = versions.forVersion('1.0')!;
    assert.equal(v1.isCurrent, false);
    assert.equal(v1.isLatest, true);
    assert.equal(v1.isDefault, true);

    const v2 = versions.forVersion('2.0')!;
    assert.equal(v2.isCurrent, true);
    assert.equal(v2.isLatest, false);
    assert.equal(v2.isDefault, false);
  });
});

// ---- Case 5: latest === current ---- //

describe('latest === current', () => {
  it('serves latest at bare prefix with no separate current route', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0' }],
    });

    writeContent(root, 'docs', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { intro: PAGE('Intro') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      prefix: '/docs',
      cacheDir: join(root, '.cache'),
    });

    assert.equal(versions.versions().length, 1);
    const info = versions.versions()[0]!;
    assert.equal(info.isCurrent, true);
    assert.equal(info.isLatest, true);
    assert.equal(versions.latest()!.name, versions.current()!.name);

    // versionPath for latest yields bare prefix.
    assert.equal(versions.versionPath('1.0', 'intro'), '/docs/intro');
    assert.equal(versions.versionPath('1.0', ''), '/docs');
  });
});

// ---- Case 6: hidden vs private ---- //

describe('hidden vs private', () => {
  it('hidden version stays reachable and discoverable', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [
        { name: '1.0', label: '1.0', path: '1.0' },
        { name: '0.9', label: '0.9', path: '0.9', hidden: true },
      ],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/1.0', { intro: PAGE('Intro') });
    writeContent(root, 'versions/0.9', { changes: PAGE('Changes') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    // Hidden version resolves via forVersion.
    const hidden = versions.forVersion('0.9')!;
    assert.equal(hidden.hidden, true);

    // Hidden version appears in versions().
    assert.ok(versions.versions().some((v) => v.name === '0.9'));

    // Hidden version appears in names().
    assert.ok(versions.names().includes('0.9'));

    // Hidden version's pages are discoverable.
    const pages = await versions.pages('0.9');
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.slug, 'changes');
  });
});

// ---- Case 7: Alias resolution ---- //

describe('alias resolution', () => {
  it('resolves latest, stable, dev aliases and returns null for unknown', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '2.0',
      latest: '1.0',
      versions: [
        { name: '2.0', label: 'v2', path: '2.0' },
        { name: '1.0', label: 'v1', path: '1.0' },
      ],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/2.0', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { changes: PAGE('Changes') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    assert.equal(versions.forVersion('latest')!.name, '1.0');
    assert.equal(versions.forVersion('stable')!.name, '1.0');
    assert.equal(versions.forVersion('dev')!.name, '2.0');
    assert.equal(versions.forVersion('nope'), null);
  });
});

// ---- Case 8: versionPath URL rule ---- //

describe('versionPath URL rule', () => {
  it('produces correct URLs for latest and non-latest versions', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '2.0',
      latest: '1.0',
      versions: [
        { name: '2.0', label: 'v2', path: '2.0' },
        { name: '1.0', label: 'v1', path: '1.0' },
      ],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/2.0', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { changes: PAGE('Changes') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      prefix: '/docs',
      cacheDir: join(root, '.cache'),
    });

    // latest (1.0) — bare prefix
    assert.equal(versions.versionPath('1.0', 'a/b'), '/docs/a/b');
    assert.equal(versions.versionPath('1.0', ''), '/docs');

    // non-latest (2.0) — prefix/path/slug
    assert.equal(versions.versionPath('2.0', 'intro'), '/docs/2.0/intro');
    assert.equal(versions.versionPath('2.0', ''), '/docs/2.0');

    // leading slash stripped
    assert.equal(versions.versionPath('1.0', '/intro'), '/docs/intro');

    // duplicate slashes collapsed
    assert.equal(versions.versionPath('1.0', 'a//b'), '/docs/a/b');

    // trailing slash stripped
    assert.equal(versions.versionPath('1.0', 'intro/'), '/docs/intro');
  });

  it('respects custom prefix', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0' }],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/1.0', { intro: PAGE('Intro') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      prefix: '/api/docs',
      cacheDir: join(root, '.cache'),
    });

    assert.equal(versions.versionPath('1.0', 'intro'), '/api/docs/intro');
  });

  it('throws for unknown version', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0' }],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/1.0', { intro: PAGE('Intro') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    assert.throws(
      () => versions.versionPath('nope', 'slug'),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'versions_unknown_version');
        return true;
      },
    );
  });
});

// ---- Case 9: No auto-sort ---- //

describe('no auto-sort', () => {
  it('preserves manifest order', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '2.0',
      latest: '2.0',
      versions: [
        { name: '1.0', label: 'v1', path: '1.0' },
        { name: '2.0', label: 'v2', path: '2.0' },
      ],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/2.0', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { changes: PAGE('Changes') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    // Input order: 1.0, 2.0 — must NOT be sorted.
    assert.deepEqual(versions.names(), ['1.0', '2.0']);
    assert.equal(versions.versions()[0]!.name, '1.0');
    assert.equal(versions.versions()[1]!.name, '2.0');
  });
});

// ---- Case 10: Banner derivation + override ---- //

describe('banner derivation', () => {
  it('derives banner from position relative to latest', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '2.0',
      latest: '2.0',
      versions: [
        { name: '3.0', label: 'v3-dev', path: '3.0' },
        { name: '2.0', label: 'v2', path: '2.0' },
        { name: '1.0', label: 'v1', path: '1.0' },
      ],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/3.0', { next: PAGE('Next') });
    writeContent(root, 'versions/2.0', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { changes: PAGE('Changes') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    // 3.0 before latest → unreleased
    assert.equal(versions.forVersion('3.0')!.banner, 'unreleased');
    // 2.0 is latest → undefined
    assert.equal(versions.forVersion('2.0')!.banner, undefined);
    // 1.0 after latest → unmaintained
    assert.equal(versions.forVersion('1.0')!.banner, 'unmaintained');
  });

  it('explicit banner overrides derivation', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '2.0',
      latest: '2.0',
      versions: [
        { name: '3.0', label: 'v3-dev', path: '3.0', banner: 'unmaintained' },
        { name: '2.0', label: 'v2', path: '2.0' },
        { name: '1.0', label: 'v1', path: '1.0', banner: 'unreleased' },
      ],
    });

    writeContent(root, 'docs', { index: PAGE('Index') });
    writeContent(root, 'versions/3.0', { next: PAGE('Next') });
    writeContent(root, 'versions/2.0', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { changes: PAGE('Changes') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    // 3.0 overridden to unmaintained (not position-derived unreleased).
    assert.equal(versions.forVersion('3.0')!.banner, 'unmaintained');
    // 1.0 overridden to unreleased (not position-derived unmaintained).
    assert.equal(versions.forVersion('1.0')!.banner, 'unreleased');
  });
});

// ---- Case 11: Freezing ---- //

describe('freezing', () => {
  it('freezes every level', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0' }],
    });

    writeContent(root, 'docs', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { intro: PAGE('Intro') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    assert.ok(Object.isFrozen(versions));
    assert.ok(Object.isFrozen(versions.versions()));
    assert.ok(Object.isFrozen(versions.names()));
    const info = versions.versions()[0]!;
    assert.ok(Object.isFrozen(info));
    assert.ok(Object.isFrozen(info.aliases));
  });

  it('validated manifest is frozen', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0' }],
    });
    const manifest = readContentVersions(path);
    assert.ok(Object.isFrozen(manifest));
    assert.ok(Object.isFrozen(manifest.versions));
    assert.ok(Object.isFrozen(manifest.versions[0]));
  });
});

// ---- Case 12: Memoization ---- //

describe('memoization', () => {
  it('readContentVersions returns same identity for same path', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0' }],
    });
    const a = readContentVersions(path);
    const b = readContentVersions(path);
    assert.strictEqual(a, b);
  });

  it('pages memoizes via discoverContent (same frozen array)', async (t) => {
    const root = tempRoot(t);
    const jsonPath = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: '1.0', path: '1.0' }],
    });

    writeContent(root, 'docs', { intro: PAGE('Intro') });
    writeContent(root, 'versions/1.0', { intro: PAGE('Intro') });

    const manifest = readContentVersions(jsonPath);
    const versions = await defineContentVersions({
      currentDir: join(root, 'docs'),
      versionsDir: join(root, 'versions'),
      manifest,
      cacheDir: join(root, '.cache'),
    });

    const a = await versions.pages('1.0');
    const b = await versions.pages('1.0');
    assert.strictEqual(a, b);
  });
});

// ---- Case 13: readContentVersions filesystem errors ---- //

describe('readContentVersions filesystem errors', () => {
  it('errors on missing file', (t) => {
    const root = tempRoot(t);
    const path = join(root, 'nonexistent.json');
    assertContentError(() => readContentVersions(path), 'versions_unreadable');
  });

  it('errors on invalid JSON', (t) => {
    const root = tempRoot(t);
    const full = join(root, 'versions.json');
    mkdirSync(root, { recursive: true });
    writeFileSync(full, 'not json', 'utf-8');
    assertContentError(() => readContentVersions(full), 'versions_invalid_json');
  });
});

// ---- Case 14: unsafe name/path validation ---- //

describe('unsafe name/path validation', () => {
  function assertValueFree(fn: () => void, code: string, forbiddenValue: string): void {
    assert.throws(fn, (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.code, code);
      // The forbidden value must never appear in the message.
      assert.ok(!error.message.includes(forbiddenValue));
      return true;
    });
  }

  it('rejects ../escape in name', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '../escape', label: 'Bad', path: 'x' }],
    });
    assertValueFree(() => readContentVersions(path), 'versions_invalid_name', '../escape');
  });

  it('rejects /abs in name', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '/abs', label: 'Bad', path: 'x' }],
    });
    assertValueFree(() => readContentVersions(path), 'versions_invalid_name', '/abs');
  });

  it('rejects . in name', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '.', label: 'Bad', path: 'x' }],
    });
    assertValueFree(() => readContentVersions(path), 'versions_invalid_name', '.');
  });

  it('rejects .. in name', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '..', label: 'Bad', path: 'x' }],
    });
    assertValueFree(() => readContentVersions(path), 'versions_invalid_name', '..');
  });

  it('rejects a/b in name', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: 'a/b', label: 'Bad', path: 'x' }],
    });
    assertValueFree(() => readContentVersions(path), 'versions_invalid_name', 'a/b');
  });

  it('rejects ../escape in path', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: 'x', label: 'X', path: '../escape' }],
    });
    assertValueFree(() => readContentVersions(path), 'versions_invalid_path', '../escape');
  });

  it('accepts 1.0 as name and path', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '1.0', label: 'v1', path: '1.0' }],
    });
    // Does not throw.
    const manifest = readContentVersions(path);
    assert.equal(manifest.versions[0]!.name, '1.0');
    assert.equal(manifest.versions[0]!.path, '1.0');
  });

  it('rejects name containing NUL-like escape', (t) => {
    const root = tempRoot(t);
    // \0b  in JSON becomes literal backslash-zero-b — backslash is not in the allowlist.
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      versions: [{ name: '\\0b', label: 'Bad', path: 'x' }],
    });
    assertValueFree(() => readContentVersions(path), 'versions_invalid_name', '\\0b');
  });
});

// ---- Case 15: value-free error messages ---- //

describe('value-free error messages', () => {
  it('duplicate name message does not echo the value', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '2.0',
      versions: [
        { name: '2.0', label: 'v2', path: '2.0' },
        { name: '2.0', label: 'dup', path: '2.0-dup' },
      ],
    });
    assert.throws(
      () => readContentVersions(path),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'versions_duplicate_name');
        assert.ok(error.message.includes('index 1'));
        assert.ok(!error.message.includes('2.0'));
        return true;
      },
    );
  });

  it('unknown current reference message does not echo the value', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: 'nope',
      versions: [{ name: '1.0', label: 'v1', path: '1.0' }],
    });
    assert.throws(
      () => readContentVersions(path),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'versions_unknown_reference');
        assert.ok(error.message.includes('"current"'));
        assert.ok(!error.message.includes('nope'));
        return true;
      },
    );
  });

  it('unknown latest reference message does not echo the value', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      latest: 'nope',
      versions: [{ name: '1.0', label: 'v1', path: '1.0' }],
    });
    assert.throws(
      () => readContentVersions(path),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'versions_unknown_reference');
        assert.ok(error.message.includes('"latest"'));
        assert.ok(!error.message.includes('nope'));
        return true;
      },
    );
  });

  it('unknown default reference message does not echo the value', (t) => {
    const root = tempRoot(t);
    const path = writeJson(root, 'versions.json', {
      current: '1.0',
      default: 'nope',
      versions: [{ name: '1.0', label: 'v1', path: '1.0' }],
    });
    assert.throws(
      () => readContentVersions(path),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'versions_unknown_reference');
        assert.ok(error.message.includes('"default"'));
        assert.ok(!error.message.includes('nope'));
        return true;
      },
    );
  });
});
