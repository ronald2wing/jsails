/**
 * Unit tests for the i18n plugin: token, service lifecycle, and error paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runExtensions } from '../../src/extensions/extension.js';
import { i18nPlugin, i18nToken } from '../../src/i18n/plugin.js';

// ---- token ------------------------------------------------------------------

test('i18nToken is a valid service token', () => {
  assert.strictEqual(typeof i18nToken, 'object');
  assert.ok(i18nToken !== null);
});

// ---- plugin provides i18nToken -----------------------------------------------

test('i18nPlugin provides I18nService under i18nToken', async () => {
  const plugin = i18nPlugin();
  assert.strictEqual(plugin.name, 'i18n');

  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);
  assert.ok(service !== null);
  assert.strictEqual(typeof service.t, 'function');
  assert.strictEqual(typeof service.tChoice, 'function');
  assert.strictEqual(typeof service.locale, 'function');
  assert.strictEqual(typeof service.withLocale, 'function');

  await runtime.close();
});

// ---- defaults ----------------------------------------------------------------

test('I18nService defaults locale and fallback to "en"', async () => {
  const plugin = i18nPlugin();
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  assert.strictEqual(service.locale(), 'en');
  assert.strictEqual(service.fallbackLocale(), 'en');

  await runtime.close();
});

// ---- explicit locale ---------------------------------------------------------

test('I18nService respects explicit locale and fallbackLocale', async () => {
  const plugin = i18nPlugin({ locale: 'fr', fallbackLocale: 'de' });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  assert.strictEqual(service.locale(), 'fr');
  assert.strictEqual(service.fallbackLocale(), 'de');

  await runtime.close();
});

// ---- t() outside a request falls back to default ------------------------------

test('I18nService.t returns key when no catalog is loaded', async () => {
  const plugin = i18nPlugin();
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  // No locale set and no catalog — key echo
  assert.strictEqual(service.t('greeting.hello'), 'greeting.hello');

  await runtime.close();
});

// ---- t() with catalogs -------------------------------------------------------

test('I18nService.t resolves a key from catalogs (eager)', async () => {
  const plugin = i18nPlugin({
    catalogs: {
      en: { greeting: { hello: 'Hello!' } },
    },
  });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  assert.strictEqual(service.t('greeting.hello'), 'Hello!');

  await runtime.close();
});

// ---- tChoice ---------------------------------------------------------------

test('I18nService.tChoice does plural selection', async () => {
  const plugin = i18nPlugin({
    catalogs: {
      en: { apples: { one: '{count} apple', other: '{count} apples' } },
    },
  });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  assert.strictEqual(service.tChoice('apples', 1), '1 apple');
  assert.strictEqual(service.tChoice('apples', 5), '5 apples');

  await runtime.close();
});

// ---- exists ---------------------------------------------------------------

test('I18nService.exists returns true when key is in active locale', async () => {
  const plugin = i18nPlugin({
    catalogs: {
      en: { hello: 'Hello' },
    },
  });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  assert.strictEqual(service.exists('hello'), true);
  assert.strictEqual(service.exists('missing'), false);

  await runtime.close();
});

// ---- fallback chain -------------------------------------------------------

test('I18nService.t falls back through fallback locale', async () => {
  const plugin = i18nPlugin({
    locale: 'fr',
    catalogs: {
      fr: { page: { title: 'Bonjour' } },
    },
  });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  // Key exists in fr
  assert.strictEqual(service.t('page.title'), 'Bonjour');
  // Key missing in fr, missing in en — key echo
  assert.strictEqual(service.t('page.missing'), 'page.missing');

  await runtime.close();
});

// ---- catalogs and loadPaths mutually exclusive --------------------------------

test('i18nPlugin rejects catalogs and loadPaths together', () => {
  assert.throws(() => i18nPlugin({ catalogs: {}, loadPaths: ['/'] }), {
    name: 'TypeError',
    message: 'catalogs and loadPaths are mutually exclusive',
  });
});

// ---- availableLocales ----------------------------------------------------------

test('I18nService.availableLocales lists loaded locales', async () => {
  const plugin = i18nPlugin({
    catalogs: {
      en: { hello: 'Hello' },
      fr: { hello: 'Bonjour' },
      de: { hello: 'Hallo' },
    },
  });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  const locales = service.availableLocales();
  assert.deepStrictEqual(locales, ['de', 'en', 'fr']);

  await runtime.close();
});

// ---- empty catalogs -> empty availableLocales --------------------------------

test('I18nService.availableLocales returns [] for empty catalogs', async () => {
  const plugin = i18nPlugin();
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  const locales = service.availableLocales();
  assert.deepStrictEqual(locales, []);

  await runtime.close();
});

// ---- withLocale bypasses ambient scope ----------------------------------------

test('I18nService.withLocale returns a locale-bound Translator', async () => {
  const plugin = i18nPlugin({
    catalogs: {
      en: { hello: 'Hello' },
      fr: { hello: 'Bonjour' },
    },
  });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  const fr = service.withLocale('fr');
  assert.strictEqual(fr.t('hello'), 'Bonjour');
  assert.strictEqual(fr.locale(), 'fr');

  // Ambient still reads en (the default)
  assert.strictEqual(service.locale(), 'en');

  await runtime.close();
});

// ---- resolveRequestLocale returns default when no resolver ---------------------

test('I18nService.resolveRequestLocale returns default with no resolver', async () => {
  const plugin = i18nPlugin({ locale: 'fr' });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  const request = new Request('http://localhost/');
  const context = { url: new URL('http://localhost/'), params: {} };

  assert.strictEqual(await service.resolveRequestLocale(request, context), 'fr');

  await runtime.close();
});

// ---- resolveRequestLocale calls the resolver ----------------------------------

test('I18nService.resolveRequestLocale uses the resolver', async () => {
  const plugin = i18nPlugin({
    locale: 'en',
    resolveLocale: (_request: Request, context: { url: URL }) =>
      context.url.searchParams.get('lang') ?? undefined,
  });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  const request = new Request('http://localhost/?lang=de');
  const context = { url: new URL('http://localhost/?lang=de'), params: {} };

  assert.strictEqual(await service.resolveRequestLocale(request, context), 'de');

  await runtime.close();
});

// ---- resolveRequestLocale falls back when resolver throws ----------------------

test('I18nService.resolveRequestLocale falls back when resolver throws', async () => {
  const plugin = i18nPlugin({
    locale: 'en',
    resolveLocale: () => {
      throw new Error('boom');
    },
  });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  const request = new Request('http://localhost/');
  const context = { url: new URL('http://localhost/'), params: {} };

  assert.strictEqual(await service.resolveRequestLocale(request, context), 'en');

  await runtime.close();
});

// ---- resolveRequestLocale falls back for invalid return -----------------------

test('I18nService.resolveRequestLocale falls back for invalid locale', async () => {
  const plugin = i18nPlugin({
    locale: 'en',
    resolveLocale: () => '../../etc', // path traversal is not a valid locale
  });
  const runtime = await runExtensions([plugin]);
  const service = runtime.services.get(i18nToken);

  const request = new Request('http://localhost/');
  const context = { url: new URL('http://localhost/'), params: {} };

  assert.strictEqual(await service.resolveRequestLocale(request, context), 'en');

  await runtime.close();
});
