/**
 * Bounded database accessory generators (MariaDB / PostgreSQL).
 *
 * These functions produce configuration FRAGMENTS as strings — they never run
 * Docker, SSH, or `kamal`, never pull images, and never open a database
 * connection. Two generators are provided:
 *
 * - {@link generateDevDatabaseConfig}: a `docker-compose.database.yml` addon
 *   (one database service on a private network, no published port) plus a
 *   `.env.database.example`.
 * - {@link generateKamalDatabaseConfig}: a Kamal `accessories:` stanza plus the
 *   app-side `env:` references and a `.kamal/secrets` example. These are
 *   ADD-ONS to merge into the main `config/deploy.yml`; they are not a
 *   standalone deployment and do not declare web/worker roles.
 *
 * The default driver is MariaDB (`mariadb:11.4`); PostgreSQL
 * (`postgres:16-alpine`) is available via the explicit `driver: 'postgres'`
 * option. Credentials are never baked into the emitted YAML: the Compose
 * service references host environment variables (`${DATABASE_NAME}` etc.), and
 * the Kamal accessory references `.kamal/secrets` entries via Kamal's aliased
 * `secret` syntax. The app reads the same `DATABASE_*` variables individually
 * into its TypeORM options; a connection URL is deliberately never emitted, so
 * an arbitrary password is never string-interpolated into one.
 */

/** SQL database drivers this generator supports. */
export type DatabaseDriver = 'mariadb' | 'postgres';

/** Default driver: MariaDB. */
export const DATABASE_DEFAULT_DRIVER: DatabaseDriver = 'mariadb';

/** App-facing env var names (individual TypeORM options, never a URL). */
export const DATABASE_TYPE_ENV = 'DATABASE_TYPE';
export const DATABASE_HOST_ENV = 'DATABASE_HOST';
export const DATABASE_PORT_ENV = 'DATABASE_PORT';
export const DATABASE_NAME_ENV = 'DATABASE_NAME';
export const DATABASE_USER_ENV = 'DATABASE_USER';
export const DATABASE_PASSWORD_ENV = 'DATABASE_PASSWORD';
/** Admin-only root password env (MariaDB only; the app never uses it). */
export const DATABASE_ROOT_PASSWORD_ENV = 'DATABASE_ROOT_PASSWORD';

/** Default pinned MariaDB image. */
export const MARIADB_DEFAULT_IMAGE = 'mariadb:11.4';
/** Default Compose service name / hostname for MariaDB. */
export const MARIADB_DEFAULT_SERVICE = 'mariadb';
/** Default named volume backing MariaDB's data directory. */
export const MARIADB_DEFAULT_VOLUME = 'mariadb-data';
/** MariaDB's standard listening port. */
export const MARIADB_DEFAULT_PORT = 3306;
/** In-container data directory for the MariaDB image. */
export const MARIADB_DATA_DIR = '/var/lib/mysql';

/** Default pinned PostgreSQL image. */
export const POSTGRES_DEFAULT_IMAGE = 'postgres:16-alpine';
/** Default Compose service name / hostname for PostgreSQL. */
export const POSTGRES_DEFAULT_SERVICE = 'postgres';
/** Default named volume backing PostgreSQL's data directory. */
export const POSTGRES_DEFAULT_VOLUME = 'postgres-data';
/** PostgreSQL's standard listening port. */
export const POSTGRES_DEFAULT_PORT = 5432;
/** In-container data directory for the PostgreSQL image. */
export const POSTGRES_DATA_DIR = '/var/lib/postgresql/data';
/**
 * Subdirectory PGDATA points at. The official image declares a VOLUME on
 * `${POSTGRES_DATA_DIR}`, so mounting the named volume there and pointing
 * PGDATA at a child directory keeps the named volume from being shadowed.
 */
export const POSTGRES_PGDATA = '/var/lib/postgresql/data/pgdata';

/** Default private Compose network for the development addon. */
export const DATABASE_DEFAULT_NETWORK = 'jsails';

/** Default Kamal network the accessory attaches to. */
export const KAMAL_DEFAULT_NETWORK = 'kamal';

/** Filename for the generated development Compose addon. */
export const DATABASE_DEV_COMPOSE_FILENAME = 'docker-compose.database.yml';
/** Filename for the generated development env example. */
export const DATABASE_DEV_ENV_EXAMPLE_FILENAME = '.env.database.example';
/** Kamal secrets file the generated example documents. */
export const KAMAL_SECRETS_FILENAME = '.kamal/secrets';

/** Error raised for any invalid database config option. */
export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

/** Options for {@link generateDevDatabaseConfig}. */
export interface DevDatabaseOptions {
  /** Database driver. Defaults to {@link DATABASE_DEFAULT_DRIVER}. */
  driver?: DatabaseDriver;
  /** Pinned image reference. Defaults to the driver's default image. */
  image?: string;
  /** Compose service name (also `DATABASE_HOST`). Defaults per driver. */
  serviceName?: string;
  /** Named data volume. Defaults per driver. */
  volumeName?: string;
  /** Private Compose network name. Defaults to {@link DATABASE_DEFAULT_NETWORK}. */
  networkName?: string;
}

/** Generated development files as strings. */
export interface DevDatabaseFiles {
  /** `docker-compose.database.yml` content: service, private network, and volume. */
  compose: string;
  /** `.env.database.example` content: the `DATABASE_*` variables the app reads. */
  envExample: string;
}

/** Options for {@link generateKamalDatabaseConfig}. */
export interface KamalDatabaseOptions {
  /** Database driver. Defaults to {@link DATABASE_DEFAULT_DRIVER}. */
  driver?: DatabaseDriver;
  /** App service name (Kamal root `service:`). Required — no default. */
  service: string;
  /** Single host the accessory runs on. Required — no default. */
  host: string;
  /** Production database name. Required — no default. */
  databaseName: string;
  /** Production database user. Required — no default. */
  username: string;
  /** Pinned image reference. Defaults to the driver's default image. */
  image?: string;
  /** Accessory key, container/service name, and `DATABASE_HOST`. Defaults per driver. */
  serviceName?: string;
  /** Kamal network name. Defaults to {@link KAMAL_DEFAULT_NETWORK}. */
  network?: string;
  /** Host directory mounted at the data directory. Defaults per driver. */
  directory?: string;
}

/**
 * Generated production fragments as strings. These are add-ons to merge into
 * the main `config/deploy.yml` (and `.kamal/secrets`), not a standalone
 * deployment.
 */
export interface KamalDatabaseFiles {
  /** `accessories:` stanza for the database accessory. */
  accessory: string;
  /** App-side `env:` references for the web/worker roles. */
  envExample: string;
  /** `.kamal/secrets` example: the `DATABASE_PASSWORD` (and root) entries. */
  secretsExample: string;
}

/** Control characters (including newlines) that can break YAML/commands. */
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

/** Conservative container/service/network/volume name: letters/digits, then `._-`. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Unquoted SQL identifier safe in both MariaDB and PostgreSQL. */
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Docker image reference: registry/namespace/name, tag, or digest. */
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:\-@]*$/;

/** Hostname or IP (IPv4/IPv6), optionally with a port. No shell characters. */
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:\-[\]]*$/;

function assertDriver(value: unknown): DatabaseDriver {
  if (value !== 'mariadb' && value !== 'postgres') {
    throw new DatabaseConfigError(
      `options.driver must be "mariadb" or "postgres"; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Validate a conservative container/service/network/volume identifier. */
function assertIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new DatabaseConfigError(
      `${label} must match [A-Za-z0-9][A-Za-z0-9._-]* (no whitespace or shell characters)`,
    );
  }
  return value;
}

/** Validate a database name or username as an unquoted SQL identifier. */
function assertSqlIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || !SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new DatabaseConfigError(
      `${label} must match [A-Za-z_][A-Za-z0-9_]* (a valid unquoted SQL identifier)`,
    );
  }
  return value;
}

/** Validate a Docker image reference (no shell/control characters). */
function assertImageRef(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DatabaseConfigError(`${label} must be a non-empty image reference`);
  }
  if (CONTROL_PATTERN.test(value) || !IMAGE_PATTERN.test(value)) {
    throw new DatabaseConfigError(
      `${label} contains characters that are not valid in a Docker image reference`,
    );
  }
  return value;
}

/** Extract the tag segment of an image reference, or `undefined` when untagged. */
function imageTag(ref: string): string | undefined {
  const lastSlash = ref.lastIndexOf('/');
  const last = ref.slice(lastSlash + 1);
  const at = last.indexOf('@');
  const nameAndTag = at === -1 ? last : last.slice(0, at);
  const colon = nameAndTag.lastIndexOf(':');
  return colon === -1 ? undefined : nameAndTag.slice(colon + 1);
}

/**
 * Validate a pinned image reference. Rejects floating tags (`latest`, or a bare
 * name that resolves to it) so the database image is always a specific version.
 */
function assertPinnedImage(value: string, label: string): string {
  assertImageRef(value, label);
  const tag = imageTag(value);
  const hasDigest = value.slice(value.lastIndexOf('/') + 1).includes('@');
  if (tag === undefined && !hasDigest) {
    throw new DatabaseConfigError(
      `${label} must be pinned to a tag or digest (a floating "latest" image is not allowed)`,
    );
  }
  if (tag !== undefined && tag.toLowerCase() === 'latest') {
    throw new DatabaseConfigError(`${label} must not use the "latest" tag; pin a specific version`);
  }
  return value;
}

/** Validate a host string (no newlines, whitespace, or shell metacharacters). */
function assertHost(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DatabaseConfigError(`${label} must be a non-empty host`);
  }
  if (CONTROL_PATTERN.test(value) || !HOST_PATTERN.test(value)) {
    throw new DatabaseConfigError(
      `${label} is not a valid host: expected a hostname or IP (optionally with a port)`,
    );
  }
  return value;
}

interface DriverDefaults {
  image: string;
  service: string;
  volume: string;
  port: number;
}

function driverDefaults(driver: DatabaseDriver): DriverDefaults {
  if (driver === 'mariadb') {
    return {
      image: MARIADB_DEFAULT_IMAGE,
      service: MARIADB_DEFAULT_SERVICE,
      volume: MARIADB_DEFAULT_VOLUME,
      port: MARIADB_DEFAULT_PORT,
    };
  }
  return {
    image: POSTGRES_DEFAULT_IMAGE,
    service: POSTGRES_DEFAULT_SERVICE,
    volume: POSTGRES_DEFAULT_VOLUME,
    port: POSTGRES_DEFAULT_PORT,
  };
}

interface DevComposeInput {
  driver: DatabaseDriver;
  image: string;
  serviceName: string;
  volumeName: string;
  networkName: string;
}

function buildDevCompose(input: DevComposeInput): string {
  const lines: string[] = [];
  if (input.driver === 'mariadb') {
    lines.push(
      '# JSails development database (Docker Compose add-on for MariaDB).',
      '#',
      '# Private network, no published port: the database is reachable only by',
      '# services on the same network. Credentials are injected from the host',
      '# environment (see .env.database.example) — none are baked in here.',
      '#',
      '# The app connects as MARIADB_USER, never root. MARIADB_ROOT_PASSWORD is',
      '# required by the image for administration but is not used by the app.',
      '',
    );
  } else {
    lines.push(
      '# JSails development database (Docker Compose add-on for PostgreSQL).',
      '#',
      '# Private network, no published port: the database is reachable only by',
      '# services on the same network. Credentials are injected from the host',
      '# environment (see .env.database.example) — none are baked in here.',
      '#',
      '# The postgres image runs as the "postgres" user (UID 999) and has no',
      '# separate root account: POSTGRES_USER owns POSTGRES_DB and is the account',
      '# the app connects as. PGDATA points at a subdirectory of the mount so the',
      "# image's own VOLUME declaration does not shadow the named volume.",
      '',
    );
  }

  lines.push(
    'services:',
    `  ${input.serviceName}:`,
    `    image: ${input.image}`,
    '    environment:',
  );

  if (input.driver === 'mariadb') {
    lines.push(
      `      MARIADB_DATABASE: \${${DATABASE_NAME_ENV}}`,
      `      MARIADB_USER: \${${DATABASE_USER_ENV}}`,
      `      MARIADB_PASSWORD: \${${DATABASE_PASSWORD_ENV}}`,
      `      MARIADB_ROOT_PASSWORD: \${${DATABASE_ROOT_PASSWORD_ENV}}`,
    );
  } else {
    lines.push(
      `      POSTGRES_DB: \${${DATABASE_NAME_ENV}}`,
      `      POSTGRES_USER: \${${DATABASE_USER_ENV}}`,
      `      POSTGRES_PASSWORD: \${${DATABASE_PASSWORD_ENV}}`,
      `      PGDATA: ${POSTGRES_PGDATA}`,
    );
  }

  const dataDir = input.driver === 'mariadb' ? MARIADB_DATA_DIR : POSTGRES_DATA_DIR;

  lines.push('    volumes:', `      - ${input.volumeName}:${dataDir}`, '    healthcheck:');

  if (input.driver === 'mariadb') {
    lines.push('      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]');
  } else {
    lines.push(
      `      test: ["CMD-SHELL", "pg_isready -U \${${DATABASE_USER_ENV}} -d \${${DATABASE_NAME_ENV}}"]`,
    );
  }

  lines.push(
    '      interval: 10s',
    '      timeout: 5s',
    '      retries: 10',
    '    restart: unless-stopped',
    '    networks:',
    `      - ${input.networkName}`,
    '',
    'networks:',
    `  ${input.networkName}:`,
    '    driver: bridge',
    '',
    'volumes:',
    `  ${input.volumeName}:`,
    '',
  );

  return lines.join('\n');
}

interface DevEnvInput {
  driver: DatabaseDriver;
  serviceName: string;
  port: number;
}

function buildDevEnvExample(input: DevEnvInput): string {
  const lines: string[] = [
    '# JSails development database (copy to .env.database).',
    '#',
    '# The database is a private Compose service with no published port. The app',
    '# reads these variables individually into its TypeORM options — the password',
    '# is never interpolated into a connection URL.',
    '',
    `${DATABASE_TYPE_ENV}=${input.driver}`,
    `${DATABASE_HOST_ENV}=${input.serviceName}`,
    `${DATABASE_PORT_ENV}=${input.port}`,
    `${DATABASE_NAME_ENV}=jsails_development`,
    `${DATABASE_USER_ENV}=app`,
    '# Required: set a strong password. No default is provided.',
    `${DATABASE_PASSWORD_ENV}=`,
  ];
  if (input.driver === 'mariadb') {
    lines.push(
      '# Admin-only: the MariaDB image requires a root password; the app never uses it.',
      `${DATABASE_ROOT_PASSWORD_ENV}=`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Generate the development database addon: a `docker-compose.database.yml`
 * fragment and a `.env.database.example`. Returns strings only; nothing is run
 * or written to disk.
 */
export function generateDevDatabaseConfig(options: DevDatabaseOptions = {}): DevDatabaseFiles {
  const driver = assertDriver(options.driver ?? DATABASE_DEFAULT_DRIVER);
  const defaults = driverDefaults(driver);

  const image = assertPinnedImage(options.image ?? defaults.image, 'options.image');
  const serviceName = assertIdentifier(
    options.serviceName ?? defaults.service,
    'options.serviceName',
  );
  const volumeName = assertIdentifier(options.volumeName ?? defaults.volume, 'options.volumeName');
  const networkName = assertIdentifier(
    options.networkName ?? DATABASE_DEFAULT_NETWORK,
    'options.networkName',
  );

  return {
    compose: buildDevCompose({ driver, image, serviceName, volumeName, networkName }),
    envExample: buildDevEnvExample({ driver, serviceName, port: defaults.port }),
  };
}

interface KamalAccessoryInput {
  driver: DatabaseDriver;
  service: string;
  accessoryName: string;
  image: string;
  host: string;
  network: string;
  directory: string;
  databaseName: string;
  username: string;
}

function buildKamalAccessory(input: KamalAccessoryInput): string {
  const lines: string[] = [];
  if (input.driver === 'mariadb') {
    lines.push(
      '# JSails database accessory (Kamal add-on).',
      '#',
      `# Merge this \`accessories:\` block into the existing config/deploy.yml for`,
      `# the "${input.service}" service. It declares only the database accessory — it`,
      '# does not redefine the service, image, registry, or web/worker roles.',
      '#',
      '# The app connects as MARIADB_USER, never root. MARIADB_ROOT_PASSWORD is',
      '# required for administration only and is not read by the app.',
      '',
    );
  } else {
    lines.push(
      '# JSails database accessory (Kamal add-on).',
      '#',
      `# Merge this \`accessories:\` block into the existing config/deploy.yml for`,
      `# the "${input.service}" service. It declares only the database accessory — it`,
      '# does not redefine the service, image, registry, or web/worker roles.',
      '#',
      '# The postgres image runs as UID 999 and has no separate root account:',
      '# POSTGRES_USER owns POSTGRES_DB. The data directory is mounted with owner',
      "# 999:999 and PGDATA points at a subdirectory so the image's VOLUME",
      '# declaration does not shadow the mounted directory.',
      '',
    );
  }

  lines.push(
    'accessories:',
    `  ${input.accessoryName}:`,
    `    image: ${input.image}`,
    `    service: ${input.accessoryName}`,
    `    host: ${input.host}`,
    `    network: ${input.network}`,
    '    directories:',
  );

  if (input.driver === 'mariadb') {
    lines.push(`      - ${input.directory}:${MARIADB_DATA_DIR}`);
  } else {
    lines.push(
      `      - local: ${input.directory}`,
      `        remote: ${POSTGRES_DATA_DIR}`,
      '        owner: "999:999"',
    );
  }

  lines.push('    env:', '      clear:');
  if (input.driver === 'mariadb') {
    lines.push(
      `        MARIADB_DATABASE: ${input.databaseName}`,
      `        MARIADB_USER: ${input.username}`,
    );
  } else {
    lines.push(
      `        POSTGRES_DB: ${input.databaseName}`,
      `        POSTGRES_USER: ${input.username}`,
      `        PGDATA: ${POSTGRES_PGDATA}`,
    );
  }

  lines.push('      secret:');
  if (input.driver === 'mariadb') {
    lines.push(
      `        - MARIADB_PASSWORD:${DATABASE_PASSWORD_ENV}`,
      `        - MARIADB_ROOT_PASSWORD:${DATABASE_ROOT_PASSWORD_ENV}`,
    );
  } else {
    lines.push(`        - POSTGRES_PASSWORD:${DATABASE_PASSWORD_ENV}`);
  }

  lines.push('');
  return lines.join('\n');
}

interface KamalEnvInput {
  driver: DatabaseDriver;
  service: string;
  accessoryName: string;
  port: number;
  databaseName: string;
  username: string;
}

function buildKamalEnvExample(input: KamalEnvInput): string {
  return [
    '# JSails app-side database environment (Kamal).',
    '#',
    `# Merge this \`env:\` block into the main config/deploy.yml \`env:\` for the`,
    `# "${input.service}" web/worker roles. DATABASE_PASSWORD is the same secret the`,
    '# accessory aliases into its own image variable (MARIADB_PASSWORD or',
    '# POSTGRES_PASSWORD), so both containers read one secret value.',
    '',
    'env:',
    '  clear:',
    `    ${DATABASE_TYPE_ENV}: ${input.driver}`,
    `    ${DATABASE_HOST_ENV}: ${input.accessoryName}`,
    `    ${DATABASE_PORT_ENV}: ${input.port}`,
    `    ${DATABASE_NAME_ENV}: ${input.databaseName}`,
    `    ${DATABASE_USER_ENV}: ${input.username}`,
    '  secret:',
    `    - ${DATABASE_PASSWORD_ENV}`,
    '',
  ].join('\n');
}

function buildKamalSecretsExample(input: { driver: DatabaseDriver }): string {
  const lines: string[] = [
    '# JSails production database secrets (Kamal). Place in .kamal/secrets; never commit.',
    '#',
    "# DATABASE_PASSWORD is read by the app and aliased to the database image's",
    '# password variable in the accessory.',
  ];
  if (input.driver === 'mariadb') {
    lines.push('# DATABASE_ROOT_PASSWORD is admin-only (aliased to MARIADB_ROOT_PASSWORD).');
  }
  lines.push(`${DATABASE_PASSWORD_ENV}=`);
  if (input.driver === 'mariadb') {
    lines.push(`${DATABASE_ROOT_PASSWORD_ENV}=`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Generate the production database add-on: a Kamal `accessories:` stanza, the
 * app-side `env:` references, and a `.kamal/secrets` example. Returns strings
 * only; nothing is run or written to disk. These fragments are merged into the
 * main `config/deploy.yml` (and secrets file) by the user or the CLI later —
 * they are not a full Kamal deployment.
 */
export function generateKamalDatabaseConfig(options: KamalDatabaseOptions): KamalDatabaseFiles {
  const driver = assertDriver(options.driver ?? DATABASE_DEFAULT_DRIVER);
  const defaults = driverDefaults(driver);

  const service = assertIdentifier(options.service, 'options.service');
  const host = assertHost(options.host, 'options.host');
  const databaseName = assertSqlIdentifier(options.databaseName, 'options.databaseName');
  const username = assertSqlIdentifier(options.username, 'options.username');
  const image = assertPinnedImage(options.image ?? defaults.image, 'options.image');
  const accessoryName = assertIdentifier(
    options.serviceName ?? defaults.service,
    'options.serviceName',
  );
  const network = assertIdentifier(options.network ?? KAMAL_DEFAULT_NETWORK, 'options.network');
  const directory = assertIdentifier(options.directory ?? defaults.volume, 'options.directory');

  const accessoryInput: KamalAccessoryInput = {
    driver,
    service,
    accessoryName,
    image,
    host,
    network,
    directory,
    databaseName,
    username,
  };

  return {
    accessory: buildKamalAccessory(accessoryInput),
    envExample: buildKamalEnvExample({
      driver,
      service,
      accessoryName,
      port: defaults.port,
      databaseName,
      username,
    }),
    secretsExample: buildKamalSecretsExample({ driver }),
  };
}
