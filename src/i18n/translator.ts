/**
 * Internationalization: a message translator over plain nested string maps.
 *
 * This slice is deliberately dependency-free and does no file-system or
 * environment resolution: the caller owns loading messages (from plain JSON or
 * objects) and passes them to {@link createTranslator}. The translator then:
 *
 * - resolves a dot-path key (`nav.home`) against the active locale's map, then
 *   the fallback locale's map, and finally returns the key itself when neither
 *   has it;
 * - interpolates `{name}` placeholders with `t(key, params)` (values are
 *   stringified; escaping is the caller's job);
 * - selects a plural form with {@link tChoice} using the built-in
 *   `Intl.PluralRules` for the locale — a plural key maps to an object keyed by
 *   category (`one`, `few`, `many`, `other`, ...), never a bespoke index.
 *
 * The translator holds the passed `messages` reference and never mutates it.
 * Locale resolution is from the explicit `locale`/`fallbackLocale` values only
 * (defaulting to `en`); errors are value-free {@link I18nError}s that never
 * echo a locale string.
 */

/** The default locale and fallback locale when neither is supplied. */
const DEFAULT_LOCALE = 'en';

/**
 * A nested message map: leaves are strings, interior nodes are further maps.
 * Plain JSON objects satisfy this shape directly.
 */
export interface Messages {
  readonly [key: string]: string | Messages;
}

/** A single node in a message map: a translated string or a nested map. */
export type MessageValue = string | Messages;

/** Placeholder values accepted by {@link Translator.t} and `tChoice`. */
export type TranslationParams = Readonly<Record<string, string | number>>;

/** Raised for invalid locales or message maps. Messages are value-free. */
export class I18nError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'I18nError';
  }
}

/** Options for {@link createTranslator}. */
export interface CreateTranslatorOptions {
  /** Nested message maps keyed by locale. Never mutated. */
  readonly messages: Messages;
  /** The active locale. Defaults to `en`. */
  readonly locale?: string;
  /** The fallback locale used when a key is missing. Defaults to `en`. */
  readonly fallbackLocale?: string;
}

/** A locale-scoped translator with dot-path lookup, interpolation, and plurals. */
export interface Translator {
  /**
   * Resolve `key` (dot-path) against the active locale, then the fallback
   * locale. `{name}` placeholders are replaced from `params`; placeholders
   * without a matching param are left as-is. Returns `key` when missing.
   */
  t(key: string, params?: TranslationParams): string;

  /**
   * Resolve a plural message for `key`: the resolved value is either a string
   * (returned as-is) or a category-keyed map selected by the locale's
   * `Intl.PluralRules` category for `count`. `{count}` is injected into
   * `params` unless the caller supplied it. Returns `key` when missing.
   */
  tChoice(key: string, count: number, params?: TranslationParams): string;

  /** The active locale. */
  locale(): string;

  /** The fallback locale. */
  fallbackLocale(): string;

  /** Return a new translator with the same messages and fallback but a new locale. */
  withLocale(locale: string): Translator;
}

const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

/** A shared empty map for a locale that has no messages. */
const EMPTY: Messages = Object.freeze({});

/** Build a `Intl.PluralRules` for `locale`, translating any failure to an I18nError. */
function pluralRulesFor(locale: string): Intl.PluralRules {
  if (typeof locale !== 'string' || locale.length === 0) {
    throw new I18nError('invalid locale');
  }
  try {
    // PluralRules construction is the strictest check: it throws a RangeError
    // for malformed or empty tags, and never falls back silently.
    return new Intl.PluralRules(locale);
  } catch {
    throw new I18nError('invalid locale');
  }
}

/** Coerce an unknown value into a `Messages` map or throw a value-free error. */
function assertMessages(value: unknown): Messages {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new I18nError('invalid messages');
  }
  return value as Messages;
}

/** The nested map for `locale`, or an empty map when absent or not an object. */
function mapFor(messages: Messages, locale: string): Messages {
  const entry = messages[locale];
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : EMPTY;
}

/** Walk `key`'s dot-path segments; `undefined` when any segment is missing. */
function lookup(messages: Messages, key: string): MessageValue | undefined {
  let node: MessageValue | undefined = messages;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      return undefined;
    }
    node = node[segment];
  }
  return node;
}

/** Replace `{name}` placeholders from `params`, leaving unknown ones as-is. */
function interpolate(template: string, params: TranslationParams | undefined): string {
  if (params === undefined) {
    return template;
  }
  return template.replace(PLACEHOLDER_PATTERN, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

/** Merge the auto-injected `count` with the caller's params (caller wins). */
function withCount(params: TranslationParams | undefined, count: number): TranslationParams {
  return params === undefined ? { count } : { count, ...params };
}

function makeTranslator(messages: Messages, locale: string, fallbackLocale: string): Translator {
  const pluralRules = pluralRulesFor(locale);
  const fallbackPluralRules = pluralRulesFor(fallbackLocale);

  return {
    t(key, params) {
      const value =
        lookup(mapFor(messages, locale), key) ?? lookup(mapFor(messages, fallbackLocale), key);
      return typeof value === 'string' ? interpolate(value, params) : key;
    },

    tChoice(key, count, params) {
      const local = lookup(mapFor(messages, locale), key);
      const value = local ?? lookup(mapFor(messages, fallbackLocale), key);
      if (value === undefined) {
        return key;
      }

      const effective = withCount(params, count);
      if (typeof value === 'string') {
        return interpolate(value, effective);
      }

      // Pick the plural form with the locale that actually owns the key, so a
      // fallback plural map uses the fallback locale's categories, not the
      // active locale's.
      const rules = local === undefined ? fallbackPluralRules : pluralRules;
      const form = value[rules.select(count)] ?? value.other;
      return typeof form === 'string' ? interpolate(form, effective) : key;
    },

    locale: () => locale,

    fallbackLocale: () => fallbackLocale,

    withLocale(next) {
      return makeTranslator(messages, next, fallbackLocale);
    },
  };
}

/**
 * Create a translator over `options.messages`. The `locale` and
 * `fallbackLocale` are validated eagerly (a malformed locale throws an
 * {@link I18nError} at construction, not on first lookup). Nothing is read from
 * the environment or the file system.
 */
export function createTranslator(options: CreateTranslatorOptions): Translator {
  const messages = assertMessages(options.messages);
  const locale = options.locale ?? DEFAULT_LOCALE;
  const fallbackLocale = options.fallbackLocale ?? DEFAULT_LOCALE;
  return makeTranslator(messages, locale, fallbackLocale);
}
