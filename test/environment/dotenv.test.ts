import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { assembleEnvironment } from '../../src/dotenv.js';

/**
 * The environment assembly: developer-owned `.env` files become `process.env`
 * at bootstrap, without ever overwriting a real environment variable.
 *
 * Semantics follow the Node consensus (dotenv-flow / Vite / Next / Symfony):
 * a cumulative merge where `.env` is base and `.env.testing` / `.env.local` /
 * `.env.${NODE_ENV}` layer on top, with `.env.local` skipped under test.
 */
describe('assembleEnvironment', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotenv-'));
  let seq = 0;

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A fresh, empty per-test directory so files never leak between cases. */
  function fixture(): string {
    const dir = join(root, `case-${seq++}`);
    mkdirSync(dir);
    return dir;
  }

  function freshEnv(): NodeJS.ProcessEnv {
    return {};
  }

  it('loads .env into an empty env map (non-test)', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_HOST=127.0.0.1\nDATABASE_NAME=app\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'development', env });
    assert.equal(env['DATABASE_HOST'], '127.0.0.1');
    assert.equal(env['DATABASE_NAME'], 'app');
  });

  it('never overwrites an already-set real variable (real env wins)', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=from-file\n');
    const env: NodeJS.ProcessEnv = { DATABASE_NAME: 'from-env' };
    assembleEnvironment({ rootDir: dir, env });
    assert.equal(env['DATABASE_NAME'], 'from-env');
  });

  it('test mode: .env.testing overrides .env (merge, dev keys inherited)', () => {
    const dir = fixture();
    // `.env` sets DATABASE_NAME and a dev-only key, DATABASE_URL.
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=app\nDATABASE_URL=mysql://dev\n');
    // `.env.testing` re-sets only DATABASE_NAME.
    writeFileSync(join(dir, '.env.testing'), 'DATABASE_NAME=app_test\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'test', env });

    assert.equal(env['DATABASE_NAME'], 'app_test');
    // Merge, not substitute: DATABASE_URL lived only in `.env`, and `.env` is
    // still loaded in test mode, so it is inherited.
    assert.equal(env['DATABASE_URL'], 'mysql://dev');
  });

  it('test mode loads .env when .env.testing is absent', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=app\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'test', env });
    assert.equal(env['DATABASE_NAME'], 'app');
  });

  it('test mode never loads .env.local', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=app\n');
    writeFileSync(join(dir, '.env.testing'), 'DATABASE_NAME=app_test\n');
    writeFileSync(join(dir, '.env.local'), 'DATABASE_NAME=local_dev\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'test', env });
    assert.equal(env['DATABASE_NAME'], 'app_test');
  });

  it('non-test mode: .env.local overrides .env', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'DATABASE_NAME=app\n');
    writeFileSync(join(dir, '.env.local'), 'DATABASE_NAME=local_dev\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'development', env });
    assert.equal(env['DATABASE_NAME'], 'local_dev');
  });

  it('non-test mode: .env.<nodeEnv> layers over .env', () => {
    const dir = fixture();
    writeFileSync(join(dir, '.env'), 'A=1\nB=2\n');
    writeFileSync(join(dir, '.env.staging'), 'B=staging\nC=3\n');
    const env = freshEnv();
    assembleEnvironment({ rootDir: dir, nodeEnv: 'staging', env });
    assert.equal(env['A'], '1');
    assert.equal(env['B'], 'staging');
    assert.equal(env['C'], '3');
  });

  it('is a silent no-op when no files exist', () => {
    const env = freshEnv();
    assembleEnvironment({ rootDir: join(root, 'missing'), env });
    assert.deepEqual(env, {});
  });
});
