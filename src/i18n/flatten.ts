/**
 * Flatten a single locale's catalog into dotted translation keys.
 *
 * Plural entries — a map whose keys are a non-empty subset of the CLDR plural
 * categories (`zero`/`one`/`two`/`few`/`many`/`other`) with `other` present and
 * every value a string — collapse to a single key (their parent path), because
 * `tChoice('count', n)` addresses the whole entry, not `count.one`/`count.other`.
 * Any other nested map is a namespace and its children are distinct keys.
 *
 * Pure and dependency-free (browser-safe).
 */

import type { Messages } from './translator.js';

/** CLDR plural categories recognized by {@link flattenMessageKeys}. */
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** True when `node` is a plural entry: category-only keys, `other` present, all
 *  values strings. */
function isPluralEntry(node: Messages): boolean {
  const keys = Object.keys(node);
  if (keys.length === 0 || !('other' in node)) return false;
  return (
    keys.every((key) => PLURAL_CATEGORIES.has(key)) &&
    keys.every((key) => typeof node[key] === 'string')
  );
}

/**
 * Return the dotted keys of a single locale's catalog, sorted for determinism.
 * Leaf strings become keys; plural entries become their parent key; namespaces
 * recurse. The result is the set of keys `t`/`tChoice` can address in that
 * locale.
 */
export function flattenMessageKeys(catalog: Messages): readonly string[] {
  const out: string[] = [];

  const walk = (node: Messages, prefix: string): void => {
    if (isPluralEntry(node)) {
      out.push(prefix);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof value === 'string') {
        out.push(path);
      } else {
        walk(value, path);
      }
    }
  };

  walk(catalog, '');
  return out.sort();
}
