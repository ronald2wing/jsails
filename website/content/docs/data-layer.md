---
title: Data Layer
order: 4
---

# Data Layer

JSails builds a portable schema over TypeORM: `JsailsDataSource` extends
TypeORM's `DataSource` but restricts drivers and owns its schema history. Use
`BaseEntity` (Active Record) or `EntitySchema` to define entities.

## The data source

`JsailsDataSource` restricts drivers to `'mariadb' | 'postgres' | 'mysql' |
'sqlite'`. **MariaDB is the recommended default.** Construction rejects
`synchronize`, `dropSchema`, and `migrationsRun` — JSails owns schema history via
its own migration runner.

```js
import { JsailsDataSource, readDatabaseEnvironment } from 'jsails';

const database = readDatabaseEnvironment();

export default new JsailsDataSource({
  ...database,
  entities: [User, Post],
});
```

`getModelSchema()` builds entity metadata offline — it never opens a connection.

## Models

Define entities with `BaseEntity` (Active Record) or `EntitySchema`. The portable
schema model covers:

- scalar columns — `integer`, `varchar` (with explicit `length`), `text`,
  `boolean`, `datetime`
- a single generated integer primary key, or a composite primary key
- simple (non-partial, non-expression) indexes and unique constraints
- single- or multi-column many-to-one foreign keys with
  `CASCADE` / `RESTRICT` / `SET NULL` / `NO ACTION`
- many-to-many relations via explicit junction entities or `@JoinTable()`

```ts
import { EntitySchema } from 'typeorm';

export const Post = new EntitySchema({
  name: 'Post',
  tableName: 'posts',
  columns: {
    id: { type: Number, primary: true, generated: true },
    title: { type: String, length: 255, nullable: false },
    body: { type: 'text', nullable: false },
    published: { type: Boolean, nullable: false, default: false },
  },
});
```

Rejected at the schema boundary (`UnsupportedSchemaError`): partial/expression
indexes, enums, generated UUIDs, computed columns, `@CreateDateColumn` /
`@UpdateDateColumn`, and function defaults. Deferrable foreign keys and unique
constraints are supported on Postgres only.

## Migrations

Migrations are **scalar and linear** — a JSON file in `migrations/` recording
operations, diffed against the model metadata by `makemigrations` (it never
introspects the database). JSails tracks applied state in its own
`jsails_migrations` table.

```sh
jsails makemigrations --name add_posts --config jsails.config.js
jsails migrate --config jsails.config.js
jsails showmigrations --config jsails.config.js
```

Rollback is explicit and destructive — select by name or step count, and both
require `--allow-destructive`:

```sh
jsails migrate --config jsails.config.js --down add_posts --allow-destructive
jsails migrate --config jsails.config.js --steps 1 --allow-destructive
```

Every destructive operation retains the definition it removed, so a rollback
re-creates dropped tables/columns and reverts renames exactly.

### Polymorphic relations

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
const owner = await loadPolymorphic(like, 'owner');          // child → parent
const likes = await loadPolymorphicInverse(post, 'likes');   // parent → children
```

There is no database-level FK — the target varies per row.

## Loading relations

`loadRelation` / `loadRelations` batch with IN-clause queries (one query per
relation level, never per parent), supporting M2O, O2M, O2O, M2M, and
polymorphic, with nested paths, column selection, filters, ordering, and limits:

```ts
const pages = await loadRelations(posts, {
  with: { tags: true, author: { with: { profile: true } } },
});
```

Compile relation conditions into portable `EXISTS` subqueries:

```ts
whereHas(users, 'posts', (q) => q.where('published', true)); // at least one match
has(users, 'posts', '>', 3);                                 // count comparison
relationCount(users, 'posts');                               // Map<id, count>
```

**Limits:** polymorphic relations and M2M-in-nested-paths are rejected
value-free by the predicates; composite-key loading raises `RelationError`.

## Read-only sources and seeders

`FileDataSource.create({ models })` seeds a read-only, in-memory Active Record
source from `rows` arrays or JSON files and flips SQLite into `query_only` mode —
the same `BaseEntity` static queries work, any write fails.

Seeders are registered and run in order against an initialized data source:

```ts
const registry = createSeederRegistry({ users: defineSeeder(async (ctx) => {...}) });
```

```sh
jsails seed --config jsails.seed.js
```

## Transactions

`transaction(dataSource, body)` wraps TypeORM's `manager.transaction` and adds a
per-call handle. The body receives the **transaction-scoped** `EntityManager` —
use it for every write inside the transaction, not the data source's own
manager.

```ts
import { transaction } from 'jsails';

await transaction(dataSource, async ({ manager, afterCommit, afterRollback }) => {
  const user = await manager.save(User, { email: 'ada@example.com', name: 'Ada' });
  await manager.save(Post, { authorId: user.id, title: 'Hello' });

  afterCommit(() => {
    // Runs after the outermost commit — safe for side effects that must
    // not happen if the transaction rolls back.
  });
  afterRollback(() => {
    // Runs after a rollback. A throw here is swallowed.
  });

  return user;
});
```

`afterCommit` / `afterRollback` callbacks are **per-call** — there is no global
registry — and they run **awaited, in registration order**, at the **outermost**
boundary only.

- **Success:** the transaction commits, then `afterCommit` callbacks run, then
  `transaction()` resolves with the body's value. A throwing `afterCommit`
  callback propagates and **replaces the body result**: the commit already
  happened, so the writes are durable even though the caller sees an error.
- **Failure:** the transaction rolls back, then `afterRollback` callbacks run,
  then the **original body error is re-thrown unchanged**. A throwing
  `afterRollback` callback is **swallowed** — cleanup must not mask the original
  cause.

**Nested calls join the outer transaction.** A `transaction()` inside a body for
the **same** `JsailsDataSource` reuses the outer manager and appends its
callbacks to the outer boundary, so they fire once at the outermost
commit/rollback. A nested call for a **different** data source opens an
independent transaction. This is implemented with `AsyncLocalStorage` keyed by
data-source identity.

`TransactionError` is raised only for the wrapper's own invalid arguments (a bad
data source or a non-function body); body failures propagate unwrapped. A
validation or subscriber throw inside a `transaction()` body rolls back the
whole transaction and fires `afterRollback`.

## Model-level validation

`defineEntityValidation(entity, schema)` attaches a Zod object schema to an
entity and returns an immutable `{ entity, schema }` descriptor. Validate data
directly with `validateEntity` (returns a flat `FieldError[]`, `[]` on success,
and never throws for a validation failure) or `assertEntityValid` (throws an
`EntityValidationError` carrying `.errors`).

```ts
import { JsailsDataSource, createEntitySubscriber } from 'jsails';
import { defineEntityValidation, entityValidationHooks } from 'jsails';
import { z } from 'zod';

const validation = defineEntityValidation(
  User,
  z.object({
    email: z.string().email('A valid email address is required.'),
    name: z.string().min(1, 'Name is required.'),
  }),
);

const dataSource = new JsailsDataSource({
  type: 'sqljs',
  location: './data/app.sqlite',
  entities: [User],
  subscribers: [createEntitySubscriber(entityValidationHooks(validation))],
});
```

`FieldError` is the same `{ field, message }` type from `jsails/validation`.
Messages come from the authored Zod schema (`issue.message`), input values are
never echoed, and dotted paths are used (`_root` for a root-level failure).

`entityValidationHooks(validation)` bridges the descriptor to the subscriber
seam: it returns a `defineEntityHooks` definition gating `beforeInsert` **and**
`beforeUpdate`. Wire it through the existing `createEntitySubscriber` in the
data source's `subscribers` list — an invalid `save()` throws
`EntityValidationError` and aborts, rolling back the surrounding transaction. Do
not wire it manually through `defineEntityHooks`; `entityValidationHooks`
already does that. It works for `BaseEntity` classes and `EntitySchema`-defined
entities alike, since it operates on the hook's `data` and needs no class.

**Deliberate non-goal:** there is no load-time (`afterLoad`) validation.
Auto-rejecting legacy rows at load turns a data-quality issue into an
availability outage; callers that want it can opt in with `validateEntity`.

## Query expressions

`F` is a column reference for column-to-column comparison. `Q` is a composable
predicate tree built from leaf constructors and combined with `and`/`or`/`not`.
`Case`/`When` is a conditional value expression. All three compile to portable
SQL through TypeORM's query builder — every value is a bound parameter, never
inlined, so booleans and dates are driver-correct.

```ts
import { applyQ, qGt, qLt, qIsNull, and, or, F, caseWhen, when, addCaseSelect } from 'jsails';

// Column-to-column comparison: likes > views.
const popular = await repo
  .createQueryBuilder('post')
  .where(applyQ(repo.createQueryBuilder('post'), qGt('likes', new F('views'))))
  .getMany();

// A nested predicate tree: (likes > 4 AND likes < 10) OR name IS NULL.
const predicate = or(and(qGt('likes', 4), qLt('likes', 10)), qIsNull('name'));
const rows = await repo.createQueryBuilder('post').where(applyQ(qb, predicate)).getMany();

// A conditional value in the SELECT list: 'hot' when likes > 6, else 'cold'.
const qb = repo.createQueryBuilder('post');
addCaseSelect(qb, caseWhen([when(qGt('likes', 6), 'hot')], 'cold'), 'temperature');
const scored = await qb.getRawMany();
```

`applyQ(qb, predicate, alias?)` wraps the compiled predicate in a parenthesized
`Brackets`, so it composes with any pre-existing `WHERE` condition. It also
composes with the relation seam: a `RelationPredicate` can call
`applyQ(rq.builder, predicate)` to filter a correlated `EXISTS` subquery.

**v1 limits:** `when` conditions are single leaves only (compound conditions are
rejected — TypeORM's `Brackets` has no public SQL-extraction API); dotted
relation paths are rejected; `eq`/`ne` with `null` is rejected (use
`qIsNull`/`qNotNull`); empty `in`/`notIn` and empty `and`/`or` are rejected.
`QueryExpressionError` is value-free.

## Model query

`query(entity, options?)` returns a chainable `ModelQuery<T>` over a TypeORM
`SelectQueryBuilder<T>` — a thin, connectionless wrapper that composes the query
expression and relation seams without a bespoke query language.

```ts
import { query, qGt } from 'jsails';

const posts = await query(Post)
  .where(qGt('likes', 4))
  .whereHas('comments', (rq) => rq.where('approved', true))
  .orderBy('createdAt', 'DESC')
  .limit(20)
  .includes({ author: true, comments: { order: { id: 'DESC' }, limit: 3 } })
  .getMany();
```

- `where(predicate)` applies a `Q` tree; `orderBy`/`limit`/`offset` map to the
  builder; `apply(fn)` is the raw escape hatch.
- `whereHas(relation, predicate?)` and `has(relation, operator, count)` delegate
  to the same EXISTS/COUNT subquery builders as the standalone relation
  predicates, so there is one code path. Both require the default alias
  `'entity_'`; a custom alias throws a value-free `RelationError` rather than
  silently mis-correlating the subquery.
- `includes(spec)` eager-loads relations **after** the base query runs, using
  IN-clause batching (one query per relation level). Repeated calls deep-merge;
  an explicit `false` removes a relation. `count()` ignores includes, and an
  empty result set skips the loader.
- Executors: `getMany()`, `getOne()` (returns `null` when no row matches), and
  `count()`. `ModelQueryError` is value-free.

**v1 limits:** `limit`/`offset` slice the **base** rows (Rails-like), not the
eager-loaded children; the `'join'` eager-load strategy is unsupported.

## Next steps

- [Pages & Routing](/docs/pages-and-routing) — serve and statically export pages.
- [Plugins & Extending](/docs/plugins-and-extending) — the extension seam and services.