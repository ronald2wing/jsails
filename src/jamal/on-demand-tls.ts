/**
 * On-demand TLS allowlist endpoint for kamal-proxy.
 *
 * kamal-proxy authorizes each hostname at certificate-issuance time by calling
 * `GET <url>?host=<hostname>` with a matching `Host` header: a `200` allows
 * issuance, any other response denies it (and an already-cached certificate
 * skips the call). {@link createOnDemandTlsAllowlist} builds the Fetch-style
 * handler for that URL, so an app can mount it as a JSails API route or an
 * extension HTTP hook without reimplementing the contract.
 *
 * The endpoint is fail-closed by construction: it answers `200` only when the
 * hostname is allowlisted (exact match, case-insensitive, trailing-dot
 * tolerant) or `allow(hostname)` resolves to exactly `true`, and every other
 * response is an empty-bodied `403` (or `400`/`405` for a malformed request).
 * Hostnames are never echoed in a body or an error, so the endpoint leaks
 * nothing beyond its status code. Because the endpoint gates certificate
 * issuance, an over-permissive `domains`/`allow` configuration can have
 * certificates issued for unauthorized domains — the caller owns the policy.
 *
 * The module is server-only: the constant-time shared-secret comparison uses
 * `node:crypto`.
 */

import { safeEqualStrings } from '../internal/crypto.js';

/** Control characters plus DEL — never valid in a hostname or header name. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Upper bound on a fully-qualified hostname (RFC 1035). */
const MAX_HOST_LENGTH = 253;

/** Raised for an invalid allowlist configuration. Messages never embed input. */
export class OnDemandTlsAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnDemandTlsAllowlistError';
  }
}

/** Options for {@link createOnDemandTlsAllowlist}. */
export interface OnDemandTlsAllowlistOptions {
  /**
   * Allowlisted hostnames (exact match, case-insensitive, trailing-dot
   * tolerant). May be empty; then only `allow` can grant issuance.
   */
  readonly domains: readonly string[];
  /**
   * Additional dynamic allow check, called for hostnames not present in
   * `domains`. It receives the normalized hostname (lower-cased, trailing dot
   * stripped) and grants issuance only when it resolves to exactly `true`.
   */
  readonly allow?: (hostname: string) => boolean;
  /**
   * When set, require the request to carry this header equal to `secret`
   * (constant-time compare), so a public endpoint can be shared-secret gated.
   */
  readonly headerName?: string;
  /** Shared secret for `headerName`; required when `headerName` is set. */
  readonly secret?: string;
}

/** The Fetch-style handler the allowlist endpoint exposes. */
export type OnDemandTlsAllowlistHandler = (request: Request) => Response;

/** Lower-case and strip a single trailing dot, without any length validation. */
function normalizeHostname(value: string): string {
  const lower = value.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * Validate a configured allowlist hostname and return its normalized form. The
 * matching is case-insensitive, so the value may carry any letter case; it is
 * still rejected when it is not a plausible hostname (whitespace/control,
 * wildcard, scheme/port/path/query/fragment, empty labels). The returned value
 * is lower-cased with a trailing dot stripped.
 */
function assertAllowlistDomain(value: string): string {
  if (value.length === 0) {
    throw new OnDemandTlsAllowlistError('allowlist domains must be non-empty strings');
  }
  if (value.length > MAX_HOST_LENGTH) {
    throw new OnDemandTlsAllowlistError('allowlist domains exceed the maximum hostname length');
  }
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new OnDemandTlsAllowlistError(
      'allowlist domains must not contain whitespace or control characters',
    );
  }
  if (value.includes('*')) {
    throw new OnDemandTlsAllowlistError('allowlist domains must not contain a wildcard');
  }
  if (/[^a-z0-9.-]/.test(value.toLowerCase())) {
    throw new OnDemandTlsAllowlistError('allowlist domains must be valid hostnames');
  }
  if (value.startsWith('.') || value.includes('..')) {
    throw new OnDemandTlsAllowlistError('allowlist domains must not contain empty labels');
  }
  const normalized = normalizeHostname(value);
  if (normalized === '') {
    throw new OnDemandTlsAllowlistError('allowlist domains must be non-empty hostnames');
  }
  return normalized;
}

/** Build an empty-bodied response for a status code; never a body or an error. */
function empty(status: number): Response {
  return new Response(null, { status });
}

/**
 * Build the on-demand TLS allowlist handler. The returned function implements
 * the kamal-proxy contract: `GET <path>?host=<hostname>` with a matching
 * `Host` header resolves `200` only for an allowlisted hostname, and `403`
 * (or `400`/`405` for a malformed request) otherwise. Construction validates
 * the configuration once and throws {@link OnDemandTlsAllowlistError} on a bad
 * option; the returned handler itself never throws on request input.
 */
export function createOnDemandTlsAllowlist(
  options: OnDemandTlsAllowlistOptions,
): OnDemandTlsAllowlistHandler {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new OnDemandTlsAllowlistError('options must be a plain object');
  }
  if (!Array.isArray(options.domains)) {
    throw new OnDemandTlsAllowlistError('options.domains must be an array');
  }
  const domains = new Set<string>();
  for (const domain of options.domains) {
    if (typeof domain !== 'string') {
      throw new OnDemandTlsAllowlistError('options.domains must contain only strings');
    }
    domains.add(assertAllowlistDomain(domain));
  }

  const allow = options.allow;
  if (allow !== undefined && typeof allow !== 'function') {
    throw new OnDemandTlsAllowlistError('options.allow must be a function');
  }

  const headerName = options.headerName;
  const secret = options.secret;
  let verifySecret: ((request: Request) => boolean) | undefined;
  if (headerName !== undefined) {
    if (
      typeof headerName !== 'string' ||
      headerName.length === 0 ||
      /\s/.test(headerName) ||
      CONTROL_CHARS.test(headerName)
    ) {
      throw new OnDemandTlsAllowlistError(
        'options.headerName must be a non-empty header name without whitespace',
      );
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new OnDemandTlsAllowlistError(
        'options.secret is required when options.headerName is set',
      );
    }
    // Both are narrowed to `string` inside this branch; close over the
    // validated values so the handler needs no further narrowing.
    const name = headerName;
    const expected = secret;
    verifySecret = (request) => {
      const provided = request.headers.get(name);
      return provided !== null && safeEqualStrings(provided, expected);
    };
  } else if (secret !== undefined) {
    throw new OnDemandTlsAllowlistError('options.secret requires options.headerName');
  }

  return (request: Request): Response => {
    if (request.method !== 'GET') {
      return empty(405);
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return empty(400);
    }

    // Exactly one `host` query parameter, non-empty and free of whitespace.
    const hosts = url.searchParams.getAll('host');
    if (hosts.length !== 1) {
      return empty(400);
    }
    const rawHost = hosts[0];
    if (rawHost === undefined || rawHost === '') {
      return empty(400);
    }
    if (CONTROL_CHARS.test(rawHost) || /\s/.test(rawHost)) {
      return empty(400);
    }

    let hostname: string;
    try {
      hostname = assertAllowlistDomain(rawHost);
    } catch {
      return empty(400);
    }

    // The request's Host header must match the hostname being authorized; a
    // mismatch (or absence) means the check URL is being used off-contract.
    const requestHost = request.headers.get('host');
    if (requestHost === null || normalizeHostname(requestHost) !== hostname) {
      return empty(403);
    }

    if (verifySecret !== undefined && !verifySecret(request)) {
      return empty(403);
    }

    if (domains.has(hostname) || (allow !== undefined && allow(hostname) === true)) {
      return empty(200);
    }
    return empty(403);
  };
}
