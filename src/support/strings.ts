import {
  camelCase,
  capitalCase,
  constantCase,
  kebabCase,
  pascalCase,
  snakeCase,
} from 'change-case';
import slugifyLib from 'slugify';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export class StrError extends SupportError {
  readonly code = 'invalid_argument';
}

// ---------------------------------------------------------------------------
// Validation helpers (value-free — never echo the offending value)
// ---------------------------------------------------------------------------

function assertString(value: unknown, operation: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new StrError(`Str.${operation}: expected a string`);
  }
}

function assertPositiveInteger(value: unknown, operation: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 1 ||
    !Number.isInteger(value)
  ) {
    throw new StrError(`Str.${operation}: expected a positive integer`);
  }
}

function assertNonNegativeInteger(value: unknown, operation: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new StrError(`Str.${operation}: expected a non-negative integer`);
  }
}

// ---------------------------------------------------------------------------
// Wraps: change-case
// ---------------------------------------------------------------------------

export function camel(value: string): string {
  assertString(value, 'camel');
  return camelCase(value);
}

export function pascal(value: string): string {
  assertString(value, 'pascal');
  return pascalCase(value);
}

export function snake(value: string): string {
  assertString(value, 'snake');
  return snakeCase(value);
}

export function kebab(value: string): string {
  assertString(value, 'kebab');
  return kebabCase(value);
}

export function constant(value: string): string {
  assertString(value, 'constant');
  return constantCase(value);
}

export function title(value: string): string {
  assertString(value, 'title');
  return capitalCase(value);
}

// ---------------------------------------------------------------------------
// Wraps: slugify
// ---------------------------------------------------------------------------

export function slug(value: string, options?: Record<string, unknown>): string {
  assertString(value, 'slug');
  return slugifyLib(value, options ?? {});
}

// ---------------------------------------------------------------------------
// Own: truncate
// ---------------------------------------------------------------------------

const DEFAULT_ELLIPSIS = '\u2026'; // …

export function truncate(value: string, length: number, options?: { ellipsis?: string }): string {
  assertString(value, 'truncate');
  assertPositiveInteger(length, 'truncate');

  const ellipsis = options?.ellipsis ?? DEFAULT_ELLIPSIS;

  if (value.length <= length) return value;

  const keepLength = length - ellipsis.length;
  if (keepLength <= 0) return ellipsis.slice(0, length);

  return value.slice(0, keepLength) + ellipsis;
}

// ---------------------------------------------------------------------------
// Own: excerpt (word-boundary-aware truncation)
// ---------------------------------------------------------------------------

export function excerpt(value: string, length: number): string {
  assertString(value, 'excerpt');
  assertPositiveInteger(length, 'excerpt');

  if (value.length <= length) return value;

  // Find the last whitespace at or before the limit.
  const slice = value.slice(0, length);
  const lastSpace = /\s(?=\S*$)/.exec(slice);

  if (!lastSpace || lastSpace.index === 0) {
    // No word boundary found — hard cut.
    return value.slice(0, length) + '...';
  }

  return value.slice(0, lastSpace.index) + '...';
}

// ---------------------------------------------------------------------------
// Own: words
// ---------------------------------------------------------------------------

export function words(value: string): string[] {
  assertString(value, 'words');
  return value.trim() === '' ? [] : value.trim().split(/\s+/);
}

// ---------------------------------------------------------------------------
// Own: limit (hard cut, no ellipsis)
// ---------------------------------------------------------------------------

export function limit(value: string, length: number): string {
  assertString(value, 'limit');
  assertPositiveInteger(length, 'limit');
  return value.slice(0, length);
}

// ---------------------------------------------------------------------------
// Own: escapeHtml / unescapeHtml (exactly five entities)
// ---------------------------------------------------------------------------

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(value: string): string {
  assertString(value, 'escapeHtml');
  return value.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]!);
}

const UNESCAPE_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
};

const UNESCAPE_RE = /&(?:amp|lt|gt|quot|#39|#x27|apos);/g;

export function unescapeHtml(value: string): string {
  assertString(value, 'unescapeHtml');
  return value.replace(UNESCAPE_RE, (entity) => UNESCAPE_MAP[entity] ?? entity);
}

// ---------------------------------------------------------------------------
// Own: random (crypto.getRandomValues)
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_RANDOM_LENGTH = 16;

export function random(length?: number): string {
  if (length === undefined) length = DEFAULT_RANDOM_LENGTH;
  assertNonNegativeInteger(length, 'random');

  if (length === 0) return '';

  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);

  let result = '';
  for (let i = 0; i < length; i++) {
    result += ALPHABET[bytes[i]! % ALPHABET.length]!;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Own: mask
// ---------------------------------------------------------------------------

const DEFAULT_MASK_CHAR = '*';

export function mask(
  value: string,
  options?: { maskChar?: string; revealLeading?: number; revealTrailing?: number },
): string {
  assertString(value, 'mask');

  const maskChar = options?.maskChar ?? DEFAULT_MASK_CHAR;
  const revealLeading = options?.revealLeading ?? 0;
  const revealTrailing = options?.revealTrailing ?? 0;

  if (typeof maskChar !== 'string' || maskChar.length !== 1) {
    throw new StrError('Str.mask: maskChar must be a single character');
  }
  if (typeof revealLeading !== 'number' || !Number.isInteger(revealLeading) || revealLeading < 0) {
    throw new StrError('Str.mask: revealLeading must be a non-negative integer');
  }
  if (
    typeof revealTrailing !== 'number' ||
    !Number.isInteger(revealTrailing) ||
    revealTrailing < 0
  ) {
    throw new StrError('Str.mask: revealTrailing must be a non-negative integer');
  }

  if (value.length === 0) return '';

  if (revealLeading + revealTrailing >= value.length) return value;

  const lead = value.slice(0, revealLeading);
  const trail = value.slice(-revealTrailing || value.length);
  const masked = maskChar.repeat(value.length - revealLeading - revealTrailing);

  return lead + masked + trail;
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Str = Object.freeze({
  camel,
  pascal,
  snake,
  kebab,
  constant,
  title,
  slug,
  truncate,
  excerpt,
  words,
  limit,
  escapeHtml,
  unescapeHtml,
  random,
  mask,
});
