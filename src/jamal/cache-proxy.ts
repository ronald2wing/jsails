/**
 * Jamal cache-proxy command: `jamal cache-proxy <plan|status>`.
 *
 * The cache proxy is an opt-in Varnish reverse proxy between kamal-proxy and the
 * app container, toggled by `cacheProxy.enabled` in the jamal config. These two
 * verbs are the read-only CLI surface for it:
 *
 * - `status` reports the configuration (enabled state, image, size, and cookie
 *   allowlist) plus how to switch it on or off.
 * - `plan` prints the VCL that `jamal deploy` would write, with the cookie
 *   allowlist applied, so a human can review the cache policy before deploying.
 *
 * Both verbs are pure planners: they load the config and print text, and never
 * execute docker, ssh, or any other command. There is no `--dry-run` because
 * nothing runs.
 */

import { parseArgs } from 'node:util';

import { loadJamalConfig, type JamalConfig } from './config.js';
import { formatError, type JamalDeps, usageError } from './plan-command.js';
import {
  CACHE_PROXY_VCL_PATH,
  resolveVcl,
  type ResolveVclOptions,
} from './production/cache-proxy.js';
import { containerNameForTag } from './production/plan.js';
import { CACHE_PROXY_USAGE } from './usage.js';

/** The recognised cache-proxy verbs. */
const VERBS = new Set(['plan', 'status']);

/** Flags the cache-proxy verbs accept; parsed independently of the top-level set. */
const CACHE_PROXY_OPTIONS = {
  tag: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/** The image tag used to derive the plan's backend container name when `--tag` is absent. */
const DEFAULT_PLAN_TAG = 'latest';

/** Render the cookie allowlist as a one-line summary for human consumption. */
function formatAllowlist(allowlist: readonly string[] | undefined): string {
  if (allowlist === undefined || allowlist.length === 0) {
    return 'none (every cookie-bearing request bypasses the cache)';
  }
  return allowlist.join(', ');
}

/** Print the `cache-proxy status` report. Reads the config, never the server. */
function printStatus(stdout: (text: string) => void, config: JamalConfig): void {
  const cacheProxy = config.cacheProxy;
  if (cacheProxy === undefined) {
    stdout('cache proxy: not configured');
    stdout('');
    stdout('To enable: add "cacheProxy": { "enabled": true } to jamal.config.js,');
    stdout('then run "jsails jamal deploy" to boot it.');
    return;
  }
  stdout(`cache proxy: ${cacheProxy.enabled ? 'enabled' : 'disabled'}`);
  stdout(`image: ${cacheProxy.image}`);
  stdout(`size: ${cacheProxy.size}`);
  stdout(`cookie allowlist: ${formatAllowlist(cacheProxy.cookieAllowlist)}`);
  if (!cacheProxy.enabled) {
    stdout('');
    stdout('To enable: set "cacheProxy.enabled": true in jamal.config.js,');
    stdout('then run "jsails jamal deploy" to boot it.');
  }
}

/**
 * Run the `jamal cache-proxy` command over the tokens after `cache-proxy`.
 * Resolves to a process exit code: 0 on success, 2 for a usage error, and 1 for
 * a config-load failure or a disabled cache proxy on `plan`.
 */
export async function runCacheProxyCommand(
  deps: JamalDeps,
  args: readonly string[],
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: CACHE_PROXY_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(deps, formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    deps.stdout(CACHE_PROXY_USAGE);
    return 0;
  }

  const verb = positionals[0];
  if (verb === undefined || !VERBS.has(verb)) {
    return usageError(deps, 'a verb is required (plan | status)');
  }
  if (positionals.length > 1) {
    return usageError(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
  }
  if (values.tag !== undefined && verb !== 'plan') {
    return usageError(deps, '--tag is only valid for `jamal cache-proxy plan`');
  }

  const loader = deps.loadJamalConfig ?? ((dir: string) => loadJamalConfig(dir));
  let config: JamalConfig;
  try {
    config = await loader(deps.cwd);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  if (verb === 'status') {
    printStatus(deps.stdout, config);
    return 0;
  }

  // `plan` prints the VCL the deploy would write; it is meaningless when the
  // cache proxy is off, because `jamal deploy` would not write one.
  if (config.cacheProxy?.enabled !== true) {
    deps.stderr('jsails: cacheProxy.enabled must be true to plan the cache proxy');
    return 1;
  }

  let vcl: string;
  try {
    const backend = containerNameForTag(config.service, values.tag ?? DEFAULT_PLAN_TAG);
    const options: ResolveVclOptions = { cookieAllowlist: config.cacheProxy.cookieAllowlist };
    vcl = resolveVcl(backend, 3000, options);
    deps.stdout(
      `cache proxy plan (backend ${backend}, port 3000; written to ${CACHE_PROXY_VCL_PATH})`,
    );
    deps.stdout('');
    deps.stdout(vcl);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
  return 0;
}
