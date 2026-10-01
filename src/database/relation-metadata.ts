/**
 * Pure, connectionless relation-metadata resolver for JSails entities.
 *
 * Given a BaseEntity class and a relation property name (or a dotted path),
 * returns a normalized {@link ResolvedRelation} descriptor without opening
 * a database connection. Resolves TypeORM decorator metadata from the global
 * metadata args storage, falling back to the polymorphic registry for
 * {@link PolymorphicRelation} properties.
 *
 * This is the foundation layer for relation loading and query building
 * (Slices 2+); it is deliberately synchronous and driver-independent.
 */

import { getMetadataArgsStorage } from 'typeorm';
import type { RelationTypeInFunction } from 'typeorm/metadata/types/RelationTypeInFunction.js';

import { resolvePolymorphicDescriptor } from './polymorphic.js';
import type { PolymorphicDescriptor } from './polymorphic.js';
import type { ThroughRelation } from './through-relations.js';
import { resolveThroughRelation } from './through-relations.js';

/** Maximum depth for dotted-path resolution. Mirrors the server-components precedent. */
export const MAX_NESTING_DEPTH = 8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedRelation {
  /** The relation property name on the source entity. */
  propertyName: string;
  /** Relation kind. */
  kind: 'many-to-one' | 'one-to-many' | 'one-to-one' | 'many-to-many' | 'polymorphic';
  /** The related entity class. */
  targetEntity: Function;
  /** For owning M2O/O2O: the FK column on this entity. */
  joinColumn?: string;
  /** For inverse O2M: the FK column on the target entity. */
  inverseJoinColumn?: string;
  /** For M2M: junction table plus both join columns. */
  junction?: {
    table: string;
    ownerColumn: string;
    inverseColumn: string;
  };
  /** For polymorphic: the descriptor from polymorphic.ts. */
  polymorphic?: PolymorphicDescriptor;
  /**
   * For through relations resolved by {@link resolveThroughRelation}: the
   * intermediate chain descriptor. When set, the current relation represents
   * a virtual "has_many :through" / "has_one :through" property.
   */
  through?: ThroughRelation;
  /** Ordered list of primary-key property names on the target entity. */
  primaryColumns: string[];
}

/** Raised for relation-resolution failures. Value-free. */
export class RelationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelationError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a TypeORM callback type to the actual entity class.
 * The `type` field on a decorator arg may be:
 * - A wrapper callback (`() => TargetClass`), which TypeORM wraps in
 *   {@link RelationTypeInFunction},
 * - Or a class constructor directly (for EntitySchema-based relations).
 */
function resolveType(typeValue: RelationTypeInFunction): Function {
  // EntitySchema objects carry a `type` property (not a function).
  if (typeof typeValue === 'object' && typeValue !== null && 'type' in typeValue) {
    const schemaType = (typeValue as { type: Function }).type;
    if (typeof schemaType !== 'function') {
      throw new RelationError('An entity schema relation must reference an entity class');
    }
    return schemaType;
  }
  // Both the wrapper callback `(() => TargetClass)` and `EntityTarget` (which
  // includes class constructors) are typeof 'function'. Call it — TypeORM
  // convention is to invoke the wrapper with no args to resolve.
  if (typeof typeValue === 'function') {
    // TypeScript narrows this union to `EntityTarget<any>` rather than the
    // callable arm, so cast through `Function` to invoke.
    const resolved = (typeValue as Function)();
    if (typeof resolved !== 'function') {
      throw new RelationError('A relation type callback must return an entity class');
    }
    return resolved;
  }
  throw new RelationError('Unsupported relation type value');
}

/** Read all PK column property names (in order) from the metadata args of an entity. */
function resolvePrimaryColumns(target: Function): string[] {
  const storage = getMetadataArgsStorage();
  return storage.columns
    .filter((c) => c.target === target && c.options?.primary === true)
    .sort((a, b) => {
      // Preserve declaration order: TypeORM stores columns in the order they
      // were processed, and primary columns are typically declared first.
      const aIdx = storage.columns.indexOf(a);
      const bIdx = storage.columns.indexOf(b);
      return aIdx - bIdx;
    })
    .map((c) => c.propertyName);
}

// ---------------------------------------------------------------------------
// Through-relation resolver
// ---------------------------------------------------------------------------

/**
 * Build a synthetic {@link ResolvedRelation} from a through chain resolved by
 * {@link resolveThroughRelation}. The result carries `kind: 'one-to-many'` and
 * the `through` descriptor so the loader and query builder can treat it as a
 * junction-mediated relation.
 *
 * Composite-key through paths are rejected value-free.
 * Polymorphic through paths are rejected value-free.
 */
function resolveThroughToRelation(
  entity: Function,
  propertyName: string,
  through: ThroughRelation,
): ResolvedRelation {
  // Find the target entity class by scanning registered TypeORM tables
  // and matching the class name (ThroughRelation.target stores the entity
  // class name, not the database table name).
  const storage = getMetadataArgsStorage();
  const targetTableArg = storage.tables.find(
    (t) => typeof t.target === 'function' && t.target.name === through.target,
  );
  const targetEntity: Function = (targetTableArg?.target as Function | undefined) ?? Object;
  const primaryColumns = resolvePrimaryColumns(targetEntity);

  // Reject composite-key through paths — the loader uses single-PK correlation.
  if (primaryColumns.length !== 1) {
    throw new RelationError('Composite-key through relations are not yet supported');
  }

  // Reject through paths that involve polymorphic relations.
  // Scan for a polymorphic descriptor on the through entity.
  const throughTableArg = storage.tables.find(
    (t) => typeof t.target === 'function' && t.target.name === through.through,
  );
  if (throughTableArg && typeof throughTableArg.target === 'function') {
    const polyDesc = resolvePolymorphicDescriptor(throughTableArg.target);
    if (polyDesc) {
      throw new RelationError('Polymorphic through relations are not supported');
    }
  }

  return {
    propertyName,
    kind: 'one-to-many',
    targetEntity,
    primaryColumns,
    through,
    // The "inverse join column" is the sourceKey on the through entity —
    // it's the FK on through that references the source's PK. For loading
    // we use through.sourceKey directly, but inverseJoinColumn lets
    // existing O2M code paths recognize the FK side.
    inverseJoinColumn: through.sourceKey,
  };
}

/** Find a join-column arg for the given entity and property. */
function findJoinColumn(entity: Function, propertyName: string): string | undefined {
  const storage = getMetadataArgsStorage();
  const joinCol = storage.joinColumns.find(
    (jc) => jc.target === entity && jc.propertyName === propertyName,
  );
  return joinCol?.name;
}

/**
 * Find the join-table arg for a M2M owning side.
 */
function findJoinTable(entity: Function, propertyName: string) {
  const storage = getMetadataArgsStorage();
  return storage.joinTables.find((jt) => jt.target === entity && jt.propertyName === propertyName);
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

function resolveSingle(entity: Function, propertyName: string): ResolvedRelation {
  const storage = getMetadataArgsStorage();

  // 1. Check polymorphic first — it does not produce a TypeORM relation arg.
  const polyDesc = resolvePolymorphicDescriptor(entity);
  if (polyDesc && polyDesc.propertyName === propertyName) {
    // For polymorphic, there is no single target entity; primaryColumns is
    // computed from the first target class (callers that need to query
    // polymorphic relations resolve the target at runtime via the descriptor).
    const firstTarget = polyDesc.targetClasses[0];
    const primary = firstTarget ? resolvePrimaryColumns(firstTarget) : [];
    return {
      propertyName,
      kind: 'polymorphic',
      targetEntity: firstTarget ?? Function,
      polymorphic: polyDesc,
      primaryColumns: primary,
    };
  }

  // 2. Find the TypeORM relation arg.
  const relationArg = storage.relations.find(
    (r) => r.target === entity && r.propertyName === propertyName,
  );

  if (!relationArg) {
    // 3. Fall back to through-relation resolution. A "has_many :through"
    // property has no direct TypeORM relation arg — it is resolved by
    // chaining an O2M/M2M on the source through a M2O on the intermediate
    // entity to the final target.
    const through = resolveThroughRelation(entity, propertyName);
    if (through) {
      return resolveThroughToRelation(entity, propertyName, through);
    }
    throw new RelationError('No relation or polymorphic descriptor found for the property');
  }

  const targetEntity = resolveType(relationArg.type);
  const primaryColumns = resolvePrimaryColumns(targetEntity);

  switch (relationArg.relationType) {
    case 'many-to-one': {
      const joinColumn = findJoinColumn(entity, propertyName);
      return {
        propertyName,
        kind: 'many-to-one',
        targetEntity,
        joinColumn,
        primaryColumns,
      };
    }

    case 'one-to-many': {
      // The inverse side is a M2O relation on targetEntity whose type
      // resolves back to `entity`. We find it and read its join column.
      const inverseM2O = storage.relations.find(
        (r) =>
          r.target === targetEntity &&
          r.relationType === 'many-to-one' &&
          resolveType(r.type) === entity,
      );
      if (!inverseM2O) {
        throw new RelationError(
          'One-to-many relation must have a matching many-to-one on the target',
        );
      }
      const inverseJoinColumn = findJoinColumn(targetEntity, inverseM2O.propertyName);
      return {
        propertyName,
        kind: 'one-to-many',
        targetEntity,
        inverseJoinColumn,
        primaryColumns,
      };
    }

    case 'one-to-one': {
      const joinTable = findJoinTable(entity, propertyName);
      // One-to-one via explicit join table is currently unsupported through
      // this path (TypeORM does not use @JoinTable on O2O).
      if (joinTable) {
        throw new RelationError('One-to-one with a join table is not supported');
      }

      // Ownership is determined by the presence of a @JoinColumn on this
      // entity. An owning O2O has a @JoinColumn; an inverse does not.
      const ownJoinColumn = findJoinColumn(entity, propertyName);
      if (ownJoinColumn) {
        return {
          propertyName,
          kind: 'one-to-one',
          targetEntity,
          joinColumn: ownJoinColumn,
          primaryColumns,
        };
      }

      // Inverse side: find the owning one-to-one on targetEntity whose type
      // resolves back to `entity`.
      const owningO2O = storage.relations.find(
        (r) =>
          r.target === targetEntity &&
          r.relationType === 'one-to-one' &&
          resolveType(r.type) === entity,
      );
      if (!owningO2O) {
        throw new RelationError(
          'One-to-one inverse relation does not have a matching owning relation',
        );
      }
      const inverseJoinColumn = findJoinColumn(targetEntity, owningO2O.propertyName) ?? undefined;
      // For the inverse side, the "join" column lives on the owning (target) entity.
      return {
        propertyName,
        kind: 'one-to-one',
        targetEntity,
        joinColumn: inverseJoinColumn,
        primaryColumns,
      };
    }

    case 'many-to-many': {
      // Ownership is determined by the presence of a @JoinTable on this entity.
      const ownJoinTable = findJoinTable(entity, propertyName);
      if (ownJoinTable) {
        // joinColumns reference the owning entity; inverseJoinColumns reference
        // the inverse entity.
        const ownerCol = ownJoinTable.joinColumns?.[0]?.name;
        const inverseCol = ownJoinTable.inverseJoinColumns?.[0]?.name;
        if (!ownerCol || !inverseCol) {
          throw new RelationError('Many-to-many join table is missing join-column definitions');
        }
        const tableName = ownJoinTable.name;
        if (!tableName) {
          throw new RelationError('Many-to-many join table must have a name');
        }
        return {
          propertyName,
          kind: 'many-to-many',
          targetEntity,
          junction: {
            table: tableName,
            ownerColumn: ownerCol,
            inverseColumn: inverseCol,
          },
          primaryColumns,
        };
      }

      // Inverse side: find the join table via the owning relation on the
      // target entity — the relation of type 'many-to-many' on targetEntity
      // whose own type callback resolves back to `entity`.
      const owningRelation = storage.relations.find(
        (r) =>
          r.target === targetEntity &&
          r.relationType === 'many-to-many' &&
          resolveType(r.type) === entity,
      );
      if (!owningRelation) {
        throw new RelationError('Many-to-many inverse side must reference an owning relation');
      }
      const owningJoinTable = findJoinTable(targetEntity, owningRelation.propertyName);
      if (!owningJoinTable) {
        throw new RelationError(
          'Many-to-many inverse side must reference a relation with a join table',
        );
      }
      const invOwnerCol = owningJoinTable.inverseJoinColumns?.[0]?.name;
      const invInverseCol = owningJoinTable.joinColumns?.[0]?.name;
      if (!invOwnerCol || !invInverseCol) {
        throw new RelationError(
          'Many-to-many join table on the inverse side is missing join-column definitions',
        );
      }
      const invTableName = owningJoinTable.name;
      if (!invTableName) {
        throw new RelationError('Many-to-many join table must have a name');
      }
      return {
        propertyName,
        kind: 'many-to-many',
        targetEntity,
        junction: {
          table: invTableName,
          ownerColumn: invOwnerCol,
          inverseColumn: invInverseCol,
        },
        primaryColumns,
      };
    }

    default:
      throw new RelationError('Unsupported relation type');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a single relation property on an entity class.
 *
 * @param entity  The entity class (e.g. `Post`).
 * @param path    A single relation property name (e.g. `"author"`).
 */
export function resolveRelation(entity: Function, path: string): ResolvedRelation {
  return resolveSingle(entity, path);
}

/**
 * Resolve a dotted relation path (e.g. `"author.profile.city"`) into an ordered
 * list of {@link ResolvedRelation} descriptors, one per hop. Each intermediate
 * segment must resolve to a relation; the depth is bounded at
 * {@link MAX_NESTING_DEPTH}.
 */
export function resolveRelationPath(entity: Function, path: string): ResolvedRelation[] {
  const segments = path.split('.');
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    throw new RelationError('A relation path must not be empty');
  }
  if (segments.length > MAX_NESTING_DEPTH) {
    throw new RelationError('A relation path exceeds the maximum nesting depth');
  }

  const results: ResolvedRelation[] = [];
  let currentEntity: Function = entity;

  for (const segment of segments) {
    const resolved = resolveSingle(currentEntity, segment);
    results.push(resolved);
    // The next entity is the target of the current hop.
    currentEntity = resolved.targetEntity;
  }

  return results;
}
