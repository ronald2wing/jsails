/**
 * Headless plugin lifecycle CLI tests: `plugins install|uninstall|enable|
 * disable|rollback`.
 *
 * These drive `runPluginsCommand` directly with injected dependencies — no
 * network, database, or filesystem mutation beyond temp fixture dirs. They
 * assert the argument gating, the value-free failure discipline, the installer
 * wiring (including the checksum key derived from the URL path basename), the
 * code-enabled conflict refusal, and the managed-state mutate/init/destroy
 * ordering. Secrets are never echoed: a non-value-free error falls back to a
 * fixed message.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { DataSource } from 'typeorm';

import { runPluginsCommand, type PluginsDeps } from '../../src/cli/plugins-command.js';
import {
  PluginInstallerError,
  type InstallPluginInput,
  type PluginInstaller,
} from '../../src/plugins/installer.js';
import {
  PluginStateError,
  PLUGIN_STATE_VERSION,
  type PluginState,
  type PluginStateSource,
} from '../../src/plugins/state-store.js';

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'plugins-cli-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

/** An in-memory installer that records every call plus the directory it was built for. */
function makeInstaller() {
  const installs: InstallPluginInput[] = [];
  const uninstalls: Array<{ id: string; force: boolean }> = [];
  const pluginsDirs: string[] = [];
  const installer: PluginInstaller = {
    install: async (input) => {
      installs.push(input);
      return { id: input.id, version: input.version, warnings: [] };
    },
    uninstall: async (id, options) => {
      uninstalls.push({ id, force: options?.force === true });
    },
    rollback: async () => {},
  };
  return {
    installs,
    uninstalls,
    pluginsDirs,
    installer,
    createInstaller: (options: { pluginsDir: string }): PluginInstaller => {
      pluginsDirs.push(options.pluginsDir);
      return installer;
    },
  };
}

/** An in-memory state source that records every `save` and exposes its state. */
function makeStateSource(initial: PluginState['plugins'] = {}) {
  let state: PluginState = { version: PLUGIN_STATE_VERSION, plugins: initial };
  const saves: PluginState[] = [];
  const source: PluginStateSource = {
    async load() {
      return state;
    },
    async save(next: PluginState) {
      saves.push(next);
      state = next;
    },
  };
  return {
    source,
    saves,
    createStateStore: (): PluginStateSource => source,
    get state() {
      return state;
    },
  };
}

/** A fake TypeORM data source recording init/destroy order. */
function makeDataSource() {
  const calls: string[] = [];
  const dataSource = {
    async initialize() {
      calls.push('initialize');
    },
    async destroy() {
      calls.push('destroy');
    },
  } as unknown as DataSource;
  return { calls, dataSource };
}

/** Build a deps value with the lifecycle seams wired and a fixed cwd. */
function lifecycleDeps(
  s: Sinks,
  overrides: {
    loadAppPlugins?: PluginsDeps['loadAppPlugins'];
    loadDataSource?: PluginsDeps['loadDataSource'];
    createInstaller?: PluginsDeps['createInstaller'];
    createStateStore?: PluginsDeps['createStateStore'];
  } = {},
): PluginsDeps {
  return {
    cwd: join(fixturesRoot, 'cwd'),
    frameworkVersion: '0.1.0',
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    ...overrides,
  };
}

const INSTALL_ARGS = [
  'install',
  'acme',
  '--version',
  '1.2.3',
  '--url',
  'https://example.com/acme.tgz',
];

describe('plugins lifecycle argument gating', () => {
  it('requires --url for install (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['install', 'acme', '--version', '1.2.3'],
      lifecycleDeps(s),
    );
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires --url/);
  });

  it('requires --version for install (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['install', 'acme', '--url', 'https://example.com/acme.tgz'],
      lifecycleDeps(s),
    );
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires --version/);
  });

  it('requires <id> <version> for rollback (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['rollback', 'acme'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires <id> <version>/);
  });

  it('rejects an extra rollback positional (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['rollback', 'acme', '1.0.0', 'extra'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires <id> <version>/);
  });

  it('rejects an unknown flag for a lifecycle subcommand (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand([...INSTALL_ARGS, '--json'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--json is not valid for "plugins install"/);
  });

  it('rejects --force on a subcommand that does not support it (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['enable', 'acme', '--force'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--force is not valid for "plugins enable"/);
  });

  it('rejects an invalid plugin id (exit 1)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['install', 'BAD ID', '--version', '1.0.0', '--url', 'https://example.com/a.tgz'],
      lifecycleDeps(s),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin id is invalid/);
  });

  it('rejects an invalid rollback version (exit 1)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['rollback', 'acme', 'not-a-version'], lifecycleDeps(s));
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin version is invalid/);
  });

  it('rejects an install with extra positionals (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand([...INSTALL_ARGS, 'extra'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires <id>/);
  });
});

describe('plugins install', () => {
  it('installs through the installer with id/version/url and a checksum keyed by artifact name', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      [
        'install',
        'acme',
        '--version',
        '1.2.3',
        '--url',
        'https://example.com/dl/acme-1.2.3.tgz?token=secret#frag',
        '--sha256',
        'deadbeef',
        '--signature',
        'c2ln',
      ],
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: inst.createInstaller,
      }),
    );
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /Installed acme@1\.2\.3\./);

    assert.equal(inst.installs.length, 1);
    const call = inst.installs[0]!;
    assert.equal(call.id, 'acme');
    assert.equal(call.version, '1.2.3');
    assert.equal(call.url, 'https://example.com/dl/acme-1.2.3.tgz?token=secret#frag');
    assert.deepEqual(call.checksums, { 'acme-1.2.3.tgz': 'deadbeef' });
    assert.equal(call.signature, 'c2ln');
  });

  it('resolves the default plugins dir under cwd and reports warnings to stderr', async () => {
    const pluginsDirs: string[] = [];
    const s = sinks();
    const code = await runPluginsCommand(
      INSTALL_ARGS,
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: (options) => {
          pluginsDirs.push(options.pluginsDir);
          return {
            install: async (input) => ({
              id: input.id,
              version: input.version,
              warnings: ['be careful'],
            }),
            uninstall: async () => {},
            rollback: async () => {},
          };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(pluginsDirs, [join(fixturesRoot, 'cwd', 'storage', 'plugins')]);
    assert.match(s.err.join('\n'), /warning: be careful/);
  });

  it('refuses a code-enabled id before calling the installer', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      INSTALL_ARGS,
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ enabled: ['acme'] }),
        createInstaller: inst.createInstaller,
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /code-enabled/);
    assert.equal(inst.installs.length, 0);
  });

  it('surfaces a value-free fallback when the installer throws a generic error', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      INSTALL_ARGS,
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: () => ({
          install: async () => {
            throw new Error('db password hunter2 leaked');
          },
          uninstall: async () => {},
          rollback: async () => {},
        }),
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin install failed/);
    assert.doesNotMatch(s.err.join('\n'), /hunter2/);
  });

  it('echoes a value-free PluginInstallerError message', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      INSTALL_ARGS,
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: () => ({
          install: async () => {
            throw new PluginInstallerError('checksum_mismatch', 'plugin checksum does not match');
          },
          uninstall: async () => {},
          rollback: async () => {},
        }),
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin checksum does not match/);
  });

  it('passes force: true to the installer when --force is set', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      [...INSTALL_ARGS, '--force'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: inst.createInstaller,
      }),
    );
    assert.equal(code, 0);
    assert.equal(inst.installs[0]?.force, true);
  });
});

describe('plugins uninstall', () => {
  it('uninstalls through the installer', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      ['uninstall', 'acme'],
      lifecycleDeps(s, { createInstaller: inst.createInstaller }),
    );
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /Uninstalled acme\./);
    assert.deepEqual(inst.uninstalls, [{ id: 'acme', force: false }]);
  });

  it('passes force: true to uninstall when --force is set', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      ['uninstall', 'acme', '--force'],
      lifecycleDeps(s, { createInstaller: inst.createInstaller }),
    );
    assert.equal(code, 0);
    assert.deepEqual(inst.uninstalls, [{ id: 'acme', force: true }]);
  });
});

describe('plugins enable/disable', () => {
  it('flips enabled and initializes then destroys the data source', async () => {
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: false } });
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['enable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    assert.deepEqual(stateSource.state.plugins['acme'], { active: '1.2.3', enabled: true });
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('disables while preserving the active version', async () => {
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: true } });
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['disable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    assert.deepEqual(stateSource.state.plugins['acme'], { active: '1.2.3', enabled: false });
  });

  it('fails value-free when the deployment is not managed', async () => {
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['enable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        loadDataSource: async () => db.dataSource,
      }),
    );

    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /not managed/);
    assert.deepEqual(db.calls, []);
  });

  it('fails when the id is not in the managed state', async () => {
    const stateSource = makeStateSource({});
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['enable', 'ghost'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin is not installed/);
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('destroys the data source even when the state save fails', async () => {
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['enable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: () => ({
          load: async () => ({
            version: PLUGIN_STATE_VERSION,
            plugins: { acme: { active: '1.0.0', enabled: false } },
          }),
          save: async () => {
            throw new PluginStateError('plugin state could not be updated');
          },
        }),
      }),
    );

    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin state could not be updated/);
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('surfaces a value-free fallback when the database config fails to load', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['enable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => {
          throw new Error('credential secret leaked');
        },
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /database config could not be loaded/);
    assert.doesNotMatch(s.err.join('\n'), /secret leaked/);
  });
});

describe('plugins rollback', () => {
  it('flips the active version while preserving enabled', async () => {
    const stateSource = makeStateSource({ acme: { active: '2.0.0', enabled: true } });
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['rollback', 'acme', '1.0.0'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    assert.deepEqual(stateSource.state.plugins['acme'], { active: '1.0.0', enabled: true });
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });
});
