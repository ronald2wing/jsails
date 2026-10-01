import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CliCommandError,
  DEFAULT_RESERVED_COMMAND_NAMES,
  collectConfigCommands,
  createCliCommandRegistry,
  type CliCommand,
  type CliCommandContext,
  type CommandAudience,
} from '../src/cli/commands.js';

/**
 * Tests for the user-defined CLI command foundation. They cover raw argument
 * pass-through, exit-code validation, serializable metadata, method `this`,
 * structural config collection without any `setup`/handler execution, and
 * duplicate/reserved rejection across app and extension sources. No config
 * module is imported and no process/global state is touched.
 */

interface CapturedContext {
  readonly ctx: CliCommandContext;
  readonly out: string[];
  readonly err: string[];
}

function captureContext(): CapturedContext {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ctx: {
      configPath: '/tmp/jsails.app.js',
      cwd: '/tmp',
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
    out,
    err,
  };
}

/** A valid single-command shape for reuse. */
function command(overrides: Partial<CliCommand> = {}): CliCommand {
  return {
    name: 'hello',
    summary: 'say hello',
    run: () => 0,
    ...overrides,
  };
}

/** Assert `fn` throws a `CliCommandError` with the given code. */
function commandError(fn: () => unknown, code: CliCommandError['code']): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CliCommandError, `expected CliCommandError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

class GreeterCommand implements CliCommand {
  readonly name = 'greet';
  readonly summary = 'greet someone';
  readonly usage = 'greet <name>';

  constructor(private readonly prefix: string) {}

  async run(rawArgs: readonly string[], ctx: CliCommandContext): Promise<number> {
    ctx.stdout(`${this.prefix}:${rawArgs[0] ?? ''}`);
    return 0;
  }
}

describe('createCliCommandRegistry', () => {
  it('passes raw argument tokens, including unknown flags, straight to the command', async () => {
    const seen: string[][] = [];
    const registry = createCliCommandRegistry([
      command({
        async run(rawArgs, ctx) {
          seen.push([...rawArgs]);
          ctx.stdout(`hello ${rawArgs.join(' ')}`);
        },
      }),
    ]);
    const { ctx, out } = captureContext();

    const code = await registry.run('hello', ['--unknown', 'world', '-x'], ctx);

    assert.equal(code, 0);
    assert.deepEqual(seen, [['--unknown', 'world', '-x']]);
    assert.deepEqual(out, ['hello --unknown world -x']);
  });

  it('treats a void return as exit code 0', async () => {
    const registry = createCliCommandRegistry([command({ run: () => {} })]);
    const { ctx } = captureContext();

    assert.equal(await registry.run('hello', [], ctx), 0);
  });

  it('accepts every exit code in 0..255', async () => {
    for (const code of [0, 1, 42, 255]) {
      const registry = createCliCommandRegistry([command({ run: () => code })]);
      const { ctx } = captureContext();
      assert.equal(await registry.run('hello', [], ctx), code);
    }
  });

  it('rejects out-of-range, fractional, non-numeric, and truthy non-number returns', async () => {
    const invalid: unknown[] = [
      -1,
      256,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '0',
      true,
      false,
      null,
    ];
    for (const value of invalid) {
      const registry = createCliCommandRegistry([command({ run: () => value as number })]);
      const { ctx } = captureContext();
      await assert.rejects(
        registry.run('hello', [], ctx),
        (error: unknown) => {
          assert.ok(error instanceof CliCommandError);
          assert.equal(error.code, 'invalid_exit_code');
          return true;
        },
        `expected ${String(value)} to be rejected`,
      );
    }
  });

  it('rejects async commands that resolve to an invalid exit code', async () => {
    const registry = createCliCommandRegistry([command({ run: async () => 300 })]);
    const { ctx } = captureContext();

    await assert.rejects(registry.run('hello', [], ctx), (error: unknown) => {
      assert.ok(error instanceof CliCommandError);
      assert.equal(error.code, 'invalid_exit_code');
      return true;
    });
  });

  it('rejects an unknown command without invoking anything', async () => {
    const registry = createCliCommandRegistry([command()]);
    const { ctx } = captureContext();

    await assert.rejects(registry.run('nope', [], ctx), (error: unknown) => {
      assert.ok(error instanceof CliCommandError);
      assert.equal(error.code, 'unknown_command');
      return true;
    });
    assert.equal(registry.has('nope'), false);
    assert.equal(registry.get('nope'), undefined);
  });

  it('validates every command before returning the registry', () => {
    let ran = false;
    const first = command({
      run: () => {
        ran = true;
        return 0;
      },
    });
    const second = { name: 'broken', summary: 'no run' } as unknown as CliCommand;

    commandError(() => createCliCommandRegistry([first, second]), 'invalid_command');
    assert.equal(ran, false);
  });

  it('lists serializable metadata in declaration order without function references', () => {
    const registry = createCliCommandRegistry([
      command({ name: 'alpha', summary: 'first' }),
      command({ name: 'beta', summary: 'second', usage: 'beta [flags]' }),
    ]);

    const metadata = registry.list();
    assert.deepEqual(metadata, [
      { name: 'alpha', summary: 'first', audience: 'developer' },
      { name: 'beta', summary: 'second', usage: 'beta [flags]', audience: 'developer' },
    ]);
    for (const entry of metadata) {
      assert.equal('run' in entry, false);
      assert.equal(typeof (entry as unknown as Record<string, unknown>).run, 'undefined');
    }
  });

  it('resolves a command audience to the developer default when unspecified', () => {
    const registry = createCliCommandRegistry([command({ name: 'alpha' })]);

    assert.deepEqual(registry.list(), [
      { name: 'alpha', summary: 'say hello', audience: 'developer' },
    ]);
  });

  it('preserves an explicit audience over the developer default', () => {
    const registry = createCliCommandRegistry([command({ name: 'alpha', audience: 'user' })]);

    assert.deepEqual(registry.list(), [{ name: 'alpha', summary: 'say hello', audience: 'user' }]);
  });

  it('applies a caller defaultAudience to commands without an explicit audience', () => {
    const registry = createCliCommandRegistry(
      [command({ name: 'alpha' }), command({ name: 'beta', audience: 'developer' })],
      { defaultAudience: 'user' },
    );

    assert.deepEqual(
      registry.list().map((entry) => entry.audience),
      ['user', 'developer'],
    );
  });

  it('rejects an invalid audience without echoing the value', () => {
    assert.throws(
      () =>
        createCliCommandRegistry([
          command({ name: 'alpha', audience: 'admin' as CommandAudience }),
        ]),
      (error: unknown) => {
        assert.ok(error instanceof CliCommandError);
        assert.equal(error.code, 'invalid_audience');
        assert.equal(error.message.includes('admin'), false);
        return true;
      },
    );
  });

  it('rejects an invalid defaultAudience without echoing the value', () => {
    assert.throws(
      () => createCliCommandRegistry([command()], { defaultAudience: 'admin' as CommandAudience }),
      (error: unknown) => {
        assert.ok(error instanceof CliCommandError);
        assert.equal(error.code, 'invalid_audience');
        assert.equal(error.message.includes('admin'), false);
        return true;
      },
    );
  });

  it('preserves command identity and method this through get and run', async () => {
    const greeter = new GreeterCommand('hi');
    const registry = createCliCommandRegistry([greeter]);
    const { ctx, out } = captureContext();

    assert.equal(registry.get('greet'), greeter);
    assert.equal(registry.has('greet'), true);
    assert.equal(await registry.run('greet', ['bob'], ctx), 0);
    assert.deepEqual(out, ['hi:bob']);
    assert.deepEqual(registry.list(), [
      { name: 'greet', summary: 'greet someone', usage: 'greet <name>', audience: 'developer' },
    ]);
  });

  it('rejects duplicate names', () => {
    commandError(() => createCliCommandRegistry([command(), command()]), 'duplicate_name');
  });

  it('rejects reserved names, including the builtins by default', () => {
    for (const name of DEFAULT_RESERVED_COMMAND_NAMES) {
      commandError(() => createCliCommandRegistry([command({ name })]), 'reserved_name');
    }
  });

  it('reserves the jamal builtin command name', () => {
    assert.ok(DEFAULT_RESERVED_COMMAND_NAMES.includes('jamal'));
    commandError(() => createCliCommandRegistry([command({ name: 'jamal' })]), 'reserved_name');
  });

  it('merges caller reserved names with the builtin defaults', () => {
    commandError(
      () => createCliCommandRegistry([command({ name: 'deploy' })], { reservedNames: ['deploy'] }),
      'reserved_name',
    );
    // The builtin defaults still apply even when a caller list is provided.
    commandError(
      () => createCliCommandRegistry([command({ name: 'serve' })], { reservedNames: ['deploy'] }),
      'reserved_name',
    );
    commandError(() => createCliCommandRegistry([], { reservedNames: [''] }), 'invalid_config');
  });

  it('rejects empty, whitespace, flag-like, and malformed names', () => {
    for (const name of ['', '   ', '--help', 'has space', 'a/b', 7]) {
      commandError(
        () => createCliCommandRegistry([command({ name: name as string })]),
        'invalid_name',
      );
    }
  });

  it('rejects a missing run, empty summary, and non-string usage', () => {
    commandError(
      () => createCliCommandRegistry([command({ run: undefined as unknown as CliCommand['run'] })]),
      'invalid_command',
    );
    commandError(() => createCliCommandRegistry([command({ summary: '   ' })]), 'invalid_command');
    commandError(
      () => createCliCommandRegistry([command({ usage: 7 as unknown as string })]),
      'invalid_command',
    );
  });

  it('rejects a non-array commands argument', () => {
    commandError(
      () => createCliCommandRegistry(null as unknown as readonly CliCommand[]),
      'invalid_command',
    );
  });
});

describe('collectConfigCommands', () => {
  it('reads app commands in declaration order', () => {
    const alpha = command({ name: 'alpha' });
    const beta = command({ name: 'beta' });

    assert.deepEqual(collectConfigCommands({ commands: [alpha, beta] }), [alpha, beta]);
  });

  it('preserves an explicit audience on collected commands', () => {
    const alpha = command({ name: 'alpha', audience: 'user' });

    const collected = collectConfigCommands({ commands: [alpha] });

    assert.equal(collected.length, 1);
    assert.equal(collected[0], alpha);
    assert.equal(collected[0]?.audience, 'user');
  });

  it('leaves a command without an explicit audience unresolved', () => {
    const collected = collectConfigCommands({ commands: [command()] });

    assert.equal('audience' in (collected[0] as CliCommand), false);
  });

  it('rejects an invalid audience declared in config without echoing the value', () => {
    assert.throws(
      () =>
        collectConfigCommands({
          commands: [command({ name: 'alpha', audience: 'admin' as CommandAudience })],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CliCommandError);
        assert.equal(error.code, 'invalid_audience');
        assert.equal(error.message.includes('admin'), false);
        return true;
      },
    );
  });

  it('flattens app and extension commands without invoking setup', () => {
    const appCommand = command({ name: 'app-cmd' });
    const extCommand = command({ name: 'ext-cmd' });
    let setupCalls = 0;

    const collected = collectConfigCommands({
      commands: [appCommand],
      extensions: [
        {
          name: 'one',
          setup: () => {
            setupCalls += 1;
          },
        },
        {
          name: 'two',
          setup: () => {
            setupCalls += 1;
          },
          commands: [extCommand],
        },
      ],
    });

    assert.deepEqual(collected, [appCommand, extCommand]);
    assert.equal(setupCalls, 0);
  });

  it('returns no commands when neither source declares any', () => {
    assert.deepEqual(collectConfigCommands({}), []);
    assert.deepEqual(collectConfigCommands({ commands: [], extensions: [] }), []);
    assert.deepEqual(collectConfigCommands({ extensions: [{ name: 'x' }] }), []);
  });

  it('ignores unrelated config fields', () => {
    const only = command({ name: 'only' });
    const collected = collectConfigCommands({ rootDir: '.', port: 3000, commands: [only] });
    assert.deepEqual(collected, [only]);
  });

  it('detects duplicates across app and extension sources through the registry', () => {
    const collected = collectConfigCommands({
      commands: [command({ name: 'shared' })],
      extensions: [{ name: 'ext', commands: [command({ name: 'shared' })] }],
    });

    commandError(() => createCliCommandRegistry(collected), 'duplicate_name');
  });

  it('rejects a reserved name declared by an extension', () => {
    const collected = collectConfigCommands({
      extensions: [{ name: 'ext', commands: [command({ name: 'serve' })] }],
    });

    commandError(() => createCliCommandRegistry(collected), 'reserved_name');
  });

  it('rejects malformed config shapes', () => {
    commandError(() => collectConfigCommands(null), 'invalid_config');
    commandError(() => collectConfigCommands('nope'), 'invalid_config');
    commandError(() => collectConfigCommands({ commands: {} }), 'invalid_config');
    commandError(() => collectConfigCommands({ extensions: {} }), 'invalid_config');
    commandError(() => collectConfigCommands({ extensions: [null] }), 'invalid_config');
    commandError(() => collectConfigCommands({ extensions: [{ commands: {} }] }), 'invalid_config');
    commandError(
      () => collectConfigCommands({ commands: [{ name: 'x', summary: 'x' }] }),
      'invalid_command',
    );
    commandError(
      () => collectConfigCommands({ commands: [{ name: 'bad name', summary: 'x', run: () => 0 }] }),
      'invalid_name',
    );
  });

  it('does not echo values from throwing getters', () => {
    const secret = 'sk-live-super-secret-token';

    const throwingCommands = {
      get commands(): unknown {
        throw new Error(`leaked ${secret}`);
      },
    };
    assert.throws(
      () => collectConfigCommands(throwingCommands),
      (error: unknown) => {
        assert.ok(error instanceof CliCommandError);
        assert.equal(error.code, 'invalid_config');
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );

    const throwingExtension = {
      extensions: [
        {
          get commands(): unknown {
            throw new Error(`leaked ${secret}`);
          },
        },
      ],
    };
    assert.throws(
      () => collectConfigCommands(throwingExtension),
      (error: unknown) => {
        assert.ok(error instanceof CliCommandError);
        assert.equal(error.code, 'invalid_config');
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );

    const throwingName = {
      commands: [
        {
          get name(): unknown {
            throw new Error(`leaked ${secret}`);
          },
        },
      ],
    };
    assert.throws(
      () => collectConfigCommands(throwingName),
      (error: unknown) => {
        assert.ok(error instanceof CliCommandError);
        assert.equal(error.code, 'invalid_config');
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  });

  it('does not invoke command handlers while collecting', () => {
    let invoked = 0;
    const collected = collectConfigCommands({
      commands: [
        command({
          run: () => {
            invoked += 1;
            return 0;
          },
        }),
      ],
    });

    assert.equal(collected.length, 1);
    assert.equal(invoked, 0);
  });
});
