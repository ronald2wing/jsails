import { parseCookie, stringifySetCookie } from 'cookie';
import setCookie from 'set-cookie-parser';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export type CookieErrorCode = 'invalid_argument';

export class CookieError extends SupportError {
  readonly code: CookieErrorCode;

  constructor(code: CookieErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CookieParseOptions {
  /**
   * Custom decoder for a cookie value. Receives the raw value and returns the
   * decoded string (or `undefined` to skip the cookie). Defaults to
   * `decodeURIComponent`.
   */
  decode?: (value: string) => string | undefined;
}

export interface CookieSerializeOptions {
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  partitioned?: boolean;
  priority?: 'low' | 'medium' | 'high';
  sameSite?: boolean | 'lax' | 'strict' | 'none';
}

export interface SetCookieParseOptions {
  /** Decode the value with `decodeURIComponent`. Defaults to true. */
  decodeValues?: boolean;
}

export interface ParsedSetCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly domain?: string;
  readonly expires?: Date;
  readonly maxAge?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a `Cookie` request header into a name→value record. */
export function parse(
  header: string,
  options: CookieParseOptions = {},
): Record<string, string | undefined> {
  if (typeof header !== 'string') {
    throw new CookieError('invalid_argument', 'parse: expected a string header');
  }
  // `parseCookie` returns a null-prototype object; spread it into a plain one
  // so callers get ordinary object ergonomics (`hasOwnProperty`, `deepEqual`).
  return { ...parseCookie(header, options) };
}

/** Serialize a `Set-Cookie` header value from a name, value, and options. */
export function serialize(
  name: string,
  value: string,
  options: CookieSerializeOptions = {},
): string {
  return stringifySetCookie({ name, value, ...options });
}

/** Parse one or more `Set-Cookie` response headers into structured objects. */
export function parseSetCookie(
  header: string | readonly string[],
  options: SetCookieParseOptions = {},
): ParsedSetCookie[] {
  const headers = Array.isArray(header) ? [...header] : [header as string];
  try {
    const parsed = setCookie.parse(headers, {
      decodeValues: options.decodeValues ?? true,
    });
    return parsed.map((entry) => ({
      name: entry.name,
      value: entry.value,
      path: entry.path,
      domain: entry.domain,
      expires: entry.expires,
      maxAge: entry.maxAge,
      httpOnly: entry.httpOnly,
      secure: entry.secure,
      sameSite: entry.sameSite,
    }));
  } catch (error) {
    throw new CookieError('invalid_argument', 'parseSetCookie: malformed Set-Cookie header', {
      cause: error,
    });
  }
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Cookie = Object.freeze({
  parse,
  serialize,
  parseSetCookie,
});
