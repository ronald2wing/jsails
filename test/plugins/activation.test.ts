import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { activatePlugins, isBareSpecifier } from '../../src/plugins/activation.js';
import { PLUGIN_STATE_VERSION, type PluginStateSource } from '../../src/plugins/state-store.js';

/** A minimal valid manifest fixture. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme',
    version: '1.0.0',
    jsailsCompat: '^0.1.0',
    entry: './index.mjs',
    ...overrides,
  };
}

/** A package.json that self-identifies as a plugin with the given manifest id. */
function pluginPackage(id: string): Record<string, unknown> {
  return { name: 'pkg', version: '1.0.0', jsails: manifest({ id }) };
}

/** A valid ESM plugin module: a default-exported plugin named `name`. */
function pluginModule(name: string): string {
  return `export default { name: ${JSON.stringify(name)}, setup() {} };\n`;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'plugins-activation-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('dependency source activation', () => {
  it('imports and activates a plugin when its id is code-enabled', async () => {
    const root = makeDir('dep-activated');
    writeJson(join(root, 'package.json'), { dependencies: { 'acme-plugin': '^1.0.0' } });
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), pluginPackage('acme'));
    writeFile(join(root, 'node_modules', 'acme-plugin', 'index.mjs'), pluginModule('acme'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'acme');
    assert.equal(typeof result.plugins[0]!.setup, 'function');
  });

  it('skips a non-enabled plugin without importing it', async () => {
    const root = makeDir('dep-not-enabled');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'acme-plugin': '^1.0.0', 'other-plugin': '^1.0.0' },
    });
    // A module that throws on import proves activation never touched it.
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), pluginPackage('acme'));
    writeFile(join(root, 'node_modules', 'acme-plugin', 'index.mjs'), 'throw new Error("boom");\n');
    writeJson(join(root, 'node_modules', 'other-plugin', 'package.json'), pluginPackage('other'));
    writeFile(join(root, 'node_modules', 'other-plugin', 'index.mjs'), pluginModule('other'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['other'] });

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['other'],
    );
    assert.deepEqual(result.skipped, [{ id: 'acme', reason: 'not-enabled' }]);
    assert.deepEqual(result.issues, []);
  });
});

describe('bundle source activation', () => {
  it('imports a bundle plugin via its manifest entry', async () => {
    const root = makeDir('bundle-activated');
    writeJson(join(root, 'storage', 'plugins', 'acme', 'manifest.json'), manifest());
    writeFile(join(root, 'storage', 'plugins', 'acme', 'index.mjs'), pluginModule('acme'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

    assert.deepEqual(result.issues, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'acme');
  });
});

describe('load failures', () => {
  it('reports plugin_load_failed for an invalid export and a throwing import, without aborting the rest', async () => {
    const root = makeDir('load-failures');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'bad-export': '^1.0.0', 'bad-throw': '^1.0.0', good: '^1.0.0' },
    });
    writeJson(
      join(root, 'node_modules', 'bad-export', 'package.json'),
      pluginPackage('bad-export'),
    );
    writeFile(join(root, 'node_modules', 'bad-export', 'index.mjs'), 'export default 42;\n');
    writeJson(join(root, 'node_modules', 'bad-throw', 'package.json'), pluginPackage('bad-throw'));
    writeFile(join(root, 'node_modules', 'bad-throw', 'index.mjs'), 'throw new Error("boom");\n');
    writeJson(join(root, 'node_modules', 'good', 'package.json'), pluginPackage('good'));
    writeFile(join(root, 'node_modules', 'good', 'index.mjs'), pluginModule('good'));

    const result = await activatePlugins({
      rootDir: root,
      codeEnabled: ['bad-export', 'bad-throw', 'good'],
    });

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['good'],
    );
    assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
      'plugin_load_failed',
      'plugin_load_failed',
    ]);
    assert.deepEqual(result.issues.map((issue) => issue.pluginId).sort(), [
      'bad-export',
      'bad-throw',
    ]);
    // Value-free: messages never echo module contents or thrown error text.
    for (const issue of result.issues) {
      assert.equal(issue.message.includes('boom'), false);
      assert.equal(issue.message.includes('42'), false);
    }
  });

  it('orders plugins deterministically by id', async () => {
    const root = makeDir('ordering');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'multi-plugin': '^1.0.0', 'named-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'multi-plugin', 'package.json'), pluginPackage('multi'));
    writeFile(
      join(root, 'node_modules', 'multi-plugin', 'index.mjs'),
      'export default [{ name: "mb", setup() {} }, { name: "ma", setup() {} }];\n',
    );
    writeJson(join(root, 'node_modules', 'named-plugin', 'package.json'), pluginPackage('named'));
    writeFile(
      join(root, 'node_modules', 'named-plugin', 'index.mjs'),
      'export const plugins = [{ name: "named", setup() {} }];\n',
    );

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['multi', 'named'] });

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['ma', 'mb', 'named'],
    );
  });
});

describe('managed/non-managed switch', () => {
  it('rejects a managed activation without a state source, value-free', async () => {
    const root = makeDir('managed-missing-source');
    await assert.rejects(
      activatePlugins({ rootDir: root, managed: true }),
      (error: unknown) => error instanceof Error && /requires a state source/.test(error.message),
    );
  });

  it('performs zero stateSource calls when not managed', async () => {
    const root = makeDir('non-managed');
    writeJson(join(root, 'package.json'), { dependencies: { 'acme-plugin': '^1.0.0' } });
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), pluginPackage('acme'));
    writeFile(join(root, 'node_modules', 'acme-plugin', 'index.mjs'), pluginModule('acme'));

    let calls = 0;
    const stateSource: PluginStateSource = {
      load: () => {
        calls += 1;
        return { version: PLUGIN_STATE_VERSION, plugins: {} };
      },
      save: () => {
        calls += 1;
      },
    };

    const result = await activatePlugins({
      rootDir: root,
      codeEnabled: ['acme'],
      managed: false,
      stateSource,
    });

    assert.equal(calls, 0);
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['acme'],
    );
  });

  it('enables a plugin from managed state when no code list is present', async () => {
    const root = makeDir('managed-enabled');
    writeJson(join(root, 'package.json'), { dependencies: { 'acme-plugin': '^1.0.0' } });
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), pluginPackage('acme'));
    writeFile(join(root, 'node_modules', 'acme-plugin', 'index.mjs'), pluginModule('acme'));

    const stateSource: PluginStateSource = {
      load: async () => ({
        version: PLUGIN_STATE_VERSION,
        plugins: { acme: { active: '1.0.0', enabled: true } },
      }),
      save: async () => {},
    };

    const result = await activatePlugins({ rootDir: root, managed: true, stateSource });

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['acme'],
    );
  });
});

describe('isBareSpecifier', () => {
  it('returns false for relative paths (./ and ../)', () => {
    assert.equal(isBareSpecifier('./index.mjs'), false);
    assert.equal(isBareSpecifier('../src/main.mjs'), false);
    assert.equal(isBareSpecifier('./nested/deep.mjs'), false);
  });

  it('returns false for POSIX absolute paths', () => {
    assert.equal(isBareSpecifier('/absolute/path/main.mjs'), false);
  });

  it('returns false for Windows drive-letter paths', () => {
    assert.equal(isBareSpecifier('C:\\path\\to\\module.mjs'), false);
    assert.equal(isBareSpecifier('D:/path/to/module.mjs'), false);
  });

  it('returns true for bare module specifiers', () => {
    assert.equal(isBareSpecifier('jsails/auth'), true);
    assert.equal(isBareSpecifier('@acme/blog'), true);
    assert.equal(isBareSpecifier('pkg'), true);
    assert.equal(isBareSpecifier('my-plugin'), true);
  });
});

describe('bare specifier entry resolution', () => {
  // A bare-specifier entry is imported via `import(specifier)`. Node resolves
  // bare specifiers from the importing module's location
  // (src/plugins/activation.ts), which looks in node_modules directories
  // walking up from that path. The fixture must therefore be accessible from
  // the project root's node_modules. This test creates a one-shot fixture
  // package there and cleans it up afterward.

  const BARE_FIXTURE_NAME = '__test_bare_specifier_plugin__';
  const bareFixtureDir = join(process.cwd(), 'node_modules', BARE_FIXTURE_NAME);

  let fixtureCreated = false;

  after(() => {
    if (fixtureCreated) {
      rmSync(bareFixtureDir, { recursive: true, force: true });
    }
  });

  it('imports a plugin via a bare specifier entry', async () => {
    // Create the fixture package in the project root's node_modules so Node
    // can resolve it from src/plugins/activation.ts.
    writeJson(join(bareFixtureDir, 'package.json'), {
      name: BARE_FIXTURE_NAME,
      version: '1.0.0',
      type: 'module',
      main: './index.mjs',
    });
    writeFile(join(bareFixtureDir, 'index.mjs'), pluginModule('bare-plugin'));
    fixtureCreated = true;

    const root = makeDir('bare-spec');
    writeJson(join(root, 'package.json'), { dependencies: { 'acme-plugin': '^1.0.0' } });
    // The manifest entry is a bare specifier — not a relative path.
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), {
      name: 'pkg',
      version: '1.0.0',
      jsails: manifest({ id: 'acme', entry: BARE_FIXTURE_NAME }),
    });

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'bare-plugin');
    assert.equal(typeof result.plugins[0]!.setup, 'function');
  });
});
