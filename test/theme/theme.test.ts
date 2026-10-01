/**
 * Theme token contract tests: ordered-fold resolution, same-name spread-merge,
 * seed derivation, CSS serialization with data-theme blocks, the themePlugin
 * service, and the browser-safe guarantee.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions, type ExtensionRuntime } from '../../src/extensions/index.js';
import {
  coreThemeTokenNames,
  createThemeTokens,
  deriveThemeTokens,
  resolveThemeTokens,
  themeTokensToCss,
  ThemeError,
  type ThemeContribution,
  type ThemeTokenMap,
  type ThemeTokens,
} from '../../src/theme/tokens.js';
import { themePlugin, themeToken, type ThemePluginOptions } from '../../src/theme/plugin.js';

// ---------------------------------------------------------------------------
// Core token set
// ---------------------------------------------------------------------------

describe('coreThemeTokenNames', () => {
  it('is a frozen, non-empty readonly array', () => {
    assert.ok(Array.isArray(coreThemeTokenNames));
    assert.ok(coreThemeTokenNames.length > 0);
    assert.throws(() => {
      (coreThemeTokenNames as string[]).push('--jsails-extra');
    }, /not.*extensible|read.only|not.*function|frozen/);
  });

  it('every entry is a CSS custom property name', () => {
    for (const name of coreThemeTokenNames) {
      assert.match(name, /^--jsails-[a-z]/);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveThemeTokens — ordered fold
// ---------------------------------------------------------------------------

describe('resolveThemeTokens', () => {
  const APP: ThemeTokenMap = Object.freeze({
    '--jsails-bg': '#000000',
    '--jsails-fg': '#ffffff',
  });

  const PLUGIN_A: ThemeContribution = {
    source: 'plugin-a',
    tokens: Object.freeze({
      '--jsails-accent': '#ff0000',
      '--jsails-muted': '#888888',
    }),
  };

  const PLUGIN_B: ThemeContribution = {
    source: 'plugin-b',
    tokens: Object.freeze({
      '--jsails-border': '#333333',
      '--jsails-extra': '#cccccc',
    }),
  };

  it('returns app tokens when there are no layers', () => {
    const result = resolveThemeTokens(APP, []);
    assert.deepStrictEqual(result.active, APP);
    assert.ok(Object.isFrozen(result.active));
    assert.deepStrictEqual(result.themes, {});
    assert.equal(result.activeName, undefined);
  });

  it('returns an empty frozen object for empty app and no layers', () => {
    const result = resolveThemeTokens({}, []);
    assert.deepStrictEqual(result.active, {});
    assert.ok(Object.isFrozen(result.active));
  });

  it('app layer wins over any plugin layer that sets the same key', () => {
    const plugin: ThemeContribution = {
      source: 'override',
      tokens: Object.freeze({ '--jsails-bg': '#plugin-bg' }),
    };
    const result = resolveThemeTokens(APP, [plugin]);
    assert.equal(result.active['--jsails-bg'], '#000000');
  });

  it('plugin layers fill keys the app did not set', () => {
    const result = resolveThemeTokens(APP, [PLUGIN_A, PLUGIN_B]);
    assert.equal(result.active['--jsails-bg'], '#000000'); // app
    assert.equal(result.active['--jsails-fg'], '#ffffff'); // app
    assert.equal(result.active['--jsails-accent'], '#ff0000'); // plugin-a
    assert.equal(result.active['--jsails-muted'], '#888888'); // plugin-a
    assert.equal(result.active['--jsails-border'], '#333333'); // plugin-b
    assert.equal(result.active['--jsails-extra'], '#cccccc'); // plugin-b
  });

  it('two plugins setting the same key fold later-wins (no error)', () => {
    const a: ThemeContribution = {
      source: 'plugin-a',
      tokens: Object.freeze({ '--jsails-accent': '#red' }),
    };
    const b: ThemeContribution = {
      source: 'plugin-b',
      tokens: Object.freeze({ '--jsails-accent': '#blue' }),
    };
    const result = resolveThemeTokens({}, [a, b]);
    assert.equal(result.active['--jsails-accent'], '#blue'); // later wins
  });

  it('app resolves any collision trivially', () => {
    const a: ThemeContribution = {
      source: 'plugin-a',
      tokens: Object.freeze({ '--jsails-bg': '#plugin-bg' }),
    };
    const b: ThemeContribution = {
      source: 'plugin-b',
      tokens: Object.freeze({ '--jsails-bg': '#other-bg' }),
    };
    const result = resolveThemeTokens({ '--jsails-bg': '#app-bg' }, [a, b]);
    assert.equal(result.active['--jsails-bg'], '#app-bg');
  });

  it('returns a frozen active map', () => {
    const result = resolveThemeTokens(APP, [PLUGIN_A]);
    assert.throws(() => {
      (result.active as Record<string, string>)['new'] = 'oops';
    });
  });
});

// ---------------------------------------------------------------------------
// Same-name spread-merge
// ---------------------------------------------------------------------------

describe('same-name contributions', () => {
  it('two contributions with the same name spread-merge later-wins', () => {
    const a: ThemeContribution = {
      source: 'lib-a',
      name: 'dark',
      tokens: Object.freeze({ '--jsails-bg': '#000', '--jsails-fg': '#fff' }),
    };
    const b: ThemeContribution = {
      source: 'lib-b',
      name: 'dark',
      tokens: Object.freeze({ '--jsails-bg': '#111', '--jsails-accent': '#f00' }),
    };
    const result = resolveThemeTokens({}, [a, b]);
    assert.equal(result.themes['dark']!['--jsails-bg'], '#111'); // later overrides
    assert.equal(result.themes['dark']!['--jsails-fg'], '#fff'); // from a
    assert.equal(result.themes['dark']!['--jsails-accent'], '#f00'); // from b
    assert.ok(Object.isFrozen(result.themes));
  });

  it('same-name spread-merge works with three contributions', () => {
    const a: ThemeContribution = {
      source: 'a',
      name: 'theme',
      tokens: Object.freeze({ a: '1' }),
    };
    const b: ThemeContribution = {
      source: 'b',
      name: 'theme',
      tokens: Object.freeze({ b: '2' }),
    };
    const c: ThemeContribution = {
      source: 'c',
      name: 'theme',
      tokens: Object.freeze({ a: '3' }),
    };
    const result = resolveThemeTokens({}, [a, b, c]);
    assert.equal(result.themes['theme']!['a'], '3'); // c overrides a
    assert.equal(result.themes['theme']!['b'], '2'); // b
  });

  it('themes map is frozen', () => {
    const a: ThemeContribution = {
      source: 'a',
      name: 'myt',
      tokens: Object.freeze({ k: 'v' }),
    };
    const result = resolveThemeTokens({}, [a]);
    assert.throws(() => {
      (result.themes as Record<string, ThemeTokenMap>)['n'] = {};
    });
  });
});

// ---------------------------------------------------------------------------
// Active named theme
// ---------------------------------------------------------------------------

describe('active named theme', () => {
  const DARK: ThemeContribution = {
    source: 'dark-lib',
    name: 'dark',
    tokens: Object.freeze({
      '--jsails-bg': '#1a1a2e',
      '--jsails-fg': '#e0e0e0',
      '--jsails-accent': '#e94560',
    }),
  };

  const LIGHT: ThemeContribution = {
    source: 'light-lib',
    name: 'light',
    tokens: Object.freeze({
      '--jsails-bg': '#ffffff',
      '--jsails-fg': '#1f2937',
      '--jsails-accent': '#3b82f6',
    }),
  };

  const UNNAMED: ThemeContribution = {
    source: 'base-plugin',
    tokens: Object.freeze({ '--jsails-radius': '0.5rem' }),
  };

  it('active selects a named theme and folds it into the active map', () => {
    const result = resolveThemeTokens({}, [DARK, LIGHT], { active: 'dark' });
    assert.equal(result.active['--jsails-bg'], '#1a1a2e');
    assert.equal(result.active['--jsails-fg'], '#e0e0e0');
    assert.equal(result.active['--jsails-accent'], '#e94560');
    assert.equal(result.activeName, 'dark');
  });

  it('app overrides the active named theme', () => {
    const result = resolveThemeTokens({ '--jsails-bg': '#app-bg' }, [DARK, LIGHT], {
      active: 'dark',
    });
    assert.equal(result.active['--jsails-bg'], '#app-bg');
  });

  it('unnamed contributions fold before the active named theme', () => {
    const result = resolveThemeTokens({}, [UNNAMED, DARK], { active: 'dark' });
    assert.equal(result.active['--jsails-radius'], '0.5rem');
  });

  it('active named theme overrides unnamed contributions', () => {
    const unnamedWithBg: ThemeContribution = {
      source: 'plug',
      tokens: Object.freeze({ '--jsails-bg': '#plug-bg' }),
    };
    const result = resolveThemeTokens({}, [unnamedWithBg, DARK], { active: 'dark' });
    // dark is step 3 (after unnamed), so it wins.
    assert.equal(result.active['--jsails-bg'], '#1a1a2e');
  });

  it('unknown active name is harmless', () => {
    const result = resolveThemeTokens({}, [DARK], { active: 'missing' });
    assert.equal(result.activeName, 'missing');
    assert.deepStrictEqual(result.active, {});
  });

  it('themes contains all named themes regardless of active', () => {
    const result = resolveThemeTokens({}, [DARK, LIGHT], { active: 'dark' });
    assert.equal(Object.keys(result.themes).length, 2);
    assert.ok(result.themes['dark']);
    assert.ok(result.themes['light']);
  });
});

// ---------------------------------------------------------------------------
// ThemeTokens service (createThemeTokens)
// ---------------------------------------------------------------------------

describe('createThemeTokens', () => {
  it('resolve returns the frozen merged map', () => {
    const tokens = createThemeTokens({ '--jsails-bg': '#app' }, []);
    const map = tokens.resolve();
    assert.equal(map['--jsails-bg'], '#app');
    assert.ok(Object.isFrozen(map));
  });

  it('toCss returns CSS with :root and per-theme blocks', () => {
    const dark: ThemeContribution = {
      source: 'dark',
      name: 'dark',
      tokens: Object.freeze({ '--jsails-bg': '#000' }),
    };
    const tokens = createThemeTokens({ '--jsails-fg': '#fff' }, [dark]);
    const css = tokens.toCss();
    assert.ok(css.includes(':root {'));
    assert.ok(css.includes('--jsails-fg: #fff;'));
    assert.ok(css.includes('[data-theme="dark"] {'));
    assert.ok(css.includes('--jsails-bg: #000;'));
  });

  it('toCss returns empty string for empty resolution', () => {
    const tokens = createThemeTokens({}, []);
    assert.equal(tokens.toCss(), '');
  });

  it('themes returns the named themes map', () => {
    const dark: ThemeContribution = {
      source: 'dark',
      name: 'dark',
      tokens: Object.freeze({ '--jsails-bg': '#000' }),
    };
    const tokens = createThemeTokens({}, [dark]);
    const themes = tokens.themes();
    assert.equal(themes['dark']!['--jsails-bg'], '#000');
    assert.ok(Object.isFrozen(themes));
  });

  it('activeName returns the active theme name or undefined', () => {
    const dark: ThemeContribution = {
      source: 'dark',
      name: 'dark',
      tokens: Object.freeze({ '--jsails-bg': '#000' }),
    };
    const a = createThemeTokens({}, [dark], { active: 'dark' });
    assert.equal(a.activeName(), 'dark');
    const b = createThemeTokens({}, [dark]);
    assert.equal(b.activeName(), undefined);
  });
});

// ---------------------------------------------------------------------------
// themeTokensToCss — per-theme blocks and hardening
// ---------------------------------------------------------------------------

describe('themeTokensToCss', () => {
  it('returns empty string for an empty resolution', () => {
    const css = themeTokensToCss({ active: {}, themes: {}, activeName: undefined });
    assert.equal(css, '');
  });

  it('emits :root for active tokens', () => {
    const css = themeTokensToCss({
      active: Object.freeze({ '--jsails-bg': '#fff' }),
      themes: {},
      activeName: undefined,
    });
    assert.equal(css, ':root { --jsails-bg: #fff; }');
  });

  it('emits [data-theme] blocks sorted by name', () => {
    const css = themeTokensToCss({
      active: Object.freeze({ '--jsails-bg': '#base' }),
      themes: Object.freeze({
        dark: Object.freeze({ '--jsails-bg': '#000' }),
        light: Object.freeze({ '--jsails-bg': '#fff' }),
      }),
      activeName: 'dark',
    });
    // Sorted alphabetically: dark before light.
    assert.ok(css.includes(':root {'));
    assert.ok(css.includes('[data-theme="dark"]'));
    assert.ok(css.includes('[data-theme="light"]'));
    const darkIdx = css.indexOf('[data-theme="dark"]');
    const lightIdx = css.indexOf('[data-theme="light"]');
    assert.ok(darkIdx < lightIdx, 'dark block must come before light block');
  });

  it('rejects a value containing </style', () => {
    assert.throws(
      () =>
        themeTokensToCss({
          active: Object.freeze({ '--jsails-bg': 'red</style>' }),
          themes: {},
          activeName: undefined,
        }),
      (err: unknown) => {
        if (!(err instanceof ThemeError)) return false;
        assert.equal(err.code, 'invalid_token');
        return true;
      },
    );
  });

  it('rejects a value containing a control character', () => {
    assert.throws(
      () =>
        themeTokensToCss({
          active: Object.freeze({ '--jsails-bg': 'red\u0000' }),
          themes: {},
          activeName: undefined,
        }),
      (err: unknown) => {
        if (!(err instanceof ThemeError)) return false;
        assert.equal(err.code, 'invalid_token');
        return true;
      },
    );
  });

  it('sorts declarations deterministically by insertion order', () => {
    const css = themeTokensToCss({
      active: Object.freeze({
        '--jsails-bg': '#000',
        '--jsails-fg': '#fff',
        '--jsails-accent': '#f00',
      }),
      themes: {},
      activeName: undefined,
    });
    assert.ok(css.includes('--jsails-bg: #000;'));
    assert.ok(css.includes('--jsails-fg: #fff;'));
    assert.ok(css.includes('--jsails-accent: #f00;'));
  });

  it('skips [data-theme] blocks for empty named themes', () => {
    const css = themeTokensToCss({
      active: Object.freeze({ '--jsails-bg': '#base' }),
      themes: Object.freeze({
        empty: Object.freeze({}),
      }),
      activeName: undefined,
    });
    assert.ok(!css.includes('[data-theme="empty"]'));
  });
});

// ---------------------------------------------------------------------------
// deriveThemeTokens — seed derivation
// ---------------------------------------------------------------------------

describe('deriveThemeTokens', () => {
  it('sets --jsails-accent to primary', () => {
    const tokens = deriveThemeTokens({ primary: '#ff0000' });
    assert.equal(tokens['--jsails-accent'], '#ff0000');
  });

  it('derives all five core tokens as non-empty strings from a hex', () => {
    const tokens = deriveThemeTokens({ primary: '#3b82f6' });
    for (const name of coreThemeTokenNames) {
      assert.equal(typeof tokens[name], 'string');
      assert.ok(tokens[name]!.length > 0, `${name} must be non-empty`);
    }
  });

  it('returns a frozen map', () => {
    const tokens = deriveThemeTokens({ primary: '#ff0000' });
    assert.ok(Object.isFrozen(tokens));
  });

  it('throws ThemeError invalid_token for empty primary', () => {
    assert.throws(
      () => deriveThemeTokens({ primary: '' }),
      (err: unknown) => {
        if (!(err instanceof ThemeError)) return false;
        assert.equal(err.code, 'invalid_token');
        return true;
      },
    );
  });

  it('throws ThemeError invalid_token for primary with control char', () => {
    assert.throws(
      () => deriveThemeTokens({ primary: 'red\u0000' }),
      (err: unknown) => {
        if (!(err instanceof ThemeError)) return false;
        assert.equal(err.code, 'invalid_token');
        return true;
      },
    );
  });

  it('accepts non-hex primary and provides neutral defaults', () => {
    const tokens = deriveThemeTokens({ primary: 'red' });
    assert.equal(tokens['--jsails-accent'], 'red');
    assert.equal(tokens['--jsails-bg'], '#ffffff');
    assert.equal(tokens['--jsails-fg'], '#1f2937');
  });

  it('adds --jsails-radius when radius is set', () => {
    const tokens = deriveThemeTokens({ primary: '#ff0000', radius: '0.5rem' });
    assert.equal(tokens['--jsails-radius'], '0.5rem');
  });

  it('does not add --jsails-radius when radius is absent', () => {
    const tokens = deriveThemeTokens({ primary: '#ff0000' });
    assert.equal(tokens['--jsails-radius'], undefined);
  });
});

// ---------------------------------------------------------------------------
// themePlugin — service registration
// ---------------------------------------------------------------------------

async function setupThemePlugin(
  options: ThemePluginOptions = {},
): Promise<{ runtime: ExtensionRuntime; tokens: ThemeTokens }> {
  const runtime = await runExtensions([themePlugin(options)]);
  const tokens = runtime.services.get(themeToken);
  return { runtime, tokens };
}

describe('themePlugin', () => {
  it('provides under themeToken with an empty map by default', async () => {
    const { tokens, runtime } = await setupThemePlugin();
    assert.deepStrictEqual(tokens.resolve(), {});
    assert.equal(tokens.toCss(), '');
    assert.equal(tokens.activeName(), undefined);
    await runtime.close();
  });

  it('provides app-level tokens', async () => {
    const { tokens, runtime } = await setupThemePlugin({
      tokens: { '--jsails-bg': '#000' },
    });
    assert.equal(tokens.resolve()['--jsails-bg'], '#000');
    await runtime.close();
  });

  it('merges app tokens with plugin contributions', async () => {
    const { tokens, runtime } = await setupThemePlugin({
      tokens: { '--jsails-bg': '#app-bg' },
      contributions: [
        {
          source: 'plugin-x',
          tokens: { '--jsails-accent': '#plugin-accent' },
        },
      ],
    });
    const map = tokens.resolve();
    assert.equal(map['--jsails-bg'], '#app-bg');
    assert.equal(map['--jsails-accent'], '#plugin-accent');
    await runtime.close();
  });

  it('supports active named theme', async () => {
    const { tokens, runtime } = await setupThemePlugin({
      contributions: [
        {
          source: 'my-theme',
          name: 'dark',
          tokens: { '--jsails-bg': '#000' },
        },
      ],
      active: 'dark',
    });
    const map = tokens.resolve();
    assert.equal(map['--jsails-bg'], '#000');
    assert.equal(tokens.activeName(), 'dark');
    await runtime.close();
  });

  it('a second themePlugin is rejected at setup (duplicate provide)', async () => {
    await assert.rejects(runExtensions([themePlugin(), themePlugin()]), (err: unknown) => {
      if (!(err instanceof Error)) return false;
      assert.match(err.message, /theme/);
      return true;
    });
  });

  it('rejects non-object options eagerly', () => {
    assert.throws(() => {
      themePlugin(null as never);
    }, TypeError);
    assert.throws(() => {
      themePlugin('bad' as never);
    }, TypeError);
  });
});

// ---------------------------------------------------------------------------
// Browser-safe: no node:* imports in src/theme/*
// ---------------------------------------------------------------------------

describe('browser-safe guarantee', () => {
  it('src/theme/tokens.ts imports nothing from node:*', async () => {
    const mod = await import('../../src/theme/tokens.js');
    assert.equal(typeof mod.resolveThemeTokens, 'function');
    assert.equal(typeof mod.createThemeTokens, 'function');
    assert.equal(typeof mod.themeTokensToCss, 'function');
    assert.equal(typeof mod.deriveThemeTokens, 'function');
    assert.ok(Array.isArray(mod.coreThemeTokenNames));
    assert.equal(typeof mod.ThemeError, 'function');
  });

  it('src/theme/plugin.ts has no node:* specifiers in source', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../../../src/theme/plugin.ts', import.meta.url),
      'utf-8',
    );
    const importLines = source.split('\n').filter((line) => /^import\s/.test(line));
    const nodeImports = importLines.filter((line) => line.includes('node:'));
    assert.deepStrictEqual(nodeImports, [], 'plugin.ts must not import node:*');
  });

  it('src/theme/tokens.ts has no node:* specifiers in source', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../../../src/theme/tokens.ts', import.meta.url),
      'utf-8',
    );
    const importLines = source.split('\n').filter((line) => /^import\s/.test(line));
    const nodeImports = importLines.filter((line) => line.includes('node:'));
    assert.deepStrictEqual(nodeImports, [], 'tokens.ts must not import node:*');
  });

  it('src/theme/index.ts has no node:* specifiers in source', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../../src/theme/index.ts', import.meta.url), 'utf-8');
    const importLines = source
      .split('\n')
      .filter((line) => /^import\s/.test(line) || /^export\s.*from/.test(line));
    const nodeImports = importLines.filter((line) => line.includes('node:'));
    assert.deepStrictEqual(nodeImports, [], 'index.ts must not import node:*');
  });
});
