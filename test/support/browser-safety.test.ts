import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertBrowserSafeSubpathsBundleable,
  declaredBrowserSafeSubpaths,
} from '../../src/symbols/framework-symbol-catalog-scan.js';
import { browserSymbolSpecifiers } from '../../src/symbols/install-browser.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const supportBarrel = resolve(repoRoot, 'src/support/index.ts');

/**
 * Collect every `node:` builtin specifier reachable from `entry` through static
 * relative imports. This is an independent guard: it reads the source graph
 * directly rather than trusting the framework's own browser-safety scanner, so a
 * regression in the scanner cannot hide a regression in the barrel.
 */
function collectNodeSpecifiers(entry: string, seen = new Set<string>()): string[] {
  const abs = resolve(entry);
  if (seen.has(abs)) return [];
  seen.add(abs);

  const source = readFileSync(abs, 'utf8');
  const specifiers = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((specifier): specifier is string => specifier !== undefined);
  const nodeSpecifiers = specifiers.filter((specifier) => specifier.startsWith('node:'));

  const relative = specifiers
    .filter((specifier) => specifier.startsWith('./') || specifier.startsWith('../'))
    .map((specifier) => resolve(dirname(abs), specifier).replace(/\.js$/, '.ts'));

  for (const path of relative) {
    nodeSpecifiers.push(...collectNodeSpecifiers(path, seen));
  }
  return nodeSpecifiers;
}

describe('jsails/support browser boundary', () => {
  it('declares jsails/support and excludes the server addendum', () => {
    const declared = declaredBrowserSafeSubpaths();
    assert.ok(declared.includes('jsails/support'));
    assert.ok(!declared.includes('jsails/support/server'));
  });

  it('the browser barrel and its transitive static imports are node-free', () => {
    const offenders = [...new Set(collectNodeSpecifiers(supportBarrel))];
    assert.deepEqual(
      offenders,
      [],
      `browser barrel reaches node builtins: ${offenders.join(', ')}`,
    );
  });

  it('the browser barrel is bundleable and the installer map covers the declaration', () => {
    assert.deepEqual(assertBrowserSafeSubpathsBundleable({ rootDir: repoRoot }), []);
    assert.deepEqual(browserSymbolSpecifiers(), declaredBrowserSafeSubpaths());
  });
});
