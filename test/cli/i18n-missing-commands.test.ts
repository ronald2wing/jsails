/**
 * Tests for `jsails i18n:missing`. Exercises the DI seam (`runI18nMissing`)
 * and the CLI arg parser without importing real config modules.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  runI18nMissing,
  runI18nMissingCommand,
  type I18nMissingDeps,
} from '../../src/cli/i18n-missing-commands.js';
import type { ResolvedAppConfig } from '../../src/app/config/index.js';

interface Sinks {
  out: string[];
  err: string[];
}

/** Build a minimal resolved config with the fields the command reads. */
function resolveConfig(i18n?: ResolvedAppConfig['i18n']): ResolvedAppConfig {
  return {
    rootDir: '/app',
    pagesDir: '/app/pages',
    apiDir: '/app/api',
    i18n,
  } as unknown as ResolvedAppConfig;
}

function depsFor(
  config: ResolvedAppConfig,
  files: Record<string, string>,
): I18nMissingDeps & Sinks {
  const sinks: Sinks = { out: [], err: [] };
  return {
    loadConfig: async () => config,
    listFiles: (dir) => Object.keys(files).filter((file) => file.startsWith(dir)),
    readFile: (path) => files[path] ?? '',
    stdout: (text) => sinks.out.push(text),
    stderr: (text) => sinks.err.push(text),
    out: sinks.out,
    err: sinks.err,
  };
}

describe('runI18nMissing', () => {
  it('reports a key referenced in code but absent from catalogs', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: { nav: { home: 'Home' } } },
    });
    const deps = depsFor(config, {
      '/app/pages/index.js': `I18n.t('nav.home'); I18n.t('missing.key');`,
    });
    const { result, exitCode } = await runI18nMissing(
      { configPath: 'jsails.app.js', options: {} },
      deps,
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(
      result.missing.map((m) => m.key),
      ['missing.key'],
    );
    assert.equal(result.dynamic, 0);
    assert.equal(result.scannedFiles, 1);
  });

  it('exits 0 when every key resolves', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: { nav: { home: 'Home' } } },
    });
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t('nav.home');` });
    const { result, exitCode } = await runI18nMissing(
      { configPath: 'jsails.app.js', options: {} },
      deps,
    );
    assert.equal(exitCode, 0);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unused, []);
  });

  it('reports unused keys only via the unused list (not missing)', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: { nav: { home: 'Home' }, stale: 'S' } },
    });
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t('nav.home');` });
    const { result } = await runI18nMissing({ configPath: 'jsails.app.js', options: {} }, deps);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unused, ['stale']);
  });

  it('counts dynamic call sites without guessing', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: {} },
    });
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t(dynamicKey);` });
    const { result } = await runI18nMissing({ configPath: 'jsails.app.js', options: {} }, deps);
    assert.equal(result.dynamic, 1);
    assert.deepEqual(result.missing, []);
  });

  it('fails when i18n is not configured', async () => {
    const config = resolveConfig(undefined);
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t('nav.home');` });
    const { exitCode } = await runI18nMissing({ configPath: 'jsails.app.js', options: {} }, deps);
    assert.equal(exitCode, 1);
    assert.ok(deps.err.join('').includes('not configured'));
  });
});

describe('runI18nMissingCommand', () => {
  it('prints JSON with --json', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: { nav: { home: 'Home' } } },
    });
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t('nav.home');` });
    const code = await runI18nMissingCommand(['--json'], deps);
    assert.equal(code, 0);
    const parsed = JSON.parse(deps.out.join('\n')) as { missing: unknown[] };
    assert.deepEqual(parsed.missing, []);
  });

  it('returns a usage error for an unknown option', async () => {
    const config = resolveConfig({ locale: 'en', fallbackLocale: 'en', catalogs: {} });
    const deps = depsFor(config, {});
    const code = await runI18nMissingCommand(['--bogus'], deps);
    assert.equal(code, 2);
    assert.ok(deps.err.join('').includes('unknown option'));
  });

  it('prints help and exits 0 with --help', async () => {
    const config = resolveConfig({ locale: 'en', fallbackLocale: 'en', catalogs: {} });
    const deps = depsFor(config, {});
    const code = await runI18nMissingCommand(['--help'], deps);
    assert.equal(code, 0);
    assert.ok(deps.out.join('').includes('Usage'));
  });
});
