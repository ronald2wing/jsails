/**
 * Varnish caching reverse-proxy accessory for jamal production deploys.
 *
 * When enabled via {@link JamalCacheProxyConfig.enabled}, jamal boots a Varnish
 * container on the target server and routes traffic through it:
 *
 *   client -> kamal-proxy (TLS, routing, zero-downtime switch)
 *          -> varnish (plaintext, internal Docker network, caches public shells)
 *          -> app container
 *
 * The cache proxy is OPT-IN (default OFF) and switchable later by toggling
 * `cacheProxy.enabled` in the jamal config — it is never forced on every app.
 *
 * This module is a SIBLING of {@link proxy.ts}, not a reimplementation of it:
 * it mirrors the same style (pure validated argv-builder functions returning
 * `readonly string[]`, frozen constants, value-free typed errors,
 * `assertValue`/`assertPort`-style guards, and executors over an injected
 * {@link RemoteRunner}) for a Varnish container that sits BETWEEN kamal-proxy
 * and the application container on the internal Docker network.
 *
 * Two plan steps are required to boot the cache proxy:
 *
 *   1. `cache-proxy:write-vcl` — writes the VCL file onto the server via a
 *      base64-encoded `sh -c` command. Base64 avoids every shell escaping
 *      concern because the encoded payload contains only alphanumerics, `+`,
 *      `/`, and `=` — none of which are special in single-quoted strings.
 *   2. `cache-proxy:boot` — boots the Varnish container with the VCL file
 *      bind-mounted read-only.
 *
 * The VCL is shipped as a fixed string constant, {@link DEFAULT_VCL}, with
 * placeholder markers (`__BACKEND_HOST__` and `__BACKEND_PORT__`) resolved at
 * deploy time by {@link resolveVcl}. It is never read from disk. When a cookie
 * allowlist is configured, {@link resolveVcl} replaces the pass-on-any-cookie
 * block with one that strips only the allowlisted pairs and passes any request
 * that still carries another cookie.
 *
 * The default image is pinned to {@link CACHE_PROXY_IMAGE_DEFAULT} — the
 * official `varnish` image at a specific tagged version so a config that
 * omits `image` does not silently pick up a breaking upgrade.
 */

import type { CommandResult } from './command-runner.js';
import type { RemoteRunner } from './transport.js';

/** The fixed Varnish container name jamal controls. */
export const CACHE_PROXY_CONTAINER_NAME = 'jamal-cache-proxy';

/**
 * The default Varnish image, pinned to varnish:7.7 (the latest stable release
 * as of October 2025). It is a single-digit semver track distinct from the
 * `stable`/`latest` rolling tags.
 */
export const CACHE_PROXY_IMAGE_DEFAULT = 'varnish:7.7';

/** The internal port Varnish listens on for backend traffic (the Varnish default). */
export const CACHE_PROXY_PORT_DEFAULT = 6081;

/** The default memory size for the Varnish cache (`-e VARNISH_SIZE=...`). */
export const CACHE_PROXY_SIZE_DEFAULT = '256m';

/** The VCL file path on the server host where the VCL is written before boot. */
export const CACHE_PROXY_VCL_PATH = '/etc/varnish/default.vcl';

/** Control characters plus DEL — never valid in a cache-proxy value. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Upper bound on a published port. */
const MAX_PORT = 65535;

/** Raised for an invalid cache-proxy value or a non-zero command. Value-free. */
export class CacheProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheProxyError';
  }
}

/** Options for {@link cacheProxyBootArgv}. */
export interface CacheProxyBootOptions {
  /** The Varnish image; defaults to {@link CACHE_PROXY_IMAGE_DEFAULT}. */
  readonly image?: string;
  /** The memory size string (`-e VARNISH_SIZE=...`); defaults to {@link CACHE_PROXY_SIZE_DEFAULT}. */
  readonly size?: string;
}

/** Reject a cache-proxy value that cannot be a safe single token, value-free. */
function assertValue(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CacheProxyError(`${label} must be a non-empty string`);
  }
  if (/\s/.test(value) || CONTROL_CHARS.test(value)) {
    throw new CacheProxyError(`${label} must not contain whitespace or control characters`);
  }
  if (value.startsWith('-')) {
    throw new CacheProxyError(`${label} must not start with "-"`);
  }
  return value;
}

/** Reject a published port outside `1..65535`, value-free. */
function assertPort(port: number, label: string): number {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new CacheProxyError(`${label} must be an integer between 1 and ${MAX_PORT}`);
  }
  return port;
}

/**
 * Assemble the `sh -c` argv that writes the VCL file onto the server.
 *
 * The VCL content is base64-encoded so the `sh -c` argument contains only
 * alphanumerics, `+`, `/`, and `=` — none of which are special in
 * single-quoted strings. This avoids every shell escaping concern: no
 * backslash, quote, dollar-sign, or newline can break the command. The
 * destination path is a fixed constant, and the encoded payload is decoded
 * via `base64 -d > <path>`.
 *
 * The caller prefixes this with `ssh <server>` to make it a remote step.
 */
export function cacheProxyWriteVclArgv(vclContent: string): readonly string[] {
  if (typeof vclContent !== 'string' || vclContent.length === 0) {
    throw new CacheProxyError('the cache-proxy VCL content must be a non-empty string');
  }
  const encoded = Buffer.from(vclContent, 'utf8').toString('base64');
  return ['sh', '-c', `echo '${encoded}' | base64 -d > ${CACHE_PROXY_VCL_PATH}`];
}

/**
 * Assemble the fixed `docker run` argv that boots the Varnish cache-proxy
 * container.
 *
 *   docker run -d --restart unless-stopped --name jamal-cache-proxy
 *     -e VARNISH_SIZE=<size> -p 127.0.0.1:6081:6081
 *     -v <vclPath>:<vclPath>:ro <image>
 *
 * The VCL file must already exist on the server (written by the preceding
 * `cache-proxy:write-vcl` step). Varnish listens on 127.0.0.1:6081 — internal
 * only — so kamal-proxy routes to it on the Docker host's loopback.
 *
 * Every value is validated; ports and paths are fixed constants.
 */
export function cacheProxyBootArgv(options: CacheProxyBootOptions = {}): readonly string[] {
  const image = assertValue(options.image ?? CACHE_PROXY_IMAGE_DEFAULT, 'the cache-proxy image');
  const size = assertValue(options.size ?? CACHE_PROXY_SIZE_DEFAULT, 'the cache-proxy size');

  return [
    'docker',
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--name',
    CACHE_PROXY_CONTAINER_NAME,
    '-e',
    `VARNISH_SIZE=${size}`,
    '-p',
    `127.0.0.1:${CACHE_PROXY_PORT_DEFAULT}:${CACHE_PROXY_PORT_DEFAULT}`,
    '-v',
    `${CACHE_PROXY_VCL_PATH}:${CACHE_PROXY_VCL_PATH}:ro`,
    image,
  ];
}

/** Assemble the `docker inspect` argv that reports the cache-proxy container. */
export function cacheProxyStatusArgv(): readonly string[] {
  return ['docker', 'inspect', CACHE_PROXY_CONTAINER_NAME];
}

/** Assemble the `docker ps` argv that lists the cache-proxy container. */
export function cacheProxyListArgv(): readonly string[] {
  return ['docker', 'ps', '--filter', `name=${CACHE_PROXY_CONTAINER_NAME}`];
}

/**
 * Assemble a health-check argv that probes Varnish's process state.
 *
 * `varnishlog -c -n /tmp` exits zero when the VSM (shared memory) is
 * accessible, which means the varnishd process is up. The `-c` flag filters
 * to client connections and exits immediately when there is nothing to read
 * (varnishlog 7.x behaviour).
 */
export function cacheProxyHealthArgv(): readonly string[] {
  return ['docker', 'exec', CACHE_PROXY_CONTAINER_NAME, 'varnishlog', '-c', '-n', '/tmp'];
}

/** Run a cache-proxy argv over ssh and reject a non-zero exit, value-free. */
async function runCacheProxyCommand(
  remote: RemoteRunner,
  server: string,
  argv: readonly string[],
  operation: string,
): Promise<CommandResult> {
  const result = await remote.run(server, argv);
  if (result.exitCode !== 0) {
    throw new CacheProxyError(`${operation} exited with code ${result.exitCode}`);
  }
  return result;
}

/**
 * Report whether the cache-proxy container exists (`docker inspect` exit zero).
 * A non-zero exit is a valid "not present" answer, not an operation failure.
 */
export async function cacheProxyStatus(remote: RemoteRunner, server: string): Promise<boolean> {
  const result = await remote.run(server, cacheProxyStatusArgv());
  return result.exitCode === 0;
}

/** Boot the cache-proxy container on `server`; throws a value-free error on non-zero. */
export async function cacheProxyBoot(
  remote: RemoteRunner,
  server: string,
  options: CacheProxyBootOptions,
): Promise<void> {
  await runCacheProxyCommand(remote, server, [...cacheProxyBootArgv(options)], 'cache-proxy boot');
}

// ---------------------------------------------------------------------------
// Default VCL
// ---------------------------------------------------------------------------

/** Placeholder for the backend host in the VCL — replaced by {@link resolveVcl}. */
const VCL_BACKEND_HOST = '__BACKEND_HOST__';

/** Placeholder for the backend port in the VCL — replaced by {@link resolveVcl}. */
const VCL_BACKEND_PORT = '__BACKEND_PORT__';

/** The app port where Varnish forwards traffic inside the Docker network. */
const DEFAULT_APP_PORT = 3000;

/**
 * The default cookie policy: any cookie-bearing request is passed through (a
 * session must never be served from cache), and cookies are stripped from the
 * cacheable (cookie-less) requests that follow so the cache key is stable.
 *
 * This is the block {@link resolveVcl} replaces with the cookie-allowlist block
 * when {@link ResolveVclOptions.cookieAllowlist} is set, so the two policies
 * share one source of truth for the surrounding `vcl_recv` structure.
 */
const COOKIE_PASS_ALL_VCL = `  if (req.http.Cookie) {
    return (pass);
  }

  unset req.http.Cookie;`;

/**
 * The default Varnish Configuration Language file as a string constant.
 *
 * Every line of the cache policy is deliberate:
 *
 * - `return(pass)` for non-GET/HEAD — caching a POST/PUT/DELETE response is
 *   never correct.
 * - `return(pass)` for `^/_jsails/` — broadcast, server-component updates, and
 *   the introspect endpoint are all session-bound or signed and must never be
 *   served from cache.
 * - `return(pass)` when a cookie is present — a session-bearing request is
 *   passed through to the origin.
 * - Strip cookies otherwise so the cache key is stable across visitors.
 * - In `vcl_backend_response`, default-deny: only cache when the origin sent
 *   `Surrogate-Control` or `Cache-Control` with a max-age; set
 *   `beresp.uncacheable = true` otherwise. Never store a response with
 *   `Set-Cookie`.
 * - `beresp.grace = 1h` — serve stale content while revalidating, so a backend
 *   failure during revalidation returns the previous valid response.
 */
export const DEFAULT_VCL = `vcl 4.1;

import std;

backend default {
  .host = "${VCL_BACKEND_HOST}";
  .port = "${VCL_BACKEND_PORT}";
}

acl purgers {
  "127.0.0.1";
  "172.16.0.0"/12;
  "10.0.0.0"/8;
}

sub vcl_recv {
  if (req.method == "PURGE") {
    if (!client.ip ~ purgers) {
      return (synth(405, "Not allowed"));
    }
    return (purge);
  }

  if (req.method != "GET" && req.method != "HEAD") {
    return (pass);
  }

  if (req.url ~ "^/_jsails/") {
    return (pass);
  }

  ${COOKIE_PASS_ALL_VCL}
}

sub vcl_backend_response {
  if (beresp.http.Surrogate-Control) {
    if (beresp.http.Surrogate-Control ~ "max-age" && beresp.http.Surrogate-Control !~ "no-store") {
    } else {
      set beresp.uncacheable = true;
    }
  } elsif (beresp.http.Cache-Control ~ "public" && beresp.http.Cache-Control ~ "max-age" && beresp.http.Cache-Control !~ "no-store" && beresp.http.Cache-Control !~ "private") {
  } else {
    set beresp.uncacheable = true;
  }

  if (beresp.http.Set-Cookie) {
    set beresp.uncacheable = true;
  }

  set beresp.grace = 1h;
  set beresp.keep = 30m;
}

sub vcl_deliver {
  if (obj.hits > 0) {
    set resp.http.X-Cache = "HIT";
    set resp.http.X-Cache-Hits = obj.hits;
  } else {
    set resp.http.X-Cache = "MISS";
  }
}
`;

/**
 * Options for {@link resolveVcl}.
 */
export interface ResolveVclOptions {
  /**
   * Cookie names whose pairs are stripped from a request so it can be cached.
   * `undefined` (or an empty list) keeps the default pass-on-any-cookie policy.
   */
  readonly cookieAllowlist?: readonly string[];
}

/** Regex metacharacters escaped when a cookie name is embedded in VCL. */
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** Escape a cookie name so it matches literally inside a VCL regular expression. */
function escapeRegExpLiteral(value: string): string {
  return value.replace(REGEX_META, '\\$&');
}

/**
 * Reject a cookie allowlist entry that cannot be embedded safely in the VCL.
 * Defense in depth: the config schema already bounds entries to non-empty
 * strings, but the generated VCL embeds each name inside a double-quoted regex
 * string, so a quote or backslash would break the literal even when the config
 * checks pass. The error is value-free.
 */
function assertCookieName(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CacheProxyError('cookie allowlist entries must be non-empty strings');
  }
  if (/\s/.test(value) || CONTROL_CHARS.test(value)) {
    throw new CacheProxyError(
      'cookie allowlist entries must not contain whitespace or control characters',
    );
  }
  if (value.includes('"') || value.includes('\\')) {
    throw new CacheProxyError('cookie allowlist entries must not contain quotes or backslashes');
  }
  return value;
}

/**
 * Generate the cookie-allowlist policy block that replaces
 * {@link COOKIE_PASS_ALL_VCL}: strip each allowlisted pair with `regsuball`,
 * then `unset` the header only when nothing but separators remains (the request
 * is now cookie-less and cacheable); pass through when any other cookie remains.
 *
 * The `(^|; *)` anchor and the `[^;]*` value follow the literal-space idiom
 * used across Varnish cookie-stripping snippets (`regsuball(req.http.Cookie,
 * "(^|; *)NAME=[^;]*", "")`). It deliberately avoids `\s` and relies on
 * `; *` / `[; ]*` because a literal space in a character class is more portable
 * across Varnish releases than the `\s` escape.
 */
function buildCookieAllowlistVcl(allowlist: readonly string[]): string {
  const strips = allowlist
    .map(
      (name) =>
        `    set req.http.Cookie = regsuball(req.http.Cookie, "(^|; *)${escapeRegExpLiteral(name)}=[^;]*", "");`,
    )
    .join('\n');
  return `  if (req.http.Cookie) {
    # Cookie allowlist: strip each allowlisted pair, then pass only when a
    # non-allowlisted pair remains. Removing every allowlisted pair leaves the
    # header holding only separators, so a "no cookies left" request is
    # cacheable; any leftover pair is session/state and must bypass the cache.
${strips}
    if (req.http.Cookie ~ "^[; ]*$") {
      unset req.http.Cookie;
    } else {
      return (pass);
    }
  }`;
}

/**
 * Resolve the VCL content for a deploy, replacing the backend host and port
 * placeholders with the actual runtime values. When a cookie allowlist is
 * given, the pass-on-any-cookie block is replaced with an allowlist block that
 * strips only the named pairs. The VCL body is a generated constant — only the
 * host, port, and cookie policy are configurable.
 */
export function resolveVcl(
  backendHost: string,
  backendPort: number = DEFAULT_APP_PORT,
  options: ResolveVclOptions = {},
): string {
  assertValue(backendHost, 'the VCL backend host');
  assertPort(backendPort, 'the VCL backend port');
  const base = DEFAULT_VCL.replaceAll(VCL_BACKEND_HOST, backendHost).replaceAll(
    VCL_BACKEND_PORT,
    String(backendPort),
  );
  const allowlist = options.cookieAllowlist;
  if (allowlist === undefined || allowlist.length === 0) {
    return base;
  }
  const validated = allowlist.map((name) => assertCookieName(name));
  return base.replace(COOKIE_PASS_ALL_VCL, buildCookieAllowlistVcl(validated));
}
