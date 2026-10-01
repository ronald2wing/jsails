/**
 * Jamal describe / launch / ssh argv planners. Pure projection of the config
 * with no secret values, and argv builders that never execute.
 *
 * {@link describeJamal} projects the service, server, domain, ports, and
 * declared services from a {@link JamalConfig} without any env values.
 * {@link planLaunchArgv} picks the platform-appropriate opener for a URL.
 * {@link planSshArgv} assembles the `ssh` argv from the production config.
 *
 * No environment variable is read and no process is spawned here.
 */

import { type JamalConfig } from './config.js';
import { sshArgv } from './production/transport.js';

/** A pure projection of a Jamal config for human consumption. */
export interface DescribeInfo {
  /** The service (app container) name. */
  readonly service: string;
  /** The production server, when configured. */
  readonly server: string | undefined;
  /** The production domain, when configured. */
  readonly domain: string | undefined;
  /** Published ports from the local overlay. */
  readonly ports: Readonly<Record<string, number>>;
  /** Declared backing service names. */
  readonly services: readonly string[];
}

/** Raised when a launch URL is not http(s). */
export class DescribeError extends Error {
  constructor() {
    super('the launch URL must start with http:// or https://');
    this.name = 'DescribeError';
  }
}

/**
 * Build a {@link DescribeInfo} from a normalized config. `env` values are
 * never projected (they may carry secrets). The function is pure: it reads
 * no environment and writes no file.
 */
export function describeJamal(config: JamalConfig): DescribeInfo {
  return {
    service: config.service,
    server: config.production?.server,
    domain: config.production?.domain,
    ports: { ...config.local.ports },
    services: Object.keys(config.services),
  };
}

/**
 * Build the argv for opening a URL in the platform browser.
 *
 * - Darwin (`process.platform === 'darwin'`) → `['open', url]`
 * - Everything else → `['xdg-open', url]`
 *
 * The URL is validated as `http(s)`. A non-http URL or one with
 * control characters raises a value-free {@link DescribeError}.
 */
export function planLaunchArgv(url: string): readonly string[] {
  assertLaunchUrl(url);

  if (process.platform === 'darwin') {
    return ['open', url];
  }
  return ['xdg-open', url];
}

/** Reject a non-http(s) URL or one with control characters, value-free. */
function assertLaunchUrl(url: string): void {
  if (typeof url !== 'string' || url.length === 0) {
    throw new DescribeError();
  }
  const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
  if (CONTROL_CHARS.test(url)) {
    throw new DescribeError();
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new DescribeError();
  }
}

/**
 * Build the `ssh` argv for connecting to the configured production server
 * with no remote command. The server is taken from `config.production.server`
 * and the SSH options from `config.production.ssh`.
 *
 * Returns `['ssh']` (bare ssh, no arguments) when no production config is set.
 */
export function planSshArgv(config: JamalConfig): readonly string[] {
  const prod = config.production;
  if (prod === undefined) {
    return ['ssh'];
  }

  return sshArgv(prod.server, [], { ssh: prod.ssh });
}
