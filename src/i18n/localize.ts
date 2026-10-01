/**
 * Value localisation: date, time, datetime, number, currency, and percent
 * formatting built on `Intl` (dependency-free, browser-safe).
 *
 * The translator's `localize`/`l` methods delegate to a localizer built once
 * in the constructor. Callers that need a standalone formatter call
 * `createLocalizer(locale)` directly.
 *
 * Deliberate limit: no `strftime`-style format strings — expose `Intl` option
 * fields instead.
 */

import { I18nError } from './translator.js';

/** What kind of value is being localised. */
export type LocalizeKind = 'date' | 'time' | 'datetime' | 'number' | 'currency' | 'percent';

/** Options accepted by a localizer call. */
export interface LocalizeOptions {
  /** The value kind. Defaults to `'date'` for a `Date`, `'number'` for a number. */
  readonly kind?: LocalizeKind;
  /** ISO 4217 code, required when `kind: 'currency'`. */
  readonly currency?: string;
  /** BCP-47 locale override; defaults to the translator's active locale. */
  readonly locale?: string;
  /** `Intl.DateTimeFormat` options, passed through. */
  readonly dateStyle?: 'full' | 'long' | 'medium' | 'short';
  readonly timeStyle?: 'full' | 'long' | 'medium' | 'short';
  /** `Intl.NumberFormat` options, passed through. */
  readonly minimumFractionDigits?: number;
  readonly maximumFractionDigits?: number;
  readonly timeZone?: string;
}

/** Validate a BCP-47 locale through `Intl.PluralRules`, mirroring the
 *  constructor-level check in `MessageTranslator`. `message` lets the caller
 *  surface the context-appropriate error (`'invalid locale'` at construction,
 *  `'invalid localize options'` for a per-call override). */
function assertValidLocale(locale: string, message = 'invalid locale'): void {
  if (typeof locale !== 'string' || locale.length === 0) {
    throw new I18nError(message);
  }
  try {
    // PluralRules is the strictest Intl check — it throws RangeError for
    // malformed or empty tags, and never falls back silently.
    void new Intl.PluralRules(locale);
  } catch {
    throw new I18nError(message);
  }
}

/**
 * Build a locale-bound localizer. The returned function is pure and performs
 * no I/O — every call resolves through `Intl` formatters.
 */
export function createLocalizer(
  locale: string,
): (value: Date | number, options?: LocalizeOptions) => string {
  assertValidLocale(locale);
  return (value: Date | number, options?: LocalizeOptions): string => {
    const kind = options?.kind ?? (value instanceof Date ? 'date' : 'number');
    const effectiveLocale = options?.locale ?? locale;

    // Validate the effective locale when it differs from the constructed one.
    if (options?.locale !== undefined && options.locale !== locale) {
      assertValidLocale(options.locale, 'invalid localize options');
    }

    switch (kind) {
      case 'date':
      case 'time':
      case 'datetime': {
        const formatOptions: Intl.DateTimeFormatOptions = {};
        if (options?.timeZone !== undefined) {
          formatOptions.timeZone = options.timeZone;
        }
        if (kind === 'datetime') {
          formatOptions.dateStyle = options?.dateStyle ?? 'long';
          formatOptions.timeStyle = options?.timeStyle ?? 'short';
        } else if (kind === 'date') {
          formatOptions.dateStyle = options?.dateStyle ?? 'long';
        } else {
          formatOptions.timeStyle = options?.timeStyle ?? 'short';
        }
        try {
          return new Intl.DateTimeFormat(effectiveLocale, formatOptions).format(value);
        } catch {
          throw new I18nError('invalid localize options');
        }
      }

      case 'currency': {
        if (options?.currency === undefined || options.currency.length === 0) {
          throw new I18nError('currency code required');
        }
        try {
          return new Intl.NumberFormat(effectiveLocale, {
            style: 'currency',
            currency: options.currency,
            minimumFractionDigits: options?.minimumFractionDigits,
            maximumFractionDigits: options?.maximumFractionDigits,
          }).format(value as number);
        } catch {
          throw new I18nError('invalid localize options');
        }
      }

      case 'percent': {
        try {
          return new Intl.NumberFormat(effectiveLocale, {
            style: 'percent',
            minimumFractionDigits: options?.minimumFractionDigits,
            maximumFractionDigits: options?.maximumFractionDigits,
          }).format(value as number);
        } catch {
          throw new I18nError('invalid localize options');
        }
      }

      case 'number': {
        try {
          return new Intl.NumberFormat(effectiveLocale, {
            minimumFractionDigits: options?.minimumFractionDigits,
            maximumFractionDigits: options?.maximumFractionDigits,
          }).format(value as number);
        } catch {
          throw new I18nError('invalid localize options');
        }
      }

      default:
        throw new I18nError('invalid localize options');
    }
  };
}
