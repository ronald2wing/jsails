import {
  add as dfAdd,
  differenceInDays,
  differenceInHours,
  differenceInMilliseconds,
  differenceInMinutes,
  differenceInMonths,
  differenceInSeconds,
  differenceInWeeks,
  differenceInYears,
  endOfDay,
  endOfHour,
  endOfMinute,
  endOfMonth,
  endOfSecond,
  endOfWeek,
  endOfYear,
  isFuture,
  isPast,
  isToday,
  parseISO,
  startOfDay,
  startOfHour,
  startOfMinute,
  startOfMonth,
  startOfSecond,
  startOfWeek,
  startOfYear,
  sub as dfSub,
} from 'date-fns';
import msParser from 'ms';
import prettyMs from 'pretty-ms';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export class TimeError extends SupportError {
  readonly code = 'invalid_argument';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimeUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second' | 'ms';

/** A value that can be resolved to a `Date`. */
export type DateInput = Date | number | string;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type PrettyMsOptions = NonNullable<Parameters<typeof prettyMs>[1]>;

/** Resolve a `DateInput` to a `Date`. Throws `TimeError` on invalid input. */
function toDate(input: DateInput): Date {
  if (input instanceof Date) {
    if (isNaN(input.getTime())) {
      throw new TimeError('Cannot resolve input to a valid date');
    }
    return input;
  }

  if (typeof input === 'number') {
    const d = new Date(input);
    if (isNaN(d.getTime())) {
      throw new TimeError('Cannot resolve input to a valid date');
    }
    return d;
  }

  // string — try ISO first, then native parse
  let d = parseISO(input);
  if (isNaN(d.getTime())) {
    d = new Date(input);
  }
  if (isNaN(d.getTime())) {
    throw new TimeError('Cannot resolve input to a valid date');
  }
  return d;
}

// date-fns Duration property map for units other than 'ms'.
const UNIT_DURATION_KEY = {
  year: 'years',
  month: 'months',
  week: 'weeks',
  day: 'days',
  hour: 'hours',
  minute: 'minutes',
  second: 'seconds',
} as const;

type DiffFn = (a: Date, b: Date) => number;

const DIFF_MAP: Record<TimeUnit, DiffFn> = {
  ms: differenceInMilliseconds,
  second: differenceInSeconds,
  minute: differenceInMinutes,
  hour: differenceInHours,
  day: differenceInDays,
  week: differenceInWeeks,
  month: differenceInMonths,
  year: differenceInYears,
};

type BoundaryFn = (date: Date) => Date;

const START_OF_MAP: Record<TimeUnit, BoundaryFn> = {
  ms: startOfSecond,
  second: startOfSecond,
  minute: startOfMinute,
  hour: startOfHour,
  day: startOfDay,
  week: startOfWeek,
  month: startOfMonth,
  year: startOfYear,
};

const END_OF_MAP: Record<TimeUnit, BoundaryFn> = {
  ms: endOfSecond,
  second: endOfSecond,
  minute: endOfMinute,
  hour: endOfHour,
  day: endOfDay,
  week: endOfWeek,
  month: endOfMonth,
  year: endOfYear,
};

// Thresholds for automatic unit selection in `relative`.
const RELATIVE_THRESHOLDS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365.25 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: (365.25 / 12) * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
  { unit: 'second', ms: 1000 },
];

function bestRelativeUnit(diffMs: number): {
  value: number;
  unit: Intl.RelativeTimeFormatUnit;
} {
  const absMs = Math.abs(diffMs);
  for (const entry of RELATIVE_THRESHOLDS) {
    if (absMs >= entry.ms) {
      return { value: Math.trunc(diffMs / entry.ms), unit: entry.unit };
    }
  }
  return { value: Math.trunc(diffMs / 1000), unit: 'second' };
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Format milliseconds as a human-readable duration string.
 *
 * Wraps {@link https://github.com/sindresorhus/pretty-ms | pretty-ms}.
 */
export function duration(ms: number, options?: PrettyMsOptions): string {
  if (typeof ms !== 'number' || !isFinite(ms)) {
    throw new TimeError('Cannot format duration from a non-finite number');
  }
  return prettyMs(ms, options);
}

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Wraps {@link https://github.com/vercel/ms | ms}. Accepts strings like
 * `'2 days'`, `'1h'`, `'3 minutes'`.
 *
 * @throws {TimeError} if the input cannot be parsed.
 */
export function parseDuration(input: string): number {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new TimeError('Cannot parse duration from non-string input');
  }
  // `@types/ms` types the parse overload with a template-literal unit union,
  // but `parseDuration` deliberately accepts an arbitrary string and validates
  // it at runtime — hence the widening assertion.
  const result = msParser(input as Parameters<typeof msParser>[0]);
  if (result === undefined || (typeof result === 'number' && isNaN(result))) {
    throw new TimeError('Cannot parse duration from value');
  }
  return result;
}

/**
 * Parse a date from a `string`, `number` (timestamp), or `Date`.
 *
 * Uses `date-fns/parseISO` for string input; falls back to the platform
 * `Date` parser.
 *
 * @throws {TimeError} if the input cannot be resolved to a valid date.
 */
export function parse(input: DateInput): Date {
  return toDate(input);
}

/**
 * Return the difference between two dates in the given unit.
 *
 * Default unit is `'ms'`. The result is `a - b` (positive when `a` is later).
 *
 * Wraps the `differenceIn*` family from date-fns.
 */
export function diff(a: DateInput, b: DateInput, unit: TimeUnit = 'ms'): number {
  const da = toDate(a);
  const db = toDate(b);
  const fn = DIFF_MAP[unit];
  return fn(da, db);
}

/**
 * Add `amount` of `unit` to a date.
 *
 * Wraps `date-fns/add`.
 */
export function add(value: DateInput, amount: number, unit: TimeUnit): Date {
  const d = toDate(value);
  if (unit === 'ms') {
    return new Date(d.getTime() + amount);
  }
  return dfAdd(d, { [UNIT_DURATION_KEY[unit]]: amount });
}

/**
 * Subtract `amount` of `unit` from a date.
 *
 * Wraps `date-fns/sub`.
 */
export function subtract(value: DateInput, amount: number, unit: TimeUnit): Date {
  const d = toDate(value);
  if (unit === 'ms') {
    return new Date(d.getTime() - amount);
  }
  return dfSub(d, { [UNIT_DURATION_KEY[unit]]: amount });
}

/**
 * Return the start of `unit` for the given date.
 *
 * Wraps the `startOf*` family from date-fns.
 */
export function startOf(value: DateInput, unit: TimeUnit): Date {
  const d = toDate(value);
  return START_OF_MAP[unit](d);
}

/**
 * Return the end of `unit` for the given date.
 *
 * Wraps the `endOf*` family from date-fns.
 */
export function endOf(value: DateInput, unit: TimeUnit): Date {
  const d = toDate(value);
  return END_OF_MAP[unit](d);
}

/**
 * Format a date using `Intl.DateTimeFormat`.
 */
export function format(
  value: DateInput,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const d = toDate(value);
  return new Intl.DateTimeFormat(locale, options).format(d);
}

/**
 * Return a human-readable relative time string (e.g. "3 days ago").
 *
 * Uses `Intl.RelativeTimeFormat`. `base` defaults to the current time.
 * The unit is chosen automatically as the largest unit where the rounded
 * absolute difference is at least 1.
 */
export function relative(value: DateInput, base?: DateInput, locale?: string): string {
  const dv = toDate(value);
  const db = base !== undefined ? toDate(base) : new Date();
  const diffMs = dv.getTime() - db.getTime();
  const { value: relValue, unit: relUnit } = bestRelativeUnit(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return rtf.format(relValue, relUnit);
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

// Predicate helpers are re-exported bare so the module satisfies the
// named-export contract (design §4.1) as well as the namespace object.
export { isFuture, isPast, isToday };

export const Time = Object.freeze({
  add,
  diff,
  duration,
  endOf,
  format,
  isFuture,
  isPast,
  isToday,
  parse,
  parseDuration,
  relative,
  startOf,
  subtract,
});
