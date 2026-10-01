/**
 * Ambient request locale holder, server-only (`node:async_hooks`).
 *
 * The i18n middleware wraps the rest of the request in
 * {@link withLocale}(resolved, ...) so every async continuation inside the
 * request sees the same locale. The {@link I18nService} reads the current
 * locale via {@link currentLocale}, falling back to the plugin's default when
 * no locale is set (e.g. outside a request).
 *
 * This mirrors the transaction ALS precedent in {@link src/facades/app-scope.ts}.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const localeALS = new AsyncLocalStorage<string>();

/**
 * Run `fn` with the given request locale ambient. The locale is active for the
 * synchronous body and every async continuation it awaits, and is restored on
 * return/throw. Nested calls shadow the outer locale.
 */
export function withLocale<T>(locale: string, fn: () => T): T {
  return localeALS.run(locale, fn);
}

/**
 * The current request locale, or `undefined` when no locale has been set
 * (outside a request, before the i18n middleware runs, or when the plugin is
 * absent).
 */
export function currentLocale(): string | undefined {
  return localeALS.getStore();
}
