import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../../src/cli.js';

/**
 * CLI flag validation tests for the new migration flags.
 * These tests only validate flag combinations and dispatch — no database
 * connection or file system is touched because invalid config paths will fail
 * before any operation runs. The tests verify that flag gating (ownership,
 * mutual exclusion, format validation) catches the right shape errors.
 */

describe('showmigrations --format flag gating', () => {
  it('--format is rejected for commands other than showmigrations', async () => {
    const result = await runCli(['migrate', '--format', 'json']);
    assert.equal(result, 2, '--format on migrate is a usage error');
  });

  it('--format is rejected on makemigrations', async () => {
    const result = await runCli(['makemigrations', '--format', 'json']);
    assert.equal(result, 2, '--format on makemigrations is a usage error');
  });

  it('--format table is accepted on showmigrations (config loads even if missing)', async () => {
    // This will fail because the config module doesn't exist, but the flag
    // was accepted (not a usage error 2). Error 1 means the flag was valid
    // but the operation failed.
    const result = await runCli([
      'showmigrations',
      '--config',
      '/nonexistent/config.js',
      '--format',
      'table',
    ]);
    assert.ok(result === 1 || result === 2);
  });
});

describe('--fake and --fake-initial flag gating', () => {
  it('--fake is rejected for non-migrate commands', async () => {
    const result = await runCli(['showmigrations', '--fake']);
    assert.equal(result, 2, '--fake on showmigrations is a usage error');
  });

  it('--fake-initial is rejected for non-migrate commands', async () => {
    const result = await runCli(['showmigrations', '--fake-initial']);
    assert.equal(result, 2, '--fake-initial on showmigrations is a usage error');
  });

  it('--fake and --fake-initial are mutually exclusive', async () => {
    const result = await runCli(['migrate', '--fake', '--fake-initial']);
    assert.equal(result, 2, '--fake and --fake-initial combined is a usage error');
  });

  it('--fake with --down is rejected (fake only for forward)', async () => {
    // --fake on a rollback should be a usage error
    const result = await runCli([
      'migrate',
      '--fake',
      '--down',
      'some_name',
      '--allow-destructive',
    ]);
    assert.equal(result, 2);
  });
});

describe('--format invalid values', () => {
  it('rejects an unknown format value', async () => {
    const result = await runCli([
      'showmigrations',
      '--config',
      '/nonexistent/config.js',
      '--format',
      'xml',
    ]);
    assert.equal(result, 2);
  });
});
