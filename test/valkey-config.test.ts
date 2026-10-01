import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  ValkeyConfigError,
  VALKEY_DEFAULT_IMAGE,
  VALKEY_SECRET_PLACEHOLDER,
  buildStartupScript,
  buildValkeyConf,
  generateDevValkeyConfig,
} from '../src/deploy/valkey-config.js';
import {
  KAMAL_SCHEDULE_CMD,
  KAMAL_WORKER_CMD,
  generateKamalValkeyConfig,
  type KamalValkeyOptions,
} from '../src/deploy/kamal-config.js';

/** Full-required Kamal options on a single host, for reuse. */
function kamalOptions(overrides: Partial<KamalValkeyOptions> = {}): KamalValkeyOptions {
  return {
    service: 'myapp',
    image: 'ghcr.io/acme/myapp:git-sha',
    registry: { server: 'ghcr.io', username: 'acme' },
    hosts: { web: ['1.2.3.4'], worker: ['1.2.3.4'] },
    valkeyHost: '1.2.3.4',
    ...overrides,
  };
}

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
      () => generateDevValkeyConfig({ image: 'valkey/valkey:8.0-alpine\nports: 6379' }),
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
    const { compose } = generateDevValkeyConfig({ image: 'valkey/valkey@sha256:deadbeef' });
    assert.ok(compose.includes('image: valkey/valkey@sha256:deadbeef'));
  });
});

describe('generateKamalValkeyConfig', () => {
  it('emits app/worker roles, a registry secret reference, and a private Valkey accessory', () => {
    const { deploy } = generateKamalValkeyConfig(kamalOptions());

    // Root service + image + registry (password referenced, not baked).
    assert.ok(deploy.includes('service: myapp'));
    assert.ok(deploy.includes('image: ghcr.io/acme/myapp:git-sha'));
    assert.ok(deploy.includes('registry:'));
    assert.ok(deploy.includes('  server: ghcr.io'));
    assert.ok(deploy.includes('  username: acme'));
    assert.ok(deploy.includes('    - KAMAL_REGISTRY_PASSWORD'));

    // Roles.
    assert.ok(deploy.includes('servers:'));
    assert.ok(deploy.includes('  web:'));
    assert.ok(deploy.includes('    - 1.2.3.4'));
    assert.ok(deploy.includes('  worker:'));
    assert.ok(deploy.includes('    cmd: "node dist/src/cli.js work --config jsails.runtime.js"'));

    // App env: VALKEY_URL is a secret (Kamal does no YAML substitution).
    assert.ok(deploy.includes('env:'));
    assert.ok(deploy.includes('  secret:'));
    assert.ok(deploy.includes('    - VALKEY_URL'));

    // Valkey accessory: private network, durable /data directory, no port.
    assert.ok(deploy.includes('accessories:'));
    assert.ok(deploy.includes('  valkey:'));
    assert.ok(deploy.includes('    service: valkey'));
    assert.ok(deploy.includes('    image: valkey/valkey:8.0-alpine'));
    assert.ok(deploy.includes('    network: kamal'));
    // The host directory is owned by the image's runtime uid/gid. The pinned
    // alpine image runs user valkey as uid 999, gid 1000 (the Debian variant is
    // 999:999), so a fresh host directory must be chowned 999:1000.
    assert.ok(deploy.includes('    directories:'));
    assert.ok(deploy.includes('      - local: valkey-data'));
    assert.ok(deploy.includes('        remote: /data'));
    assert.ok(deploy.includes('        owner: "999:1000"'));
    assert.ok(/^\s*port\s*:/m.test(deploy) === false);
  });

  it('mounts /data with the pinned image owner, distinct from the dev named volume', () => {
    const { deploy } = generateKamalValkeyConfig(kamalOptions());

    // Remote path must match the runtime config's `dir /data`.
    assert.ok(deploy.includes('        remote: /data'));
    assert.ok(deploy.includes('        owner: "999:1000"'));
    // No un-owned string-form directory line remains.
    assert.ok(!deploy.includes('      - valkey-data:/data'));

    // Dev keeps its named volume, which inherits ownership from the image.
    const { compose } = generateDevValkeyConfig();
    assert.ok(compose.includes('- valkey-data:/data'));
    assert.ok(!compose.includes('owner:'));
  });

  it('wires the accessory to the startup script with a secret, uploaded files, and non-root user', () => {
    const { deploy } = generateKamalValkeyConfig(kamalOptions());

    assert.ok(deploy.includes('    options:'));
    assert.ok(deploy.includes('      user: valkey'));
    assert.ok(deploy.includes('      secret:'));
    assert.ok(deploy.includes('        - VALKEY_PASSWORD'));
    assert.ok(deploy.includes('      - config/valkey/valkey.conf:/etc/valkey/valkey.conf:ro'));
    assert.ok(
      deploy.includes('      - config/valkey/start-valkey.sh:/etc/valkey/start-valkey.sh:ro'),
    );
    assert.ok(deploy.includes('    cmd: /bin/sh /etc/valkey/start-valkey.sh'));
    // No password is baked into the accessory command or args.
    assert.ok(!deploy.includes('--requirepass'));
    assert.ok(!deploy.includes(VALKEY_SECRET_PLACEHOLDER));
  });

  it('emits a startup script that is syntax-valid and never contains the secret', () => {
    const { startupScript } = generateKamalValkeyConfig(kamalOptions());

    assert.ok(shSyntaxOk(startupScript), 'startup script must pass sh -n');
    assert.ok(startupScript.includes('exec valkey-server'));
    assert.ok(!startupScript.includes(VALKEY_SECRET_PLACEHOLDER));
  });

  it('documents VALKEY_PASSWORD and VALKEY_URL as secrets, not literals', () => {
    const { secretsExample } = generateKamalValkeyConfig(kamalOptions());

    assert.ok(secretsExample.includes('KAMAL_REGISTRY_PASSWORD='));
    assert.ok(secretsExample.includes(`VALKEY_PASSWORD=${VALKEY_SECRET_PLACEHOLDER}`));
    assert.ok(
      secretsExample.includes(`VALKEY_URL=redis://:${VALKEY_SECRET_PLACEHOLDER}@valkey:6379/0`),
    );
  });

  it('freezes the worker and scheduler command strings for the integration writer', () => {
    assert.equal(KAMAL_WORKER_CMD, 'node dist/src/cli.js work --config jsails.runtime.js');
    assert.equal(KAMAL_SCHEDULE_CMD, 'node dist/src/cli.js schedule --config jsails.runtime.js');

    const { deploy } = generateKamalValkeyConfig(kamalOptions());
    assert.ok(deploy.includes('node dist/src/cli.js work --config jsails.runtime.js'));
    // The scheduler is documented as one-shot, not emitted as an endless role.
    assert.ok(deploy.includes(KAMAL_SCHEDULE_CMD));
  });

  it('rejects multi-host topologies without a shared Valkey endpoint', () => {
    assert.throws(
      () =>
        generateKamalValkeyConfig(
          kamalOptions({ hosts: { web: ['9.9.9.9'], worker: ['1.2.3.4'] } }),
        ),
      /multi-host configuration is not supported/,
    );
    assert.throws(
      () => generateKamalValkeyConfig(kamalOptions({ valkeyHost: '9.9.9.9' })),
      /multi-host configuration is not supported/,
    );
  });

  it('rejects missing required identity options rather than choosing defaults', () => {
    assert.throws(() => generateKamalValkeyConfig({} as KamalValkeyOptions), ValkeyConfigError);
    assert.throws(
      () =>
        generateKamalValkeyConfig({
          service: 'myapp',
          image: 'x/y:1',
          hosts: { web: ['1.2.3.4'], worker: ['1.2.3.4'] },
          valkeyHost: '1.2.3.4',
        } as KamalValkeyOptions),
      /registry/,
    );
    assert.throws(
      () => generateKamalValkeyConfig(kamalOptions({ hosts: { web: [], worker: ['1.2.3.4'] } })),
      /options\.hosts\.web/,
    );
  });

  it('rejects injection attempts in hosts, commands, and registry values', () => {
    assert.throws(
      () => generateKamalValkeyConfig(kamalOptions({ valkeyHost: '1.2.3.4\nports: 6379:6379' })),
      ValkeyConfigError,
    );
    assert.throws(
      () => generateKamalValkeyConfig(kamalOptions({ workerCmd: 'node x\nwork' })),
      ValkeyConfigError,
    );
    assert.throws(
      () => generateKamalValkeyConfig(kamalOptions({ workerCmd: 'node x --flag "$EVIL"' })),
      ValkeyConfigError,
    );
    assert.throws(
      () => generateKamalValkeyConfig(kamalOptions({ registry: { server: 'ghcr.io\nfoo' } })),
      ValkeyConfigError,
    );
  });
});

describe('shared valkey files', () => {
  it('is identical across dev and production generators', () => {
    const dev = generateDevValkeyConfig();
    const prod = generateKamalValkeyConfig(kamalOptions());

    assert.equal(dev.valkeyConfig, buildValkeyConf());
    assert.equal(prod.valkeyConfig, buildValkeyConf());
    assert.equal(dev.valkeyConfig, prod.valkeyConfig);

    assert.equal(dev.startupScript, buildStartupScript());
    assert.equal(prod.startupScript, buildStartupScript());
    assert.equal(dev.startupScript, prod.startupScript);
  });

  it('uses a pinned default image that is not latest', () => {
    assert.equal(VALKEY_DEFAULT_IMAGE, 'valkey/valkey:8.0-alpine');
    assert.ok(!VALKEY_DEFAULT_IMAGE.includes('latest'));
  });
});
