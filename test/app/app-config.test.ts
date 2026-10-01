import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  DEFAULT_APP_HOST,
  DEFAULT_APP_PORT,
  DEFAULT_HEALTH_PATH,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  loadAppConfig,
  MAX_SHUTDOWN_TIMEOUT_MS,
  validateAppConfig,
  type ResolvedAppConfig,
} from '../../src/app/config/index.js';
import type { BroadcastAdapter, BroadcastOptions } from '../../src/broadcast/server.js';
import {
  collectConfigCommands,
  createCliCommandRegistry,
  type CliCommand,
  type CliCommandContext,
} from '../../src/cli/command-registry.js';
import { DEFAULT_MAX_BODY_BYTES } from '../../src/server/app.js';
import { defineDeploymentGenerator } from '../../src/deploy/registry.js';

/**
 * Tests for the application config loader. Config modules are written under the
 * project tree (not `os.tmpdir()`) so they inherit `"type": "module"` and load
 * as ESM. No test connects to a service, creates a directory for the resolved
 * config, or invokes a callback.
 */

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'app-config-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string, filename = DEFAULT_APP_CONFIG_PATH): string {
  const path = join(dir, filename);
  writeFileSync(path, content);
  return path;
}

/** Narrow a resolved config's built-in (non-adapter) broadcast to its options. */
function builtinBroadcast(resolved: ResolvedAppConfig): BroadcastOptions {
  const broadcast = resolved.broadcast;
  assert.ok(broadcast !== undefined, 'expected broadcast to be configured');
  assert.ok(!('adapter' in broadcast), 'expected the built-in broadcast form');
  return broadcast;
}

// ---------------------------------------------------------------------------
// loadAppConfig: import + resolution
// ---------------------------------------------------------------------------

describe('loadAppConfig', () => {
  it('loads jsails.app.js by default and resolves dirs from the config directory', async () => {
    const dir = makeDir('defaults');
    writeConfig(dir, `export default { port: 0 };`);

    const resolved = await loadAppConfig(undefined, { cwd: dir });

    assert.equal(resolved.configPath, join(dir, DEFAULT_APP_CONFIG_PATH));
    assert.equal(resolved.rootDir, dir);
    assert.equal(resolved.pagesDir, join(dir, 'pages'));
    assert.equal(resolved.apiDir, join(dir, 'api'));
    assert.equal(resolved.publicDir, join(dir, 'public'));
    assert.equal(resolved.outDir, join(dir, 'out'));
    assert.equal(resolved.host, DEFAULT_APP_HOST);
    assert.deepEqual(resolved.extensions, []);
    assert.equal(resolved.renderer, undefined);
    assert.equal(resolved.port, 0);
    assert.equal(resolved.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
    assert.equal(resolved.publicOrigin, undefined);
    assert.equal(resolved.authorize, undefined);
    assert.equal(resolved.resolveSession, undefined);
    assert.equal(resolved.broadcast, undefined);
    assert.equal(resolved.setup, undefined);
  });

  it('resolves rootDir against the config directory and other dirs against rootDir', async () => {
    const dir = makeDir('nested');
    const sub = makeDir('nested/sub');
    writeConfig(
      sub,
      `export default {
  rootDir: '..',
  pages: 'src/pages',
  api: 'src/api',
  public: 'assets',
  out: 'build',
};`,
    );

    const resolved = await loadAppConfig(join(sub, DEFAULT_APP_CONFIG_PATH));

    assert.equal(resolved.rootDir, dir);
    assert.equal(resolved.pagesDir, join(dir, 'src/pages'));
    assert.equal(resolved.apiDir, join(dir, 'src/api'));
    assert.equal(resolved.publicDir, join(dir, 'assets'));
    assert.equal(resolved.outDir, join(dir, 'build'));
  });

  it('resolves a relative config path against the explicit cwd, not process.cwd()', async () => {
    const a = makeDir('cwd-a');
    const b = makeDir('cwd-b');
    writeConfig(a, `export default { host: '10.0.0.1' };`);
    writeConfig(b, `export default { host: '10.0.0.2' };`);

    const resolved = await loadAppConfig('jsails.app.js', { cwd: b });

    assert.equal(resolved.configPath, join(b, DEFAULT_APP_CONFIG_PATH));
    assert.equal(resolved.rootDir, b);
    assert.equal(resolved.host, '10.0.0.2');
  });

  it('imports a config whose path contains spaces', async () => {
    const dir = makeDir('with space');
    writeConfig(dir, `export default { host: '0.0.0.0' };`);

    const resolved = await loadAppConfig(join(dir, DEFAULT_APP_CONFIG_PATH));

    assert.equal(resolved.configPath, join(dir, DEFAULT_APP_CONFIG_PATH));
    assert.equal(resolved.rootDir, dir);
    assert.equal(resolved.host, '0.0.0.0');
  });

  it('passes setup through without invoking it', async () => {
    const dir = makeDir('setup');
    writeConfig(
      dir,
      `globalThis.__jsailsSetupCalled = false;
export default {
  setup() { globalThis.__jsailsSetupCalled = true; },
};`,
    );

    const resolved = await loadAppConfig(undefined, { cwd: dir });

    assert.equal(typeof resolved.setup, 'function');
    assert.equal(
      (globalThis as Record<string, unknown>).__jsailsSetupCalled,
      false,
      'setup must not run during load',
    );
    delete (globalThis as Record<string, unknown>).__jsailsSetupCalled;
  });

  it('rejects TypeScript config paths with a compile hint', async () => {
    const dir = makeDir('typescript');
    for (const name of ['jsails.app.ts', 'jsails.app.mts', 'jsails.app.cts']) {
      await assert.rejects(loadAppConfig(name, { cwd: dir }), (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /TypeScript module/);
        assert.match(error.message, /compile it to JavaScript first/);
        return true;
      });
    }
  });

  it('does not echo a module exception (or attach a cause) when import fails', async () => {
    const dir = makeDir('throwing-module');
    writeConfig(dir, `throw new Error('supersecret-password');`);

    await assert.rejects(loadAppConfig(undefined, { cwd: dir }), (error: unknown) => {
      assert.ok(error instanceof AppConfigError);
      assert.doesNotMatch(error.message, /supersecret-password/);
      assert.equal(error.cause, undefined);
      return true;
    });
  });

  it('rejects a missing config module without leaking filesystem details', async () => {
    const dir = makeDir('missing-module');
    await assert.rejects(loadAppConfig(undefined, { cwd: dir }), (error: unknown) => {
      assert.ok(error instanceof AppConfigError);
      assert.match(error.message, /failed to load app config/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// validateAppConfig: shape + resolution
// ---------------------------------------------------------------------------

describe('validateAppConfig: shape', () => {
  it('rejects non-object exports', () => {
    for (const value of [undefined, null, 42, 'nope', true, []]) {
      assert.throws(
        () => validateAppConfig(value),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /default-export an object/);
          return true;
        },
      );
    }
  });

  it('rejects unknown top-level fields without echoing their names', () => {
    assert.throws(
      () => validateAppConfig({ nope: 'supersecret-password' }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /unrecognized config field/);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('applies defaults anchored at cwd when no configPath is given', () => {
    const cwd = makeDir('defaults-anchor');
    const resolved = validateAppConfig({}, { cwd });

    assert.equal(resolved.configPath, join(cwd, DEFAULT_APP_CONFIG_PATH));
    assert.equal(resolved.rootDir, cwd);
    assert.equal(resolved.pagesDir, join(cwd, 'pages'));
    assert.equal(resolved.apiDir, join(cwd, 'api'));
    assert.equal(resolved.publicDir, join(cwd, 'public'));
    assert.equal(resolved.outDir, join(cwd, 'out'));
    assert.equal(resolved.host, DEFAULT_APP_HOST);
    assert.equal(resolved.port, DEFAULT_APP_PORT);
    assert.equal(resolved.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  });

  it('anchors rootDir at an explicit relative configPath directory', () => {
    const cwd = makeDir('explicit-anchor');
    const resolved = validateAppConfig(
      { rootDir: 'app', pages: 'views' },
      { configPath: 'configs/jsails.app.js', cwd },
    );

    assert.equal(resolved.configPath, join(cwd, 'configs/jsails.app.js'));
    assert.equal(resolved.rootDir, join(cwd, 'configs', 'app'));
    assert.equal(resolved.pagesDir, join(cwd, 'configs', 'app', 'views'));
  });

  it('keeps absolute directory overrides', () => {
    const cwd = makeDir('absolute-dirs');
    const absolute = makeDir('absolute-dirs/root');
    const resolved = validateAppConfig(
      { rootDir: absolute, out: join(absolute, 'build') },
      { cwd },
    );

    assert.equal(resolved.rootDir, absolute);
    assert.equal(resolved.outDir, join(absolute, 'build'));
  });
});

describe('validateAppConfig: host and port', () => {
  it('preserves port 0 as an explicit ephemeral-port request', () => {
    assert.equal(validateAppConfig({ port: 0 }).port, 0);
  });

  it('rejects invalid ports', () => {
    for (const port of [-1, 65536, 1.5, Number.NaN, '3000']) {
      assert.throws(
        () => validateAppConfig({ port: port as unknown as number }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.port/);
          return true;
        },
      );
    }
  });

  it('rejects invalid hosts and accepts real host forms', () => {
    for (const host of ['', 'has space', 'http://example.com', 'a/b']) {
      assert.throws(
        () => validateAppConfig({ host }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.host/);
          return true;
        },
      );
    }
    for (const host of ['0.0.0.0', 'localhost', '::']) {
      assert.equal(validateAppConfig({ host }).host, host);
    }
  });

  it('rejects invalid body limits', () => {
    for (const maxBodyBytes of [0, -1, 1.5, '1024']) {
      assert.throws(
        () =>
          validateAppConfig({
            maxBodyBytes: maxBodyBytes as unknown as number,
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.maxBodyBytes/);
          return true;
        },
      );
    }
  });
});

describe('validateAppConfig: field semantics', () => {
  it('canonicalizes a valid publicOrigin', () => {
    assert.equal(
      validateAppConfig({ publicOrigin: 'https://Example.com:443' }).publicOrigin,
      'https://example.com',
    );
    assert.equal(
      validateAppConfig({ publicOrigin: 'http://localhost:8080' }).publicOrigin,
      'http://localhost:8080',
    );
  });

  it('rejects non-origin publicOrigin values without echoing credentials', () => {
    for (const publicOrigin of [
      'not a url',
      'ftp://example.com',
      'https://example.com/path',
      'https://example.com?x=1',
      'https://example.com#frag',
    ]) {
      assert.throws(
        () => validateAppConfig({ publicOrigin }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.publicOrigin/);
          return true;
        },
      );
    }

    assert.throws(
      () =>
        validateAppConfig({
          publicOrigin: 'https://user:supersecret-password@example.com',
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /credentials/);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('rejects non-function callbacks', () => {
    for (const [name, value] of [
      ['authorize', 1],
      ['resolveSession', 'x'],
      ['setup', {}],
    ] as const) {
      assert.throws(
        () => validateAppConfig({ [name]: value }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, new RegExp(`config\\.${name} must be a function`));
          return true;
        },
      );
    }
  });
});

// ---------------------------------------------------------------------------
// callback pass-through + immutability
// ---------------------------------------------------------------------------

describe('validateAppConfig: callbacks and immutability', () => {
  it('passes callbacks through by identity and never invokes them', () => {
    let authorizeCalls = 0;
    let sessionCalls = 0;
    let setupCalls = 0;
    const authorize = async (): Promise<boolean> => {
      authorizeCalls += 1;
      return true;
    };
    const resolveSession = async () => {
      sessionCalls += 1;
      return null;
    };
    const setup = (): void => {
      setupCalls += 1;
    };

    const resolved = validateAppConfig({ authorize, resolveSession, setup });

    assert.equal(resolved.authorize, authorize);
    assert.equal(resolved.resolveSession, resolveSession);
    assert.equal(resolved.setup, setup);
    assert.equal(authorizeCalls, 0);
    assert.equal(sessionCalls, 0);
    assert.equal(setupCalls, 0);
  });

  it('does not mutate or freeze the input config', () => {
    const broadcast = {
      allowedOrigins: ['https://example.com'],
      authenticate: () => 'user',
      valkeyUrl: 'redis://127.0.0.1:6379',
    };
    const input = {
      rootDir: '.',
      port: 0,
      publicOrigin: 'https://example.com',
      broadcast,
    };
    const inputKeys = Object.keys(input);
    const broadcastKeys = Object.keys(broadcast);

    const resolved = validateAppConfig(input, { cwd: '/tmp/anchor' });

    assert.deepEqual(Object.keys(input), inputKeys, 'the input must not gain or lose fields');
    assert.deepEqual(Object.keys(broadcast), broadcastKeys, 'broadcast must not be mutated');
    assert.equal(input.rootDir, '.');
    assert.equal(input.port, 0);
    assert.equal(input.publicOrigin, 'https://example.com');
    assert.equal(Object.isFrozen(input), false);
    assert.equal(Object.isFrozen(broadcast), false);
    assert.equal(broadcast.valkeyUrl, 'redis://127.0.0.1:6379');
    assert.equal(builtinBroadcast(resolved).redisUrl, 'redis://127.0.0.1:6379');
  });
});

// ---------------------------------------------------------------------------
// broadcast: alias mapping + no environment fallback
// ---------------------------------------------------------------------------

describe('validateAppConfig: broadcast', () => {
  it('maps the valkeyUrl alias onto redisUrl', () => {
    const resolved = validateAppConfig({
      broadcast: {
        allowedOrigins: ['https://example.com'],
        authenticate: () => 'user',
        valkeyUrl: 'rediss://:pw@host:6380/0',
      },
    });

    assert.equal(builtinBroadcast(resolved).redisUrl, 'rediss://:pw@host:6380/0');
    assert.equal(
      'valkeyUrl' in builtinBroadcast(resolved),
      false,
      'the alias is not carried into the resolved config',
    );
  });

  it('ignores the legacy redisUrl config key', () => {
    const resolved = validateAppConfig({
      broadcast: {
        allowedOrigins: ['https://example.com'],
        authenticate: () => 'user',
        valkeyUrl: 'redis://a:6379',
        redisUrl: 'redis://b:6379',
      },
    });
    assert.equal(builtinBroadcast(resolved).redisUrl, 'redis://a:6379');

    const legacyOnly = validateAppConfig({
      broadcast: {
        allowedOrigins: ['https://example.com'],
        authenticate: () => 'user',
        redisUrl: 'redis://b:6379',
      },
    });
    assert.equal(builtinBroadcast(legacyOnly).redisUrl, undefined);
  });

  it('does not fall back to the process environment for the broadcast URL', () => {
    const originalValkey = process.env.VALKEY_URL;
    const originalRedis = process.env.REDIS_URL;
    process.env.VALKEY_URL = 'redis://env:6379';
    process.env.REDIS_URL = 'redis://env:6380';
    try {
      const resolved = validateAppConfig({
        broadcast: {
          allowedOrigins: ['https://example.com'],
          authenticate: () => 'user',
        },
      });
      assert.equal(builtinBroadcast(resolved).redisUrl, undefined);
    } finally {
      if (originalValkey === undefined) delete process.env.VALKEY_URL;
      else process.env.VALKEY_URL = originalValkey;
      if (originalRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = originalRedis;
    }
  });

  it('rejects an invalid broadcast URL without echoing credentials', () => {
    assert.throws(
      () =>
        validateAppConfig({
          broadcast: {
            allowedOrigins: ['https://example.com'],
            authenticate: () => 'user',
            valkeyUrl: 'http://user:supersecret-password@example.com',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /redis:\/\/ or rediss:\/\//);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('rejects non-function broadcast callbacks and non-object broadcast', () => {
    assert.throws(
      () =>
        validateAppConfig({
          broadcast: {
            allowedOrigins: [],
            authenticate: 'nope',
          } as unknown as never,
        }),
      /config\.broadcast\.authenticate must be a function/,
    );
    assert.throws(
      () => validateAppConfig({ broadcast: 'nope' }),
      /config\.broadcast must be an object/,
    );
  });
});

// ---------------------------------------------------------------------------
// broadcast: custom adapter form
// ---------------------------------------------------------------------------

describe('validateAppConfig: broadcast adapter', () => {
  function makeAdapter(name = 'custom'): BroadcastAdapter {
    return {
      name,
      attach: () => ({
        broadcast: () => {},
        close: () => Promise.resolve(),
        closesHttpServer: false,
      }),
    };
  }

  it('accepts a custom adapter without Socket.IO origin/auth/Valkey fields', () => {
    const adapter = makeAdapter();
    const resolved = validateAppConfig({ broadcast: { adapter } });

    const broadcast = resolved.broadcast;
    assert.ok(broadcast !== undefined);
    assert.ok('adapter' in broadcast, 'the custom form is preserved as { adapter }');
    assert.equal((broadcast as { adapter: unknown }).adapter, adapter);
    assert.equal('redisUrl' in broadcast, false, 'no redisUrl is synthesized for a custom adapter');
    assert.equal('allowedOrigins' in broadcast, false, 'no Socket.IO fields are required');
  });

  it('preserves the adapter instance by identity and never invokes attach', () => {
    let attachCalls = 0;
    const adapter: BroadcastAdapter = {
      name: 'custom',
      attach() {
        attachCalls += 1;
        return {
          broadcast: () => {},
          close: () => Promise.resolve(),
          closesHttpServer: false,
        };
      },
    };

    const resolved = validateAppConfig({ broadcast: { adapter } });

    const broadcast = resolved.broadcast as { adapter: BroadcastAdapter };
    assert.equal(broadcast.adapter, adapter);
    assert.equal(attachCalls, 0, 'attach must not run during config validation');
  });

  it('rejects a structurally invalid adapter without echoing its value', () => {
    assert.throws(
      () => validateAppConfig({ broadcast: { adapter: null } }),
      /config\.broadcast\.adapter must be a BroadcastAdapter/,
    );
    assert.throws(
      () => validateAppConfig({ broadcast: { adapter: { attach: () => {} } } }),
      /non-empty name/,
    );
    assert.throws(
      () => validateAppConfig({ broadcast: { adapter: { name: 'x' } } }),
      /attach function/,
    );
    assert.throws(
      () =>
        validateAppConfig({
          broadcast: { adapter: { name: 'supersecret-password' } },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('does not run redisUrl validation for the custom adapter form', () => {
    // A custom adapter form must not trip the built-in redis:// scheme check.
    const resolved = validateAppConfig({
      broadcast: { adapter: makeAdapter() },
    });
    assert.ok(resolved.broadcast !== undefined);
    assert.ok('adapter' in resolved.broadcast);
  });
});

// ---------------------------------------------------------------------------
// extensions + renderer: structural validation, identity pass-through
// ---------------------------------------------------------------------------

describe('validateAppConfig: extensions', () => {
  const extension = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    setup: () => {},
    ...extra,
  });

  it('defaults to an empty list when unset', () => {
    assert.deepEqual(validateAppConfig({}).extensions, []);
  });

  it('passes the list and its entries through by identity without invoking setup', () => {
    let setupCalls = 0;
    const setup = (): void => {
      setupCalls += 1;
    };
    const first = { name: 'a', setup };
    const second = { name: 'b', setup };
    const extensions = [first, second];

    const resolved = validateAppConfig({ extensions });

    assert.equal(resolved.extensions, extensions);
    assert.equal(resolved.extensions[0], first);
    assert.equal(resolved.extensions[1], second);
    assert.equal(setupCalls, 0);
  });

  it('accepts requires tokens structurally without invoking them', () => {
    const token = { name: 'db' };
    const resolved = validateAppConfig({
      extensions: [{ name: 'a', setup: () => {}, requires: [token] }],
    });
    assert.equal(resolved.extensions.length, 1);
  });

  it('rejects non-array, non-object, and malformed extensions', () => {
    assert.throws(
      () => validateAppConfig({ extensions: 'nope' }),
      /config\.extensions must be an array/,
    );
    assert.throws(
      () => validateAppConfig({ extensions: [null] }),
      /entries must be extension objects/,
    );
    assert.throws(
      () => validateAppConfig({ extensions: [42] }),
      /entries must be extension objects/,
    );
    assert.throws(() => validateAppConfig({ extensions: [{ setup: () => {} }] }), /non-empty name/);
    assert.throws(
      () => validateAppConfig({ extensions: [{ name: '  ', setup: () => {} }] }),
      /non-empty name/,
    );
    assert.throws(() => validateAppConfig({ extensions: [{ name: 'a' }] }), /setup function/);
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [{ name: 'a', setup: () => {}, requires: 'db' }],
        }),
      /requires must be an array/,
    );
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [{ name: 'a', setup: () => {}, requires: [{}] }],
        }),
      /invalid service token/,
    );
  });

  it('rejects duplicate names early without echoing the name', () => {
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [extension('alpha-secret'), extension('alpha-secret')],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /duplicate names/);
        assert.doesNotMatch(error.message, /alpha-secret/);
        return true;
      },
    );
  });

  it('never leaks an extension value in an error', () => {
    assert.throws(
      () => validateAppConfig({ extensions: [{ name: 'supersecret-password' }] }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('does not source extensions from the environment', () => {
    process.env.JSAILS_EXTENSIONS = 'nope';
    try {
      assert.deepEqual(validateAppConfig({}).extensions, []);
    } finally {
      delete process.env.JSAILS_EXTENSIONS;
    }
  });

  it('rejects malformed priority and disabled flags', () => {
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [{ name: 'a', setup: () => {}, priority: 'x' }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /priority/);
        return true;
      },
    );
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [{ name: 'a', setup: () => {}, disabled: 1 }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /disabled/);
        return true;
      },
    );
  });
});

describe('validateAppConfig: renderer', () => {
  class TestRenderer {
    calls = 0;
    constructor(private readonly label: string) {}
    render(): string {
      this.calls += 1;
      return `${this.label}:${this.calls}`;
    }
  }

  it('defaults to undefined when unset', () => {
    assert.equal(validateAppConfig({}).renderer, undefined);
  });

  it('passes a class renderer through by identity and preserves this and state', () => {
    const renderer = new TestRenderer('page');
    const resolved = validateAppConfig({ renderer });

    assert.equal(resolved.renderer, renderer);
    const roundTripped = resolved.renderer;
    assert.equal(roundTripped.render(), 'page:1');
    assert.equal(roundTripped.render(), 'page:2');
  });

  it('accepts a plain object renderer with a render function', () => {
    const renderer = { render: () => 'html' };
    assert.equal(validateAppConfig({ renderer }).renderer, renderer);
  });

  it('rejects renderers without a render function without echoing the value', () => {
    for (const renderer of [null, 42, 'supersecret-password', {}, { render: 'nope' }]) {
      assert.throws(
        () => validateAppConfig({ renderer }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.renderer/);
          assert.doesNotMatch(error.message, /supersecret-password/);
          return true;
        },
      );
    }
  });

  it('does not source a renderer from the environment', () => {
    process.env.JSAILS_RENDERER = 'nope';
    try {
      assert.equal(validateAppConfig({}).renderer, undefined);
    } finally {
      delete process.env.JSAILS_RENDERER;
    }
  });
});

describe('validateAppConfig: deployments', () => {
  it('defaults to an empty list when unset', () => {
    assert.deepEqual(validateAppConfig({}).deployments, []);
  });

  it('passes the list and its entries through by identity without invoking generate', () => {
    let generateCalls = 0;
    const first = defineDeploymentGenerator('cdn', () => {
      generateCalls += 1;
      return { files: { 'a.txt': 'a' } };
    });
    const second = defineDeploymentGenerator('backup', () => ({ files: {} }));
    const deployments = [first, second];

    const resolved = validateAppConfig({ deployments });

    assert.equal(resolved.deployments, deployments);
    assert.equal(resolved.deployments[0], first);
    assert.equal(resolved.deployments[1], second);
    assert.equal(generateCalls, 0);
  });

  it('rejects non-array, non-object, and malformed entries', () => {
    assert.throws(
      () => validateAppConfig({ deployments: 'nope' }),
      /config\.deployments must be an array/,
    );
    for (const entry of [null, 42, 'x', []]) {
      assert.throws(
        () => validateAppConfig({ deployments: [entry] }),
        /config\.deployments entries must be deployment generator objects/,
      );
    }
    assert.throws(
      () =>
        validateAppConfig({
          deployments: [{ generate: () => ({ files: {} }) }],
        }),
      /non-empty name/,
    );
    assert.throws(() => validateAppConfig({ deployments: [{ name: '  ' }] }), /non-empty name/);
    assert.throws(() => validateAppConfig({ deployments: [{ name: 'cdn' }] }), /generate function/);
  });

  it('rejects duplicate names without echoing the name', () => {
    assert.throws(
      () =>
        validateAppConfig({
          deployments: [
            defineDeploymentGenerator('alpha-secret', () => ({ files: {} })),
            defineDeploymentGenerator('alpha-secret', () => ({ files: {} })),
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /duplicate names/);
        assert.doesNotMatch(error.message, /alpha-secret/);
        return true;
      },
    );
  });

  it('never leaks a deployment value in an error', () => {
    assert.throws(
      () => validateAppConfig({ deployments: [{ name: 'supersecret-password' }] }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('does not source deployments from the environment', () => {
    process.env.JSAILS_DEPLOYMENTS = 'nope';
    try {
      assert.deepEqual(validateAppConfig({}).deployments, []);
    } finally {
      delete process.env.JSAILS_DEPLOYMENTS;
    }
  });
});

describe('validateAppConfig: plugins', () => {
  it('defaults to undefined when absent (no plugins enabled)', () => {
    assert.equal(validateAppConfig({}).plugins, undefined);
  });

  it('defaults enabled to an empty list when plugins is present without enabled', () => {
    assert.deepEqual(validateAppConfig({ plugins: {} }).plugins, {
      enabled: [],
    });
    assert.deepEqual(validateAppConfig({ plugins: { downloads: true } }).plugins, {
      enabled: [],
      downloads: true,
    });
  });

  it('accepts a valid enabled allow-list and downloads flag', () => {
    assert.deepEqual(
      validateAppConfig({
        plugins: { enabled: ['alpha', 'beta-x', 'gamma_1.2'], downloads: true },
      }).plugins,
      { enabled: ['alpha', 'beta-x', 'gamma_1.2'], downloads: true },
    );
    assert.deepEqual(validateAppConfig({ plugins: { downloads: false } }).plugins, {
      enabled: [],
      downloads: false,
    });
  });

  it('passes the plugins object and enabled array through by identity without freezing', () => {
    const enabled = ['alpha', 'beta'];
    const plugins = { enabled };
    const resolved = validateAppConfig({ plugins });

    assert.equal(resolved.plugins, plugins, 'plugins object is preserved by identity');
    assert.equal(resolved.plugins?.enabled, enabled, 'enabled array is preserved by identity');
    assert.equal(Object.isFrozen(plugins), false);
    assert.equal(Object.isFrozen(enabled), false);
  });

  it('does not mutate or freeze the input plugins config', () => {
    const plugins = { enabled: ['alpha'], downloads: true };
    validateAppConfig({ plugins });

    assert.deepEqual(Object.keys(plugins), ['enabled', 'downloads']);
    assert.deepEqual(plugins.enabled, ['alpha']);
    assert.equal(plugins.downloads, true);
    assert.equal(Object.isFrozen(plugins), false);
    assert.equal(Object.isFrozen(plugins.enabled), false);
  });

  it('rejects a non-array enabled value', () => {
    for (const enabled of ['nope', 42, {}, true]) {
      assert.throws(
        () => validateAppConfig({ plugins: { enabled } }),
        /config\.plugins\.enabled has an invalid type/,
      );
    }
  });

  it('rejects invalid plugin ids without echoing them', () => {
    for (const id of ['UPPER', '-leading', 'has space', 'has!bang', '']) {
      assert.throws(
        () => validateAppConfig({ plugins: { enabled: [id] } }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.plugins\.enabled/);
          return true;
        },
      );
    }
    assert.throws(
      () => validateAppConfig({ plugins: { enabled: ['supersecret-password!'] } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('rejects a non-boolean downloads value', () => {
    for (const downloads of ['yes', 1, {}, []]) {
      assert.throws(
        () => validateAppConfig({ plugins: { downloads } }),
        /config\.plugins\.downloads has an invalid type/,
      );
    }
  });

  it('rejects unknown plugin config keys without echoing them', () => {
    assert.throws(
      () => validateAppConfig({ plugins: { nope: 'supersecret-password' } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /unrecognized config field/);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('rejects a non-object plugins value', () => {
    for (const plugins of ['nope', 42, [], true]) {
      assert.throws(
        () => validateAppConfig({ plugins }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.plugins has an invalid type/);
          return true;
        },
      );
    }
  });

  it('carries the plugins field through loadAppConfig', async () => {
    const dir = makeDir('plugins-module');
    writeConfig(
      dir,
      `export default { plugins: { enabled: ['alpha', 'beta'], downloads: true } };`,
    );

    const resolved = await loadAppConfig(undefined, { cwd: dir });

    assert.deepEqual(resolved.plugins, {
      enabled: ['alpha', 'beta'],
      downloads: true,
    });
  });

  // -- plugins.use: declarative specifier/tuple entries -------------------------

  it('accepts a bare string specifier in use', () => {
    const plugins = { use: ['jsails/auth', 'jsails/cache'] };
    assert.deepEqual(validateAppConfig({ plugins }).plugins?.use, ['jsails/auth', 'jsails/cache']);
  });

  it('accepts a [specifier, options] tuple in use', () => {
    const plugins = { use: [['jsails/auth', { sessionDuration: 3600 }]] as const };
    assert.deepEqual(validateAppConfig({ plugins }).plugins?.use, [
      ['jsails/auth', { sessionDuration: 3600 }],
    ]);
  });

  it('accepts a mix of bare strings and tuples in use', () => {
    const plugins = { use: ['jsails/mail', ['jsails/auth', { tokenExpiry: 7200 }]] as const };
    assert.deepEqual(validateAppConfig({ plugins }).plugins?.use, [
      'jsails/mail',
      ['jsails/auth', { tokenExpiry: 7200 }],
    ]);
  });

  it('leaves use undefined when absent', () => {
    assert.equal(validateAppConfig({ plugins: {} }).plugins?.use, undefined);
    assert.equal(validateAppConfig({ plugins: { enabled: ['alpha'] } }).plugins?.use, undefined);
  });

  it('still defaults enabled to [] when use is present', () => {
    assert.deepEqual(validateAppConfig({ plugins: { use: ['jsails/auth'] } }).plugins, {
      enabled: [],
      use: ['jsails/auth'],
    });
  });

  it('preserves use and enabled together without mutating them', () => {
    const use = ['jsails/auth'];
    const enabled = ['alpha'];
    const plugins = { use, enabled };
    const resolved = validateAppConfig({ plugins });

    assert.equal(resolved.plugins?.use, use);
    assert.equal(resolved.plugins?.enabled, enabled);
    assert.equal(Object.isFrozen(plugins), false);
  });

  it('rejects an empty string entry in use without echoing it', () => {
    assert.throws(
      () => validateAppConfig({ plugins: { use: [''] } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.plugins\.use/);
        return true;
      },
    );
  });

  it('rejects a tuple whose second element is not a plain object', () => {
    for (const bad of [null, 42, 'nope', [1, 2], ['supersecret-password']]) {
      assert.throws(
        () => validateAppConfig({ plugins: { use: [['jsails/auth', bad]] } }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.plugins\.use/);
          return true;
        },
      );
    }
  });

  it('rejects a tuple with wrong arity without echoing values', () => {
    assert.throws(
      () => validateAppConfig({ plugins: { use: [['jsails/auth']] } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.plugins\.use/);
        return true;
      },
    );
    assert.throws(
      () => validateAppConfig({ plugins: { use: [['jsails/auth', {}, 'extra']] } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.plugins\.use/);
        return true;
      },
    );
  });

  it('rejects a use entry that is neither string nor tuple', () => {
    for (const bad of [42, true, {}, []]) {
      assert.throws(
        () => validateAppConfig({ plugins: { use: [bad] } }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.plugins\.use/);
          return true;
        },
      );
    }
  });

  it('never echoes a use entry value in an error', () => {
    // A tuple whose second element embeds a secret — rejected because null is not
    // a plain object, and the error must not echo the secret.
    assert.throws(
      () => validateAppConfig({ plugins: { use: [['supersecret-password', null]] } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('carries use through loadAppConfig', async () => {
    const dir = makeDir('plugins-use-module');
    writeConfig(
      dir,
      `export default {
  plugins: {
    enabled: ['alpha'],
    use: ['jsails/auth', ['jsails/cache', { ttl: 3600 }]],
  },
};`,
    );

    const resolved = await loadAppConfig(undefined, { cwd: dir });

    assert.deepEqual(resolved.plugins, {
      enabled: ['alpha'],
      use: ['jsails/auth', ['jsails/cache', { ttl: 3600 }]],
    });
  });
});

// ---------------------------------------------------------------------------
// throwing property getters: value-free sanitization
// ---------------------------------------------------------------------------

describe('validateAppConfig: throwing getters', () => {
  const secret = 'supersecret-password';

  /** Assert the error is a value-free AppConfigError with no chained cause. */
  function assertRedacted(error: unknown): boolean {
    assert.ok(error instanceof AppConfigError);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.equal(error.cause, undefined);
    return true;
  }

  it('sanitizes a throwing top-level config getter', () => {
    const config = {
      get port(): number {
        throw new Error(secret);
      },
    };
    assert.throws(() => validateAppConfig(config), assertRedacted);
  });

  it('sanitizes a throwing custom-adapter getter', () => {
    const broadcast = {
      get adapter() {
        throw new Error(secret);
      },
    };
    assert.throws(() => validateAppConfig({ broadcast }), assertRedacted);
  });

  it('sanitizes throwing built-in broadcast URL getters', () => {
    for (const key of ['valkeyUrl', 'redisUrl'] as const) {
      const broadcast: Record<string, unknown> = {
        allowedOrigins: [],
        authenticate: () => 'user',
      };
      Object.defineProperty(broadcast, key, {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      });
      assert.throws(() => validateAppConfig({ broadcast }), assertRedacted);
    }
  });

  it('sanitizes throwing extension field getters', () => {
    for (const field of ['name', 'setup', 'requires'] as const) {
      const extension: Record<string, unknown> = { name: 'x', setup: () => {} };
      Object.defineProperty(extension, field, {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      });
      assert.throws(() => validateAppConfig({ extensions: [extension] }), assertRedacted);
    }
  });

  it('sanitizes a throwing renderer method getter', () => {
    const renderer = {
      get render() {
        throw new Error(secret);
      },
    };
    assert.throws(() => validateAppConfig({ renderer }), assertRedacted);
  });

  it('sanitizes throwing deployment field getters', () => {
    for (const field of ['name', 'generate'] as const) {
      const deployment: Record<string, unknown> = {
        name: 'cdn',
        generate: () => ({ files: {} }),
      };
      Object.defineProperty(deployment, field, {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      });
      assert.throws(() => validateAppConfig({ deployments: [deployment] }), assertRedacted);
    }
  });

  it('sanitizes throwing plugin config getters', () => {
    for (const field of ['enabled', 'downloads', 'use'] as const) {
      const plugins: Record<string, unknown> = {
        enabled: [],
        downloads: false,
        use: ['jsails/auth'],
      };
      Object.defineProperty(plugins, field, {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      });
      assert.throws(() => validateAppConfig({ plugins }), assertRedacted);
    }

    const config = {
      get plugins() {
        throw new Error(secret);
      },
    };
    assert.throws(() => validateAppConfig(config), assertRedacted);
  });

  it('sanitizes a throwing command metadata getter while still validating', () => {
    const command = {
      name: 'ok',
      summary: 'ok',
      get run() {
        throw new Error(secret);
      },
    };
    assert.throws(
      () => validateAppConfig({ commands: [command as unknown as CliCommand] }),
      assertRedacted,
    );
  });

  it('still accepts a valid custom adapter by identity', () => {
    const adapter: BroadcastAdapter = {
      name: 'custom',
      attach: () => ({
        broadcast: () => {},
        close: () => Promise.resolve(),
        closesHttpServer: false,
      }),
    };
    const resolved = validateAppConfig({ broadcast: { adapter } });

    assert.ok(resolved.broadcast !== undefined);
    assert.ok('adapter' in resolved.broadcast);
    assert.equal(resolved.broadcast.adapter, adapter);
  });
});

// ---------------------------------------------------------------------------
// public directory isolation + shutdown timeout
// ---------------------------------------------------------------------------

describe('validateAppConfig: public directory isolation', () => {
  const cwd = makeDir('public-isolation');

  it('keeps sibling public/pages/api/out directories valid', () => {
    const resolved = validateAppConfig(
      { public: 'public', pages: 'pages', api: 'api', out: 'out' },
      { cwd },
    );

    assert.equal(resolved.publicDir, join(cwd, 'public'));
    assert.equal(resolved.pagesDir, join(cwd, 'pages'));
    assert.equal(resolved.apiDir, join(cwd, 'api'));
    assert.equal(resolved.outDir, join(cwd, 'out'));
  });

  it('rejects a public directory that equals or contains the project root', () => {
    for (const publicDir of ['.', '..']) {
      assert.throws(
        () => validateAppConfig({ public: publicDir }, { cwd }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /must not contain the project root/);
          return true;
        },
      );
    }
  });

  it('rejects a public directory overlapping pages/api/out in either direction', () => {
    const cases: ReadonlyArray<{
      config: Record<string, string>;
      field: string;
    }> = [
      { config: { public: 'pages' }, field: 'pages' },
      { config: { public: 'src', pages: 'src/pages' }, field: 'pages' },
      { config: { public: 'pages/sub', pages: 'pages' }, field: 'pages' },
      { config: { public: 'api' }, field: 'api' },
      { config: { public: 'api/v1', api: 'api' }, field: 'api' },
      { config: { public: 'dist', out: 'dist' }, field: 'out' },
      { config: { public: 'out/build', out: 'out' }, field: 'out' },
    ];
    for (const { config, field } of cases) {
      assert.throws(
        () => validateAppConfig(config, { cwd }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, new RegExp(`must not overlap the ${field} directory`));
          return true;
        },
      );
    }
  });

  it('rejects a config file living inside the public directory', () => {
    assert.throws(
      () =>
        validateAppConfig(
          { rootDir: '..', public: 'configs' },
          { configPath: join(cwd, 'configs', 'jsails.app.js'), cwd },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /must not live inside the public directory/);
        return true;
      },
    );
  });

  it('never echoes a path value in an isolation error', () => {
    assert.throws(
      () => validateAppConfig({ rootDir: 'supersecret-dir', public: '.' }, { cwd }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-dir/);
        return true;
      },
    );
  });
});

describe('validateAppConfig: storage directory', () => {
  const cwd = makeDir('storage');

  it('defaults storageDir to <rootDir>/storage and resolves a custom value', () => {
    assert.equal(validateAppConfig({}, { cwd }).storageDir, join(cwd, 'storage'));
    assert.equal(validateAppConfig({ storage: 'data' }, { cwd }).storageDir, join(cwd, 'data'));
  });

  it('resolves a relative storage against rootDir', () => {
    const resolved = validateAppConfig(
      { rootDir: 'app', storage: 'var/store' },
      { configPath: 'configs/jsails.app.js', cwd },
    );
    assert.equal(resolved.storageDir, join(cwd, 'configs', 'app', 'var/store'));
  });

  it('rejects a storage directory that equals the project root', () => {
    assert.throws(
      () => validateAppConfig({ storage: '.' }, { cwd }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /must not equal the project root/);
        return true;
      },
    );
  });

  it('rejects a storage directory overlapping public/out in either direction', () => {
    const cases: ReadonlyArray<{
      config: Record<string, string>;
      field: string;
    }> = [
      { config: { storage: 'public' }, field: 'public' },
      { config: { storage: 'public/sub', public: 'public' }, field: 'public' },
      { config: { storage: 'src', public: 'src/assets' }, field: 'public' },
      { config: { storage: 'out' }, field: 'out' },
      { config: { storage: 'dist', out: 'dist' }, field: 'out' },
    ];
    for (const { config, field } of cases) {
      assert.throws(
        () => validateAppConfig(config, { cwd }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, new RegExp(`must not overlap the ${field} directory`));
          return true;
        },
      );
    }
  });

  it('rejects a config file living inside the storage directory', () => {
    assert.throws(
      () =>
        validateAppConfig(
          { rootDir: '..', storage: 'configs' },
          { configPath: join(cwd, 'configs', 'jsails.app.js'), cwd },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /must not live inside the storage directory/);
        return true;
      },
    );
  });

  it('never echoes a path value in a storage isolation error', () => {
    assert.throws(
      () => validateAppConfig({ storage: 'supersecret-dir', public: 'supersecret-dir' }, { cwd }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-dir/);
        return true;
      },
    );
  });
});

describe('validateAppConfig: healthPath', () => {
  it('defaults to /up and disables on false', () => {
    assert.equal(validateAppConfig({}).healthPath, DEFAULT_HEALTH_PATH);
    assert.equal(validateAppConfig({ healthPath: false }).healthPath, undefined);
  });

  it('accepts the root path and a custom path', () => {
    assert.equal(validateAppConfig({ healthPath: '/' }).healthPath, '/');
    assert.equal(validateAppConfig({ healthPath: '/healthz' }).healthPath, '/healthz');
  });

  it('rejects malformed paths without echoing the value', () => {
    for (const healthPath of [
      'up',
      '/up/',
      'a/b',
      '/up?x=1',
      '/up#frag',
      '/up\\x',
      '/up//x',
      '/up:x',
      '/_jsails',
      '/_jsails/health',
    ]) {
      assert.throws(
        () => validateAppConfig({ healthPath }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.healthPath/);
          return true;
        },
      );
    }
  });

  it('never echoes the path value in an error', () => {
    assert.throws(
      () => validateAppConfig({ healthPath: 'supersecret-password' }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });
});

describe('validateAppConfig: shutdownTimeoutMs', () => {
  it('defaults to DEFAULT_SHUTDOWN_TIMEOUT_MS and accepts positive bounded values', () => {
    assert.equal(validateAppConfig({}).shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(validateAppConfig({ shutdownTimeoutMs: 30 }).shutdownTimeoutMs, 30);
    assert.equal(
      validateAppConfig({ shutdownTimeoutMs: MAX_SHUTDOWN_TIMEOUT_MS }).shutdownTimeoutMs,
      MAX_SHUTDOWN_TIMEOUT_MS,
    );
  });

  it('rejects non-positive, non-integer, and over-bounded timeouts', () => {
    for (const value of [0, -1, 1.5, Number.NaN, '5000', MAX_SHUTDOWN_TIMEOUT_MS + 1]) {
      assert.throws(
        () => validateAppConfig({ shutdownTimeoutMs: value as unknown as number }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.shutdownTimeoutMs/);
          return true;
        },
      );
    }
  });
});

// ---------------------------------------------------------------------------
// CLI commands: app-level surface + cross-source validation
// ---------------------------------------------------------------------------

describe('validateAppConfig: CLI commands', () => {
  const command = (overrides: Partial<CliCommand> = {}): CliCommand => ({
    name: 'hello',
    summary: 'say hello',
    run: () => 0,
    ...overrides,
  });

  it('defaults app-level commands to an empty list', () => {
    assert.deepEqual(validateAppConfig({}).commands, []);
    assert.deepEqual(
      validateAppConfig({ extensions: [{ name: 'x', setup: () => {} }] }).commands,
      [],
    );
  });

  it('passes app commands through by identity without invoking run', () => {
    let runCalls = 0;
    const appCommand = command({
      run: () => {
        runCalls += 1;
        return 0;
      },
    });

    const resolved = validateAppConfig({ commands: [appCommand] });

    assert.deepEqual(resolved.commands, [appCommand]);
    assert.equal(resolved.commands[0], appCommand);
    assert.equal(runCalls, 0);
  });

  it('surfaces only app-level commands while extension commands stay on their extension', () => {
    const appCommand = command({ name: 'app-cmd' });
    const extCommand = command({ name: 'ext-cmd' });
    const extension = { name: 'ext', setup: () => {}, commands: [extCommand] };

    const resolved = validateAppConfig({
      commands: [appCommand],
      extensions: [extension],
    });

    assert.deepEqual(resolved.commands, [appCommand]);
    assert.equal(resolved.extensions[0], extension, 'the extension is passed through by identity');
    assert.equal(resolved.extensions[0]?.commands?.[0], extCommand);

    // Collecting from the resolved shape sees each command exactly once.
    assert.deepEqual(collectConfigCommands(resolved), [appCommand, extCommand]);
  });

  it('preserves command identity and method this through the collecting registry', async () => {
    class GreeterCommand implements CliCommand {
      readonly name = 'greet';
      readonly summary = 'greet someone';
      calls = 0;

      async run(_args: readonly string[], ctx: CliCommandContext): Promise<void> {
        this.calls += 1;
        ctx.stdout(`hi:${this.calls}`);
      }
    }
    const greeter = new GreeterCommand();

    const resolved = validateAppConfig({ commands: [greeter] });
    const registry = createCliCommandRegistry(collectConfigCommands(resolved));

    assert.equal(registry.get('greet'), greeter);
    const out: string[] = [];
    await registry.run('greet', [], {
      configPath: '/x/jsails.app.js',
      cwd: '/x',
      stdout: (text) => out.push(text),
      stderr: () => {},
    });
    assert.deepEqual(out, ['hi:1']);
    assert.equal(greeter.calls, 1);
  });

  it('rejects a duplicate shared between the app and an extension', () => {
    assert.throws(
      () =>
        validateAppConfig({
          commands: [command({ name: 'shared' })],
          extensions: [
            {
              name: 'ext',
              setup: () => {},
              commands: [command({ name: 'shared' })],
            },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /duplicate command names/);
        return true;
      },
    );
  });

  it('rejects a builtin-reserved name declared by the app or an extension', () => {
    assert.throws(
      () => validateAppConfig({ commands: [command({ name: 'serve' })] }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /reserved command name/);
        return true;
      },
    );
    assert.throws(
      () =>
        validateAppConfig({
          extensions: [
            {
              name: 'ext',
              setup: () => {},
              commands: [command({ name: 'migrate' })],
            },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /reserved command name/);
        return true;
      },
    );
  });

  it('rejects malformed command lists without echoing values', () => {
    assert.throws(() => validateAppConfig({ commands: 'nope' }), /config\.commands is invalid/);
    assert.throws(
      () =>
        validateAppConfig({
          commands: [{ name: 'x', summary: 'x' } as unknown as CliCommand],
        }),
      /config\.commands/,
    );
    assert.throws(
      () =>
        validateAppConfig({
          commands: [
            command({ name: 'supersecret-password' }),
            command({ name: 'supersecret-password' }),
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('never invokes extension setup or command run while validating', () => {
    let setupCalls = 0;
    let runCalls = 0;
    const counted = (name: string): CliCommand =>
      command({
        name,
        run: () => {
          runCalls += 1;
          return 0;
        },
      });

    validateAppConfig({
      commands: [counted('app-cmd')],
      extensions: [
        {
          name: 'ext',
          setup: () => {
            setupCalls += 1;
          },
          commands: [counted('ext-cmd')],
        },
      ],
    });

    assert.equal(setupCalls, 0);
    assert.equal(runCalls, 0);
  });

  it('still rejects unknown config fields with commands accepted', () => {
    assert.throws(
      () => validateAppConfig({ commands: [], nope: 'supersecret-password' }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /unrecognized config field/);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// middleware + globalMiddleware: structural validation, identity pass-through
// ---------------------------------------------------------------------------

describe('validateAppConfig: middleware', () => {
  function makeMiddleware(
    _name: string,
  ): (ctx: unknown, next: () => Promise<Response>) => Promise<Response> {
    return (_ctx, next) => {
      // Minimal middleware that forwards to next.
      return next();
    };
  }

  it('defaults to undefined when absent', () => {
    assert.equal(validateAppConfig({}).middleware, undefined);
    assert.equal(validateAppConfig({}).globalMiddleware, undefined);
  });

  it('passes a valid middleware map through by identity', () => {
    const auth = makeMiddleware('auth');
    const throttle = makeMiddleware('throttle');
    const middleware = { auth, throttle };

    const resolved = validateAppConfig({ middleware });

    assert.equal(resolved.middleware, middleware);
    assert.equal(resolved.middleware?.auth, auth);
    assert.equal(resolved.middleware?.throttle, throttle);
    assert.equal(Object.isFrozen(middleware), false);
  });

  it('passes a valid globalMiddleware array through by identity', () => {
    const auth = makeMiddleware('auth');
    const cache = makeMiddleware('cache');
    const globalMiddleware = [auth, 'throttle', cache];

    const resolved = validateAppConfig({ globalMiddleware });

    assert.equal(resolved.globalMiddleware, globalMiddleware);
    assert.equal(resolved.globalMiddleware?.[0], auth);
    assert.equal(resolved.globalMiddleware?.[1], 'throttle');
    assert.equal(resolved.globalMiddleware?.[2], cache);
  });

  it('accepts both middleware and globalMiddleware together', () => {
    const auth = makeMiddleware('auth');
    const middleware = { auth };
    const globalMiddleware = ['auth' as const];

    const resolved = validateAppConfig({ middleware, globalMiddleware });

    assert.equal(resolved.middleware, middleware);
    assert.equal(resolved.globalMiddleware, globalMiddleware);
  });

  it('rejects middleware with a non-function value without echoing the name or value', () => {
    assert.throws(
      () => validateAppConfig({ middleware: { auth: 'supersecret-password' as unknown } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.middleware entries must be functions/);
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('rejects middleware with an empty name without echoing the key', () => {
    assert.throws(
      () => validateAppConfig({ middleware: { '': makeMiddleware('empty') } }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.middleware entries must have non-empty names/);
        return true;
      },
    );
  });

  it('rejects middleware that is not a plain object', () => {
    for (const value of [null, 42, 'nope', [], new Map()]) {
      assert.throws(
        () => validateAppConfig({ middleware: value as unknown }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.middleware must be a plain object/);
          return true;
        },
      );
    }
  });

  it('rejects middleware with a class instance (non-plain-object)', () => {
    class MiddlewareMap {
      auth = makeMiddleware('auth');
    }
    assert.throws(
      () => validateAppConfig({ middleware: new MiddlewareMap() as unknown }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.middleware must be a plain object/);
        return true;
      },
    );
  });

  it('does not source middleware from the environment', () => {
    process.env.JSAILS_MIDDLEWARE = 'nope';
    try {
      assert.equal(validateAppConfig({}).middleware, undefined);
    } finally {
      delete process.env.JSAILS_MIDDLEWARE;
    }
  });
});

describe('validateAppConfig: globalMiddleware', () => {
  function makeMiddleware(
    _name: string,
  ): (ctx: unknown, next: () => Promise<Response>) => Promise<Response> {
    return (_ctx, next) => next();
  }

  it('rejects globalMiddleware that is not an array', () => {
    for (const value of [null, 42, 'nope', {}, new Set()]) {
      assert.throws(
        () => validateAppConfig({ globalMiddleware: value as unknown }),
        (error: unknown) => {
          assert.ok(error instanceof AppConfigError);
          assert.match(error.message, /config\.globalMiddleware must be an array/);
          return true;
        },
      );
    }
  });

  it('rejects globalMiddleware with a numeric entry without echoing the value', () => {
    assert.throws(
      () => validateAppConfig({ globalMiddleware: [42 as unknown] }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(
          error.message,
          /config\.globalMiddleware entries must be functions or strings/,
        );
        return true;
      },
    );
  });

  it('rejects globalMiddleware with an object entry without echoing the value', () => {
    assert.throws(
      () =>
        validateAppConfig({
          globalMiddleware: [{ secret: 'supersecret-password' } as unknown],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(
          error.message,
          /config\.globalMiddleware entries must be functions or strings/,
        );
        assert.doesNotMatch(error.message, /supersecret-password/);
        return true;
      },
    );
  });

  it('rejects globalMiddleware with an empty string entry', () => {
    assert.throws(
      () => validateAppConfig({ globalMiddleware: [''] }),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /config\.globalMiddleware entries must be non-empty strings/);
        return true;
      },
    );
  });

  it('accepts a mix of functions and strings', () => {
    const auth = makeMiddleware('auth');
    const globalMiddleware = [auth, 'logged-in', 'cached'];
    const resolved = validateAppConfig({ globalMiddleware });
    assert.equal(resolved.globalMiddleware, globalMiddleware);
  });

  it('accepts a function-only globalMiddleware', () => {
    const first = makeMiddleware('first');
    const second = makeMiddleware('second');
    const globalMiddleware = [first, second];
    const resolved = validateAppConfig({ globalMiddleware });
    assert.equal(resolved.globalMiddleware, globalMiddleware);
  });

  it('accepts a string-only globalMiddleware', () => {
    const globalMiddleware = ['auth', 'throttle'];
    const resolved = validateAppConfig({ globalMiddleware });
    assert.equal(resolved.globalMiddleware, globalMiddleware);
  });

  it('does not source globalMiddleware from the environment', () => {
    process.env.JSAILS_GLOBAL_MIDDLEWARE = 'nope';
    try {
      assert.equal(validateAppConfig({}).globalMiddleware, undefined);
    } finally {
      delete process.env.JSAILS_GLOBAL_MIDDLEWARE;
    }
  });
});
