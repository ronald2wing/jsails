import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  createPrompter,
  defineCommand,
  parseSignature,
  renderSignatureUsage,
  SignatureError,
  type ParsedCommandInput,
  type Prompter,
} from '../../src/cli/signature-commands.js';
import type { CliCommandContext, CommandAudience } from '../../src/cli/command-registry.js';

/**
 * Tests for the Laravel Zero-style command kit: the signature DSL parser
 * (required/optional/default arguments, boolean flags, value options, and
 * malformed signatures), `defineCommand` argument parsing and prompter
 * injection, and the `node:readline/promises`-backed prompter.
 */

function context(): CliCommandContext {
  return {
    configPath: '/tmp/jsails.app.js',
    cwd: '/tmp',
    stdout: () => {},
    stderr: () => {},
  };
}

function signatureError(fn: () => unknown): void {
  assert.throws(fn, SignatureError);
}

describe('parseSignature', () => {
  it('parses a required argument', () => {
    assert.deepEqual(parseSignature('hello {name}'), {
      name: 'hello',
      arguments: [{ name: 'name', required: true, defaultValue: undefined }],
      options: [],
    });
  });

  it('parses an optional argument', () => {
    assert.deepEqual(parseSignature('hello {name?}'), {
      name: 'hello',
      arguments: [{ name: 'name', required: false, defaultValue: undefined }],
      options: [],
    });
  });

  it('parses an argument with a default', () => {
    assert.deepEqual(parseSignature('hello {name=world}'), {
      name: 'hello',
      arguments: [{ name: 'name', required: false, defaultValue: 'world' }],
      options: [],
    });
  });

  it('parses a boolean flag', () => {
    assert.deepEqual(parseSignature('mail {--force}'), {
      name: 'mail',
      arguments: [],
      options: [{ name: 'force', takesValue: false, defaultValue: undefined }],
    });
  });

  it('parses a value option without a default', () => {
    assert.deepEqual(parseSignature('mail {--queue=}'), {
      name: 'mail',
      arguments: [],
      options: [{ name: 'queue', takesValue: true, defaultValue: undefined }],
    });
  });

  it('parses a value option with a default', () => {
    assert.deepEqual(parseSignature('mail {--queue=default}'), {
      name: 'mail',
      arguments: [],
      options: [{ name: 'queue', takesValue: true, defaultValue: 'default' }],
    });
  });

  it('accepts a namespaced command name and mixed tokens in order', () => {
    const parsed = parseSignature('make:user {name} {email?} {--admin} {--role=member}');
    assert.equal(parsed.name, 'make:user');
    assert.deepEqual(parsed.arguments, [
      { name: 'name', required: true, defaultValue: undefined },
      { name: 'email', required: false, defaultValue: undefined },
    ]);
    assert.deepEqual(parsed.options, [
      { name: 'admin', takesValue: false, defaultValue: undefined },
      { name: 'role', takesValue: true, defaultValue: 'member' },
    ]);
  });

  it('rejects malformed signatures', () => {
    for (const signature of [
      '',
      '   ',
      'hello name',
      'hello {}',
      'hello {name} {name}',
      'hello {--x} {x}',
      'hello {--force} {name}',
      'hello {na me}',
      'hello {--}',
      'hello {name=}',
      'hello {1name}',
      'hello {name?=x}',
    ]) {
      signatureError(() => parseSignature(signature));
    }
  });

  it('rejects a non-string signature', () => {
    signatureError(() => parseSignature(42 as unknown as string));
    signatureError(() => parseSignature(null as unknown as string));
  });

  it('rejects an invalid command name', () => {
    signatureError(() => parseSignature('123 {name}'));
    signatureError(() => parseSignature('has space {name}'));
  });
});

describe('renderSignatureUsage', () => {
  it('renders required, optional, flag, and option tokens', () => {
    assert.equal(
      renderSignatureUsage(parseSignature('hello {name} {email?} {--force} {--queue=}')),
      'hello name [email] [--force] [--queue=]',
    );
  });

  it('renders defaults inline', () => {
    assert.equal(
      renderSignatureUsage(parseSignature('send {to=alice} {--subject=hello}')),
      'send [to=alice] [--subject=hello]',
    );
  });
});

describe('defineCommand', () => {
  it('derives name, summary, and usage from the signature', () => {
    const command = defineCommand({ signature: 'greet {name}', run: () => 0 });
    assert.equal(command.name, 'greet');
    assert.equal(command.summary, 'greet');
    assert.equal(command.usage, 'greet name');
  });

  it('honors an explicit summary and usage', () => {
    const command = defineCommand({
      signature: 'greet {name}',
      summary: 'greet someone',
      usage: 'greet <name>',
      run: () => 0,
    });
    assert.equal(command.summary, 'greet someone');
    assert.equal(command.usage, 'greet <name>');
  });

  it('passes an explicit audience through to the command', () => {
    const command = defineCommand({ signature: 'greet {name}', audience: 'user', run: () => 0 });
    assert.equal(command.audience, 'user');
  });

  it('omits the audience when not specified', () => {
    const command = defineCommand({ signature: 'greet {name}', run: () => 0 });
    assert.equal('audience' in command, false);
  });

  it('rejects an invalid audience without echoing the value', () => {
    assert.throws(
      () =>
        defineCommand({
          signature: 'greet {name}',
          audience: 'admin' as CommandAudience,
          run: () => 0,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SignatureError);
        assert.equal(error.message.includes('admin'), false);
        return true;
      },
    );
  });

  it('parses raw args into typed arguments/options and keeps the raw tokens', async () => {
    const seen: ParsedCommandInput[] = [];
    const command = defineCommand({
      signature: 'greet {name} {title?} {--loud}',
      run(input) {
        seen.push(input);
        return 0;
      },
    });

    const code = await command.run(['bob', '--loud'], context());

    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.arguments, { name: 'bob', title: undefined });
    assert.deepEqual(seen[0]?.options, { loud: true });
    assert.deepEqual(seen[0]?.rawArgs, ['bob', '--loud']);
  });

  it('applies argument and option defaults when absent', async () => {
    const seen: ParsedCommandInput[] = [];
    const command = defineCommand({
      signature: 'send {to=alice} {--subject=hello}',
      run(input) {
        seen.push(input);
        return 0;
      },
    });
    const ctx = context();

    await command.run([], ctx);
    assert.deepEqual(seen[0]?.arguments, { to: 'alice' });
    assert.deepEqual(seen[0]?.options, { subject: 'hello' });

    await command.run(['bob', '--subject=urgent'], ctx);
    assert.deepEqual(seen[1]?.arguments, { to: 'bob' });
    assert.deepEqual(seen[1]?.options, { subject: 'urgent' });
  });

  it('accepts both --opt=value and --opt value for value options', async () => {
    const seen: ParsedCommandInput[] = [];
    const command = defineCommand({
      signature: 'mail {--to=}',
      run(input) {
        seen.push(input);
        return 0;
      },
    });
    const ctx = context();

    await command.run(['--to=x@y'], ctx);
    await command.run(['--to', 'x@y'], ctx);

    assert.equal(seen[0]?.options.to, 'x@y');
    assert.equal(seen[1]?.options.to, 'x@y');
  });

  it('maps an absent flag to undefined and a present flag to true', async () => {
    const seen: ParsedCommandInput[] = [];
    const command = defineCommand({
      signature: 'deploy {--force}',
      run(input) {
        seen.push(input);
        return 0;
      },
    });
    const ctx = context();

    await command.run([], ctx);
    assert.deepEqual(seen[0]?.options, { force: undefined });

    await command.run(['--force'], ctx);
    assert.deepEqual(seen[1]?.options, { force: true });
  });

  it('rejects unknown options, extra arguments, missing required arguments, and flag values', async () => {
    const command = defineCommand({
      signature: 'greet {name} {--loud}',
      run: () => 0,
    });
    const ctx = context();

    await assert.rejects(async () => command.run([], ctx), /missing required argument "name"/);
    await assert.rejects(async () => command.run(['a', 'b'], ctx), /unexpected argument/);
    await assert.rejects(
      async () => command.run(['a', '--bogus'], ctx),
      /unknown option "--bogus"/,
    );
    await assert.rejects(
      async () => command.run(['a', '--loud=yes'], ctx),
      /flag "--loud" does not accept a value/,
    );
    await assert.rejects(async () => command.run(['--'], ctx), /missing required argument/);
  });

  it('injects the configured prompter and forwards parsed input to the handler', async () => {
    const fakePrompter: Prompter = {
      async text() {
        return '';
      },
      async confirm() {
        return false;
      },
      async select<T extends string>(_message: string, choices: readonly T[]) {
        return choices[0] as T;
      },
    };
    let receivedInput: ParsedCommandInput | undefined;
    let receivedPrompter: Prompter | undefined;

    const command = defineCommand({
      signature: 'greet {name} {--loud}',
      prompter: fakePrompter,
      run(input, ctx) {
        receivedInput = input;
        receivedPrompter = ctx.prompter;
        return 7;
      },
    });

    const code = await command.run(['bob', '--loud'], context());

    assert.equal(code, 7);
    assert.equal(receivedPrompter, fakePrompter);
    assert.deepEqual(receivedInput?.arguments, { name: 'bob' });
    assert.deepEqual(receivedInput?.options, { loud: true });
  });

  it('returns a CliCommand-compatible object usable through the registry', async () => {
    const { createCliCommandRegistry } = await import('../../src/cli/command-registry.js');
    const command = defineCommand({
      signature: 'greet {name}',
      run(input, ctx) {
        ctx.stdout(`hi ${input.arguments.name}`);
        return 0;
      },
    });
    const out: string[] = [];
    const registry = createCliCommandRegistry([command]);

    const code = await registry.run('greet', ['bob'], {
      ...context(),
      stdout: (text) => out.push(text),
    });

    assert.equal(code, 0);
    assert.deepEqual(out, ['hi bob']);
  });
});

describe('createPrompter', () => {
  it('reads text, confirm, and select from injected streams', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    let written = '';
    output.on('data', (chunk: string) => {
      written += chunk;
    });
    const prompter = createPrompter(input, output);

    // Each prompt attaches its line listener synchronously, so write the answer
    // after invoking the method (not before) to avoid dropping the line.
    const name = prompter.text('Name?');
    input.write('Alice\n');
    assert.equal(await name, 'Alice');

    const nickname = prompter.text('Nickname?', { default: 'Al' });
    input.write('\n');
    assert.equal(await nickname, 'Al');

    const confirm = prompter.confirm('Continue?');
    input.write('y\n');
    assert.equal(await confirm, true);

    const pick = prompter.select('Pick', ['a', 'b', 'c'] as const);
    input.write('2\n');
    assert.equal(await pick, 'b');

    prompter.close();
    assert.match(written, /Name\?: /);
  });
});
