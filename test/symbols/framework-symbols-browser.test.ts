import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FrameworkSymbolOverrideWarning } from '../../src/symbols/projection.js';
import {
  browserSymbolSpecifiers,
  installBrowserSymbols,
} from '../../src/symbols/install-browser.js';

describe('browser framework symbols', () => {
  it('projects only browser-safe subpaths, never a server subpath', () => {
    const serverOnly = [
      'jsails/database',
      'jsails/blog',
      'jsails/flags',
      'jsails/sessions',
      'jsails/admin',
      'jsails/jobs',
      'jsails/server-components',
    ];
    for (const specifier of serverOnly) {
      assert.ok(
        !browserSymbolSpecifiers().includes(specifier),
        `${specifier} must not be browser-projected`,
      );
    }
  });

  it('browser specifiers are sorted and de-duplicated', () => {
    const specifiers = browserSymbolSpecifiers();
    assert.deepEqual(specifiers, [...specifiers].sort());
    assert.equal(new Set(specifiers).size, specifiers.length);
  });

  it('installs every browser symbol onto globalThis with no missing loader', async () => {
    // installBrowserSymbols throws on a specifier with no loader; a clean run
    // proves the literal import map covers the browser-safe set, and every
    // projected name lands on globalThis.
    const warnings: FrameworkSymbolOverrideWarning[] = [];
    await installBrowserSymbols({ onWarn: (warning) => warnings.push(warning) });
    for (const specifier of browserSymbolSpecifiers()) {
      const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
      for (const name of Object.keys(module)) {
        if (name === 'default') {
          continue;
        }
        assert.notEqual(
          (globalThis as Record<string, unknown>)[name],
          undefined,
          `${specifier}:${name} was not installed`,
        );
      }
    }
  });

  it('is idempotent: a second install produces no override warnings', async () => {
    await installBrowserSymbols({ onWarn: () => {} });
    const warnings: FrameworkSymbolOverrideWarning[] = [];
    await installBrowserSymbols({ onWarn: (warning) => warnings.push(warning) });
    assert.deepEqual(warnings, []);
  });
});
