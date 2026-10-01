import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DATABASE_DEFAULT_DRIVER,
  DATABASE_DEV_COMPOSE_FILENAME,
  DATABASE_DEV_ENV_EXAMPLE_FILENAME,
  DatabaseConfigError,
  MARIADB_DEFAULT_IMAGE,
  POSTGRES_DEFAULT_IMAGE,
  generateDevDatabaseConfig,
} from '../../src/deploy/database-config.js';

describe('generateDevDatabaseConfig', () => {
  it('defaults to MariaDB with a pinned image, private network, and durable volume', () => {
    assert.equal(DATABASE_DEFAULT_DRIVER, 'mariadb');

    const { compose } = generateDevDatabaseConfig();

    assert.ok(compose.includes('services:'));
    assert.ok(compose.includes('  mariadb:'));
    assert.ok(compose.includes('    image: mariadb:11.4'));
    assert.ok(compose.includes('- mariadb-data:/var/lib/mysql'));
    assert.ok(compose.includes('healthcheck:'));
    assert.ok(compose.includes('networks:'));
    assert.ok(compose.includes('  jsails:'));
    assert.ok(compose.includes('volumes:'));
    assert.ok(compose.includes('  mariadb-data:'));
  });

  it('emits a real MariaDB healthcheck string', () => {
    const { compose } = generateDevDatabaseConfig();

    assert.ok(compose.includes('healthcheck.sh'));
    assert.ok(compose.includes('--connect'));
    assert.ok(compose.includes('--innodb_initialized'));
    assert.ok(
      compose.includes(
        '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
      ),
    );
  });

  it('injects credentials via host env references, never plaintext', () => {
    const { compose } = generateDevDatabaseConfig();

    assert.ok(compose.includes('MARIADB_DATABASE: ${DATABASE_NAME}'));
    assert.ok(compose.includes('MARIADB_USER: ${DATABASE_USER}'));
    assert.ok(compose.includes('MARIADB_PASSWORD: ${DATABASE_PASSWORD}'));
    assert.ok(compose.includes('MARIADB_ROOT_PASSWORD: ${DATABASE_ROOT_PASSWORD}'));
    // No literal secret or default password is ever baked into the compose: the
    // value after the key must be a `${...}` host env reference, never a literal.
    assert.ok(!/MARIADB_PASSWORD: [^$]/.test(compose));
    assert.ok(!/MARIADB_ROOT_PASSWORD: [^$]/.test(compose));
  });

  it('keeps the database private: no published port', () => {
    const { compose } = generateDevDatabaseConfig();

    assert.ok(!compose.includes('ports:'));
    assert.ok(!compose.includes('3306'));
    assert.ok(!compose.includes('5432'));
  });

  it('emits a .env example with individual variables and no password default', () => {
    const { envExample } = generateDevDatabaseConfig();

    assert.ok(envExample.includes('DATABASE_TYPE=mariadb'));
    assert.ok(envExample.includes('DATABASE_HOST=mariadb'));
    assert.ok(envExample.includes('DATABASE_PORT=3306'));
    assert.ok(envExample.includes('DATABASE_NAME=jsails_development'));
    assert.ok(envExample.includes('DATABASE_USER=app'));
    // Passwords are required and empty — no default value.
    assert.ok(envExample.includes('DATABASE_PASSWORD=\n'));
    assert.ok(envExample.includes('DATABASE_ROOT_PASSWORD=\n'));
    // No connection URL is emitted (the password is never interpolated).
    assert.ok(!envExample.includes('DATABASE_URL'));
  });

  it('switches to PostgreSQL with an analogous PGDATA volume and pg_isready healthcheck', () => {
    const { compose, envExample } = generateDevDatabaseConfig({ driver: 'postgres' });

    assert.ok(compose.includes('  postgres:'));
    assert.ok(compose.includes('    image: postgres:16-alpine'));
    assert.ok(compose.includes('- postgres-data:/var/lib/postgresql/data'));
    assert.ok(compose.includes('PGDATA: /var/lib/postgresql/data/pgdata'));
    assert.ok(compose.includes('pg_isready'));
    assert.ok(compose.includes('POSTGRES_DB: ${DATABASE_NAME}'));
    assert.ok(compose.includes('POSTGRES_USER: ${DATABASE_USER}'));
    assert.ok(compose.includes('POSTGRES_PASSWORD: ${DATABASE_PASSWORD}'));

    assert.ok(envExample.includes('DATABASE_TYPE=postgres'));
    assert.ok(envExample.includes('DATABASE_HOST=postgres'));
    assert.ok(envExample.includes('DATABASE_PORT=5432'));
    // PostgreSQL has no separate root account, so no root password is emitted.
    assert.ok(!envExample.includes('DATABASE_ROOT_PASSWORD'));
  });

  it('honors custom driver image, service, and volume names', () => {
    const { compose, envExample } = generateDevDatabaseConfig({
      serviceName: 'db',
      volumeName: 'pgdata',
      image: 'postgres:16.2-alpine',
      driver: 'postgres',
    });

    assert.ok(compose.includes('  db:'));
    assert.ok(compose.includes('    image: postgres:16.2-alpine'));
    assert.ok(compose.includes('- pgdata:/var/lib/postgresql/data'));
    assert.ok(envExample.includes('DATABASE_HOST=db'));
  });

  it('rejects floating images, invalid driver, and invalid names', () => {
    assert.throws(
      () => generateDevDatabaseConfig({ image: 'mariadb:latest' }),
      DatabaseConfigError,
    );
    assert.throws(() => generateDevDatabaseConfig({ image: 'mariadb' }), DatabaseConfigError);
    assert.throws(
      () => generateDevDatabaseConfig({ image: 'mariadb:11.4\nports: 3306' }),
      DatabaseConfigError,
    );
    assert.throws(() => generateDevDatabaseConfig({ image: 'mariadb:$TAG' }), DatabaseConfigError);
    assert.throws(
      () => generateDevDatabaseConfig({ driver: 'mysql' as never }),
      DatabaseConfigError,
    );
    assert.throws(
      () => generateDevDatabaseConfig({ serviceName: 'bad name' }),
      DatabaseConfigError,
    );
    assert.throws(() => generateDevDatabaseConfig({ networkName: 'a b' }), DatabaseConfigError);
  });
});

describe('shared constants', () => {
  it('pins non-latest default images', () => {
    assert.equal(MARIADB_DEFAULT_IMAGE, 'mariadb:11.4');
    assert.equal(POSTGRES_DEFAULT_IMAGE, 'postgres:16-alpine');
    assert.ok(!MARIADB_DEFAULT_IMAGE.includes('latest'));
    assert.ok(!POSTGRES_DEFAULT_IMAGE.includes('latest'));
  });

  it('freezes the exact filenames for the integration/doc writer', () => {
    assert.equal(DATABASE_DEV_COMPOSE_FILENAME, 'docker-compose.database.yml');
    assert.equal(DATABASE_DEV_ENV_EXAMPLE_FILENAME, '.env.database.example');
  });
});
