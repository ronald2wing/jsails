/**
 * The `'use server'` Vite/Rolldown plugin: a thin `transform` wrapper over the
 * pure {@link stripServerDirectives} rewrite.
 *
 * Construction is inert and bundler-agnostic: the returned object is
 * structurally compatible with any bundler exposing an `enforce`/`transform`
 * hook pair, and imports no bundler code. It runs `enforce: 'pre'` so the strip
 * happens before any other transform sees the server bodies, and only on client
 * builds — the server build keeps the real implementations.
 *
 * Pair it with `cleanBundlePlugin`: this transform neutralizes function-level
 * directives in mixed modules; `cleanBundlePlugin` is the belt-and-suspenders
 * assertion that a `*.server.ts` module never reaches a client chunk at all.
 */

import { stripServerDirectives } from './server-directive.js';

/** Options for {@link serverDirectivePlugin}. */
export interface ServerDirectivePluginOptions {
  /**
   * Extensions the transform applies to. Defaults to the TypeScript/JSX set the
   * authoring surface uses (`.ts`, `.tsx`, `.mts`, `.mtsx`, `.jsx`, `.js`).
   */
  readonly include?: readonly string[];
  /**
   * When `true`, the transform is skipped entirely (e.g. a server build that
   * must keep the real bodies). Defaults to `false` so a client build is safe
   * unless it explicitly opts out.
   */
  readonly server?: boolean;
}

const DEFAULT_INCLUDE = Object.freeze(['.ts', '.tsx', '.mts', '.mtsx', '.jsx', '.js']);

/** The synthetic id Vite passes for CSS/asset requests that must never be parsed. */
const CSS_QUERY = /\.(css|scss|sass|less|styl)(\?|$)/i;

/** True when `id` (a Vite module id, possibly with a query) matches one of the extensions. */
function applies(id: string, include: readonly string[]): boolean {
  if (CSS_QUERY.test(id)) {
    return false;
  }
  const clean = id.split('?')[0] ?? id;
  return include.some((extension) => clean.endsWith(extension));
}

/**
 * Build the plugin. `transform` returns `null` when nothing was marked so the
 * bundler skips its own re-parse; otherwise it returns the rewritten code with a
 * source map of `null` (the transform does not track positions — callers that
 * need maps should run it before map-generating transforms, which `enforce:
 * 'pre'` guarantees).
 */
export function serverDirectivePlugin(options: ServerDirectivePluginOptions = {}): {
  name: string;
  enforce: 'pre';
  transform(code: string, id: string): { code: string; map: null } | null;
} {
  const include = options.include ?? DEFAULT_INCLUDE;
  const isServer = options.server === true;

  return {
    name: 'jsails-use-server-directive',
    enforce: 'pre',
    transform(code, id) {
      if (isServer || !applies(id, include)) {
        return null;
      }
      const result = stripServerDirectives(code, id);
      if (!result.hadDirective) {
        return null;
      }
      return { code: result.code, map: null };
    },
  };
}
