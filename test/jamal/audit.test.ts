import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planAudit, formatAuditPlan } from '../../src/jamal/audit.js';
import { normalizeJamalConfig } from '../../src/jamal/config.js';

describe('planAudit', () => {
  it('flags a missing production config as info', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
    });

    const plan = planAudit(config);

    const prodMissing = plan.findings.find((f) => f.description.includes('No production config'));
    assert.ok(prodMissing !== undefined);
    assert.equal(prodMissing.severity, 'info');
  });

  it('warns about missing TLS (no domain and no on-demand TLS URL)', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: { server: 'host.example.com' },
    });

    const plan = planAudit(config);

    const tlsMissing = plan.findings.find((f) => f.description.includes('No TLS configured'));
    assert.ok(tlsMissing !== undefined);
    assert.equal(tlsMissing.severity, 'warning');
  });

  it('warns about on-demand TLS without an allowlist endpoint', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: {
        server: 'host.example.com',
        onDemandTlsUrl: 'https://tls.example.com/check',
      },
    });

    const plan = planAudit(config);

    const onDemandWarning = plan.findings.find((f) => f.description.includes('On-demand TLS'));
    assert.ok(onDemandWarning !== undefined);
    assert.equal(onDemandWarning.severity, 'warning');
  });

  it('errors when the production config has no registry', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: {
        server: 'host.example.com',
        domain: 'example.com',
      },
    });

    const plan = planAudit(config);

    const noRegistry = plan.findings.find((f) => f.description.includes('No registry configured'));
    assert.ok(noRegistry !== undefined);
    assert.equal(noRegistry.severity, 'error');
  });

  it('warns about plaintext env values', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      env: {
        DB_HOST: 'db.example.com',
        DB_PASSWORD: 'hunter2',
        API_KEY: 'sk-plaintext',
      },
    });

    const plan = planAudit(config);

    const plaintextWarning = plan.findings.find((f) =>
      f.description.includes('plaintext strings rather than secret'),
    );
    assert.ok(plaintextWarning !== undefined);
    assert.equal(plaintextWarning.severity, 'warning');
    // The finding must name the keys so the operator knows which ones.
    const desc = plaintextWarning.description;
    assert.match(desc, /DB_HOST/);
    assert.match(desc, /DB_PASSWORD/);
    assert.match(desc, /API_KEY/);
  });

  it('warns about missing health check config', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
    });

    const plan = planAudit(config);

    const noHealth = plan.findings.find((f) =>
      f.description.includes('No health check configured'),
    );
    assert.ok(noHealth !== undefined);
    assert.equal(noHealth.severity, 'warning');
  });

  it('notes the health path is /up (the default)', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      health: { path: '/up', timeoutMs: 5000, intervalMs: 1000 },
    });

    const plan = planAudit(config);

    const healthInfo = plan.findings.find((f) =>
      f.description.includes('Health check path is /up'),
    );
    assert.ok(healthInfo !== undefined);
    assert.equal(healthInfo.severity, 'info');
  });

  it('notes published local ports', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      local: { ports: { http: 8080, database: 3306 } },
    });

    const plan = planAudit(config);

    const portInfo = plan.findings.find((f) => f.description.includes('Local ports published'));
    assert.ok(portInfo !== undefined);
    assert.equal(portInfo.severity, 'info');
    assert.match(portInfo.description, /http:8080/);
    assert.match(portInfo.description, /database:3306/);
  });

  it('never embeds config values in finding descriptions except key names', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      env: { SECRET_KEY: 'top-secret-value!' },
    });

    const plan = planAudit(config);

    for (const finding of plan.findings) {
      assert.ok(
        !finding.description.includes('top-secret-value!'),
        'finding must never embed a secret value',
      );
    }
  });

  it('produces a summary line with error/warning/info counts', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: { server: 'host.example.com' },
    });

    const plan = planAudit(config);

    assert.ok(plan.summary.length > 0);
    const errors = plan.findings.filter((f) => f.severity === 'error').length;
    const warnings = plan.findings.filter((f) => f.severity === 'warning').length;
    const infos = plan.findings.filter((f) => f.severity === 'info').length;
    assert.match(plan.summary, new RegExp(`${errors} error`));
    assert.match(plan.summary, new RegExp(`${warnings} warning`));
    assert.match(plan.summary, new RegExp(`${infos} info`));
  });
});

describe('formatAuditPlan', () => {
  it('renders "No findings." when the plan is empty', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      // A thorough config: production with registry and domain, health check,
      // no plaintext env, bind-mounted volumes.
      production: {
        server: 'host.example.com',
        domain: 'example.com',
        registry: { server: 'ghcr.io', username: 'bot' },
      },
      env: {},
      health: { path: '/healthz', timeoutMs: 5000, intervalMs: 1000 },
      volumes: { data: '/var/lib/data' },
    });

    // All env values are SecretRefs? No, they're all empty. No plaintext.
    const plan = planAudit(config);
    const output = formatAuditPlan(plan);

    assert.match(output, /No findings/);
  });

  it('renders findings with severity labels', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp:latest',
      production: { server: 'host.example.com' },
      env: { KEY: 'value' },
    });

    const plan = planAudit(config);
    const output = formatAuditPlan(plan);

    // Should have at least ERROR (no registry), WARN (plaintext env, no health), INFO (no prod conf? no - prod IS present)
    assert.match(output, /\[ERROR\]/);
    assert.match(output, /\[WARN /);
  });
});
