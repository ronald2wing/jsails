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
  actions), `jsails/notifications` (multi-channel delivery: memory/mail channels
  plus a plugin), `jsails/testing` (server-only in-process test application),
  `jsails/i18n` (a dependency-free message translator with pluralization),
  `jsails/flags` (feature flags: in-memory/database stores plus a plugin),
  `jsails/diagnostics` (in-memory diagnostics recorder + plugin + pluggable watchers),
  `jsails/logging` (record-first structured logging: channels, formatters, plugin),
  `jsails/encryption` (symmetric AES-256-GCM encryption with key rotation),
  `jsails/validation` (composable Zod-backed validation rules),
  `jsails/http` (fetch-based HTTP client with injectable fetch),
  `jsails/jobs` (provider-neutral job runtime, metrics, tags, lifecycle events, and failed-job store),
  `jsails/theme` (browser-safe CSS custom property token contract: core set + plugin contributions, app-wins-highest precedence),
  `jsails/jsx-runtime`, `jsails/render-to-string`.
- Verify with `npm run check` (typecheck, lint, format check, then the full
  test build) and the opt-in `npm run verify:starter`.
- Docs: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (how the framework is
  assembled, with diagrams) and [`docs/CODEMAP.md`](./docs/CODEMAP.md) (annotated
  source-tree map + package subpaths).

## Primary workflow

With the CLI installed, the fast path for a new app is:

```sh
jsails create my-app --install
cd my-app
npm run dev     # compile + watch + serve (restarts the backend on changes)
npm run build   # compile TS/assets, then static-export into out/
```

`create` scaffolds a single Preact starter using the framework's own client
runtime: the Home page registers a `counter` island and hydrates it via
`startClient` (no hand-written `hydrate` call), the Tasks page renders a live
`task-list` server component with a backend action, About is a plain static
page, and Login/Dashboard/Device pages back a local email/password sign-in flow
(Better Auth over MariaDB). The starter always ships auth — there is no `--auth`
flag — while the admin panel and the first-party blog are opt-in via `--admin`
and `--blog` (`--blog` implies `--admin`); the default is auth-only. `--cli`
scaffolds a Laravel-Zero-style CLI-only project with **no web surface**
(no `pages/`, `api/`, `public/`, `client/`, auth, admin, blog, or Vite) but the
**same framework and plugin system**: it ships a real `jsails.app.js` with
`plugins.enabled: []` and the extension seam, plus a trimmed `package.json`/
`tsconfig.json` (no JSX/DOM). It is
mutually exclusive with `--admin`/`--blog`. It refuses
a non-empty or symlink target, writes files only, and runs `npm install`
**only** with `--install`; a failed install keeps the generated files so the
user can retry. Its scoped flags are `--name <pkg>` (defaults to the directory
basename), `--jsails-dependency <spec>` (a `file:` tarball/path), `--admin`,
`--blog`, and `--cli`.

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

`JsailsDataSource` (`src/database/data-source.ts`) extends TypeORM's
`DataSource` and restricts drivers to `'mariadb' | 'postgres' | 'mysql' | 'sqlite'`.
**MariaDB is the recommended default**, Postgres is supported, the `mysql`
driver is retained for compatibility (`mysql2`), and the logical `sqlite`
driver surfaces a persistent, single-file SQLite database through TypeORM's
`sqljs` driver. Construction rejects
`synchronize`, `dropSchema`, `migrationsRun`, and a TypeORM `migrations` config —
JSails owns its schema history. `getModelSchema()` builds entity metadata
offline; it never opens a connection.

Use `BaseEntity` for Active Record entities, or `EntitySchema`. The portable
schema model covers: scalar columns (`integer`, `varchar` with explicit
`length`, `text`, `boolean`, `datetime`, `decimal` with `precision` and optional
`scale`, `float`, `bigint`, `uuid`, `json`, `date`, `time`), a single generated
integer primary key or a composite primary key, simple (non-partial,
non-expression, non-fulltext/spatial) indexes, simple unique constraints,
table-level `CHECK` constraints (caller-owned raw SQL `expression`; add/drop
operations + autodetect diffing), and single- or multi-column (composite)
many-to-one foreign keys with `CASCADE`/`RESTRICT`/`SET NULL`/`NO ACTION`
actions. Many-to-many relations are supported through explicit junction-table
entities or auto-generated `@JoinTable()` junction tables (a composite primary
key plus two foreign keys). Deferrable foreign keys and unique constraints are
supported on Postgres only; non-postgres drivers reject them. Partial/expression
indexes, enums, generated UUIDs, computed columns,
`@CreateDateColumn`/`@UpdateDateColumn`, and function defaults are rejected with
`UnsupportedSchemaError`. `decimal` precision/scale changes are destructive in
autodetection.

`FileDataSource.create({ models })` (`src/database/file-data-source.ts`) is a
**read-only**, in-memory Active Record source backed by TypeORM's `sqljs`
driver. It seeds from in-memory `rows` arrays or JSON `file`s, validates every
row against the portable schema, then flips SQLite into `query_only` mode: the
same `BaseEntity` static queries work, while any write fails at the SQLite level.
It is a convenience for tests, demos, and read-only catalogs, not a sandbox — a
trusted caller can reach the raw `DataSource` through
`handle.getRepository(entity)` and re-enable writes.

### Transactions

`transaction(dataSource, body)` (`src/database/transaction.ts`, exported from
`jsails/database` and the root entry) wraps TypeORM's `manager.transaction` and
adds a per-call `TransactionHandle` — `{ manager, afterCommit(cb),
afterRollback(cb) }`. The body receives the **transaction-scoped**
`EntityManager`, not the raw data source's manager. `afterCommit` /
`afterRollback` callbacks are **per-call** (no global registry) and run
**awaited, in registration order**, at the **outermost** boundary only. On
success the transaction commits, then `afterCommit` callbacks run, then the
body's value resolves; a throwing `afterCommit` callback propagates and
**replaces the body result** — the commit already happened, so writes are
durable even though the caller observes an error. On failure the transaction
rolls back, then `afterRollback` callbacks run, then the **original body error
is re-thrown unchanged**; a throwing `afterRollback` callback is **swallowed**
(cleanup must not mask the original cause). **Nested calls join the outer
transaction**: a `transaction()` inside a body for the **same**
`JsailsDataSource` reuses the outer manager and appends its callbacks to the
outer boundary (fired once, at the outermost commit/rollback), while a nested
call for a **different** data source opens an independent transaction
(implemented with `AsyncLocalStorage` keyed by data-source identity).
`TransactionError` covers only the wrapper's own invalid arguments (bad data
source / non-function body); body failures propagate unwrapped. A
validation/subscriber throw inside a `transaction()` body rolls back the whole
transaction and fires `afterRollback`.

### Model-level validation

`defineEntityValidation(entity, schema)` (`src/database/entity-validation.ts`,
exported from `jsails/database` and the root entry) returns an immutable
`{ entity, schema }` descriptor. `validateEntity(validation, data)` returns a
flat `FieldError[]` (`[]` on success; never throws for a validation failure) and
`assertEntityValid(validation, data)` throws an `EntityValidationError` carrying
`.errors`. `FieldError` is the same `{ field, message }` type from
`jsails/validation`; messages come from the authored Zod schema
(`issue.message`), input values are never echoed, and dotted paths are used
(`_root` for a root-level failure). `entityValidationHooks(validation)` bridges
to the subscriber seam: it returns a `defineEntityHooks` definition gating
`beforeInsert` **and** `beforeUpdate`, wired through the existing
`createEntitySubscriber` in the data source's `subscribers` list — an invalid
`save()` throws `EntityValidationError` and aborts (rolling back the surrounding
transaction). Do not wire it manually through `defineEntityHooks`;
`entityValidationHooks` already does that. It works for `BaseEntity` classes and
`EntitySchema`-defined entities alike (it operates on hook `data`, no class
required). **Deliberate non-goal:** no load-time (`afterLoad`) validation —
auto-rejecting legacy rows at load turns a data-quality issue into an
availability outage; callers can opt in with `validateEntity`.

### Query expressions

`F` is a column reference for column-to-column comparison
(`qGt('likes', new F('views'))` emits a qualified column reference instead of a
bound parameter). `Q` is a composable predicate tree: leafs constructed with
`qEq`/`qNe`/`qGt`/`qGte`/`qLt`/`qLte`/`qIn`/`qNotIn`/`qIsNull`/`qNotNull`/
`qLike` (or the generic `q(column, operator, value?)`), combined with `and`/
`or`/`not` into arbitrarily nested trees, and applied to a `SelectQueryBuilder`
via `applyQ(qb, predicate, alias?)`, which wraps in a parenthesized `Brackets`
so it composes with existing WHERE conditions. `Case`/`When` is a conditional
value expression — `caseWhen([when(qGt('likes', 6), 'hot')], 'cold')` renders a
portable `CASE WHEN ... THEN ... ELSE ... END` with every branch value as a
bound parameter (or column reference) — added to a SELECT list via
`addCaseSelect(qb, expr, selectionAlias, alias?)`, or used as a `Q` comparison
RHS. It composes with the relation seam: a `RelationPredicate` can call
`applyQ(rq.builder, predicate)`.

**v1 limits:** `when` conditions are single leaves only (compound conditions
rejected — TypeORM's `Brackets` has no public SQL-extraction API); dotted
relation paths are rejected; `eq`/`ne` with `null` is rejected (use
`qIsNull`/`qNotNull`); empty `in`/`notIn` and empty `and`/`or` are rejected;
all values are bound parameters (never inlined), so booleans and dates are
driver-correct; `QueryExpressionError` is value-free.

### Model query

`query(entity, options?)` (`src/database/model-query.ts`, exported from
`jsails/database` and the root entry) returns a chainable `ModelQuery<T>` over a
TypeORM `SelectQueryBuilder<T>` — a thin, connectionless wrapper that composes
the query-expression and relation seams without a bespoke query language.

- `where(predicate: Q)` applies a predicate tree via `applyQ`; `orderBy(column,
  direction?)`, `limit(n)`, `offset(n)` map to the builder; `apply(fn)` is the
  raw escape hatch for anything the chain does not cover.
- `whereHas(relation, predicate?)` and `has(relation, operator, count)` delegate
  to the same EXISTS/COUNT subquery builders as the standalone relation
  predicates (`applyWhereHas`/`applyHas` in `relation-query.ts`), so there is one
  code path. Both require the default alias `'entity_'` — a custom alias throws a
  value-free `RelationError` rather than silently mis-correlating the subquery.
- `includes(spec: RelationLoadSpec)` declares relations to eager-load **after**
  the base query runs: `getMany`/`getOne` execute the base query, then call
  `loadRelations(rows, { with })` (IN-clause batching, one query per relation
  level). Repeated `includes` calls deep-merge; an explicit `false` removes a
  previously-included relation. `count()` ignores includes. An empty result set
  skips the loader entirely.
- Executors: `getMany()`, `getOne()` (returns `null` when no row matches), and
  `count()`. `ModelQueryOptions { alias? }` defaults the alias to `'entity_'`.
  `ModelQueryError` is value-free.
- `annotate(relation, ...relations)` records one or more relations whose row
  counts will be attached post-fetch (via `relationCount`) under
  `<relation>_count` on each result row. Counts are computed after the base
  query and any eager loads; unknown relations throw a value-free
  `ModelQueryError` lazily at execution time.
- `in_batches(size, fn, options?)` paginates by `size` with `limit`/`offset` over
  the primary key (an automatic `orderBy` on the PK is added when none was set),
  calling `fn(rows, page)` for each non-empty page. Excludes applied
  `where`/`includes`/`annotate` configuration.
- `find_each(fn, options?)` iterates every matching row one at a time,
  internally delegating to `in_batches` with a configurable `batchSize` (default
  100).

**v1 limits:** `limit`/`offset` slice the **base** rows (Rails-like), not the
eager-loaded children; the `'join'` eager-load strategy is unsupported; a custom
alias is rejected by `whereHas`/`has`. `annotate` operates only through
`relationCount` — no `sum`/`avg`/`min`/`max` annotation. No `scope()`/named-scope
registry.

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
- Valkey resolves `VALKEY_URL`.
- Readers accept an injected source and never fall back to `process.env` once
  one is given.

## Migrations

Migrations are **scalar and linear**. A definition is a JSON file in
`migrations/` holding operation/type metadata (schema history), not a live
database schema. `makemigrations` diffs the model metadata against that recorded
history; it does not introspect the database. JSails tracks applied state in its
own `jsails_migrations` table. History is forward-only for application, but a
migration can be **un-applied** by executing its recorded operations' inverses
(`invertOperation` in `operations.ts`): every destructive operation retains the
definition it removed, so a rollback re-creates dropped tables/columns and
reverts renames/alterations exactly.

```sh
jsails makemigrations --name add_users --config jsails.config.js
jsails migrate --config jsails.config.js
jsails migrate --config jsails.config.js --down add_users --allow-destructive
jsails migrate --config jsails.config.js --steps 1 --allow-destructive
jsails showmigrations --config jsails.config.js
```

`--migrations <dir>` defaults to `migrations`. Rollback is selected by exactly
one of `--down <name>` (un-apply every applied migration after `<name>`, which
stays applied) or `--steps <n>` (un-apply the last N applied migrations). Both
**require `--allow-destructive`** — rolling back drops tables/columns and loses
data — and are refused value-free without it. The runner API is
`rollbackTo(dataSource, history, options)` (`src/migrations/migrator.ts`), which
verifies stored checksums and replays the whole backwards plan against the
schema state before any DDL; a mismatch or un-invertible plan is refused
value-free. Un-applying the first (root) migration additionally requires
`allowDestructive: true` at the runner level. Rollback uses the same durability
discipline as forward apply: a per-migration transaction on Postgres/SQLite (the
tracking row is deleted only after the inverted operations succeed) and a dirty
`applying` marker persisted before the DDL on MySQL/MariaDB. `--allow-destructive`
on `makemigrations` permits a generated migration to drop tables/columns;
`makemigrations` remains forward-only (no `--down`/`--steps`).

`showmigrations` accepts `--format table|json|plan` for human-readable,
machine-readable, and plan-mode output. `migrate --fake` records a migration as
applied without running DDL; `--fake-initial` marks the first migration already
applied (for an existing database with no history table).

**Data migrations** (`defineDataMigration` / `createDataMigrationRegistry`) are
named, invertible `up`/`down` functions running against a live connection
(`DataMigrationContext` query runner, no DDL). They carry `kind: 'data'` and are
sequenced in the same linear chain; rollback refuses a data migration without
`down`. **Squashing** (`squashMigrations`) replaces a contiguous applied range of
schema migrations with a single cumulative migration, defaulting to rejecting
data-migration boundaries unless `allowCrossKind` is set.

### Polymorphic relations

`@PolymorphicRelation({ targets, relatedName, typeColumn?, idColumn? })`
(`src/database/polymorphic.ts`) is a TypeORM-layer decorator on a **child**
entity: it registers two generated columns — `<prop>_type` varchar(190) not null
and `<prop>_id` integer not null — and a table-level `polymorphic` descriptor
(`{ typeColumn, idColumn, targets }`) in the portable schema state. The target
entity declares nothing; the inverse is auto-inferred by scanning descriptors for
a matching `relatedName` and target table. There is **no database-level FK** (the
target varies per row), and this is not Django's content-type registry.

- `loadPolymorphic<T>(instance, prop)` loads child → parent; returns `null` when
  the type or id is unset. `loadPolymorphicInverse<T>(instance, prop)` loads
  parent → children; returns `[]` when none exist. `resolvePolymorphicTarget` /
  `resolvePolymorphicInverse` are the synchronous, no-I/O class resolvers.
- The autodetector emits a metadata-only `alter_polymorphic` operation when the
  `targets` list changes; it emits **no DDL** (the type/id columns are physical
  columns managed by column operations). `normalizePolymorphic` /
  `polymorphicEqual` (`src/migrations/schema-state.ts`) canonicalize and compare
  the descriptor; `invertOperation` swaps `polymorphic`/`previous`.

### Relation API

`resolveRelation(entity, prop)` / `resolveRelationPath(entity, dottedPath)`
(`src/database/relation-metadata.ts`) expose a pure, connectionless resolver over
TypeORM decorator metadata plus the polymorphic registry — no DataSource or
database needed. `ResolvedRelation` descriptors carry the kind (`many-to-one`,
`one-to-many`, `one-to-one`, `many-to-many`, `polymorphic`), the target entity
class, join-column/junction-table metadata, and the target's primary-key columns.
`MAX_NESTING_DEPTH` (8) bounds dotted-path resolution.

- **Batch loading** (`loadRelation` / `loadRelations`, `src/database/relation-loader.ts`)
  loads related entities with IN-clause batching — one query per relation level,
  never per parent. Supports M2O, O2M, O2O (owning and inverse), M2M (owning and
  inverse via junction tables), and polymorphic (forward and inverse). Nested
  paths (`with: { author: { with: { profile: true } } }`) recurse level-by-level
  using the flattened set of loaded children as the next parent array. Per-relation
  options: `select` (column whitelist), `where` (filter), `order`, `limit`
  (post-fetch slice per parent). The `'join'` strategy is not yet supported;
  composite-key loading raises a `RelationError`.

- **Predicates** (`whereHas` / `has` / `exists`, `src/database/relation-query.ts`)
  compile relation conditions into portable `EXISTS` correlated subqueries via
  TypeORM's `SelectQueryBuilder`. `whereHas` filters parents to those with at least
  one related row matching an optional `RelationPredicate` (fluent `where` /
  `whereIn` / `whereNull` / `whereNotNull` / `orderBy` / `limit`). `has` compares
  the COUNT of related rows (`>`, `>=`, `=`, `<`, `<=`). `exists` is a readability
  alias of `whereHas`. Nested dotted paths (`"comments.author"`) build chained
  EXISTS subqueries — one per hop. **Limits:** polymorphic relations are rejected
  value-free by all predicates; M2M inside nested paths is rejected; `has` rejects
  nested paths.

- **Aggregates** (`relationCount` / `relationAggregate`, same module) issue one
  `GROUP BY` query per call over a `LEFT JOIN`, keyed by parent primary key.
  `relationCount` returns `Map<string, number>` (absent entry means zero related
  rows). `relationAggregate` supports `count` / `sum` / `avg` / `min` / `max` with
  an optional column. The `where` option filters the JOIN's ON clause so parents
  with no matching rows still appear with a `NULL` aggregate (absent from the map).
  **Limits:** polymorphic relations and nested paths are rejected value-free.

### Through relations

`resolveThroughRelation(source, throughProp, targetProp)`
(`src/database/through-relations.ts`) resolves a `has_many :through` or
`has_one :through` relation path. `ThroughRelation` carries the three-hop
descriptors (source → through → target) plus join-column metadata; the loader
wires it into `loadRelations` so `through` relations batch-load with the same
IN-clause discipline as direct relations.

### Active Storage

`hasOneAttached(options)` (`src/database/active-storage.ts`) is a declarative
decorator that attaches a file to an entity through the `JsailsAttachment`
model. Attachments are persisted in the `jsails_attachment` table
(`activeStorageEntities` exports the entity); the blob is stored on a caller-
supplied `Disk` (the `jsails/filesystem` seam), with no dedicated storage
service. An I/O failure raises a value-free `ActiveStorageError`.

### Attribute encryption

`encrypts(encrypter, fields, options?)` (`src/database/attribute-encryption.ts`)
builds an `EntityHooksDefinition` that transparently encrypts and decrypts the
named fields at the subscriber boundary (`beforeInsert`/`beforeUpdate`/
`afterLoad`). Encryption uses the caller-supplied `Encrypter`
(`jsails/encryption`); an opt-in `deterministic` mode (with a separate
`deterministicKey`) derives the IV from the plaintext hash so equality queries
stay possible — at the accepted cost of revealing plaintext equality.

### Hook bridges

`counterCache` / `touch` / `autosave` / `nestedAttributes`
(`src/database/counter-cache.ts`) are `EntityHooksDefinition` factories that
wire Active Record-style lifecycle behaviour into the entity-subscriber seam
without a class-level DSL:

- `counterCache(entity, { relation, column?, scope? })` increments a counter
  column on the parent after a child is inserted or deleted.
- `touch(entity, { relation, column?, create? })` updates a `updatedAt`-style
  timestamp on the parent when a child changes.
- `autosave(entity, { relation })` persists associated child entities
  automatically when the parent is saved.
- `nestedAttributes(entity, { relation, fields })` accepts nested child data
  through the parent's `save()` call, with a field whitelist, and persists
  (insert or update) each child.

### Fixtures

`defineFixture(name, fixture)` (`src/database/fixtures.ts`) builds a named,
schema-validated `Fixture` of rows; `loadFixtures(dataSource, fixtures)`
inserts them in declaration order. `withRollback(dataSource, body)` wraps a body
in a `transaction` and always rolls back, so test setup can use real database
rows and discard them deterministically. `FixtureError` is value-free.

### System checks

`createSystemCheckRegistry()` / `defineSystemCheck(name, { severity, check })`
(`src/database/system-checks.ts`) provide a runtime health-check framework.
Checks are `error` / `warning` / `info` severity and run against an optional
`DataSource`; failures surface as value-free `SystemCheckError`s.

## Jobs

`defineJob(schema, handler)` (`src/jobs/registry.ts`) pairs a Zod schema with a
typed handler; `createJobRegistry({...})` validates the map. Payloads are validated
on dispatch **and** on the worker. Instantiating a queue/worker is what connects —
importing the modules never opens a Valkey connection.

The job layer has one public surface — the **provider-neutral runtime**:

- `createJobsRuntime({ registry, adapter, queueName?, prefix?, concurrency? })`
  binds the registry to a `JobsRuntimeAdapter` and owns job-level policy (payload
  validation on enqueue and on processing, dispatch-option allowlisting, local
  schedule validation, lazy + idempotent handles, idempotent `close`).
  `validateJobsRuntimeAdapter(adapter)` checks an adapter's shape without
  invoking any factory. `createBullMQAdapter({ redisUrl, onError?, queueFactory?,
  workerFactory? })` is the built-in BullMQ adapter and the default transport.
  An adapter is `{ name, createProducer, createWorker, upsertSchedules? }`; when
  `upsertSchedules` is absent, `runtime.upsertSchedules` throws an explicit
  `JobsRuntimeError` instead of silently doing nothing. A custom adapter needs
  **no connection URL** — `createJobsRuntime` never receives one.

```js
// jsails.runtime.js  (default config for `work` / `schedule`)
import { z } from 'zod';
import { defineJob, createJobRegistry } from 'jsails';

const sendEmail = defineJob(
  z.object({ to: z.string(), subject: z.string() }),
  async (data, ctx) => { await ctx.log(`send to ${data.to}`); },
);

export default {
  registry: createJobRegistry({ sendEmail }),
  // `adapter` is optional. Omit it to use the built-in BullMQ adapter, which
  // then requires a Valkey/Redis URL (valkeyUrl config key, or VALKEY_URL in
  // the environment). Supply a custom JobsRuntimeAdapter to target another
  // backend with no URL at all.
  valkeyUrl: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379',
  schedules: [{ id: 'digest', job: 'sendEmail', cron: '0 3 * * *',
                data: { to: 'ops@example.com', subject: 'digest' } }],
  queueName: 'default',
  concurrency: 1,
};
```

- Runtime config (`validateRuntimeConfig`): when `config.adapter` is present it is
  selected verbatim (identity preserved) and no URL is read or validated; when
  absent, the URL is resolved (`valkeyUrl` → `VALKEY_URL`;
  must be `redis://` or `rediss://`) and the built-in
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

- **Job metrics** — `createJobMetrics(options?)` (`jsails/jobs`) builds an
  in-memory aggregator (`JobMetrics`) that measures completed and failed jobs by
  name via `snapshot()` and can `reset()` on its own cadence. `recordCompleted`
  and `recordFailed` are synchronous; errors carry only the message, never a
  payload or stack trace.
- **Wait-time metrics** — `JobMetrics.recordWait(name, waitMs)` accumulates wait
  samples per job name; `JobMetricsSnapshot.avgWaitMs`/`maxWaitMs` expose the
  distribution. `detectLongWaits(snapshot, thresholds)` returns the names whose
  `maxWaitMs` meets or exceeds a configured `LongWaitThreshold`.
- **Metrics snapshot history** — `createJobMetricsHistory(metrics, options?)`
  wraps a `JobMetrics` collector and records time-stamped `JobMetricsHistoryEntry`
  instances on each `capture()` call. Eviction is oldest-first (`maxSnapshots`
  bound); the underlying metrics are reset with every snapshot, so each entry
  represents the delta since the previous capture.
- **Job tags** — `normalizeTags(value)` wins a `MAX_TAGS` union of non-empty, trimmed strings
  bounded by `MAX_TAG_LENGTH` (64 chars). `tagFilter(tags)` builds a predicate
  for filtering entries by tag membership. Tags ride dispatch options under the
  reserved `TAG_OPTION_KEY` (`__jsailsTags`); `TagError` is value-free.
  `FailedJobEntry.tags`, `FailedJobStore.list({ tags })`, and
  `JobMetricsSnapshot.byTag` expose the tag axis.
- **Job lifecycle events** — `jobPushed`, `jobCompleted`, `jobFailed`, and
  `jobRetried` are event tokens (`src/jobs/events.ts`) emitted through the shared
  signals bus at well-defined provider-neutral boundaries. Every
  `JobEventPayload` is value-free (name, jobId, attemptsMade only — never the
  job data or dispatch options). The `jobs` plugin wires the bus automatically
  when the `signals` plugin is also enabled; when the bus is absent the runtime
  behaves identically and emits nothing.
- **Failed-job store retention** — `FailedJobStoreOptions.maxAgeMs` (plus an injectable
  `now` clock) enables age-based eviction on `add` and `list`: entries older than
  the bound are dropped automatically. `FailedJobStore.list({ tags })` also supports
  filtering by tag membership alongside the existing `limit`.
- **Producer pause/resume** — `JobsRuntime.pauseQueue()`/`resumeQueue()` pause
  and resume the underlying transport's producer through the `JobQueue.pause?`/
  `resume?` capability contract. The BullMQ adapter delegates to BullMQ's own
  `queue.pause()`/`resume()`. Pause is **non-durable and process-scoped**: a
  restart clears the state and the queue resumes. When the transport has no
  pause capability a value-free `JobsRuntimeError` is raised.

- **Per-job middleware** (`src/jobs/middleware.ts`) — `composeMiddleware` wraps the
  handler with `JobMiddleware` functions registered per job name via
  `createJobsRuntime({ middleware: { [jobName]: [mw, ...] } })`. Middleware runs
  **worker-side only** after payload validation, declared order outermost-first;
  `next()` is callable at most once, and a middleware that returns without
  calling `next()` short-circuits. Errors propagate unwrapped as
  `JobMiddlewareError` (codes `invalid_middleware`/`middleware_threw`).

- **Job chaining** (`src/jobs/chain.ts`) — `createJobChain(runtime, steps)` builds
  a sequential pipeline: the `chainMiddleware`, registered on every chained job,
  enqueues step N+1 only after step N's handler succeeds. The chain descriptor
  rides in dispatch options under the reserved `CHAIN_OPTION_KEY` key;
  `JobChainError` (codes `empty_chain`/`invalid_step`) rejects a malformed chain.
  Chaining is **at-least-once**: a retried step re-runs the handler and continues
  on success — handlers must be idempotent.

- **Job batching** (`src/jobs/batch.ts`) — `createJobBatch(runtime, coordinator,
  items, callbacks?)` fans out N jobs, each carrying a `BatchDescriptor` under
  the reserved `BATCH_OPTION_KEY`. The per-job `createBatchMiddleware(coordinator)`
  records every item's outcome into an **injectable** `BatchCoordinator`; when all
  items settle `then` (all ok) / `catch` (any failed) / `finally` (always) fire
  once, in that order. Recording is idempotent per item index; settlement is
  single-fire; callback errors are swallowed. `JobBatchError` (codes
  `empty_batch`/`invalid_item`) rejects a malformed batch.

  Two coordinators ship. **`createBatchCoordinator()`** is the in-process default:
  recording and settlement are synchronous within a single process, with no
  serialisation or I/O — fast for single-process deployments.
  **`createSharedBatchCoordinator(cache, options?)`** (`src/jobs/shared-batch-coordinator.ts`)
  persists batch progress through the `CacheStore` contract (e.g. Valkey), so
  separate producer and worker processes can share progress. Every `register`
  writes an initial snapshot under `jsails:batch:<id>` with a configurable TTL;
  each `record` performs a read-modify-write against the cache and marks the
  index as recorded idempotently. Settlement callbacks fire **in-process** only —
  the process that called `register` is the one that fires them.

  **Cross-process limits (honest):** callbacks are local to the registering
  process; a worker that never called `register` cannot fire settlement.
  Concurrent writes race with last-writer-wins because the store has no
  compare-and-swap — the TTL evicts orphans. The `CacheStore.set` must accept a
  `ttlMs` argument; implementations that ignore it will never auto-evict
  orphaned entries. `SharedBatchCoordinatorError` (code `invalid_cache`) rejects
  a missing or invalid cache.

### Task scheduling and overlap control

`ScheduleDefinition.overlap` (`src/jobs/scheduler.ts`) opts a scheduled job into
overlap control so only one run executes at a time. The policy defaults off
(`undefined`) and accepts two forms:

- `true` — enables overlap control with a default key `schedule:<id>` and the
  `DEFAULT_OVERLAP_TTL_MS` (86,400,000 ms, 24 hours).
- An `OverlapDescriptor` object `{ key?, ttlMs? }` — a custom mutex key and a
  TTL bounded by `MAX_OVERLAP_TTL_MS`. The descriptor is carried in the scheduled
  job's `opts` under the reserved `OVERLAP_OPTION_KEY`.

The mutex itself is the `MutexStore` contract (`acquire`/`release`/`close` in
`src/cache/mutex.ts`) — a separate contract from `CacheStore` because a cache is
pure data (always overwrites on `set`, reads are safe to retry) while a mutex
needs an atomic "acquire only when absent" operation that a cache's `set` cannot
express. Two stores ship: `createMemoryMutexStore()` (single-process; in-memory
`Map` with expiry) and `createValkeyMutexStore({ valkeyUrl? })` (multi-process
via atomic `SET NX PX`). `mutexPlugin` provides a `MutexStore` under
`mutexToken`.

`createOverlapMiddleware(mutex)` (`src/jobs/overlap.ts`) builds a
`JobMiddleware` registered per job name via
`createJobsRuntime({ middleware: { [jobName]: [createOverlapMiddleware(mutex)] } })`.
It resolves the overlap descriptor from the scheduled job's dispatch options:
when the descriptor is absent or malformed the middleware calls `next()` and
returns its result unchanged (fail-safe — a framework-internal descriptor
problem must never fail the job). When present it attempts a mutex `acquire` for
`descriptor.key` with `descriptor.ttlMs`; if the acquire fails (a prior run is
still in flight) the middleware returns `undefined` without calling `next()` or
throwing — a skipped run is a normal outcome, not a failure, and throwing would
trigger adapter retries that repeatedly hit the still-held lock. The mutex
`release` is in a `finally` block with a swallowed error so a handler failure
never holds the lock past TTL.

**Runtime surface:** `runtime.listSchedules()` returns a `readonly ScheduleInfo[]`
(name and metadata only, never job payloads or schedule data). `runtime.pauseSchedules(ids)`
stops the named schedules by removing their repeatable jobs from the provider.

**Honest limits:**
- **Without a store, pause is non-durable** — `pauseSchedules` removes the
  repeatable job; a later `work` start re-registers every schedule from config
  via `upsertSchedules`, so a paused schedule resumes automatically on the next
  process restart. Resume is re-`upsertSchedules` — there is no separate
  `resumeSchedules` call.
- **Durable pause** — pass a `PausedScheduleStore` through
  `JobsRuntimeOptions.pausedSchedules` to persist paused schedule ids across
  restarts. Two stores ship: `createMemoryPausedScheduleStore()` (single-process;
  in-memory `Set`) and `createCachePausedScheduleStore(cache, options?)`
  (multi-process; backed by the `CacheStore` contract — a Valkey-backed cache
  makes pause state durable across process restarts). Both are idempotent; when
  a store is present, `upsertSchedules` skips paused ids and `pauseSchedules`
  writes them to the store so a later `work` start remembers. The store is never
  closed by the runtime — the caller owns its lifecycle.
- **The memory mutex is single-process only** — a `createMemoryMutexStore` map
  is not shared across worker processes. Use `createValkeyMutexStore` for
  multi-process deployments.

```sh
jsails schedules --config jsails.runtime.js   # read-only list (CLI command)
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
- Optional `redisUrl` for the multi-process pub/sub adapter;
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

- `broadcast` accepts either the built-in Socket.IO options (with a `valkeyUrl`
  key, mapped to the transport's `redisUrl`) or `{ adapter }`. The custom form is
  validated structurally (non-empty `name` + `attach`) and passed through by
  identity; its `attach` is never invoked by the loader.
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
  routes, and optional `revalidate` (seconds) that opts the page's `load` result
  into the cache store when one is available. `preactPageRenderer` + `renderRoute`
  render them via **Preact SSR**
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
- **Progressive streaming** — a page module may export `stream(context)` →
  `PageStream` (`AsyncIterable<string>`, `ReadableStream<Uint8Array>`, or Node
  `Readable`) to stream HTML progressively during live serving.
  `renderStreamResponse(stream, headers?)` (`jsails/pages`) wraps the stream into
  a `Response` with chunked transfer encoding and `X-Accel-Buffering: no` so
  buffering proxies pass chunks through uninspected. During live serving
  `stream` takes precedence over the string renderer (`default` + `load`); a
  module may define both. Static export (`jsails build`) ignores `stream` and
  renders `default` + `load` as usual.
- **HTTP** is Hono. `createApp` + `createHttpServer` never listen. An API module
  exports named HTTP-method handlers `(request, context) => Response`; there is
  no default-export guessing. The global `authorize` is default-deny and a
  per-module `authorize` can only further restrict. HTTP extension hooks run in
  order after the body-limit/405 middleware and before the filesystem routes,
  receiving the real Hono app; hook routes are trusted code that own their own
  security — the default-deny pipeline covers only filesystem API routes.
- **Per-route middleware** — a compiled page or API module may export
  `middleware`, an array of `RouteMiddleware` handlers `(context, next) =>
  Response | Promise<Response>` applied in declared order before the terminal
  handler. A handler that returns without calling `next()` short-circuits the
  chain; a thrown/rejected handler surfaces as the standard sanitized 500.
  Middleware can never run before the default-deny gate. The **ordering
  invariant** is fixed: body-limit/405 → session → origin/CSRF → global
  `authorize` → module `authorize` → global middleware → per-route middleware →
  handler. Global middleware is set via `globalMiddleware: readonly
  RouteMiddlewareRef[]` in the app config; extensions add to the global chain
  through `configureMiddleware(handler)` on the `ExtensionRuntime`. A named
  registry (`middleware: Record<string, RouteMiddleware>`) is built at assembly
  time; routes reference registered names (or inline functions) in their
  `middleware` export, resolved by `resolveMiddlewareRefs`. The chain is
  request-scoped — `next()` is callable at most once, a second call throws a
  `MiddlewareError`, and the returned `Response` is trusted producer output.
  `validateMiddlewareList` validates a module's `middleware` export
  structurally; `runMiddleware` composes the chain over a terminal handler.
  **Limits:** no reordering of built-in pipeline steps; no middleware on
  framework-owned routes (/up, /_jsails/introspect, server-component updates,
  extension HTTP hooks); no route-path-keyed config map; no lazy/async name
  resolution. The static export never runs middleware.
- **Route groups** — a `pages/` directory named `(name)` (matching `[A-Za-z0-9_-]+`)
  is a route group: it contributes no URL segment but does scope layouts.
  Groups are **pages-only**; in `api/` the `(...)` is not a safe static segment
  and is rejected by the existing literal check.
- **Nested layouts** — a `layout.js`/`layout.mjs` file in any `pages/`
  directory is a layout module, discovered lexically by `discoverRoutes` and
  excluded from the route manifest. It attaches to `RouteManifestEntry.layouts`
  as an ancestor chain (outermost first — closest to `pages/` comes first).
  Layout modules carry no `load`, `middleware`, or `getStaticPaths`; their
  default export is `(props: LayoutProps, context?) => RenderChild` where
  `props` receives the page's resolved props plus the framework-reserved
  `children` slot (a colliding page prop loses). The function may be sync or
  async. `renderRoute` folds the chain inside-out: the innermost layout wraps
  the page, its result is wrapped by the next-outer, and so on. If the
  outermost layout emits `<html>`, the minimal document shell is skipped.
  Static export folds layouts identically. **v1 limits:** layouts have no
  `load`, no `middleware`, and no `SERVER_ONLY` check (only the page component
  is checked); no loading/error boundaries, or
  parallel/intercepting routes; the starter's `ui/layout.tsx` remains app-owned
  and `pages/layout.js` is opt-in.
- **API resources** live in `jsails/api` (browser-safe). `createResourceHandlers({
  serializer, store, authorize })` needs only a `ResourceStore`, which makes no
  ORM assumptions — any persistence can back it. The root `jsails` entry
  re-exports these and aliases the resource `Authorize` as `ResourceAuthorize`;
  the schema builders (`string`/`integer`/`boolean`/`object`/`array`/`optional`),
  pagination helpers, and `defineSerializer` are in `jsails/api`.
- **List-query parsing** — `parseFilters(options?)` (`jsails/api`) reads the
  recognized `?search=`, `?sort=`, and `?filter[<field>]=` parameters from a
  `URL`/`URLSearchParams` and returns a normalized `NormalizedQuery` (a trimmed
  search term, `SortClause[]`, type-coerced `FilterValue`s, and
  `FilterClause[]`). Three filter forms are accepted: `filter[field]=v` (eq),
  `filter[field][]=a&filter[field][]=b` (in array), and
  `filter[field][op]=v` (named operator: gt/gte/lt/lte/neq/in/nin). Every field
  must be whitelisted with optional `FilterFieldOptions.operators` and every
  bound (search length, sort and filter counts, per-value length) is enforced,
  so a hostile query string cannot drive unbounded work; failures are value-free
  `ValidationError`s that map to `400`.
- **Composable permissions** — `require`, `and`, `or`, and
  `resourcePolicy({ list, get, create, update, delete })` (`jsails/api`) build
  `PermissionPredicate`s with the same signature and strict default-deny
  semantics as the resource `Authorize` callback, so they pass straight to
  `createResourceHandlers({ authorize })`. `createPermissionRegistry(initial?)`
  builds a named `PermissionRegistry` for app-level permission organization;
  registered predicates compose with `and`/`or`/`resourcePolicy` identically.
- **API rate limiting** — `throttle({ key, limit, windowMs, store? })`
  (`jsails/api`) wraps the fixed-window limiter into a one-shot decision that
  returns either `allowed` or a value-free `429` response with a `Retry-After`
  header; the default store is a shared in-memory one, and a multi-process
  deployment must pass a shared `CacheStore`.
- **Form parsing** — `readForm(request, schema)` (`jsails/api`) reads the body
  under a hard byte bound, decodes form-urlencoded (or JSON) with no implicit
  coercion, and returns a discriminated result (typed values or value-free field
  errors) so the handler renders its own errors instead of throwing.
- **OpenAPI generation** — `generateOpenApi({ resources })` (`jsails/api`)
  produces a deterministic OpenAPI 3.0 JSON document (list/create/get/update/
  delete per resource) with no external library.

- **API router** — `createResourceRouter({ prefix, resources, handlers })`
  (`jsails/api`) produces a deterministic route manifest (a flat array of
  `{ method, path, resource, handlerKey }` entries) from named resource handlers,
  rejecting duplicate method+path combinations with a value-free `ValidationError`.
  The manifest is suitable for mounting on a Hono router; resources iterate in
  sorted name order and routes follow a fixed method-then-path order.
- **API versioning** — `resolveApiVersion({ versions, default, url, accept })`
  (`jsails/api`) resolves an API version from URL path prefix (e.g. `/v2/users`)
  and Accept header (`application/vnd.jsails.v2+json`), with URL always taking
  precedence over the header. A missing signal returns the configured default;
  an unknown version returns a `VersionError`. The response helpers
  `versionedNotFound()` / `versionedNotAcceptable()` return value-free, empty-body
  `Response` objects when version resolution fails.
- **Signed URLs** — `createUrlSigner({ key, now? })` (`src/routing/signed-urls.ts`,
  re-exported from the root entry) returns a `UrlSigner` with `sign(path, params?,
  expiresInMs?)` and `verify(url)`. The signer uses HMAC-SHA256 with a
  domain-scoped key prefix, an expiry timestamp, and value-free `SignedUrlError`s.
  `UrlSignerOptions` accepts `key` (>= 32 bytes) and an injectable `now` clock.

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
`startClient({ islands })`). `morphComponent(target, html, options?)` renders a Turbo stream message and
resolves once it lands; `MorphComponentOptions.action` now accepts the full
`TurboStreamAction` set — `replace` / `update` / `append` / `prepend` /
`remove` / `before` / `after` / `refresh` — so one call covers every Turbo
Stream action. `jsails/client` also exports pure `turboStreamMessage(action,
target, html?)` and eight convenience helpers (`replaceStream`, `updateStream`,
`appendStream`, `prependStream`, `removeStream`, `beforeStream`, `afterStream`,
`refreshStream`) — pure string builders returning a serialized `<turbo-stream>`
element, with no DOM or Turbo dependency, so they are safe to call server-side.
Trusted producer output — the caller owns HTML escaping. A cancelable `jsails:before-navigation` document event (plus an
`onBeforeNavigation` hook) fires before a navigation commits, so a runtime can
drop stale in-flight work. There is **no HMR** — `dev` rebuilds and you reload
the browser; the client runtime does not patch modules.

Island props are decoded with `JSON.parse` only, bounded by length/depth/key
count, and reject `__proto__`/`constructor`/`prototype` keys at any depth. A
hydration or render error is reported (default `console.warn`, or `onError`) and
that island is skipped; the rest of the document keeps hydrating.

**Hotwire Native web groundwork** (`src/client/native.js`, `src/client/native-protocol.ts`,
`src/client/path-config-loader.ts`) adds a pure-path configuration layer and a
bridge-protocol contract for Hotwire Native mobile-web hybrids, with no native
SDK dependency. `definePathConfiguration(rules)` builds a `PathConfiguration` from
application- or pattern-matched `PathRule`s; `resolvePathConfiguration(config,
path)` returns the best-matching rule for a given path.
`resolvePathConfigurationMerged(config, url)` returns a later-wins merge of
**every** matching rule's properties (not just the best match), and
`defaultPathRules()` returns the three standard historical-location rules
(`recede`/`resume`/`refresh`) for combining with custom rules.
`isNativeApp()` detects whether the client is running inside a native app's web
view from its `User-Agent`. `nativeBridge` is a stub object (type only).

**Bridge protocol:** `createBridgeMessage(component, event, data, options?)`
builds a typed bridge message with a UUID id for request/reply correlation;
`replyTo(original, event, data?)` returns a reply carrying the original's id.
`isBridgeMessage` and `isVisitProposal` are structural guards. `createBridgeComponentRegistry(send)`
returns a name-based registry that dispatches `register`/`unregister` lifecycle
messages through an injectable `send` callback. `BridgeMessageError` and
`BridgeComponentError` are value-free. Types `BridgeMessage`, `VisitProposal`,
and `VisitProposalAction` complete the contract.

**Path-configuration loader:** `createPathConfigurationLoader({ fetch })` builds a
`PathConfigurationLoader` that reads a `PathConfiguration` from data, file, and
server `PathConfigSource` instances (three source kinds: `'data'`, `'file'`,
`'server'`). `loadAll` merges multiple sources with shallow-merged settings
(later wins) and concatenated rules. `mergePathConfigurations` is the pure merge
helper over already-loaded configs. `PathConfigLoaderError` is value-free — it
never echoes the raw source value or response body.

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
`serverComponentsPlugin({ components })` extension, and render one from a page's
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
- **Lifecycle hooks** — optional, awaited in order: `hydrate(state, context)`
  (runs after a snapshot is verified and before any client edit, for server-side
  rehydration), `updating(state, context)` (before client edits; may throw a
  value-free error to reject the update), `updated(state, context)` (after a
  successful update or action, before the re-render), and `mount(context)` (once
  on the first live server render). Hooks receive the mutable server-side state
  (except `mount`, which receives only the context) and may mutate it in place.
- **Computed properties** — `computed` maps names to `(state, context)` functions
  deriving a read-only view value at render time (a Promise result is awaited),
  exposed to `render` through `tools.computed(name)` and memoized per render.
  Computed values are never persisted and never client-writable; a name that
  collides with a top-level state field is rejected at definition time.
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
  otherwise a `ServerComponentError`. A standalone `jsails serve` outside those
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
import { serverComponentsPlugin } from 'jsails/server-components';
import { taskList } from './dist/components/task-list.js';

export default {
  rootDir: '.',
  extensions: [
    // `components` is a plain object map keyed by name (arrays are rejected).
    // The key is not hardcoded: explicit signingKey / JSAILS_COMPONENT_SECRET,
    // or an ephemeral key only in development/test, else a live render fails.
    serverComponentsPlugin({ components: { 'task-list': taskList } }),
  ],
};
```

**Form objects** (`defineForm`) wrap a Zod object schema and provide typed field
access, `fill`/`validate`/`reset` helpers, and `toState`/`fromState` JSON
round-trip methods compatible with the server-component snapshot protocol. A
`FormObject` is a plain object created inside a component action or lifecycle
hook; `FormDefinitionError` is raised for an invalid schema or options.
**Nested (child) components** (`defineNestedComponent` / `renderNested`) allow a
parent component to render independently authorised, stateful children, each
with its own signed snapshot, CSRF marker, and component id. Child state is
fully independent — every render/update goes through the child's own
`mount` → `sign` → `verify` lifecycle, with its own `authorize` and
`writableKeys`. `MAX_NESTING_DEPTH` (8) bounds the tree depth;
`NestedComponentError` is raised when a component is not found, the depth is
exceeded, or a child's own signature or security check fails.

**Render-tool directives** (`src/server-components/directives.ts`) provide eight
pure attribute-map builders for spreading onto elements inside a component's
`render`, each consumed by the client binding layer: `confirmAttrs(message)`
(confirm guard before dispatching), `loadingTargetAttrs(target)` (toggle a
loading indicator), `showAttrs(field)` and `textAttrs(field)` (conditional
visibility and text replacement from state), `sortAttrs(field)` (sort toggle),
`intersectAttrs(action)` (fire-once viewport observer), `refAttrs(name)` (element
lookup by id), and `ignoreAttrs()` (exclude a subtree from the client's DOM
diff). `pagerAttrs(page, options?)` returns `{ previous, next }` call-attribute
maps for array pages, reusing `Page<T>` from `jsails/api` with configurable
`ServerComponentPagerOptions`.

**Action redirects and downloads** — `redirect(url)` (validated: no
`javascript:`/`data:`/`vbscript:` schemes) returned from a `run` signals the
client to navigate via Turbo. `download(id, opts?)` returned from an action
mints a signed, subject-scoped, expiring reference (`createDownloadReferenceSigner`,
`DOWNLOAD_REFERENCE_TTL_MS`); the runtime carries the reference in the update
response and streams the file from `COMPONENT_DOWNLOAD_ENDPOINT` with
`Content-Disposition: attachment`. `isDownload` is the structural guard,
`DownloadError` is value-free.

**Read-only URL binding** — a component may declare `urlBinding?: readonly
string[]` naming the state fields seeded from the request URL's query string on
first mount only, via `seedFromUrl`. The snapshot always wins afterward;
subsequent updates reconstruct state solely from the signed snapshot.

**Test harness** — `createComponentTestHarness({ components, signingKey?,
origin?, session?, lifecycle? })` (`jsails/testing`) returns a
`ComponentTestHarness` that renders and updates a component in-process against
the real runtime without an HTTP server: `render(name)` mints a fresh instance,
`update(name, snapshot, csrf, data?)` drives an update, and `close()` tears down
idempotently.

### Interaction metadata (validation, polling, uploads)

The root `jsails` entry re-exports the browser-safe wire constants and types
from `src/server-components/protocol.ts` (marker attributes — including the
eight directive markers `data-jsails-confirm`, `data-jsails-loading-target`,
`data-jsails-show`, `data-jsails-text`, `data-jsails-sort`,
`data-jsails-intersect`, `data-jsails-ref`, `data-jsails-ignore` — endpoint
paths, CSRF header, upload field names, and the request/response/poll/upload
shapes) and the validation-metadata helpers from
`src/server-components/validation-meta.ts`. `extractFieldRules(schema)` reduces
a field's Zod schema to a bounded, JSON-serializable `FieldValidationRules`
object; `serializeFieldRules` turns it into a `data-jsails-rules` marker the
runtime spreads onto a model-bound control, which the client applies as instant
(pre-round-trip) feedback. These rules are advisory by construction: anything
they cannot represent (transforms, refinements, unions, nested objects, custom
formats) is omitted rather than guessed, and oversized metadata throws a
value-free `ValidationMetaError`. Poll options (interval, marker, refresh
action) and the signed-upload markers (`data-jsails-uploading`,
`data-jsails-upload-max-bytes`, and the `__upload` state key) round out the
client/server contract; `UploadReference` itself is exported from the extension
seam, not the protocol module.

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
URLs and renders the top-level links. Pages ship for the full app: Home
(`pages/index.tsx`) mounts the `counter` island, About (`pages/about.tsx`) is
plain static markup, Tasks (`pages/tasks.tsx`) renders the `task-list` server
component alongside the counter island (kept **outside** the component root so
its local state survives a server-component morph), and Login
(`pages/login.tsx`), Dashboard (`pages/dashboard.tsx`), and Device
(`pages/device.tsx`) back the local sign-in flow. An admin panel is mounted by
the `admin` plugin only in the `--admin`/`--blog` variants (see "Extending
JSails" and `jsails.app.js`).

`client/main.tsx` is the whole browser entry: it calls
`registerIsland('counter', ...)` once and then `startClient()`. There is no
manual `hydrate`, `fetch`, or `history` call, and no automatic island
registration — the island is registered explicitly and hydration is owned by the
framework runtime. The counter is frontend-only (daisyUI card + native
`<dialog>`); reloading resets it. `task-list` is the live backend demo and
deliberately says so: transient per-instance state, no database, no account.
There is still **no authentication/authorization kit** and no separate `init`
command; mobile/offline behavior is future work and is not implemented.

The starter always ships a local email/password sign-in flow through the
first-party **`auth` plugin** (`jsails/auth`), which backs **Better Auth over
MariaDB**: `authPlugin({ publicOrigin })` lazily builds a Better Auth instance
(email/password + RFC 8628 device authorization) and mounts the trusted
`/api/auth/*`, `/api/login`, `/api/logout`, and `/api/device/approve|deny`
routes. The plugin provides an `AuthSessionService` under `authSessionToken`,
which the admin panel consumes (declaring `requires: [authSessionToken]`, so the
`auth` plugin must be declared first). The app config still sets a global
`resolveSession` via `resolveSessionFromRequest(createAuth(), request)` for the
`/api/me` filesystem API and `/dashboard` page — that resolves a memoized
instance distinct from the plugin's own, but both read the same environment and
database. Auth requires a database connection — the recommended default is
MariaDB, started locally with `jamal up` (which also starts Valkey) — and JSails
reads the connection from `DATABASE_HOST`, `DATABASE_PORT` (default `3306`),
`DATABASE_USER`, `DATABASE_PASSWORD`, and `DATABASE_NAME` individually (there is
no `DATABASE_URL`). Export `BETTER_AUTH_SECRET` (>= 32 bytes) before serving
and, behind a TLS-terminating proxy, `BETTER_AUTH_URL` to the public origin
(default `http://localhost:3000`). `npm run auth:migrate` creates Better Auth's
tables and `npm run user:create -- <email> <password> [name]` creates the first
account. This is login-only: registration UI, password reset, email
verification, and OAuth are deferred.

The starter ships in three web shapes selected by `jsails create` flags. They
share the same auth + server-components base — including the `cache`,
`filesystem`, and `mail` plugins plus a `jamal.config.js` that declares the
MariaDB + Valkey backing services — and differ only in the generated
`jsails.app.js` (and, for the blog variant, two extra pages). The auth-only and
`--admin` shapes ship 47 files; `--blog` ships 49.

- **auth-only (default)** — 47 files;
  `plugins.enabled: ['auth', 'cache', 'filesystem', 'mail', 'server-components']`;
  no admin panel.
- **`--admin`** — 47 files; additionally mounts the first-party `admin` plugin at
  `/admin` through `defineAdminPanel`/`adminPlugin` (`jsails/admin`), built from
  `auth: authSessionToken` with a default-deny `authorize` that allows any
  signed-in session (restrict it to an admin role in production);
  `plugins.enabled: ['auth', 'admin', 'cache', 'filesystem', 'mail', 'server-components']`.
- **`--blog`** (implies `--admin`) — 49 files; additionally mounts the first-party
  blog plugin (`jsails/blog`) and the `plugin-manager` admin plugin, adds the
  blog admin CRUD resource over one shared store, and ships two SSG blog pages
  (`pages/blog/index.tsx` and `pages/blog/[slug].tsx`);
  `plugins.enabled: ['auth', 'admin', 'blog', 'cache', 'filesystem', 'mail', 'server-components']`.

A fourth, **`--cli`** shape is a Laravel-Zero-style project generated from
`templates/starter-cli/` — a small file set (`package.json`, `tsconfig.json`,
`.gitignore`, `app/application-command.ts`, `commands/hello.ts`, a real
`jsails.app.js`, and a generated `AGENTS.md`) with **no web surface**: no
`pages/`, `api/`, `public/`, or `client/` tree, and no auth, admin, blog, or
Vite. It is the **same framework and plugin system** as the web starter, with
web plugins disabled: `jsails.app.js` sets `plugins.enabled: []` and carries the
extension seam, so a CLI project can opt into cache, filesystem, mail, jobs,
diagnostics, or flags by adding ids and matching extensions. Its `tsconfig.json`
compiles only `commands/` and `app/` (NodeNext, no JSX/DOM). Commands work
through both seams: `commands/hello.ts` default-exports a `defineCommand(...)`
object discovered from compiled `dist/commands/*.js`, while `jsails.app.js`
declares an `about` command in its `commands` array. A discovered `user` command
runs without loading the config; a config-declared command loads it. `--cli` is
mutually exclusive with `--admin`/`--blog`.

`enabled` lists the plugin ids enabled out of the box and `managed: true`
persists installed-plugin state in the `jsails_plugin_state` table (add
`pluginStateEntities` to the `JsailsDataSource` `entities` and run
`makemigrations`/`migrate`).

The blog module is `jsails/blog` (`src/blog/`): `blogPlugin({ store })`
contributes the `blogPostsToken` post-store service plus the live `GET /blog`
list and `POST /blog/posts` create routes; `blogAdmin({ store })` contributes
the admin `posts` CRUD resource; `createBlogStore()` builds one store shared by
both. The starter's default store is database-backed
(`createDatabaseBlogStore` in `src/blog/database-store.ts`, table
`jsails_blog_post`, MariaDB/Postgres/SQLite via TypeORM); the in-memory
`createBlogStore()` remains for demos and tests. Swap the store for any
`BlogPostStore` implementation to persist posts elsewhere.

## Extending JSails

This is the framework-wide extensibility seam, independent of the data layer.
Import from **`jsails/extensions`** for an ORM-free entry (Hono is referenced via
`import type`); the root `jsails` entry re-exports the same symbols but pulls in
`reflect-metadata` and TypeORM.

### Substrate vs. plugin boundary

Not everything can be an extension. The **substrate** is everything upstream of
`runExtensions` — the code that must run *before* any extension can exist:

- the CLI entry and command dispatch (`src/cli.ts`),
- the app config loader (`loadAppConfig` / `validateAppConfig`),
- the extension runner itself (`runExtensions`) and the service registry,
- route discovery (`discoverRoutes`), which runs before extensions,
- pure plugin enablement (`resolvePluginEnablement` / `loadPluginEnablement`).

An extension cannot run itself, so these stay in core. Everything **above** that
line — HTTP hooks, services, commands, pages, admin surfaces, first-party
features like auth/blog/jobs — is plugin-shaped and can be declared as an
extension.

The read-only introspection commands (`inspect`, `describe`, `explain`) are
deliberately **substrate**, not an `introspect` plugin: they are early-routed
*before* config loading and own their own `--config` flag, so they work from any
cwd with no app config. The extension `commands` seam is only collected after
`loadAppConfig`, so moving them behind it would force an app config to load
first and destroy that property. Their names are reserved
(`DEFAULT_RESERVED_COMMAND_NAMES`) so a user command cannot be silently shadowed
by the early routing.

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
out-of-tree plugins: `JobsRuntimeAdapter` (with `JobAdapterContext`,
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
- The deploy-generator registry is programmatic; `jsails jamal` surfaces it, but
  there is no `jsails generate` command, and the registry itself never writes
  files or deploys.
- HTTP hooks compose with the built-in pipeline; they do not automatically
  replace every internal step.
- There is no full auth/authorization system. The starter's UI components are
  app-owned template files, not a framework UI layer; the framework runtime owns
  hydration, but every island must still be registered explicitly.

## First-party `auth` plugin

`jsails/auth` (`src/auth/`) packages the Better Auth-over-MariaDB
sign-in stack as a first-party plugin. `authPlugin(options?)` builds a lazy,
memoized Better Auth instance (email/password + RFC 8628 device authorization),
provides an `AuthSessionService` under the `authSessionToken` service token, and
mounts trusted hook routes (`/api/auth/*`, `/api/login`, `/api/logout`,
`/api/device/approve`, `/api/device/deny`) — never filesystem API routes, so
they bypass the default-deny `authorize` and session CSRF middleware. The same
subpath exports `createAuth`, `resolveSessionFromRequest`
(the Better Auth → `Session` mapping), and the device-flow CLI client
(`login`/`whoami`/`logout`). `defineAdminPanel` accepts either a `resolveSession`
callback or `auth: authSessionToken` (exactly one); when built from `auth`, the
`admin` plugin declares `requires: [authSessionToken]`, so the `auth` plugin must
be declared earlier or assembly fails with a value-free error.

The account lifecycle is completed in the same subpath. `authPlugin` also mounts
`/api/register`, `/api/password-reset`, `/api/password-reset/confirm`, and
`/api/verification/send` (all trusted hook routes, outside the default-deny
pipeline), and the barrel exports the standalone handlers
`handleRegister`, `handleRequestPasswordReset`/`handleResetPassword`, and
`handleSendVerificationEmail`, plus `buildResetPasswordSender`/
`buildVerificationSender` (which wire a `SendMailFn` to the `jsails/mail`
transport). Role checks read a session's `role`: `sessionRole(context)`,
`requireRole(...roles)`, and `adminOnly` return a strict `RoleCheck` (exact
`true` allows; anything else denies), suitable for a page or API `authorize`.

The same subpath also mints long-lived, revocable **API tokens** behind the
`apiTokens` option, **disabled by default**. When `apiTokens.enabled` is set the
plugin provides an `ApiTokenService` under `apiTokensToken` and mounts the
trusted `POST /api/tokens` / `GET /api/tokens` / `DELETE /api/tokens/:id`
routes (management requires a signed-in *browser* session plus same-origin +
CSRF). A token is a Better Auth session tagged with a `jsails/api-token:`
`userAgent` sentinel, so it rides the existing session table with no new schema;
`createApiToken` returns the raw secret exactly once and it is never listed or
stored again. The `AuthSessionService.resolveSession` provided under
`authSessionToken` resolves the cookie session first, then falls back to the
`Bearer <token>` credential in the configured header (default `authorization`,
overridable via `apiTokens.headerName`) — and only when tokens are enabled.
`apiTokens.expiresInDays` defaults to `30` (bounded `1..3650`).

## Mail

`jsails/mail` (`src/mail/`) is a minimal, transport-agnostic mail seam: the
`Mailer` contract plus three transports and a first-party plugin. Use
`createMemoryTransport` (in-memory capture for tests), `createCallbackTransport`
(an injected callback), or `createSmtpTransport` (lazy SMTP over nodemailer,
loaded at first send); `mailPlugin({ transport, transportOptions })` exposes the
mailer under `mailToken` with lazy, fail-closed transport resolution.
`assertMailAddress`/`validateMessage` validate a message (returning a
`ValidatedMail`), and `MailError` is value-free. The subpath is server-only;
nodemailer is pulled in only when SMTP is actually used.

## Filesystem

`jsails/filesystem` (`src/filesystem/`) is a keyed blob-store `Disk` contract
with two implementations and a plugin. `createLocalDisk(options)` backs a disk
with the local filesystem; `createMemoryDisk(options)` is an in-memory disk for
tests and demos; `filesystemPlugin({ disks })` exposes a named `FileSystem`
service over those disks under `filesystemToken`. The surface is deliberately
narrow: the `Disk`/`FileSystem` contracts, `DiskData`/`DiskPutOptions`, and
`DiskError` (with its `DiskErrorCode`). Server-only — local disks touch
`node:fs`. Two extension surfaces sit on top:

- **Variants** (`defineVariant` / `createVariantResolver`) — lazy, cached
  transformations of a stored source file. The caller supplies the transform
  function (no image library dependency); the resolver caches results on disk
  keyed deterministically from the source path + variant name, and the original
  source is never mutated.
- **Rich text** (`createRichText`) — a sanitized HTML value object with
  plain-text extraction. The caller supplies the sanitizer function; JSails
  ships no HTML parser and never trusts producer HTML. A `RichTextFactory` is
  built once and reused, returning an immutable `RichText` value object.

## Diagnostics

`jsails/diagnostics` (`src/diagnostics/`) is a Telescope-style, in-memory
diagnostics recorder. `createDiagnosticsRecorder({ maxEntries?, clock? })` builds
a bounded ring buffer of typed, value-free `DiagnosticsEntry` instances;
`wrapAsync(type, fn)` wraps an async call and records its duration (the caller
sees the error, the recorder observes it). `diagnosticsPlugin({ recorder?,
enabled? })` exposes a `Diagnostics` service under `diagnosticsToken` with an
opt-in disabled/no-op mode. Construction is inert — nothing connects and no
entry is recorded until `record`/`entries`/`stats`/`wrapAsync` is called. No
secrets, credentials, or raw request bodies are recorded.

- **Watcher registry** — `createWatcherRegistry()` builds a setup-scoped
  `WatcherRegistry` for pluggable diagnostic watchers. Each `Watcher` owns its
  own subscription and returns an unsubscribe from `register`; the registry is
  sealed after `start()` — no new watchers can be added — matching the
  interceptor-registry discipline. `WatcherError` (codes `sealed`/
  `invalid_watcher`) is value-free.

- **Request watcher** — `createRequestWatcher({ signals, slowMs? })` observes
  the `requestFinished` and `requestFailed` signals, recording value-free
  `'request'` / `'failed:request'` entries (method, route, status, durationMs,
  and a computed `slow` flag). Headers, body, url, and session details never
  appear in entries.

- **Query watcher** — `createQueryWatcher({ onQuery, slowMs? })` records every
  database query through an injected subscriber. Only the parameterized SQL,
  a `bindingCount`, and a computed `slow` flag are stored; bindings themselves
  never appear in any entry. No TypeORM import or connection is required.

- **Exception watcher** — `createExceptionWatcher({ capture, signals?,
  maxFamilies? })` captures unhandled errors and records value-free
  `'exception'` entries keyed by a stable `family` discriminator. Each entry
  carries `class`, `file`, `line`, `frames` (a frame count only — the raw stack
  is never stored), and an optional `context`. A bounded LRU dedup map exposes
  occurrence counts via `ExceptionWatcher.counts()`.

- **Entry metadata** — `DiagnosticsEntry.id` is a monotonic counter assigned by
  the recorder, rendered as a decimal string `"<n>"`. `DiagnosticsEntry.familyHash`
  is a 12-hex-char SHA-1 hash of `type` + `data.family`, derived when a
  `family` discriminator is present. Neither is ever caller-supplied; a
  caller-supplied id or hash is overridden.

- **Tags and monitored stats** — `createTagRegistry(callbacks)` builds a
  `TagRegistry` from `TagCallback` entries (`name`/`when`/`value`). Tags are
  derived at record time and attached as `"name:value"` strings to entries.
  `DiagnosticsRecorderOptions.monitored` names tag keys whose entries are counted
  in `DiagnosticsStats.monitoredCounts`. Callback errors are swallowed so a
  broken callback never breaks recording.

- **Filters and pruning** — `DiagnosticsRecorderOptions.filters` gates entries
  at record time via `applyFilters` (`DiagnosticsFilterFn` / `DiagnosticsFilters`);
  a throwing filter is fail-closed (drop). `DiagnosticsRecorder.prune(options,
  now?)` applies `pruneEntries` (`PruneOptions`: `hours` + `keepExceptions`)
  in place, evicting entries older than the cutoff except the newest
  `keepExceptions` exception entries.

- **Runtime pause/resume** — `DiagnosticsRecorder.pause()`/`resume()`/
  `isPaused()` gate recording without flushing the buffer. When paused, `record`
  and `wrapAsync` are no-ops; constructed with `enabled: false`, the recorder
  starts silent but `isPaused()` returns `false`.

## Signals

`jsails/signals` (`src/signals/`) is a service-layer **signal bus** over the
shared interceptor/observer registry. `createSignalBus(registry)` wraps an
`InterceptorRegistry` as a `SignalBus` (`observe`/`emit`); `signalsPlugin()`
exposes that bus under the typed `signalsToken` service. The bus adds no
buffering, durability, or removal API — it delegates to the registry, whose seal
guard applies (registration is closed after setup; `emit` stays callable).
`emit` isolates observer errors: it never throws, and resolves to a
`readonly unknown[]` of the errors thrown by observers. `SignalError` (code
`'registry_unavailable'`) is raised when the shared registry is absent.

The bus is the **shared** registry, so an observer registered by one plugin
fires for events emitted by another. `SetupContext`/`PluginContext` expose
`interceptorRegistry` directly, so a plugin can run its own operations through
the shared graph (`runBefore`/`runAfter`/`emit`) instead of a private registry —
the first-party blog plugin does exactly this.

`requestStarted` / `requestFinished` / `requestFailed` are built-in lifecycle
events emitted by the API pipeline when the signals plugin is enabled. Their
`RequestSignalPayload` is value-free: it carries the `Request`, `URL`, params,
method, route, and `session` (server-only), but never the body, headers, or
cookies. Emission is fire-and-forget and opt-in — without the plugin the pipeline
emits nothing and behaves identically.

## Logging

`jsails/logging` (`src/logging/`) is a **record-first** structured logging
service. The record is the API and the string is a rendering: `logger.info(msg,
context?)` builds a frozen `LogRecord { level, message, context, at }`, and each
channel receives the record. `createLogger(options?)` is the standalone factory;
`loggerPlugin(options?)` provides a `Logger` under the typed `loggerToken`
service. Construction is inert — no I/O, no `process` access, no connection until
a log method is called.

- **Levels** — `debug` | `info` | `warn` | `error`, ordered. Each channel carries
  its own `minLevel` threshold and receives only records at or above it.
- **Channels** are the pluggable seam (`{ name, minLevel, write(record) }`).
  Built-ins: `consoleChannel()` (default; `warn`/`error` → stderr, `debug`/`info`
  → stdout, lazily resolving `process` inside `write`), `memoryChannel()` (tests;
  exposes raw `records()` and `clear()`), and `nullChannel()` (discard).
- **Formatters** are pluggable (`{ format(record) }`). Built-ins: `jsonFormatter()`
  (stable key order `level`/`message`/`context`/`at`) and `lineFormatter()`
  (`<ISO> <LEVEL> <message> <json context>`). Both are guaranteed never to throw:
  a circular or `toJSON`-throwing value becomes the fixed placeholder
  `"[unserializable]"`, and functions/symbols/`undefined` are dropped.
- **`child(context)`** returns a logger whose bound context is merged into every
  record (child overrides parent; nested children merge in order). The bound
  context is copied, never mutated.
- **Composition** — an optional `diagnostics` recorder receives a value-free
  `{ type: 'log', data: { level, message } }` entry on every call (the record's
  `context` is deliberately excluded), and an optional `signals` bus emits the
  shared `logError` event for `error`-level records. Both sinks are
  failure-isolated: a throwing channel or sink never propagates to the caller.
- **Value-free by default** — there is **no** automatic secret redaction
  (heuristic redaction is a footgun). `context` is caller-owned; never place
  credentials in it. The built-in formatters serialize only the four record
  fields and never stack traces, `Error` internals, or `cause` chains.

**v1 limits:** no `file`/`daily`/`stack` channels (the `LogChannel` contract makes
them additive); no automatic redaction; no async channel flush (writes are
synchronous and fire-and-forget); no runtime level mutation; no global logger
singleton. `LoggerError` (codes `invalid_level`/`unknown_channel`/`invalid_options`)
is value-free.

## Encryption

`jsails/encryption` (`src/encryption/`) is a symmetric **AES-256-GCM** encrypter
built on `node:crypto` (no new dependency). `createEncrypter({ key, previousKeys? })`
returns an inert `Encrypter` with `encrypt(plaintext, { aad? })` and
`decrypt(token, { aad? })`; `encryptionPlugin(options)` provides it under the
typed `encryptionToken` service. Construction validates keys eagerly and performs
no crypto until a method is called.

- **Envelope** — `v1.<iv>.<tag>.<ciphertext>`, each part base64url (no padding).
  The `v1` version tag is mandatory so a future format is rejected with
  `unsupported_version` rather than misparsed. The IV is 12 random bytes per
  `encrypt` call (GCM-recommended), the tag is 16 bytes.
- **Key model** — a `string` key is a high-entropy secret of at least 32 bytes
  from which a 32-byte AES key is derived with **HKDF-SHA256** (a fixed
  domain-separation salt; the input is a secret, not a password). A `Uint8Array`
  key is used verbatim and must be exactly 32 bytes. Truncation is deliberately
  avoided: two secrets sharing a 32-byte prefix must not collide.
- **Key rotation** — `previousKeys` is **decrypt-only**: `encrypt` always uses
  `key`, while `decrypt` tries `key` first, then each `previousKeys` entry in
  order, returning the first that authenticates. The key is never stored in the
  envelope, so rotation needs no format change.
- **AAD** — an optional `aad` string is bound into the GCM tag; a mismatch (or a
  missing/extra `aad`) fails authentication with `decryption_failed`.
- **No global secret** — the key is always passed explicitly; there is no
  `JSAILS_ENCRYPTION_KEY` environment fallback. Encryption is opt-in per call
  site, unlike server components which need a key to sign snapshots.
- **Value-free errors** — `EncryptionError` (codes `invalid_key`/`invalid_options`/
  `invalid_token`/`decryption_failed`/`unsupported_version`) never echoes the key,
  plaintext, ciphertext, token, or AAD. A wrong key or tampered ciphertext yields
  `decryption_failed` and never partial plaintext.

**v1 limits:** no passphrase KDF (a string key is a secret, not a password); no
`encrypts`-style entity attribute hook yet — GCM is non-deterministic, so an
encrypted column cannot be queried by equality, and shipping the hook without a
separate deterministic scheme would silently break equality queries (deferred to
T1.6b). The module is server-only (`node:crypto`) and must never enter the
browser-safe `jsails/api`/`jsails/client` graphs.

## Validation rules

`jsails/validation` (`src/validation/`, re-exported from the root entry) provides
composable, value-free Zod-backed validation rules and a bulk validation helper.
Each rule returns a Zod schema (for direct composition into `z.object({...})`) or
a `ValidationRule` predicate for cross-field checks. Messages never echo input
values.

- **Zod-backed rules** — `required` (non-empty string), `email`, `url`,
  `minLength` / `maxLength` (string length bounds), `min` / `max` (numeric
  bounds), `regex` (pattern match), `inList` (string whitelist).
- **Predicate-based rules** — `confirmed(field)` requires the field to match
  `<field>_confirmation`; `when(condition, rule)` applies a rule only when a
  condition over all submitted values holds.
- **`validateFields(schema, values)`** — runs a Zod object schema against values
  and returns a flat array of value-free `FieldError` objects (`{ field, message }`).

## HTTP client

`jsails/http` (`src/http/`, re-exported from the root entry) is a thin
fetch-based HTTP client seam (`createHttpClient({ baseUrl?, headers?, fetch?,
timeoutMs?, retries?, retryStatuses?, shouldRetry?, retryDelayMs? })`) with typed
`get`/`post`/`put`/`patch`/`delete` methods. Every
method encodes/decodes JSON, enforces a bounded timeout via AbortController, and
surfaces failures as value-free `HttpClientError`s (status + message; never
echoes the request URL or response body). Pass an injectable `fetch` for testing
— the client uses `globalThis.fetch` by default.

- **Retries** — `HttpClientOptions` gained `retries?` (max automatic retries,
  default `0`), `retryStatuses?` (default `[408,429,500,502,503,504]`),
  `shouldRetry?(status, attempt)`, and `retryDelayMs?`. A retryable status
  re-attempts up to `retries` with a fresh fetch call; a non-retryable status
  fails immediately. Status-0 (network/timeout) never retries.
- **Fake HTTP** — `createFakeHttp()` (`src/http/fake.ts`) returns a `FakeHttpClient`
  (an `HttpClient` + `respond(handler)` callback) for deterministic test stubbing.
  `FakeHttpHandler`/`FakeHttpRequest`/`FakeHttpResponse` are the handler/request/
  response contracts; the fake records no history and delegates every call to the
  current handler.

## Inertia adapter

`createInertiaPage({ component, props?, url, version? })` builds a validated
Inertia page object (`{ component, props, url, version }`); `renderInertiaPage(page,
{ request, shell? })` returns `application/json` with `X-Inertia: true` for
`X-Inertia` requests, or a minimal HTML document with the page object embedded in
`<div id="app" data-page="...">`. `inertiaVersion(assets)` computes a
deterministic version hash from an asset map (SHA-256, 8-char hex).
`resolveInertiaProps(page, request)` parses `X-Inertia-Partial-Data`/`-Except`
for partial reloads (with dot-path navigation; `only` beats `except`);
`mergeSharedProps(page, shared)` returns a new page with shared props merged in
(page props win). `resolveErrorBag(request)` reads the `X-Inertia-Error-Bag`
header; `errorsFor(errors, bag)` extracts scoped errors for the named bag. The
adapter lives in `src/app/inertia.ts` and is re-exported from the root entry; it
has no client-side router dependency — the caller owns frontend component
resolution.

## Notifications

`jsails/notifications` (`src/notifications/`, re-exported from the root entry)
is a narrow, multi-channel delivery seam. A `NotificationMessage` is smaller
than a mail message — `to`, `subject`, and a required plain-text `text` body —
so any channel (mail, SMS, push) can consume it. Two channels ship:
`createMemoryChannel` captures messages in-process (the explicit test/demo
channel), and `createMailChannel({ mailer })` adapts the `jsails/mail` `Mailer`.
`notificationsPlugin({ channels?, mail? })` exposes a `NotificationsService`
under `notificationsToken`; `mail: true` adds a channel named `mail` over the
mail service and declares `requires: [mailToken]`, so the mail plugin must be
declared earlier (the mailer is resolved lazily at send time — no transport or
connection at import/setup). Delivery is fire-and-forget within the process:
`notify(message, { channels? })` sends through every selected channel, waits for
all of them, and aggregates any failure into a value-free `NotificationError`
that lists only the failed channel names. There is **no durable queue, retry
policy, or database**: an app needing retries or out-of-process delivery
enqueues the message with the jobs plugin and sends from the job handler.

## Internationalization (i18n)

`jsails/i18n` (`src/i18n/`, re-exported from the root entry) is a
**dependency-free** message translator over nested string maps the caller loads
from plain JSON/objects — this slice performs **no file-system or environment
resolution**. `createTranslator({ messages, locale?, fallbackLocale? })` returns a
`Translator` with:

- `t(key, params?)` — resolves a dot-path key (`nav.home`) against the active
  locale's map, then the fallback locale's, and interpolates `{name}`
  placeholders (values are stringified; escaping is the caller's job). Returns
  the key itself when missing.
- `tChoice(key, count, params?)` — plural selection driven by the built-in
  `Intl.PluralRules` for the locale: a plural key maps to an object keyed by
  category (`one`, `few`, `many`, `other`, ...), never a bespoke index. `count`
  is injected into `params` unless the caller supplied it.
- `locale()` / `fallbackLocale()` / `withLocale(next)` — read the active/fallback
  locales or derive a same-messages translator with a new locale.

The translator holds the passed `messages` reference and never mutates it.
`locale` and `fallbackLocale` are validated eagerly (a malformed locale throws a
value-free `I18nError` at construction), and errors never echo a locale string.

## Feature flags

`jsails/flags` (`src/flags/`, re-exported from the root entry) is a boolean gate
the app flips without a deploy. A flag is a non-empty `key` plus an optional
`scope` (a string/id); the global scope and each scoped namespace are
independent, so the same key can be active for one scope and inactive elsewhere.

- `createMemoryFeatureStore()` — the zero-config in-memory `FeatureStore`
  default for tests, demos, and single-process deployments.
- `createDatabaseFeatureStore({ dataSource })` — the optional database-backed
  store. `JsailsFeatureFlag`/`featureFlagEntities` map the `jsails_feature_flag`
  table (key varchar(190), scope varchar(190), value boolean, updatedAt
  datetime); add `featureFlagEntities` to a `JsailsDataSource` `entities` and run
  the normal `makemigrations`/`migrate` history — the store reads and writes only
  through the injected data source's repository (no raw SQL, no runtime DDL), and
  a missing table fails with a value-free `FeatureFlagError` pointing at those
  commands.
- `resolveFeature(flags, key, scope?)` — a branch helper returning
  `{ active, inactive }`; compose with `??` to select one branch. The key/scope
  are validated eagerly; the store is read lazily on the first branch call.
- `flagsPlugin({ store? })` — the first-party plugin exposing a `FeatureFlags`
  service (`isActive`/`activate`/`deactivate`/`all`) under the typed
  `flagsToken`. With an explicit `store` it is used verbatim (identity
  preserved, never closed); otherwise the plugin owns the in-memory default.
  Construction is inert — nothing connects and no flag is read or written until
  a service method is called. `FeatureStore.get` returns `null` for an unset
  flag, so "explicitly off" and "never set" stay distinguishable at the store
  level even though both resolve to inactive through `FeatureFlags.isActive`.

## Theme tokens

`jsails/theme` (`src/theme/`, re-exported from the root entry) is a **browser-safe**
CSS custom property token contract shared by the admin renderer, the generated
starter, and plugin authors. No I/O, no `node:*` imports — the module is safe for
client-side code.

- `coreThemeTokenNames` — frozen array of the five fixed core tokens
  (`--jsails-bg`, `--jsails-fg`, `--jsails-accent`, `--jsails-muted`,
  `--jsails-border`) the admin renderer and starter layout reference directly.
  These names are semver-visible API; the open `--jsails-*` namespace accepts any
  custom property following that pattern, but only the core set is guaranteed to
  be consumed by every surface.
- `deriveThemeTokens(seed)` — derives the five core tokens from a seed
  `{ primary, radius? }` via a dependency-free HSL transform. `primary` becomes
  `--jsails-accent`; the remaining tokens are derived by varying lightness and
  saturation. Hex colors produce a harmonic palette; non-hex primaries get
  sensible neutral defaults. The optional `radius` sets `--jsails-radius`.
- **Themes = ordered fold, no parent graph.** `resolveThemeTokens(app, contributions,
  options?)` folds in four precedence layers (lowest → highest):
  1. Implicit empty base `{}`.
  2. Unnamed contributions, in registration order (spread-overwrite).
  3. The **active** named theme's effective tokens, when `options.active` names one.
  4. Application tokens (spread-overwrite, highest).
  Two contributions sharing the same `name` are spread-merged (`...earlier, ...later`)
  — later wins per key, never an error. The result is a `ThemeResolution`
  `{ active, themes, activeName }` with every named theme's effective map
  available in `themes` for `[data-theme]` blocks. There is no `parent` field,
  no parent-graph resolution, and no `conflict`/`cycle`/`unknown_parent` errors.
- `themeTokensToCss(resolution)` — emits `:root { active tokens }` plus one
  `[data-theme="<name>"] { ... }` block per named theme (sorted), hardened
  against control characters and `</style` injection. Returns `''` when empty.
- `createThemeTokens(app, contributions, options?)` — wraps `resolveThemeTokens`
  into a `ThemeTokens` service with `resolve()` (frozen active map), `toCss()`
  (all blocks), `themes()` (named maps), and `activeName()`.
- `themePlugin({ tokens?, contributions?, active? })` — the first-party plugin
  exposing the resolved `ThemeTokens` under the typed `themeToken` service token.
  `options.tokens` is the application layer (highest precedence);
  `options.contributions` collects `ThemeContribution` entries from each
  plugin's `PluginDescription.theme` descriptor (inert declarative metadata,
  never resolved at import time); `options.active` selects the initial active
  theme. Construction is inert — no tokens resolve until `setup` runs.
- Admin reads the theme via optional `tryGet(themeToken)`; the starter `Layout`
  consumes tokens by default through `ThemeTokens.toCss()`, which includes the
  full `[data-theme]` blocks for runtime theme switching.

## Database-backed sessions

`jsails/sessions` (`src/sessions/`) carries the framework-owned session entity
and a database-backed `SessionStore`. `JsailsSession` maps the `jsails_session`
table (`SESSION_TABLE`, `SESSION_ID_COLUMN_LENGTH`); add `sessionEntities` to a
`JsailsDataSource` `entities` and run the normal `makemigrations`/`migrate`
history. `createDatabaseSessionStore({ dataSource })` builds the
`DatabaseSessionStore` through the data source's repository — no raw SQL, no
runtime DDL; a missing table fails with a value-free `SessionStoreError`. The
subpath imports no HTTP/queue/Socket.IO runtime beyond the `Session`/`SessionStore`
contracts and the TypeORM entity.

## Cache and rate limiting

`jsails/cache` (`src/cache/`, re-exported from the root entry) is a narrow
string-keyed `CacheStore` contract with an in-memory default
(`createMemoryCacheStore`) and an optional Valkey/Redis backend
(`createValkeyCacheStore`), plus a fixed-window `createRateLimiter` over the
same store (`guard` for the check, `rateLimitResponse` for a value-free `429`).
`cachePlugin` exposes a `CacheStore` under `cacheToken`. The API-facing
`throttle` helper (see "Pages, routing, and API") builds on this same limiter.

The mutex store (`MutexStore` contract, `createMemoryMutexStore`,
`createValkeyMutexStore`, `mutexPlugin`/`mutexToken`) is a separate contract
within the same subpath: a cache is pure data whose `set` always overwrites,
while a mutex needs an atomic "acquire only when absent" operation that a cache
cannot express. The overlap middleware in the jobs section (see above) uses the
mutex store to gate concurrent scheduled runs.

## Admin panel breadth

The admin building blocks — `defineWidget` (dashboard stat-card descriptors),
`defineNotice` (a flash-message registry keyed by a stable code, with the
built-in `ADMIN_ACTION_SUCCESS_CODE`/`ADMIN_ACTION_SUCCESS_NOTICE`),
`defineAdminAction` (declarative header/row/bulk mutations with an optional
per-record `authorize` and success `notice` code), and `renderGlobalSearch` (the
server-rendered cross-resource search page) — are exported from both the
`jsails/admin` subpath barrel and the root `jsails` entry.
`defineAdminPanel({ widgets, notices, charts, theme })` accepts the first two plus
optional `charts` (dashboard SVG chart descriptors) and an
optional `theme` (`'light' | 'dark' | 'system'`, default `'system'`) rendered as
the document's `data-theme` attribute with minimal light/dark CSS variables and
no client bundle; `adminPlugin`
mounts the dashboard, the `/_search` page, and the `/actions/:name` confirm/run
surface. `defineResource` descriptors own their list/create/edit forms: list
columns carry a `badge`/`boolean`/`date`/`image`/`icon`/`color`/`tags` format
plus `sortable`/`searchable` flags, an `f_<name>` select filter, and optional
`imageBaseUrl`/`tagSeparator` affinities, and form fields cover `text`, `textarea`,
`select`, `toggle`, `number`, `date`, `datetime`, `checkbox`, `radio`, `repeater`,
`file`, `keyvalue`, `tags`, `color`, `slider`, `code`, and `markdown`. These descriptors are ORM-free and carry callbacks by identity; they
are consumed by `adminPlugin`, never executed at import.

Breadth beyond the base resource form:

- **Relation columns** — a column with `type: 'relation'` plus a `resolve(row)`
  callback renders related labels (escaped text) instead of a plain value cell;
  it must not declare value-cell affordances (`format`/`colors`/`sortable`/
  `searchable`/`filter`).
- **Repeater fields** — a `repeater` field renders a bounded, repeatable list of
  scalar item fields (`repeater: { fields, maxItems? }`; item kinds are the
  scalar field types only, never `repeater`/`file`). Items are submitted as flat
  `name[i].sub` keys and lifted into an array before the strict schema validates.
- **Infolist** — `infolist: { label, entries }` renders a read-only detail section
  above the edit form; entries mirror a column's `name`/`label`/`format`/`colors`.
- **File field** — a `file` field persists a string reference; the resource's
  `resolveFileDisk({ session, fieldName })` callback resolves the `Disk` that
  stores the upload (or `null` to skip), wiring the admin upload path to the
  `jsails/filesystem` disk seam.
- **Charts** — `defineChart({ name, label, render })` builds a dashboard chart
  whose `render` returns trusted SVG markup; `lineChartSvg`/`barChartSvg` are
  self-contained, label-escaping SVG helpers. A panel declares them via
  `defineAdminPanel({ charts })`.

- **Tabs** — `defineTabs({ tabs })` groups resource fields into named tabs for
  the create/edit form; `collectTabFields` flattens the tab set into a single
  field list, and `renderTabs` emits tab nav markup plus the active tab's fields.
- **Wizards** — `defineWizard({ steps })` splits the form into sequential steps
  with per-step validation and navigation; `wizardStepValues` extracts the
  current step's field values, `collectWizardFields` flattens all steps, and
  `renderWizard` emits step navigation plus the current step's fields.
- **Table grouping** — `groupRows(rows, { by })` partitions list rows into
  ordered groups by a column value; `renderGroupedTable` emits group headers
  and a per-group table.
- **Bulk export** — `defineExportAction({ name, label, format, columns? })`
  builds a bulk-action descriptor that serializes selected rows to CSV or JSON;
  `serializeExport(format, columns, rows)` returns the content + content-type,
  and `wireExportAction` wraps it into a complete `AdminActionRun`.
- **Additional chart helpers** — `donutChartSvg(points)` renders a donut/ring
  chart and `areaChartSvg(points)` renders an area chart; both are
  self-contained, label-escaping SVG helpers like `lineChartSvg`/`barChartSvg`.
- **Additional widget types** — `defineProgressWidget(...)` (a percentage
  progress bar), `defineListWidget(...)` (a bulleted list of items), and
  `defineTrendWidget(...)` (a trend indicator with direction) extend the
  dashboard widget set beyond the base stat-card widget.
- **Additional action builders** — `defineReplicateAction(...)` (clone a record
  with the resource's own create pipeline), `defineRestoreAction(...)` (restore a
  soft-deleted record), and `defineImportAction(...)` (bulk import from a
  caller-supplied parser) build declarative header/row/bulk mutations with the
  same optional per-record `authorize` and success `notice` code as
  `defineAdminAction`.
- **Relation managers** — `defineRelationManager({ relation, resource })`
  describes a related-resource panel (inert descriptor, no route mounting;
  rendered by `renderRelationManager`) that lists and manages sibling records
  through a resource-policy gate. `defineAttachAction(...)` and
  `defineDetachAction(...)` build attach/detach mutation descriptors for many-to-
  many relations, validated by `RelationActionError`.

## Plugins

The plugin system lives in `src/plugins/` (exported as `jsails/plugins`): the
manifest contract, two-source discovery, the framework-version check, the `.tgz`
extractor, the persisted state store (a JSON document or the database), the
enablement merge, download-capability resolution, the installer, and activation.
Discovery, check, and the installer only read and validate manifests and
installer inputs; `activatePlugins` is the one slice that imports plugin code —
it dynamically imports each enabled plugin's entry module (executing trusted
plugin top-level code at import time) and structurally validates the exported
plugin object(s), never calling `setup` (the extension runner does that later).
The admin install surface lives in `src/admin/`.

**`activatePlugins` is an exported, opt-in capability — it is not wired into
`createApplication`.** The runtime's boot path does not discover or dynamically
import plugins: `createApplication` runs the extensions the app config declares
directly (`config.extensions`), gated by name through `plugins.enabled`. A
deployment that wants discovery-driven activation (a plugin installed into
`node_modules` or `storage/plugins` and enabled through managed state) calls
`activatePlugins` itself and feeds the returned `plugins` into its extension
list. This keeps the default boot path free of dynamic imports and managed-state
I/O; the static export is always non-managed.

### Plugin enablement (two sources)

A plugin id is enabled by either of two independent sources, merged
deterministically by `resolvePluginEnablement({ codeEnabled, state })`:

- **Code list.** `plugins.enabled` in `jsails.app.js` (`AppPluginsConfig.enabled`)
  names the npm plugins enabled out of the box. Installing an npm plugin that
  self-identifies through its `package.json` `jsails` field is activating it, so
  the code list is the source of truth for dependency plugins.
- **Managed state.** A `PluginStateSource` — either the `<pluginsDir>/state.json`
  `PluginStateStore` document (`{ version, plugins: { [id]: { active, enabled } } }`,
  written by the admin) or the database-backed store (see below) — records what
  the admin installed and toggled. Every id whose `enabled` is `true` is enabled.

`plugins.enabled` also gates the built-in `config.extensions` at runtime by name,
not just discovery/activation: an extension whose `name` is not listed is
skipped before its `setup` runs (every built-in extension must be listed).

`loadPluginEnablement({ codeEnabled, managed, stateSource })` is the
managed/non-managed switch: a **non-managed** deployment (`managed !== true`)
performs no state I/O and resolves code-only enablement, while a **managed** one
requires a state source, loads it, then merges it with the code list. The static
export is always non-managed.

The result is frozen and deterministic: `enabled` is the sorted union of the
code list and every state id with `enabled === true`; `conflicts` lists ids
present in **both** sources, which are **excluded** from `enabled` and must be
reported by the caller (fail closed — the admin refuses to install a
code-managed id, so a conflict is a configuration error, never silently
resolved). `disabledManaged` lists state ids turned off that are not
code-enabled; those ids — and any id that is not installed — are skipped, not
enabled.

### Database-managed plugin state

A managed deployment can persist plugin state in the application's database
instead of the `<pluginsDir>/state.json` document. The table is
**framework-owned**: the `JsailsPluginState` entity (exported from both
`jsails/plugins` and the root `jsails` entry) maps to `jsails_plugin_state` with
a generated integer primary key and four scalar columns — `pluginId`
varchar(190), `activeVersion` varchar(64), `enabled` boolean, `updatedAt`
datetime (no `@CreateDateColumn`; `updatedAt` is set in code). An app opts in by
adding `pluginStateEntities` to its `JsailsDataSource` `entities` and running
the normal history:

```js
// jsails.config.js  (app-owned; plain ESM)
import { JsailsDataSource, pluginStateEntities } from 'jsails';
import { User } from './entities/user.js';

export default new JsailsDataSource({
  type: 'mariadb',
  /* ... */
  entities: [...pluginStateEntities, User],
});
```

```sh
jsails makemigrations --name add_plugin_state --config jsails.config.js
jsails migrate --config jsails.config.js
```

`createDatabasePluginStateStore({ dataSource })` reads and writes that table
through the injected data source's **repository** — no raw SQL and **no runtime
DDL**. The table must already exist: a missing table fails with a clear,
value-free error telling the caller to run `makemigrations`/`migrate`; the store
**never creates it** (and `JsailsDataSource` rejects `synchronize` anyway). The
migration history is the only path that creates the table, so its schema is
recorded and diffed like every other entity.

### Plugin settings UI

The plugin-manager admin plugin (`jsails/plugin-manager`) mounts a `Plugin
Settings` page alongside the install/enable surface. It renders one form per
installed plugin whose manifest declares a `settingsSchema`: a field whose
shorthand type is `'string' | 'number' | 'boolean'` renders as an editable
input, any other shape renders read-only and is never submitted, and saved
values persist per-plugin in the managed state (`settings`). The page is
available only in managed mode (`managed: true` with a `stateSource`), and it
inherits the admin panel's default-deny, same-origin, and CSRF checks before its
own `handlePost` runs.

## Deploy config generators

`generateDevValkeyConfig` and `generateDevDatabaseConfig` return **strings
only**; they never run Docker, `kamal`, or open a connection. Output is not
deployed and is not a complete scaffold.

- Valkey: pinned `valkey/valkey:8.0-alpine`, AOF persistence, no published 6379
  port. The startup script requires `VALKEY_PASSWORD` (≥32 URL-safe chars) and
  injects `requirepass` at runtime; the healthcheck authenticates via
  `REDISCLI_AUTH`. Filenames: `docker-compose.yml`, `valkey.conf`,
  `start-valkey.sh`, `.env.example`.
- Database: default MariaDB (`mariadb:11.4`), Postgres via `driver: 'postgres'`.
  Credentials are env references, never baked in; the app reads `DATABASE_*`
  variables individually — no connection URL is emitted.

### Deploy generator registry

`createDeploymentGeneratorRegistry({ includeBuiltins?, generators? })` is a
neutral container over named `{ name, generate(input, context?) }` generators;
`defineDeploymentGenerator(name, generate)` is the typed helper. It includes the
eight built-in adapters by default (`includeBuiltins: false` for a custom-only
registry) with deterministic ids `valkey-dev`, `database-dev`, `once`,
`harden-server`, `vercel-static`, `netlify-static`, `cloudflare-pages`,
`github-pages` (`BUILTIN_DEPLOYMENT_GENERATOR_IDS`). `generate`
returns `{ files }`; the registry validates every path as a portable relative
path — rejecting absolute/Windows-drive/UNC paths, backslashes, `..`,
`__proto__`, control characters, and file/dir collisions — and copies it into a
frozen, prototype-free map. It never writes files, never touches
`node:fs`/`node:child_process`, and never runs Docker, SSH, or `kamal`; the caller
owns all writing and deployment.

The registry is **programmatic** — the `jsails jamal` command surfaces it, but
there is no `jsails generate` command and the registry itself never writes files
or deploys. `valkey-dev`/`database-dev` emit the local Compose development set;
`once` emits the ONCE preset; `harden-server` emits a single
`config/harden-server.sh` UFW script (reviewed and run by a human; never
executed by JSails). The four static-hosting adapters emit a single config each —
`vercel.json`, `netlify.toml`, `wrangler.toml`, and the GitHub Pages workflow —
so a static export can ship to a static host instead of a container.

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

## Jamal

`jsails jamal` (`src/jamal/`) is the deployment/planning CLI: a TypeScript
reimplementation of Kamal + Sail behind one config file. Subcommands are
`up | down | ps | logs | exec | status | dev | deploy | rollback | harden | targets | domain | accessory | app | registry | prune | audit | snapshot`.

- **One config file.** `jamal.config.js` is a plain ESM module whose default
  export is a `JamalConfig`. There is no `mode` flag: the base fields plus
  non-destructive `local` (ports/build) and `production`
  (server/domain/onDemandTlsUrl/registry) overlay sections drive both
  environments. Secrets are `SecretRef`s (a name only, never resolved or
  serialized); `redactJamalConfig` renders a plan-safe view.
- **Deploy executes by default.** `jamal dev` plans the local Docker Compose set
  (Valkey + database) and writes nothing until `--write`. `jamal deploy` runs a
  **production release** (production is the DEFAULT; `jamal dev` is the explicit
  local override): the default `--target kamal` engine builds and pushes the
  image locally, then pulls, runs, health-checks, switches, and stops the
  previous container on the remote server — `--dry-run` prints the plan and runs
  nothing. `rollback` executes by default too, with `--dry-run` as its preview. A
  static or custom target (`--target vercel|netlify|cloudflare|github`, plus any
  custom deployment generator from `deployments` in `jsails.app.js`) generates
  files and requires `--write`. A built-in static host (vercel/netlify/cloudflare)
  then EXECUTES its deploy through `npx` (via the same `CommandRunner` seam the
  kamal engine uses; `--dry-run` skips execution). `github` is push-based — it
  generates the Pages workflow + `.nojekyll` and prints `git push`, never a CLI.
  A custom deployment only generates files and is never deployed by jamal.
  `--execute` is kept as a deprecated no-op alias for `deploy`/`rollback` (they
  already execute). `harden` plans the server-hardening script; `targets` lists
  every available target. `--write` materializes generated files with exclusive
  creation (an existing file is skipped, never overwritten), and `--dir <path>`
  relocates the plan.
- **Execution verbs** (`up`/`down`/`ps`/`logs`/`exec`) drive `docker compose`
  against the local project. `up`
  materializes the managed `.jamal/compose.yml` from `jamal.config.js` and runs
  `docker compose up -d --wait`; `down`/`ps`/`logs` use that managed file/project
  when it exists, else fall back to the legacy `docker-compose.yml` from
  `jamal dev --write`. `exec <service> -- <cmd...>` requires the managed file.
  `--detach` is accepted for `up` and is already the default; `--follow` tails
  `logs`.
- **Naming.** `deploy --target kamal` refers to the external Kamal engine; Jamal
  is Sail + Kamal in TypeScript.
- **Production execution.** `deploy [--tag <tag>]` performs a real production
  release — it first provisions the declared backing services
  (MariaDB/Postgres/Valkey accessory containers published on loopback), then
  builds and pushes the image locally, pulls, runs, health-checks, switches, and
  stops the previous container on the remote server — and records the deployed
  tag in `.jamal/deploys.json`; `rollback` redeploys the previous successful tag;
  `status` lists remote containers, and `logs`/`exec` inspect the last deployed
  container — each requiring `config.production`. These verbs drive the release
  engine in `src/jamal/production/execute.ts`
  (`runDeployExecution`/`runRollbackExecution`, exported from the root entry, over
  the internal `executeReleaseSteps`/`acquireLock`/`runHookPhase` steps). Jamal
  executes by default; `--dry-run` previews the plan without running it.
  `jamal app <verb>` drives the app container over ssh against the LATEST recorded
  deploy (`containers` filters by service name), and `jamal accessory <verb>`
  manages the backing-service containers; both require `config.production` and
  support `--dry-run`.
- **Server hardening** is available through the `jamal harden` subcommand, which
  plans `config/harden-server.sh`. Jamal never runs it — the script is
  UEFI/UFW-specific and must be reviewed and run by a human.
- **Domain routing.** `jamal domain add|list|remove` controls kamal-proxy routing
  without re-running a full deploy, over the same ssh path `deploy` takes.
  `add <host>` binds a host to the LATEST deployed container (reconstructed
  from `.jamal/deploys.json`, so a deploy must be recorded first), `remove <host>`
  removes the service — kamal-proxy removes by service, so `<host>` is validated
  but the argv is service-scoped — and `list` dumps the routing table. All three
  require `config.production`; `--dry-run` prints the exact ssh argv without
  running it. These verbs drive the proxy's runtime `deploy`/`remove` API over
  ssh, not `deploy.yml`: a host added here is **not** recorded in `deploy.yml`,
  so a later external `kamal deploy` may overwrite or conflict with it. Use
  on-demand TLS for unknown/customer hosts, and a static `production.domain` and
  on-demand TLS are mutually exclusive.

**Config breadth** — the normalized config model (`src/jamal/config.ts`) covers:
`JamalSshConfig` (production SSH: user, port, proxy command, log level, keys,
agent forwarding); `JamalHealthConfig` (path, timeout/interval in ms, retries,
retry delay, readiness delay); `JamalLoggingConfig` (driver + options);
`JamalVolumeSpec` (source, container path, access mode, host flag, parsed by
`parseVolumeSpec`); `JamalEnvEntry` (structured env with value, alias, clear
flag — also accepts a raw string or `SecretRef` via `JamalEnvValue`).

**Proxy tuning** — `ProxyBootOptions` (image, config volume, http/https/metrics
ports) and `ProxyDeployOptions` (path-prefix routing with optional strip,
TLS staging toggle, on-demand TLS URL, target/health/body-size timeouts,
canonical host redirect, TLS redirect, forward-headers, client-IP header,
scope cookie, exclude-metrics, log request/response headers) extend the
`proxyBootArgv`/`proxyDeployArgv` planners in `src/jamal/production/proxy.ts`.

**Pure planners** — additional subcommands that produce a plan and never execute:
`jamal registry` builds the `docker login` argv from the production registry
config (password redacted), with `planRegistrySetup`/`planRegistryRemove`/
`planRegistryLogout` (`src/jamal/registry.ts`); `jamal prune --keep <n>
[--images <ref>...]` plans image removal keeping the N most recent per service
group, with `planPrune` (pure group-and-slice logic) and `planPruneExecution`
(execution planner over a `PruneScope: 'all' | 'images' | 'containers'` and a
validated server hostname); `jamal audit` produces a security checklist from the
jamal config; `jamal snapshot <service> [--name <name>] [--driver mariadb|postgres]`
and `jamal snapshot restore <service> --snapshot <path> [--driver ...]` build
`docker compose exec` argv arrays for database dump and restore
(MariaDB + Postgres), plus `planImportDb`/`planExportDb` over a host file with a
`DbFileFormat` (`'sql' | 'sql.gz' | 'mysql' | 'tar' | 'zip'`). These planners
return plan objects, never run Docker, resolve secrets, or open a connection.

**Dev hooks** — `planDevHook(phase, hooksDir)` (`src/jamal/production/hooks.ts`)
plans a dev-time hook script path and argv for one of four `DevHookPhase`
values: `'pre-start'`, `'post-start'`, `'pre-import-db'`, `'post-import-db'`.

**Describe/launch/ssh** — `describeJamal` (`src/jamal/describe.ts`) projects a
`DescribeInfo` (service, server, domain, ports, services) from a `JamalConfig`
with no env values; `planLaunchArgv(url)` picks the platform opener
(`open` on Darwin, `xdg-open` elsewhere) for a validated http(s) URL;
`planSshArgv(config)` assembles the `ssh` argv from the production config's
server and SSH options, returning `['ssh']` when no production config is set.

### Jamal on-demand TLS

`production.onDemandTlsUrl` in `jamal.config.js` opts a deploy into
kamal-proxy's on-demand TLS. It is mutually exclusive with `production.domain`:
when set, the proxy routes unknown hostnames and authorizes each at
certificate-issuance time instead of pinning one static host — the `switch` step
carries `kamal-proxy deploy ... --tls-on-demand-url <url>` and no `--host`. The
value must be an absolute `http://` or `https://` URL, or a local path starting
with `/`; any other scheme, or a value with whitespace/control characters, is
rejected when the config is normalized.

On-demand TLS is **released in kamal-proxy v0.10.0**; Kamal's default is still
v0.9.2, so a proxy image bump is needed (kamal-proxy PR
[#225](https://github.com/basecamp/kamal-proxy/pull/225) is tagged; the
`deploy.yml` exposure in Kamal itself, PR
[#1927](https://github.com/basecamp/kamal/pull/1927), is still open/draft). The
proxy authorizes each hostname at certificate-issuance time by calling
`GET <url>?host=<hostname>` with a matching `Host` header: a `200` allows
issuance, any other response denies it, and an already-cached certificate skips
the call.

**Security:** the app owns that endpoint and must protect it. An over-permissive
endpoint — one that returns `200` for a hostname it does not control — lets
certificates be issued for unauthorized domains.

`createOnDemandTlsAllowlist({ domains, allow?, headerName?, secret? })`
(`src/jamal/on-demand-tls.ts`, exported from the root entry) builds the
Fetch-style handler for that endpoint, so an app mounts it as a JSails API route
or an extension HTTP hook without reimplementing the kamal-proxy contract. It is
fail-closed by construction: it answers `200` only for an allowlisted hostname
(exact match, case-insensitive, trailing-dot tolerant) or when `allow(hostname)`
resolves to exactly `true`, and every other response is an empty-bodied `403`
(or `400`/`405` for a malformed request); hostnames are never echoed. Because
the endpoint gates certificate issuance, an over-permissive `domains`/`allow`
policy can have certificates issued for unauthorized domains — the app owns that
policy. The proxy support is released in kamal-proxy v0.10.0; Kamal's default is
still v0.9.2, so a proxy image bump is needed (see above).

## CLI surface and limitations

The CLI (`src/cli.ts`) implements the built-ins: `makemigrations`, `migrate`,
`showmigrations`, `work`, `schedule`, `build`, `serve`, `create`, `dev`, `seed`,
`queue`, and the `make:<page|api|job|model|command>` generators, plus
`jamal` (deployment planning), `plugins` (discovery/check/install/enable/
disable/uninstall/rollback), and the read-only introspection commands
`inspect`, `describe`, and `explain`. `jamal`, `plugins`, `make`, `inspect`,
`describe`, and `explain` own their own
subcommands and flags, so they are routed before the
shared flag-gating and never import an app config. Config defaults are
`jsails.config.js` (migrations), `jsails.runtime.js` (`work`/`schedule`/`queue`),
`jsails.seed.js` (`seed`), and
`jsails.app.js` (`build`/`serve`/`dev`). `build`, `serve`, and `dev` take no
host/port/output flags — those come from the app config; `create` takes no
`--config`. See "Jamal" for the `jamal` surface and the Plugins section for
`jsails plugins`.

The CLI entry was rewritten to eliminate heavy static imports: `src/cli.ts` is
now a lazy bootstrap (~512 lines) that loads only node builtins, Zod, and pure
modules for early routing (`--help`, `inspect`, `describe`). Heavy dependencies
(TypeORM, BullMQ, Hono, Preact, Vite, Jamal) are dynamically imported in
`src/cli/dispatch.ts` only when a command executes, so the common fast paths
avoid the full dependency graph. A `buildCommandContributionIndex` builder
(`src/cli/command-contribution.ts`) validates a plugin's `PluginDescription.commands`
descriptors into a read-only index without importing any command module (phase 1
foundation — no command family has been moved yet).

- `create <dir> [--name <pkg>] [--jsails-dependency <file:...>] [--install]
  [--admin] [--blog] [--cli]` generates the single starter file set with
  `createStarterFiles` and writes it through `writeProjectFiles`. It refuses an
  existing non-empty target, a symlink target, and a non-directory target, and
  never overwrites an existing file. There is no `--auth` flag: the starter
  always includes auth, and the admin panel (`--admin`) and the first-party blog
  (`--blog`, which implies `--admin`) are opt-in — the default is auth-only.
  `--cli` scaffolds a Laravel-Zero-style CLI-only project with no web surface
  but the same framework and plugin system (`plugins.enabled: []` plus the
  extension seam) and is mutually exclusive with `--admin`/`--blog`.
  Nothing is installed unless `--install` is passed; a failed install returns its
  exit code but keeps the scaffold so the user can retry.
- `dev` compiles and watches: an initial `tsc -p tsconfig.json` (when
  `tsconfig.json` exists) and `vite build` (when a Vite config exists), then both
  in watch mode, plus nodemon restarting `serve` when compiled JS or the app
  config changes. New routes are compiled and served; the same app port is
  reused. There is no HMR — reload the browser manually. Each tool must be
  installed in the project; a present config with a missing binary reports "run
  npm install".
- `seed [--only <name>] --config jsails.seed.js` runs registered database seeders
  against an initialized data source. The config default-exports
  `{ registry, dataSource }` — a `SeederRegistry` (built with
  `defineSeeder`/`createSeederRegistry` from the root entry) plus a TypeORM
  `DataSource`. The command initializes and destroys the source around the run
  and runs the selected seeders in registry order (`--only` is repeatable);
  `.ts` config paths are rejected (compile first). Failures are value-free
  `SeederError`s.
- `queue [--json] --config jsails.runtime.js` is a **read-only** queue dashboard:
  it loads the same runtime config `work`/`schedule` use, builds the neutral job
  runtime, reads the queue's normalized metrics (`waiting`/`active`/`completed`/
  `failed`/`delayed`) through the producer's optional `readCounts` capability, and
  prints them (human-readable, or one JSON line with `--json`). It never starts a
  worker, registers schedules, or dispatches a job; a transport without a
  countable queue fails with a value-free error rather than printing zeros.
- `make:<page|api|job|model|command> <name> [--dir <path>]` generates a single
  conventional file (`pages/<name>.tsx`, `api/<name>.ts`, `jobs/<name>.ts`,
  `models/<name>.ts`, `commands/<name>.ts`) using exclusive creation, so an
  existing file is never overwritten. Names must match `[A-Za-z][A-Za-z0-9_-]*`
  and are case-normalized; the templates follow the starter's own conventions so
  they compile against a fresh scaffold. The command performs no writes beyond
  the single generated file and never imports application code.

### AI-first introspection

Four read-only CLI surfaces and one opt-in runtime endpoint expose
machine-readable state for agents and tooling.

- `jsails inspect routes [--json] [--config <path>]` wraps `discoverRoutes` and
  prints the route manifest; `--json` emits one line with resolved absolute file
  paths. It never imports page/API modules or opens a connection.
- `jsails plugins resolve [--json] [--config <path>] [--db-config <path>]` wraps
  `loadPluginEnablement` and prints `{ enabled, conflicts, disabledManaged,
  sources }`, explicitly flagging conflicts (ids present in both the code list
  and managed state, excluded from `enabled`). It never imports plugin code, runs
  `setup`, or mutates state; the database config is consulted only when the app
  is managed.
- `jsails describe [--json] [--config <path>] [--db-config <path>]` composes one
  machine-readable snapshot of an app's static **definition** (no runtime state)
  as `{ app, routes, plugins, components, schema }`. `app` carries the resolved
  dirs, host, port, `healthPath`, and `publicOrigin` (when set); `routes` is
  `{ kind, route, dynamic, catchAll, params }` and **omits `file`** (no absolute
  paths); `plugins` is `{ enabled, conflicts, disabledManaged, sources }`;
  `components` is `{ name, actions, writableKeys }[]`; `schema` is
  `{ tables: [{ name, columns, indexes, uniques, foreignKeys }] }`, `[]` when no
  entities or no db config. Default config is `jsails.app.js`; `--db-config`
  defaults to `jsails.config.js` and is used only to extract the entity schema
  via `getModelSchema()`, which builds metadata without connecting. Read-only:
  never imports page/API modules, never opens a connection, never runs `setup`.
  Source: `src/cli/describe-command.ts`.
- `jsails explain <path> [--json] [--config <path>]` resolves one request path
  against the discovered route manifest and reports which route matches, its
  params, and the fixed request pipeline it would traverse. It is a pure CLI
  command: it never assembles an application, imports page/API modules, or opens
  a connection. A path in the reserved `/_jsails` namespace reports
  `reserved: true, matched: false`. Source: `src/cli/explain-command.ts`.
- `GET /_jsails/introspect` is an opt-in, default-off, default-deny runtime
  endpoint configured by `introspect: { enabled, authorize, sections? }` in
  `jsails.app.js`. `authorize` is **required** when `enabled` is `true` (the
  loader raises a load-time `AppConfigError` otherwise) and follows the same
  exact-`true` default-deny rule as the rest of the runtime. The safe subset
  (`routes`, `plugins`, `components`, `pipeline`, `config`, `health`) ships by
  default, and three live
  sections are now available: `migrations` (`{ applied: [{ name, appliedAt }],
  pending: string[] }`; names/timestamps only, never checksums or operation
  JSON; `unavailable` when no data source or no tracking table), `diagnostics`
  (`stats()` counts/durations only, never raw `entries`; `unavailable` when the
  diagnostics plugin is not enabled), and `jobs` (`{ metrics, failed: [{ id,
  job, failedAt, attempts, error }] }`; metadata only, never job payloads
  (`data`) or stack traces; `unavailable` when no jobs runtime). The `pipeline`
  section reports the fixed stage list, the registered middleware names, and the
  global middleware count; the `config` section reports a **redacted** projection
  of the resolved app config (booleans for callbacks, directory basenames only —
  never absolute paths, secrets, or callback identities). `sections` in
  config is the **default** set returned when no `?section=` is given; an
  explicit `?section=` may name **any** valid section (including the live ones),
  which then reports `unavailable` if no provider handles it. The full valid set
  is `routes, plugins, components, pipeline, config, migrations, diagnostics,
  jobs, health`. The
  response envelope is `{ generatedAt, sections: { [name]: { status, data? |
  error? } } }`, with each section collected independently so one failure never
  fails the rest. It never exposes secrets, session ids, CSRF tokens, raw
  bodies, job payloads, or absolute filesystem paths. Source: `src/introspect/`,
  `src/cli/inspect-commands.ts`, `src/cli/plugins/resolve.ts`.
- **Plugin static descriptor** — `JsailsPlugin` carries an optional
  `describe?: () => PluginDescription`, a pure, side-effect-free declarative
  descriptor readable **without** running `setup`; it never invokes callbacks,
  signs snapshots, or performs I/O. `PluginDescription` currently carries
  `components?: readonly { name, actions, writableKeys }[]`. The
  server-components plugin implements it, and both `jsails describe` and the
  introspect `components` section read component metadata through it without
  materializing a runtime. Source: `src/extensions/plugin-contract.ts`,
  `src/server-components/extension.ts`.

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
- The built-in names above (including `jamal` and `plugins`) are always reserved
  and cannot be shadowed.

Authentication primitives in `src/auth/` (session manager/CSRF) are
**internal, not exported from the package index, and are not a finished
authentication/authorization system** — build production auth on maintained
libraries. There is no separate `init`
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
npm run check              # typecheck, lint, format check, then the full test build
npm run verify:starter     # opt-in end-to-end starter verification (see below)
npm run verify:starter -- --skip-browser  # same pipeline, 0 browsers launched
npm run verify:integrations # opt-in live-service harness (env-gated; see below)
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

The fixture's database-gated auth stages (`auth:migrate`, `user:create`, and the
auth browser journey) run only when the three MariaDB connection variables
(`DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`) are present; when they are
absent each is recorded as an explicit `skipped` with reason `requires MariaDB
(DATABASE_HOST)` — never silently passed — and this is evaluated regardless of
`--skip-browser`.

`npm run verify:integrations` is **opt-in** and env-gated: it exercises the four
external-service seams (database, jobs, broadcast, Docker) against real services
the operator points at via `JSAILS_TEST_*` variables. Every stage skips cleanly
when its variables are absent (the run exits 0), and a stage that is enabled but
then fails exits non-zero. No CLI command triggers it and it is not part of
`check`/`test`; it requires an already-built `dist/`.

### CI and security

`.github/workflows/ci.yml` runs three jobs on push to `main` and pull requests:
`check` (a Node `20.19.0` / `22.13.0` / `26.x` matrix running `npm ci` + `npm run
check`), `starter` (Node 26; builds the framework then runs `verify:starter
--skip-browser` — no browser is downloaded or launched), and `integrations`
(Node 26; runs `verify:integrations` only when at least one `JSAILS_TEST_*`
secret is configured, so an unconfigured repo skips the harness instead of
reporting four no-op skips). `docs/SECURITY.md` records the security model and
review state: the trusted in-process plugin boundary, install gates (SHA-256
checksum + optional signature verification), two-source enablement, the
admin/server-component/upload/auth/broadcast/deploy boundaries, the
dependency-audit posture (CI does **not** gate on `npm audit`), and open
verification gaps (no live external-service coverage, Windows untested, login-only
auth in the starter).

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
  `src/client/navigation.ts`, `src/client/state-decoding.ts`,
  `src/client/component-bindings.ts`.
- Server components: `src/server-components/index.ts`,
  `src/server-components/component.ts`, `src/server-components/extension.ts`,
  `src/server-components/runtime.ts`, `src/server-components/snapshot.ts`,
  `src/server-components/protocol.ts`.
- Asset URLs: `src/app/asset-urls.ts`.
- i18n: `src/i18n/index.ts`, `src/i18n/translator.ts`.
- Feature flags: `src/flags/index.ts`, `src/flags/flags.ts`,
  `src/flags/plugin.ts`, `src/flags/database-store.ts`.
- Theme tokens: `src/theme/index.ts`, `src/theme/tokens.ts`,
  `src/theme/plugin.ts`.
- Seeders: `src/database/seeders.ts`, `src/cli/seeder-commands.ts`,
  `src/cli/queue-commands.ts`, `src/cli/make-commands.ts`.
- CLI dispatch and contributions: `src/cli.ts` (lazy bootstrap),
  `src/cli/dispatch.ts` (heavy command imports),
  `src/cli/command-contribution.ts` (`buildCommandContributionIndex`).
- Plugins: `src/plugins/index.ts`, `src/plugins/discovery.ts`,
  `src/plugins/manifest.ts`, `src/plugins/enablement.ts`,
  `src/plugins/state-store.ts`, `src/plugins/database-state-store.ts`,
  `src/plugins/activation.ts`, `src/plugins/installer.ts`.
- Admin: `src/admin/panel.ts`, `src/admin/plugin.ts`, `src/admin/resource.ts`,
  `src/admin/page.ts`, `src/admin/admin-plugin.ts`, `src/admin/helpers.ts`.
- Plugin manager: `src/plugin-manager/index.ts`,
  `src/plugin-manager/plugin.ts`, `src/plugin-manager/pages.ts`.
- Jamal: `src/jamal/command.ts`, `src/jamal/config.ts`, `src/jamal/compose.ts`,
  `src/jamal/docker.ts`, `src/jamal/production/`.
- Deploy generators: `src/deploy/builtin-generators.ts`, `src/deploy/registry.ts`,
  `src/deploy/database-config.ts`, `src/deploy/valkey-config.ts`,
  `src/deploy/hosting-config.ts`, `src/deploy/hardening-config.ts`,
  `src/deploy/once-config.ts`.
- Starter templates: `templates/starter/pages/`, `templates/starter/components/`,
  `templates/starter/ui/`, `templates/starter/client/main.tsx`,
  `templates/starter/jsails.app.js.template`.

This file travels into generated apps: `createStarterFiles` bundles this guide
and prefixes it with starter-specific instructions, so a scaffolded project ships
a reader guide without any runtime import of the framework's copy.
