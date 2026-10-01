import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCAL_COMPOSE_PATH, planLocal } from '../../src/jamal/compose.js';
import { JamalConfigError, normalizeJamalConfig, secret } from '../../src/jamal/config.js';

/**
 * Tests for the pure local Compose planner. `planLocal` never touches disk or
 * the environment, so these run entirely in-process. Every assertion targets
 * the emitted YAML string (service presence, image/healthcheck/volume
 * conventions, port bindings, env interpolation) plus the deterministic shape
 * of the plan object.
 */

/** Port lines in the emitted YAML: `      - "127.0.0.1:<host>:<internal>"`. */
function portLines(contents: string): string[] {
  return contents.split('\n').filter((line) => line.trim().startsWith('- "') && line.includes(':'));
}

describe('planLocal: services, ports, and interpolation', () => {
  it('plans mariadb + valkey services, the app service, ports, and env interpolation', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:git-sha',
      command: 'node server.js',
      env: { NODE_ENV: 'production', DB_PASSWORD: secret('DB_PASSWORD') },
      services: { db: { type: 'mariadb' }, cache: { type: 'valkey' } },
      volumes: { storage: '/app/storage' },
      local: { ports: { web: 3000, db: 3307, cache: 6380 }, build: true },
    });

    const plan = planLocal(config);

    assert.equal(plan.projectName, 'myapp');
    assert.equal(plan.path, '.jamal/compose.yml');
    const yaml = plan.contents;

    // Compose project name.
    assert.match(yaml, /^name: myapp$/m);

    // Backing services with the pinned images and healthcheck conventions.
    assert.ok(yaml.includes('  db:'));
    assert.ok(yaml.includes('    image: mariadb:11.4'));
    assert.ok(
      yaml.includes('      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]'),
    );
    assert.ok(yaml.includes('  cache:'));
    assert.ok(yaml.includes('    image: valkey/valkey:8.0-alpine'));
    assert.ok(yaml.includes('      test: ["CMD", "valkey-cli", "ping"]'));

    // Application service (build is true).
    assert.ok(yaml.includes('  app:'));
    assert.ok(yaml.includes('    build: .'));
    assert.ok(yaml.includes('    command: node server.js'));
    assert.ok(yaml.includes('      db:\n        condition: service_healthy'));
    assert.ok(yaml.includes('      cache:\n        condition: service_healthy'));

    // Env interpolation: every entry is `${KEY}`, never a literal value.
    assert.ok(yaml.includes('      NODE_ENV: ${NODE_ENV}'));
    assert.ok(yaml.includes('      DB_PASSWORD: ${DB_PASSWORD}'));

    // App volumes map config.volumes names to their container paths.
    assert.ok(yaml.includes('      - storage:/app/storage'));

    // Published ports: loopback binding with the backing service internal port.
    assert.ok(yaml.includes('      - "127.0.0.1:3307:3306"'));
    assert.ok(yaml.includes('      - "127.0.0.1:6380:6379"'));
    assert.ok(yaml.includes('      - "127.0.0.1:3000:3000"'));

    // Shared private network and named volumes (backing data + app volumes).
    assert.ok(yaml.includes('  jsails:\n    driver: bridge'));
    assert.ok(yaml.includes('  mariadb-data:'));
    assert.ok(yaml.includes('  valkey-data:'));
    assert.ok(yaml.includes('  storage:'));
  });

  it('mirrors the postgres conventions (image, healthcheck, volume)', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { db: { type: 'postgres' } },
    });

    const yaml = planLocal(config).contents;

    assert.ok(yaml.includes('    image: postgres:16-alpine'));
    assert.ok(
      yaml.includes(
        '      test: ["CMD-SHELL", "pg_isready -U ${DATABASE_USER} -d ${DATABASE_NAME}"]',
      ),
    );
    assert.ok(yaml.includes('      - postgres-data:/var/lib/postgresql/data'));
    assert.ok(yaml.includes('  postgres-data:'));
  });
});

describe('planLocal: app service gating', () => {
  it('emits no app service when local.build is false', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { db: { type: 'mariadb' } },
      local: { build: false },
    });

    const yaml = planLocal(config).contents;

    assert.ok(yaml.includes('  db:'));
    assert.ok(!yaml.includes('  app:'));
    assert.ok(!yaml.includes('    build: .'));
    assert.ok(!yaml.includes('depends_on'));
  });
});

describe('planLocal: port validation', () => {
  it('rejects a port entry naming a service that is not configured, value-free', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { db: { type: 'mariadb' } },
      local: { ports: { redis: 6379 }, build: false },
    });

    assert.throws(
      () => planLocal(config),
      (error: unknown): boolean => {
        assert.ok(error instanceof JamalConfigError);
        const message = String(error.message);
        assert.ok(!message.includes('redis'), 'the port name must not leak');
        assert.ok(!message.includes('6379'), 'the port value must not leak');
        return true;
      },
    );
  });

  it('rejects a web/app port when the app service is not built', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      local: { ports: { web: 3000 }, build: false },
    });

    assert.throws(
      () => planLocal(config),
      (error: unknown): boolean => {
        assert.ok(error instanceof JamalConfigError);
        assert.ok(!String(error.message).includes('web'));
        return true;
      },
    );
  });
});

describe('planLocal: secret safety', () => {
  it('never writes a secret value: SecretRefs interpolate as ${NAME}', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      env: { DB_PASSWORD: secret('DB_PASSWORD'), API_KEY: secret('API_KEY') },
      local: { build: true },
    });

    const yaml = planLocal(config).contents;

    assert.ok(yaml.includes('      DB_PASSWORD: ${DB_PASSWORD}'));
    assert.ok(yaml.includes('      API_KEY: ${API_KEY}'));
    assert.ok(!yaml.includes('secret('), 'the redacted secret(<name>) form must not appear');
    assert.ok(!yaml.includes('DB_PASSWORD: secret'), 'no redacted secret form may appear');
  });
});

describe('planLocal: determinism and shape', () => {
  it('is deterministic: two calls produce deep-equal plans', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      command: 'node server.js',
      env: { A: '1', B: secret('B') },
      services: { db: { type: 'postgres' }, cache: { type: 'valkey' } },
      volumes: { data: '/data' },
      local: { ports: { web: 3000, cache: 6379 }, build: true },
    });

    assert.deepEqual(planLocal(config), planLocal(config));
  });

  it('uses config.service as the project name and the fixed relative path', () => {
    const config = normalizeJamalConfig({ service: 'acme', image: 'img' });

    const plan = planLocal(config);

    assert.equal(plan.path, LOCAL_COMPOSE_PATH);
    assert.equal(plan.projectName, 'acme');
    assert.match(plan.contents, /^name: acme$/m);
  });
});

describe('planLocal: loopback-only binding', () => {
  it('publishes every port on 127.0.0.1 only', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { db: { type: 'mariadb' } },
      local: { ports: { db: 3307 }, build: true },
    });

    const yaml = planLocal(config).contents;

    const ports = portLines(yaml);
    assert.ok(ports.length > 0, 'expected at least one published port');
    for (const line of ports) {
      assert.match(line, /- "127\.0\.0\.1:\d+:\d+"/, line);
    }
    assert.ok(yaml.includes('      - "127.0.0.1:3307:3306"'));
  });
});

describe('planLocal: dev tools (mailpit, adminer)', () => {
  it('emits mailpit and adminer with fixed loopback ports and conventions', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: {
        db: { type: 'mariadb' },
        mailpit: { type: 'mailpit' },
        adminer: { type: 'adminer' },
      },
      local: { build: true },
    });

    const yaml = planLocal(config).contents;

    // mailpit: pinned image, authoritative healthcheck, fixed SMTP + UI ports.
    assert.ok(yaml.includes('  mailpit:'));
    assert.ok(yaml.includes('    image: axllent/mailpit:v1.31.4'));
    assert.ok(yaml.includes('      test: ["CMD", "/mailpit", "readyz"]'));
    assert.ok(yaml.includes('      interval: 15s'));
    assert.ok(yaml.includes('      - "127.0.0.1:1025:1025"'));
    assert.ok(yaml.includes('      - "127.0.0.1:8025:8025"'));

    // adminer: pinned image, no healthcheck (nothing to probe), fixed UI port.
    assert.ok(yaml.includes('  adminer:'));
    assert.ok(yaml.includes('    image: adminer:6.1.1-standalone'));
    assert.ok(yaml.includes('      - "127.0.0.1:8080:8080"'));

    // Neither dev tool spawns a named data volume.
    assert.ok(!yaml.includes('mailpit-data'));
    assert.ok(!yaml.includes('adminer-data'));
  });

  it('keeps dev tools out of the app depends_on and the volume list', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: {
        db: { type: 'mariadb' },
        mailpit: { type: 'mailpit' },
        adminer: { type: 'adminer' },
      },
      local: { build: true },
    });

    const yaml = planLocal(config).contents;

    // The app waits only on backing services; adminer has no healthcheck and
    // must never gate startup, and mailpit is not a runtime dependency.
    assert.ok(yaml.includes('      db:\n        condition: service_healthy'));
    assert.ok(!yaml.includes('      mailpit:'));
    assert.ok(!yaml.includes('      adminer:'));
  });

  it('emits dev tools even when the app service is not built', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { mailpit: { type: 'mailpit' } },
      local: { build: false },
    });

    const yaml = planLocal(config).contents;

    assert.ok(yaml.includes('  mailpit:'));
    assert.ok(!yaml.includes('  app:'));
    assert.ok(!yaml.includes('depends_on'));
  });

  describe('planLocal: env aliasing', () => {
    it('renders an aliased env entry as ALIAS: ${KEY}', () => {
      const config = normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        env: {
          DB_USER: { value: secret('DB_USER'), alias: 'DATABASE_USER' },
          NODE_ENV: 'production',
        },
        local: { build: true },
      });

      const yaml = planLocal(config).contents;

      assert.ok(yaml.includes('      DATABASE_USER: ${DB_USER}'));
      assert.ok(yaml.includes('      NODE_ENV: ${NODE_ENV}'));
    });
  });

  describe('planLocal: host volumes', () => {
    it('renders a host volume with options in the app service', () => {
      const config = normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        volumes: { uploads: '/host/uploads:/app/uploads:ro', data: '/var/lib/myapp' },
        local: { build: true },
      });

      const yaml = planLocal(config).contents;

      // Host volume: source:containerPath:options on a single line
      assert.ok(yaml.includes('      - /host/uploads:/app/uploads:ro'));
      // Named volume: unchanged behavior
      assert.ok(yaml.includes('      - data:/var/lib/myapp'));
    });

    it('renders a host volume without options', () => {
      const config = normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        volumes: { uploads: '/host/uploads:/app/uploads' },
        local: { build: true },
      });

      const yaml = planLocal(config).contents;

      assert.ok(yaml.includes('      - /host/uploads:/app/uploads'));
    });

    it('excludes host volumes from the top-level volumes declaration', () => {
      const config = normalizeJamalConfig({
        service: 'myapp',
        image: 'img',
        services: { db: { type: 'mariadb' } },
        volumes: { uploads: '/host/uploads:/app/uploads:ro', storage: '/app/storage' },
        local: { build: true },
      });

      const yaml = planLocal(config).contents;

      // Top-level volumes: only named volumes + backing service volumes
      assert.ok(yaml.includes('  storage:'));
      assert.ok(yaml.includes('  mariadb-data:'));
      // Host volumes never appear as Docker named volume declarations
      assert.ok(!yaml.includes('  uploads:'));
    });
  });

  it('rejects a local.ports entry naming a dev tool, value-free', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'img',
      services: { mailpit: { type: 'mailpit' } },
      local: { ports: { mailpit: 8025 }, build: false },
    });

    assert.throws(
      () => planLocal(config),
      (error: unknown): boolean => {
        assert.ok(error instanceof JamalConfigError);
        const message = String(error.message);
        assert.ok(!message.includes('mailpit'), 'the dev-tool name must not leak');
        assert.ok(!message.includes('8025'), 'the port value must not leak');
        return true;
      },
    );
  });
});
