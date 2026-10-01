/**
 * i18n URL routing: `localizedPath`/`hreflang`/`hreflangRel` pure helpers and
 * `localePrefixPaths` (prefix routing aliases).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hreflang, hreflangRel, localizedPath } from '../../src/i18n/routing.js';
import { localePrefixPaths } from '../../src/routing/routes.js';
import type { RouteManifestEntry } from '../../src/routing/routes.js';

const about: RouteManifestEntry = {
  kind: 'page',
  route: '/about',
  file: '/app/pages/about.js',
  dynamic: false,
  catchAll: false,
  params: [],
};

describe('localizedPath', () => {
  it('prefixes a non-default locale and leaves the default bare', () => {
    assert.equal(localizedPath('/about', 'fr', 'en'), '/fr/about');
    assert.equal(localizedPath('/about', 'en', 'en'), '/about');
  });

  it('handles the root route', () => {
    assert.equal(localizedPath('/', 'fr', 'en'), '/fr');
    assert.equal(localizedPath('/', 'en', 'en'), '/');
  });

  it('normalizes a non-/ route', () => {
    assert.equal(localizedPath('about', 'fr', 'en'), '/fr/about');
  });
});

describe('hreflang / hreflangRel', () => {
  it('emits one link per locale with x-default for the default', () => {
    const links = hreflang('/about', {
      locales: ['en', 'fr'],
      defaultLocale: 'en',
      origin: 'https://example.com',
    });
    assert.deepEqual(links, [
      { locale: 'en', href: 'https://example.com/about' },
      { locale: 'fr', href: 'https://example.com/fr/about' },
    ]);
    assert.equal(hreflangRel('en', 'en'), 'x-default');
    assert.equal(hreflangRel('fr', 'en'), 'fr');
  });

  it('returns [] for an empty locale list', () => {
    assert.deepEqual(hreflang('/about', { locales: [], origin: 'https://example.com' }), []);
  });
});

describe('localePrefixPaths', () => {
  it('emits a prefixed alias per non-default locale', () => {
    assert.deepEqual(localePrefixPaths(about, ['en', 'fr'], 'en'), ['/fr/about']);
  });

  it('returns [] when no locales are configured', () => {
    assert.deepEqual(localePrefixPaths(about, [], 'en'), []);
  });

  it('handles the root route', () => {
    const root: RouteManifestEntry = {
      kind: 'page',
      route: '/',
      file: '/app/pages/index.js',
      dynamic: false,
      catchAll: false,
      params: [],
    };
    assert.deepEqual(localePrefixPaths(root, ['en', 'fr'], 'en'), ['/fr']);
  });
});
