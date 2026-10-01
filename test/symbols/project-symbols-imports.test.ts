import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  AutoloadContext,
  AutoloadSymbol,
  AutoloadSymbolIndex,
} from '../../src/compiler/project-symbols-scan.js';
import {
  AutoloadInjectionError,
  injectAutoloadImports,
} from '../../src/compiler/project-symbols-imports.js';

/** Build a symbol index from `[name, context, absoluteFile]` triples. */
function index(
  entries: readonly (readonly [string, AutoloadContext, string])[],
): AutoloadSymbolIndex {
  const byName = new Map<string, Map<AutoloadContext, AutoloadSymbol>>();
  for (const [name, context, file] of entries) {
    let contexts = byName.get(name);
    if (contexts === undefined) {
      contexts = new Map();
      byName.set(name, contexts);
    }
    contexts.set(context, { name, context, file });
  }
  return byName;
}

const APP_INDEX = index([
  ['useCounter', 'app', '/proj/app/composables/use-counter.ts'],
  ['formatDate', 'app', '/proj/app/utils/format-date.ts'],
  ['useStep', 'app', '/proj/app/composables/use-counter.ts'],
  ['serverOnlyFn', 'server', '/proj/server/utils/server-only-fn.ts'],
]);

describe('injectAutoloadImports', () => {
  it('prepends an import for a single free app symbol', () => {
    const result = injectAutoloadImports('console.log(useCounter());', {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });

    assert.ok(result);
    assert.equal(
      result.code,
      "import { useCounter } from '../composables/use-counter.js';\nconsole.log(useCounter());",
    );
    assert.deepEqual(result.injected, [
      { symbol: 'useCounter', from: '../composables/use-counter.js' },
    ]);
  });

  it('groups multiple symbols from the same module into one import', () => {
    const result = injectAutoloadImports('console.log(useCounter(), useStep());', {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });

    assert.ok(result);
    assert.equal(
      result.code,
      "import { useCounter, useStep } from '../composables/use-counter.js';\nconsole.log(useCounter(), useStep());",
    );
  });

  it('emits one import per distinct module, sorted by specifier', () => {
    const result = injectAutoloadImports('console.log(useCounter(), formatDate());', {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });

    assert.ok(result);
    assert.equal(
      result.code,
      "import { formatDate } from '../utils/format-date.js';\n" +
        "import { useCounter } from '../composables/use-counter.js';\n" +
        'console.log(useCounter(), formatDate());',
    );
  });

  it('merges a new symbol into an existing import of the same module', () => {
    const code =
      "import { useCounter } from '../composables/use-counter.js';\nconsole.log(useCounter(), useStep());";
    const result = injectAutoloadImports(code, {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });

    assert.ok(result);
    assert.equal(
      result.code,
      "import { useCounter, useStep } from '../composables/use-counter.js';\nconsole.log(useCounter(), useStep());",
    );
    assert.deepEqual(result.injected, [
      { symbol: 'useStep', from: '../composables/use-counter.js' },
    ]);
  });

  it('returns null when every free symbol is already imported (idempotence)', () => {
    const code =
      "import { useCounter } from '../composables/use-counter.js';\nconsole.log(useCounter());";
    const result = injectAutoloadImports(code, {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });

    assert.equal(result, null);
  });

  it('is idempotent across two passes', () => {
    const first = injectAutoloadImports('console.log(useCounter(), formatDate());', {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });
    assert.ok(first);

    const second = injectAutoloadImports(first.code, {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });
    assert.equal(second, null);
  });

  it('returns null when no free symbol matches the index', () => {
    const result = injectAutoloadImports('console.log(unknownThing());', {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });

    assert.equal(result, null);
  });

  it('refuses a server-only symbol in the app context', () => {
    const result = injectAutoloadImports('console.log(serverOnlyFn());', {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });

    assert.equal(result, null);
  });

  it('injects a server-only symbol in the server context', () => {
    const result = injectAutoloadImports('console.log(serverOnlyFn());', {
      fileName: '/proj/server/api/foo.ts',
      symbols: APP_INDEX,
      context: 'server',
    });

    assert.ok(result);
    assert.equal(
      result.code,
      "import { serverOnlyFn } from '../utils/server-only-fn.js';\nconsole.log(serverOnlyFn());",
    );
  });

  it('rewrites a .tsx source extension to .js', () => {
    const tsxIndex = index([['Widget', 'app', '/proj/app/components/widget.tsx']]);
    const result = injectAutoloadImports('console.log(Widget);', {
      fileName: '/proj/app/pages/index.tsx',
      symbols: tsxIndex,
      context: 'app',
    });

    assert.ok(result);
    assert.match(result.code, /from '\.\.\/components\/widget\.js'/);
  });

  it('rewrites a .mts source extension to .mjs', () => {
    const mtsIndex = index([['helper', 'app', '/proj/app/utils/helper.mts']]);
    const result = injectAutoloadImports('console.log(helper);', {
      fileName: '/proj/app/pages/index.tsx',
      symbols: mtsIndex,
      context: 'app',
    });

    assert.ok(result);
    assert.match(result.code, /from '\.\.\/utils\/helper\.mjs'/);
  });

  it('throws a value-free error for unparseable source', () => {
    assert.throws(
      () =>
        injectAutoloadImports('const = ;', {
          fileName: '/proj/app/pages/broken.tsx',
          symbols: APP_INDEX,
          context: 'app',
        }),
      (error: unknown) => {
        assert.ok(error instanceof AutoloadInjectionError);
        assert.equal(error.code, 'unparseable');
        assert.match(error.message, /could not parse/);
        // The message must not echo the source text.
        assert.doesNotMatch(error.message, /const = ;/);
        return true;
      },
    );
  });

  it('does not inject a symbol that is locally declared', () => {
    const result = injectAutoloadImports('const useCounter = () => 1; console.log(useCounter());', {
      fileName: '/proj/app/pages/index.tsx',
      symbols: APP_INDEX,
      context: 'app',
    });

    assert.equal(result, null);
  });
});
