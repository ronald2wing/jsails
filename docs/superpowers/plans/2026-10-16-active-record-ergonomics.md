# Active Record ergonomics: dirty tracking, enum, named scopes — Implementation Plan

**Status:** plan · ready for execution
**Owner:** lead + deep-worker
**Date:** 2026-10-16

## Goal

Close three of the highest-frequency Active Record gaps vs Rails/Phoenix/EF/Laravel:

1. **Dirty tracking** — `changedAtributes()`, `changed?()`, `was(name)`,
   `savedChanges()` on the model instance (TypeORM has an **internal** change
   tracker but no public AR API).
2. **`enum`** — `@jsails.enum(values)` / a `enum` declaration that stores a
   string/int and exposes value predicates + a scope.
3. **Named scopes** — `scope(name, fn)` authoring surface composing with the
   existing `query()`/`ModelQuery`.

All three are authoring-surface additions; none changes migration/schema
semantics beyond what the existing `varchar`/`integer` columns already support.

## Design

### 1. Dirty tracking — `src/database/dirty.ts`

TypeORM's `BaseEntity` exposes private change tracking via
`repository`/`Subject` internally, but the clean AR surface is to track changes
at the entity-subscriber boundary (`beforeUpdate`) and on a per-instance basis.

- `defineDirtyTracking(entity)` → an `EntityHooksDefinition` wiring `beforeInsert`
  and `beforeUpdate` to snapshot the previous column values into non-persisted
  metadata on the instance.
- Public read API on the instance (via prototype decoration or a helper):
  - `changed(): string[]` — columns changed since load.
  - `changed?(name): boolean` — was a specific column changed.
  - `was(name): unknown` — the previous value for a changed column.
  - `savedChanges()` — the last `beforeUpdate` snapshot (before/after).
- Implementation: record a `WeakMap<entity, { previous: Record<string, unknown> }>`
  snapshot at load/insert boundary. `changed?`/`was` compare against the entity's
  current value. Read-only, no persistence changes.

### 2. `enum` — `src/database/enum.ts`

- `@jsails.enum(values)` decorator marker (runtime-inert, like the existing
  `@jsails.*` markers) read by the compiler; OR a standalone
  `enumColumn({ values })` on the portable schema.
- Generates:
  - a `varchar` (or `integer` for numeric values) column,
  - value predicates: `post.statusIsDraft()`, `post.statusIn(['draft'])`,
  - a scope: `Post.published()` returning `query(Post).where(qEq('status','published'))`.
- Because enum values are a closed set, `db:push` column + a `CHECK` constraint
  (`status IN (...)`).

### 3. Named scopes — `src/database/scopes.ts`

- `scope(name, fn)` authoring helper registering a reusable predicate/query
  transformer on a model's prototype/registry.
- `ModelQuery.applyScope(name, ...args)` or model-level `Post.<scope>()` calling
  into the existing `query(Post)`.
- A scope is `(qb: SelectQueryBuilder<T>, ...args) => void` or a pure
  `(q: ModelQuery<T>, ...args) => ModelQuery<T>` — pick the latter to compose
  with `ModelQuery`. Registry per-model, value-free unknown-scope error.

## Files

- `src/database/dirty.ts` (new)
- `src/database/enum.ts` (new)
- `src/database/scopes.ts` (new)
- `src/models/index.ts` — re-export `dirty` helpers + `enum` + `scope`
- `src/internal/jsails-namespace.ts` — add `@jsails.enum` marker (consistent
  with existing markers)
- `test/database/{dirty,enum,scopes}.test.ts` (new)

## Verification

`npm run format` → `npm run lint` → `npm run check` (0 failures).

## Non-goals

- No new migration file format (enum stays `varchar` + CHECK).
- No full AR lifecycle event system (that is a separate, larger gap).
- No change-tracking for relations (columns only; relation-level dirty is out of
  scope this pass).

## Deliberate decision to defer

This slice does NOT touch auth lifecycle, the AI SDK, assets, routing, or HMR —
those are later slices in the 16-item batch.