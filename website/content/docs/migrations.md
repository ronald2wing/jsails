---
title: Migrations
order: 6
section: Building
---

# Migrations

JSails reconciles your database with a **declarative desired-state engine**.
Your model classes are the single source of truth — there is no migration file
to write, no JSON artifact to check in, and no applied-state ledger.

```sh
jsails db:push --config jsails.config.js           # diff and apply
jsails db:push --dry-run --config jsails.config.js  # print the plan only
jsails db:diff --config jsails.config.js            # read-only plan
```

## How it works

`db:push` diffs the declared model schema (the `@jsails.*` decorators on your
`ApplicationRecord` subclasses) against the **live database** — it introspects
the current state via TypeORM's `QueryRunner.getTables()`, computes a minimal
operation plan, and applies it.

`db:diff` prints the same plan without applying anything.

There is **no `migrations/` directory, no JSON migration files, and no
`jsails_migrations` tracking table**. Every run derives the plan fresh from the
models and the current database shape.

### Destructive changes are refused by default

Every operation in the plan is classified safe or destructive before any DDL
runs. The classification is **atomic**: if any operation is destructive and
`--allow-destructive` is absent, the engine applies **nothing**.

| Safe | Destructive |
|------|-------------|
| `create_table` | `drop_table` |
| `add_column` (nullable or with default) | `drop_column` |
| `rename_column` | `drop_index`, `drop_unique` |
| `alter_column` — widening (varchar length up, int → bigint) | `alter_column` — narrowing, type change, or nullability tightening |
| `create_index`, `create_unique` | `drop_foreign_key`, `drop_check` |
| `add_foreign_key`, `add_check` | **any `alter_column` on SQLite** (SQLite drops and recreates the table) |
| `alter_inheritance`, `alter_polymorphic` (metadata only) | |

An `add_column` that is `NOT NULL` with no default is refused even earlier by
the differ — it cannot generate a plan for it because the existing rows have no
value.

Pass `--allow-destructive` to apply a plan that contains destructive operations.
You are responsible for your own backups — the engine cannot reverse a
destructive change without a ledger.

### Renames: `@jsails.renamedFrom`

Without a hint the differ sees a dropped column and a new one. Mark a renamed
column or relation with `@jsails.renamedFrom` so the plan emits `rename_column`
instead of drop + add:

```ts
export class Post extends ApplicationRecord {
  @jsails.renamedFrom('summary') declare excerpt: string;
}
```

The marker is **idempotent** — it matches nothing once the rename has been
applied, so it is safe to leave in the source. It is a side-channel hint, not a
schema field.

### Portable schema

The engine supports these column types: `integer`, `varchar` (with a ceiled
`length`), `text`, `boolean`, `datetime`, `decimal(precision, scale?)`, `float`,
`bigint`, `uuid`, `json`, `date`, `time`. A single generated integer primary key
or a composite primary key is supported. Simple (non-partial, non-expression,
non-fulltext, non-spatial) indexes, simple unique constraints, table-level
`CHECK`, and single- or multi-column foreign keys with
`CASCADE` / `RESTRICT` / `SET NULL` / `NO ACTION` actions round out the set.
Many-to-many relations are supported through explicit junction entities or
`@JoinTable()`. Deferrable foreign keys and unique constraints are available on
Postgres only.

Rejected types raise `UnsupportedSchemaError`: partial and expression indexes,
database enums, generated UUIDs, computed columns, `@CreateDateColumn` /
`@UpdateDateColumn`, and function defaults.

## Data migrations

Schema reconciliation (phase 1) handles the table shape. Data migrations
(phase 2) transform the rows — backfilling a new column, normalising values, or
cleaning up after a rename. They are defined as named pairs in `jsails.config.js`
and run on **every** `db:push`, including when the schema is already up to date.

```ts
// jsails.config.js
import { JsailsDataSource, defineDataMigration, readDatabaseEnvironment } from 'jsails';

const database = readDatabaseEnvironment();

export const dataMigrations = {
  backfill_slugs: defineDataMigration({
    async up(ctx) {
      await ctx.queryRunner.query(
        "UPDATE post SET slug = LOWER(title) WHERE slug IS NULL",
      );
    },
    async down(ctx) {
      await ctx.queryRunner.query("UPDATE post SET slug = NULL");
    },
  }),
};

export default new JsailsDataSource({ ...database, entities: [Post] });
```

`ctx.queryRunner` is a TypeORM `QueryRunner`. Call `ctx.queryRunner.query(sql)`
for raw SQL; there is no DSL. Data migrations are expected to run DML only —
never DDL; the tables are already reconciled by phase 1.

Data migrations run in **declaration order** (object key order). There is no
dependency graph and no topo sort.

### The idempotency contract

Data migrations are **not tracked** — there is no ledger recording which ones
have run. They execute on every `db:push`, so every data migration **must be
idempotent**. The canonical form is a guarded statement:

```sql
UPDATE post SET slug = LOWER(title) WHERE slug IS NULL;
```

An unguarded `INSERT` duplicates rows on every push. This is the developer's
responsibility.

Data migrations never run if phase 1 refuses (destructive without
`--allow-destructive`) or fails.

### `down` is manual

The `down` function is **not invoked by any command**. There is no
`db:push --down` and no automatic rollback. `down` is a documented escape hatch
you can call from a script or REPL when you need to reverse a data migration
by hand.

## Polymorphic relations

A polymorphic relation lives on the **child** only; the target entity declares
nothing and the inverse is inferred.

```ts
@PolymorphicRelation({ targets: [Post, Comment], relatedName: 'owner' })
export class Like extends BaseEntity {
  // like_type varchar(190), like_id integer are generated columns
}
```

Read it both directions:

```ts
const owner = await loadPolymorphic(like, 'owner'); // child → parent
const likes = await loadPolymorphicInverse(post, 'likes'); // parent → children
```

There is no database-level FK — the target varies per row.

## Honest limits

- **Live-only objects are skipped.** Partial, expression, fulltext, and spatial
  indexes, database enums, generated and computed columns, and function defaults
  that exist only in the live database are filtered from introspection, so they
  never cause phantom diffs.
- **Type canonicalization on MySQL/MariaDB is heuristic.** The engine resolves
  ambiguous mapped types (`tinyint` → boolean vs integer, `longtext` → text vs
  json) by preferring the **declared** model type as a tiebreaker. Unsigned
  integers are canonicalized to signed — precision is lossy.
- **SQLite introspection is best-effort.** SQLite has no real type system; the
  engine matches types by string comparison, and every `alter_column` on SQLite
  is destructive because SQLite drops and recreates the table.
- **No automatic rollback.** Without a ledger the engine cannot know what ran.
  Destructive changes are refused by default — the operator owns backups. Data
  migration `down` functions are invoked only manually.

## Next steps

- [Models](/docs/models) — the declarative Active Record model surface.
- [Data Layer](/docs/data-layer) — the portable schema, validation, and query
  expressions.
- [CLI](/docs/cli) — `db:push` and `db:diff`.