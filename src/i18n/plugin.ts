/**
 * First-party `i18n` plugin: exposes an {@link I18nService} under a typed
 * service token, building a per-locale {@link MessageTranslator} from the
 * configured loader. The service reads the active locale from the ambient
 * request scope ({@link currentLocale}) and falls back to the plugin's default
 * when no locale is set.
 *
 * Construction is inert: no file is read until a `t`/`load` call. The plugin
 * owns no resources that need closing (the loader caches in memory), so cleanup
 * is a no-op.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { installFacades } from '../facades/facade.js';
import {
  I18nError,
  MessageTranslator,
  type Messages,
  type TranslationOptions,
  type TranslationParams,
  type Translator,
} from './translator.js';
import { type Loader, createArrayLoader } from './loader.js';
import { createFileLoader } from './catalog-loader.js';
import { currentLocale } from './request-locale.js';

/**
 * Opaque token for the application {@link I18nService}. Defined once here and
 * shared by the provider (`i18nPlugin`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const i18nToken: ServiceToken<I18nService> = createServiceToken<I18nService>('i18n');

/** Options accepted by {@link i18nPlugin}. */
export interface I18nPluginOptions {
  /** Default active locale. Defaults to `'en'`. */
  readonly locale?: string;
  /** Fallback locale. Defaults to `'en'`. */
  readonly fallbackLocale?: string;
  /** In-memory catalogs (tests/demos). Mutually exclusive with `loadPaths`. */
  readonly catalogs?: Readonly<Record<string, Messages>>;
  /** Filesystem load paths (server). Mutually exclusive with `catalogs`. */
  readonly loadPaths?: readonly string[];
  /**
   * Resolve the request locale. Receives the Request and the sovereign
   * RequestContext; returns a locale string or `undefined` to use the default.
   * A throw or rejection falls back to the default locale — the resolver must
   * never break the request.
   */
  readonly resolveLocale?: (
    request: Request,
    context: { readonly url: URL; readonly params: Record<string, string> },
  ) => string | undefined | Promise<string | undefined>;
}

/** Locale pattern used for validation (the same as in the catalog loader). */
const LOCALE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Validate a locale string; throws value-free `I18nError` on failure. */
function assertValidLocale(locale: string): void {
  if (typeof locale !== 'string' || locale.length === 0 || !LOCALE_PATTERN.test(locale)) {
    throw new I18nError('invalid locale');
  }
}

/** The ambient i18n service backed by a loader and per-locale translator cache. */
export interface I18nService {
  t(key: string, arg?: TranslationParams | TranslationOptions): string;
  t(keys: readonly string[], options?: TranslationOptions): string[];
  tChoice(key: string, count: number, arg?: TranslationParams | TranslationOptions): string;
  exists(key: string, options?: Pick<TranslationOptions, 'scope'>): boolean;
  localize(value: Date | number, options?: import('./localize.js').LocalizeOptions): string;
  /** Alias of {@link localize}. */
  l(value: Date | number, options?: import('./localize.js').LocalizeOptions): string;
  /** The resolved locale for the current request (or the default). */
  locale(): string;
  /** The configured fallback locale. */
  fallbackLocale(): string;
  /** Return a translator pinned to an explicit locale (bypasses the ambient scope). */
  withLocale(locale: string): Translator;
  /** Locales the loader can serve. */
  availableLocales(): readonly string[];
  /**
   * Resolve the request locale from the incoming Request and context. Uses the
   * plugin's configured `resolveLocale` callback; falls back to the default
   * locale when no callback is configured or when it throws/rejects. Never
   * throws — a misbehaving resolver returns the default, not an error.
   */
  resolveRequestLocale(
    request: Request,
    context: { readonly url: URL; readonly params: Record<string, string> },
  ): Promise<string>;
}

class I18nServiceImpl implements I18nService {
  readonly #defaultLocale: string;
  readonly #fallbackLocale: string;
  readonly #resolveLocale: I18nPluginOptions['resolveLocale'];
  readonly #availableLocales: readonly string[];
  readonly #baseTranslator: Translator;
  readonly #translators = new Map<string, Translator>();

  constructor(options: I18nPluginOptions, collected: CollectedCatalogs) {
    this.#defaultLocale = options.locale ?? 'en';
    this.#fallbackLocale = options.fallbackLocale ?? 'en';
    this.#resolveLocale = options.resolveLocale;
    this.#availableLocales = collected.availableLocales;

    assertValidLocale(this.#defaultLocale);
    assertValidLocale(this.#fallbackLocale);

    // One base translator over the FULL merged catalog (`{ en: {...}, fr: {...} }`),
    // built eagerly at setup. The active locale switches via `withLocale`, which
    // shares the same `messages` reference, so `t` is synchronous with no
    // per-call I/O and no empty-translator race.
    this.#baseTranslator = new MessageTranslator({
      messages: collected.messages,
      locale: this.#defaultLocale,
      fallbackLocale: this.#fallbackLocale,
    });
  }

  // ---- t ----------------------------------------------------------------

  t(key: string, arg?: TranslationParams | TranslationOptions): string;
  t(keys: readonly string[], options?: TranslationOptions): string[];
  t(
    keyOrKeys: string | readonly string[],
    arg?: TranslationParams | TranslationOptions,
  ): string | string[] {
    // Narrow the union for overload resolution: the underlying
    // MessageTranslator.t has separate overloads for string and
    // readonly string[], and TypeScript cannot resolve the union
    // against a single overload.
    if (typeof keyOrKeys === 'string') {
      return this.#activeTranslator().t(keyOrKeys, arg);
    }
    return this.#activeTranslator().t(keyOrKeys, arg);
  }

  // ---- tChoice ----------------------------------------------------------

  tChoice(key: string, count: number, arg?: TranslationParams | TranslationOptions): string {
    return this.#activeTranslator().tChoice(key, count, arg);
  }

  // ---- exists -----------------------------------------------------------

  exists(key: string, options?: Pick<TranslationOptions, 'scope'>): boolean {
    return this.#activeTranslator().exists(key, options);
  }

  // ---- localize / l -----------------------------------------------------

  localize(value: Date | number, options?: import('./localize.js').LocalizeOptions): string {
    return this.#activeTranslator().localize(value, options);
  }

  l(value: Date | number, options?: import('./localize.js').LocalizeOptions): string {
    return this.localize(value, options);
  }

  // ---- metadata ---------------------------------------------------------

  locale(): string {
    return currentLocale() ?? this.#defaultLocale;
  }

  fallbackLocale(): string {
    return this.#fallbackLocale;
  }

  withLocale(locale: string): Translator {
    return this.#baseTranslator.withLocale(locale);
  }

  availableLocales(): readonly string[] {
    return this.#availableLocales;
  }

  /**
   * Resolve the request locale safely: delegates to the configured
   * `resolveLocale` callback, falling back to the plugin default on any
   * failure (throw, rejection, or an invalid return value). Never throws.
   */
  async resolveRequestLocale(
    request: Request,
    context: { readonly url: URL; readonly params: Record<string, string> },
  ): Promise<string> {
    return resolveLocaleSafe(request, context, this.#resolveLocale, this.#defaultLocale);
  }

  // ---- internals ---------------------------------------------------------

  /**
   * Get (or build and memoize) the translator for the currently ambient locale.
   * All catalogs are preloaded at setup, so this is pure lookup + a cheap
   * `withLocale` — never I/O, never a partially-populated translator.
   */
  #activeTranslator(): Translator {
    const locale = currentLocale() ?? this.#defaultLocale;
    const existing = this.#translators.get(locale);
    if (existing !== undefined) return existing;
    const translator = this.#baseTranslator.withLocale(locale);
    this.#translators.set(locale, translator);
    return translator;
  }
}

/** Catalogs collected eagerly at setup: the merged locale map plus the list. */
interface CollectedCatalogs {
  readonly messages: Messages;
  readonly availableLocales: readonly string[];
}

/**
 * Load every catalog the loader can serve (plus the default and fallback
 * locales) into one merged `messages` map keyed by locale. Runs once at setup,
 * so the runtime translator is fully populated before any request.
 */
async function collectCatalogs(
  loader: Loader,
  defaultLocale: string,
  fallbackLocale: string,
): Promise<CollectedCatalogs> {
  // `availableLocales` reflects what the loader actually serves — not the
  // synthetic default/fallback locales (which the merged catalog still carries
  // so the fallback chain resolves even when the loader has no catalog).
  const availableLocales = [...(await loader.availableLocales())].sort();
  const locales = new Set<string>([defaultLocale, fallbackLocale, ...availableLocales]);
  const messages: Record<string, Messages> = {};
  for (const locale of locales) {
    const catalog = await loader.load(locale);
    if (catalog !== undefined) {
      messages[locale] = catalog;
    }
  }
  return { messages, availableLocales };
}

/**
 * Call the plugin's `resolveLocale` (fail-safe: a throw/rejection falls back
 * to the default). Validate the result against the locale pattern; an invalid
 * result also falls back to the default.
 */
async function resolveLocaleSafe(
  request: Request,
  context: { readonly url: URL; readonly params: Record<string, string> },
  resolver: I18nPluginOptions['resolveLocale'],
  defaultLocale: string,
): Promise<string> {
  if (resolver === undefined) return defaultLocale;

  let resolved: string | undefined;
  try {
    resolved = await resolver(request, context);
  } catch {
    return defaultLocale;
  }

  if (resolved === undefined || typeof resolved !== 'string' || !LOCALE_PATTERN.test(resolved)) {
    return defaultLocale;
  }

  return resolved;
}

/**
 * Build the first-party `i18n` plugin. Validation is eager and throws
 * `TypeError` / `I18nError` for malformed options; the returned plugin is
 * otherwise inert and opens no connection.
 */
export function i18nPlugin(options: I18nPluginOptions = {}): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('i18nPlugin requires an options object');
  }

  if (options.catalogs !== undefined && options.loadPaths !== undefined) {
    throw new TypeError('catalogs and loadPaths are mutually exclusive');
  }

  if (options.catalogs !== undefined) {
    if (
      options.catalogs === null ||
      typeof options.catalogs !== 'object' ||
      Array.isArray(options.catalogs)
    ) {
      throw new TypeError('catalogs must be a record of locale → messages');
    }
  }

  if (options.loadPaths !== undefined) {
    if (!Array.isArray(options.loadPaths)) {
      throw new TypeError('loadPaths must be an array of strings');
    }
    for (const path of options.loadPaths) {
      if (typeof path !== 'string' || path.length === 0) {
        throw new TypeError('loadPaths entries must be non-empty strings');
      }
    }
  }

  if (options.resolveLocale !== undefined && typeof options.resolveLocale !== 'function') {
    throw new TypeError('resolveLocale must be a function');
  }

  return definePlugin({
    name: 'i18n',
    async setup({ services }) {
      const defaultLocale = options.locale ?? 'en';
      const fallbackLocale = options.fallbackLocale ?? 'en';
      const loader: Loader =
        options.catalogs !== undefined
          ? createArrayLoader(options.catalogs)
          : options.loadPaths !== undefined
            ? createFileLoader({ loadPaths: options.loadPaths })
            : createArrayLoader({});

      // Eagerly load every catalog once at setup so the runtime translator is
      // fully populated before any request; `t` stays synchronous (like Rails'
      // `eager_load!` and Laravel's synchronous load-on-first-use).
      const collected = await collectCatalogs(loader, defaultLocale, fallbackLocale);

      const service = new I18nServiceImpl(options, collected);
      services.provide(i18nToken, service);

      // Publish the facade as a global so `I18n.t('nav.home')` works with no
      // import. The proxy is memoized per token, so re-installing is idempotent.
      // The dynamic import breaks the facade↔plugin module cycle: `facade.ts`
      // statically imports `i18nToken` from this module, so this module must not
      // statically import `facade.ts`.
      const { I18n: I18nFacade } = await import('./facade.js');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      installFacades({ I18n: I18nFacade as object });
    },
  });
}
