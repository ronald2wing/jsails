import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createServiceRegistry,
  createServiceToken,
  runExtensions,
  ServiceRegistryError,
  type HttpExtensionHook,
  type JsailsExtension,
  type ServiceRegistrar,
} from '../src/extensions/index.js';
import type { CliCommand } from '../src/cli/commands.js';

/**
 * Tests for the extension foundation. They exercise the registry, the ordered
 * setup/failure lifecycle, sealing, idempotent close, hook collection, and the
 * absence of any ORM/HTTP runtime import. No service or network is involved.
 */

/** Capture the `ServiceRegistryError` thrown by `fn`, asserting its code. */
function registryError(fn: () => unknown, code: ServiceRegistryError['code']): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(
      error instanceof ServiceRegistryError,
      `expected ServiceRegistryError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return true;
  });
}

describe('service tokens and registry', () => {
  it('returns an opaque typed identity that is not frozen', () => {
    const token = createServiceToken<{ port: number }>('database');
    const controller = createServiceRegistry();
    const value = { port: 5432 };

    controller.registrar.provide(token, value);

    // Compile-time check: `get` returns the token's value type.
    const resolved: { port: number } = controller.services.get(token);
    assert.equal(resolved, value);
    assert.equal(controller.services.has(token), true);

    // Values are handed back by reference, never frozen.
    resolved.port = 6000;
    assert.equal(controller.services.get(token).port, 6000);
  });

  it('treats tokens with the same name as distinct identities', () => {
    const primary = createServiceToken<string>('shared');
    const other = createServiceToken<string>('shared');
    const controller = createServiceRegistry();

    controller.registrar.provide(primary, 'a');

    assert.equal(controller.services.has(other), false);
    assert.equal(controller.services.tryGet(other), undefined);
    registryError(() => controller.services.get(other), 'not_found');
  });

  it('rejects a duplicate provide of the same token', () => {
    const token = createServiceToken<number>('count');
    const controller = createServiceRegistry();

    controller.registrar.provide(token, 1);

    registryError(() => controller.registrar.provide(token, 2), 'duplicate');
    assert.equal(controller.services.get(token), 1);
  });

  it('keeps registries isolated per app', () => {
    const token = createServiceToken<string>('config');
    const first = createServiceRegistry();
    const second = createServiceRegistry();

    first.registrar.provide(token, 'one');

    assert.equal(first.services.get(token), 'one');
    assert.equal(second.services.has(token), false);
  });
});

describe('runExtensions lifecycle', () => {
  it('checks requirements against services registered by earlier extensions', async () => {
    const answer = createServiceToken<number>('answer');
    const seen: number[] = [];

    const runtime = await runExtensions([
      {
        name: 'provider',
        setup: ({ services }) => {
          services.provide(answer, 42);
        },
      },
      {
        name: 'consumer',
        requires: [answer],
        setup: ({ services }) => {
          seen.push(services.get(answer));
        },
      },
    ]);

    assert.deepEqual(seen, [42]);
    assert.equal(runtime.services.get(answer), 42);
    await runtime.close();
  });

  it('fails when a requirement is not registered before the extension', async () => {
    const answer = createServiceToken<number>('answer');

    await assert.rejects(
      runExtensions([
        { name: 'consumer', requires: [answer], setup: () => {} },
        {
          name: 'provider',
          setup: ({ services }) => {
            services.provide(answer, 42);
          },
        },
      ]),
      /requires service "answer" which is not registered/,
    );
  });

  it('rejects duplicate names and malformed setup before any side effect', async () => {
    let ran = false;

    await assert.rejects(
      runExtensions([
        {
          name: 'dup',
          setup: () => {
            ran = true;
          },
        },
        {
          name: 'dup',
          setup: () => {
            ran = true;
          },
        },
      ]),
      /duplicate extension name "dup"/,
    );
    assert.equal(ran, false);

    await assert.rejects(
      runExtensions([{ name: 'bad', setup: undefined as unknown as () => void }]),
      /must define a setup function/,
    );
    assert.equal(ran, false);
  });

  it('cleans up completed extensions in reverse and aggregates errors', async () => {
    const order: string[] = [];
    const primary = new Error('setup failed');

    await assert.rejects(
      runExtensions([
        {
          name: 'first',
          setup: () => () => {
            order.push('first');
          },
        },
        {
          name: 'second',
          setup: () => () => {
            order.push('second');
            throw new Error('cleanup failed');
          },
        },
        {
          name: 'third',
          setup: () => {
            throw primary;
          },
        },
      ]),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], primary);
        assert.equal(error.cause, primary);
        assert.equal((error.errors[1] as Error).message, 'cleanup failed');
        return true;
      },
    );

    assert.deepEqual(order, ['second', 'first']);
  });

  it('clears the registry on failure even when cleanup throws', async () => {
    const token = createServiceToken<string>('leaked');
    const late = createServiceToken<string>('late');
    let leaked: ServiceRegistrar | undefined;

    await assert.rejects(
      runExtensions([
        {
          name: 'first',
          setup: ({ services }) => {
            leaked = services;
            services.provide(token, 'value');
            return () => {
              throw new Error('cleanup failed');
            };
          },
        },
        {
          name: 'second',
          setup: () => {
            throw new Error('boom');
          },
        },
      ]),
      AggregateError,
    );

    const registrar = leaked;
    assert.ok(registrar);
    registryError(() => registrar.provide(late, 'value'), 'closed');
  });
});

describe('runExtensions sealing and close', () => {
  it('seals the registry after setup so a leaked registrar cannot provide', async () => {
    const early = createServiceToken<string>('early');
    const late = createServiceToken<string>('late');
    let leaked: ServiceRegistrar | undefined;

    const runtime = await runExtensions([
      {
        name: 'app',
        setup: ({ services }) => {
          leaked = services;
          services.provide(early, 'ok');
        },
      },
    ]);

    assert.equal(runtime.services.get(early), 'ok');
    const registrar = leaked;
    assert.ok(registrar);
    registryError(() => registrar.provide(late, 'nope'), 'sealed');

    await runtime.close();
    registryError(() => registrar.provide(late, 'nope'), 'closed');
  });

  it('makes registry reads fail after close', async () => {
    const token = createServiceToken<number>('gone');
    const runtime = await runExtensions([
      { name: 'app', setup: ({ services }) => services.provide(token, 1) },
    ]);

    await runtime.close();

    registryError(() => runtime.services.has(token), 'closed');
    registryError(() => runtime.services.tryGet(token), 'closed');
    registryError(() => runtime.services.get(token), 'closed');
  });

  it('closes idempotently and shares one promise across concurrent callers', async () => {
    let cleanups = 0;
    const runtime = await runExtensions([
      {
        name: 'app',
        setup: () => () => {
          cleanups += 1;
        },
      },
    ]);

    const first = runtime.close();
    const second = runtime.close();
    assert.equal(first, second);
    await Promise.all([first, second]);
    await runtime.close();

    assert.equal(cleanups, 1);
  });

  it('runs every cleanup before clearing, even when one throws', async () => {
    const order: string[] = [];
    const runtime = await runExtensions([
      {
        name: 'first',
        setup: () => () => {
          order.push('first');
        },
      },
      {
        name: 'second',
        setup: () => () => {
          order.push('second');
          throw new Error('cleanup failed');
        },
      },
    ]);

    await assert.rejects(runtime.close(), /cleanup failed/);
    assert.deepEqual(order, ['second', 'first']);
  });
});

describe('runExtensions http hooks', () => {
  it('collects hooks in setup order, never invokes them, and closes registration', async () => {
    const calls: string[] = [];
    let leakedConfigure: ((hook: HttpExtensionHook) => void) | undefined;

    const runtime = await runExtensions([
      {
        name: 'first',
        setup: ({ configureHttp }) => {
          configureHttp(() => {
            calls.push('first');
          });
        },
      },
      {
        name: 'second',
        setup: ({ configureHttp }) => {
          leakedConfigure = configureHttp;
          configureHttp(async () => {
            calls.push('second');
          });
        },
      },
    ]);

    assert.equal(runtime.httpHooks.length, 2);
    assert.deepEqual(calls, []);

    const configure = leakedConfigure;
    assert.ok(configure);
    assert.throws(() => configure(() => {}), /during extension setup/);

    await runtime.close();
  });
});

describe('extension entry point imports', () => {
  it('compiled extension modules import no ORM, HTTP, or CLI runtime', async () => {
    const dir = fileURLToPath(new URL('../src/extensions/', import.meta.url));
    const files = (await readdir(dir)).filter((file) => file.endsWith('.js')).sort();

    assert.ok(files.includes('index.js'), 'expected compiled index.js');
    for (const file of files) {
      const source = await readFile(join(dir, file), 'utf8');
      assert.equal(
        /from\s+['"](hono|typeorm)['"]/.test(source),
        false,
        `${file} must not import hono or typeorm at runtime`,
      );
      assert.equal(
        /from\s+['"]\.\.\/cli\//.test(source),
        false,
        `${file} must not import the CLI at runtime`,
      );
    }
  });
});

describe('extension commands metadata', () => {
  it('ignores an extension commands list: no validation and no handler invocation', async () => {
    let setupCalls = 0;
    let runCalls = 0;
    const command: CliCommand = {
      name: 'ext-cmd',
      summary: 'an extension command',
      run: () => {
        runCalls += 1;
        return 0;
      },
    };

    const runtime = await runExtensions([
      {
        name: 'with-commands',
        commands: [command],
        setup: () => {
          setupCalls += 1;
        },
      },
    ]);

    assert.equal(setupCalls, 1);
    assert.equal(runCalls, 0);
    assert.deepEqual(runtime.httpHooks, []);
    await runtime.close();
  });

  it('does not inspect or reject a malformed commands list at runtime', async () => {
    let setupCalls = 0;
    const runtime = await runExtensions([
      {
        name: 'bad-commands',
        commands: [null, 42] as unknown as readonly CliCommand[],
        setup: () => {
          setupCalls += 1;
        },
      },
    ]);

    assert.equal(setupCalls, 1);
    await runtime.close();
  });

  it('leaves an extension without commands unchanged', async () => {
    const token = createServiceToken<string>('value');
    const runtime = await runExtensions([
      {
        name: 'plain',
        setup: ({ services }) => {
          services.provide(token, 'ok');
        },
      },
    ]);

    assert.equal(runtime.services.get(token), 'ok');
    await runtime.close();
  });
});

/** Compile-time guard: the exported extension shape stays usable. */
const _extensionShape: JsailsExtension = { name: 'noop', setup: () => {} };
void _extensionShape;
