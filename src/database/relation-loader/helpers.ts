/**
 * Internal helpers for the batch relation loader: FK/property resolution,
 * polymorphic inverse scanning, metadata lookups, PK serialization, and
 * select-object conversion.
 */

import { getMetadataArgsStorage } from 'typeorm';
import type { BaseEntity } from 'typeorm';

import { RelationError, type ResolvedRelation } from '../relation-metadata.js';
import { resolvePolymorphicDescriptor, type PolymorphicDescriptor } from '../polymorphic.js';
import type { RelationLoadOptions } from './types.js';

// ---------------------------------------------------------------------------
// FK / property resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a foreign-key column's property name from its database column name.
 * The QueryBuilder addresses columns by property name and quotes them per
 * driver; a relation property cannot be selected raw, so the FK must be
 * referenced through the scalar column that backs it.
 */
export function fkPropertyName(
  repo: {
    metadata: { findColumnWithDatabaseName(name: string): { propertyName: string } | undefined };
  },
  databaseName: string,
): string {
  const column = repo.metadata.findColumnWithDatabaseName(databaseName);
  if (!column) {
    throw new RelationError('Relation foreign-key column could not be resolved');
  }
  return column.propertyName;
}

// ---------------------------------------------------------------------------
// Metadata helpers (no DataSource required)
// ---------------------------------------------------------------------------

/**
 * Resolve an entity class to its table name via metadata storage only —
 * no {@code getRepository()} call, so it works for classes without a live
 * DataSource (e.g. polymorphic targets scanned during inverse resolution).
 */
export function getTableNameFromMeta(target: Function): string {
  const tableArg = getMetadataArgsStorage().tables.find((t) => t.target === target);
  return tableArg?.name ?? target.name;
}

/**
 * Resolve an entity class to its primary-key column property names via
 * metadata storage.
 */
function getPkPropertyNamesFromMeta(target: Function): string[] {
  const storage = getMetadataArgsStorage();
  return storage.columns
    .filter((c) => c.target === target && c.options.primary)
    .map((c) => c.propertyName)
    .sort();
}

// ---------------------------------------------------------------------------
// Polymorphic select / where validation
// ---------------------------------------------------------------------------

/**
 * Validate that every column named in {@code opts.select} and every key in
 * {@code opts.where} exists as a scalar column on **every** target entity of
 * the polymorphic descriptor. A column absent from any single target is
 * rejected value-free — silently applying a filter or selection that a target
 * does not understand would produce incorrect results.
 */
export function validatePolymorphicColumns(
  descriptor: PolymorphicDescriptor,
  opts: RelationLoadOptions,
): void {
  if (!opts.select && !opts.where) return;

  for (const targetClass of descriptor.targetClasses) {
    const targetRepo = (targetClass as typeof BaseEntity).getRepository();
    const columnNames = new Set(targetRepo.metadata.columns.map((c) => c.propertyName));

    if (opts.select) {
      for (const col of opts.select) {
        if (!columnNames.has(col)) {
          throw new RelationError(
            'A selected column is not present on every polymorphic target entity',
          );
        }
      }
    }

    if (opts.where) {
      for (const key of Object.keys(opts.where)) {
        if (!columnNames.has(key)) {
          throw new RelationError(
            'A where filter references a column not present on every polymorphic target entity',
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Polymorphic inverse helpers (fallback for relation-metadata)
// ---------------------------------------------------------------------------

/**
 * Check whether ANY registered polymorphic descriptor uses the given
 * {@code relatedName}. This lets the loader distinguish a plausible polymorphic
 * inverse property (which should resolve to empty arrays when no child targets
 * this specific parent) from a genuinely unknown property (which should throw).
 */
export function hasPolymorphicInverseProperty(propertyName: string): boolean {
  const storage = getMetadataArgsStorage();
  for (const tableArg of storage.tables) {
    const candidate = tableArg.target;
    if (typeof candidate !== 'function') continue;
    const desc = resolvePolymorphicDescriptor(candidate);
    if (desc && desc.relatedName === propertyName) return true;
  }
  return false;
}

/**
 * Try to resolve a polymorphic **inverse** relation — a property name on a
 * parent entity that matches the {@code relatedName} of a polymorphic
 * descriptor on a child entity whose target classes include the parent's table.
 *
 * {@link resolveRelation} only resolves forward polymorphic (when the owning
 * entity carries the descriptor). For inverse, we scan all registered tables
 * for a child descriptor that targets this parent's table by {@code relatedName}.
 *
 * Returns a synthetic {@link ResolvedRelation} with {@code kind: 'polymorphic'}
 * and the child entity as {@code targetEntity}, or {@code null} when no
 * matching child is found.
 */
export function tryResolvePolymorphicInverse(
  entity: Function,
  propertyName: string,
): ResolvedRelation | null {
  // Read the parent's table name from metadata so this works even when the
  // parent entity has no live DataSource (e.g. a dynamically created entity in
  // a test where only a subset of entities shares a FileDataSource).
  const parentTableName = getTableNameFromMeta(entity);

  const storage = getMetadataArgsStorage();
  for (const tableArg of storage.tables) {
    const candidate = tableArg.target;
    if (typeof candidate !== 'function') continue;
    const desc = resolvePolymorphicDescriptor(candidate);
    if (!desc) continue;
    if (desc.relatedName !== propertyName) continue;

    for (const targetClass of desc.targetClasses) {
      if (getTableNameFromMeta(targetClass) === parentTableName) {
        // Build a synthetic ResolvedRelation pointing at the child entity.
        const childPkCols = getPkPropertyNamesFromMeta(candidate);
        return {
          propertyName,
          kind: 'polymorphic',
          targetEntity: candidate,
          polymorphic: desc,
          primaryColumns: childPkCols,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Select / metadata utilities
// ---------------------------------------------------------------------------

/**
 * Convert a string-array {@code select} list to TypeORM v1+ object syntax.
 * {@code ['id', 'name']} becomes {@code { id: true, name: true }}.
 */
export function selectToObject(columns: readonly string[]): Record<string, true> {
  const obj: Record<string, true> = {};
  for (const col of columns) {
    obj[col] = true;
  }
  return obj;
}

export function hasJoinColumnOnEntity(entity: Function, relationProp: string): boolean {
  return getMetadataArgsStorage().joinColumns.some(
    (jc) => jc.target === entity && jc.propertyName === relationProp,
  );
}

// ---------------------------------------------------------------------------
// PK serialization
// ---------------------------------------------------------------------------

export function serializeValues(values: unknown[]): string {
  if (values.length === 1) {
    return String(values[0]);
  }
  return JSON.stringify(values);
}

export function serializePk(row: Record<string, unknown>, pkColumns: string[]): string {
  const values = pkColumns.map((col) => row[col]);
  return serializeValues(values);
}

export function deserializeCompositePk(fk: unknown, pkColumns: string[]): Record<string, unknown> {
  if (Array.isArray(fk) && fk.length === pkColumns.length) {
    const rec: Record<string, unknown> = {};
    for (let i = 0; i < pkColumns.length; i += 1) {
      rec[pkColumns[i]!] = fk[i];
    }
    return rec;
  }
  throw new RelationError(
    'Composite-key foreign key value is not an array matching the PK columns',
  );
}
