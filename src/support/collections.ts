import { SupportError } from './errors.js';

import {
  compact as esCompact,
  flatten as esFlatten,
  flattenDeep as esFlattenDeep,
  groupBy as esGroupBy,
  keyBy as esKeyBy,
  omit as esOmit,
  pick as esPick,
  range as esRange,
  sortBy as esSortBy,
  uniq as esUniq,
  uniqBy as esUniqBy,
} from 'es-toolkit';
import { get as esGet, has as esHas, set as esSet } from 'es-toolkit/compat';
import { defu } from 'defu';
import equal from 'fast-deep-equal';
import { klona } from 'klona';

// ---------------------------------------------------------------------------
// ArrError
// ---------------------------------------------------------------------------

export class ArrError extends SupportError {
  readonly code = 'invalid_argument';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// groupBy — native Object.groupBy with es-toolkit fallback, selected once
// ---------------------------------------------------------------------------

type NativeGroupByFn = <T>(
  items: Iterable<T>,
  keySelector: (item: T, index: number) => PropertyKey,
) => Record<PropertyKey, T[]>;

const _nativeGroupBy = (Object as unknown as Record<string, unknown>).groupBy as
  NativeGroupByFn | undefined;

const _groupBy: <T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T) => K,
) => Record<K, T[]> =
  typeof _nativeGroupBy === 'function'
    ? function groupByNative<T, K extends PropertyKey>(
        items: readonly T[],
        keyFn: (item: T) => K,
      ): Record<K, T[]> {
        return _nativeGroupBy(
          items,
          keyFn as unknown as (item: unknown, index: number) => PropertyKey,
        );
      }
    : esGroupBy;

export function groupBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  if (!Array.isArray(items)) throw new ArrError('groupBy expects an array argument');
  return _groupBy(items, keyFn);
}

// ---------------------------------------------------------------------------
// keyBy
// ---------------------------------------------------------------------------

export function keyBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Record<K, T> {
  if (!Array.isArray(items)) throw new ArrError('keyBy expects an array argument');
  return esKeyBy(items, keyFn);
}

// ---------------------------------------------------------------------------
// pluck — hand-rolled (not in es-toolkit)
// ---------------------------------------------------------------------------

export function pluck<T, K extends keyof T>(items: readonly T[], key: K): T[K][] {
  if (!Array.isArray(items)) throw new ArrError('pluck expects an array argument');
  return items.map((item) => item[key]);
}

// ---------------------------------------------------------------------------
// unique / uniqueBy — aliases for es-toolkit uniq / uniqBy
// ---------------------------------------------------------------------------

export function unique<T>(items: readonly T[]): T[] {
  if (!Array.isArray(items)) throw new ArrError('unique expects an array argument');
  return esUniq(items);
}

export function uniqueBy<T, K>(items: readonly T[], predicate: (item: T) => K): T[] {
  if (!Array.isArray(items)) throw new ArrError('uniqueBy expects an array argument');
  return esUniqBy(items, predicate);
}

// ---------------------------------------------------------------------------
// flatten / flattenDeep / compact
// ---------------------------------------------------------------------------

export function flatten<T>(array: readonly (T | readonly T[])[]): T[] {
  if (!Array.isArray(array)) throw new ArrError('flatten expects an array argument');
  return esFlatten(array as T[]) as T[];
}

export function flattenDeep<T>(array: readonly unknown[]): T[] {
  if (!Array.isArray(array)) throw new ArrError('flattenDeep expects an array argument');
  return esFlattenDeep(array) as T[];
}

export function compact<T>(items: readonly (T | null | undefined | false | 0 | '')[]): T[] {
  if (!Array.isArray(items)) throw new ArrError('compact expects an array argument');
  return esCompact(items);
}

// ---------------------------------------------------------------------------
// pick / omit
// ---------------------------------------------------------------------------

export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  if (obj === null || typeof obj !== 'object')
    throw new ArrError('pick expects an object argument');
  return esPick(obj, keys);
}

export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  if (obj === null || typeof obj !== 'object')
    throw new ArrError('omit expects an object argument');
  return esOmit(obj, keys);
}

// ---------------------------------------------------------------------------
// get / set / has (from es-toolkit/compat)
// ---------------------------------------------------------------------------

export function get<T = unknown>(obj: unknown, path: string, fallback?: T): T {
  return esGet(obj, path, fallback) as unknown as T;
}

export function set<T extends object>(obj: T, path: string, value: unknown): T {
  return esSet(obj, path, value);
}

export function has(obj: unknown, path: string): boolean {
  return esHas(obj, path);
}

// ---------------------------------------------------------------------------
// sortBy
// ---------------------------------------------------------------------------

export function sortBy<T>(
  items: readonly T[],
  ...criteria: (((item: T) => unknown) | string)[]
): T[] {
  if (!Array.isArray(items)) throw new ArrError('sortBy expects an array argument');
  return esSortBy(items, criteria) as T[];
}

// ---------------------------------------------------------------------------
// range
// ---------------------------------------------------------------------------

export function range(start: number, end?: number, step?: number): number[] {
  if (end === undefined) return esRange(start);
  if (step === undefined) return esRange(start, end);
  return esRange(start, end, step);
}

// ---------------------------------------------------------------------------
// chunk — hand-rolled
// ---------------------------------------------------------------------------

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Array.isArray(items)) throw new ArrError('chunk expects an array argument');
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1)
    throw new ArrError('chunk expects a positive integer size');
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

// ---------------------------------------------------------------------------
// merge — defu
// ---------------------------------------------------------------------------

export function merge<T extends object>(...sources: readonly (Partial<T> | undefined)[]): T {
  return defu({}, ...sources) as T;
}

// ---------------------------------------------------------------------------
// clone / cloneDeep — structuredClone with klona fallback
// ---------------------------------------------------------------------------

export function clone<T>(value: T): T {
  if (typeof structuredClone !== 'function') {
    return klona<T>(value);
  }
  try {
    return structuredClone(value);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'DataCloneError') {
      throw new ArrError('clone: value cannot be cloned');
    }
    throw e;
  }
}

export const cloneDeep = clone;

// ---------------------------------------------------------------------------
// equals — fast-deep-equal
// ---------------------------------------------------------------------------

export function equals(a: unknown, b: unknown): boolean {
  return equal(a, b);
}

// ---------------------------------------------------------------------------
// toSentence — native Intl.ListFormat
// ---------------------------------------------------------------------------

export function toSentence(
  items: readonly string[],
  options?: Intl.ListFormatOptions,
  locale?: string,
): string {
  if (!Array.isArray(items)) throw new ArrError('toSentence expects an array argument');
  return new Intl.ListFormat(locale, options).format(items);
}

// ---------------------------------------------------------------------------
// Arr frozen namespace
// ---------------------------------------------------------------------------

export const Arr = Object.freeze({
  chunk,
  clone,
  cloneDeep,
  compact,
  equals,
  flatten,
  flattenDeep,
  get,
  groupBy,
  has,
  keyBy,
  merge,
  omit,
  pick,
  pluck,
  range,
  set,
  sortBy,
  toSentence,
  unique,
  uniqueBy,
});
