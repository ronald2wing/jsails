# Working with JSails

JSails is a **TypeORM-based Active Record data layer** plus a bounded application
runtime: an extension system, HTTP/pages/API serving, static export, jobs,
broadcast, deploy-config generators, and a CLI. It is not a complete MVC
framework. It deliberately reuses maintained libraries (TypeORM, Zod, BullMQ,
Socket.IO, Preact, Hono) rather than implementing a bespoke renderer, auth stack,
or queue.

- **ESM only** (`"type": "module"`); Node `^20.19.0 || ^22.13.0 || >=24.11.0`.
- Public API: `src/index.ts`. Subpaths in `package.json` `exports`:
  `jsails/api` (browser-safe schemas/serializers/pagination/resources),
  `jsails/extensions` (ORM/HTTP/queue/Socket.IO-free extension foundation plus
  type-only plugin author contracts), `jsails/broadcast/client` (the Socket.IO
  browser client), `jsails/client` (browser island/Turbo/component runtime),
  `jsails/server-components` (server-only stateful components with backend
  actions), `jsails/testing` (server-only in-process test application),
  `jsails/jsx-runtime`, `jsails/render-to-string`.
- Verify with `npm run check` (typecheck, lint, format check, then the full
  test build) and the opt-in `npm run verify:starter`.

## Primary workflow

With the CLI installed, the fast path for a new app is:

```sh
jsails create my-app --install
cd my-app
npm run dev     # compile + watch + serve (restarts the backend on changes)
npm run build   # compile TS/assets, then static-export into out/
```

`create` scaffolds a Preact starter with three pages — Home, About, and Tasks —
using the framework's own client runtime: the Home page registers a `counter`
island and hydrates it via `startClient` (no hand-written `hydrate` call), the
Tasks page renders a live `task-list` server component with a backend action,
and About is a plain static page. It refuses a non-empty or symlink target,
writes files only, and runs `npm install` **only** with `--install`; a failed
install keeps the generated files so the user can retry. Its scoped flags are
`--name <pkg>` (defaults to the directory basename) and
`--jsails-dependency <spec>` (a `file:` tarball/path).

jsails is not published to npm. From a framework **source checkout**, build and
drive the CLI directly, pointing the generated app at a packed tarball:

```sh
npm run build
npm pack --pack-destination /tmp
node dist/src/cli.js create my-app --install \
  --jsails-dependency "file:/tmp/jsails-0.1.0.tgz"
```

`dev` owns the toolchain: an initial `tsc`/Vite build, then both in watch mode,
plus nodemon restarting the backend — including newly added routes — on the
**same app port**. There is no hot module replacement; reload the browser after
a change. Host, port, and output directory come from the app config, never flags.

The CLI stays human-first: it scaffolds and serves, but decisions with domain
impact — applying migrations, destructive schema changes, deploy configuration —
remain explicit human actions. Internal seams are documented further down; the
API promises above are deliberately narrow.

## Data layer

`JsailsDataSource` (`src/database/jsails-data-source.ts`) extends TypeORM's
`DataSource` and restricts drivers to `'mariadb' | 'postgres' | 'mysql'`.
**MariaDB is the recommended default**, Postgres is supported, and the `mysql`
driver is retained for compatibility (`mysql2`). Construction rejects
`synchronize`, `dropSchema`, `migrationsRun`, and a TypeORM `migrations` config —
JSails owns its schema history. `getModelSchema()` builds entity metadata
offline; it never opens a connection.

Use `BaseEntity` for Active Record entities, or `EntitySchema`. The portable
schema model is narrow: scalar columns only (`integer`, `varchar` with explicit
`length`, `text`, `boolean`, `datetime`) and a single generated integer primary
key. Relations, foreign keys, composite keys, indexes, uniques, enums,
generated UUIDs, `@CreateDateColumn`, and function defaults are rejected with
`UnsupportedSchemaError`.

`FileDataSource.create({ models })` (`src/database/file-data-source.ts`) is a
**read-only**, in-memory Active Record source backed by TypeORM's `sqljs`
driver. It seeds from in-memory `rows` arrays or JSON `file`s, validates every
row against the portable schema, then flips SQLite into `query_only` mode: the
same `BaseEntity` static queries work, while any write fails at the SQLite level.
It is a convenience for tests, demos, and read-only catalogs, not a sandbox — a
trusted caller can reach the raw `DataSource` through
`handle.getRepository(entity)` and re-enable writes.

Migration config modules (`jsails.config.js` by default) must default-export a
`JsailsDataSource` and be **compiled JavaScript** — `.ts` paths are rejected by
the CLI.

```js
// jsails.config.js  (app-owned; plain ESM)
import { JsailsDataSource } from 'jsails';
import { EntitySchema } from 'typeorm';

export const User = new EntitySchema({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true, generated: true },
    email: { type: String, length: 255, nullable: false },
    active: { type: Boolean, nullable: false, default: true },
  },
});

export default new JsailsDataSource({
  type: 'mariadb',
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT ?? 3306),
  username: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  entities: [User],
});
```

## Environment configuration

`readEnvironment(schema, source?)` validates a plain
`Record<string, string | undefined>` (defaulting to `process.env`) against a Zod
schema and returns typed config. It **never loads a `.env` file, never mutates
the source or `process.env`**, and resolves the default source when a reader is
called — not at import. Failures are `EnvironmentError`s whose issues carry
`{ path, code, message }` only: custom Zod messages, thrown transform/refine
errors, `.cause`, and raw values (including credentials) are never surfaced.

`readDatabaseEnvironment(source?)` and `readValkeyEnvironment(source?)` are
opt-in service readers. A static site that never calls them needs neither a
database nor Valkey; call them explicitly where the service is used.

```js
// jsails.config.js  (app-owned; plain ESM)
import { JsailsDataSource, readDatabaseEnvironment } from 'jsails';
import { User } from './entities/user.js';

const database = readDatabaseEnvironment();

export default new JsailsDataSource({ ...database, entities: [User] });
```

- Database defaults to `mariadb` (port `3306`); `postgres` defaults to `5432`,
  and the legacy `mysql` driver is retained. `DATABASE_HOST`, `DATABASE_USER`,
  `DATABASE_PASSWORD`, and `DATABASE_NAME` are required — there is no implicit
  database.
- Valkey resolves `VALKEY_URL` first, then `REDIS_URL`.
- Readers accept an injected source and never fall back to `process.env` once
  one is given.

## Migrations

Migrations are **scalar, linear, forward-only**. A definition is a JSON file in
`migrations/` holding operation/type metadata (schema history), not a live
database schema. `makemigrations` diffs the model metadata against that recorded
history; it does not introspect the database. There are no down/rollback
operations. JSails tracks applied state in its own `jsails_migrations` table.

```sh
jsails makemigrations --name add_users --config jsails.config.js
jsails migrate --config jsails.config.js
jsails showmigrations --config jsails.config.js
```

`--migrations <dir>` defaults to `migrations`; `--allow-destructive` is
`makemigrations`-only.

## Jobs

`defineJob(schema, handler)` (`src/jobs/registry.ts`) pairs a Zod schema with a
typed handler; `createRegistry({...})` validates the map. Payloads are validated
on dispatch **and** on the worker. Instantiating a queue/worker is what connects —
importing the modules never opens a Valkey connection.

The job layer has two public surfaces:

- the **provider-neutral runtime** — `createJobsRuntime({ registry, adapter,
  queueName?, prefix?, concurrency? })` binds the registry to a
  `JobRuntimeAdapter` and owns job-level policy (payload validation on enqueue
  and on processing, dispatch-option allowlisting, local schedule validation,
  lazy + idempotent handles, idempotent `close`). `validateJobRuntimeAdapter(
  adapter)` checks an adapter's shape without invoking any factory.
  `createBullMQAdapter({ redisUrl, onError?, queueFactory?, workerFactory? })` is
  the built-in BullMQ adapter and the default transport. An adapter is
  `{ name, createProducer, createWorker, upsertSchedules? }`; when
  `upsertSchedules` is absent, `runtime.upsertSchedules` throws an explicit
  `JobRuntimeError` instead of silently doing nothing. A custom adapter needs
  **no connection URL** — `createJobsRuntime` never receives one.
- the **legacy BullMQ helpers**, preserved unchanged: `createJobQueue({ redisUrl,
  registry, queueName?, prefix? })` → `dispatch(name, payload, opts?)`,
  `close()`; `startJobWorker({ redisUrl, registry, concurrency? })`; and
  `upsertSchedules(queue.queue, registry, specs)`.

```js
// jsails.runtime.js  (default config for `work` / `schedule`)
import { z } from 'zod';
import { defineJob, createRegistry } from 'jsails';

const sendEmail = defineJob(
  z.object({ to: z.string(), subject: z.string() }),
  async (data, ctx) => { await ctx.log(`send to ${data.to}`); },
);

export default {
  registry: createRegistry({ sendEmail }),
  // `adapter` is optional. Omit it to use the built-in BullMQ adapter, which
  // then requires a Valkey/Redis URL (valkeyUrl preferred, redisUrl legacy,
  // then VALKEY_URL / REDIS_URL). Supply a custom JobRuntimeAdapter to target
  // another backend with no URL at all.
  valkeyUrl: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379',
  schedules: [{ id: 'digest', job: 'sendEmail', cron: '0 3 * * *',
                data: { to: 'ops@example.com', subject: 'digest' } }],
  queueName: 'default',
  concurrency: 1,
};
```

- Runtime config (`validateRuntimeConfig`): when `config.adapter` is present it is
  selected verbatim (identity preserved) and no URL is read or validated; when
  absent, the URL is resolved (`valkeyUrl` → `redisUrl` → `VALKEY_URL` →
  `REDIS_URL`; must be `redis://` or `rediss://`) and the built-in
  `createBullMQAdapter` is constructed from it (lazily — no connection yet).
  `work`/`schedule` drive the selected adapter through the same neutral
  contract, not a separate built-in path.
- Queue defaults: 3 attempts, exponential backoff (1000 ms); `MAX_ATTEMPTS` is
  25. Each schedule spec is `{ id, job, cron | everyMs, timezone?, data? }`
  (exactly one of cron/everyMs), validated locally before any provider call.
- Scheduling is **at-least-once**: no exactly-once, non-overlap, or catch-up
  guarantee is provided — make handlers idempotent.

```sh
jsails work --config jsails.runtime.js      # worker + schedule registration
jsails schedule --config jsails.runtime.js  # one-shot registration, then exit
```

## Broadcast

`attachBroadcast(httpServer, options)` (`src/broadcast/server.ts`) mounts a
broadcast transport onto an **existing HTTP server** under `/_jsails/broadcast` —
the same public port, never a second listener. It accepts two forms:

- the built-in Socket.IO options (the default), which lazily load
  `createSocketIOBroadcastAdapter` and enforce its origin/auth/channel checks;
- `{ adapter }`, a custom `BroadcastAdapter`, which mounts a caller-supplied
  transport.

Built-in safety (unchanged; owned by the Socket.IO adapter, never assumed for a
custom adapter):

- `allowedOrigins`: non-empty exact-match allowlist; mismatches are rejected.
- `authenticate(handshake)`: derives identity from server-side handshake data.
  Client-supplied `auth` is never trusted. Return a falsy value to deny.
- `authorizeChannel(identity, channel)`: default-deny when omitted.
- Optional `redisUrl`/`valkeyUrl` for the multi-process pub/sub adapter;
  defaults to websocket-only transport. Broadcasts are ephemeral (no replay or
  durability).

A **custom adapter** is trusted application code: the core performs no
authentication, channel authorization, origin check, or payload serialization
for it — the adapter owns all of those, and only the built-in adapter carries
the Socket.IO security posture above. A custom transport also needs its own
matching client: `jsails/broadcast/client` is Socket.IO-specific and will not
talk to a non-Socket.IO adapter.

The returned handle exposes `broadcast` (with an `emit` alias) and an idempotent,
concurrent-safe `close`. `handle.closesHttpServer` declares whether the
transport's `close()` also closes the attached HTTP server: the built-in adapter
declares `true` (Socket.IO's `close()` closes the server); a `false` handle
leaves the server to the caller. The application itself **always** closes its
own listener if it is still listening, regardless of the flag — only the
server's listening state guards against a double close. Wire `authenticate` to
your app's real session check; do not ship a demo callback that returns a
constant identity.

## Application runtime

An app ships one compiled ESM module (default `jsails.app.js`) whose default
export is a plain object. `loadAppConfig(path?)` imports it and
`validateAppConfig` resolves absolute directories; `createApplication(config)`
discovers routes, runs the extensions, then the app's `setup` hook, and returns
an inert `Application` (`build()`, `serve()`, `close()`). Nothing opens a
connection until `serve()` or an extension's own `setup` does.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
export default {
  rootDir: '.',      // defaults to the config file's directory
  pages: 'pages',    // relative to rootDir
  api: 'api',        // relative to rootDir
  public: 'public',  // relative to rootDir
  out: 'out',        // relative to rootDir
  storage: 'storage', // relative to rootDir; resolved to storageDir
  healthPath: '/up',  // GET/HEAD 200; false disables the health route
  host: '127.0.0.1',
  port: 3000,        // 0 requests an ephemeral port
};
```

- `broadcast` accepts either the built-in Socket.IO options (with a preferred
  `valkeyUrl` alias of `redisUrl`) or `{ adapter }`. The custom form is validated
  structurally (non-empty `name` + `attach`) and passed through by identity; its
  `attach` is never invoked by the loader.
- `renderer` is a `PageRenderer` passed through directly; only its `render`
  function is checked, never called.
- CLI commands live on `commands` (app level) or `extensions[].commands`
  (per extension). Both are validated through the pure command registry, which
  applies one namespace and rejects invalid, duplicate, or reserved builtin
  names. Extension commands stay on their extension so `collectConfigCommands`
  sees each exactly once.
- The loader is inert: it never invokes `setup`, `authorize`, `resolveSession`,
  a renderer's `render`, an extension's `setup`, or a command's `run`. Importing
  the config module does run its own top-level code (inherent to ESM); the
  loader does not prevent trusted app side effects.
- `setup()` runs last and may return a cleanup callback; neither is invoked by
  the loader. If `setup` throws, already-opened extensions are closed first.
- `authorize(context)` is **default-deny**: absent means every API request is
  rejected, and a request is allowed only when the callback resolves to exactly
  `true` (truthy non-boolean, throw, or rejection all deny). There is no
  implicit-public default.
- `resolveSession(request)` is the trusted session seam; when absent the context
  carries `session: null`, and a throwing/rejecting resolver fails closed.
- Cookie-authenticated mutations (`POST`/`PUT`/`PATCH`/`DELETE` with a session)
  require a same-origin `Origin` and a matching `X-CSRF-Token`. Behind a
  TLS-terminating proxy the request URL is plain HTTP, so set `publicOrigin` to
  the public https origin — forwarded headers are never trusted. `publicOrigin`
  is consulted only for that `Origin` check (and the equivalent check on signed
  server-component updates); plain page rendering, static export, and the health
  route never need it.
- `healthPath` is a `string` or `false` and defaults to `/up`. The resolved
  config exposes it as `healthPath: string | undefined` (`false` becomes
  `undefined`). The framework route answers `GET`/`HEAD` with `200
  text/plain; charset=utf-8` and `Cache-Control: no-store`, **independent of the
  default-deny API pipeline**. A path must be absolute, have no trailing slash
  (except `/`), and stay outside the reserved `/_jsails` namespace; a collision
  with a discovered page/API route is rejected when the application is assembled.
- `storage` defaults to `storage` and resolves to `ResolvedAppConfig.storageDir`
  (the folder need not exist yet). `serve` creates it before listening; `build`
  and `fetch` never materialize it. The resolved directory reaches pages/API as
  `RequestContext.storagePath` (absent when the static export synthesized the
  context without one). Isolation guards reject a `storageDir` that equals the
  project root, overlaps `public`/`out` in either direction, or contains the
  config module.
- Config guards: `public` must not contain the project root, overlap
  `pages`/`api`/`out` in either direction, or contain the config file. The static
  build refuses to overwrite a non-empty `out` without its own ownership marker.
- Shutdown: `close()` is idempotent and tears down in reverse (HTTP/broadcast →
  app cleanup → extensions). `shutdownTimeoutMs` (default `5000`, max `300000`)
  bounds transport teardown: idle/all connections are force-closed and a server
  that will not stop has its tracked sockets destroyed at the deadline. The app
  cleanup and extension cleanups are trusted and awaited **without** a deadline —
  each owns its own async cleanup; this is bounded teardown, not a full graceful
  drain of active connections.

```sh
jsails build --config jsails.app.js   # static export into `out`
jsails serve --config jsails.app.js   # listen until SIGINT/SIGTERM
```

`host`, `port`, and `out` come from the config, not CLI flags. The generated
starter's `npm run build` chains `tsc` (server), `vite build` (browser assets),
then `jsails build` (static export). Calling `jsails build` directly assumes
**already-compiled** `pages/`/`api/` inputs — it is the low-level static-export
command, not a compiler. Advanced app config (`renderer`, `extensions`,
`broadcast`) is honored, but a starter normally leaves its generated
`jsails.app.js` untouched.

## Pages, routing, and API

`discoverRoutes(rootDir, { pagesDir?, apiDir? })` walks `pages/` and `api/`
lexically — no module import, no connection. Only compiled `.js`/`.mjs` modules
are discovered; symlinks are never followed; `api/` routes mount under `/api`.
Parameters are single-segment `[id]`; catch-all `[...id]` is rejected, not
accepted as a literal path.

- **Pages** are compiled modules: a function default export, optional
  `load(context)` for async props, optional `getStaticPaths()` for dynamic
  routes. `preactPageRenderer` + `renderRoute` render them via **Preact SSR**
  (doctype plus a minimal document shell) and reject a `SERVER_ONLY` default
  component in static mode. Set `"jsxImportSource": "jsails"` so JSX resolves to
  a thin `preact/jsx-runtime` re-export; components are synchronous and async
  data belongs in `load`. JSX/Preact runtimes are **not** interchangeable.
- **`jsails build` is a static export**: it renders every page (expanding
  `getStaticPaths`), copies `public/` byte-for-byte (symlinks rejected,
  dot-files skipped), and swaps the result into `out` through a staging
  directory. API routes are never rendered and are reported skipped.
- **Renderer seam**: `PageRenderer.render(entry, context, options)` is the same
  interface for `serve` and `build`; configure it with `renderer`. The built-in
  renderer keeps the compiled-page loader and `getStaticPaths` contract. A custom
  renderer's returned string is **trusted producer HTML** — JSails never
  sanitizes it, so the renderer owns its escaping and safety.
- **HTTP** is Hono. `createApp` + `createHttpServer` never listen. An API module
  exports named HTTP-method handlers `(request, context) => Response`; there is
  no default-export guessing. The global `authorize` is default-deny and a
  per-module `authorize` can only further restrict. HTTP extension hooks run in
  order after the body-limit/405 middleware and before the filesystem routes,
  receiving the real Hono app; hook routes are trusted code that own their own
  security — the default-deny pipeline covers only filesystem API routes.
- **API resources** live in `jsails/api` (browser-safe). `createResourceHandlers({
  serializer, store, authorize })` needs only a `ResourceStore`, which makes no
  ORM assumptions — any persistence can back it. The root `jsails` entry
  re-exports these and aliases the resource `Authorize` as `ResourceAuthorize`;
  the schema builders (`string`/`integer`/`boolean`/`object`/`array`/`optional`),
  pagination helpers, and `defineSerializer` are in `jsails/api`.

## Client runtime and islands

`jsails/client` is the **browser-safe** runtime. `startClient(options?)`
dynamically imports `@hotwired/turbo`, starts the shared Turbo session, registers
any declarative `islands` map, hydrates the initial island markup, and
auto-enables the server-component bindings; it is idempotent, and a failed start
tears down listeners/islands and remains retryable. `registerIsland(name,
component)` registers a typed Preact island (the same name + same component is a
no-op; a different component under an existing name throws). Islands are
server-rendered elements carrying `data-jsails-island="name"` and bounded-JSON
`data-jsails-props`; the element `id` is required only for
`data-turbo-permanent`. `data-hydrated="true"` is set on hydrate and removed on
restore, but hydration is tracked per element **identity** (a `WeakMap`), never
by the attribute alone — a cache restore or Turbo clone can carry the attribute
without a live Preact root.

Turbo owns all link interception and history: the runtime installs no bespoke
click handler, `history` call, or router. Ordinary valid same-origin `<a href>`
links get Turbo soft navigation over server-rendered (SSR) **and** plain static
(SSG) pages, including back/forward. Native opt-outs — external origin,
`download`, `target`, a modified left-click, and `data-turbo="false"` — are left
to the browser's default full navigation. There is **no automatic module
discovery**: every island must be registered explicitly (via `registerIsland` or
`startClient({ islands })`). `morphComponent(target, html, options?)` renders a
Turbo `<turbo-stream method="morph">` message and resolves once the morph
actually lands. A cancelable `jsails:before-navigation` document event (plus an
`onBeforeNavigation` hook) fires before a navigation commits, so a runtime can
drop stale in-flight work. There is **no HMR** — `dev` rebuilds and you reload
the browser; the client runtime does not patch modules.

Island props are decoded with `JSON.parse` only, bounded by length/depth/key
count, and reject `__proto__`/`constructor`/`prototype` keys at any depth. A
hydration or render error is reported (default `console.warn`, or `onError`) and
that island is skipped; the rest of the document keeps hydrating.

## Asset URLs and Turbo reload

`createAssetUrlResolver(publicDir)` (`src/app/asset-urls.ts`) maps a root-relative
public asset path (`/assets/app.js`) to the same path with a content-derived
query (`/assets/app.js?v=<sha256>`). Hashing streams the file through SHA-256 and
is cached by `mtimeMs` + `size`, so an unchanged asset is never re-read. The
resolver is a **graceful-degradation seam, never a source of errors**: a missing
directory/asset, a traversal/absolute/hidden/backslash/query/fragment path, or a
symlink all return the unversioned path unchanged, so browser-free SSR (where
`public/` may not exist) still renders, and a hostile path is never read from
disk.

`context.assetUrl` is optional; `Application` and `createApp` attach the resolver
to each request context and the static export attaches it to each synthesized
page context. The starter layout tags the stylesheet and the module script with
`data-turbo-track="reload"`; Turbo compares that URL across navigations, so a
content change that keeps the same filename yields a new URL and forces a **full
reload** instead of serving a stale deployment cache. This is the intentional
exception to soft navigation: an unchanged asset keeps the same URL, so ordinary
links stay fast soft navigations, while changed build assets reload. The script
also carries `data-turbo-eval="false"` so Turbo does not re-evaluate the client
entry on every navigation. When no resolver is wired in (e.g. browser-free SSR),
`loadLayout` falls back to the plain `/assets/app.css` and `/assets/app.js`
paths.

## Server components

`jsails/server-components` is **server-only** (`node:crypto` + Preact). It is a
Livewire-like, signed, **stateless** state protocol: component state is carried
in a signed snapshot, not a server-side UI store. Define components with
`defineServerComponent` / `defineAction`, register them through the
`serverComponents({ components })` extension, and render one from a page's
`load` with `renderServerComponent(name, context)` (Preact VNode) or
`renderServerComponentHtml(name, context)` (raw string). The HTTP layer mounts
`POST /_jsails/components/update` only when an extension registered a runtime;
the runtime owns every origin/CSRF/signature/policy check.

- `stateSchema` (a Zod object, forced `.strict()`) is the single source of truth
  for persisted state. `writableKeys` names **only** the top-level fields a
  CLIENT update may set (default: none; every entry must be a real top-level
  field). This restricts client edits only: actions run server-side and may
  change **any** schema-valid field regardless of `writableKeys`.
- `authorize(context)` is **REQUIRED** and default-deny (an exact `true` allows;
  truthy non-boolean, throw, and rejection all deny). An action may add its own
  `authorize(context, state, input)`. Action `input` is a Zod schema for a
  **separate args object**, parsed and passed to `run(state, args, context)` —
  never derived from an assumed `FormData` shape.
- `render(state, tools)` receives `bind(name)` / `call(action, args?)` /
  `submit(action, args?)` helpers that return attribute maps to spread onto
  elements; `submit` pins `data-turbo="false"` so it is a plain form POST. The
  runtime owns serialization and transport.
- An update verifies the snapshot (HMAC-SHA256 signature, expiry, hashed
  subject binding, trusted origin) **before** the component is looked up,
  enforces same-origin + a required CSRF header (session CSRF token, or for an
  anonymous public component the verified snapshot id — a possession token, not
  an authentication identity), re-runs the component `authorize` for the
  **current** request, applies client edits under `writableKeys`, validates the
  strict state, runs at most one allowlisted action, re-validates the whole
  state, and returns a re-signed snapshot plus synchronized HTML. A `ZodError`
  thrown from `run` becomes a `422` with field errors and repopulated values.
- **State is PUBLIC.** The token is integrity-protected, **not encrypted**, and
  readable by anyone who holds it — never place credentials or secrets in
  component state. The raw session id is never serialized; a purpose-separated
  HMAC tag binds the snapshot to the session. There is **no exactly-once
  processing, no replay prevention, and no atomic DB rollback**: a valid token is
  replayed until it expires and every request reconstructs state from it, so a
  handler must make its own persistence idempotent. This is not full Livewire
  parity.
- `staticFallback(context)` is the **only** thing rendered during static export:
  read-only, with no signing key, no state, and no actions; a component without
  one throws a value-free error in static mode. The static wrapper still carries
  the component-name attributes but **no** snapshot, CSRF token, or live id, and
  no interactive form.
- Signing-key precedence, resolved **lazily** only when a live render/update
  signs or verifies: explicit `signingKey` → `JSAILS_COMPONENT_SECRET` → a fresh
  random key **only** when `NODE_ENV` is exactly `development` or `test` →
  otherwise a `ServerComponentsError`. A standalone `jsails serve` outside those
  modes must configure the key; the framework ships **no fake identity or auth
  kit**. The `dev` child and the test runners mint a default key only when none
  is supplied. The starter's `task-list` is an explicitly public, **transient**
  demo (no database, no account) whose policy is `authorize: () => true`;
  replacing that with a real session check is the app's job.

```tsx
// components/task-list.tsx  (app-owned; server-only module)
import { z } from 'zod';
import { defineAction, defineServerComponent } from 'jsails/server-components';

const stateSchema = z
  .object({ title: z.string().max(120), tasks: z.array(z.string().min(1)).max(50) })
  .strict();

export const taskList = defineServerComponent<z.infer<typeof stateSchema>>({
  name: 'task-list',
  stateSchema,
  writableKeys: ['title'], // only the bound input is client-writable
  initialState: () => ({ title: '', tasks: [] }),
  authorize: (context) => context.session !== null, // default-deny; exact true
  actions: {
    add: defineAction({
      input: z.object({}), // explicit args, separate from bound state
      run(state) {
        const parsed = z
          .object({ title: z.string().trim().min(1) })
          .safeParse({ title: state.title });
        if (!parsed.success) throw parsed.error; // mapped to a 422 field error
        state.tasks.push(parsed.data.title);
        state.title = '';
      },
    }),
  },
  render(state, { bind, submit, errors }) {
    return (
      <form {...submit('add')}>
        <input {...bind('title')} />
        {errors.title ? <p role="alert">{errors.title}</p> : null}
        <button type="submit">Add</button>
      </form>
    );
  },
  // Static export renders only this: no state, no signing, no actions.
  staticFallback: () => <p>The live task list is unavailable in the static export.</p>,
});
```

```tsx
// pages/tasks.tsx  (app-owned page)
import type { RequestContext } from 'jsails';
import { renderServerComponent } from 'jsails/server-components';

export async function load(context: RequestContext) {
  return { taskList: await renderServerComponent('task-list', context) };
}
export default function Tasks({ taskList }: { taskList: unknown }) {
  return <main>{taskList}</main>;
}
```

```js
// jsails.app.js  (app-owned; compiled ESM)
import { serverComponents } from 'jsails/server-components';
import { taskList } from './dist/components/task-list.js';

export default {
  rootDir: '.',
  extensions: [
    // `components` is a plain object map keyed by name (arrays are rejected).
    // The key is not hardcoded: explicit signingKey / JSAILS_COMPONENT_SECRET,
    // or an ephemeral key only in development/test, else a live render fails.
    serverComponents({ components: { 'task-list': taskList } }),
  ],
};
```

## Starter application and UI

`createStarterFiles()` (`src/app/starter.ts`) is the **programmatic** advanced
helper: it reads a fixed whitelist of bundled text templates from
`templates/starter/`, strips `.template` suffixes, rewrites `package.json`'s name
and `jsails` dependency, and returns an in-memory `{ files }` map. It performs no
writes, installs, or subprocesses; the `create` CLI command composes it with
`writeProjectFiles` (`src/app/scaffold.ts`) to materialize the map on disk.

The generated UI is **app-owned** and lives entirely in the starter templates —
the framework core exports **no** UI component library. It uses Tailwind 4 +
daisyUI 5 through the starter's own `vite.config.js`, two thin helper wrappers
(`Field` and `Dialog` in `ui/components.tsx`), and a shared document shell
(`Layout` / `loadLayout` in `ui/layout.tsx`) that resolves content-hashed asset
URLs and renders the top-level links. Three pages ship: Home (`pages/index.tsx`)
mounts the `counter` island, About (`pages/about.tsx`) is plain static markup,
and Tasks (`pages/tasks.tsx`) renders the `task-list` server component alongside
the counter island (kept **outside** the component root so its local state
survives a server-component morph).

`client/main.tsx` is the whole browser entry: it calls
`registerIsland('counter', ...)` once and then `startClient()`. There is no
manual `hydrate`, `fetch`, or `history` call, and no automatic island
registration — the island is registered explicitly and hydration is owned by the
framework runtime. The counter is frontend-only (daisyUI card + native
`<dialog>`); reloading resets it. `task-list` is the live backend demo and
deliberately says so: transient per-instance state, no database, no account.
There is still **no authentication/authorization kit** and no separate `init`
command; mobile/offline behavior is future work and is not implemented.

## Extending JSails

This is the framework-wide extensibility seam, independent of the data layer.
Import from **`jsails/extensions`** for an ORM-free entry (Hono is referenced via
`import type`); the root `jsails` entry re-exports the same symbols but pulls in
`reflect-metadata` and TypeORM.

- `createServiceToken<T>(name)` makes an opaque typed token. Identity is the
  token object itself, not its name, so define each token **once** and share it
  between providers and consumers. `name` is a diagnostic label only.
- Services are per application: `runExtensions([...])` (or `createApplication`)
  builds a fresh registry. There is no global registry and no cross-app sharing.
- An extension is a plain object `{ name, requires?, setup(context) }`. Names
  must be non-empty and unique (a duplicate errors before any setup runs).
  `setup({ services, configureHttp })` may return a cleanup function.
- `requires` lists service tokens that must already be registered by an
  **earlier** declared extension; a missing requirement fails before `setup`.
- Cleanups run in **reverse** declaration order on `close()`. If a `setup`
  throws, already-completed extensions are cleaned up and the registry cleared.
  An extension that throws before returning its teardown **owns the cleanup of
  whatever it partially created** — return the teardown as soon as resources
  exist so a later failure can dispose of them.
- `configureHttp(hook)` collects native Hono hooks (once, in declaration order).
  Hooks are trusted application code: routes they add own their own security and
  are **not** covered by the filesystem default-deny API pipeline.

```js
// jsails.app.js  (app-owned, compiled ESM; plain default export)
import { createServiceToken } from 'jsails/extensions';

// Token defined once, shared by the provider and the consumer.
export const clock = createServiceToken('clock');

const clockExtension = {
  name: 'clock',
  setup({ services }) {
    services.provide(clock, { now: () => new Date().toISOString() });
  },
};

const healthExtension = {
  name: 'health',
  requires: [clock], // provided by the earlier "clock" extension
  setup({ services, configureHttp }) {
    const { now } = services.get(clock);
    configureHttp((app) => {
      // Native Hono route; this hook owns its own authorization.
      app.get('/healthz', (c) => c.json({ ok: true, at: now() }));
    });
  },
};

const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Trusted HTML producer: it owns escaping.
const htmlRenderer = {
  render(entry) {
    return `<!DOCTYPE html><html><body><h1>${escapeHtml(entry.route)}</h1></body></html>`;
  },
};

export default {
  rootDir: '.',
  out: 'out',
  extensions: [clockExtension, healthExtension],
  renderer: htmlRenderer,
};
```

Custom persistence needs neither TypeORM nor a migration init: implement the
`ResourceStore` interface (or provide it under a service token) and pass it to
`createResourceHandlers`. The package still **depends on TypeORM**, and its
built-in migration CLI remains TypeORM-specific.

The `jsails/extensions` subpath also carries **type-only** author contracts for
out-of-tree plugins: `JobRuntimeAdapter` (with `JobAdapterContext`,
`RuntimeProducer`, `RuntimeWorker`, `RuntimeJob`, `ProcessJob`,
`JobDispatchOptions`), `BroadcastAdapter`/`BroadcastHandle`,
`CliCommand`/`CliCommandContext`, and
`DeploymentGenerator`/`DeploymentFileMap`/`DeploymentGeneratorContext`. Every one
is erased at compile time, so the subpath still imports only `./services.js` and
`./extension.js` and stays free of ORM/HTTP/queue/Socket.IO runtime libraries.
Runtime construction (`createJobsRuntime`, `createBullMQAdapter`,
`createSocketIOBroadcastAdapter`, `createCliCommandRegistry`,
`createDeploymentGeneratorRegistry`, ...) lives in the root entry, never here.

Remaining limits — do not overstate:

- The built-in migration CLI stays TypeORM-specific; only the data/store and
  HTTP/page seams are generalized.
- A custom server-side broadcast transport needs its own matching client:
  `jsails/broadcast/client` is Socket.IO-specific.
- The deploy-generator registry is programmatic; there is no `jsails generate`
  CLI command, and it never writes files or deploys.
- HTTP hooks compose with the built-in pipeline; they do not automatically
  replace every internal step.
- There is no full auth/authorization system. The starter's UI components are
  app-owned template files, not a framework UI layer; the framework runtime owns
  hydration, but every island must still be registered explicitly.

## Deploy config generators

`generateDevValkeyConfig`, `generateKamalValkeyConfig`,
`generateDevDatabaseConfig`, `generateKamalDatabaseConfig` return **strings
only**; they never run Docker, `kamal`, or open a connection. Output is not
deployed and is not a complete scaffold.

- Valkey: pinned `valkey/valkey:8.0-alpine`, AOF persistence, no published 6379
  port. The startup script requires `VALKEY_PASSWORD` (≥32 URL-safe chars) and
  injects `requirepass` at runtime; the healthcheck authenticates via
  `REDISCLI_AUTH`. Filenames: `docker-compose.yml`, `valkey.conf`,
  `start-valkey.sh`, `.env`; Kamal emits `config/deploy.yml`,
  `config/valkey/valkey.conf`, `config/valkey/start-valkey.sh`, `.kamal/secrets`.
- Database: default MariaDB (`mariadb:11.4`), Postgres via `driver: 'postgres'`.
  Credentials are env references, never baked in; the app reads `DATABASE_*`
  variables individually — no connection URL is emitted.

### Deploy generator registry

`createDeploymentGeneratorRegistry({ includeBuiltins?, generators? })` is a
neutral container over named `{ name, generate(input, context?) }` generators;
`defineDeploymentGenerator(name, generate)` is the typed helper. It includes the
five built-in adapters by default (`includeBuiltins: false` for a custom-only
registry) with deterministic ids `valkey-dev`, `valkey-kamal`, `database-dev`,
`database-kamal`, `once` (`BUILTIN_DEPLOYMENT_GENERATOR_IDS`). `generate` returns
`{ files }`; the registry validates every path as a portable relative path —
rejecting absolute/Windows-drive/UNC paths, backslashes, `..`, `__proto__`,
control characters, and file/dir collisions — and copies it into a frozen,
prototype-free map. It never writes files, never touches
`node:fs`/`node:child_process`, and never runs Docker, SSH, or `kamal`; the caller
owns all writing and deployment.

The registry is **programmatic** — there is no `jsails generate` CLI command. The
built-in `database-kamal` adapter emits fragments
(`config/deploy.database.yml`, `config/deploy.database-env.yml`,
`.kamal/secrets.database.example`) to merge into an existing deploy config; it is
**not** a complete config, unlike `valkey-kamal`, which emits a full
`config/deploy.yml`.

### ONCE deployment preset

The opt-in built-in `once` adapter wraps `generateOnceConfig` and emits three
strings: a multi-stage `Dockerfile.once`, a `.dockerignore`, and a
`jsails.once.js` ESM wrapper around the app's real `jsails.app.js`. It is a
Basecamp ONCE preset: the image listens on port 80 (`host: '0.0.0.0'`), creates
and chowns `/storage` (and the legacy `/rails/storage`) to the `node` user,
drops to that unprivileged user, and starts the `jsails` CLI by its
`node_modules/.bin/jsails` path to `serve --config jsails.once.js`. Like the
other generators it is pure: it never writes files, runs Docker or ONCE, opens a
connection, or embeds a secret. Building the image still requires a resolvable
`jsails` dependency (published, or vendored via a `file:` tarball) and a
committed `package-lock.json`.

ONCE injects environment variables into the container, and the wrapper maps
`BASE_URL` to `publicOrigin` conditionally. JSails does **not** use ONCE's
`SECRET_KEY_BASE`: plain SSR/SSG needs no framework secret at all, and only
signed server components need a stable signing key — an explicit `signingKey`
or `JSAILS_COMPONENT_SECRET` the app supplies itself (for example through
ONCE's custom environment settings), never `SECRET_KEY_BASE`.

- **`SECRET_KEY_BASE` is never read by JSails core.** Sessions, CSRF, jobs,
  broadcast, plain page rendering, and the static export need no framework
  secret. In development/test the server-component signer mints an ephemeral
  key, and every other mode requires an explicit `signingKey` or
  `JSAILS_COMPONENT_SECRET`; the ONCE wrapper neither reads `SECRET_KEY_BASE`
  nor mutates `JSAILS_COMPONENT_SECRET`.
- **`BASE_URL` maps to `publicOrigin` only when set** (an unset `BASE_URL`
  preserves the app's own `publicOrigin`, never hardcoding one). `publicOrigin`
  is consulted only for the same-origin `Origin` validation of cookie-
  authenticated mutations and server-component updates behind ONCE/kamal-proxy
  TLS termination; plain pages, static export, and the `/up` health route never
  need it.

ONCE lets an app supply custom environment variables at install time or after
install: through the `once` CLI (`deploy --env KEY=VALUE` or `update <host>
--env KEY=VALUE`) or the TUI's Settings → Environment screen. They are stored in
the `once` Docker label as `"env"` and passed verbatim as `k=v`, appended last so
they override injected variables such as `BASE_URL`. The TUI caps keys at 256 and
values at 1024 characters and rejects empty keys, but values are not masked and
remain visible in the UI — store only what that exposure is acceptable for. This
is how a JSails app can set `JSAILS_COMPONENT_SECRET` for signed server
components, or `DATABASE_*`/`VALKEY_URL` for external services it runs itself
(ONCE provisions neither a database nor Valkey), without code changes; the
`readDatabaseEnvironment`/`readValkeyEnvironment` readers consume them as usual.

Limitations — do not overstate: the preset assumes a resolvable `jsails`
dependency, no Docker or ONCE run happens in CI, ONCE does **no** MariaDB/Valkey
provisioning and **never chowns** the mounted volume (the image creates and owns
`/storage` itself), and the preset provides no writable SQLite path.

## CLI surface and limitations

The CLI (`src/cli.ts`) implements nine built-ins: `makemigrations`, `migrate`,
`showmigrations`, `work`, `schedule`, `build`, `serve`, `create`, `dev`. Config
defaults are `jsails.config.js` (migrations), `jsails.runtime.js`
(`work`/`schedule`), and `jsails.app.js` (`build`/`serve`/`dev`). `build`,
`serve`, and `dev` take no host/port/output flags — those come from the app
config; `create` takes no `--config`.

- `create <dir> [--name <pkg>] [--jsails-dependency <file:...>] [--install]`
  generates the starter file set with `createStarterFiles` and writes it through
  `writeProjectFiles`. It refuses an existing non-empty target, a symlink target,
  and a non-directory target, and never overwrites an existing file. Nothing is
  installed unless `--install` is passed; a failed install returns its exit code
  but keeps the scaffold so the user can retry.
- `dev` compiles and watches: an initial `tsc -p tsconfig.json` (when
  `tsconfig.json` exists) and `vite build` (when a Vite config exists), then both
  in watch mode, plus nodemon restarting `serve` when compiled JS or the app
  config changes. New routes are compiled and served; the same app port is
  reused. There is no HMR — reload the browser manually. Each tool must be
  installed in the project; a present config with a missing binary reports "run
  npm install".

### User-defined CLI commands

An application can add commands without touching the entry point by declaring
them on the app config (`commands: [...]`) or on an extension
(`extensions: [{ ..., commands: [...] }]`). `runCli` dispatches a leading
non-builtin token to the custom path. A command object is
`{ name, summary, usage?, run(rawArgs, ctx) }`; `run` may return nothing (exit
0), a number in `0..255`, or a promise of either, and `ctx.stdout`/`ctx.stderr`
write lines.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
export default {
  commands: [
    {
      name: 'hello',
      summary: 'say hello',
      usage: 'hello [name]',
      run(rawArgs, ctx) {
        ctx.stdout(`hello ${rawArgs[0] ?? 'world'}`);
      },
    },
  ],
};
```

```sh
jsails hello --config jsails.app.js --rawargs
```

- Syntax is `<command> [--config <path>] [raw args]` — the command name comes
  first. The custom path is taken only when `--config` is explicit or the
  default `jsails.app.js` exists.
- Only `--config <value>` / `--config=<value>` **before** a `--` delimiter are
  parsed; every other token — including `--` itself and everything after it — is
  forwarded verbatim and in original order to `run`.
- `jsails <command> --help` prints that command's exact metadata
  (`name - summary`, `Usage: jsails <usage>`) without invoking `setup`, `run`,
  or `createApplication`. Global `jsails --help` imports no app config. No
  application is assembled for a custom command and no extension `setup` runs.
- A config module must still be imported to collect commands, so its own
  top-level code runs — trusted app JS side effects are not prevented.
- The nine built-in names above are always reserved and cannot be shadowed.

Authentication primitives in `src/auth/`
(scrypt password hashing, session manager/CSRF) are **internal, not exported from
the package index, and are not a finished authentication/authorization system** —
build production auth on maintained libraries. There is no separate `init`
command; scaffolding is `jsails create`.

## Testing

`jsails/testing` is a **server-only** subpath for in-process tests. Importing it
pulls in the application runtime (Hono, page rendering, the config loader); it is
never part of the browser-safe root entry. `createTestApp(options?)` assembles a
real `Application` over the **same Hono pipeline `serve` uses** and routes every
request through `Application.fetch`: no HTTP server listens, no broadcast
transport is attached, and no Valkey connection is opened automatically. Pages
render through the built-in Preact renderer (or the configured renderer) and API
routes go through the normal default-deny / session / CSRF pipeline, so server
HTML and API behavior are the real output.

The generated starter's `npm test` is the default, browser-free path. It runs
`tsc -p tsconfig.json` (the server project) and then `node scripts/run-tests.mjs`,
which collects only compiled `*.test.js` files under `dist/test/` (never a
Playwright `*.spec.js`) and forwards extra flags to `node --test`. Tests use the
built-in `node:test` runner and native `node:assert/strict` — no third-party
framework. `npm run test:report` runs the same tests with a spec reporter on
stdout plus a JUnit XML report at `test-results/junit.xml`; `--enable-source-maps`
maps failure stacks back to the original TypeScript source locations. `npm run
check` remains the compiler/client/static-build check (`typecheck` then `build`);
it does **not** execute the native app test suite.

### The `createTestApp` surface

`createTestApp` resolves config like the runtime: pass a raw `config` object
(validated by `validateAppConfig`) **or** a `configPath` to a compiled config
module (loaded by `loadAppConfig`, default `jsails.app.js`) resolved against
`cwd`. The two are mutually exclusive. The request origin is the explicit
`origin` (a validated `http(s)` origin — no credentials, path, query, or
fragment) when given, else the configured `publicOrigin`, else the `TEST_ORIGIN`
environment variable, else `http://localhost` (`DEFAULT_TEST_ORIGIN`).

- `fetch(request)` — route a native `Request` directly; the escape hatch for
  deliberately exercising a non-test origin in-process.
- `request(path, init?)` — build a `Request` **pinned to the resolved origin**
  and route it; rejects a path that resolves off-origin, carries credentials, or
  uses a non-`http(s)` scheme before any handler runs. Returns the `Response` for
  **any** status, so negative HTTP assertions use it.
- `json<T>(path, init?)` — `request` plus a 2xx check and JSON parse; rejects
  with `TestRequestError` on a non-2xx status or invalid JSON. Its message never
  embeds the response body, the underlying cause, or the request URL (which may
  carry secrets).
- `close()` — idempotent teardown. Pass `lifecycle: t` (a `node:test`
  `TestContext`) to register `t.after(...)`, so the app closes automatically when
  each test finishes.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTestApp } from 'jsails/testing';

test('home page is served as HTML', { timeout: 30_000 }, async (t) => {
  const app = await createTestApp({ lifecycle: t });

  const response = await app.request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);

  // The response body is caller-owned: consume it explicitly.
  const html = await response.text();
  assert.match(html, /<title>JSails Starter<\/title>/);

  const missing = await app.request('/does-not-exist');
  assert.equal(missing.status, 404); // request() returns negative statuses.
});
```

**No sandbox.** Loading a trusted app config module and running its `setup` /
extensions can open whatever connections the app config selects — a database,
Valkey, or any other service. `close()` tears the app down (services and the
extension registry are fresh per call), but there is **no automatic database
rollback**, no global module reset, and no cookie jar. Point each test at
isolated fixtures and seeds it owns; cookies, sessions, and other state persist
only when the test sets them explicitly. The test surface also does not exercise
Socket.IO or any native broadcast-adapter transport, because no transport is
attached in-process. Core HTTP producer errors remain sanitized, and the testing
helpers add no JSON CLI flags. The generated `test/app.test.ts` cases are shared
by humans and AI agents: plain, readable `node:test` examples that document
server behavior both audiences can extend.

### Browser tests (optional)

`npm run test:browser` runs `npm run build && playwright test`. It is an optional
developer/AI UI tool, never part of the default `npm test` path: `@playwright/test`
is a starter devDependency, and there is **no automatic browser download** — set
`JSAILS_BROWSER_PATH` to an installed Chrome/Chromium or run
`npx playwright install chromium` yourself. Playwright starts the already-built
app on an isolated local server (`127.0.0.1:4173` by default; override with
`JSAILS_TEST_PORT`) and never reuses an existing service.

Screenshots and traces require a browser. Failure screenshots are attached to the
test; traces are opt-in only with `JSAILS_TRACE=1`. The JSON report lands in
`test-results/results.json` and the HTML report in `playwright-report/`.
`test-results/` and `playwright-report/` are git-ignored because reports,
screenshots, and traces can embed private UI, console, and network data — keep
them out of version control. Specs use the standard Playwright API; no bespoke
DSL, no LLM service, and no global MCP configuration is required.

The generated browser specs cover the counter island, the native `<dialog>`,
Home/About soft navigation, adding a task through the `task-list` backend
action, rejecting a blank task (422), a mid-edit in-flight navigation, and the
native opt-out / modified-click cases — i.e. the island runtime and server
actions are implemented and exercised, not aspirational. There is still **no
authentication/authorization kit** and no mobile/offline support; do not present
the starter as production-ready on those fronts.

## Verification

```sh
npm run check            # typecheck, lint, format check, then the full test build
npm run verify:starter   # opt-in end-to-end starter verification (see below)
npm run verify:starter -- --skip-browser  # same pipeline, 0 browsers launched
```

`npm run check` typechecks, lints, verifies formatting, then builds and runs the
compiled `node:test` suite. Unit
tests cover the schema/migration/jobs/legacy-and-neutral-runtime/broadcast/
deploy/CLI/app/extension surfaces without external services, plus the
`create`/install and `dev` argv/protocol decisions through injected fakes.
`FileDataSource` runs against a real in-process `sqljs` (WASM SQLite), and
broadcast is exercised against a real local same-port HTTP server on loopback.
There is no live-Valkey, live-MariaDB, or Docker integration test, so those
paths remain unverified end to end.

`npm run verify:starter` is **opt-in** — no CLI command triggers it and it is
not part of `check`/`test`. It builds the framework, `npm pack`s it, invokes the
real `jsails create --install` with a `file:` tarball dependency into a temp
fixture, imports the *packaged* `createStarterFiles`, runs the fixture's
`check`, validates the exported `out/`, then runs the fixture's `test:report`
native suite (a **pass** plus an `expected-failure` negative proof) and, in the
default full run, drives browser QA against `jsails serve`, a pure static serve
of `out/`, and a live `jsails dev` run. The browser suite exercises the
island/Turbo journeys (counter hydration, dialog, Home/About soft navigation,
the `task-list` backend action and its 422 branch, an in-flight edit, and the
native opt-outs), asserts soft navigation over the statically exported pages,
and drives backend state through the server-component action. The `dev` stage
validates backend restart, an added route, Vite CSS rebuild, and no leaked child
processes, and it waits on a bounded latest-live-URL readiness probe (a
quiescence window plus a 2xx check within an overall timeout) rather than a fixed
sleep. `--skip-browser` runs that same
pack/install/check/native-test pipeline but records each of the five browser
stages (test:browser, its negative proof, serve QA, static QA, dev-server QA) as
an explicit `skipped` — never run, never probed — and launches **0** browsers.
The default full run (no flag) is unchanged; unknown flags are rejected. Stage
and test totals vary by run and are not hardcoded here. The fixture install runs
with `npm_config_ignore_scripts` so the public dependency graph runs no lifecycle
hooks, and no OS or browser binaries are downloaded — browser stages use an
already-present Chromium (`JSAILS_BROWSER_PATH`) and fail explicitly rather than
claiming a pass. The real end-to-end run is Linux / Node 26 / Chromium;
Windows-compatible teardown code (`owned-process-tree.ts`, `npmInstallSpawn`) is
present but exercised only through simulated argument/protocol tests, so there
is **no live Windows verification**.

### Contributor commands

`npm run check` runs `typecheck`, then `lint`, then `format:check`, then the
full test build. For iterative work, run two terminals: `npm run build:watch`
(a `tsc --watch` that
keeps `dist/` current) and `npm run test:watch` (`node --test --watch`) over the
compiled tests. `test:watch` precompiles once through its `pretest:watch` hook
but does **not** clean `dist/`, so it seeds from whatever was already built;
restart the watch after adding new test files so the runner globs them. `npm run
typecheck:watch` and `npm run test:coverage` are also available. Coverage
reports **loaded** code only — modules never reached by the tests are not a
guaranteed coverage figure.

Prettier is the formatter (`.prettierrc.json`: 2-space indent, single quotes,
semicolons, trailing commas `"all"`, print width 100, `arrowParens` always,
LF line endings) and owns all formatting. ESLint 10 + typescript-eslint is the
linter (`eslint.config.mjs`, flat config). Linting is **type-checked**: `src`
and `test` TypeScript files run under
`tseslint.configs.recommendedTypeChecked` with
`parserOptions.projectService: true` (typed against the same `tsconfig.json`
`includes`, so `eslint .` needs no explicit `--project`), while the remaining
surface stays on the untyped `recommended` preset. `eslint-config-prettier` is
wired in as the **last** flat-config entry so the two never fight: ESLint owns
correctness, Prettier owns style. Every code change must end with `npm run lint`
and `npm run format` (or `npm run check`, which enforces both) — agents always
run them at the end of a task — and findings are fixed, never suppressed: a rule
that conflicts with an established pattern is disabled only in
`eslint.config.mjs` with a written justification. typescript-eslint still
supports TypeScript `<6.1.0` only (typescript-eslint#10940), so the repo builds
with TypeScript 7 (the `tsc` binary, via the `@typescript/native` alias) while
the parser resolves the official `@typescript/typescript6` side-by-side API (the
`typescript` package); oxlint is a noted fallback/complement when native TS 7
support ships. Re-check typescript-eslint issue #10940 whenever the TypeScript
or ESLint versions change; once native TypeScript 7 support ships, remove the
`@typescript/typescript6` alias and this compatibility note. Toolchain work
around TypeScript 7 decorators remains unresolved.

### Source guide

- Client runtime: `src/client/index.ts`, `src/client/islands.ts`,
  `src/client/navigation.ts`, `src/client/component-state.ts`,
  `src/client/components.ts`.
- Server components: `src/server-components/index.ts`,
  `src/server-components/component.ts`, `src/server-components/extension.ts`,
  `src/server-components/runtime.ts`, `src/server-components/snapshot.ts`,
  `src/server-components/protocol.ts`.
- Asset URLs: `src/app/asset-urls.ts`.
- Starter templates: `templates/starter/pages/`, `templates/starter/components/`,
  `templates/starter/ui/`, `templates/starter/client/main.tsx`,
  `templates/starter/jsails.app.js.template`.

This file travels into generated apps: `createStarterFiles` bundles this guide
and prefixes it with starter-specific instructions, so a scaffolded project ships
a reader guide without any runtime import of the framework's copy.
