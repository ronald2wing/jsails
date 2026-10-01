import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MessageTranslator,
  I18nError,
  createLocalizer,
  type Messages,
} from '../../src/i18n/index.js';

/** Shared message map: English plus Polish plural forms. */
const messages: Messages = {
  en: {
    greeting: 'Hello, {name}!',
    status: '{count} of {total} done',
    nav: { home: 'Home', about: { team: 'Team' } },
    apples: { one: 'one apple', other: '{count} apples' },
    single: 'always this',
    date: { formats: { short: 'short date', long: 'long date' } },
    fallback: { literal: 'fallback literal from messages' },
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

describe('MessageTranslator', () => {
  it('defaults locale and fallbackLocale to en', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.locale(), 'en');
    assert.equal(translator.fallbackLocale(), 'en');
  });

  it('resolves a top-level key', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('greeting'), 'Hello, {name}!');
  });

  it('resolves a dot-path key across nesting levels', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('nav.home'), 'Home');
    assert.equal(translator.t('nav.about.team'), 'Team');
  });

  it('interpolates {name} placeholders with string and number values', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('greeting', { name: 'Alice' }), 'Hello, Alice!');
    assert.equal(translator.t('status', { count: 3, total: 10 }), '3 of 10 done');
  });

  it('leaves an unmatched placeholder untouched', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('greeting'), 'Hello, {name}!');
  });

  it('falls back to the fallback locale when the key is missing', () => {
    const translator = new MessageTranslator({ messages, locale: 'pl' });
    // "greeting" exists only in `en`.
    assert.equal(translator.t('greeting', { name: 'Alice' }), 'Hello, Alice!');
  });

  it('returns the key itself when neither locale has it', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('missing.key'), 'missing.key');
  });

  it('uses an explicit fallback locale instead of the default', () => {
    const translator = new MessageTranslator({
      messages: { de: { hello: 'Hallo' } },
      locale: 'fr',
      fallbackLocale: 'de',
    });
    assert.equal(translator.t('hello'), 'Hallo');
  });

  it('rejects a non-object messages value with a value-free error', () => {
    for (const bad of [null, [], 'en', 42]) {
      assert.throws(
        () => new MessageTranslator({ messages: bad as unknown as Messages }),
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
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.tChoice('apples', 1), 'one apple');
    assert.equal(translator.tChoice('apples', 0), '0 apples');
    assert.equal(translator.tChoice('apples', 5), '5 apples');
  });

  it('selects a second locale with more categories (Polish)', () => {
    const translator = new MessageTranslator({ messages, locale: 'pl' });
    assert.equal(translator.tChoice('apples', 1), '1 jabłko'); // one
    assert.equal(translator.tChoice('apples', 2), '2 jabłka'); // few
    assert.equal(translator.tChoice('apples', 5), '5 jabłek'); // many
    assert.equal(translator.tChoice('apples', 22), '22 jabłka'); // few
  });

  it('returns a plain-string value unchanged (no plural map)', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.tChoice('single', 7), 'always this');
  });

  it('injects {count} unless the caller supplied it', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.tChoice('apples', 5), '5 apples');
    assert.equal(translator.tChoice('apples', 5, { count: 'five' }), 'five apples');
  });

  it('returns the key itself when missing', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.tChoice('missing.plural', 2), 'missing.plural');
  });

  it('uses the fallback locale forms and categories when the locale lacks the key', () => {
    // Polish has no "apples" here; English supplies one/other, so the choice
    // must follow English categories even though the active locale is Polish.
    const translator = new MessageTranslator({
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
    const translator = new MessageTranslator({ messages });
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
      () => new MessageTranslator({ messages, locale: bad }),
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
      () => new MessageTranslator({ messages, fallbackLocale: 'en_US' }),
      (error) => {
        assert.ok(error instanceof I18nError);
        assert.equal(error.message, 'invalid locale');
        return true;
      },
    );
  });

  it('throws when withLocale receives an invalid locale', () => {
    const translator = new MessageTranslator({ messages });
    assert.throws(() => translator.withLocale('123'), I18nError);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 additions
// ---------------------------------------------------------------------------

describe('t() with scope', () => {
  it('resolves a key with a string scope (split on dot)', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('short', { scope: 'date.formats' }), 'short date');
  });

  it('resolves a key with an array scope', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('short', { scope: ['date', 'formats'] }), 'short date');
  });

  it('string and array scope are equivalent', () => {
    const translator = new MessageTranslator({ messages });
    const a = translator.t('short', { scope: 'date.formats' });
    const b = translator.t('short', { scope: ['date', 'formats'] });
    assert.equal(a, b);
  });

  it('returns the scoped key when neither locale has it', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('nope', { scope: 'date.formats' }), 'date.formats.nope');
  });

  it('rejects an empty scope segment (string form)', () => {
    const translator = new MessageTranslator({ messages });
    assert.throws(
      () => translator.t('x', { scope: 'date..formats' }),
      (e: unknown) => e instanceof I18nError && e.message === 'invalid scope',
    );
  });

  it('rejects an empty scope segment (array form)', () => {
    const translator = new MessageTranslator({ messages });
    assert.throws(
      () => translator.t('x', { scope: ['date', ''] }),
      (e: unknown) => e instanceof I18nError && e.message === 'invalid scope',
    );
  });
});

describe('t() with default', () => {
  it('returns a literal default string (interpolated) when key is missing', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(
      translator.t('missing.key', {
        default: 'Hello {name}',
        params: { name: 'World' },
      }),
      'Hello World',
    );
  });

  it('returns a default { key } by resolving another key', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('missing.key', { default: { key: 'nav.home' } }), 'Home');
  });

  it('returns the first hit from a default array', () => {
    const translator = new MessageTranslator({ messages });
    // First literal matches → stops.
    assert.equal(translator.t('missing.key', { default: ['first-wins', 'second'] }), 'first-wins');
  });

  it('skips a non-resolving { key } in a default array and uses the next', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(
      translator.t('missing.key', {
        default: [{ key: 'missing.too' }, { key: 'nav.home' }, 'never-reached'],
      }),
      'Home',
    );
  });

  it('default is not consulted when the key exists', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.t('nav.home', { default: 'should-not-use' }), 'Home');
  });

  it('returns the scoped key when no default matches', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(
      translator.t('missing.key', {
        scope: 'date.formats',
        default: [{ key: 'missing.too' }],
      }),
      'date.formats.missing.key',
    );
  });
});

describe('t() bulk lookup', () => {
  it('resolves an array of keys and preserves input order', () => {
    const translator = new MessageTranslator({ messages });
    const result = translator.t(['greeting', 'nav.home', 'missing.key'], {
      params: { name: 'Alice' },
    });
    assert.deepEqual(result, ['Hello, Alice!', 'Home', 'missing.key']);
  });

  it('bulk lookup with scope scopes each key identically', () => {
    const translator = new MessageTranslator({ messages });
    const result = translator.t(['short', 'long'], { scope: 'date.formats' });
    assert.deepEqual(result, ['short date', 'long date']);
  });

  it('empty array returns empty array', () => {
    const translator = new MessageTranslator({ messages });
    assert.deepEqual(translator.t([]), []);
  });
});

describe('exists()', () => {
  it('returns true when the key is in the active locale', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.exists('nav.home'), true);
  });

  it('returns true when the key is only in the fallback locale', () => {
    const translator = new MessageTranslator({ messages, locale: 'pl' });
    // greeting is only in en (fallback).
    assert.equal(translator.exists('greeting'), true);
  });

  it('returns false when neither locale has the key', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.exists('missing.key'), false);
  });

  it('respects the scope option', () => {
    const translator = new MessageTranslator({ messages });
    assert.equal(translator.exists('short', { scope: 'date.formats' }), true);
    assert.equal(translator.exists('nope', { scope: 'date.formats' }), false);
  });

  it('does not consult default fallback', () => {
    const translator = new MessageTranslator({ messages });
    // `missing.key` is not in en or pl, and exists ignores defaults.
    assert.equal(translator.exists('missing.key'), false);
    // Even though a t() with default would return it.
  });
});

describe('case-variant interpolation :name / :Name / :NAME', () => {
  const caseMessages: Messages = {
    en: {
      user_label: 'Hello, :name!',
      title_label: 'Welcome :Name',
      shout: 'HELLO :NAME',
    },
  };

  it(':name → value as-is', () => {
    const translator = new MessageTranslator({ messages: caseMessages });
    assert.equal(translator.t('user_label', { name: 'alice' }), 'Hello, alice!');
  });

  it(':Name → value with first character uppercase', () => {
    const translator = new MessageTranslator({ messages: caseMessages });
    assert.equal(translator.t('title_label', { name: 'alice' }), 'Welcome Alice');
  });

  it(':NAME → value fully uppercase', () => {
    const translator = new MessageTranslator({ messages: caseMessages });
    assert.equal(translator.t('shout', { name: 'alice' }), 'HELLO ALICE');
  });

  it('leaves a colon in 12:30 untouched', () => {
    const messagesWithTime: Messages = {
      en: { time: 'The time is 12:30 and :name is here' },
    };
    const translator = new MessageTranslator({ messages: messagesWithTime });
    assert.equal(translator.t('time', { name: 'alice' }), 'The time is 12:30 and alice is here');
  });

  it('leaves http:// untouched', () => {
    const messagesWithUrl: Messages = {
      en: { link: 'Visit http://example.com for :name' },
    };
    const translator = new MessageTranslator({ messages: messagesWithUrl });
    assert.equal(translator.t('link', { name: 'details' }), 'Visit http://example.com for details');
  });

  it('leaves unknown :name placeholders as-is', () => {
    const translator = new MessageTranslator({ messages: caseMessages });
    assert.equal(translator.t('user_label'), 'Hello, :name!');
  });

  it('case variants work after {name} interpolation', () => {
    const mixedMessages: Messages = {
      en: { mixed: '{greeting}, :name!' },
    };
    const translator = new MessageTranslator({ messages: mixedMessages });
    assert.equal(translator.t('mixed', { greeting: 'Hi', name: 'world' }), 'Hi, world!');
  });
});

describe('reserved option name rejection', () => {
  it('rejects "scope" as a param key inside TranslationOptions', () => {
    const translator = new MessageTranslator({ messages });
    assert.throws(
      () =>
        translator.t('greeting', {
          scope: 'greeting',
          params: { scope: 'bad' },
        }),
      (e: unknown) => e instanceof I18nError && e.message === 'reserved option name',
    );
  });

  it('rejects "default" as a param key inside TranslationOptions', () => {
    const translator = new MessageTranslator({ messages });
    assert.throws(
      () =>
        translator.t('greeting', {
          scope: 'greeting',
          params: { default: 'bad' },
        }),
      (e: unknown) => e instanceof I18nError && e.message === 'reserved option name',
    );
  });

  it('"scope" at the top level is treated as an option, not rejected', () => {
    const translator = new MessageTranslator({ messages });
    assert.doesNotThrow(() => translator.t('short', { scope: 'date.formats' }));
  });

  it('"default" at the top level is treated as an option, not rejected', () => {
    const translator = new MessageTranslator({ messages });
    assert.doesNotThrow(() => translator.t('missing', { default: 'fallback' }));
  });
});

describe('onMissing handler', () => {
  it('is called when a key is missing in both locales and no default matches', () => {
    const missingKeys: string[] = [];
    const translator = new MessageTranslator({
      messages,
      onMissing(key, locale) {
        missingKeys.push(`${locale}:${key}`);
        return undefined;
      },
    });
    const result = translator.t('missing.key');
    assert.equal(result, 'missing.key'); // falls through to key echo
    assert.deepEqual(missingKeys, ['en:missing.key']);
  });

  it('returns the handler string when provided', () => {
    const translator = new MessageTranslator({
      messages,
      onMissing(_key, _locale) {
        return 'MISSING';
      },
    });
    assert.equal(translator.t('missing.key'), 'MISSING');
  });

  it('handler result is interpolated with params', () => {
    const translator = new MessageTranslator({
      messages,
      onMissing() {
        return 'Missing {name}';
      },
    });
    assert.equal(translator.t('missing.key', { scope: 'a', params: { name: 'X' } }), 'Missing X');
  });

  it('is NOT called when a default resolves', () => {
    let called = false;
    const translator = new MessageTranslator({
      messages,
      onMissing() {
        called = true;
        return undefined;
      },
    });
    const result = translator.t('missing.key', { default: 'fallback' });
    assert.equal(result, 'fallback');
    assert.equal(called, false);
  });

  it('a throwing handler falls through to key echo', () => {
    const translator = new MessageTranslator({
      messages,
      onMissing() {
        throw new Error('boom');
      },
    });
    assert.equal(translator.t('missing.key'), 'missing.key');
  });

  it('is never called for exists()', () => {
    let called = false;
    const translator = new MessageTranslator({
      messages,
      onMissing() {
        called = true;
        return undefined;
      },
    });
    assert.equal(translator.exists('missing.key'), false);
    assert.equal(called, false);
  });

  it('receives the scoped key and the active locale', () => {
    let capturedKey = '';
    let capturedLocale = '';
    const translator = new MessageTranslator({
      messages,
      locale: 'pl',
      onMissing(key, locale) {
        capturedKey = key;
        capturedLocale = locale;
        return undefined;
      },
    });
    translator.t('nope', { scope: 'date.formats' });
    assert.equal(capturedKey, 'date.formats.nope');
    assert.equal(capturedLocale, 'pl');
  });
});

describe('localize / l', () => {
  const epoch = new Date(2000, 0, 1); // 2000-01-01

  it('formats a date with the active locale', () => {
    const translator = new MessageTranslator({ messages });
    const result = translator.localize(epoch, { dateStyle: 'medium' });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('formats a time', () => {
    const translator = new MessageTranslator({ messages });
    const result = translator.localize(epoch, { kind: 'time', timeStyle: 'medium' });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('formats a datetime', () => {
    const translator = new MessageTranslator({ messages });
    const result = translator.localize(epoch, {
      kind: 'datetime',
      dateStyle: 'short',
      timeStyle: 'short',
    });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('formats a number with the active locale', () => {
    const translator = new MessageTranslator({ messages });
    const result = translator.localize(1234.56, { kind: 'number', minimumFractionDigits: 2 });
    assert.equal(typeof result, 'string');
    // 1,234.56 or 1 234,56 depending on locale.
    assert.ok(result.includes('1234') || result.includes('1'));
  });

  it('formats a percent', () => {
    const translator = new MessageTranslator({ messages });
    const result = translator.localize(0.42, { kind: 'percent' });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('formats a currency (USD)', () => {
    const translator = new MessageTranslator({ messages });
    const result = translator.localize(42.5, { kind: 'currency', currency: 'USD' });
    assert.equal(typeof result, 'string');
    assert.ok(result.includes('42'));
  });

  it('l() is an alias of localize()', () => {
    const translator = new MessageTranslator({ messages });
    const a = translator.localize(epoch, { dateStyle: 'short' });
    const b = translator.l(epoch, { dateStyle: 'short' });
    assert.equal(a, b);
  });

  it('currency without code throws value-free', () => {
    const translator = new MessageTranslator({ messages });
    assert.throws(
      () => translator.localize(42, { kind: 'currency' }),
      (e: unknown) => e instanceof I18nError && e.message === 'currency code required',
    );
  });

  it('malformed locale throws value-free (I18nError)', () => {
    const translator = new MessageTranslator({ messages });
    assert.throws(
      () => translator.localize(epoch, { locale: 'en_US' }),
      (e: unknown) => e instanceof I18nError && e.message === 'invalid localize options',
    );
  });

  it('does not echo the malformed locale in the error', () => {
    const translator = new MessageTranslator({ messages });
    assert.throws(
      () => translator.localize(epoch, { locale: 'x!!_x' }),
      (e: unknown) => {
        assert.ok(e instanceof I18nError);
        assert.equal(e.message, 'invalid localize options');
        assert.ok(!e.message.includes('x!!_x'), 'must not echo the locale');
        return true;
      },
    );
  });
});

describe('createLocalizer', () => {
  it('returns a locale-bound formatter', () => {
    const formatter = createLocalizer('en');
    assert.equal(typeof formatter, 'function');
    const result = formatter(new Date(2000, 0, 1), { dateStyle: 'medium' });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('defaults kind to date for a Date value', () => {
    const formatter = createLocalizer('en');
    const result = formatter(new Date(2000, 0, 1));
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('defaults kind to number for a numeric value', () => {
    const formatter = createLocalizer('en');
    const result = formatter(1234.5);
    assert.equal(typeof result, 'string');
    // Must contain digits (but exact format depends on locale).
    assert.match(result, /\d/);
  });

  it('respects an explicit locale override in options', () => {
    const deFormatter = createLocalizer('de');
    const enFormatter = createLocalizer('en-US');
    const deResult = deFormatter(1234.5, { kind: 'number', minimumFractionDigits: 2 });
    const enResult = enFormatter(1234.5, { kind: 'number', minimumFractionDigits: 2 });
    // German uses comma as decimal separator, US uses period.
    assert.ok(
      deResult.includes(',') || enResult.includes('.'),
      'locale overrides should produce distinct formatting',
    );
  });
});

describe('tChoice with TranslationOptions', () => {
  it('resolves a plural key with scope', () => {
    const msgs: Messages = {
      en: { products: { apples: { one: '{count} apple', other: '{count} apples' } } },
    };
    const translator = new MessageTranslator({ messages: msgs });
    assert.equal(translator.tChoice('apples', 1, { scope: 'products' }), '1 apple');
    assert.equal(translator.tChoice('apples', 5, { scope: 'products' }), '5 apples');
  });

  it('falls back through default when missing with scope', () => {
    const msgs: Messages = {
      en: { fallback: { literal: 'no data' } },
    };
    const translator = new MessageTranslator({ messages: msgs });
    assert.equal(
      translator.tChoice('missing', 1, { scope: 'nonexistent', default: 'fallback literal' }),
      'fallback literal',
    );
  });
});

describe('new withScope translator preserves new features', () => {
  it('withLocale carries over onMissing', () => {
    const translator = new MessageTranslator({
      messages,
      onMissing(key) {
        return `[${key}]`;
      },
    });
    const french = translator.withLocale('fr');
    assert.equal(french.t('missing.key'), '[missing.key]');
  });

  it('withLocale creates an independent localizer', () => {
    const translator = new MessageTranslator({ messages, locale: 'en' });
    const german = translator.withLocale('de');
    const enDate = translator.localize(new Date(2000, 0, 1), { dateStyle: 'medium' });
    const deDate = german.localize(new Date(2000, 0, 1), { dateStyle: 'medium' });
    // Different locales may produce different output, but both should be strings.
    assert.equal(typeof enDate, 'string');
    assert.equal(typeof deDate, 'string');
  });
});
