import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import type { FrameworkSymbolOverrideWarning } from '../../src/symbols/projection.js';
import {
  installDeclaredGlobals,
  installPluginDeclarations,
  type PluginAutoloadEntry,
} from '../../src/symbols/install-plugin-globals.js';

/**
 * `installDeclaredGlobals` projects a plugin's own surface onto `globalThis` from
 * pre-resolved entries; `installPluginDeclarations` reads the folded
 * `.jsails/plugin-declarations.js` emitted at `build:meta`. Both enumerate the
 * opted-in subpath's named exports and project them, skipping `default`.
 */

const fixtureDir = mkdtempSync(join(tmpdir(), 'plugin-globals-'));

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** Write a synthetic subpath module and return its importable specifier. */
function writeModule(exports: string): string {
  const file = join(fixtureDir, `mod-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, exports, 'utf8');
  return pathToFileURL(file).href;
}

describe('installDeclaredGlobals', () => {
  it('projects a selected subpath onto globalThis, excluding default', async () => {
    const specifier = writeModule(
      'export const alpha = 1;\nexport default 2;\nexport const beta = 3;\n',
    );
    const entries: PluginAutoloadEntry[] = [
      { origin: 'fixture', autoload: { mode: 'selected', specifiers: [specifier] } },
    ];
    const warnings: FrameworkSymbolOverrideWarning[] = [];
    try {
      await installDeclaredGlobals(entries, { onWarn: (w) => warnings.push(w) });
      const target = globalThis as Record<string, unknown>;
      assert.equal(target['alpha'], 1);
      assert.equal(target['beta'], 3);
      assert.equal(target['default'], undefined); // never projected
    } finally {
      delete (globalThis as Record<string, unknown>)['alpha'];
      delete (globalThis as Record<string, unknown>)['beta'];
    }
  });

  it('contributes nothing for none or an empty selected list', async () => {
    const before = Object.keys(globalThis).length;
    await installDeclaredGlobals([
      { origin: 'a', autoload: undefined },
      { origin: 'b', autoload: { mode: 'none' } },
      { origin: 'c', autoload: { mode: 'selected', specifiers: [] } },
    ]);
    assert.equal(Object.keys(globalThis).length, before);
  });
});

describe('installPluginDeclarations', () => {
  it('reads the emitted plugin-declarations.js and projects each active surface', async () => {
    const specifier = writeModule('export const gamma = 4;\n');
    const rootDir = join(fixtureDir, 'app');
    mkdirSync(join(rootDir, '.jsails'), { recursive: true });
    writeFileSync(
      join(rootDir, '.jsails', 'plugin-declarations.js'),
      `export const PLUGIN_DECLARATIONS = Object.freeze([
  Object.freeze({
    id: 'acme',
    provides: Object.freeze(['acme']),
    autoload: Object.freeze({ mode: 'selected', specifiers: Object.freeze(['${specifier}']) }),
    symbols: undefined,
    plugins: undefined,
  }),
]);\n`,
    );

    try {
      await installPluginDeclarations(rootDir, { onWarn: () => {} });
      assert.equal((globalThis as Record<string, unknown>)['gamma'], 4);
    } finally {
      delete (globalThis as Record<string, unknown>)['gamma'];
    }
  });

  it('is a silent no-op when no declarations artifact exists', async () => {
    const rootDir = join(fixtureDir, 'missing-app');
    const before = Object.keys(globalThis).length;
    await installPluginDeclarations(rootDir);
    assert.equal(Object.keys(globalThis).length, before);
  });
});
