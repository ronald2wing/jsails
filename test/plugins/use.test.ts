import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  extractPluginFromUse,
  normalizeUseEntry,
  resolvePluginUse,
} from '../../src/plugins/use.js';

// ---------------------------------------------------------------------------
// Pure unit tests: normalizeUseEntry + extractPluginFromUse
// ---------------------------------------------------------------------------

describe('normalizeUseEntry', () => {
  it('wraps a bare string with an empty options object', () => {
    const [specifier, options] = normalizeUseEntry('jsails/auth');
    assert.equal(specifier, 'jsails/auth');
    assert.deepEqual(options, {});
  });

  it('passes a tuple through unchanged', () => {
    const opts = Object.freeze({ timeout: 5000 });
    const [specifier, options] = normalizeUseEntry(['my-plugin', opts]);
    assert.equal(specifier, 'my-plugin');
    assert.strictEqual(options, opts);
  });

  it('returns an empty frozen object for a string entry', () => {
    const [, options] = normalizeUseEntry('bare');
    assert.strictEqual(Object.isFrozen(options), true);
    assert.deepEqual(options, {});
  });
});

describe('extractPluginFromUse', () => {
  it('constructs plugin via a sync factory with options', async () => {
    const factory = (opts: Record<string, unknown>) => ({
      name: 'test-plugin',
      setup() {},
      _opts: opts,
    });
    const result = await extractPluginFromUse({ default: factory }, 'spec', { key: 'val' });
    assert.ok(result !== undefined);
    assert.equal(result.name, 'test-plugin');
  });

  it('returns undefined when the default export is not a function or plugin', async () => {
    assert.equal(await extractPluginFromUse({ default: 42 }, 'spec', {}), undefined);
    assert.equal(await extractPluginFromUse({ default: 'string' }, 'spec', {}), undefined);
    assert.equal(await extractPluginFromUse({ default: null }, 'spec', {}), undefined);
    assert.equal(await extractPluginFromUse({}, 'spec', {}), undefined);
  });

  it('returns undefined when namespace is not an object', async () => {
    assert.equal(await extractPluginFromUse(null, 'spec', {}), undefined);
    assert.equal(await extractPluginFromUse('string', 'spec', {}), undefined);
    assert.equal(await extractPluginFromUse(42, 'spec', {}), undefined);
  });

  it('returns undefined when factory throws synchronously', async () => {
    const factory = () => {
      throw new Error('boom');
    };
    assert.equal(await extractPluginFromUse({ default: factory }, 'spec', {}), undefined);
  });

  it('accepts a ready JsailsPlugin as default export (forward-compat)', async () => {
    const ready = { name: 'ready-plugin', setup() {} };
    const result = await extractPluginFromUse({ default: ready }, 'spec', {});
    assert.ok(result !== undefined);
    assert.strictEqual(result, ready);
  });

  it('returns undefined when the default export is an object without name+setup', async () => {
    assert.equal(await extractPluginFromUse({ default: {} }, 'spec', {}), undefined);
    assert.equal(await extractPluginFromUse({ default: { name: '' } }, 'spec', {}), undefined);
    assert.equal(await extractPluginFromUse({ default: { setup: 42 } }, 'spec', {}), undefined);
  });

  it('returns undefined when factory returns an invalid value', async () => {
    const factory = () => 42;
    assert.equal(await extractPluginFromUse({ default: factory }, 'spec', {}), undefined);

    const factoryNull = () => null;
    assert.equal(await extractPluginFromUse({ default: factoryNull }, 'spec', {}), undefined);

    const factoryObj = () => ({ notName: 'x' });
    assert.equal(await extractPluginFromUse({ default: factoryObj }, 'spec', {}), undefined);
  });

  it('resolves an async factory', async () => {
    const factory = async () => ({ name: 'async-plugin', setup() {} });
    const result = await extractPluginFromUse({ default: factory }, 'spec', {});
    assert.ok(result !== undefined);
    assert.equal(result.name, 'async-plugin');
  });

  it('returns undefined when async factory rejects', async () => {
    const factory = async () => {
      throw new Error('async boom');
    };
    const result = await extractPluginFromUse({ default: factory }, 'spec', {});
    assert.equal(result, undefined);
  });

  it('returns undefined when async factory resolves to an invalid value', async () => {
    const factory = async () => 42;
    const result = await extractPluginFromUse({ default: factory }, 'spec', {});
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: resolvePluginUse with file:// URL fixtures
// ---------------------------------------------------------------------------

const fixturesDir = mkdtempSync(join(tmpdir(), 'jsails-use-'));

after(() => {
  rmSync(fixturesDir, { recursive: true, force: true });
});

/**
 * Write a fixture module and return its `file://` URL.
 * Fixture sources are generated inline (not read from disk) so each test run
 * produces a unique module — Node caches `import(file://<path>)` results by
 * URL, so a unique temp dir per run yields fresh imports every time.
 */
function fixtureUrl(name: string, content: string): string {
  const fixturePath = join(fixturesDir, name);
  writeFileSync(fixturePath, content);
  return pathToFileURL(fixturePath).href;
}

const OK_MODULE = `export default function factory(options) { return { name: 'ok', setup() {}, _opts: options }; }\n`;
const INVALID_RESULT = `export default function factory(_options) { return 42; }\n`;
const NOT_FUNC = `export default 'not-a-function';\n`;
const FACTORY_THROW = `export default function factory(_options) { throw new Error('bang'); }\n`;
const READY_PLUGIN = `export default { name: 'ready', setup() {} };\n`;
const ASYNC_OK = `export default async function factory(options) { return { name: 'async-ok', setup() {}, _opts: options }; }\n`;

describe('resolvePluginUse integration', () => {
  it('constructs a plugin from a bare specifier (factory with empty options)', async () => {
    const result = await resolvePluginUse({ entries: [fixtureUrl('ok.mjs', OK_MODULE)] });
    assert.deepEqual(result.issues, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'ok');
    assert.equal(typeof result.plugins[0]!.setup, 'function');
  });

  it('passes options to the factory via a tuple entry', async () => {
    const opts = Object.freeze({ timeout: 5000 });
    const result = await resolvePluginUse({
      entries: [[fixtureUrl('ok.mjs', OK_MODULE), opts]],
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'ok');
  });

  it('reports a value-free issue when the factory returns an invalid value', async () => {
    const result = await resolvePluginUse({
      entries: [fixtureUrl('invalid-result.mjs', INVALID_RESULT)],
    });
    assert.deepEqual(result.plugins, []);
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0]!;
    assert.equal(issue.code, 'plugin_load_failed');
    assert.equal(issue.message.includes('failed to load'), true);
    // Value-free: never echoes module contents or option values.
    // The specifier (a config value) may appear in the message.
    assert.equal(issue.message.includes('42'), false);
  });

  it('reports a value-free issue when the default export is not a function', async () => {
    const result = await resolvePluginUse({ entries: [fixtureUrl('not-func.mjs', NOT_FUNC)] });
    assert.deepEqual(result.plugins, []);
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0]!;
    assert.equal(issue.code, 'plugin_load_failed');
    // Value-free: never echoes module contents.
    assert.equal(issue.message.includes('not-a-function'), false);
  });

  it('reports a value-free issue when the factory throws', async () => {
    const result = await resolvePluginUse({
      entries: [fixtureUrl('factory-throw.mjs', FACTORY_THROW)],
    });
    assert.deepEqual(result.plugins, []);
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0]!;
    assert.equal(issue.code, 'plugin_load_failed');
    // Value-free: never echoes the thrown error message.
    assert.equal(issue.message.includes('bang'), false);
  });

  it('accepts a ready JsailsPlugin as default export (forward-compat)', async () => {
    const result = await resolvePluginUse({
      entries: [fixtureUrl('ready-plugin.mjs', READY_PLUGIN)],
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'ready');
  });

  it('constructs a plugin from an async factory', async () => {
    const result = await resolvePluginUse({
      entries: [fixtureUrl('async-ok.mjs', ASYNC_OK)],
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'async-ok');
  });

  it('reports a value-free issue for an unresolvable specifier', async () => {
    const result = await resolvePluginUse({
      entries: ['__nonexistent_package_12345__'],
    });
    assert.deepEqual(result.plugins, []);
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0]!;
    assert.equal(issue.code, 'plugin_load_failed');
    // Value-free: specifier is the only allowed echo — check it's present.
    assert.equal(issue.message.includes('__nonexistent_package_12345__'), true);
    // But never echoes internal module resolution errors.
    assert.equal(issue.message.includes('Cannot find'), false);
    assert.equal(issue.message.includes('ERR_MODULE'), false);
  });

  it('preserves entry order in plugins', async () => {
    const a = fixtureUrl('a-ok.mjs', OK_MODULE);
    const b = fixtureUrl('b-ready.mjs', READY_PLUGIN);
    const c = fixtureUrl('c-async.mjs', ASYNC_OK);
    const result = await resolvePluginUse({ entries: [a, b, c] });
    assert.deepEqual(result.issues, []);
    assert.equal(result.plugins.length, 3);
    assert.deepEqual(
      result.plugins.map((p) => p.name),
      ['ok', 'ready', 'async-ok'],
    );
  });

  it('continues after a failure — one bad entry does not abort the rest', async () => {
    const result = await resolvePluginUse({
      entries: [
        fixtureUrl('ok.mjs', OK_MODULE),
        fixtureUrl('not-func.mjs', NOT_FUNC),
        fixtureUrl('ready.mjs', READY_PLUGIN),
        fixtureUrl('factory-throw.mjs', FACTORY_THROW),
        fixtureUrl('async-ok.mjs', ASYNC_OK),
      ],
    });
    // Two failures: not-func + factory-throw
    assert.equal(result.issues.length, 2);
    // Three successes, in original order
    assert.deepEqual(
      result.plugins.map((p) => p.name),
      ['ok', 'ready', 'async-ok'],
    );
    for (const issue of result.issues) {
      assert.equal(issue.code, 'plugin_load_failed');
    }
  });

  it('never echoes option values in issue messages', async () => {
    const result = await resolvePluginUse({
      entries: [[fixtureUrl('factory-throw.mjs', FACTORY_THROW), Object.freeze({ secret: 'xyz' })]],
    });
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0]!;
    assert.equal(issue.message.includes('secret'), false);
    assert.equal(issue.message.includes('xyz'), false);
  });

  it('never echoes module contents in issue messages', async () => {
    const result = await resolvePluginUse({
      entries: [fixtureUrl('not-func.mjs', NOT_FUNC)],
    });
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0]!;
    assert.equal(issue.message.includes('not-a-function'), false);
  });
});
