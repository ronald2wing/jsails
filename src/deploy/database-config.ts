/**
 * Bounded development database accessory generator (MariaDB / PostgreSQL).
 *
 * This function produces configuration FRAGMENTS as strings — it never runs
 * Docker, SSH, or `kamal`, never pulls images, and never opens a database
 * connection.
 *
 * {@link generateDevDatabaseConfig} emits a `docker-compose.database.yml` addon
 * (one database service on a private network, no published port) plus a
 * `.env.database.example`.
 *
 * The default driver is MariaDB (`mariadb:11.4`); PostgreSQL
 * (`postgres:16-alpine`) is available via the explicit `driver: 'postgres'`
 * option. Credentials are never baked into the emitted YAML: the Compose
 * service references host environment variables (`${DATABASE_NAME}` etc.). The
 * app reads the same `DATABASE_*` variables individually into its TypeORM
 * options; a connection URL is deliberately never emitted, so an arbitrary
 * password is never string-interpolated into one.
 */

import { assertIdentifier, assertPinnedImage } from './validators.js';
import {
  DATABASE_HOST_ENV,
  DATABASE_NAME_ENV,
  DATABASE_PASSWORD_ENV,
  DATABASE_PORT_ENV,
  DATABASE_TYPE_ENV,
  DATABASE_USER_ENV,
} from '../environment.js';

export {
  DATABASE_HOST_ENV,
  DATABASE_NAME_ENV,
  DATABASE_PASSWORD_ENV,
  DATABASE_PORT_ENV,
  DATABASE_TYPE_ENV,
  DATABASE_USER_ENV,
};

/** SQL database drivers this generator supports. */
export type DatabaseDriver = 'mariadb' | 'postgres';

/** Default driver: MariaDB. */
export const DATABASE_DEFAULT_DRIVER: DatabaseDriver = 'mariadb';

/** Admin-only root password env (MariaDB only; the app never uses it). */
const DATABASE_ROOT_PASSWORD_ENV = 'DATABASE_ROOT_PASSWORD';

/** Default pinned MariaDB image. */
export const MARIADB_DEFAULT_IMAGE = 'mariadb:11.4';
/** Default Compose service name / hostname for MariaDB. */
const MARIADB_DEFAULT_SERVICE = 'mariadb';
/** Default named volume backing MariaDB's data directory. */
const MARIADB_DEFAULT_VOLUME = 'mariadb-data';
/** MariaDB's standard listening port. */
const MARIADB_DEFAULT_PORT = 3306;
/** In-container data directory for the MariaDB image. */
const MARIADB_DATA_DIR = '/var/lib/mysql';

/** Default pinned PostgreSQL image. */
export const POSTGRES_DEFAULT_IMAGE = 'postgres:16-alpine';
/** Default Compose service name / hostname for PostgreSQL. */
const POSTGRES_DEFAULT_SERVICE = 'postgres';
/** Default named volume backing PostgreSQL's data directory. */
const POSTGRES_DEFAULT_VOLUME = 'postgres-data';
/** PostgreSQL's standard listening port. */
const POSTGRES_DEFAULT_PORT = 5432;
/** In-container data directory for the PostgreSQL image. */
const POSTGRES_DATA_DIR = '/var/lib/postgresql/data';
/**
 * Subdirectory PGDATA points at. The official image declares a VOLUME on
 * `${POSTGRES_DATA_DIR}`, so mounting the named volume there and pointing
 * PGDATA at a child directory keeps the named volume from being shadowed.
 */
const POSTGRES_PGDATA = '/var/lib/postgresql/data/pgdata';

/** Default private Compose network for the development addon. */
const DATABASE_DEFAULT_NETWORK = 'jsails';

/** Filename for the generated development Compose addon. */
export const DATABASE_DEV_COMPOSE_FILENAME = 'docker-compose.database.yml';
/** Filename for the generated development env example. */
export const DATABASE_DEV_ENV_EXAMPLE_FILENAME = '.env.database.example';

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

function assertDriver(value: unknown): DatabaseDriver {
  if (value !== 'mariadb' && value !== 'postgres') {
    throw new DatabaseConfigError(
      `options.driver must be "mariadb" or "postgres"; got ${JSON.stringify(value)}`,
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

  const image = assertPinnedImage(
    options.image ?? defaults.image,
    'options.image',
    DatabaseConfigError,
  );
  const serviceName = assertIdentifier(
    options.serviceName ?? defaults.service,
    'options.serviceName',
    DatabaseConfigError,
  );
  const volumeName = assertIdentifier(
    options.volumeName ?? defaults.volume,
    'options.volumeName',
    DatabaseConfigError,
  );
  const networkName = assertIdentifier(
    options.networkName ?? DATABASE_DEFAULT_NETWORK,
    'options.networkName',
    DatabaseConfigError,
  );

  return {
    compose: buildDevCompose({ driver, image, serviceName, volumeName, networkName }),
    envExample: buildDevEnvExample({ driver, serviceName, port: defaults.port }),
  };
}
