/**
 * Internationalization + pluralization (`jsails/i18n`).
 *
 * A dependency-free message translator over nested string maps loaded from
 * plain JSON/objects by the caller. Dot-path lookup, `{name}` interpolation,
 * and `Intl.PluralRules`-driven plural selection; no file-system or
 * environment resolution lives in this slice.
 */

export {
  createTranslator,
  I18nError,
  type CreateTranslatorOptions,
  type Messages,
  type MessageValue,
  type TranslationParams,
  type Translator,
} from './translator.js';
