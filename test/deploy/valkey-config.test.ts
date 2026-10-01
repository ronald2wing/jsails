import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  ValkeyConfigError,
  VALKEY_DEFAULT_IMAGE,
  VALKEY_SECRET_PLACEHOLDER,
  generateValkeyStartupScript,
  generateValkeyConf,
  generateDevValkeyConfig,
} from '../../src/deploy/valkey-config.js';

/** Whether the startup script passes POSIX `sh -n` (static syntax only). */
function shSyntaxOk(script: string): boolean {
  const result = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
  return result.status === 0;
}

describe('generateDevValkeyConfig', () => {
  it('emits a Valkey service with a pinned image and no published port', () => {
    const { compose } = generateDevValkeyConfig();

    assert.ok(compose.includes('services:'));
    assert.ok(compose.includes('  valkey:'));
    assert.ok(compose.includes('    image: valkey/valkey:8.0-alpine'));
    assert.ok(compose.includes('- valkey-data:/data'));
    assert.ok(compose.includes('healthcheck:'));
    assert.ok(compose.includes('valkey-cli'));
    assert.ok(compose.includes('networks:'));
    assert.ok(compose.includes('  jsails:'));
    assert.ok(compose.includes('volumes:'));
    assert.ok(compose.includes('  valkey-data:'));

    // Private network only: no published port, no 6379 mapping at all.
    assert.ok(!compose.includes('ports:'));
    assert.ok(!compose.includes('6379'));

    // Runs as the unprivileged valkey user, via the generated startup script.
    assert.ok(compose.includes('user: valkey'));
    assert.ok(compose.includes('command: ["sh", "/etc/valkey/start-valkey.sh"]'));
  });

  it('mounts valkey.conf and start-valkey.sh, and references the password from env', () => {
    const { compose } = generateDevValkeyConfig();

    assert.ok(compose.includes('- ./valkey.conf:/etc/valkey/valkey.conf:ro'));
    assert.ok(compose.includes('- ./start-valkey.sh:/etc/valkey/start-valkey.sh:ro'));

    // The secret is referenced through Compose `${VAR:?msg}`, never a literal.
    assert.ok(compose.includes('VALKEY_PASSWORD: ${VALKEY_PASSWORD:?'));
    // Regression: the pinned valkey 8.0 image ships a valkey-cli that only
    // reads REDISCLI_AUTH (the redis-cli name); VALKEYCLI_AUTH landed in 9.
    assert.ok(compose.includes('REDISCLI_AUTH: ${VALKEY_PASSWORD:?'));
    assert.ok(!compose.includes('VALKEYCLI_AUTH'));
    assert.ok(!compose.includes(VALKEY_SECRET_PLACEHOLDER));
    assert.ok(!compose.includes('requirepass'));
  });

  it('probes the healthcheck with valkey-cli and no -a password flag', () => {
    const { compose } = generateDevValkeyConfig();

    assert.ok(compose.includes('test: ["CMD", "valkey-cli", "ping"]'));
    assert.ok(!compose.includes(' -a '));
    assert.ok(!compose.includes('--requirepass'));
  });

  it('emits AOF persistence and noeviction in valkey.conf with no active requirepass', () => {
    const { valkeyConfig } = generateDevValkeyConfig();

    assert.ok(valkeyConfig.includes('appendonly yes'));
    assert.ok(valkeyConfig.includes('appendfsync everysec'));
    assert.ok(valkeyConfig.includes('maxmemory-policy noeviction'));
    assert.ok(valkeyConfig.includes('dir /data'));
    // requirepass is never active in the shipped file.
    assert.ok(!/^requirepass/m.test(valkeyConfig));
  });

  it('emits a startup script that validates the password and injects requirepass', () => {
    const { startupScript } = generateDevValkeyConfig();

    assert.ok(shSyntaxOk(startupScript), 'startup script must pass sh -n');
    assert.ok(startupScript.includes('set -eu'));
    assert.ok(startupScript.includes('password=${VALKEY_PASSWORD-}'));
    assert.ok(startupScript.includes('[!A-Za-z0-9._~-]'));
    assert.ok(startupScript.includes('-lt 32'));
    assert.ok(startupScript.includes('umask 077'));
    assert.ok(startupScript.includes('mktemp'));
    assert.ok(startupScript.includes('exec valkey-server'));
    // The secret is appended via printf %s, never interpolated into the format.
    assert.ok(startupScript.includes("printf 'requirepass %s"));
  });

  it('emits a VALKEY_URL env example with the password and a numeric database index', () => {
    const { envExample } = generateDevValkeyConfig();

    assert.ok(
      envExample.includes(`VALKEY_URL=redis://:${VALKEY_SECRET_PLACEHOLDER}@valkey:6379/0`),
    );
    // The required password placeholder is documented, not left empty.
    assert.ok(envExample.includes(`VALKEY_PASSWORD=${VALKEY_SECRET_PLACEHOLDER}`));
    // The stock image does not read VALKEY_PASSWORD automatically; the script does.
    assert.ok(envExample.includes('stock valkey image does NOT read'));
  });

  it('honors custom database, service name, and image pin', () => {
    const { compose, envExample } = generateDevValkeyConfig({
      database: 3,
      serviceName: 'cache',
      image: 'valkey/valkey:8.0.11-alpine',
    });

    assert.ok(envExample.includes(`VALKEY_URL=redis://:${VALKEY_SECRET_PLACEHOLDER}@cache:6379/3`));
    assert.ok(compose.includes('  cache:'));
    assert.ok(compose.includes('    image: valkey/valkey:8.0.11-alpine'));
  });

  it('rejects floating images, out-of-range databases, and invalid names', () => {
    assert.throws(
      () => generateDevValkeyConfig({ image: 'valkey/valkey:latest' }),
      ValkeyConfigError,
    );
    assert.throws(() => generateDevValkeyConfig({ image: 'valkey/valkey' }), ValkeyConfigError);
    assert.throws(
      () =>
        generateDevValkeyConfig({
          image: 'valkey/valkey:8.0-alpine\nports: 6379',
        }),
      ValkeyConfigError,
    );
    assert.throws(
      () => generateDevValkeyConfig({ image: 'valkey/valkey:$TAG' }),
      ValkeyConfigError,
    );
    assert.throws(() => generateDevValkeyConfig({ database: 16 }), ValkeyConfigError);
    assert.throws(() => generateDevValkeyConfig({ database: -1 }), ValkeyConfigError);
    assert.throws(() => generateDevValkeyConfig({ database: 1.5 }), ValkeyConfigError);
    assert.throws(() => generateDevValkeyConfig({ serviceName: 'bad name' }), ValkeyConfigError);
    assert.throws(() => generateDevValkeyConfig({ networkName: 'a b' }), ValkeyConfigError);
  });

  it('accepts a digest-pinned image', () => {
    const { compose } = generateDevValkeyConfig({
      image: 'valkey/valkey@sha256:deadbeef',
    });
    assert.ok(compose.includes('image: valkey/valkey@sha256:deadbeef'));
  });
});

describe('shared valkey files', () => {
  it('the dev generator emits the shared config and startup script builders', () => {
    const dev = generateDevValkeyConfig();

    assert.equal(dev.valkeyConfig, generateValkeyConf());
    assert.equal(dev.startupScript, generateValkeyStartupScript());
  });

  it('uses a pinned default image that is not latest', () => {
    assert.equal(VALKEY_DEFAULT_IMAGE, 'valkey/valkey:8.0-alpine');
    assert.ok(!VALKEY_DEFAULT_IMAGE.includes('latest'));
  });
});
