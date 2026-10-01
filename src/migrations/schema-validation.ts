/**
 * Identifier and scalar-literal validation for the portable schema model.
 *
 * These checks guard every field that reaches a driver from untrusted JSON (a
 * stored migration definition or a hand-written one): an identifier is
 * structural, never interpolated blindly, and a scalar default is validated
 * against its column type so an impossible literal is rejected before DDL.
 */

import { MigrationError, type ScalarColumnType } from './schema-types.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidIdentifier(name: string): boolean {
  return typeof name === 'string' && IDENTIFIER.test(name);
}

/** Validate a runtime identifier and return it typed. Used for untrusted JSON. */
export function validateIdentifier(name: unknown): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new MigrationError(`invalid identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Portable integer columns are signed 32-bit (postgres `integer`, mysql `int`). */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * Backslash (U+005C) and C0/DEL control characters (U+0000-001F, U+007F) are
 * not portable as string literal defaults: MySQL treats a backslash as an
 * escape, so re-escaping per driver would silently corrupt data or reopen the
 * injection it was meant to close. These are rejected uniformly rather than
 * given driver-dependent escaping.
 */
const BACKSLASH_OR_CONTROL = /[\u005C\u0000-\u001F\u007F]/;

/**
 * Reject a string that cannot be represented portably as a SQL default. Shared
 * with the schema editor so a direct `quoteLiteral` call cannot bypass core
 * normalization. Single quotes remain allowed (they are doubled, never escaped).
 */
export function assertPortableStringLiteral(value: string, label: string): void {
  if (BACKSLASH_OR_CONTROL.test(value)) {
    throw new MigrationError(
      `${label} contains a backslash or control character (U+005C or U+0000-001F/007F), ` +
        `which cannot be ported safely across SQL drivers; omit the default and set the ` +
        `value from application code instead`,
    );
  }
}

function literalTypeMismatch(value: unknown, type: ScalarColumnType, columnName: string): never {
  throw new MigrationError(
    `default for ${type} column "${columnName}" does not match its type: ${JSON.stringify(value)}`,
  );
}

function daysInMonth(year: number, month: number): number {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leapFebruary = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 2 && leapFebruary) {
    return 29;
  }
  return days[month - 1] as number;
}

/**
 * Validate a datetime default against the exact `YYYY-MM-DD HH:MM:SS` form,
 * with a real calendar (leap years, month/day ranges) and a portable year range
 * of 1000..9999. This is a pure string/arithmetic check; no `Date` object is
 * constructed, so timezone coercion can never shift the value.
 */
function assertValidDatetimeLiteral(value: string, columnName: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new MigrationError(
      `default for datetime column "${columnName}" must be exactly "YYYY-MM-DD HH:MM:SS" ` +
        `(no timezone, no fractional seconds); got ${JSON.stringify(value)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1000 || year > 9999) {
    throw new MigrationError(
      `default for datetime column "${columnName}" has year ${year}, outside the ` +
        `portable range 1000..9999`,
    );
  }
  if (month < 1 || month > 12) {
    throw new MigrationError(
      `default for datetime column "${columnName}" has invalid month ${month}`,
    );
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new MigrationError(
      `default for datetime column "${columnName}" has invalid day ${day} for ` +
        `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    );
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new MigrationError(
      `default for datetime column "${columnName}" has invalid time ` +
        `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:` +
        `${String(second).padStart(2, '0')}`,
    );
  }
}

/**
 * Validate a date default (YYYY-MM-DD) with a real calendar and a portable year
 * range of 1000..9999. No `Date` object is constructed.
 */
function assertValidDateLiteral(value: string, columnName: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new MigrationError(
      `default for date column "${columnName}" must be exactly "YYYY-MM-DD" ` +
        `(no timezone, no time component); got ${JSON.stringify(value)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || year > 9999) {
    throw new MigrationError(
      `default for date column "${columnName}" has year ${year}, outside the ` +
        `portable range 1000..9999`,
    );
  }
  if (month < 1 || month > 12) {
    throw new MigrationError(`default for date column "${columnName}" has invalid month ${month}`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new MigrationError(
      `default for date column "${columnName}" has invalid day ${day} for ` +
        `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    );
  }
}

/**
 * Validate a time default (HH:MM:SS) within valid ranges. No `Date` object is
 * constructed.
 */
function assertValidTimeLiteral(value: string, columnName: string): void {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new MigrationError(
      `default for time column "${columnName}" must be exactly "HH:MM:SS" ` +
        `(no timezone, no fractional seconds); got ${JSON.stringify(value)}`,
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new MigrationError(
      `default for time column "${columnName}" has invalid time ` +
        `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:` +
        `${String(second).padStart(2, '0')}`,
    );
  }
}

/** Assert a scalar default literal is representable as the given column type. */
export function assertLiteralMatchesType(
  value: unknown,
  type: ScalarColumnType,
  columnName: string,
): void {
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      literalTypeMismatch(value, type, columnName);
    }
    if (value < INT32_MIN || value > INT32_MAX) {
      throw new MigrationError(
        `default for integer column "${columnName}" is out of range: ${String(value)}; ` +
          `portable integer columns are signed 32-bit (${INT32_MIN}..${INT32_MAX})`,
      );
    }
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      literalTypeMismatch(value, type, columnName);
    }
    return;
  }
  if (type === 'decimal' || type === 'float' || type === 'bigint') {
    if (typeof value !== 'number') {
      literalTypeMismatch(value, type, columnName);
    }
    return;
  }
  if (type === 'json') {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      literalTypeMismatch(value, type, columnName);
    }
    if (typeof value === 'string') {
      assertPortableStringLiteral(value, `default for json column "${columnName}"`);
    }
    return;
  }
  // varchar / text / datetime / uuid / date / time
  if (typeof value !== 'string') {
    literalTypeMismatch(value, type, columnName);
  }
  assertPortableStringLiteral(value, `default for ${type} column "${columnName}"`);
  if (type === 'datetime') {
    assertValidDatetimeLiteral(value, columnName);
  }
  if (type === 'date') {
    assertValidDateLiteral(value, columnName);
  }
  if (type === 'time') {
    assertValidTimeLiteral(value, columnName);
  }
}
