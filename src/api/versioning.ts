/**
 * API versioning via URL prefix and Accept header negotiation.
 *
 * ## Precedence (highest to lowest)
 *
 * 1. **URL prefix segment** — `/v2/users` → version `"2"`.
 * 2. **Accept header** — `application/vnd.jsails.v2+json` → version `"2"`.
 * 3. **Default version** — returned when no signal is present.
 *
 * A request that signals an unknown version (via URL or header) produces a
 * value-free error result. URL always wins over header, so a request to
 * `/v1/users` with `Accept: application/vnd.jsails.v2+json` resolves to
 * version `"1"`.
 *
 * ## Response helpers
 *
 * `versionedNotFound()` / `versionedNotAcceptable()` return value-free Response
 * objects suitable for returning from a handler when version resolution fails.
 * They carry no body and no identifying headers — the status alone is the
 * signal.
 */

/** Options for {@link resolveApiVersion}. */
export interface VersioningOptions {
  /** Non-empty list of supported version strings (e.g. `["1", "2"]`). */
  readonly versions: readonly string[];
  /** Default version when no signal is present. Must be in `versions`. */
  readonly default: string;
  /**
   * Request URL path to inspect for a `/v<version>/` prefix segment. When
   * omitted, URL-based resolution is skipped.
   */
  readonly url?: string;
  /**
   * Request headers to inspect for the `Accept` media-type. When omitted,
   * header-based resolution is skipped.
   */
  readonly headers?: Record<string, string>;
}

/** Successful version resolution. */
export interface VersionOk {
  readonly ok: true;
  readonly version: string;
}

/** Failed version resolution with a stable machine code. */
export interface VersionFailure {
  readonly ok: false;
  /** `"invalid_versions"` | `"unknown_version"` */
  readonly code: 'invalid_versions' | 'unknown_version';
}

/** The discriminated result of version resolution. */
export type VersionResult = VersionOk | VersionFailure;

/** Regex that matches a `/v<version>/` prefix at the start of a path. */
const URL_VERSION_RE = /^\/v([^/]+)\//;

/**
 * Regex that matches the JSails vendor media type:
 * `application/vnd.jsails.v<version>+json`
 *
 * Accepted forms (per RFC 6838 / RFC 9110):
 * - `application/vnd.jsails.v2+json`
 * - `application/vnd.jsails.v2+json;q=0.9`
 * - `application/vnd.jsails.v2+json; q=0.9`
 */
const ACCEPT_VERSION_RE = /^application\/vnd\.jsails\.v([^+;]+)\+json(?:\s*;.*)?$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves the API version from a URL path and/or Accept header.
 *
 * Validation is eager: `versions` must be non-empty and `default` must be in
 * `versions`; a bad config returns `{ ok: false, code: 'invalid_versions' }`.
 *
 * Resolution follows the documented precedence: URL first, then Accept header,
 * then the configured default. An unknown version in the URL or header produces
 * `{ ok: false, code: 'unknown_version' }`. A malformed Accept header that
 * does not match the vendor media type is silently skipped (default falls
 * through).
 *
 * Both `url` and `headers` are optional: omit either to skip that signal
 * source. When both are omitted the default version is returned.
 */
export function resolveApiVersion(options: VersioningOptions): VersionResult {
  const { default: defaultVersion, url, headers } = options;

  // Eager validation.
  if (!Array.isArray(options.versions) || options.versions.length === 0) {
    return { ok: false, code: 'invalid_versions' };
  }
  const versionSet = new Set(options.versions);
  if (!versionSet.has(defaultVersion)) {
    return { ok: false, code: 'invalid_versions' };
  }
  if (options.versions.some((v) => typeof v !== 'string' || v.length === 0)) {
    return { ok: false, code: 'invalid_versions' };
  }

  // 1. URL prefix segment — highest precedence.
  if (url !== undefined) {
    const match = URL_VERSION_RE.exec(url);
    if (match !== null) {
      const version = match[1]!;
      if (versionSet.has(version)) {
        return { ok: true, version };
      }
      return { ok: false, code: 'unknown_version' };
    }
  }

  // 2. Accept header — media type negotiation.
  if (headers !== undefined) {
    const accept = findAcceptValue(headers);
    if (accept !== null) {
      const match = ACCEPT_VERSION_RE.exec(accept);
      if (match !== null) {
        const version = match[1]!;
        if (versionSet.has(version)) {
          return { ok: true, version };
        }
        return { ok: false, code: 'unknown_version' };
      }
      // Not a recognised vendor type → fall through to default.
    }
  }

  // 3. Default.
  return { ok: true, version: defaultVersion };
}

/**
 * Returns a value-free 404 Response. Suitable for returning when a version is
 * not supported and there is no fallback resource.
 */
export function versionedNotFound(): Response {
  return new Response(null, { status: 404 });
}

/**
 * Returns a value-free 406 Response. Suitable for returning when the Accept
 * header requests a version or media type the server cannot produce.
 */
export function versionedNotAcceptable(): Response {
  return new Response(null, { status: 406 });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Scans header keys for `accept` (case-insensitive), returning the first
 * non-empty trimmed value, or `null` when absent.
 */
function findAcceptValue(headers: Record<string, string>): string | null {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'accept') {
      const value = headers[key];
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }
  return null;
}
