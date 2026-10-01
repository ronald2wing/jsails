/**
 * Jamal local Docker Compose planner.
 *
 * {@link planLocal} turns a normalized {@link JamalConfig} into the single
 * `.jamal/compose.yml` that `jamal dev --write` materializes for local
 * development. It is pure: it reads only its argument, writes no file, reads no
 * environment variable, and its output is deterministic (stable key order, no
 * timestamps, no network or clock access).
 *
 * The backing services mirror the conventions established by the existing
 * development generators (`src/deploy/valkey-config.ts` and
 * `src/deploy/database-config.ts`) — the same pinned images, healthcheck
 * probes, named data volumes, and a private bridge network — inlined minimally
 * here so this planner carries no dependency on those modules. A backing
 * service publishes no port unless `config.local.ports` lists it, and then only
 * on loopback (`127.0.0.1:<host>:<internal>`).
 *
 * The `mailpit`/`adminer` service types are dev-only tools: they are rendered
 * after the backing services with fixed loopback ports (mailpit 1025+8025,
 * adminer 8080), never create a named data volume, and never join the
 * application service's `depends_on` graph — a tool is a convenience for a
 * human, not a dependency of the app.
 *
 * The application service exists only when `config.local.build` is true. No
 * secret value ever reaches the emitted file: every `config.env` entry, literal
 * or {@link SecretRef}, is rendered as `${KEY}` for Docker Compose to
 * interpolate from the host environment at container start — the value is never
 * written and is never read by this module.
 */

import { JamalConfigError, type JamalConfig, type JamalServiceType } from './config.js';

/** Relative path of the generated Compose file. */
export const LOCAL_COMPOSE_PATH = '.jamal/compose.yml';

/** Compose service key for the application container. */
const APP_SERVICE = 'app';

/** Port-name aliases that target the application service rather than a backing service. */
const APP_PORT_NAMES: ReadonlySet<string> = new Set(['web', 'app']);

/** Private bridge network every service joins. */
const NETWORK = 'jsails';

/** Image/healthcheck/volume conventions shared with the existing dev generators. */
interface ServiceConvention {
  readonly image: string;
  readonly internalPort: number;
  readonly volume: string;
  readonly dataDir: string;
  readonly healthcheckTest: string;
  readonly interval: string;
  readonly timeout: string;
  readonly retries: string;
}

const MARIADB: ServiceConvention = {
  image: 'mariadb:11.4',
  internalPort: 3306,
  volume: 'mariadb-data',
  dataDir: '/var/lib/mysql',
  healthcheckTest: '["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
  interval: '10s',
  timeout: '5s',
  retries: '10',
};

const POSTGRES: ServiceConvention = {
  image: 'postgres:16-alpine',
  internalPort: 5432,
  volume: 'postgres-data',
  dataDir: '/var/lib/postgresql/data',
  healthcheckTest: '["CMD-SHELL", "pg_isready -U ${DATABASE_USER} -d ${DATABASE_NAME}"]',
  interval: '10s',
  timeout: '5s',
  retries: '10',
};

const VALKEY: ServiceConvention = {
  image: 'valkey/valkey:8.0-alpine',
  internalPort: 6379,
  volume: 'valkey-data',
  dataDir: '/data',
  healthcheckTest: '["CMD", "valkey-cli", "ping"]',
  interval: '5s',
  timeout: '3s',
  retries: '5',
};

/** Dev-only tool conventions: fixed loopback ports, no data volume, optional probe. */
interface DevToolConvention {
  readonly image: string;
  readonly ports: readonly number[];
  readonly healthcheckTest?: string;
  readonly interval?: string;
  readonly timeout?: string;
  readonly retries?: string;
}

const MAILPIT: DevToolConvention = {
  image: 'axllent/mailpit:v1.31.4',
  ports: [1025, 8025],
  healthcheckTest: '["CMD", "/mailpit", "readyz"]',
  interval: '15s',
  timeout: '5s',
  retries: '5',
};

const ADMINER: DevToolConvention = {
  image: 'adminer:6.1.1-standalone',
  ports: [8080],
};

/** True for a dev-only tool rather than a backing service the app depends on. */
function isDevTool(type: JamalServiceType | undefined): boolean {
  return type === 'mailpit' || type === 'adminer';
}

function convention(type: JamalServiceType): ServiceConvention {
  switch (type) {
    case 'mariadb':
      return MARIADB;
    case 'postgres':
      return POSTGRES;
    case 'valkey':
      return VALKEY;
    default:
      // Defensive: dev tools are rendered by `renderDevTool`, never here.
      throw new JamalConfigError('a dev tool is not a backing service');
  }
}

function devToolConvention(type: JamalServiceType): DevToolConvention {
  switch (type) {
    case 'mailpit':
      return MAILPIT;
    case 'adminer':
      return ADMINER;
    default:
      // Defensive: backing services are rendered by `renderBackingService`, never here.
      throw new JamalConfigError('a backing service is not a dev tool');
  }
}

/** A resolved published-port binding: the Compose service key plus the host port. */
interface PortBinding {
  readonly serviceKey: string;
  readonly hostPort: number;
}

/**
 * Resolve `config.local.ports` to Compose service keys, rejecting any entry
 * whose named service is not configured. `web`/`app` alias the application
 * service, which is only configured when `config.local.build` is true; every
 * other name must be a key of `config.services`. Errors are value-free — the
 * offending name is never echoed.
 */
function resolvePortBindings(config: JamalConfig): PortBinding[] {
  const bindings: PortBinding[] = [];
  for (const [name, hostPort] of Object.entries(config.local.ports)) {
    if (APP_PORT_NAMES.has(name)) {
      if (!config.local.build) {
        throw new JamalConfigError('config.local.ports names a service that is not configured');
      }
      bindings.push({ serviceKey: APP_SERVICE, hostPort });
      continue;
    }
    const service = config.services[name];
    if (service === undefined || isDevTool(service.type)) {
      // Dev tools carry fixed loopback ports and are never port-mapped here.
      throw new JamalConfigError('config.local.ports names a service that is not configured');
    }
    bindings.push({ serviceKey: name, hostPort });
  }
  return bindings.sort((a, b) =>
    a.serviceKey === b.serviceKey ? a.hostPort - b.hostPort : a.serviceKey < b.serviceKey ? -1 : 1,
  );
}

/** The result of a local Compose plan: one file plus the project name it carries. */
interface LocalComposePlan {
  readonly path: string;
  readonly contents: string;
  readonly projectName: string;
}

/**
 * Plan the local development Compose file for `config`. Returns the fixed
 * relative `path`, the deterministic `contents`, and the Compose project name
 * (the config's `service`). Side-effect free: no file is written and no
 * environment variable is read.
 */
export function planLocal(config: JamalConfig): LocalComposePlan {
  const projectName = config.service;
  const serviceNames = Object.keys(config.services).sort();
  const backingNames = serviceNames.filter((name) => {
    const type = config.services[name]?.type;
    return type !== undefined && !isDevTool(type);
  });
  const devToolNames = serviceNames.filter((name) => isDevTool(config.services[name]?.type));
  const bindings = resolvePortBindings(config);

  const lines: string[] = [
    '# Jamal local development Docker Compose project.',
    '#',
    '# Environment values are interpolated by Docker Compose from the host',
    '# environment (${KEY}); no secret values are ever written to this file.',
    '',
    `name: ${projectName}`,
    '',
    'services:',
  ];

  for (const name of backingNames) {
    const service = config.services[name];
    if (service === undefined) continue;
    const ports = bindings.filter((binding) => binding.serviceKey === name).map((b) => b.hostPort);
    lines.push(...renderBackingService(name, service.type, ports));
  }

  for (const name of devToolNames) {
    const type = config.services[name]?.type;
    if (type === undefined) continue;
    lines.push(...renderDevTool(name, type));
  }

  if (config.local.build) {
    const ports = bindings
      .filter((binding) => binding.serviceKey === APP_SERVICE)
      .map((binding) => binding.hostPort);
    lines.push(...renderAppService(config, backingNames, ports));
  }

  lines.push('', 'networks:', `  ${NETWORK}:`, '    driver: bridge', '', 'volumes:');

  const volumeNames = new Set<string>();
  for (const name of backingNames) {
    const service = config.services[name];
    if (service !== undefined) {
      volumeNames.add(convention(service.type).volume);
    }
  }
  for (const [name, spec] of Object.entries(config.volumes)) {
    if (!spec.host) {
      volumeNames.add(name);
    }
  }
  for (const name of [...volumeNames].sort()) {
    lines.push(`  ${name}:`);
  }
  lines.push('');

  return { path: LOCAL_COMPOSE_PATH, contents: lines.join('\n'), projectName };
}

/** Emit one backing service with the shared image/healthcheck/volume conventions. */
function renderBackingService(name: string, type: JamalServiceType, ports: number[]): string[] {
  const c = convention(type);
  const lines: string[] = [
    `  ${name}:`,
    `    image: ${c.image}`,
    '    volumes:',
    `      - ${c.volume}:${c.dataDir}`,
    '    healthcheck:',
    `      test: ${c.healthcheckTest}`,
    `      interval: ${c.interval}`,
    `      timeout: ${c.timeout}`,
    `      retries: ${c.retries}`,
    '    restart: unless-stopped',
    '    networks:',
    `      - ${NETWORK}`,
  ];
  if (ports.length > 0) {
    lines.push('    ports:');
    for (const port of ports) {
      lines.push(`      - "127.0.0.1:${port}:${c.internalPort}"`);
    }
  }
  return lines;
}

/** Emit one dev-only tool with its fixed loopback ports and optional healthcheck. */
function renderDevTool(name: string, type: JamalServiceType): string[] {
  const c = devToolConvention(type);
  const lines: string[] = [`  ${name}:`, `    image: ${c.image}`];
  if (c.healthcheckTest !== undefined) {
    lines.push(
      '    healthcheck:',
      `      test: ${c.healthcheckTest}`,
      `      interval: ${c.interval ?? '10s'}`,
      `      timeout: ${c.timeout ?? '5s'}`,
      `      retries: ${c.retries ?? '5'}`,
    );
  }
  lines.push('    restart: unless-stopped', '    ports:');
  for (const port of c.ports) {
    lines.push(`      - "127.0.0.1:${port}:${port}"`);
  }
  lines.push('    networks:', `      - ${NETWORK}`);
  return lines;
}

/** Emit the application service (only when `config.local.build` is true). */
function renderAppService(config: JamalConfig, serviceNames: string[], ports: number[]): string[] {
  const lines: string[] = [`  ${APP_SERVICE}:`, '    build: .'];
  if (config.command !== undefined) {
    lines.push(`    command: ${config.command}`);
  }
  if (serviceNames.length > 0) {
    lines.push('    depends_on:');
    for (const name of serviceNames) {
      lines.push(`      ${name}:`, '        condition: service_healthy');
    }
  }
  const envKeys = Object.keys(config.env).sort();
  if (envKeys.length > 0) {
    lines.push('    environment:');
    for (const key of envKeys) {
      const entry = config.env[key]!;
      const alias = entry.alias;
      lines.push(`      ${alias !== undefined ? alias : key}: \${${key}}`);
    }
  }
  const volumeNames = Object.keys(config.volumes).sort();
  if (volumeNames.length > 0) {
    lines.push('    volumes:');
    for (const name of volumeNames) {
      const spec = config.volumes[name]!;
      if (spec.host) {
        const optSuffix = spec.options !== undefined ? `:${spec.options}` : '';
        lines.push(`      - ${spec.source}:${spec.containerPath}${optSuffix}`);
      } else {
        lines.push(`      - ${name}:${spec.containerPath}`);
      }
    }
  }
  lines.push('    networks:', `      - ${NETWORK}`);
  if (ports.length > 0) {
    lines.push('    ports:');
    for (const port of ports) {
      // The app has no configured container port, so the host port is reused.
      lines.push(`      - "127.0.0.1:${port}:${port}"`);
    }
  }
  return lines;
}
