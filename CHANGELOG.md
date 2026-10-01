# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - first release

The first public release. This section summarizes the shipped surface at a high
level — it is not exhaustive.

### Added

- Active Record data layer (`JsailsDataSource`, `BaseEntity`, `EntitySchema`) over
  MariaDB/Postgres/MySQL/SQLite, with a read-only in-memory `FileDataSource` for tests.
- Scalar, linear migration history (`makemigrations` / `migrate` / `showmigrations`)
  with value-free rollback replay of recorded operation inverses.
- Portable schema model expanded: many-to-many relations through explicit
  junction-table entities and auto-generated `@JoinTable()` junction tables;
  composite (multi-column) primary and foreign keys; deferrable foreign keys
  and unique constraints (Postgres-only; non-postgres drivers reject value-free).
- Filesystem-routed pages (Preact SSR) and Hono API routes with a static export.
- Signed, stateless server components with backend actions and Turbo soft navigation.
- Browser-safe client runtime (Turbo navigation + hydrated Preact islands).
- Extension system, first-party `auth`, `admin`, `blog`, `mail`, `filesystem`,
  `sessions`, `notifications`, and `cache` plugins, plus a two-source plugin
  enablement model.
- Long-lived, revocable auth API tokens (`apiTokens`, disabled by default) backed
  by tagged Better Auth sessions, with `Bearer` fallback resolution and the
  `POST/GET/DELETE /api/tokens` management routes.
- Admin panel `theme` option (`light`/`dark`/`system`, default `system`) and a
  plugin-manager `Plugin Settings` page (managed mode) persisted per-plugin.
- Jamal `domain add|list|remove` routing control and the
  `createOnDemandTlsAllowlist` endpoint helper for kamal-proxy on-demand TLS.
- Jamal `app <verb>` (boot/start/stop/details/containers/logs/exec) and
  `accessory <verb>` (boot/start/stop/reboot/logs/remove/details) lifecycle
  surfaces over ssh — the app verbs target the latest recorded deploy, the
  accessory verbs manage the backing-service containers; both require
  `config.production` and support `--dry-run`.
- Jamal deployment/planning CLI (local Docker Compose and production
  deploy/rollback/status/logs/exec execution).
- `jsails create` scaffolding (auth-only, `--admin`, `--blog`, and `--cli` shapes)
  and an in-process test application surface (`jsails/testing`). The `--cli`
  shape is the same framework and plugin system with web plugins disabled: it
  ships a real `jsails.app.js` (`plugins.enabled: []` plus the extension seam)
  and a trimmed `package.json`/`tsconfig.json`, but no web surface.
- `jsails/i18n`: a dependency-free `createTranslator` with dot-path lookup,
  `{name}` interpolation, and `Intl.PluralRules`-driven `tChoice` plural selection
  (no file-system or environment resolution).
- `jsails/flags`: feature flags with an in-memory `FeatureStore` default, an
  optional database-backed store (`JsailsFeatureFlag`/`featureFlagEntities` over
  `jsails_feature_flag`), `resolveFeature`, and a `flagsPlugin`/`flagsToken`.
- CLI `seed` (ordered, filterable database seeders via `jsails.seed.js`), `queue`
  (a read-only queue dashboard), and `make:page|api|job|model|command` generators
  (single-file, exclusive-create scaffolds).
- Server-component lifecycle hooks (`mount`/`hydrate`/`updating`/`updated`) and
  `computed` read-only properties.
- Admin breadth: relation columns, repeater fields, infolist detail sections,
  dashboard charts (`defineChart` + `lineChartSvg`/`barChartSvg`), and a file
  field wired to a `resolveFileDisk` disk resolver.

- Server-component form objects (`defineForm`) — Livewire-style abstractions
  wrapping a Zod object schema with typed field access, `fill`/`validate`/`reset`
  helpers, and JSON round-trip compatible with the snapshot protocol.
- Server-component nested (child) components (`defineNestedComponent` /
  `renderNested`) — independently authorised, stateful children, each with its own
  signed snapshot and security boundary; `MAX_NESTING_DEPTH` (8) bounds tree depth.
- Data migrations (`defineDataMigration` / `createDataMigrationRegistry`) —
  named, invertible `up`/`down` functions sequenced in the same linear chain as
  schema migrations (`kind: 'data'`); rollback refuses a data migration without
  `down`.
- Migration squashing (`squashMigrations`) — replaces a contiguous applied range
  of schema migrations with a single cumulative migration.
- `showmigrations --format table|json|plan` for human-readable, machine-readable,
  and plan-mode output.
- `migrate --fake` / `--fake-initial` — record a migration as applied without
  running DDL or touching data.
- Filesystem variants (`defineVariant` / `createVariantResolver`) — lazy, cached
  transformations (caller-supplied transform, deterministic disk key, never mutates
  the source) over the disk store.
- Filesystem rich text (`createRichText`) — a sanitized HTML value object with
  plain-text extraction; the caller supplies the sanitizer (JSails ships no HTML
  parser and never trusts producer HTML).
- Diagnostics (`jsails/diagnostics`) — Telescope-style in-memory recorder
  (`createDiagnosticsRecorder` ring buffer with `wrapAsync` duration tracking) plus
  a `diagnosticsPlugin`/`diagnosticsToken` with an opt-in disabled mode.
- Jamal pure planners — `jamal registry` (docker login argv), `jamal prune --keep
  <n>` (image retention), `jamal audit` (security checklist), and `jamal snapshot
  [restore] <service>` (database dump/restore argv, MariaDB + Postgres). These are
  pure planners: they never execute Docker, resolve secrets, or open a connection.
- Hotwire Native web groundwork (`createPathConfiguration` /
  `resolvePathConfiguration` / `isNativeApp` / `nativeBridge` type) — a pure-path
  configuration layer with no native SDK dependency.
- API router (`createResourceRouter`) — produces a deterministic route manifest
  from named resource handlers, rejecting duplicate method+path combinations
  with a value-free error.
- API versioning (`resolveApiVersion`, `versionedNotFound`,
  `versionedNotAcceptable`) — resolves a version from URL path prefix and Accept
  header, with URL always taking precedence over the header; missing signal
  returns the default, unknown version returns a `VersionError`.
- Admin tabs (`defineTabs`, `collectTabFields`, `renderTabs`) — groups resource
  fields into named tabs for the create/edit form; validation still runs over the
  full flattened field set.
- Admin wizard (`defineWizard`, `wizardStepValues`, `collectWizardFields`,
  `renderWizard`) — splits the form into sequential steps with per-step
  validation and navigation.
- Admin table grouping (`groupRows`, `renderGroupedTable`) — partitions list
  rows into ordered groups by a column value with group headers and per-group
  tables.
- Admin bulk export (`defineExportAction`, `serializeExport`, `wireExportAction`)
  — a bulk-action descriptor that serializes selected rows to CSV or JSON.
- Validation rules (`jsails/validation`) — composable, value-free Zod-backed
  rules (`required`/`email`/`url`/`minLength`/`maxLength`/`min`/`max`/
  `regex`/`inList`/`confirmed`/`when`) plus a `validateFields` bulk helper.
- HTTP client (`jsails/http`) — fetch-based `createHttpClient` with typed
  `get`/`post`/`put`/`patch`/`delete` methods, bounded timeouts, injectable
  fetch, and value-free `HttpClientError` reporting.
- Job metrics (`createJobMetrics`) — in-memory per-job completed/failed
  aggregator with `snapshot`/`reset`.
- Failed-job store (`createFailedJobStore`) — bounded ring buffer of
  value-free `FailedJobEntry` records with `retry(id, dispatch)`.
- Inertia page adapter (`createInertiaPage` / `renderInertiaPage` /
  `inertiaVersion`) — minimal Inertia-style page-object protocol with JSON/HTML
  rendering and SHA-256 asset versioning; no client-side router dependency.
- Polymorphic relations (`@PolymorphicRelation`) — a child entity declares
  `targets`/`relatedName` and gets a generated `<prop>_type` varchar(190) and
  `<prop>_id` integer column plus a table-level `polymorphic` schema descriptor;
  the target declares nothing and the inverse is auto-inferred. Typed loaders
  `loadPolymorphic` (child → parent) and `loadPolymorphicInverse` (parent →
  children), plus the synchronous `resolvePolymorphicTarget` /
  `resolvePolymorphicInverse`. No database-level FK (the target varies per row).
- Relation API — connectionless metadata resolver (`resolveRelation` /
  `resolveRelationPath`), batch IN-clause loader (`loadRelation` / `loadRelations`
  with nested-path recursion, M2O/O2M/O2O/M2M/polymorphic, select/where/order/
  limit), portable EXISTS predicates (`whereHas` / `has` / `exists` with nested
  dotted-path support), and GROUP BY aggregates (`relationCount` /
  `relationAggregate`). Limits: polymorphic relations are rejected by predicates
  and aggregates; nested paths are rejected by aggregates; composite-key loading
  and the `'join'` strategy are not yet supported.
- AI-first introspection — `jsails inspect routes --json` (route manifest with
  resolved absolute file paths), `jsails plugins resolve --json` (merged
  enablement with explicit conflict flagging), and the opt-in, default-off,
  default-deny `GET /_jsails/introspect` runtime endpoint (`introspect: {
  enabled, authorize, sections? }`; `authorize` is required when enabled).
  Sections `routes`/`plugins`/`components`/`pipeline`/`config`/`health` ship as
  the safe subset; `migrations`/`diagnostics`/`jobs` are reserved for a follow-up.
- `jsails describe [--json] [--config <path>] [--db-config <path>]` — a
  read-only builtin that composes one machine-readable snapshot of an app's
  static definition (`{ app, routes, plugins, components, schema }`) without
  importing page/API modules, opening a connection, or running `setup`. Routes
  omit absolute file paths; `--db-config` (default `jsails.config.js`) extracts
  the entity schema via `getModelSchema()` without connecting.
- `jsails explain <path> [--json] [--config <path>]` — a read-only builtin that
  resolves one request path against the discovered route manifest and reports the
  matching route, its params, and the fixed request pipeline it would traverse.
  A path in the reserved `/_jsails` namespace reports `reserved: true,
  matched: false`. It never assembles an application, imports page/API modules,
  or opens a connection.
- Live introspection sections — `GET /_jsails/introspect` now serves
  `migrations` (`{ applied: [{ name, appliedAt }], pending }`; names/timestamps
  only), `diagnostics` (`stats()` counts/durations only), and `jobs`
  (`{ metrics, failed: [{ id, job, failedAt, attempts, error }] }`; metadata
  only, never payloads or stack traces), each reporting `unavailable` when its
  provider is absent. The `pipeline` section reports the fixed stage list, the
  registered middleware names, and the global middleware count; the `config`
  section reports a redacted projection of the resolved app config (booleans for
  callbacks, directory basenames only — never absolute paths, secrets, or
  callback identities). `introspect.sections` is the default set returned when no
  `?section=` is given; an explicit `?section=` may name any valid section
  (`routes`/`plugins`/`components`/`pipeline`/`config`/`migrations`/`diagnostics`/
  `jobs`/`health`).
- Plugin static descriptor — `JsailsPlugin.describe?: () => PluginDescription`,
  a pure, side-effect-free declarative descriptor readable without running
  `setup`; `PluginDescription` currently carries `components`. The
  server-components plugin implements it, and both `jsails describe` and the
  introspect `components` section read component metadata through it.
- Per-route middleware — a compiled page or API module may export `middleware`,
  an array of `RouteMiddleware` handlers `(context, next) => Response` applied
  before the terminal handler, with a fixed ordering invariant (body-limit/405 →
  session → origin/CSRF → global `authorize` → module `authorize` → global
  middleware → per-route middleware → handler). A named `middleware` registry and
  `globalMiddleware` config wire the chain at assembly time; extensions add to
  the global chain through `configureMiddleware`. Short-circuit by returning
  without `next()`; `next()` is callable at most once. Structural validation
  (`validateMiddlewareList`) and chain composition (`runMiddleware`) are exported.
  Limits: no reordering, no middleware on framework routes, no path-keyed config
  map, no lazy name resolution; the static export never runs middleware.
- Route groups and nested layouts — a `pages/` directory named `(name)` (matching
  `[A-Za-z0-9_-]+`) is a route group that contributes no URL segment but scopes
  layouts; groups are pages-only (the parens are rejected as unsafe in `api/`).
  A `layout.js`/`layout.mjs` file in any `pages/` directory is a layout module
  discovered lexically, excluded from the route manifest, and folded around the
  page inside-out at render time (outermost first). Layouts carry no `load`,
  `middleware`, or `getStaticPaths`; their default export receives the page's
  resolved props plus a framework-reserved `children` slot. If the outermost
  layout emits `<html>`, the minimal document shell is skipped. v1 limits: no
  layout `load`, no `middleware`, no `SERVER_ONLY` check, no loading/error
  boundaries, no parallel/intercepting routes.
- Route-level data caching — a page module may export `revalidate` (a positive
  finite number of seconds) to opt its `load` result into the `cache` plugin's
  store. When `revalidate` is set, a cache store is available on the request
  context, and the render is not static, `renderRoute` caches `load` through
  `store.remember`, keyed by the route pattern, resolved params, and a stable
  hash of the query string (namespaced `jsails:page:`, independent of
  origin/host). A cache backend error falls back to a fresh `load`; static
  export always renders fresh. The pure `pageCacheKey` helper is exported from
  `src/pages/page.ts`.

### Changed

- `jamal deploy` / `jamal rollback` now execute by default: `--dry-run` prints
  the TypeScript engine's plan without running it, and `--execute` is kept as a
  deprecated no-op alias (the commands already execute).
- On-demand TLS is configured through `jamal.config.js`
  `production.onDemandTlsUrl` (mutually exclusive with `production.domain`),
  supported by kamal-proxy v0.10.0+; Kamal still defaults to proxy v0.9.2, so a
  proxy image bump is needed.
- The default kamal-proxy image is pinned to `basecamp/kamal-proxy:v0.10.0`
  (previously `:latest`), the first tagged release with on-demand TLS; Kamal
  still defaults to proxy v0.9.2, so a proxy image bump is needed to use
  on-demand TLS through an external `kamal deploy`. `jamal domain` now documents
  that it drives the proxy's runtime `deploy`/`remove` API over ssh (not
  `deploy.yml`), so a later external `kamal deploy` may overwrite or conflict
  with a domain it added.
- Convention renames (breaking, pre-1.0): `guard` → `guardRateLimit`
  (`src/cache/limiter.ts`); `VersionError` → `VersionFailure`
  (`src/api/versioning.ts`, an interface, not an Error class);
  `createPathConfiguration` → `definePathConfiguration` (`src/client/native.ts`).

### Removed

- Legacy BullMQ helpers (`createJobQueue`, `startJobWorker`, `upsertSchedules`) —
  the provider-neutral job runtime (`createJobsRuntime` + `createBullMQAdapter`)
  is the sole public job surface.
- `redisUrl` config-key aliases and `REDIS_URL` environment fallbacks across jobs,
  cache, and environment readers — `valkeyUrl` / `VALKEY_URL` are the only names;
  the internal `redisUrl` transport/URL value and the broadcast transport option
  retain their `redis://` scheme.
- `RenderRouteOptions` public type alias — use `PageRenderOptions` directly.
- The `--recipe` flag, `recipes` subcommand, and the recipe system, plus the
  `--on-demand-tls` and `--no-harden` flags.
- The Kamal YAML generators (`kamal-config.ts`, `generateKamal*`) and their
  builtin deployment adapters (the registry now ships 8 built-ins), and
  `src/deploy/recipes.ts`.
- `renderAdminDocumentThemed` — folded into
  `renderAdminDocument(title, theme?, ...body)` (`src/admin/helpers.ts`).

### Fixed

- The read-only introspection command names (`inspect`, `describe`, `explain`)
  are now reserved (`DEFAULT_RESERVED_COMMAND_NAMES`), matching `jamal` and
  `plugins`. They are early-routed before shared flag-gating, so a user command
  under one of these names was silently shadowed instead of rejected; the
  collision now fails with a value-free `reserved_name` error.

