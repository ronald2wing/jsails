/**
 * Site-level constants.
 *
 * Plain data with no Node built-ins and no `jsails/content` import, so it is
 * safe in every graph: the server pages, the browser client typecheck
 * (`tsconfig.client.json`, which follows the import from `ui/`), and the
 * build-time feed script (`scripts/generate-feeds.mjs`).
 *
 * This module lives under `shared/`, so it is autoloaded: the build publishes
 * `site` onto `globalThis` and the feed script reads it by bare name. Modules
 * that need it at type-check time (`ui/layout.tsx`) still import it explicitly.
 *
 * Keeping the title and description here means the document shell, the feed,
 * and the sitemap all read one source of truth.
 */

/** Site title and one-line description. */
export const site = {
  title: 'The JSails Blog',
  description: 'Notes on building small, typed, static-first web software.',
} as const;
