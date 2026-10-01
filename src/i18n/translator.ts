/**
 * Internationalization: a message translator over plain nested string maps.
 *
 * This slice is deliberately dependency-free and does no file-system or
 * environment resolution: the caller owns loading messages (from plain JSON or
 * objects) and passes them to {@link MessageTranslator}. The translator then:
 *
 * - resolves a dot-path key (`nav.home`) against the active locale's map, then
 *   the fallback locale's map, and finally returns the key itself when neither
 *   has it;
 * - interpolates `{name}` placeholders with `t(key, params)` (values are
 *   stringified; escaping is the caller's job);
 * - selects a plural form with {@link tChoice} using the built-in
 *   `Intl.PluralRules` for the locale — a plural key maps to an object keyed by
 *   category (`one`, `few`, `many`, `other`, ...), never a bespoke index;
 * - scopes keys with `options.scope`, falls back through `options.default`
 *   entries, and supports bulk array lookup;
 * - accepts a missing-key handler (`onMissing`) called when neither locale has
 *   the key and no default resolved;
 * - interpolates case-variant placeholders `:name` / `:Name` / `:NAME` in
 *   addition to `{name}`;
 * - provides `localize`/`l` for date, number, currency, and percent formatting
 *   backed by `Intl`.
 *
 * The translator holds the passed `messages` reference and never mutates it.
 * Locale resolution is from the explicit `locale`/`fallbackLocale` values only
 * (defaulting to `en`); errors are value-free {@link I18nError}s that never
 * echo a locale string.
 */

import { createLocalizer, type LocalizeOptions } from './localize.js';

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

/**
 * Options accepted by `t`/`tChoice` beyond interpolation params.
 *
 * When the second argument to `t` or `tChoice` carries `scope` or `default`
 * keys it is treated as `TranslationOptions`; otherwise it is treated as
 * plain {@link TranslationParams}.
 */
export interface TranslationOptions {
  /**
   * Dot-segment scope(s) prepended to `key`. A string is split on `.`; an array
   * is flattened. `t('short', { scope: ['date', 'formats'] })` is equivalent to
   * `t('date.formats.short')`. Empty segments are rejected.
   */
  readonly scope?: string | readonly string[];

  /**
   * Fallback(s) tried in order when `key` is missing. Each entry is either a
   * literal string (returned as-is, interpolated) or a `{ key: string }` object
   * naming another key to resolve. An array is tried left-to-right.
   */
  readonly default?:
    string | { readonly key: string } | readonly (string | { readonly key: string })[];

  /** Interpolation values. */
  readonly params?: TranslationParams;
}

/** Raised for invalid locales or message maps. Messages are value-free. */
export class I18nError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'I18nError';
  }
}

/** Options for {@link MessageTranslator}. */
export interface CreateTranslatorOptions {
  /** Nested message maps keyed by locale. Never mutated. */
  readonly messages: Messages;

  /** The active locale. Defaults to `en`. */
  readonly locale?: string;

  /** The fallback locale used when a key is missing. Defaults to `en`. */
  readonly fallbackLocale?: string;

  /**
   * Called when a key resolves in neither the active nor the fallback locale
   * and no `default` matched. Receives the scoped key and the active locale;
   * returns the string to use, or `undefined` to fall through to the default
   * `key`-echo behavior. Never called for `exists()`.
   *
   * A throwing handler is swallowed and falls through to the key echo.
   */
  readonly onMissing?: (key: string, locale: string) => string | undefined;
}

/** A locale-scoped translator with dot-path lookup, interpolation, plurals, localisation. */
export interface Translator {
  /**
   * Resolve `key` (dot-path) against the active locale, then the fallback
   * locale. `{name}` placeholders are replaced from `params`; placeholders
   * without a matching param are left as-is. Returns `key` when missing.
   *
   * When the argument carries `scope` or `default` keys it is treated
   * as {@link TranslationOptions}, otherwise as {@link TranslationParams}.
   */
  t(key: string, arg?: TranslationParams | TranslationOptions): string;

  /**
   * Bulk lookup: resolves each key with the same options and returns an array
   * in input order. Missing keys echo the key itself.
   */
  t(keys: readonly string[], options?: TranslationOptions): string[];

  /**
   * Resolve a plural message for `key`: the resolved value is either a string
   * (returned as-is) or a category-keyed map selected by the locale's
   * `Intl.PluralRules` category for `count`. `{count}` is injected into
   * `params` unless the caller supplied it. Returns `key` when missing.
   *
   * When the third argument carries `scope` or `default` keys it is treated
   * as {@link TranslationOptions}.
   */
  tChoice(key: string, count: number, arg?: TranslationParams | TranslationOptions): string;

  /**
   * Whether `key` resolves in the active or fallback locale (no `default`).
   * Returns `true` when the looked-up value is defined, `false` otherwise.
   */
  exists(key: string, options?: Pick<TranslationOptions, 'scope'>): boolean;

  /**
   * Localize a date, number, currency, or percent value.
   * Delegates to a locale-bound `Intl` formatter.
   */
  localize(value: Date | number, options?: LocalizeOptions): string;

  /** Alias of {@link localize}, matching Rails' `I18n.l`. */
  l(value: Date | number, options?: LocalizeOptions): string;

  /** The active locale. */
  locale(): string;

  /** The fallback locale. */
  fallbackLocale(): string;

  /** Return a new translator with the same messages and fallback but a new locale. */
  withLocale(locale: string): Translator;
}

/** Keys that must not appear in `TranslationOptions.params`. */
const RESERVED_OPTION_NAMES: readonly string[] = ['scope', 'default'];

const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

/** Matches `:name`, `:Name`, `:NAME` — a colon followed by one or more identifier chars. */
const CASE_PLACEHOLDER_PATTERN = /:([A-Za-z_][A-Za-z0-9_]*)/g;

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

/**
 * Determine whether `arg` is `TranslationOptions` (vs `TranslationParams`).
 * An object carrying `scope` or `default` is treated as options.
 */
function isTranslationOptions(
  arg: TranslationParams | TranslationOptions,
): arg is TranslationOptions {
  return typeof arg === 'object' && arg !== null && ('scope' in arg || 'default' in arg);
}

/**
 * Reject any `params` key that collides with a reserved option name
 * (`scope`, `default`).
 */
function checkReservedParams(params: TranslationParams | undefined): void {
  if (params === undefined) {
    return;
  }
  for (const name of RESERVED_OPTION_NAMES) {
    if (name in params) {
      throw new I18nError('reserved option name');
    }
  }
}

/**
 * Prepend scope segment(s) to `key`. A string is split on `.`;
 * an array is flattened in order. Empty segments are rejected.
 */
function resolveScope(key: string, scope: string | readonly string[]): string {
  const segments: string[] = [];
  const append = (source: string | readonly string[]): void => {
    if (typeof source === 'string') {
      for (const s of source.split('.')) {
        if (s.length === 0) {
          throw new I18nError('invalid scope');
        }
        segments.push(s);
      }
    } else {
      for (const s of source) {
        if (typeof s !== 'string' || s.length === 0) {
          throw new I18nError('invalid scope');
        }
        segments.push(s);
      }
    }
  };

  append(scope);
  segments.push(key);
  return segments.join('.');
}

/**
 * Try default entries left-to-right. Each entry is a literal string
 * (returned as-is, interpolated) or a `{ key: string }` object resolving
 * to another key. Returns `undefined` when no entry produces a string.
 */
function resolveDefault(
  def: Readonly<TranslationOptions['default']>,
  params: TranslationParams | undefined,
  messages: Messages,
  locale: string,
  fallbackLocale: string,
  templateLocale: string,
): string | undefined {
  if (def === undefined) {
    return undefined;
  }

  // Single-literal string.
  if (typeof def === 'string') {
    return interpolate(def, params, templateLocale);
  }

  // Single { key: string } object vs array.
  if (Array.isArray(def)) {
    // Array of literals or { key } objects.
    for (const entry of def) {
      if (typeof entry === 'string') {
        return interpolate(entry, params, templateLocale);
      }

      const resolvedKey = entry.key;
      const value =
        lookup(mapFor(messages, locale), resolvedKey) ??
        lookup(mapFor(messages, fallbackLocale), resolvedKey);
      if (typeof value === 'string') {
        return interpolate(value, params, templateLocale);
      }
    }

    return undefined;
  }

  // Remaining case: single { key: string } object.
  {
    const value =
      lookup(mapFor(messages, locale), (def as { readonly key: string }).key) ??
      lookup(mapFor(messages, fallbackLocale), (def as { readonly key: string }).key);
    return typeof value === 'string' ? interpolate(value, params, templateLocale) : undefined;
  }
}

/**
 * Replace `{name}` placeholders from `params`, then apply case-variant
 * `:name` / `:Name` / `:NAME` interpolation.
 *
 * Unknown `{name}` and `:name` placeholders are left as-is.
 * Case transforms use `toLocaleUpperCase`/`toLocaleLowerCase` with `locale`.
 */
function interpolate(
  template: string,
  params: TranslationParams | undefined,
  locale: string,
): string {
  let result = template;

  if (params !== undefined) {
    // First pass: {name}
    result = result.replace(PLACEHOLDER_PATTERN, (placeholder, name: string) => {
      const value = params[name];
      return value === undefined ? placeholder : String(value);
    });

    // Second pass: :name / :Name / :NAME
    result = result.replace(CASE_PLACEHOLDER_PATTERN, (placeholder, name: string) => {
      let value: unknown = params[name];
      // When the exact key (e.g. "Name" from ":Name") is not found,
      // try the lowercased form ("name") — callers pass a single set
      // of params keyed by the lowercased identifier.
      if (value === undefined) {
        value = params[name.toLowerCase()];
      }
      if (value === undefined) {
        return placeholder;
      }
      const str = String(value);

      // :NAME — all uppercase, at least one alphabetic character
      if (/^[A-Z]+$/.test(name) && /[A-Z]/.test(name)) {
        return str.toLocaleUpperCase(locale);
      }

      // :Name — starts uppercase, rest lowercase
      if (/^[A-Z][a-z]+$/.test(name)) {
        return str.charAt(0).toLocaleUpperCase(locale) + str.slice(1);
      }

      // :name — as-is
      return str;
    });
  }

  return result;
}

/** Merge the auto-injected `count` with the caller's params (caller wins). */
function withCount(params: TranslationParams | undefined, count: number): TranslationParams {
  return params === undefined ? { count } : { count, ...params };
}

/**
 * Build a translator over `options.messages`. The `locale` and
 * `fallbackLocale` are validated eagerly (a malformed locale throws an
 * {@link I18nError} at construction, not on first lookup). Nothing is read from
 * the environment or the file system.
 */
export class MessageTranslator implements Translator {
  readonly #messages: Messages;
  readonly #locale: string;
  readonly #fallbackLocale: string;
  readonly #pluralRules: Intl.PluralRules;
  readonly #fallbackPluralRules: Intl.PluralRules;
  readonly #onMissing: ((key: string, locale: string) => string | undefined) | undefined;
  readonly #localizer: ReturnType<typeof createLocalizer>;

  constructor(options: CreateTranslatorOptions) {
    this.#messages = assertMessages(options.messages);
    this.#locale = options.locale ?? DEFAULT_LOCALE;
    this.#fallbackLocale = options.fallbackLocale ?? DEFAULT_LOCALE;
    this.#pluralRules = pluralRulesFor(this.#locale);
    this.#fallbackPluralRules = pluralRulesFor(this.#fallbackLocale);
    this.#onMissing = options.onMissing;
    this.#localizer = createLocalizer(this.#locale);
  }

  // ---- t ----------------------------------------------------------------

  t(key: string, arg?: TranslationParams | TranslationOptions): string;
  t(keys: readonly string[], options?: TranslationOptions): string[];
  t(
    keyOrKeys: string | readonly string[],
    arg?: TranslationParams | TranslationOptions,
  ): string | string[] {
    return typeof keyOrKeys === 'string'
      ? this.#tSingle(keyOrKeys, arg)
      : keyOrKeys.map((k) => this.#tSingleOptions(k, arg as TranslationOptions | undefined));
  }

  /** Single-key lookup for bulk (array) path — arg is always TranslationOptions. */
  #tSingleOptions(key: string, arg?: TranslationOptions): string {
    if (arg === undefined) {
      // No options — plain lookup with onMissing fallback.
      const value =
        lookup(mapFor(this.#messages, this.#locale), key) ??
        lookup(mapFor(this.#messages, this.#fallbackLocale), key);
      if (typeof value === 'string') {
        return value;
      }
      if (this.#onMissing !== undefined) {
        try {
          const handlerResult = this.#onMissing(key, this.#locale);
          if (typeof handlerResult === 'string') {
            return handlerResult;
          }
        } catch {
          // Swallowed — fall through to key echo.
        }
      }
      return key;
    }

    checkReservedParams(arg.params);

    const scoped = arg.scope !== undefined ? resolveScope(key, arg.scope) : key;

    const value =
      lookup(mapFor(this.#messages, this.#locale), scoped) ??
      lookup(mapFor(this.#messages, this.#fallbackLocale), scoped);

    if (typeof value === 'string') {
      return interpolate(value, arg.params, this.#locale);
    }

    // Try defaults.
    if (arg.default !== undefined) {
      const defaultResult = resolveDefault(
        arg.default,
        arg.params,
        this.#messages,
        this.#locale,
        this.#fallbackLocale,
        this.#locale,
      );
      if (defaultResult !== undefined) {
        return defaultResult;
      }
    }

    // onMissing handler.
    if (this.#onMissing !== undefined) {
      try {
        const handlerResult = this.#onMissing(scoped, this.#locale);
        if (typeof handlerResult === 'string') {
          return interpolate(handlerResult, arg.params, this.#locale);
        }
      } catch {
        // Swallowed — fall through to key echo.
      }
    }

    return scoped;
  }

  /** Single-key lookup with options/params discrimination. */
  #tSingle(key: string, arg?: TranslationParams | TranslationOptions): string {
    if (arg !== undefined && isTranslationOptions(arg)) {
      checkReservedParams(arg.params);

      const scoped = arg.scope !== undefined ? resolveScope(key, arg.scope) : key;

      const value =
        lookup(mapFor(this.#messages, this.#locale), scoped) ??
        lookup(mapFor(this.#messages, this.#fallbackLocale), scoped);

      if (typeof value === 'string') {
        return interpolate(value, arg.params, this.#locale);
      }

      // Try defaults.
      if (arg.default !== undefined) {
        const defaultResult = resolveDefault(
          arg.default,
          arg.params,
          this.#messages,
          this.#locale,
          this.#fallbackLocale,
          this.#locale,
        );
        if (defaultResult !== undefined) {
          return defaultResult;
        }
      }

      // onMissing handler.
      if (this.#onMissing !== undefined) {
        try {
          const handlerResult = this.#onMissing(scoped, this.#locale);
          if (typeof handlerResult === 'string') {
            return interpolate(handlerResult, arg.params, this.#locale);
          }
        } catch {
          // Swallowed — fall through to key echo.
        }
      }

      return scoped;
    }

    // Plain params path (backward-compatible with existing callers).
    const params = arg;
    const value =
      lookup(mapFor(this.#messages, this.#locale), key) ??
      lookup(mapFor(this.#messages, this.#fallbackLocale), key);
    if (typeof value === 'string') {
      return interpolate(value, params, this.#locale);
    }

    // onMissing handler — invoked even in the plain params path when
    // the key is not found and no TranslationOptions wrapper exists.
    if (this.#onMissing !== undefined) {
      try {
        const handlerResult = this.#onMissing(key, this.#locale);
        if (typeof handlerResult === 'string') {
          return interpolate(handlerResult, params, this.#locale);
        }
      } catch {
        // Swallowed — fall through to key echo.
      }
    }

    return key;
  }

  // ---- tChoice ----------------------------------------------------------

  tChoice(key: string, count: number, arg?: TranslationParams | TranslationOptions): string {
    if (arg !== undefined && isTranslationOptions(arg)) {
      checkReservedParams(arg.params);

      const scoped = arg.scope !== undefined ? resolveScope(key, arg.scope) : key;

      const local = lookup(mapFor(this.#messages, this.#locale), scoped);
      const value = local ?? lookup(mapFor(this.#messages, this.#fallbackLocale), scoped);

      if (value === undefined) {
        // Try defaults.
        if (arg.default !== undefined) {
          const defaultResult = resolveDefault(
            arg.default,
            arg.params,
            this.#messages,
            this.#locale,
            this.#fallbackLocale,
            this.#locale,
          );
          if (defaultResult !== undefined) {
            return defaultResult;
          }
        }

        // onMissing handler.
        if (this.#onMissing !== undefined) {
          try {
            const handlerResult = this.#onMissing(scoped, this.#locale);
            if (typeof handlerResult === 'string') {
              return interpolate(handlerResult, arg.params, this.#locale);
            }
          } catch {
            // Swallowed.
          }
        }

        return scoped;
      }

      const effective = withCount(arg.params, count);

      if (typeof value === 'string') {
        return interpolate(value, effective, this.#locale);
      }

      // Pick the plural form with the locale that actually owns the key.
      const rules = local === undefined ? this.#fallbackPluralRules : this.#pluralRules;
      const form = value[rules.select(count)] ?? value.other;
      return typeof form === 'string' ? interpolate(form, effective, this.#locale) : scoped;
    }

    // Plain params path (backward-compatible).
    const params = arg;

    const local = lookup(mapFor(this.#messages, this.#locale), key);
    const value = local ?? lookup(mapFor(this.#messages, this.#fallbackLocale), key);
    if (value === undefined) {
      // onMissing handler for plain params path.
      if (this.#onMissing !== undefined) {
        try {
          const handlerResult = this.#onMissing(key, this.#locale);
          if (typeof handlerResult === 'string') {
            return interpolate(handlerResult, withCount(params, count), this.#locale);
          }
        } catch {
          // Swallowed.
        }
      }
      return key;
    }

    const effective = withCount(params, count);
    if (typeof value === 'string') {
      return interpolate(value, effective, this.#locale);
    }

    // Pick the plural form with the locale that actually owns the key, so a
    // fallback plural map uses the fallback locale's categories, not the
    // active locale's.
    const rules = local === undefined ? this.#fallbackPluralRules : this.#pluralRules;
    const form = value[rules.select(count)] ?? value.other;
    return typeof form === 'string' ? interpolate(form, effective, this.#locale) : key;
  }

  // ---- exists -----------------------------------------------------------

  exists(key: string, options?: Pick<TranslationOptions, 'scope'>): boolean {
    const scoped = options?.scope !== undefined ? resolveScope(key, options.scope) : key;
    const value =
      lookup(mapFor(this.#messages, this.#locale), scoped) ??
      lookup(mapFor(this.#messages, this.#fallbackLocale), scoped);
    return value !== undefined;
  }

  // ---- localize / l -----------------------------------------------------

  localize(value: Date | number, options?: LocalizeOptions): string {
    return this.#localizer(value, options);
  }

  l(value: Date | number, options?: LocalizeOptions): string {
    return this.localize(value, options);
  }

  // ---- metadata ---------------------------------------------------------

  locale(): string {
    return this.#locale;
  }

  fallbackLocale(): string {
    return this.#fallbackLocale;
  }

  withLocale(next: string): Translator {
    return new MessageTranslator({
      messages: this.#messages,
      locale: next,
      fallbackLocale: this.#fallbackLocale,
      onMissing: this.#onMissing,
    });
  }
}
