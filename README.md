# JSails

[![CI](https://github.com/ronald2wing/jsails/actions/workflows/ci.yml/badge.svg)](https://github.com/ronald2wing/jsails/actions/workflows/ci.yml)

JSails is a **TypeScript application framework** with an Active Record data layer and
a bounded application runtime. It deliberately reuses maintained libraries (TypeORM,
Zod, BullMQ, Socket.IO, Preact, Hono) rather than implementing its own renderer, auth
stack, or queue.

It is **not** a complete MVC framework, and it is **not yet published to npm** — install
it from a packed tarball or a git checkout until a release lands.

## What it gives you

| Area | Summary |
| --- | --- |
| **Data layer** | Active Record ORM (`BaseEntity` / `EntitySchema`) over MariaDB (recommended), Postgres, MySQL, or SQLite; schema history via `makemigrations` / `migrate`; relation API (batch loading, predicates, aggregates); polymorphic relations (`@PolymorphicRelation`) |
| **Pages & APIs** | Filesystem-routed pages (Preact SSR) and Hono API routes; route groups `(name)` and nested `layout.js` modules; opt-in route data caching via a page `revalidate` export; `jsails build` produces a static export |
| **Server components** | Signed, stateless Livewire-style components with backend actions and Turbo soft navigation |
| **Client runtime** | Turbo navigation plus hydrated Preact islands; Hotwire Native path-configuration groundwork (`jsails/client`) |
| **Diagnostics** | In-memory recorder with `wrapAsync` duration tracking and a plugin (`jsails/diagnostics`) |
| **Notifications** | Multi-channel delivery seam (memory/mail channels) with a plugin (`jsails/notifications`) |
| **i18n** | Dependency-free message translator with `Intl.PluralRules`-driven pluralization (`jsails/i18n`) |
| **Feature flags** | Boolean gates with in-memory/database stores plus a plugin (`jsails/flags`) |
| **Plugins & admin** | Two-source plugin enablement, an admin panel with CRUD resources, and a plugin manager |
| **Jamal** | Local Docker Compose via `jamal up`, production deploy/rollback, app/accessory lifecycle verbs over ssh, and pure planners (`registry`, `prune`, `audit`, `snapshot`) |
| **Migrations** | `showmigrations --format`, `--fake`/`--fake-initial`, data migrations (`defineDataMigration`), squashing (`squashMigrations`) |
| **CLI** | `create`, `dev`, `build`, `serve`, `makemigrations`, `migrate`, `work`, `schedule`, `seed`, `queue`, `make:<page|api|job|model|command>`, `inspect`, `describe`, `explain`, `jamal`, `plugins`, plus user-defined commands |

## Quick start

```sh
# From a framework checkout — build and pack the tarball first:
npm install
npm run build
npm pack --pack-destination /tmp

# Scaffold a new app against that tarball:
node dist/src/cli.js create my-app --install \
  --jsails-dependency "file:/tmp/jsails-1.0.0.tgz"
cd my-app
npm run dev      # compile + watch + serve (restarts the backend on changes)
```

`jsails create` flags select the starter shape:

- default — a Preact starter with auth (Better Auth over MariaDB) and server components;
- `--admin` — also mounts the first-party admin panel at `/admin`;
- `--blog` — implies `--admin` and adds a first-party blog with two SSG pages;
- `--cli` — a Laravel-Zero-style CLI-only project with **no web surface** but the
  same framework and plugin system (a real `jsails.app.js` with
  `plugins.enabled: []` and the extension seam).

The starter's sign-in flow needs a database; start MariaDB (and Valkey) locally with:

```sh
jsails jamal up
```

## Verification

```sh
npm run check                 # typecheck, lint, format check, then the full test build
npm run verify:starter        # opt-in end-to-end starter verification
npm run verify:integrations   # opt-in live-service harness (env-gated)
```

See [`AGENTS.md`](./AGENTS.md) for the full reader guide and source layout.

## Documentation

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — how JSails is assembled: kernel
  vs plugins, the data layer, HTTP/pages/server components, the client runtime,
  the admin and plugin systems, Jamal, the CLI, testing, and security boundaries.
- [`docs/CODEMAP.md`](./docs/CODEMAP.md) — an annotated source-tree map (kernel /
  plugins / tooling) plus the package export subpaths and quick reference.
- [`docs/SECURITY.md`](./docs/SECURITY.md) — security model and review summary
  (plugins, install gates, admin, server components, uploads, auth, broadcast).

## Known limits

Be honest about what is and isn't covered today:

- **Migrations are scalar and linear.** The portable schema covers scalar columns
  (`integer`, `varchar` with explicit `length`, `text`, `boolean`, `datetime`), a single
  generated integer primary key, simple indexes and unique constraints, and
  single-column many-to-one foreign keys. Composite
  or deferrable foreign keys, partial/expression indexes, enums, generated UUIDs, and
  function defaults are rejected. Application is forward-only; rollback replays the
  recorded operations' inverses.
- **Persistence is verified in-process only here.** The test suite exercises the
  read-only `FileDataSource` over in-memory `sqljs` (WASM SQLite). MariaDB is the
  recommended default, but there is **no live MariaDB, Valkey, or Docker integration
  test** in this checkout.
- **On-demand TLS needs a proxy image bump.** Setting `production.onDemandTlsUrl` in
  `jamal.config.js` (mutually exclusive with `production.domain`) uses kamal-proxy
  on-demand TLS, released in v0.10.0, but Kamal still defaults to v0.9.2. The app must
  serve an authenticated `GET ?host=<hostname>` allowlist endpoint — an over-permissive
  endpoint can have certificates issued for unauthorized domains.
- **No finished auth kit in core.** The starter's sign-in flow is app-owned and
  login-only (registration, password reset, email verification, and OAuth are deferred).
- **Custom broadcast transports need their own client.** The shipped browser client is
  Socket.IO-specific.
- **API router and versioning are available now.** `createResourceRouter` builds a
  deterministic route manifest from named resource handlers, and `resolveApiVersion`
  negotiates versions from URL prefix and Accept header (URL takes precedence).

## License

[MIT](./LICENSE)
