import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createArrayLoader,
  createFileLoader,
  deepMerge,
  type Messages,
} from '../../src/i18n/loader.js';

// ---- Helpers ------------------------------------------------------------

/** Build a readFile that resolves path -> JSON content and counts calls. */
function countingReadFile(files: Record<string, Messages>): {
  readFile: (path: string) => Promise<string>;
  count: () => number;
} {
  let callCount = 0;
  return {
    async readFile(path: string): Promise<string> {
      callCount++;
      const content = files[path];
      if (content !== undefined) return JSON.stringify(content);
      throw new Error(`ENOENT: ${path}`);
    },
    count: () => callCount,
  };
}

/** Build a readDir that resolves path -> entries and counts calls. */
function countingReadDir(dirs: Record<string, readonly string[]> = {}): {
  readDir: (path: string) => Promise<readonly string[]>;
  count: () => number;
} {
  let callCount = 0;
  return {
    async readDir(path: string): Promise<readonly string[]> {
      callCount++;
      const result = dirs[path];
      if (result !== undefined) return result;
      throw new Error(`ENOENT: ${path}`);
    },
    count: () => callCount,
  };
}

// ---- deepMerge ----------------------------------------------------------

describe('deepMerge', () => {
  it('merges two flat objects with no overlap', () => {
    const base: Messages = { a: '1' };
    const overlay: Messages = { b: '2' };
    const result = deepMerge(base, overlay);
    assert.deepEqual(result, { a: '1', b: '2' });
  });

  it('overlay leaf replaces base leaf', () => {
    const base: Messages = { a: 'old' };
    const overlay: Messages = { a: 'new' };
    const result = deepMerge(base, overlay);
    assert.deepEqual(result, { a: 'new' });
  });

  it('merges nested maps recursively', () => {
    const base: Messages = { nav: { home: 'Home', about: 'About' } };
    const overlay: Messages = { nav: { home: 'Startseite' } };
    const result = deepMerge(base, overlay);
    assert.deepEqual(result, { nav: { home: 'Startseite', about: 'About' } });
  });

  it('throws on leaf-vs-map conflict', () => {
    const base: Messages = { nav: 'plain string' };
    const overlay: Messages = { nav: { home: 'Home' } };
    assert.throws(() => deepMerge(base, overlay), {
      name: 'I18nError',
      message: 'catalog shape conflict',
    });
  });

  it('throws on map-vs-leaf conflict', () => {
    const base: Messages = { nav: { home: 'Home' } };
    const overlay: Messages = { nav: 'plain string' };
    assert.throws(() => deepMerge(base, overlay), {
      name: 'I18nError',
      message: 'catalog shape conflict',
    });
  });
});

// ---- createArrayLoader --------------------------------------------------

describe('ArrayLoader', () => {
  const catalogs: Record<string, Messages> = {
    en: { greeting: 'Hello' },
    pl: { greeting: 'Czesc' },
  };

  it('load returns catalog by reference', async () => {
    const loader = createArrayLoader(catalogs);
    const en = await loader.load('en');
    assert.deepEqual(en, { greeting: 'Hello' });
  });

  it('load returns undefined for unknown locale', async () => {
    const loader = createArrayLoader(catalogs);
    assert.equal(await loader.load('fr'), undefined);
  });

  it('availableLocales returns sorted keys', async () => {
    const loader = createArrayLoader({ de: { a: '1' }, en: { a: '1' }, ar: { a: '1' } });
    assert.deepEqual(await loader.availableLocales(), ['ar', 'de', 'en']);
  });

  it('availableLocales returns empty array for empty catalogs', async () => {
    const loader = createArrayLoader({});
    assert.deepEqual(await loader.availableLocales(), []);
  });

  it('reload is a no-op', async () => {
    const loader = createArrayLoader(catalogs);
    await loader.reload();
    assert.deepEqual(await loader.load('en'), { greeting: 'Hello' });
  });
});

// ---- createFileLoader (injectable) --------------------------------------

describe('FileLoader (injectable)', () => {
  it('rejects empty loadPaths', () => {
    assert.throws(() => createFileLoader({ loadPaths: [] }), {
      name: 'I18nError',
      message: 'invalid load path',
    });
  });

  it('loads a flat JSON file', async () => {
    const rf = countingReadFile({ '/lang/en.json': { greeting: 'Hello' } });
    const loader = createFileLoader({
      loadPaths: ['/lang'],
      readFile: rf.readFile,
      readDir: async () => {
        throw new Error('ENOENT');
      },
    });
    const catalog = await loader.load('en');
    assert.deepEqual(catalog, { greeting: 'Hello' });
  });

  it('loads nested group files', async () => {
    const rf = countingReadFile({
      '/lang/en/nav.json': { home: 'Home' },
      '/lang/en/errors.json': { not_found: 'Not found' },
    });
    const rd = countingReadDir({ '/lang/en': ['nav.json', 'errors.json'] });
    const loader = createFileLoader({
      loadPaths: ['/lang'],
      readFile: rf.readFile,
      readDir: rd.readDir,
    });
    const catalog = await loader.load('en');
    assert.deepEqual(catalog, {
      nav: { home: 'Home' },
      errors: { not_found: 'Not found' },
    });
  });

  it('deep-merges across load paths - later path wins', async () => {
    const rf = countingReadFile({
      '/base/en.json': { greeting: 'Hello', nav: { home: 'Base Home' } },
      '/overlay/en.json': { nav: { home: 'Overlay Home' } },
    });
    const rd = countingReadDir();
    const loader = createFileLoader({
      loadPaths: ['/base', '/overlay'],
      readFile: rf.readFile,
      readDir: rd.readDir,
    });
    const catalog = await loader.load('en');
    assert.deepEqual(catalog, {
      greeting: 'Hello',
      nav: { home: 'Overlay Home' },
    });
  });

  it('flat + group combined across load paths', async () => {
    const rf = countingReadFile({
      '/base/en.json': { greeting: 'Hello' },
      '/extra/en.json': { goodbye: 'Goodbye' },
      '/extra/en/nav.json': { home: 'Nav Home' },
    });
    const rd = countingReadDir({ '/extra/en': ['nav.json'] });
    const loader = createFileLoader({
      loadPaths: ['/base', '/extra'],
      readFile: rf.readFile,
      readDir: rd.readDir,
    });
    const catalog = await loader.load('en');
    assert.deepEqual(catalog, {
      greeting: 'Hello',
      goodbye: 'Goodbye',
      nav: { home: 'Nav Home' },
    });
  });

  it('returns undefined for unknown locale', async () => {
    const loader = createFileLoader({
      loadPaths: ['/lang'],
      readFile: async () => {
        throw new Error('ENOENT');
      },
      readDir: async () => {
        throw new Error('ENOENT');
      },
    });
    assert.equal(await loader.load('fr'), undefined);
  });

  it('throws value-free on invalid locale with slash', async () => {
    const loader = createFileLoader({ loadPaths: ['/lang'] });
    await assert.rejects(() => loader.load('en/../etc'), {
      name: 'I18nError',
      message: 'invalid locale',
    });
  });

  it('throws value-free on invalid locale with dots', async () => {
    const loader = createFileLoader({ loadPaths: ['/lang'] });
    await assert.rejects(() => loader.load('..'), {
      name: 'I18nError',
      message: 'invalid locale',
    });
  });

  it('throws value-free on invalid locale with control char', async () => {
    const loader = createFileLoader({ loadPaths: ['/lang'] });
    await assert.rejects(() => loader.load('en\x00'), {
      name: 'I18nError',
      message: 'invalid locale',
    });
  });

  it('caches per locale - second load does not re-read', async () => {
    const rf = countingReadFile({ '/lang/en.json': { greeting: 'Hello' } });
    const loader = createFileLoader({
      loadPaths: ['/lang'],
      readFile: rf.readFile,
      readDir: async () => {
        throw new Error('ENOENT');
      },
    });

    await loader.load('en');
    const afterFirst = rf.count();

    // Second load should hit cache, no additional reads.
    await loader.load('en');
    assert.equal(rf.count(), afterFirst);
  });

  it('reload clears cache and forces re-read', async () => {
    const rf = countingReadFile({ '/lang/en.json': { greeting: 'Hello' } });
    const loader = createFileLoader({
      loadPaths: ['/lang'],
      readFile: rf.readFile,
      readDir: async () => {
        throw new Error('ENOENT');
      },
    });

    await loader.load('en');
    const afterFirst = rf.count();

    await loader.reload();
    await loader.load('en');
    assert.ok(rf.count() > afterFirst);
  });
});

// ---- FileLoader with real filesystem ------------------------------------

describe('FileLoader (real fs)', () => {
  it('reads flat JSON and group files from a temp directory', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'jsails-i18n-'));
    try {
      await writeFile(join(tmpDir, 'en.json'), JSON.stringify({ greeting: 'Hello' }), 'utf-8');

      await mkdir(join(tmpDir, 'de'));
      await writeFile(
        join(tmpDir, 'de', 'nav.json'),
        JSON.stringify({ home: 'Startseite' }),
        'utf-8',
      );

      const loader = createFileLoader({ loadPaths: [tmpDir] });

      const en = await loader.load('en');
      assert.deepEqual(en, { greeting: 'Hello' });

      const de = await loader.load('de');
      assert.deepEqual(de, { nav: { home: 'Startseite' } });

      const locales = await loader.availableLocales();
      assert.deepEqual(locales, ['de', 'en']);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
