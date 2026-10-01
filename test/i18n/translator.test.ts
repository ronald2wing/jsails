import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTranslator, I18nError, type Messages } from '../../src/i18n/index.js';

/** Shared message map: English plus Polish plural forms. */
const messages: Messages = {
  en: {
    greeting: 'Hello, {name}!',
    status: '{count} of {total} done',
    nav: { home: 'Home', about: { team: 'Team' } },
    apples: { one: 'one apple', other: '{count} apples' },
    single: 'always this',
  },
  pl: {
    apples: {
      one: '{count} jabłko',
      few: '{count} jabłka',
      many: '{count} jabłek',
      other: '{count} jabłka',
    },
  },
};

describe('createTranslator', () => {
  it('defaults locale and fallbackLocale to en', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.locale(), 'en');
    assert.equal(translator.fallbackLocale(), 'en');
  });

  it('resolves a top-level key', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.t('greeting'), 'Hello, {name}!');
  });

  it('resolves a dot-path key across nesting levels', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.t('nav.home'), 'Home');
    assert.equal(translator.t('nav.about.team'), 'Team');
  });

  it('interpolates {name} placeholders with string and number values', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.t('greeting', { name: 'Alice' }), 'Hello, Alice!');
    assert.equal(translator.t('status', { count: 3, total: 10 }), '3 of 10 done');
  });

  it('leaves an unmatched placeholder untouched', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.t('greeting'), 'Hello, {name}!');
  });

  it('falls back to the fallback locale when the key is missing', () => {
    const translator = createTranslator({ messages, locale: 'pl' });
    // "greeting" exists only in `en`.
    assert.equal(translator.t('greeting', { name: 'Alice' }), 'Hello, Alice!');
  });

  it('returns the key itself when neither locale has it', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.t('missing.key'), 'missing.key');
  });

  it('uses an explicit fallback locale instead of the default', () => {
    const translator = createTranslator({
      messages: { de: { hello: 'Hallo' } },
      locale: 'fr',
      fallbackLocale: 'de',
    });
    assert.equal(translator.t('hello'), 'Hallo');
  });

  it('rejects a non-object messages value with a value-free error', () => {
    for (const bad of [null, [], 'en', 42]) {
      assert.throws(
        () => createTranslator({ messages: bad as unknown as Messages }),
        (error) => {
          assert.ok(error instanceof I18nError);
          assert.equal(error.message, 'invalid messages');
          return true;
        },
      );
    }
  });
});

describe('Translator.tChoice', () => {
  it('selects the singular/plural form for English', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.tChoice('apples', 1), 'one apple');
    assert.equal(translator.tChoice('apples', 0), '0 apples');
    assert.equal(translator.tChoice('apples', 5), '5 apples');
  });

  it('selects a second locale with more categories (Polish)', () => {
    const translator = createTranslator({ messages, locale: 'pl' });
    assert.equal(translator.tChoice('apples', 1), '1 jabłko'); // one
    assert.equal(translator.tChoice('apples', 2), '2 jabłka'); // few
    assert.equal(translator.tChoice('apples', 5), '5 jabłek'); // many
    assert.equal(translator.tChoice('apples', 22), '22 jabłka'); // few
  });

  it('returns a plain-string value unchanged (no plural map)', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.tChoice('single', 7), 'always this');
  });

  it('injects {count} unless the caller supplied it', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.tChoice('apples', 5), '5 apples');
    assert.equal(translator.tChoice('apples', 5, { count: 'five' }), 'five apples');
  });

  it('returns the key itself when missing', () => {
    const translator = createTranslator({ messages });
    assert.equal(translator.tChoice('missing.plural', 2), 'missing.plural');
  });

  it('uses the fallback locale forms and categories when the locale lacks the key', () => {
    // Polish has no "apples" here; English supplies one/other, so the choice
    // must follow English categories even though the active locale is Polish.
    const translator = createTranslator({
      messages: { en: { apples: { one: 'one', other: 'many' } }, pl: {} },
      locale: 'pl',
      fallbackLocale: 'en',
    });
    assert.equal(translator.tChoice('apples', 1), 'one');
    assert.equal(translator.tChoice('apples', 2), 'many');
  });
});

describe('locale handling', () => {
  it('withLocale returns a new translator without mutating the original', () => {
    const translator = createTranslator({ messages });
    const polish = translator.withLocale('pl');

    assert.equal(translator.locale(), 'en');
    assert.equal(polish.locale(), 'pl');
    assert.equal(polish.fallbackLocale(), 'en');

    // Plural selection follows the new locale.
    assert.equal(polish.tChoice('apples', 5), '5 jabłek');
    assert.equal(translator.tChoice('apples', 5), '5 apples');
  });

  it('throws a value-free I18nError for an invalid active locale', () => {
    const bad = 'not a locale';
    assert.throws(
      () => createTranslator({ messages, locale: bad }),
      (error) => {
        assert.ok(error instanceof I18nError);
        assert.equal(error.message, 'invalid locale');
        assert.ok(!error.message.includes(bad), 'must not echo the locale');
        return true;
      },
    );
  });

  it('throws a value-free I18nError for an invalid fallback locale', () => {
    assert.throws(
      () => createTranslator({ messages, fallbackLocale: 'en_US' }),
      (error) => {
        assert.ok(error instanceof I18nError);
        assert.equal(error.message, 'invalid locale');
        return true;
      },
    );
  });

  it('throws when withLocale receives an invalid locale', () => {
    const translator = createTranslator({ messages });
    assert.throws(() => translator.withLocale('123'), I18nError);
  });
});
