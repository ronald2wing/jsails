import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUILTIN_DEPLOYMENT_GENERATOR_IDS,
  BUILTIN_DEPLOYMENT_GENERATORS,
} from '../../src/deploy/builtin-generators.js';
import {
  HARDENING_SCRIPT_FILENAME,
  HardeningConfigError,
  generateServerHardeningConfig,
  type ServerHardeningOptions,
} from '../../src/deploy/hardening-config.js';
import { createDeploymentGeneratorRegistry } from '../../src/deploy/registry.js';

/** Non-blank lines, trimmed, with the leading `# ` comment marker kept intact. */
function lines(script: string): string[] {
  return script.split('\n').filter((line) => line.trim() !== '');
}

/** Every line whose trimmed text starts with `#` (a comment). */
function commentLines(script: string): string[] {
  return lines(script).filter((line) => line.trimStart().startsWith('#'));
}

describe('generateServerHardeningConfig', () => {
  it('produces a single string script under the frozen filename', () => {
    assert.equal(HARDENING_SCRIPT_FILENAME, 'config/harden-server.sh');

    const { script } = generateServerHardeningConfig();
    assert.equal(typeof script, 'string');
    assert.ok(script.length > 0);
  });

  it('is pure: identical output for identical input, with no writes or secrets', () => {
    const a = generateServerHardeningConfig();
    const b = generateServerHardeningConfig();
    assert.deepEqual(a, b);
    assert.ok(!a.script.includes('hunter2'));
  });

  it('applies a default-deny-incoming / default-allow-outgoing policy', () => {
    const { script } = generateServerHardeningConfig();
    assert.ok(script.includes('ufw default deny incoming'));
    assert.ok(script.includes('ufw default allow outgoing'));
  });

  it('allows OpenSSH, 80, and 443 before enabling', () => {
    const { script } = generateServerHardeningConfig();
    assert.ok(script.includes('ufw allow OpenSSH'));
    assert.ok(script.includes('ufw allow 80/tcp'));
    assert.ok(script.includes('ufw allow 443/tcp'));
    assert.ok(script.includes('ufw --force enable'));
  });

  it('guards with `command -v ufw` and `ufw status` so re-runs are idempotent', () => {
    const { script } = generateServerHardeningConfig();
    assert.ok(script.includes('command -v ufw'));
    assert.ok(script.includes('ufw status'));
    // The enable is gated on the firewall not already being active.
    assert.ok(script.includes('ufw --force enable'));
  });

  it('documents the rollback (`ufw disable`) and the non-22 SSH port requirement', () => {
    const { script } = generateServerHardeningConfig();
    const comments = commentLines(script).join('\n');
    assert.ok(comments.includes('ufw disable'));
    assert.ok(comments.includes('non-22 port'));
  });

  it('documents that Docker-published ports bypass UFW via the DOCKER-USER chain', () => {
    const { script } = generateServerHardeningConfig();
    const comments = commentLines(script).join('\n');
    assert.ok(comments.includes('DOCKER-USER'));
    assert.ok(comments.includes('Docker'));
    assert.ok(comments.includes('FORWARD'));
  });

  it('suggests disabling SSH password auth and installing fail2ban as comments only', () => {
    const { script } = generateServerHardeningConfig();
    const comments = commentLines(script).join('\n');
    assert.ok(comments.includes('PasswordAuthentication no'));
    assert.ok(comments.includes('fail2ban'));

    // These are suggestions, never executed: every line that mentions them is a
    // comment, and the executable body never references either.
    for (const line of lines(script)) {
      if (line.includes('fail2ban') || line.includes('PasswordAuthentication')) {
        assert.ok(line.trimStart().startsWith('#'), `suggestion must be commented: ${line}`);
      }
    }
  });

  it('rejects a non-plain-object options argument', () => {
    assert.throws(
      () => generateServerHardeningConfig(null as unknown as ServerHardeningOptions),
      HardeningConfigError,
    );
    assert.throws(() => generateServerHardeningConfig([]), HardeningConfigError);
  });
});

describe('harden-server built-in generator', () => {
  it('is registered under the built-in id, after the ONCE preset', () => {
    assert.ok(BUILTIN_DEPLOYMENT_GENERATOR_IDS.includes('harden-server'));
    assert.ok(
      BUILTIN_DEPLOYMENT_GENERATORS.some((generator) => generator.name === 'harden-server'),
    );

    const list = [...BUILTIN_DEPLOYMENT_GENERATOR_IDS];
    assert.equal(list[list.indexOf('once') + 1], 'harden-server');
  });

  it('maps the script to config/harden-server.sh through the registry', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('harden-server');
    const direct = generateServerHardeningConfig();

    assert.deepEqual(Object.keys(result.files), ['config/harden-server.sh']);
    assert.equal(result.files['config/harden-server.sh'], direct.script);
    assert.ok(Object.isFrozen(result.files));
    assert.equal(Object.getPrototypeOf(result.files), null);
  });

  it('never executes anything: the registry only returns a file map', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('harden-server');

    // The output is a proposal, not a run: exactly one file, string-valued.
    assert.equal(Object.keys(result.files).length, 1);
    assert.equal(typeof result.files['config/harden-server.sh'], 'string');
  });
});
