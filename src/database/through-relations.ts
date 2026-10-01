/**
 * Through-relation resolver for JSails entities.
 *
 * A "has_many :through" relation chains a source entity through an intermediate
 * (junction) entity to reach a final target. This module resolves such chains
 * from TypeORM decorator metadata without opening a database connection.
 *
 * Example: Doctor has_many :appointments, Appointment belongs_to :patient
 *   → resolveThroughRelation(Doctor, 'patients') returns the chain:
 *     Doctor → (through Appointment, FK doctor_id) → Patient (FK patient_id)
 */

import { getMetadataArgsStorage } from 'typeorm';
import type { RelationTypeInFunction } from 'typeorm/metadata/types/RelationTypeInFunction.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ThroughRelation {
  /** Source entity name. */
  source: string;
  /** Intermediate (junction) entity name. */
  through: string;
  /** Target entity name. */
  target: string;
  /** Database column name of the FK on the through entity referencing source. */
  sourceKey: string;
  /** Database column name of the FK on the through entity referencing target. */
  targetKey: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a TypeORM callback type to the actual entity class.
 * Mirrors the same helper in relation-metadata.ts.
 */
function resolveType(typeValue: RelationTypeInFunction): Function {
  if (typeof typeValue === 'object' && typeValue !== null && 'type' in typeValue) {
    const schemaType = (typeValue as { type: Function }).type;
    if (typeof schemaType !== 'function') {
      throw new Error('An entity schema relation must reference an entity class');
    }
    return schemaType;
  }
  if (typeof typeValue === 'function') {
    const resolved = (typeValue as Function)();
    if (typeof resolved !== 'function') {
      throw new Error('A relation type callback must return an entity class');
    }
    return resolved;
  }
  throw new Error('Unsupported relation type value');
}

/** Find a database join-column name for the given entity and property. */
function findJoinColumn(entity: Function, propertyName: string): string | undefined {
  const storage = getMetadataArgsStorage();
  const joinCol = storage.joinColumns.find(
    (jc) => jc.target === entity && jc.propertyName === propertyName,
  );
  return joinCol?.name;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a "has_many :through" / "has_one :through" relation chain.
 *
 * Scans the source entity's O2M/M2M relations for an intermediate entity whose
 * own M2O relations include one whose property name matches `prop`. When found,
 * the chain is resolved into a {@link ThroughRelation} descriptor.
 *
 * @param source  The source entity class (e.g. `Doctor`).
 * @param prop    The virtual through property name on the source entity
 *                (e.g. `'patients'`).
 * @returns The through-relation descriptor, or `undefined` when no matching
 *          chain is found.
 */
export function resolveThroughRelation(
  source: Function,
  prop: string,
): ThroughRelation | undefined {
  const storage = getMetadataArgsStorage();

  // Find O2M / M2M relations on the source entity.
  const sourceRelations = storage.relations.filter(
    (r) =>
      r.target === source &&
      (r.relationType === 'one-to-many' || r.relationType === 'many-to-many'),
  );

  for (const sourceRel of sourceRelations) {
    const throughEntity = resolveType(sourceRel.type);

    // Find M2O relations on the through entity.
    const throughM2Os = storage.relations.filter(
      (r) => r.target === throughEntity && r.relationType === 'many-to-one',
    );

    for (const m2o of throughM2Os) {
      if (m2o.propertyName !== prop) continue;

      const targetEntity = resolveType(m2o.type);

      // Reject self-referential through chains (target === source).
      if (targetEntity === source) continue;

      // sourceKey: FK column on the through entity that references source.
      // This is the inverse of source's O2M — the M2O on throughEntity whose
      // type callback resolves back to `source`.
      const inverseM2O = storage.relations.find(
        (r) =>
          r.target === throughEntity &&
          r.relationType === 'many-to-one' &&
          resolveType(r.type) === source,
      );
      const sourceKey = findJoinColumn(throughEntity, inverseM2O?.propertyName ?? '') ?? '';

      // targetKey: FK column on the through entity that references target.
      const targetKey = findJoinColumn(throughEntity, m2o.propertyName) ?? '';

      return {
        source: source.name,
        through: throughEntity.name,
        target: targetEntity.name,
        sourceKey,
        targetKey,
      };
    }
  }

  return undefined;
}
