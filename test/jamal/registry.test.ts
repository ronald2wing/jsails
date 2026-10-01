import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  planRegistryLogin,
  planRegistrySetup,
  planRegistryRemove,
  planRegistryLogout,
  formatRegistryLoginPlan,
  JamalError,
} from '../../src/jamal/registry.js';
import { normalizeJamalConfig } from '../../src/jamal/config.js';

describe('planRegistryLogin', () => {
  it('builds a docker login argv for the configured registry', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: {
        server: 'host.example.com',
        registry: { server: 'ghcr.io', username: 'mybot' },
      },
    });

    const plan = planRegistryLogin(config);

    assert.deepEqual(plan.argv, [
      'docker',
      'login',
      'ghcr.io',
      '-u',
      'mybot',
      '-p',
      'secret(JSAILS_REGISTRY_PASSWORD)',
    ]);
    assert.equal(plan.server, 'ghcr.io');
    assert.equal(plan.username, 'mybot');
    assert.equal(plan.passwordRef, 'secret(JSAILS_REGISTRY_PASSWORD)');
  });

  it('throws when no production registry is configured', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: { server: 'host.example.com' },
    });

    assert.throws(
      () => planRegistryLogin(config),
      (error: unknown) => {
        assert.ok(error instanceof JamalError);
        assert.match(error.message, /production registry is required/);
        return true;
      },
    );
  });

  it('throws when no production config at all', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
    });

    assert.throws(
      () => planRegistryLogin(config),
      (error: unknown) => {
        assert.ok(error instanceof JamalError);
        assert.match(error.message, /production registry is required/);
        return true;
      },
    );
  });

  it('never embeds a real password in the plan', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: {
        server: 'host.example.com',
        registry: { server: 'docker.io', username: 'ci' },
      },
    });

    const plan = planRegistryLogin(config);

    // The password is always the redacted form.
    const str = JSON.stringify(plan);
    assert.ok(!str.includes('mypassword'), 'password must not appear in the plan');
    assert.ok(str.includes('secret(JSAILS_REGISTRY_PASSWORD)'));
  });
});

describe('planRegistrySetup', () => {
  it('returns the same plan as planRegistryLogin', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: {
        server: 'host.example.com',
        registry: { server: 'ghcr.io', username: 'mybot' },
      },
    });

    const loginPlan = planRegistryLogin(config);
    const setupPlan = planRegistrySetup(config);

    assert.deepEqual(setupPlan, loginPlan);
  });

  it('throws when no production registry is configured', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: { server: 'host.example.com' },
    });

    assert.throws(
      () => planRegistrySetup(config),
      (error: unknown) => {
        assert.ok(error instanceof JamalError);
        assert.match(error.message, /production registry is required/);
        return true;
      },
    );
  });
});

describe('planRegistryRemove', () => {
  it('emits docker logout <server> with no password token in argv', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: {
        server: 'host.example.com',
        registry: { server: 'ghcr.io', username: 'mybot' },
      },
    });

    const plan = planRegistryRemove(config);

    assert.deepEqual(plan.argv, ['docker', 'logout', 'ghcr.io']);
    assert.equal(plan.server, 'ghcr.io');
    assert.equal(plan.username, 'mybot');
    assert.equal(plan.passwordRef, 'secret(JSAILS_REGISTRY_PASSWORD)');
    // The password must NOT appear in the argv.
    assert.ok(!plan.argv.includes('secret(JSAILS_REGISTRY_PASSWORD)'));
    assert.ok(!plan.argv.includes('-p'));
  });

  it('throws when no production registry is configured', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: { server: 'host.example.com' },
    });

    assert.throws(
      () => planRegistryRemove(config),
      (error: unknown) => {
        assert.ok(error instanceof JamalError);
        assert.match(error.message, /production registry is required/);
        return true;
      },
    );
  });

  it('throws when no production config at all', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
    });

    assert.throws(
      () => planRegistryRemove(config),
      (error: unknown) => {
        assert.ok(error instanceof JamalError);
        assert.match(error.message, /production registry is required/);
        return true;
      },
    );
  });
});

describe('planRegistryLogout', () => {
  it('returns the same plan as planRegistryRemove', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: {
        server: 'host.example.com',
        registry: { server: 'ghcr.io', username: 'mybot' },
      },
    });

    const removePlan = planRegistryRemove(config);
    const logoutPlan = planRegistryLogout(config);

    assert.deepEqual(logoutPlan, removePlan);
  });

  it('throws when no production registry is configured', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: { server: 'host.example.com' },
    });

    assert.throws(
      () => planRegistryLogout(config),
      (error: unknown) => {
        assert.ok(error instanceof JamalError);
        assert.match(error.message, /production registry is required/);
        return true;
      },
    );
  });
});

describe('formatRegistryLoginPlan', () => {
  it('renders server, username, password ref, and the command', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: {
        server: 'host.example.com',
        registry: { server: 'ghcr.io', username: 'mybot' },
      },
    });

    const plan = planRegistryLogin(config);
    const output = formatRegistryLoginPlan(plan);

    assert.match(output, /Registry: ghcr.io/);
    assert.match(output, /Username: mybot/);
    assert.match(output, /secret\(JSAILS_REGISTRY_PASSWORD\)/);
    assert.match(output, /docker login ghcr.io -u mybot -p secret/);
    assert.match(output, /resolve this secret/);
  });
});
