import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

/**
 * Tests for the opt-in live-integration verification harness
 * (`scripts/verify-integrations.mjs`). They spawn the real script as a child
 * process and assert only its *skip* and *config-failure* behavior — never a
 * live service, because none is provisioned on the test machine:
 *
 *  1. with no integration env vars, the script exits 0 and reports every stage
 *     `skipped` with a clear tally;
 *  2. a bogus `DATABASE_TYPE` (with full, secret-bearing DB env) fails
 *     non-zero without leaking the bogus type or any credential into the output.
 *
 * The child runs from an empty temp cwd so the harness's `.env` assembly finds
 * no developer `.env` file — otherwise a repo-local `.env` would make stages run
 * against real services. The harness is opt-in (`npm run verify:integrations`)
 * and is not part of `npm run check`; these cases only prove the harness stays
 * out of the default workflow and fails safe when misconfigured.
 */

const scriptPath = fileURLToPath(
  new URL('../../../scripts/verify-integrations.mjs', import.meta.url),
);

const emptyCwd = mkdtempSync(join(tmpdir(), 'verify-integrations-'));

after(() => {
  rmSync(emptyCwd, { recursive: true, force: true });
});

/** Strip every integration var so the child never inherits a leftover gate. */
function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('JSAILS_TEST_')) continue;
    if (key.startsWith('DATABASE_')) continue;
    if (key === 'VALKEY_URL') continue;
    env[key] = value;
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
    cwd: emptyCwd,
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

  it('fails safely on a bogus DATABASE_TYPE without leaking values', () => {
    const secret = 's3cr3t-pass-9f2a';
    const bogus = 'oracle';
    const { status, stdout, stderr } = runScript(
      cleanEnv({
        DATABASE_TYPE: bogus,
        DATABASE_HOST: 'db.internal.example',
        DATABASE_PORT: '5432',
        DATABASE_USER: 'integration-admin',
        DATABASE_PASSWORD: secret,
        DATABASE_NAME: 'proddb',
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
