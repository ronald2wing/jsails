/**
 * Canonical equality comparators for the portable schema model.
 *
 * Each comparator normalizes both operands first, so two definitions that mean
 * the same thing but differ in field order or omitted-vs-empty lists compare
 * equal. This is the single definition of "unchanged" the autodetector diffs
 * against.
 */

import {
  type CheckDefinition,
  type ColumnDefinition,
  type ForeignKeyDefinition,
  type IndexDefinition,
  type SchemaState,
  type TableDefinition,
  type UniqueDefinition,
} from './schema-types.js';
import {
  normalizeCheck,
  normalizeColumn,
  normalizeForeignKey,
  normalizeIndex,
  normalizeInheritance,
  normalizePolymorphic,
  normalizeSchemaState,
  normalizeTable,
  normalizeUnique,
} from './schema-normalize.js';

export function columnsEqual(a: ColumnDefinition, b: ColumnDefinition): boolean {
  return JSON.stringify(normalizeColumn(a)) === JSON.stringify(normalizeColumn(b));
}

export function indexesEqual(a: IndexDefinition, b: IndexDefinition): boolean {
  return JSON.stringify(normalizeIndex(a)) === JSON.stringify(normalizeIndex(b));
}

export function uniquesEqual(a: UniqueDefinition, b: UniqueDefinition): boolean {
  return JSON.stringify(normalizeUnique(a)) === JSON.stringify(normalizeUnique(b));
}

export function foreignKeysEqual(a: ForeignKeyDefinition, b: ForeignKeyDefinition): boolean {
  return JSON.stringify(normalizeForeignKey(a)) === JSON.stringify(normalizeForeignKey(b));
}

export function checksEqual(a: CheckDefinition, b: CheckDefinition): boolean {
  return JSON.stringify(normalizeCheck(a)) === JSON.stringify(normalizeCheck(b));
}

export function inheritanceEqual(
  a: TableDefinition['inheritance'],
  b: TableDefinition['inheritance'],
): boolean {
  return (
    JSON.stringify(normalizeInheritance(a, 'table')) ===
    JSON.stringify(normalizeInheritance(b, 'table'))
  );
}

export function polymorphicEqual(
  a: TableDefinition['polymorphic'],
  b: TableDefinition['polymorphic'],
): boolean {
  return (
    JSON.stringify(normalizePolymorphic(a, 'table')) ===
    JSON.stringify(normalizePolymorphic(b, 'table'))
  );
}

export function tablesEqual(a: TableDefinition, b: TableDefinition): boolean {
  return JSON.stringify(normalizeTable(a)) === JSON.stringify(normalizeTable(b));
}

export function schemasEqual(a: SchemaState, b: SchemaState): boolean {
  return JSON.stringify(normalizeSchemaState(a)) === JSON.stringify(normalizeSchemaState(b));
}
