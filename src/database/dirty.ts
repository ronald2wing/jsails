/**
 * Dirty tracking — a read-only Active Record change surface over the
 * entity-subscriber seam.
 *
 * {@link defineDirtyTracking} returns an {@link EntityHooksDefinition} that
 * snapshots an entity's scalar column values at the load/insert boundary and
 * records the before/after pair of each changed column at the update boundary.
 * The public read helpers ({@link changed}, {@link was}, {@link savedChanges})
 * answer the classic Rails questions without any persistence side effects:
 *
 * ```ts
 * const post = await Post.findOneByOrFail({ id: 1 });
 * post.title = 'New title';
 * post.changed();          // ['title']
 * post.changed('title');   // true
 * post.was('title');       // 'Old title' (the loaded value)
 * await post.save();
 * post.savedChanges();     // { title: ['Old title', 'New title'] }
 * ```
 *
 * Tracking is **columns only** — relation properties are deliberately ignored,
 * because a relation's "change" is its foreign-key column, not the loaded
 * object graph. Comparison is shallow (`Object.is`) against the snapshot taken
 * at the most recent load/insert (or, for an entity never loaded, at the most
 * recent update). An untracked instance answers `[]` / `false` / `undefined`
 * rather than throwing.
 */

import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';

import { defineEntityHooks, type EntityHooksDefinition } from './entity-subscribers.js';

// ---------------------------------------------------------------------------
// Snapshot state
// ---------------------------------------------------------------------------

interface DirtySnapshot {
  /** Column values as of the last load/insert/update boundary. */
  baseline: Record<string, unknown>;
  /** The last update's before/after pairs, when one has happened. */
  saved?: Record<string, readonly [unknown, unknown]>;
}

/** Per-instance snapshots; keyed by the entity instance, never the metadata. */
const snapshots = new WeakMap<object, DirtySnapshot>();

/**
 * Scalar column names per connection, cached so `getMetadata` is resolved once
 * per data source rather than once per hook invocation. A connection's metadata
 * is fixed once built, so the cache never goes stale.
 */
const columnCache = new WeakMap<object, readonly string[]>();

/** Resolve the entity's scalar column property names, cached per connection. */
function columnNames(
  manager: EntityManager,
  entity: EntityTarget<ObjectLiteral>,
): readonly string[] {
  const cached = columnCache.get(manager.connection);
  if (cached !== undefined) {
    return cached;
  }
  const metadata = manager.connection.getMetadata(entity);
  const names = metadata.columns
    .filter((column) => column.relationMetadata === undefined)
    .map((column) => column.propertyName);
  const frozen = Object.freeze(names);
  columnCache.set(manager.connection, frozen);
  return frozen;
}

/** Capture a shallow copy of the instance's scalar column values. */
function capture(instance: object, columns: readonly string[]): Record<string, unknown> {
  const record = instance as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    out[column] = record[column];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the dirty-tracking hook definition for one entity. Wire it through
 * {@link createEntitySubscriber} into a data source's `subscribers` list.
 *
 * `afterLoad`/`afterInsert` reset the baseline and clear any prior `saved`
 * snapshot; `beforeUpdate` records the before/after pair for every changed
 * scalar column and refreshes the baseline to the incoming values. The
 * `beforeUpdate` hook keys by the caller's instance (`context.data`) because
 * TypeORM hands it a distinct pre-change database entity under
 * `context.entity`.
 */
export function defineDirtyTracking<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
): EntityHooksDefinition<T> {
  return defineEntityHooks<T>(entity, {
    afterLoad({ entity: loaded, manager }) {
      seed(loaded, manager, entity);
    },
    afterInsert({ entity: inserted, manager }) {
      seed(inserted, manager, entity);
    },
    beforeUpdate({ data, changedColumns, manager }) {
      const columns = columnNames(manager, entity);
      const instance = data as object;
      const record = instance as Record<string, unknown>;

      const snapshot = snapshots.get(instance);
      if (snapshot === undefined) {
        // Never loaded/inserted through the subscriber: there is no prior
        // baseline to compare against, so record none and seed from now.
        snapshots.set(instance, { baseline: capture(instance, columns) });
        return;
      }

      const saved: Record<string, readonly [unknown, unknown]> = {};
      for (const column of changedColumns ?? []) {
        if (column in snapshot.baseline) {
          saved[column] = [snapshot.baseline[column], record[column]];
        }
      }
      snapshot.saved = saved;
      snapshot.baseline = capture(instance, columns);
    },
  });
}

/** Reset the snapshot for a freshly loaded or inserted instance. */
function seed(instance: object, manager: EntityManager, entity: EntityTarget<ObjectLiteral>): void {
  snapshots.set(instance, { baseline: capture(instance, columnNames(manager, entity)) });
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/**
 * The scalar columns whose current value differs from the tracked baseline.
 * Returns `[]` for an untracked instance.
 */
export function changed(instance: object): string[];
/** Whether `column`'s current value differs from the tracked baseline. */
export function changed(instance: object, column: string): boolean;
export function changed(instance: object, column?: string): string[] | boolean {
  const snapshot = snapshots.get(instance);
  if (snapshot === undefined) {
    return column === undefined ? [] : false;
  }
  const record = instance as Record<string, unknown>;
  if (column === undefined) {
    return Object.keys(snapshot.baseline).filter(
      (name) => !Object.is(record[name], snapshot.baseline[name]),
    );
  }
  if (!(column in snapshot.baseline)) {
    return false;
  }
  return !Object.is(record[column], snapshot.baseline[column]);
}

/** The tracked baseline value for a column, or `undefined` when absent. */
export function was(instance: object, column: string): unknown {
  return snapshots.get(instance)?.baseline[column];
}

/**
 * The before/after pairs recorded by the most recent update, keyed by column.
 * Returns `{}` when the instance has not been updated since its last load.
 */
export function savedChanges(instance: object): Record<string, readonly [unknown, unknown]> {
  return snapshots.get(instance)?.saved ?? {};
}
