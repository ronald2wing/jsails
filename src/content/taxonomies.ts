/**
 * Multi-taxonomy registry (`jsails/content`).
 *
 * `defineTaxonomies` defines several taxonomies over one content collection in
 * a single declarative call, so a page's `getStaticPaths()` stays a one-liner
 * (`taxonomy.get('tags').getStaticPaths()`) while every taxonomy is validated,
 * frozen, and enumerated through the same {@link defineTaxonomy} code path.
 *
 * It is a thin convenience over `defineTaxonomy`: each definition is delegated
 * verbatim, and the registry adds only name lookup and a concatenated
 * static-path enumeration (in declaration order, no dedup across taxonomies).
 */

import { ContentError } from './errors.js';
import { defineTaxonomy, type Taxonomy, type TaxonomyOrder } from './taxonomy.js';
import type { ContentCollection, ContentCollectionDescriptor } from './content-model.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One taxonomy definition inside a {@link DefineTaxonomiesOptions} registry. */
export interface TaxonomyDefinition {
  /** Registry key, used by {@link Taxonomies.get}. Must be a non-empty string. */
  readonly name: string;
  /** The frontmatter field to group by (delegated to {@link defineTaxonomy}). */
  readonly field: string;
  /** Route pattern whose single `[param]` token names the static-path key. */
  readonly route: string;
  /** Sort order, delegated to {@link defineTaxonomy}. */
  readonly order?: TaxonomyOrder;
  /** Weight frontmatter field, delegated to {@link defineTaxonomy}. */
  readonly weightField?: string;
  /** Slug frontmatter field, delegated to {@link defineTaxonomy}. */
  readonly slugField?: string;
}

/** Options for {@link defineTaxonomies}. */
export interface DefineTaxonomiesOptions<Data = Record<string, unknown>> {
  /** The shared content collection every taxonomy groups. */
  readonly collection: ContentCollection<Data> | ContentCollectionDescriptor<Data>;
  /** The taxonomies to define, in declaration order. */
  readonly taxonomies: readonly TaxonomyDefinition[];
}

/** A frozen registry of named taxonomies over one collection. */
export interface Taxonomies<Data = Record<string, unknown>> {
  /** Every taxonomy name, in declaration order. */
  readonly names: readonly string[];
  /** Look up a taxonomy by name. Returns `undefined` when not found. */
  get(name: string): Taxonomy<Data> | undefined;
  /**
   * Static-path parameter records for every taxonomy, concatenated in
   * declaration order with no dedup across taxonomies.
   */
  getStaticPaths(): readonly { term: string }[];
}

// ---------------------------------------------------------------------------
// defineTaxonomies
// ---------------------------------------------------------------------------

/**
 * Define several taxonomies over one content collection.
 *
 * ```ts
 * const taxonomy = defineTaxonomies({
 *   collection: posts,
 *   taxonomies: [
 *     { name: 'tags', field: 'tags', route: '/tags/[term]', order: 'count' },
 *     { name: 'categories', field: 'category', route: '/categories/[term]' },
 *   ],
 * });
 *
 * // In pages/tags/[term].tsx:
 * export function getStaticPaths() {
 *   return taxonomy.get('tags')!.getStaticPaths();
 * }
 * ```
 *
 * @throws {@link ContentError} for a malformed `name` (`invalid_taxonomy`), a
 *   duplicate name (`duplicate_taxonomy`), or any field/route/order error the
 *   underlying {@link defineTaxonomy} rejects (value-free).
 */
export function defineTaxonomies<Data = Record<string, unknown>>(
  options: DefineTaxonomiesOptions<Data>,
): Taxonomies<Data> {
  const byName = new Map<string, Taxonomy<Data>>();
  const names: string[] = [];

  for (const def of options.taxonomies) {
    if (typeof def.name !== 'string' || def.name.trim().length === 0) {
      throw new ContentError('invalid_taxonomy', 'Taxonomy name must be a non-empty string');
    }
    if (byName.has(def.name)) {
      throw new ContentError('duplicate_taxonomy', 'Duplicate taxonomy name');
    }
    // Field, route, order, and weight/slug fields are validated by
    // `defineTaxonomy`, so a bad definition surfaces with the same value-free
    // error it would if defined directly.
    const taxonomy = defineTaxonomy<Data>({
      collection: options.collection,
      field: def.field,
      route: def.route,
      order: def.order,
      weightField: def.weightField,
      slugField: def.slugField,
    });
    byName.set(def.name, taxonomy);
    names.push(def.name);
  }

  const registry: Taxonomies<Data> = {
    names: Object.freeze(names),
    get(name: string): Taxonomy<Data> | undefined {
      return byName.get(name);
    },
    getStaticPaths(): readonly { term: string }[] {
      const paths: { term: string }[] = [];
      for (const name of names) {
        const taxonomy = byName.get(name);
        if (taxonomy === undefined) continue;
        for (const path of taxonomy.getStaticPaths()) paths.push(path);
      }
      return paths;
    },
  };

  return Object.freeze(registry);
}
