import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CliCommand, CommandAudience } from '../../src/cli/command-registry.js';
import {
  buildCommandContributionIndex,
  CommandContributionError,
} from '../../src/cli/command-contribution.js';
import type { CommandContribution } from '../../src/extensions/plugin-contract.js';

/**
 * Tests for the command-contribution builder (T3.3 foundation).
 *
 * Coverage:
 * - Valid contributions build a usable index.
 * - Invalid names / summaries / audiences / configs are rejected value-free.
 * - Duplicate and reserved names are rejected.
 * - No `load()` thunk is called at index-build time (laziness).
 * - `resolve()` calls the thunk on demand.
 * - `describe()` merging collects plugin-contributed commands.
 */
describe('buildCommandContributionIndex', () => {
  /** A valid contribution thunk — never called in index-build tests (verified per test). */
  const stubCommand: CliCommand = {
    name: 'hello',
    summary: 'say hello',
    run() {},
  };

  function validContribution(overrides: Partial<CommandContribution> = {}): CommandContribution {
    return {
      name: 'hello',
      summary: 'say hello',
      audience: 'user',
      config: 'none',
      load: async () => stubCommand,
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // happy path
  // ---------------------------------------------------------------------------

  it('builds an index from a valid contribution', () => {
    const index = buildCommandContributionIndex([validContribution()]);
    assert.equal(index.has('hello'), true);
    const list = index.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, 'hello');
  });

  it('builds an index from multiple valid contributions', () => {
    const index = buildCommandContributionIndex([
      validContribution({ name: 'cmd-a' }),
      validContribution({ name: 'cmd-b' }),
    ]);
    assert.equal(index.has('cmd-a'), true);
    assert.equal(index.has('cmd-b'), true);
    assert.equal(index.list().length, 2);
  });

  it('allows all five config type values', () => {
    const types = ['app', 'migration', 'runtime', 'seed', 'none'] as const;
    for (const config of types) {
      const index = buildCommandContributionIndex([
        validContribution({ name: `cmd-${config}`, config }),
      ]);
      assert.equal(index.has(`cmd-${config}`), true);
    }
  });

  it('allows both audience values', () => {
    for (const audience of ['developer', 'user'] as CommandAudience[]) {
      const index = buildCommandContributionIndex([
        validContribution({ name: `cmd-${audience}`, audience }),
      ]);
      assert.equal(index.has(`cmd-${audience}`), true);
    }
  });

  it('get returns the contribution without calling load', () => {
    let called = false;
    const index = buildCommandContributionIndex([
      validContribution({
        load: async () => {
          called = true;
          return stubCommand;
        },
      }),
    ]);
    const contribution = index.get('hello');
    assert.ok(contribution !== undefined);
    assert.equal(called, false, 'load() must not be called during get()');
  });

  it('list returns all contributions without calling load', () => {
    let called = false;
    const index = buildCommandContributionIndex([
      validContribution({
        load: async () => {
          called = true;
          return stubCommand;
        },
      }),
    ]);
    const list = index.list();
    assert.equal(list.length, 1);
    assert.equal(called, false, 'load() must not be called during list()');
  });

  it('has returns boolean without calling load', () => {
    let called = false;
    const index = buildCommandContributionIndex([
      validContribution({
        load: async () => {
          called = true;
          return stubCommand;
        },
      }),
    ]);
    assert.equal(index.has('hello'), true);
    assert.equal(index.has('unknown'), false);
    assert.equal(called, false, 'load() must not be called during has()');
  });

  it('resolve calls the load thunk and returns the result', async () => {
    let called = false;
    const index = buildCommandContributionIndex([
      validContribution({
        load: async () => {
          called = true;
          return stubCommand;
        },
      }),
    ]);
    const result = await index.resolve('hello');
    assert.equal(called, true);
    assert.equal(result.name, 'hello');
    assert.equal(typeof result.run, 'function');
  });

  it('resolve rejects with unknown_command for an unknown name', async () => {
    const index = buildCommandContributionIndex([validContribution()]);
    await assert.rejects(index.resolve('unknown'), (error: unknown) => {
      assert.ok(error instanceof CommandContributionError);
      assert.equal(error.code, 'unknown_command');
      return true;
    });
  });

  it('resolve rejects with load_failed when the thunk throws', async () => {
    const index = buildCommandContributionIndex([
      validContribution({
        load: async () => {
          throw new Error('boom');
        },
      }),
    ]);
    await assert.rejects(index.resolve('hello'), (error: unknown) => {
      assert.ok(error instanceof CommandContributionError);
      assert.equal(error.code, 'load_failed');
      // The original error message is never echoed.
      assert.ok(!(error as Error).message.includes('boom'));
      return true;
    });
  });

  // ---------------------------------------------------------------------------
  // validation
  // ---------------------------------------------------------------------------

  it('rejects an empty array (no-op but valid)', () => {
    const index = buildCommandContributionIndex([]);
    assert.equal(index.list().length, 0);
  });

  it('rejects non-array input with a value-free error', () => {
    assert.throws(
      () => buildCommandContributionIndex(null as unknown as CommandContribution[]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_config');
        return true;
      },
    );
  });

  it('rejects an invalid name with a value-free error', () => {
    assert.throws(
      () => buildCommandContributionIndex([validContribution({ name: '-bad' })]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_name');
        return true;
      },
    );
  });

  it('rejects an empty name', () => {
    assert.throws(
      () => buildCommandContributionIndex([validContribution({ name: '' })]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_name');
        return true;
      },
    );
  });

  it('rejects an empty summary', () => {
    assert.throws(
      () => buildCommandContributionIndex([validContribution({ summary: '  ' })]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_summary');
        return true;
      },
    );
  });

  it('rejects a non-string summary', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([
          validContribution({ summary: undefined as unknown as string }),
        ]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_summary');
        return true;
      },
    );
  });

  it('rejects an invalid audience with a value-free error', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([
          validContribution({ audience: 'admin' as unknown as CommandAudience }),
        ]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_audience');
        return true;
      },
    );
  });

  it('rejects an invalid config with a value-free error', () => {
    assert.throws(
      () => buildCommandContributionIndex([validContribution({ config: 'unknown' as any })]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_config');
        return true;
      },
    );
  });

  it('rejects a missing load function', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([
          validContribution({ load: undefined as unknown as () => Promise<CliCommand> }),
        ]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_config');
        return true;
      },
    );
  });

  it('rejects a contribution that is not an object', () => {
    assert.throws(
      () => buildCommandContributionIndex(['not-an-object' as unknown as CommandContribution]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_name');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // duplicates and reserved names
  // ---------------------------------------------------------------------------

  it('rejects duplicate command names', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([
          validContribution({ name: 'dupe' }),
          validContribution({ name: 'dupe' }),
        ]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'duplicate_name');
        assert.equal(error.commandName, 'dupe');
        return true;
      },
    );
  });

  it('rejects reserved builtin command names', () => {
    assert.throws(
      () => buildCommandContributionIndex([validContribution({ name: 'migrate' })]),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'reserved_name');
        assert.equal(error.commandName, 'migrate');
        return true;
      },
    );
  });

  it('rejects additional reserved names passed via options', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([validContribution({ name: 'custom-cmd' })], {
          reservedNames: ['custom-cmd'],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'reserved_name');
        return true;
      },
    );
  });

  it('rejects invalid reservedNames option', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([], {
          reservedNames: 'not-an-array' as unknown as string[],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_config');
        return true;
      },
    );
  });

  it('rejects reservedNames with empty entries', () => {
    assert.throws(
      () =>
        buildCommandContributionIndex([], {
          reservedNames: ['valid', ''],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CommandContributionError);
        assert.equal(error.code, 'invalid_config');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // laziness — the core invariant
  // ---------------------------------------------------------------------------

  it('never calls load() during index construction even with many contributions', () => {
    let callCount = 0;
    const contributions: CommandContribution[] = [];
    for (let i = 0; i < 10; i++) {
      contributions.push(
        validContribution({
          name: `cmd-${i}`,
          load: async () => {
            callCount += 1;
            return stubCommand;
          },
        }),
      );
    }
    const index = buildCommandContributionIndex(contributions);
    assert.equal(callCount, 0, 'no load() thunk may be called at index-build time');
    // The index must be functional though.
    assert.equal(index.list().length, 10);
    assert.equal(callCount, 0, 'list() must not call load()');
  });

  it('usage field is carried through when present', () => {
    const index = buildCommandContributionIndex([
      validContribution({ name: 'with-usage', usage: 'cmd <input>' }),
    ]);
    const entry = index.get('with-usage');
    assert.ok(entry !== undefined);
    assert.equal(entry.usage, 'cmd <input>');
  });

  it('usage field is absent when omitted', () => {
    const index = buildCommandContributionIndex([validContribution({ name: 'no-usage' })]);
    const entry = index.get('no-usage');
    assert.ok(entry !== undefined);
    assert.equal(entry.usage, undefined);
  });
});

// ---------------------------------------------------------------------------
// PluginDescription commands merging via the describe() seam
// ---------------------------------------------------------------------------

describe('PluginDescription commands merging', () => {
  /**
   * Simulates what `collectPluginCommands` does in describe-command.ts:
   * iterate over extension objects, call `describe()` when present, and
   * collect the `commands` array. No `load()` is called, no setup runs.
   */
  function collectCommands(
    extensions: readonly { describe?: () => { commands?: readonly CommandContribution[] } }[],
  ): CommandContribution[] {
    const results: CommandContribution[] = [];
    for (const extension of extensions) {
      if (typeof extension.describe !== 'function') continue;
      const description = extension.describe();
      if (description?.commands !== undefined) {
        for (const cmd of description.commands) {
          results.push(cmd);
        }
      }
    }
    return results;
  }

  it('collects commands from plugins that expose describe()', () => {
    const results = collectCommands([
      {
        describe: () => ({
          commands: [
            {
              name: 'cmd-one',
              summary: 'first command',
              audience: 'developer',
              config: 'app',
              load: async () => ({ name: 'cmd-one', summary: 'first', run() {} }),
            },
          ],
        }),
      },
    ]);
    assert.equal(results.length, 1);
    const cmd = results[0]!;
    assert.equal(cmd.name, 'cmd-one');
    assert.equal(cmd.summary, 'first command');
    assert.equal(cmd.audience, 'developer');
    assert.equal(cmd.config, 'app');
  });

  it('merges commands from multiple plugins', () => {
    const results = collectCommands([
      {
        describe: () => ({
          commands: [
            {
              name: 'cmd-a',
              summary: 'command A',
              audience: 'user',
              config: 'none',
              load: async () => ({ name: 'cmd-a', summary: 'A', run() {} }),
            },
          ],
        }),
      },
      {
        describe: () => ({
          commands: [
            {
              name: 'cmd-b',
              summary: 'command B',
              audience: 'developer',
              config: 'migration',
              load: async () => ({ name: 'cmd-b', summary: 'B', run() {} }),
            },
          ],
        }),
      },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.name, 'cmd-a');
    assert.equal(results[1]!.name, 'cmd-b');
  });

  it('skips plugins without a describe function', () => {
    const results = collectCommands([
      { name: 'no-describe' } as any,
      {
        describe: () => ({
          commands: [
            {
              name: 'cmd-one',
              summary: 'only command',
              audience: 'developer',
              config: 'app',
              load: async () => ({ name: 'cmd-one', summary: 'only', run() {} }),
            },
          ],
        }),
      },
    ]);
    assert.equal(results.length, 1);
  });

  it('skips plugins whose describe() returns no commands', () => {
    const results = collectCommands([
      {
        describe: () => ({ components: [{ name: 'comp', actions: [], writableKeys: [] }] }),
      } as any,
    ]);
    assert.equal(results.length, 0);
  });

  it('returns an empty array when no plugins contribute commands', () => {
    const results = collectCommands([]);
    assert.equal(results.length, 0);
  });

  it('never calls load() during collection', () => {
    let called = false;
    collectCommands([
      {
        describe: () => ({
          commands: [
            {
              name: 'lazy-cmd',
              summary: 'lazy',
              audience: 'user',
              config: 'none',
              load: async () => {
                called = true;
                return { name: 'lazy-cmd', summary: 'lazy', run() {} };
              },
            },
          ],
        }),
      },
    ]);
    assert.equal(called, false, 'load() must not be called during describe() collection');
  });

  it('passed through buildCommandContributionIndex still does not call load', () => {
    let called = false;
    const contributions = collectCommands([
      {
        describe: () => ({
          commands: [
            {
              name: 'indexed',
              summary: 'indexed command',
              audience: 'user',
              config: 'none',
              load: async () => {
                called = true;
                return { name: 'indexed', summary: 'indexed', run() {} };
              },
            },
          ],
        }),
      },
    ]);
    const index = buildCommandContributionIndex(contributions);
    assert.equal(index.has('indexed'), true);
    assert.equal(called, false, 'load() must not be called at index-build time');
  });
});
