import prettyBytes from 'pretty-bytes';
import {
  dinero,
  add as dineroAdd,
  subtract as dineroSubtract,
  compare as dineroCompare,
  toSnapshot,
  type Dinero,
  type DineroCurrency,
} from 'dinero.js';
import * as allCurrencies from 'dinero.js/currencies';
import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Currency lookup (built once at module load)
// ---------------------------------------------------------------------------

type CurrencyObject = DineroCurrency<number, string>;

const currencyByCode: Record<string, CurrencyObject> = {};

for (const [key, value] of Object.entries(allCurrencies)) {
  if (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    'exponent' in value &&
    typeof (value as Record<string, unknown>).code === 'string'
  ) {
    currencyByCode[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class NumError extends SupportError {
  readonly code = 'invalid_argument';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNumber(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new NumError('Num: expected a finite number');
  }
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new NumError('Num: expected a string');
  }
}

function isDinero(value: unknown): value is Dinero<number> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getCurrencyExponent(currencyCode: string): number {
  const descriptor = currencyByCode[currencyCode];
  if (!descriptor) {
    throw new NumError('Num: unknown currency code');
  }
  return descriptor.exponent;
}

// ---------------------------------------------------------------------------
// Native Intl wrappers
// ---------------------------------------------------------------------------

export function format(value: number, options?: Intl.NumberFormatOptions, locale?: string): string {
  assertNumber(value);
  return new Intl.NumberFormat(locale, options).format(value);
}

export function compact(value: number, locale?: string): string {
  assertNumber(value);
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
  }).format(value);
}

export function currency(value: number, currencyCode: string, locale?: string): string {
  assertNumber(value);
  assertString(currencyCode);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
  }).format(value);
}

export function percent(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale?: string,
): string {
  assertNumber(value);
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    ...options,
  }).format(value);
}

export function unit(
  value: number,
  unitName: string,
  options?: Intl.NumberFormatOptions,
  locale?: string,
): string {
  assertNumber(value);
  assertString(unitName);
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: unitName,
    ...options,
  }).format(value);
}

// ---------------------------------------------------------------------------
// pretty-bytes wrapper
// ---------------------------------------------------------------------------

export function bytes(value: number, options?: { binary?: boolean }): string {
  assertNumber(value);
  return prettyBytes(value, options);
}

// ---------------------------------------------------------------------------
// Intl.PluralRules wrapper
// ---------------------------------------------------------------------------

export function ordinal(value: number, locale?: string): string {
  assertNumber(value);
  if (!Number.isInteger(value)) {
    throw new NumError('Num: ordinal requires an integer');
  }
  const rules = new Intl.PluralRules(locale ?? 'en', { type: 'ordinal' });
  const suffix = rules.select(value);
  return `${value}${getOrdinalSuffix(locale ?? 'en', value, suffix)}`;
}

function getOrdinalSuffix(locale: string, _value: number, category: string): string {
  // For most locales we can use the CLDR-derived ordinal patterns.
  // English is the common case — map plural categories to suffixes.
  if (locale.startsWith('en')) {
    switch (category) {
      case 'one':
        return 'st';
      case 'two':
        return 'nd';
      case 'few':
        return 'rd';
      default:
        return 'th';
    }
  }
  // For other locales return the ordinal indicator via Intl.NumberFormat
  // in a future enhancement. For now return a dot (common in many locales).
  return '.';
}

// ---------------------------------------------------------------------------
// Own helpers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  assertNumber(value);
  assertNumber(min);
  assertNumber(max);
  if (min > max) {
    throw new NumError('Num: clamp min must not exceed max');
  }
  return Math.min(Math.max(value, min), max);
}

export function round(value: number, precision?: number): number {
  assertNumber(value);
  const p = precision ?? 0;
  if (!Number.isInteger(p) || p < 0) {
    throw new NumError('Num: round precision must be a non-negative integer');
  }
  const factor = 10 ** p;
  return Math.round(value * factor) / factor;
}

export function parse(input: string): number {
  assertString(input);
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new NumError('Num: cannot parse an empty string as a number');
  }
  const result = Number(trimmed);
  if (!Number.isFinite(result)) {
    throw new NumError('Num: cannot parse value as a finite number');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Money arithmetic (dinero.js)
// ---------------------------------------------------------------------------

export function money(amount: number | string, currencyCode: string): Dinero<number> {
  const exponent = getCurrencyExponent(currencyCode);
  const numeric = typeof amount === 'string' ? parse(amount) : amount;
  assertNumber(numeric);

  const minorUnits = Math.round(numeric * 10 ** exponent);
  const currencyObj = currencyByCode[currencyCode]!;

  return dinero({
    amount: minorUnits,
    currency: currencyObj,
  });
}

// Arithmetic on `money` values, re-exported so callers compose through `Num`
// without importing `dinero.js` directly (sovereign-surface rule, design §1.1).
export const add = dineroAdd;
export const subtract = dineroSubtract;
export const compare = dineroCompare;

// ---------------------------------------------------------------------------
// Money display (Intl.NumberFormat + accounting/minor-unit gaps)
// ---------------------------------------------------------------------------

export interface FormatMoneyOptions {
  locale?: string;
  accounting?: boolean;
  minorUnits?: number;
  currency?: string;
}

export function formatMoney(
  amount: Dinero<number> | number | string,
  options: FormatMoneyOptions,
): string {
  let numericValue: number;
  let currencyCode: string;
  let exponent: number;

  if (isDinero(amount)) {
    const snap = toSnapshot(amount);
    exponent = options.minorUnits ?? snap.currency.exponent;
    numericValue = snap.amount / 10 ** snap.currency.exponent;
    currencyCode = snap.currency.code;
  } else {
    numericValue = typeof amount === 'string' ? parse(amount) : amount;
    assertNumber(numericValue);
    if (!options.currency) {
      throw new NumError('Num: formatMoney requires a currency option for non-Money input');
    }
    currencyCode = options.currency;
    exponent = options.minorUnits ?? getCurrencyExponent(currencyCode);
  }

  if (!Number.isFinite(exponent) || exponent < 0) {
    throw new NumError('Num: formatMoney minorUnits must be a non-negative integer');
  }

  const formatOptions: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  };

  if (options.accounting) {
    formatOptions.currencySign = 'accounting';
  }

  return new Intl.NumberFormat(options.locale, formatOptions).format(numericValue);
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Num = Object.freeze({
  format,
  compact,
  currency,
  percent,
  unit,
  bytes,
  ordinal,
  clamp,
  round,
  parse,
  money,
  add,
  subtract,
  compare,
  formatMoney,
});
