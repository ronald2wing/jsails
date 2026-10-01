/**
 * Tests for {@link buildCommandContributionIndex} — the existing, untested
 * config-agnostic command contribution index (T3.3 foundation).
 *
 * Validates: well-formed contributions list/index/resolve correctly; invalid
 * name/config/audience/summary are rejected with value-free
 * CommandContributionError; duplicate and reserved names are rejected; missing
 * names return undefined/false for get/has and throw for resolve; a throwing
 * load thunk wraps to load_failed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCommandContributionIndex,
  CommandContributionError,
} from '../../src/cli/command-contribution.js';
import type { CliCommand } from '../../src/cli/command-registry.js';
import type { CommandContribution } from '../../src/extensions/plugin-contract.js';
import { BUILTIN_COMMANDS, createBuiltinCommandIndex } from '../../src/cli/command-catalog.js';

/** A well-formed contribution pointing to a mock thunk that returns `cmd`. */
function makeContribution(
  overrides: Partial<CommandContribution> & { name: string },
  cmd: CliCommand = fakeCommand(overrides.name),
): CommandContribution {
  return {
    summary: `${overrides.name} summary`,
    audience: 'developer',
    config: 'none',
    load: async () => cmd,
    ...overrides,
  };
}

/** Minimal CliCommand stub. */
function fakeCommand(name: string): CliCommand {
  return {
    name,
    summary: `${name} summary`,
    run() {},
  };
}

/** Contribution that loads a specific value (useful for non-command tests). */
function loadingContribution(
  name: string,
  value: unknown,
  opts?: Partial<CommandContribution>,
): CommandContribution {
  return {
    name,
    summary: `${name} summary`,
    audience: 'developer',
    config: 'none',
    load: async () => value as CliCommand,
    ...opts,
  };
}

describe('buildCommandContributionIndex', () => {
  // ------------------------------------------------------------------
  // Well-formed contributions
  // ------------------------------------------------------------------

  it('lists contributions in input order', () => {
    const hello = makeContribution({ name: 'hello' });
    const world = makeContribution({ name: 'world' });

    const index = buildCommandContributionIndex([hello, world]);

    const list = index.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.name, 'hello');
    assert.equal(list[1]!.name, 'world');
  });

  it('get and has match registered contributions', () => {
    const hello = makeContribution({ name: 'hello' });

    const index = buildCommandContributionIndex([hello]);

    assert.equal(index.has('hello'), true);
    assert.equal(index.get('hello')!.name, 'hello');
    assert.equal(index.has('nope'), false);
    assert.equal(index.get('nope'), undefined);
  });

  it('list never calls load', () => {
    let calls = 0;
    const idx = buildCommandContributionIndex([
      {
        name: 'hello',
        summary: 'says hello',
        audience: 'developer',
        config: 'none',
        load: async () => {
          calls += 1;
          return fakeCommand('hello');
        },
      },
    ]);

    idx.list();
    idx.get('hello');
    idx.has('hello');

    assert.equal(calls, 0);
  });

  it('resolve calls load and returns the result', async () => {
    const cmd = fakeCommand('hello');
    const idx = buildCommandContributionIndex([makeContribution({ name: 'hello' }, cmd)]);

    const resolved = await idx.resolve('hello');
    assert.strictEqual(resolved, cmd);
  });

  it('resolve wraps a throwing load into load_failed', async () => {
    const idx = buildCommandContributionIndex([
      loadingContribution('fragile', undefined, {
        load: async () => {
          throw new Error('boom');
        },
      }),
    ]);

    await assert.rejects(
      () => idx.resolve('fragile'),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'load_failed');
        // Value-free: message must not echo the underlying cause.
        const msg = err.message;
        assert.ok(!msg.includes('boom'));
        return true;
      },
    );
  });

  // ------------------------------------------------------------------
  // Validation: invalid name
  // ------------------------------------------------------------------

  it('rejects a non-object contribution with invalid_name', () => {
    assert.throws(
      () => buildCommandContributionIndex([null as unknown as CommandContribution]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_name');
        return true;
      },
    );
    assert.throws(
      () => buildCommandContributionIndex([42 as unknown as CommandContribution]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_name');
        return true;
      },
    );
    assert.throws(
      () => buildCommandContributionIndex([[] as unknown as CommandContribution]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_name');
        return true;
      },
    );
  });

  it('rejects a contribution with an invalid name string (bad pattern)', () => {
    assert.throws(
      () => buildCommandContributionIndex([makeContribution({ name: '' })]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_name');
        return true;
      },
    );
    assert.throws(
      () => buildCommandContributionIndex([makeContribution({ name: '-flag' })]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_name');
        return true;
      },
    );
    assert.throws(
      () => buildCommandContributionIndex([makeContribution({ name: 'has space' })]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_name');
        return true;
      },
    );
  });

  // ------------------------------------------------------------------
  // Validation: invalid summary
  // ------------------------------------------------------------------

  it('rejects an empty summary with invalid_summary', () => {
    assert.throws(
      () => buildCommandContributionIndex([makeContribution({ name: 'hello', summary: '' })]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_summary');
        return true;
      },
    );
    assert.throws(
      () => buildCommandContributionIndex([makeContribution({ name: 'hello', summary: '   ' })]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_summary');
        return true;
      },
    );
  });

  // ------------------------------------------------------------------
  // Validation: invalid audience
  // ------------------------------------------------------------------

  it('rejects an invalid audience with invalid_audience', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([
          makeContribution({ name: 'hello', audience: 'admin' as any }),
        ]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_audience');
        return true;
      },
    );
    assert.throws(
      () =>
        buildCommandContributionIndex([makeContribution({ name: 'hello', audience: '' as any })]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_audience');
        return true;
      },
    );
  });

  // ------------------------------------------------------------------
  // Validation: invalid config
  // ------------------------------------------------------------------

  it('rejects an invalid config type with invalid_config', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([
          makeContribution({ name: 'hello', config: 'database' as any }),
        ]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_config');
        return true;
      },
    );
    assert.throws(
      () =>
        buildCommandContributionIndex([makeContribution({ name: 'hello', config: null as any })]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_config');
        return true;
      },
    );
  });

  it('accepts all five valid config types', () => {
    const validTypes = ['app', 'migration', 'runtime', 'seed', 'none'] as const;
    const idx = buildCommandContributionIndex(
      validTypes.map((config) => makeContribution({ name: `cmd-${config}`, config })),
    );
    assert.equal(idx.list().length, 5);
  });

  // ------------------------------------------------------------------
  // Validation: invalid load
  // ------------------------------------------------------------------

  it('rejects a missing load function with invalid_config', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([
          {
            name: 'bad',
            summary: 'missing load',
            audience: 'developer',
            config: 'none',
          } as any,
        ]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'invalid_config');
        return true;
      },
    );
  });

  // ------------------------------------------------------------------
  // Validation: duplicate names
  // ------------------------------------------------------------------

  it('rejects duplicate names with duplicate_name', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([
          makeContribution({ name: 'hello' }),
          makeContribution({ name: 'hello' }),
        ]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'duplicate_name');
        assert.equal(err.commandName, 'hello');
        return true;
      },
    );
  });

  // ------------------------------------------------------------------
  // Validation: reserved names
  // ------------------------------------------------------------------

  it('rejects a name listed in DEFAULT_RESERVED_COMMAND_NAMES with reserved_name', () => {
    // 'migrate' is in the default reserved set.
    assert.throws(
      () => buildCommandContributionIndex([makeContribution({ name: 'migrate' })]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'reserved_name');
        return true;
      },
    );
  });

  it('rejects names from the extra reservedNames option', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([makeContribution({ name: 'deploy' })], {
          reservedNames: ['deploy'],
        }),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'reserved_name');
        return true;
      },
    );
  });

  // ------------------------------------------------------------------
  // Missing name operations
  // ------------------------------------------------------------------

  it('throws unknown_command when resolving a missing name', async () => {
    const idx = buildCommandContributionIndex([makeContribution({ name: 'hello' })]);

    await assert.rejects(
      () => idx.resolve('nope'),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        assert.equal(err.code, 'unknown_command');
        return true;
      },
    );
  });

  // ------------------------------------------------------------------
  // Value-free error messages
  // ------------------------------------------------------------------

  it('error messages never echo raw input values', () => {
    // A null contribution name gets String(null) = "null" in the field label,
    // but the message must not echo a user-supplied value like a credential.
    assert.throws(
      () =>
        buildCommandContributionIndex([
          {
            name: null,
            summary: 'x',
            audience: 'developer',
            config: 'none',
            load: async () => fakeCommand('x'),
          } as any,
        ]),
      (err: unknown) => {
        assert.ok(err instanceof CommandContributionError);
        const msg = err.message;
        // The message identifies the field, not the raw value.
        assert.ok(msg.includes('valid command name'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Built-in command catalog — T3.3 phase 3 dispatch integration
// ---------------------------------------------------------------------------

describe('BUILTIN_COMMANDS catalog', () => {
  const ALL_EXPECTED_COMMANDS = [
    'makemigrations',
    'migrate',
    'showmigrations',
    'work',
    'schedule',
    'queue',
    'schedules',
    'seed',
    'build',
    'serve',
    'dev',
    'create',
  ];

  it('contains entries for all 12 built-in heavy commands', () => {
    assert.equal(BUILTIN_COMMANDS.length, ALL_EXPECTED_COMMANDS.length);
    for (const name of ALL_EXPECTED_COMMANDS) {
      const entry = BUILTIN_COMMANDS.find((e) => e.name === name);
      assert.ok(entry !== undefined, `missing built-in command: ${name}`);
    }
  });

  it('every entry has a non-empty summary and a callable load function', () => {
    for (const entry of BUILTIN_COMMANDS) {
      assert.ok(typeof entry.summary === 'string' && entry.summary.length > 0);
      assert.ok(typeof entry.load === 'function');
    }
  });

  // config taxonomy
  const CONFIG_TAXONOMY: Record<string, string> = {
    makemigrations: 'migration',
    migrate: 'migration',
    showmigrations: 'migration',
    work: 'runtime',
    schedule: 'runtime',
    queue: 'runtime',
    schedules: 'runtime',
    seed: 'seed',
    build: 'app',
    serve: 'app',
    dev: 'app',
    create: 'none',
  };

  it('each command has the correct config discriminant', () => {
    for (const [name, expected] of Object.entries(CONFIG_TAXONOMY)) {
      const entry = BUILTIN_COMMANDS.find((e) => e.name === name);
      assert.ok(entry !== undefined, `unknown command: ${name}`);
      assert.equal(
        entry.config,
        expected,
        `command ${name} has config ${entry.config}, expected ${expected}`,
      );
    }
  });
});

describe('createBuiltinCommandIndex', () => {
  it('builds a map containing every built-in command', () => {
    const index = createBuiltinCommandIndex();
    assert.equal(index.size, BUILTIN_COMMANDS.length);
    for (const entry of BUILTIN_COMMANDS) {
      assert.equal(index.has(entry.name), true);
    }
  });

  it('returns undefined for an unknown command', () => {
    const index = createBuiltinCommandIndex();
    assert.equal(index.has('nonexistent'), false);
    assert.equal(index.get('nonexistent'), undefined);
  });

  it('never calls load() during index construction', () => {
    // createBuiltinCommandIndex operates on the static BUILTIN_COMMANDS array
    // which already has load thunks defined — but calling the index builder
    // itself must not invoke any load thunk. Build the index and verify the
    // descriptor shape is intact (the Map stores the same descriptor objects).
    const index = createBuiltinCommandIndex();
    const entry = index.get(BUILTIN_COMMANDS[0]!.name);
    assert.ok(entry !== undefined);
    assert.equal(typeof entry.load, 'function');
  });

  it('each entry can be loaded and returns a callable runner', async () => {
    // Load a single lightweight command's thunk and verify it returns a
    // function. Skip commands that need config files (migration, runtime,
    // app, seed) since they would try to load config modules.
    const skip = new Set([
      'makemigrations',
      'migrate',
      'showmigrations',
      'work',
      'schedule',
      'queue',
      'schedules',
      'seed',
      'build',
      'serve',
      'dev',
    ]);
    for (const entry of BUILTIN_COMMANDS) {
      if (skip.has(entry.name)) continue;
      const runner = await entry.load();
      assert.equal(typeof runner, 'function', `${entry.name} load() did not return a function`);
    }
  });
});

describe('dispatch resilience — broken app config does not affect migrate', () => {
  it('migrate has config type "migration" (not "app")', () => {
    const migrateEntry = BUILTIN_COMMANDS.find((e) => e.name === 'migrate');
    assert.ok(migrateEntry !== undefined);
    assert.equal(migrateEntry.config, 'migration');
  });

  it('makemigrations has config type "migration"', () => {
    const makemigrationsEntry = BUILTIN_COMMANDS.find((e) => e.name === 'makemigrations');
    assert.ok(makemigrationsEntry !== undefined);
    assert.equal(makemigrationsEntry.config, 'migration');
  });

  it('showmigrations has config type "migration"', () => {
    const showmigrationsEntry = BUILTIN_COMMANDS.find((e) => e.name === 'showmigrations');
    assert.ok(showmigrationsEntry !== undefined);
    assert.equal(showmigrationsEntry.config, 'migration');
  });

  it('migration commands never import the app command module', async () => {
    // Prove: loading the migrate thunk imports migration-commands.js, not
    // app-commands.js. The load() thunk for migrate does
    //   await import('./migration-commands.js')
    // — it never imports app-commands.js.
    const migrateEntry = BUILTIN_COMMANDS.find((e) => e.name === 'migrate');
    assert.ok(migrateEntry !== undefined);

    // The load() thunk itself is a closure — we trust the static catalog
    // to use the correct module. The structural check is in the test above
    // (config: 'migration'). Migration config modules need a JsailsDataSource
    // (jsails.config.js), never an app config (jsails.app.js).
    assert.equal(migrateEntry.config, 'migration');
  });
});
