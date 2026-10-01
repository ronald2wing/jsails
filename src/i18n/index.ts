/**
 * Internationalization + pluralization (`jsails/i18n`).
 *
 * A dependency-free message translator over nested string maps loaded from
 * plain JSON/objects by the caller. Dot-path lookup, `{name}` interpolation,
 * `Intl.PluralRules`-driven plural selection, case-variant `:name` / `:Name` /
 * `:NAME` interpolation, scope/default/bulk lookup support, a missing-key
 * handler, and `localize`/`l` for date, number, currency, and percent
 * formatting — all without file-system or environment resolution.
 */

export {
  MessageTranslator,
  I18nError,
  type CreateTranslatorOptions,
  type Messages,
  type MessageValue,
  type TranslationOptions,
  type TranslationParams,
  type Translator,
} from './translator.js';

export { type LocalizeKind, type LocalizeOptions, createLocalizer } from './localize.js';

export { localizedPath, hreflang, hreflangRel } from './routing.js';
export type { HreflangLink, HreflangOptions } from './routing.js';
