/**
 * Unit tests for the i18n key extractor and message-key flattener.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractTranslationKeys } from '../../src/i18n/extract.js';
import { flattenMessageKeys } from '../../src/i18n/flatten.js';

describe('extractTranslationKeys', () => {
  it('finds I18n.t with a literal key', () => {
    const { refs, dynamic } = extractTranslationKeys(`I18n.t('nav.home');`);
    assert.equal(dynamic, 0);
    assert.deepEqual(
      refs.map((r) => r.key),
      ['nav.home'],
    );
  });

  it('finds I18n.tChoice and I18n.exists', () => {
    const src = `I18n.tChoice('post.count', n); I18n.exists('nav.about');`;
    const { refs } = extractTranslationKeys(src);
    assert.deepEqual(refs.map((r) => r.key).sort(), ['nav.about', 'post.count']);
  });

  it('folds a string scope', () => {
    const { refs } = extractTranslationKeys(`I18n.t('short', { scope: 'date.formats' });`);
    assert.deepEqual(
      refs.map((r) => r.key),
      ['date.formats.short'],
    );
  });

  it('folds an array scope', () => {
    const { refs } = extractTranslationKeys(`I18n.t('short', { scope: ['date', 'formats'] });`);
    assert.deepEqual(
      refs.map((r) => r.key),
      ['date.formats.short'],
    );
  });

  it('folds a scope on tChoice (options at index 2)', () => {
    const { refs } = extractTranslationKeys(`I18n.tChoice('count', n, { scope: 'post' });`);
    assert.deepEqual(
      refs.map((r) => r.key),
      ['post.count'],
    );
  });

  it('records line numbers', () => {
    const { refs } = extractTranslationKeys(`\n\nI18n.t('x');`);
    assert.equal(refs[0]?.line, 3);
  });

  it('matches bare t only when imported from the i18n server subpath', () => {
    const imported = extractTranslationKeys(
      `import { t } from 'jsails/i18n/server'; t('imported.key');`,
    );
    assert.deepEqual(
      imported.refs.map((r) => r.key),
      ['imported.key'],
    );

    const notImported = extractTranslationKeys(`const t = (x) => x; t('not.i18n');`);
    assert.deepEqual(notImported.refs, []);
    assert.equal(notImported.dynamic, 0);
  });

  it('counts dynamic keys as dynamic, not missing', () => {
    const { refs, dynamic } = extractTranslationKeys(`I18n.t(someVariable);`);
    assert.deepEqual(refs, []);
    assert.equal(dynamic, 1);
  });

  it('counts a dynamic scope as dynamic', () => {
    const { refs, dynamic } = extractTranslationKeys(`I18n.t('key', { scope: someVar });`);
    assert.deepEqual(refs, []);
    assert.equal(dynamic, 1);
  });

  it('ignores l/localize (not keys)', () => {
    const { refs, dynamic } = extractTranslationKeys(`I18n.l(date, { dateStyle: 'long' });`);
    assert.deepEqual(refs, []);
    assert.equal(dynamic, 0);
  });

  it('does not mistake node:test t context for i18n', () => {
    const src = `test('x', (t) => { t.equal(1, 1); });`;
    const { refs } = extractTranslationKeys(src);
    assert.deepEqual(refs, []);
  });
});

describe('flattenMessageKeys', () => {
  it('flattens nested namespaces to dotted keys', () => {
    const keys = flattenMessageKeys({ nav: { home: 'Home', about: 'About' }, title: 'T' });
    assert.deepEqual(keys, ['nav.about', 'nav.home', 'title']);
  });

  it('collapses a plural entry to its parent key', () => {
    const keys = flattenMessageKeys({ count: { one: '1', other: 'many' } });
    assert.deepEqual(keys, ['count']);
  });

  it('does not collapse a namespace that is not a plural entry', () => {
    const keys = flattenMessageKeys({ date: { formats: { short: 'S', long: 'L' } } });
    assert.deepEqual(keys, ['date.formats.long', 'date.formats.short']);
  });

  it('returns an empty list for an empty catalog', () => {
    assert.deepEqual(flattenMessageKeys({}), []);
  });
});
