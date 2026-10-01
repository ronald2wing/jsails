import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { InstalledPlugin } from '../../src/symbols/autoload-resolution.js';
import { resolveAutoloadExposure } from '../../src/symbols/autoload-resolution.js';

/** Build an installed-plugin map from a concise id → { autoload?, installs? } shape. */
function graph(
  entries: Record<string, { autoload?: InstalledPlugin['autoload']; installs?: string[] }>,
  direct: string[],
): ReadonlySet<string> {
  const plugins = new Map<string, InstalledPlugin>();
  for (const [id, entry] of Object.entries(entries)) {
    plugins.set(id, { id, ...entry });
  }
  return resolveAutoloadExposure({ direct, plugins });
}

describe('resolveAutoloadExposure', () => {
  it('activates directly-installed plugins (own autoload applies)', () => {
    const active = graph({ a: { autoload: { mode: 'selected', specifiers: ['a/x'] } } }, ['a']);
    assert.deepEqual([...active], ['a']);
  });

  it('defaults to none: a directly-installed plugin with no declaration is still active but exposes nothing itself', () => {
    // Active means "its own autoload applies"; with no declaration that is `none`.
    const active = graph({ a: {} }, ['a']);
    assert.deepEqual([...active], ['a']);
  });

  it('suppresses a transitively-installed plugin that the installer does not delegate', () => {
    // meta installs a (use-without-expose): a is NOT active.
    const active = graph(
      {
        meta: { autoload: { mode: 'none' }, installs: ['a'] },
        a: { autoload: { mode: 'selected', specifiers: ['a/x'] } },
      },
      ['meta'],
    );
    assert.deepEqual([...active], ['meta']);
    assert.equal(active.has('a'), false);
  });

  it('delegates a named transitive plugin via selected.plugins', () => {
    const active = graph(
      {
        meta: { autoload: { mode: 'selected', plugins: ['a'] }, installs: ['a'] },
        a: { autoload: { mode: 'selected', specifiers: ['a/x'] } },
      },
      ['meta'],
    );
    assert.deepEqual([...active].sort(), ['a', 'meta']);
  });

  it('delegates every installed plugin under all', () => {
    const active = graph(
      {
        meta: { autoload: { mode: 'all' }, installs: ['a', 'b'] },
        a: {},
        b: {},
      },
      ['meta'],
    );
    assert.deepEqual([...active].sort(), ['a', 'b', 'meta']);
  });

  it('direct install wins over a transitive installer that suppresses', () => {
    // The app installs `a` directly AND meta installs `a` but does not delegate it.
    // Direct wins: `a` is active regardless of meta's opinion.
    const active = graph(
      {
        meta: { autoload: { mode: 'none' }, installs: ['a'] },
        a: { autoload: { mode: 'selected', specifiers: ['a/x'] } },
      },
      ['meta', 'a'],
    );
    assert.ok(active.has('a'));
  });

  it('delegation is not transitive: exposing b does not expose b.s deps', () => {
    const active = graph(
      {
        meta: { autoload: { mode: 'selected', plugins: ['b'] }, installs: ['b'] },
        b: { autoload: { mode: 'none' }, installs: ['c'] },
        c: { autoload: { mode: 'all' } },
      },
      ['meta'],
    );
    assert.ok(active.has('b'));
    assert.equal(active.has('c'), false);
  });
});
