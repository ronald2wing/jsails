import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Tests for the opt-in live-integration verification harness
 * (`scripts/verify-integrations.mjs`). They spawn the real script as a child
 * process and assert only its *skip* and *config-failure* behavior — never a
 * live service, because none is provisioned on the test machine:
 *
 *  1. with no integration env vars, the script exits 0 and reports every stage
 *     `skipped` with a clear tally;
 *  2. a bogus `JSAILS_TEST_DB_TYPE` (with full, secret-bearing DB env) fails
 *     non-zero without leaking the bogus type or any credential into the output.
 *
 * The harness is opt-in (`npm run verify:integrations`) and is not part of
 * `npm run check`; these cases only prove the harness stays out of the default
 * workflow and fails safe when misconfigured.
 */

const scriptPath = fileURLToPath(new URL('../../scripts/verify-integrations.mjs', import.meta.url));

/** Strip every `JSAILS_TEST_*` var so the child never inherits a leftover gate. */
function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('JSAILS_TEST_')) env[key] = value ?? '';
  }
  return { ...env, ...overrides };
}

function runScript(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('verify-integrations harness', () => {
  it('exits 0 with every stage skipped when no integration env is set', () => {
    const { status, stdout, stderr } = runScript(cleanEnv());

    assert.equal(status, 0, `expected exit 0, got ${status}; stderr: ${stderr}`);
    assert.match(stdout, /stage database: skipped/);
    assert.match(stdout, /stage jobs: skipped/);
    assert.match(stdout, /stage broadcast: skipped/);
    assert.match(stdout, /stage docker: skipped/);
    assert.match(stdout, /SUMMARY ok=0 failed=0 skipped=4/);
  });

  it('fails safely on a bogus JSAILS_TEST_DB_TYPE without leaking values', () => {
    const secret = 's3cr3t-pass-9f2a';
    const bogus = 'oracle';
    const { status, stdout, stderr } = runScript(
      cleanEnv({
        JSAILS_TEST_DB_TYPE: bogus,
        JSAILS_TEST_DB_HOST: 'db.internal.example',
        JSAILS_TEST_DB_PORT: '5432',
        JSAILS_TEST_DB_USER: 'integration-admin',
        JSAILS_TEST_DB_PASSWORD: secret,
        JSAILS_TEST_DB_NAME: 'proddb',
      }),
    );

    assert.notEqual(status, 0, 'a bogus DB type must fail non-zero');
    const output = stdout + stderr;
    assert.match(output, /SUMMARY ok=0 failed=1 skipped=3/);
    for (const value of [bogus, secret, 'db.internal.example', 'integration-admin', 'proddb']) {
      assert.ok(!output.includes(value), `output must not leak ${JSON.stringify(value)}`);
    }
  });
});
