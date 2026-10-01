/**
 * Default security headers emitted on every framework-owned HTTP response.
 *
 * The three headers below are universally beneficial and carry no per-app
 * configuration requirement:
 * - `X-Content-Type-Options: nosniff` — prevents MIME-sniffing attacks.
 * - `X-Frame-Options: SAMEORIGIN` — prevents clickjacking from third-party
 *   origins; a page that genuinely needs framing can override this with an
 *   explicit `X-Frame-Options` (or `Content-Security-Policy: frame-ancestors`),
 *   and the framework leaves that override in place.
 * - `Referrer-Policy: strict-origin-when-cross-origin` — limits referrer
 *   leakage to same-origin navigation while preserving the referrer path for
 *   same-origin analytics.
 *
 * Deliberately NOT defaults (matching Rails' `default_headers` minus the legacy
 * Flash-era entries, and OWASP Secure Headers guidance):
 * - `Content-Security-Policy` needs a per-app nonce/hash policy — a blind
 *   default would break inline scripts and styles. Opt in with a per-app header.
 * - `Strict-Transport-Security` is a host/HTTPS concern the deploy operator
 *   sets at the reverse-proxy or load-balancer layer; a framework default on
 *   localhost blocks development and is trivially forgotten behind TLS
 *   termination.
 * - `X-XSS-Protection` is obsolete (filter mode removed from all modern
 *   browsers in favour of CSP); `X-Permitted-Cross-Domain-Policies` is a
 *   Flash-era leftover.
 */

export const DEFAULT_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});
