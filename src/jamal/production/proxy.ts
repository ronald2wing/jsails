/**
 * kamal-proxy component control for jamal production deploys.
 *
 * The proxy is a server-side kamal-proxy container: JSails does not reimplement
 * it, it controls it over ssh. The pure argv builders assemble the fixed
 * `docker` argv arrays — booting the proxy container, deploying/removing a
 * service, listing services, and querying container status — never shell
 * interpolated, so a hostile value can never become a shell fragment or a
 * docker option. The executors run those argv over an injected
 * {@link RemoteRunner} (the same ssh seam the rest of the production slice
 * uses) and convert a non-zero exit into a value-free {@link ProxyError} that
 * names only the operation and the exit code — the service name, target, host,
 * image, and any docker output are never echoed.
 *
 * The default image is {@link PROXY_IMAGE_DEFAULT}, pinned to kamal-proxy
 * v0.10.0 (the first tagged release with on-demand TLS). Kamal itself still
 * defaults to proxy v0.9.2, so a caller driving on-demand TLS through an
 * external `kamal deploy` must bump its proxy image explicitly.
 */

import type { CommandResult } from './command-runner.js';
import type { RemoteRunner } from './transport.js';

/** The fixed kamal-proxy container name the engine controls. */
export const PROXY_CONTAINER_NAME = 'kamal-proxy';

/**
 * The default kamal-proxy image, pinned to v0.10.0 (the first tagged release
 * with on-demand TLS). Kamal itself still defaults to v0.9.2, so a caller
 * driving on-demand TLS through an external `kamal deploy` must bump its proxy
 * image to at least this version explicitly.
 */
export const PROXY_IMAGE_DEFAULT = 'basecamp/kamal-proxy:v0.10.0';

/** The named volume persisting kamal-proxy's configuration. */
export const PROXY_CONFIG_VOLUME_DEFAULT = 'kamal-proxy-config';

/** The in-container mount path for {@link PROXY_CONFIG_VOLUME_DEFAULT}. */
export const PROXY_CONFIG_MOUNT = '/home/kamal-proxy/.config/kamal-proxy';

/** The default published HTTP port (`-p <port>:80`). */
export const PROXY_HTTP_PORT_DEFAULT = 80;

/** The default published HTTPS port (`-p <port>:443`). */
export const PROXY_HTTPS_PORT_DEFAULT = 443;

/** Control characters plus DEL — never valid in a proxy value. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Upper bound on a published port. */
const MAX_PORT = 65535;

/** Raised for an invalid proxy value or a non-zero proxy command. Value-free. */
export class ProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyError';
  }
}

/** Options for {@link proxyBootArgv} and {@link proxyBoot}. */
interface ProxyBootOptions {
  /** The proxy image; defaults to {@link PROXY_IMAGE_DEFAULT}. */
  readonly image?: string;
  /** The config volume name; defaults to {@link PROXY_CONFIG_VOLUME_DEFAULT}. */
  readonly configVolume?: string;
  /** The published HTTP port; defaults to {@link PROXY_HTTP_PORT_DEFAULT}. */
  readonly httpPort?: number;
  /** The published HTTPS port; defaults to {@link PROXY_HTTPS_PORT_DEFAULT}. */
  readonly httpsPort?: number;
  /** Publish a Prometheus metrics port (`-p <port>:9090`). */
  readonly metricsPort?: number;
}

/** Options for {@link proxyDeployArgv} and {@link proxyDeployService}. */
interface ProxyDeployOptions {
  /** The service name the proxy routes (stable across deploys). */
  readonly service: string;
  /** The backend target (the new container) the proxy forwards traffic to. */
  readonly target: string;
  /**
   * The public hostname to route. Omitted (and therefore not required) when
   * `onDemandTlsUrl` is set: the two flags are mutually exclusive in
   * kamal-proxy.
   */
  readonly host?: string;
  /** Emit `--tls` to terminate TLS at the proxy. */
  readonly tls?: boolean;
  /** Emit `--tls-staging` to use the ACME staging endpoint. Requires `tls: true`. */
  readonly tlsStaging?: boolean;
  /** The backend health-check path (`--health-check-path <path>`). */
  readonly healthCheckPath?: string;
  /** Emit `--path-prefix <path>` to route a path prefix upstream. */
  readonly pathPrefix?: string;
  /** Emit `--strip-path-prefix` to strip the path prefix from upstream requests. */
  readonly stripPathPrefix?: boolean;
  /** Emit `--tls-on-demand-url <url>` and omit `--host`. */
  readonly onDemandTlsUrl?: string;
  /** Emit `--target-timeout <dur>` for the backend request timeout. */
  readonly targetTimeout?: string;
  /** Emit `--max-request-body <bytes>` for the maximum request body size. */
  readonly maxRequestBody?: string;
  /** Emit `--max-response-body <bytes>` for the maximum response body size. */
  readonly maxResponseBody?: string;
  /** Emit `--health-check-interval <dur>` for the backend health-check interval. */
  readonly healthCheckInterval?: string;
  /** Emit `--health-check-timeout <dur>` for the backend health-check timeout. */
  readonly healthCheckTimeout?: string;
  /** Emit `--canonical-host <host>` to redirect to a canonical hostname. */
  readonly canonicalHost?: string;
  /** Emit `--tls-redirect` to redirect HTTP to HTTPS. */
  readonly tlsRedirect?: boolean;
  /** Emit `--forward-headers` to forward proxy headers upstream. */
  readonly forwardHeaders?: boolean;
  /** Emit `--client-ip-header <name>` for the client-IP header name. */
  readonly clientIpHeader?: string;
  /** Emit `--scope-cookie <name>` to scope session cookies by a prefix. */
  readonly scopeCookie?: string;
  /** Emit `--exclude-metrics` to exclude this service from proxy metrics. */
  readonly excludeMetrics?: boolean;
  /** Emit `--log-request-header <name>` for a request header to log. */
  readonly logRequestHeader?: string;
  /** Emit `--log-response-header <name>` for a response header to log. */
  readonly logResponseHeader?: string;
  /** Emit `--metrics-port <port>` to advertise the Prometheus metrics port on deploy. */
  readonly metricsPort?: number;
}

/** Options for {@link proxyRemoveServiceArgv} and {@link proxyRemoveService}. */
interface ProxyRemoveOptions {
  /** The service name to remove from the proxy. */
  readonly service: string;
}

/** Reject a proxy argv value that cannot be a safe single token, value-free. */
function assertValue(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProxyError(`${label} must be a non-empty string`);
  }
  if (/\s/.test(value) || CONTROL_CHARS.test(value)) {
    throw new ProxyError(`${label} must not contain whitespace or control characters`);
  }
  if (value.startsWith('-')) {
    throw new ProxyError(`${label} must not start with "-"`);
  }
  return value;
}

/** Reject a published port outside `1..65535`, value-free. */
function assertPort(port: number, label: string): number {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new ProxyError(`${label} must be an integer between 1 and ${MAX_PORT}`);
  }
  return port;
}

/**
 * Assemble the fixed `docker run` argv that boots the kamal-proxy container:
 * `docker run -d --restart unless-stopped --name kamal-proxy -p <http>:80
 * -p <https>:443 -v <volume>:/home/kamal-proxy/.config/kamal-proxy <image>
 * kamal-proxy run`. Every value is validated, and the ports default to 80/443.
 */
export function proxyBootArgv(options: ProxyBootOptions = {}): readonly string[] {
  const image = assertValue(options.image ?? PROXY_IMAGE_DEFAULT, 'the proxy image');
  const configVolume = assertValue(
    options.configVolume ?? PROXY_CONFIG_VOLUME_DEFAULT,
    'the proxy config volume',
  );
  const httpPort = assertPort(options.httpPort ?? PROXY_HTTP_PORT_DEFAULT, 'the proxy HTTP port');
  const httpsPort = assertPort(
    options.httpsPort ?? PROXY_HTTPS_PORT_DEFAULT,
    'the proxy HTTPS port',
  );
  const argv: string[] = [
    'docker',
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--name',
    PROXY_CONTAINER_NAME,
    '-p',
    `${httpPort}:80`,
    '-p',
    `${httpsPort}:443`,
  ];
  if (options.metricsPort !== undefined) {
    const metricsPort = assertPort(options.metricsPort, 'the proxy metrics port');
    argv.push('-p', `${metricsPort}:9090`);
  }
  argv.push('-v', `${configVolume}:${PROXY_CONFIG_MOUNT}`, image, 'kamal-proxy', 'run');
  return argv;
}

/**
 * Assemble the fixed `docker exec` argv that deploys a service through the
 * running proxy: `docker exec kamal-proxy kamal-proxy deploy <service> --target
 * <target> [--path-prefix <path>] [--strip-path-prefix] --host <host> [--tls]
 * [--health-check-path <path>] [--tls-on-demand-url <url>]`. When
 * `onDemandTlsUrl` is set, `--host` is omitted (the two are mutually exclusive
 * in kamal-proxy); otherwise `host` is required. `--path-prefix` must start
 * with `/`. Every present value is validated.
 */
export function proxyDeployArgv(options: ProxyDeployOptions): readonly string[] {
  const service = assertValue(options.service, 'the proxy service');
  const target = assertValue(options.target, 'the proxy target');
  const argv: string[] = [
    'docker',
    'exec',
    PROXY_CONTAINER_NAME,
    'kamal-proxy',
    'deploy',
    service,
    '--target',
    target,
  ];
  if (options.pathPrefix !== undefined) {
    const prefix = assertValue(options.pathPrefix, 'the proxy path prefix');
    if (!prefix.startsWith('/')) {
      throw new ProxyError('the proxy path prefix must start with "/"');
    }
    argv.push('--path-prefix', prefix);
  }
  if (options.stripPathPrefix === true) {
    argv.push('--strip-path-prefix');
  }
  if (options.onDemandTlsUrl === undefined) {
    argv.push('--host', assertValue(options.host, 'the proxy host'));
  }
  if (options.tls === true) {
    argv.push('--tls');
  }
  if (options.tlsStaging === true) {
    if (options.tls !== true) {
      throw new ProxyError('--tls-staging requires --tls');
    }
    argv.push('--tls-staging');
  }
  if (options.healthCheckPath !== undefined) {
    argv.push(
      '--health-check-path',
      assertValue(options.healthCheckPath, 'the proxy health-check path'),
    );
  }
  if (options.onDemandTlsUrl !== undefined) {
    argv.push(
      '--tls-on-demand-url',
      assertValue(options.onDemandTlsUrl, 'the proxy on-demand TLS URL'),
    );
  }
  if (options.targetTimeout !== undefined) {
    argv.push('--target-timeout', assertValue(options.targetTimeout, 'the proxy target timeout'));
  }
  if (options.maxRequestBody !== undefined) {
    argv.push(
      '--max-request-body',
      assertValue(options.maxRequestBody, 'the proxy max request body'),
    );
  }
  if (options.maxResponseBody !== undefined) {
    argv.push(
      '--max-response-body',
      assertValue(options.maxResponseBody, 'the proxy max response body'),
    );
  }
  if (options.healthCheckInterval !== undefined) {
    argv.push(
      '--health-check-interval',
      assertValue(options.healthCheckInterval, 'the proxy health-check interval'),
    );
  }
  if (options.healthCheckTimeout !== undefined) {
    argv.push(
      '--health-check-timeout',
      assertValue(options.healthCheckTimeout, 'the proxy health-check timeout'),
    );
  }
  if (options.canonicalHost !== undefined) {
    argv.push('--canonical-host', assertValue(options.canonicalHost, 'the proxy canonical host'));
  }
  if (options.tlsRedirect === true) {
    argv.push('--tls-redirect');
  }
  if (options.forwardHeaders === true) {
    argv.push('--forward-headers');
  }
  if (options.clientIpHeader !== undefined) {
    argv.push(
      '--client-ip-header',
      assertValue(options.clientIpHeader, 'the proxy client IP header'),
    );
  }
  if (options.scopeCookie !== undefined) {
    argv.push('--scope-cookie', assertValue(options.scopeCookie, 'the proxy scope cookie'));
  }
  if (options.excludeMetrics === true) {
    argv.push('--exclude-metrics');
  }
  if (options.logRequestHeader !== undefined) {
    argv.push(
      '--log-request-header',
      assertValue(options.logRequestHeader, 'the proxy log request header'),
    );
  }
  if (options.logResponseHeader !== undefined) {
    argv.push(
      '--log-response-header',
      assertValue(options.logResponseHeader, 'the proxy log response header'),
    );
  }
  if (options.metricsPort !== undefined) {
    argv.push('--metrics-port', String(assertPort(options.metricsPort, 'the proxy metrics port')));
  }
  return argv;
}

/**
 * Assemble the fixed `docker exec` argv that removes a service from the proxy:
 * `docker exec kamal-proxy kamal-proxy remove <service>`.
 */
export function proxyRemoveServiceArgv(options: ProxyRemoveOptions): readonly string[] {
  const service = assertValue(options.service, 'the proxy service');
  return ['docker', 'exec', PROXY_CONTAINER_NAME, 'kamal-proxy', 'remove', service];
}

/** Assemble the fixed `docker exec` argv that lists the proxy's services. */
export function proxyListArgv(): readonly string[] {
  return ['docker', 'exec', PROXY_CONTAINER_NAME, 'kamal-proxy', 'list'];
}

/** Assemble the fixed `docker inspect` argv that reports the proxy container. */
export function proxyStatusArgv(): readonly string[] {
  return ['docker', 'inspect', PROXY_CONTAINER_NAME];
}

/** Run a proxy argv over ssh and reject a non-zero exit, value-free. */
async function runProxyCommand(
  remote: RemoteRunner,
  server: string,
  argv: readonly string[],
  operation: string,
): Promise<CommandResult> {
  const result = await remote.run(server, argv);
  if (result.exitCode !== 0) {
    throw new ProxyError(`${operation} exited with code ${result.exitCode}`);
  }
  return result;
}

/**
 * Report whether the kamal-proxy container exists (`docker inspect` exit zero).
 * A non-zero exit is a valid "not present" answer, not an operation failure, so
 * it resolves `false` rather than throwing.
 */
export async function proxyStatus(remote: RemoteRunner, server: string): Promise<boolean> {
  const result = await remote.run(server, proxyStatusArgv());
  return result.exitCode === 0;
}

/** Boot the proxy container on `server`; throws a value-free error on non-zero. */
export async function proxyBoot(
  remote: RemoteRunner,
  server: string,
  options: ProxyBootOptions = {},
): Promise<void> {
  await runProxyCommand(remote, server, proxyBootArgv(options), 'proxy boot');
}

/** Deploy a service through the proxy on `server`; value-free error on non-zero. */
export async function proxyDeployService(
  remote: RemoteRunner,
  server: string,
  options: ProxyDeployOptions,
): Promise<void> {
  await runProxyCommand(remote, server, proxyDeployArgv(options), 'proxy deploy');
}

/** Remove a service from the proxy on `server`; value-free error on non-zero. */
export async function proxyRemoveService(
  remote: RemoteRunner,
  server: string,
  options: ProxyRemoveOptions,
): Promise<void> {
  await runProxyCommand(remote, server, proxyRemoveServiceArgv(options), 'proxy remove');
}

/** List the proxy's services on `server`; resolves the result, value-free error on non-zero. */
export async function proxyList(remote: RemoteRunner, server: string): Promise<CommandResult> {
  return runProxyCommand(remote, server, proxyListArgv(), 'proxy list');
}
