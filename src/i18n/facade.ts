/**
 * i18n facade + bare import-scoped helpers (server-only).
 *
 * The `I18n` proxy resolves through the ambient application scope and delegates
 * to the {@link I18nService} provided by {@link i18nPlugin}. Outside a request
 * the service falls back to the default locale — it never throws.
 *
 * `t` / `l` / `choice` are the Laravel `__()`-style terse re-exports. They are
 * deliberately NOT globals: `t` collides with `node:test` and i18next. Instead
 * they are bare named exports from `jsails/i18n/server` for `import { t } from
 * 'jsails/i18n/server'`.
 *
 * The facade is a Proxy (memoized per token), so bare helpers wrap the Proxy
 * with lazy delegation rather than binding at import time.
 */

import { facade } from '../facades/facade.js';
import { i18nToken, type I18nService } from './plugin.js';

/** Ambient translator facade, the global authoring surface: `I18n.t('nav.home')`. */
export const I18n: I18nService = facade(i18nToken);

/**
 * Bare `t` helper — the same ambient-locale resolution as `I18n.t`, module-scoped.
 * Delegates lazily to the facade Proxy so per-request locale resolution works.
 */
export function t(key: string, options?: Parameters<I18nService['t']>[1]): string {
  return (I18n.t as (k: string, o?: Parameters<I18nService['t']>[1]) => string)(key, options);
}

/**
 * Bare `l` (localize) helper — alias of `I18n.l`.
 */
export function l(value: Date | number, options?: Parameters<I18nService['l']>[1]): string {
  return I18n.l(value, options);
}

/**
 * Bare `choice` helper — alias of `I18n.tChoice`.
 */
export function choice(
  key: string,
  count: number,
  options?: Parameters<I18nService['tChoice']>[2],
): string {
  return I18n.tChoice(key, count, options);
}
