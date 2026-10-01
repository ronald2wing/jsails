/**
 * Jamal runtime domain management: `jamal domain add|list|remove`.
 *
 * A production deploy routes traffic through the kamal-proxy container, and the
 * three `domain` verbs control that routing without re-running a full deploy.
 * They build their fixed `docker exec kamal-proxy ...` argv through the same
 * pure argv builders the production planner uses (`proxyDeployArgv`,
 * `proxyRemoveServiceArgv`, `proxyListArgv`) and execute it over the injected
 * {@link RemoteRunner} seam — the same ssh path `deploy` takes.
 *
 * `add <host>` binds a new public host to the LATEST deployed container (the
 * backend target is reconstructed from `.jamal/deploys.json` via
 * {@link containerNameForTag}, exactly as the remote inspection verbs do), so
 * there must already be a recorded deploy. `remove <host>` removes the service
 * (and its routed host) from the proxy — kamal-proxy removes by service, not by
 * host, so `<host>` is validated but the argv is service-scoped. `list` dumps
 * the proxy's routing table verbatim. All three require `config.production` for
 * the SSH target and resolve the service from `--service` (or `config.service`).
 *
 * These verbs drive the proxy's runtime `deploy`/`remove` API over ssh, not a
 * config file: a host bound by `add` is NOT recorded in `deploy.yml`, so a later
 * external `kamal deploy` (which regenerates the proxy from that file) may
 * overwrite or conflict with it. Use on-demand TLS for unknown/customer hosts,
 * and note that `--tls` static hosts and on-demand TLS are mutually exclusive.
 *
 * `--dry-run` prints the exact `ssh` argv without running it; no path here
 * writes a file or opens a connection beyond the remote runner.
 */

import { parseArgs } from 'node:util';

import { loadJamalConfig, type JamalConfig } from './config.js';
import { readDeployHistory, type DeployHistory } from './production/history.js';
import { containerNameForTag } from './production/plan.js';
import { proxyDeployArgv, proxyListArgv, proxyRemoveServiceArgv } from './production/proxy.js';
import { sshArgv } from './production/transport.js';
import { defaultRemoteRunner, formatError, type JamalDeps, usageError } from './plan-command.js';
import { DOMAIN_USAGE } from './usage.js';

/** Control characters plus DEL — never valid in a domain or service name. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Upper bound on a fully-qualified hostname (RFC 1035). */
const MAX_HOST_LENGTH = 253;

/** Raised for an invalid domain or service name. Messages never embed input. */
class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * Validate a public hostname and return it unchanged. The value must be a
 * lower-case DNS name: non-empty, at most 253 characters, no whitespace or
 * control characters, no wildcard, and only digits, lower-case letters, dots,
 * and internal hyphens — so a scheme (`https://`), a port (`:443`), a path
 * (`/check`), a query, a fragment, userinfo (`@`), an underscore, or an
 * upper-case label is rejected. Labels may not start or end with a hyphen, may
 * not exceed 63 characters, and the name may not start/end with a dot or
 * contain an empty label. The failure message names only the operation label.
 */
function assertDomainHost(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError(`${label} must be a non-empty hostname`);
  }
  if (value.length > MAX_HOST_LENGTH) {
    throw new DomainError(`${label} exceeds the maximum hostname length`);
  }
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new DomainError(`${label} must not contain whitespace or control characters`);
  }
  if (value.includes('*')) {
    throw new DomainError(`${label} must not contain a wildcard`);
  }
  if (/[^a-z0-9.-]/.test(value)) {
    throw new DomainError(`${label} must be a lower-case domain name`);
  }
  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    throw new DomainError(`${label} has an invalid domain format`);
  }
  for (const segment of value.split('.')) {
    if (segment.length > 63) {
      throw new DomainError(`${label} has a domain label that is too long`);
    }
    if (segment.startsWith('-') || segment.endsWith('-')) {
      throw new DomainError(`${label} has an invalid domain label`);
    }
  }
  return value;
}

/** Reject a service name that cannot be a safe proxy value, value-free. */
function assertService(value: string, label: string): string {
  if (value.length === 0) {
    throw new DomainError(`${label} must be a non-empty name`);
  }
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new DomainError(`${label} must not contain whitespace or control characters`);
  }
  return value;
}

/** Flags the `domain` verbs accept; parsed independently of the top-level set. */
const DOMAIN_OPTIONS = {
  service: { type: 'string' },
  'no-tls': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/** A loaded production config plus the resolved service and SSH target. */
interface DomainTarget {
  readonly config: JamalConfig;
  readonly service: string;
  readonly server: string;
}

/**
 * Load `jamal.config.js` from `deps.cwd` and require `config.production` (the
 * SSH target). Reports a value-free failure and resolves `undefined` so the
 * caller returns exit code 1.
 */
async function loadDomainTarget(deps: JamalDeps): Promise<DomainTarget | undefined> {
  const loader = deps.loadJamalConfig ?? ((dir: string) => loadJamalConfig(dir));
  let config: JamalConfig;
  try {
    config = await loader(deps.cwd);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return undefined;
  }
  if (config.production === undefined) {
    deps.stderr('jsails: config.production is required for `jamal domain`');
    return undefined;
  }
  return { config, service: config.service, server: config.production.server };
}

/** Read the deploy history, reporting a value-free failure and resolving undefined. */
async function readHistorySafe(deps: JamalDeps): Promise<DeployHistory | undefined> {
  const reader = deps.readHistory ?? ((dir: string) => readDeployHistory(dir));
  try {
    return await reader(deps.cwd);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return undefined;
  }
}

/** Print the exact ssh argv a run would execute, without executing it. */
function printDryRun(deps: JamalDeps, argv: readonly string[]): number {
  deps.stdout(`[dry-run] ${argv.join(' ')}`);
  return 0;
}

/**
 * Run one proxy argv over ssh and forward its output. A spawn failure or
 * timeout returns 1; a non-zero exit forwards stdout/stderr and returns the
 * command's exit code. Mirrors the remote inspection verbs' executor.
 */
async function runProxyCommand(
  deps: JamalDeps,
  server: string,
  argv: readonly string[],
  label: string,
): Promise<number> {
  const remote = deps.remoteRunner ?? defaultRemoteRunner;
  let result;
  try {
    result = await remote.run(server, argv);
  } catch (error) {
    deps.stderr(`jsails: ${label} failed: ${formatError(error)}`);
    return 1;
  }
  if (result.stdout !== '') {
    deps.stdout(result.stdout.replace(/\n$/, ''));
  }
  if (result.stderr !== '') {
    deps.stderr(result.stderr.replace(/\n$/, ''));
  }
  if (result.exitCode !== 0) {
    deps.stderr(`jsails: ${label} exited with code ${result.exitCode}`);
  }
  return result.exitCode;
}

/**
 * Run the `jamal domain` command over the tokens after `domain`. Resolves to a
 * process exit code: 0 on success (including a dry run), 2 for a usage error
 * (bad flag, missing host, invalid host/service name), and 1 for a config,
 * history, or remote-run failure.
 */
export async function runDomainCommand(deps: JamalDeps, args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: DOMAIN_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(deps, formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    deps.stdout(DOMAIN_USAGE);
    return 0;
  }

  const subcommand = positionals[0];
  if (subcommand !== 'add' && subcommand !== 'list' && subcommand !== 'remove') {
    return usageError(deps, 'a subcommand is required (add | list | remove)');
  }

  if (subcommand === 'add' || subcommand === 'remove') {
    if (positionals[1] === undefined) {
      return usageError(deps, `"jamal domain ${subcommand}" requires a host`);
    }
    if (positionals.length > 2) {
      return usageError(deps, `unexpected argument: ${positionals.slice(2).join(' ')}`);
    }
  } else if (positionals.length > 1) {
    return usageError(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
  }

  const loaded = await loadDomainTarget(deps);
  if (loaded === undefined) {
    return 1;
  }
  const { config, server } = loaded;

  let service: string;
  let host: string | undefined;
  try {
    service = assertService(values.service ?? config.service, '--service');
    if (subcommand === 'add' || subcommand === 'remove') {
      host = assertDomainHost(positionals[1], 'domain');
    }
  } catch (error) {
    return usageError(deps, formatError(error));
  }

  if (subcommand === 'list') {
    const argv = proxyListArgv();
    return values['dry-run']
      ? printDryRun(deps, sshArgv(server, argv))
      : runProxyCommand(deps, server, argv, 'domain list');
  }

  if (subcommand === 'remove') {
    const argv = proxyRemoveServiceArgv({ service });
    return values['dry-run']
      ? printDryRun(deps, sshArgv(server, argv))
      : runProxyCommand(deps, server, argv, 'domain remove');
  }

  // `add` resolves the backend target from the latest recorded deploy.
  const history = await readHistorySafe(deps);
  if (history === undefined) {
    return 1;
  }
  const entry = history.entries[history.entries.length - 1];
  if (entry === undefined) {
    deps.stderr('jsails: no deploy history to route a domain; run "jsails jamal deploy" first');
    return 1;
  }
  const target = containerNameForTag(service, entry.tag);
  const argv = proxyDeployArgv({ service, target, host, tls: !values['no-tls'] });
  return values['dry-run']
    ? printDryRun(deps, sshArgv(server, argv))
    : runProxyCommand(deps, server, argv, 'domain add');
}
