import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { generateFrameworkSymbolsDts } from '../../src/compiler/framework-symbol-dts.js';
import type { FrameworkSymbol } from '../../src/symbols/framework-symbols.js';
import { deriveFrameworkSymbols } from '../../src/symbols/framework-symbol-catalog-scan.js';

const ALL = { mode: 'all' } as const;
import { jsails } from '../../src/internal/jsails-namespace.js';

/** The repo root, so the scan reads the framework's own `src/` barrels. */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('generateFrameworkSymbolsDts', () => {
  it('emits a script (no top-level import/export) so the namespace is global', () => {
    const dts = generateFrameworkSymbolsDts({
      globals: deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL }),
    });
    assert.match(dts, /declare namespace jsails \{/);
    // A top-level `import`/`export` would make this a module and the namespace
    // module-scoped, not global.
    assert.doesNotMatch(dts, /^import /m);
    assert.doesNotMatch(dts, /^export /m);
  });

  it('declares every runtime decorator key so the two never drift', () => {
    const dts = generateFrameworkSymbolsDts({
      globals: deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL }),
    });
    for (const key of Object.keys(jsails)) {
      // Non-reserved methods emit `  key(...)`; the reserved `enum` emits the
      // string-literal form `["enum"](...)`, which no regex needle `key(` would
      // match. Both still carry the key so a single substring assertion covers
      // the drift check with a per-key needle.
      const needle = key === 'enum' ? '["enum"](' : `${key}(`;
      assert.ok(dts.includes(needle), `missing declaration for ${key}`);
    }
  });

  it('declares every catalog name that wins its bare slot', () => {
    const catalog = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    const dts = generateFrameworkSymbolsDts({ globals: catalog });
    // A name that collides is declared once (first-in-order bare winner) plus a
    // namespace object; a unique name is declared once. So every distinct name
    // appears as a value declaration.
    const names = new Set(catalog.map((entry) => entry.name));
    for (const name of names) {
      assert.match(
        dts,
        new RegExp(`declare const ${name}: `),
        `missing value declaration for ${name}`,
      );
    }
    // Type side rides the value side: `declare type NAME = import(spec).NAME`.
    for (const { name, specifier } of catalog) {
      const escaped = specifier.replace(/[/]/g, '\\/');
      assert.match(
        dts,
        new RegExp(`import\\('${escaped}'\\)\\.${name};`),
        `missing import reference for ${name} from ${specifier}`,
      );
    }
  });

  it('is deterministic', () => {
    const globals = deriveFrameworkSymbols({ rootDir: repoRoot, declaration: ALL });
    assert.equal(
      generateFrameworkSymbolsDts({ globals }),
      generateFrameworkSymbolsDts({ globals }),
    );
  });

  it('emits no namespace object for a collision-free table', () => {
    const globals: readonly FrameworkSymbol[] = [
      { name: 'alpha', specifier: 'testns/a', target: 'both' },
      { name: 'beta', specifier: 'testns/b', target: 'both' },
    ];
    const dts = generateFrameworkSymbolsDts({ globals });
    // No `declare const NAME: {` object type is emitted — only bare pairs.
    assert.doesNotMatch(dts, /declare const [A-Za-z_$][\w$]*: \{/);
  });

  it('emits a real namespace object type on collision, never a dotted key', () => {
    const globals: readonly FrameworkSymbol[] = [
      { name: 'sharedThing', specifier: 'testns/first', target: 'both' },
      { name: 'sharedThing', specifier: 'testns/second', target: 'both' },
    ];
    const dts = generateFrameworkSymbolsDts({ globals });

    // Bare split pair only for the first-in-order entry (the runtime bare-slot
    // winner). The second entry's bare pair must not be declared.
    assert.match(dts, /declare const sharedThing: typeof import\('testns\/first'\)\.sharedThing;/);
    assert.match(dts, /declare type sharedThing = import\('testns\/first'\)\.sharedThing;/);
    assert.doesNotMatch(
      dts,
      /declare const sharedThing: typeof import\('testns\/second'\)\.sharedThing;/,
    );

    // Real namespace object types, reachable as `first.sharedThing` /
    // `second.sharedThing` — a real object type, not a dotted property name.
    assert.match(
      dts,
      /declare const first: \{\n  sharedThing: typeof import\('testns\/first'\)\.sharedThing;\n\};/,
    );
    assert.match(
      dts,
      /declare const second: \{\n  sharedThing: typeof import\('testns\/second'\)\.sharedThing;\n\};/,
    );
    assert.doesNotMatch(dts, /first\.sharedThing/);
    assert.doesNotMatch(dts, /second\.sharedThing/);
  });

  it('keeps the file a script and the decorator namespace on a collision table', () => {
    const globals: readonly FrameworkSymbol[] = [
      { name: 'sharedThing', specifier: 'testns/first', target: 'both' },
      { name: 'sharedThing', specifier: 'testns/second', target: 'both' },
    ];
    const dts = generateFrameworkSymbolsDts({ globals });
    assert.match(dts, /declare namespace jsails \{/);
    assert.doesNotMatch(dts, /^import /m);
    assert.doesNotMatch(dts, /^export /m);
  });

  it('is deterministic under collision', () => {
    const globals: readonly FrameworkSymbol[] = [
      { name: 'sharedThing', specifier: 'testns/first', target: 'both' },
      { name: 'sharedThing', specifier: 'testns/second', target: 'both' },
    ];
    assert.equal(
      generateFrameworkSymbolsDts({ globals }),
      generateFrameworkSymbolsDts({ globals }),
    );
  });
});
