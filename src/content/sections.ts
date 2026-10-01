/**
 * Section tree (`jsails/content`).
 *
 * `defineSections` derives a pure, routing-agnostic section hierarchy from page
 * slugs. Taxonomies are flat sets; sections are a genuine tree materialised from
 * the existing nested-slug data. Ghost nodes fill intermediate segments, index
 * pages are detected deterministically, and every array/node/tree is frozen.
 *
 * It stops at data — it does NOT render nested URLs (a `[slug]` param cannot
 * carry `/` in the current router).
 */

import { ContentError } from './errors.js';
import type {
  ContentCollection,
  ContentCollectionDescriptor,
  ContentPage,
} from './content-model.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One node in the section tree. */
export interface SectionNode<Data = Record<string, unknown>> {
  readonly slug: string; // full dotted path ('' for root)
  readonly title: string; // index title, else title-cased last segment ('' for root)
  readonly page?: ContentPage<Data>; // matching index page, when one exists
  readonly children: readonly SectionNode<Data>[]; // child sections, sorted
  readonly pages: readonly ContentPage<Data>[]; // non-index pages directly in this section, sorted
}

/** Options for {@link defineSections}. */
export interface DefineSectionsOptions {
  readonly rootTitle?: string; // default ''
  readonly titleCaseFallback?: boolean; // default true
}

/** The frozen section tree with lookup helpers. */
export interface SectionTree<Data = Record<string, unknown>> {
  readonly root: SectionNode<Data>;
  getSection(slug: string): SectionNode<Data> | undefined; // '' returns root
  breadcrumb(slug: string): readonly SectionNode<Data>[]; // ancestors outermost-first, excluding root
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build a frozen section tree from a content collection's pages.
 *
 * The tree is derived purely from slugs — no I/O, no rendering. Every
 * array and node is frozen; the returned tree is immutable.
 */
export function defineSections<Data = Record<string, unknown>>(
  collection: ContentCollection<Data> | ContentCollectionDescriptor<Data>,
  options?: DefineSectionsOptions,
): SectionTree<Data> {
  const rootTitle = options?.rootTitle ?? '';
  const titleCase = options?.titleCaseFallback !== false;

  if (!Array.isArray(collection.pages)) {
    throw new ContentError('invalid_collection', 'Section collection must have pages');
  }

  // 1. Collect section paths from every non-draft page's slug.
  const pages = collection.pages;
  const sectionPaths = new Set<string>();

  for (const page of pages) {
    if (page.draft) continue;

    const segments = page.slug.split('/').filter((s: string) => s.length > 0);
    // Every proper prefix of the slug is a section path.
    for (let k = 1; k < segments.length; k++) {
      sectionPaths.add(segments.slice(0, k).join('/'));
    }
  }

  // 2. Attach index pages.
  // Index candidates come from two forms:
  //   a) a page whose slug IS a section path (e.g. `docs.md` → `docs`)
  //   b) a page whose last segment is `index` (e.g. `docs/index.md` → `docs`)
  // Last-write-wins in collection order (deterministic).
  const indexByPath = new Map<string, ContentPage<Data>>();

  for (const page of pages) {
    if (page.draft) continue;

    const segments = page.slug.split('/').filter((s: string) => s.length > 0);
    const last = segments.length > 0 ? segments[segments.length - 1] : '';

    if (sectionPaths.has(page.slug)) {
      // Form (a): the slug itself is a section path.
      indexByPath.set(page.slug, page);
    } else if (segments.length >= 2 && last === 'index') {
      // Form (b): `<parent>/index` is an index for `<parent>`.
      const parentPath = segments.slice(0, -1).join('/');
      indexByPath.set(parentPath, page);
    }
  }

  // Collect the set of pages used as indexes so they are excluded from page
  // arrays in step 4.
  const indexPageSlugs = new Set<string>();
  for (const page of indexByPath.values()) {
    indexPageSlugs.add(page.slug);
  }

  // 3. Create one mutable node shell per section path, plus the synthetic root.
  const rootNode: MutableNode<Data> = {
    slug: '',
    title: rootTitle,
    page: undefined,
    children: [],
    pages: [],
  };

  const nodeByPath = new Map<string, MutableNode<Data>>();
  for (const path of sectionPaths) {
    nodeByPath.set(path, {
      slug: path,
      title: '', // filled in step 5
      page: indexByPath.get(path),
      children: [],
      pages: [],
    });
  }

  // 4. Place non-index pages into their section nodes.
  for (const page of pages) {
    if (page.draft) continue;
    if (indexPageSlugs.has(page.slug)) continue;

    const segments = page.slug.split('/').filter((s: string) => s.length > 0);

    if (segments.length === 1) {
      rootNode.pages.push(page);
    } else {
      const parentPath = segments.slice(0, -1).join('/');
      // The parent path must be in sectionPaths by step 1.
      const parent = nodeByPath.get(parentPath);
      if (parent) {
        parent.pages.push(page);
      }
      // A page whose parent path is not in sectionPaths (should not
      // happen given step 1) is silently dropped rather than raising.
    }
  }

  // 5. Assign titles.
  for (const [path, node] of nodeByPath) {
    if (node.page !== undefined) {
      node.title = node.page.title;
    } else {
      const lastSegment = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
      node.title = titleCase ? titleCaseSegment(lastSegment) : lastSegment;
    }
  }

  // 6. Wire parent/child links and sort.
  for (const [path, node] of nodeByPath) {
    const lastSlash = path.lastIndexOf('/');
    const parentPath = lastSlash === -1 ? '' : path.slice(0, lastSlash);
    const parent = parentPath === '' ? rootNode : nodeByPath.get(parentPath);
    if (parent) {
      parent.children.push(node);
    }
  }

  // Sort children within every node.
  sortChildren(rootNode);
  for (const node of nodeByPath.values()) {
    sortChildren(node);
    sortPages(node);
  }

  // 7. Freeze.
  for (const node of nodeByPath.values()) {
    freezeNode(node);
  }
  freezeNode(rootNode);

  // Build lookup map (root under empty string).
  const frozenByPath = new Map<string, SectionNode<Data>>();
  frozenByPath.set('', rootNode);
  for (const [path, node] of nodeByPath) {
    frozenByPath.set(path, node);
  }

  // breadcrumb helper.
  const breadcrumb = (slug: string): readonly SectionNode<Data>[] => {
    const segments = slug.split('/').filter((s) => s.length > 0);
    const ancestors: SectionNode<Data>[] = [];
    for (let k = 1; k < segments.length; k++) {
      const ancestorPath = segments.slice(0, k).join('/');
      const ancestor = frozenByPath.get(ancestorPath);
      if (ancestor) {
        ancestors.push(ancestor);
      }
    }
    return Object.freeze(ancestors);
  };

  const tree: SectionTree<Data> = {
    root: rootNode,
    getSection(slug: string): SectionNode<Data> | undefined {
      return frozenByPath.get(slug);
    },
    breadcrumb,
  };

  return Object.freeze(tree);
}

// ---------------------------------------------------------------------------
// Mutable shell (used during construction only)
// ---------------------------------------------------------------------------

interface MutableNode<Data> {
  slug: string;
  title: string;
  page?: ContentPage<Data>;
  children: MutableNode<Data>[];
  pages: ContentPage<Data>[];
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

/**
 * Sort children by: index-page `order` (undefined → Infinity) asc,
 * then `title`, then `slug`.
 */
function sortChildren<Data>(node: MutableNode<Data>): void {
  node.children.sort((a, b) => {
    const orderA = a.page?.order ?? Infinity;
    const orderB = b.page?.order ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;

    if (a.title < b.title) return -1;
    if (a.title > b.title) return 1;

    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;

    return 0;
  });
}

/**
 * Sort pages by: `order` asc, then `title`, then `slug`.
 *
 * Matches the same comparator semantics as `discover.ts` `defaultCompare`.
 */
function sortPages<Data>(node: MutableNode<Data>): void {
  node.pages.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;

    if (a.title < b.title) return -1;
    if (a.title > b.title) return 1;

    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;

    return 0;
  });
}

// ---------------------------------------------------------------------------
// Freezing helpers
// ---------------------------------------------------------------------------

function freezeNode<Data>(node: MutableNode<Data>): void {
  Object.freeze(node.children);
  Object.freeze(node.pages);
  Object.freeze(node);
}

// ---------------------------------------------------------------------------
// Title-casing helper
// ---------------------------------------------------------------------------

/**
 * Title-case the last slug segment: split on `-`/`_`, capitalise each word,
 * join with space.
 *
 * `'api-auth'` → `'Api Auth'`
 */
function titleCaseSegment(segment: string): string {
  return segment
    .split(/[-_]/)
    .map((word) => {
      // Only capitalise non-empty words.
      if (word.length === 0) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .filter((word) => word.length > 0)
    .join(' ');
}
