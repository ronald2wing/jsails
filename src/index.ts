// Root entry: the `jsails` package.
//
// Re-exports the full public surface from each subpath barrel directly.
// Kept entry clusters (no subpath barrel exists for them) stay in entry/.
//
// Named export collisions (Authorize from api vs contracts/http, RouteMiddleware
// from routing vs extensions) are resolved by explicit named exports placed
// BEFORE the wildcard re-exports — named exports take precedence over `export *`
// in the ES module resolution spec, so the colliding symbol in later wildcards
// is skipped rather than making the name ambiguous (and silently dropped).

// ---------------------------------------------------------------------------
// Collision resolution: named exports BEFORE any conflicting wildcard.
// ---------------------------------------------------------------------------

// `Authorize` (global API, from contracts/http.ts) vs api/index.ts's bare
// `Authorize` (resource-level, different signature). Establish the global one
// first; api's bare Authorize is aliased to ResourceAuthorize below.
export { type Authorize } from './entry/server.js';

// `RouteMiddleware` appears in both routing/index.ts and extensions/index.ts
// (both from ./routing/middleware.ts — same type). Establish it from routing.
export { type RouteMiddleware } from './routing/index.js';

// `ResourceAction` appears in both api/index.ts (API handler actions) and
// admin/index.ts (admin resource actions — different type). Establish the
// API version; admin's is excluded from the root public surface.
export { type ResourceAction } from './api/index.js';

// `and`/`or` (query expression combinators from database) collides with
// api/permissions.ts's permission combinators. `when` (CASE WHEN factory
// from database) collides with validation's `when` conditional rule.
// Establish the database versions; the originals are skipped. Consumers
// import the permission combinators from `jsails/api` and the validation
// `when` from `jsails/validation` directly.
export { and, or, when } from './database/index.js';

// ---------------------------------------------------------------------------
// Entry point slices (no subpath barrel — these are the only root barrels)
// ---------------------------------------------------------------------------

// `Authorize` from server's wildcard is skipped (named export already exists).
export * from './entry/server.js';
export * from './entry/application.js';
export * from './entry/environment.js';
export * from './entry/cli.js';
export * from './entry/migrations.js';

// ---------------------------------------------------------------------------
// Subpath barrels (canonical home)
// ---------------------------------------------------------------------------

// Data layer: TypeORM Active Record, portable schema, entity hooks, factories,
// polymorphic relations, relation metadata/loader/query, and seeders.
export * from './database/index.js';

// Jobs: registry, queue, scheduler, runtime-config, provider-neutral runtime,
// BullMQ adapter, plugin, metrics, and failed-job store.
export * from './jobs/index.js';

// Broadcast: server-side Socket.IO channel plus the pluggable transport.
export * from './broadcast/index.js';

// Deploy: config generators (Docker Compose, static hosts, ONCE, hardening)
// plus the neutral generator registry.
export * from './deploy/index.js';

// Internationalization: dependency-free message translator.
export * from './i18n/index.js';

// Validation rules: composable, value-free Zod-backed validation.
export * from './validation/index.js';

// HTTP client: fetch-based seam with JSON encoding and bounded timeouts.
export * from './http/index.js';

// Inertia adapter (the `jsails/inertia` subpath barrel owns its code/reexports).
export * from './inertia/index.js';

// Pages: compiled page loading, Preact SSR, static site generation.
export * from './pages/index.js';

// API: schema validation, serializers, pagination, resource handlers, list
// query, permissions, throttle, forms, OpenAPI, router, versioning.
//
// The bare `Authorize` from api/index.ts is skipped here (it collides with the
// named `Authorize` established above). The resource-level type is aliased:
export { type Authorize as ResourceAuthorize } from './api/index.js';
export * from './api/index.js';

// Routing: filesystem route discovery and middleware chain.
// `RouteMiddleware` from routing's wildcard is skipped (named export exists).
export * from './routing/index.js';

// Server components: stateless signed-snapshot protocol, actions, forms,
// nested components, validation metadata, and wire constants.
export * from './server-components/index.js';

// Extensions: service tokens, registry, ordered setup runner, interceptors,
// plugin contract, and type-only author contracts for out-of-tree plugins.
// `RouteMiddleware` from extensions' wildcard is skipped (named export exists).
export * from './extensions/index.js';

// Admin: panel, pages, resources, widgets, notices, actions, charts, tabs,
// wizards, table grouping, bulk export, and security/render helpers.
export * from './admin/index.js';

// Plugins: manifest contract, two-source discovery, framework-version check,
// .tgz extractor, state store, enablement, download-capability, installer,
// activation, and `plugins.use` resolution.
export * from './plugins/index.js';

// Jamal: single-file config model, production deploy planner, on-demand TLS,
// registry/prune/audit/snapshot planners, execution helpers, and history.
export * from './jamal/index.js';

// Feature flags: in-memory/database stores, resolveFeature helper, and plugin.
export * from './flags/index.js';

// Diagnostics: Telescope-style in-memory recorder with typed entries and plugin.
export * from './diagnostics/index.js';

// Signals: service-layer signal bus over the shared interceptor/observer registry.
export * from './signals/index.js';

// Logging: record-first structured logging with pluggable channels and formatters.
export * from './logging/index.js';

// Encryption: symmetric AES-256-GCM encryption with key rotation.
export * from './encryption/index.js';

// Theme: browser-safe CSS-custom-property theme token contract (T3.2).
export * from './theme/index.js';

// Introspect: runtime introspection section types, providers, and route config.
export * from './introspect/index.js';

// Services: cache, mail, notifications, filesystem, and database-backed sessions.
export * from './cache/index.js';
export * from './mail/index.js';
export * from './notifications/index.js';
export * from './filesystem/index.js';
export * from './sessions/index.js';
