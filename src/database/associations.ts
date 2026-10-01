/**
 * Declarative model relation DSL — Rails-style `has_many`, `belongs_to`,
 * `has_one`, and `accepts_nested_attributes_for` as pure function factories.
 *
 * Each function returns a {@link EntityHooksDefinition} array that composes
 * with the existing hook-bridge seam:
 *
 * ```ts
 * import { has_many, belongs_to } from 'jsails';
 *
 * const hooks = [
 *   ...has_many(Post, 'comments', { counter_cache: true }),
 *   ...belongs_to(Comment, 'post', { touch: true }),
 * ];
 * const ds = new JsailsDataSource({
 *   entities: [Post, Comment],
 *   subscribers: [createEntitySubscriber(...hooks)],
 * });
 * ```
 *
 * Every function resolves metadata connectionlessly via TypeORM's global
 * `getMetadataArgsStorage()` and {@link resolveRelation} — no connection is
 * opened. Errors are value-free {@link AssociationError}s.
 */

import { EntitySchema, getMetadataArgsStorage } from 'typeorm';
import type { EntityTarget, ObjectLiteral } from 'typeorm';
import type { RelationTypeInFunction } from 'typeorm/metadata/types/RelationTypeInFunction.js';

import { counterCache, nestedAttributes, touch } from './counter-cache.js';
import { defineEntityHooks, type EntityHooksDefinition } from './entity-subscribers.js';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Raised for invalid association declarations. Value-free. */
export class AssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssociationError';
  }
}

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface BelongsToOptions {
  /** Touch the referenced parent entity when this entity saves. */
  readonly touch?: boolean;
  /**
   * Behaviour when this entity is destroyed: `'destroy'` the parent,
   * or `'nullify'` (no-op — the FK is on the destroyed record).
   */
  readonly dependent?: 'destroy' | 'nullify';
  /** Explicit name of the inverse relation on the parent entity. */
  readonly inverse?: string;
}

export interface HasManyOptions {
  /** Explicit name of the child's many-to-one property that references back. */
  readonly inverse?: string;
  /**
   * Maintain a counter cache on the parent. `true` uses `<name>_count`;
   * a string value names the column explicitly.
   */
  readonly counter_cache?: boolean | string;
  /** Touch the parent's `updated_at` when a child is inserted, updated, or deleted. */
  readonly touch?: boolean;
  /** Behaviour when the parent is destroyed: destroy or nullify children. */
  readonly dependent?: 'destroy' | 'nullify';
  /** Name of a through relation for has_many :through. */
  readonly through?: string;
}

export interface HasOneOptions {
  /** Explicit name of the child's relation property that references back. */
  readonly inverse?: string;
  /** Touch the child entity when the parent saves. */
  readonly touch?: boolean;
  /** Behaviour when the parent is destroyed. */
  readonly dependent?: 'destroy' | 'nullify';
  /** Name of a through relation for has_one :through. */
  readonly through?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Safe entity name from a metadata target (string name or Function constructor name). */
function targetNameOf(target: Function | string): string {
  return typeof target === 'function' ? target.name : target;
}

/**
 * Resolve a TypeORM relation type callback to the actual entity constructor.
 * Mirrors `resolveType` in `relation-metadata.ts` (private).
 */
function resolveEntityType(typeValue: RelationTypeInFunction): Function {
  if (typeof typeValue === 'object' && typeValue !== null && 'type' in typeValue) {
    const schemaType = (typeValue as { type: Function }).type;
    if (typeof schemaType !== 'function') {
      throw new AssociationError('A relation type must reference an entity class');
    }
    return schemaType;
  }
  if (typeof typeValue === 'function') {
    const resolved = (typeValue as Function)();
    if (typeof resolved !== 'function') {
      throw new AssociationError('A relation type callback must return an entity class');
    }
    return resolved;
  }
  // String-based references (e.g. @OneToMany('Comment', ...)) — resolve by
  // scanning registered entity tables for a matching class name. Returns the
  // LAST match so the most recently registered entity wins (the global
  // `getMetadataArgsStorage()` accumulates across multiple function-local
  // class definitions in tests).
  if (typeof typeValue === 'string') {
    const tables = getMetadataArgsStorage().tables;
    for (let i = tables.length - 1; i >= 0; i--) {
      const t = tables[i]!;
      if (typeof t.target === 'function' && t.target.name === typeValue) {
        return t.target;
      }
    }
    throw new AssociationError('A string relation type must reference a registered entity class');
  }
  throw new AssociationError('Unsupported relation type value');
}

/** Check whether a TypeORM type callback resolves to the given entity constructor.
 *  Compares by class name, not identity, because the global `getMetadataArgsStorage()`
 *  accumulates entries across multiple function-local class definitions. */
function relationTypeResolvesTo(typeValue: RelationTypeInFunction, entity: Function): boolean {
  try {
    return resolveEntityType(typeValue).name === entity.name;
  } catch {
    return false;
  }
}

/**
 * Extract the constructor from an `EntityTarget` so `resolveRelation` and
 * `getMetadataArgsStorage()` can match by function identity.
 */
function entityConstructor(entity: EntityTarget<unknown>, label: string): Function {
  if (typeof entity === 'function') return entity;
  if (typeof entity === 'string') {
    throw new AssociationError(
      `${label}: string-named entities are not supported — pass the entity class or EntitySchema`,
    );
  }
  if (entity instanceof EntitySchema) {
    const target = entity.options.target;
    if (typeof target === 'function') return target;
    throw new AssociationError(`${label}: EntitySchema must have a target class`);
  }
  throw new AssociationError(`${label}: invalid entity target`);
}

/**
 * Find a relation property on `entity` by scanning the metadata storage.
 * Returns the property name, or `null`. Prefers many-to-one, then owning
 * one-to-one (has @JoinColumn).
 */
function findChildFkProperty(child: Function, parent: Function): string | null {
  const storage = getMetadataArgsStorage();
  const childName = child.name;

  for (const r of storage.relations) {
    if (
      targetNameOf(r.target) === childName &&
      r.relationType === 'many-to-one' &&
      relationTypeResolvesTo(r.type, parent)
    ) {
      return r.propertyName;
    }
  }

  for (const r of storage.relations) {
    if (
      targetNameOf(r.target) === childName &&
      r.relationType === 'one-to-one' &&
      relationTypeResolvesTo(r.type, parent)
    ) {
      const jc = storage.joinColumns.find(
        (j) => targetNameOf(j.target) === childName && j.propertyName === r.propertyName,
      );
      if (jc) return r.propertyName;
    }
  }

  return null;
}

/**
 * Resolve the child entity constructor and its FK property name that
 * references back to the parent.
 *
 * When `inverse` is given it is used directly (after validation). Otherwise
 * the child's many-to-one relations are scanned for a match.
 */
function resolveChildInverse(
  parentFn: Function,
  parentRelationName: string,
  childEntity: Function,
  inverse?: string,
): string {
  if (inverse !== undefined) {
    const childName = childEntity.name;
    const r = getMetadataArgsStorage().relations.find(
      (rel) =>
        targetNameOf(rel.target) === childName &&
        rel.propertyName === inverse &&
        rel.relationType === 'many-to-one' &&
        relationTypeResolvesTo(rel.type, parentFn),
    );
    if (!r) {
      throw new AssociationError(
        `inverse "${inverse}" is not a many-to-one on the child entity that references the parent`,
      );
    }
    return inverse;
  }

  const found = findChildFkProperty(childEntity, parentFn);
  if (!found) {
    throw new AssociationError(
      `cannot auto-detect the inverse many-to-one on the child entity for relation "${parentRelationName}" — provide an explicit "inverse" option`,
    );
  }
  return found;
}

/**
 * Resolve the child entity and its FK property for a `has_one` relation.
 * The child is the target entity of the relation; the FK property on the child
 * references back to the parent. For a `has_one` this is typically an owning
 * one-to-one (@JoinColumn) or a many-to-one.
 */
function resolveHasOneInverse(
  parentFn: Function,
  parentRelationName: string,
  childEntity: Function,
  inverse?: string,
): string {
  if (inverse !== undefined) {
    const childName = childEntity.name;
    const childRel = getMetadataArgsStorage().relations.find(
      (r) =>
        targetNameOf(r.target) === childName &&
        r.propertyName === inverse &&
        relationTypeResolvesTo(r.type, parentFn),
    );
    if (!childRel) {
      throw new AssociationError(
        `inverse "${inverse}" does not reference back to the parent entity`,
      );
    }
    // Verify the relation has a join column (is owning)
    const jc = getMetadataArgsStorage().joinColumns.find(
      (j) => targetNameOf(j.target) === childName && j.propertyName === childRel.propertyName,
    );
    if (!jc) {
      throw new AssociationError(
        `inverse "${inverse}" must be an owning relation (has @JoinColumn)`,
      );
    }
    return inverse;
  }

  const found = findChildFkProperty(childEntity, parentFn);
  if (!found) {
    throw new AssociationError(
      `cannot auto-detect the inverse on the child entity for relation "${parentRelationName}" — provide an explicit "inverse" option`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Dependent hooks (destroy / nullify)
// ---------------------------------------------------------------------------

/**
 * Reload an entity by id with one eager-loaded relation via query builder.
 * Avoids {@link EntityManager.findOne} generics which require per-entity
 * `FindOptionsRelations` shapes that cannot be built dynamically.
 */
async function reloadWithRelation(
  manager: import('typeorm').EntityManager,
  entity: Function,
  id: number,
  relation: string,
): Promise<Record<string, unknown> | null> {
  const row = await manager
    .createQueryBuilder(entity, 'e')
    .leftJoinAndSelect(`e.${relation}`, relation)
    .where('e.id = :id', { id })
    .getOne();
  return row ?? null;
}

/**
 * Scan the metadata storage for a relation on `entity` named `propertyName`.
 * Returns the relation arg with its target entity resolved to a constructor.
 */
function findRelationArg(
  entity: Function,
  propertyName: string,
): {
  relationType: 'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';
  targetEntity: Function;
} {
  const storage = getMetadataArgsStorage();
  const relationArg = storage.relations.find(
    (r) => (r.target as Function).name === entity.name && r.propertyName === propertyName,
  );
  if (!relationArg) {
    throw new AssociationError(`relation "${propertyName}" not found on the entity`);
  }
  const relationType = relationArg.relationType;
  const targetEntity = resolveEntityType(relationArg.type);
  return { relationType, targetEntity };
}

// ---------------------------------------------------------------------------
// Dependent hooks (destroy / nullify)
// ---------------------------------------------------------------------------

function buildDependentDestroyHook(
  parentEntity: EntityTarget<ObjectLiteral>,
  parentFn: Function,
  parentRelationName: string,
  childEntity: Function,
  _childFkProp: string,
): EntityHooksDefinition<ObjectLiteral> {
  return defineEntityHooks(parentEntity, {
    beforeDelete: async (ctx) => {
      const parent = ctx.entity as Record<string, unknown>;
      const parentId = parent['id'];
      if (parentId === undefined || parentId === null) return;

      // Load children through the relation so we get the full entity objects.
      const loaded = await reloadWithRelation(
        ctx.manager,
        parentFn,
        parentId as number,
        parentRelationName,
      );
      const children = (loaded?.[parentRelationName] ?? []) as ObjectLiteral[];

      for (const child of children) {
        await ctx.manager.remove(childEntity, child);
      }
    },
  });
}

function buildDependentNullifyHook(
  parentEntity: EntityTarget<ObjectLiteral>,
  parentFn: Function,
  parentRelationName: string,
  childEntity: Function,
  childFkProp: string,
): EntityHooksDefinition<ObjectLiteral> {
  return defineEntityHooks(parentEntity, {
    beforeDelete: async (ctx) => {
      const parent = ctx.entity as Record<string, unknown>;
      const parentId = parent['id'];
      if (parentId === undefined || parentId === null) return;

      const loaded = await reloadWithRelation(
        ctx.manager,
        parentFn,
        parentId as number,
        parentRelationName,
      );
      const children = (loaded?.[parentRelationName] ?? []) as Record<string, unknown>[];

      for (const child of children) {
        // Set the FK to null on the loaded entity and re-save. The children
        // were loaded with the parent relation hydrated, so TypeORM detects
        // the change from a Post object to null and generates the FK UPDATE.
        child[childFkProp] = null;
        await ctx.manager.save(childEntity, child);
      }
    },
  });
}

function buildBelongsToDependentDestroyHook(
  entity: EntityTarget<ObjectLiteral>,
  parentRelationName: string,
): EntityHooksDefinition<ObjectLiteral> {
  return defineEntityHooks(entity, {
    beforeDelete: async (ctx) => {
      const self = ctx.entity as Record<string, unknown>;
      const parent = self[parentRelationName] as ObjectLiteral | null | undefined;
      if (parent !== null && parent !== undefined && typeof parent === 'object') {
        await ctx.manager.remove(parent as Function, parent);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// has_one touch hook (parent saves → touch the child / referenced entity)
// ---------------------------------------------------------------------------

function buildHasOneTouchHook(
  parentEntity: EntityTarget<ObjectLiteral>,
  parentFn: Function,
  parentRelationName: string,
  childEntity: Function,
  inverse?: string,
): EntityHooksDefinition<ObjectLiteral> {
  // The child is the OWNING side of the one-to-one (the FK lives on it). We
  // touch by looking the child up through its FK column to the parent — never
  // by joining the parent's inverse relation, which has no join columns.
  const fkProperty = resolveHasOneInverse(parentFn, parentRelationName, childEntity, inverse);

  async function touchRelated(ctx: {
    readonly entity: ObjectLiteral;
    readonly manager: import('typeorm').EntityManager;
  }): Promise<void> {
    const parent = ctx.entity as Record<string, unknown>;
    // The related child is either already loaded on the parent (the common
    // insert case, where `parent.profile` is set) or must be looked up by FK.
    const loaded = parent[parentRelationName] as Record<string, unknown> | null | undefined;
    const child =
      loaded !== null &&
      loaded !== undefined &&
      typeof loaded === 'object' &&
      loaded['id'] !== undefined
        ? loaded
        : await (async () => {
            const parentId = parent['id'];
            if (parentId === undefined || parentId === null) return null;
            return ctx.manager.findOne(childEntity, {
              where: { [fkProperty]: { id: parentId } },
            });
          })();

    if (child === null || child === undefined) return;

    await ctx.manager.update(
      childEntity,
      { id: child['id'] as number },
      { updated_at: new Date() },
    );
  }

  return defineEntityHooks(parentEntity, {
    afterInsert: touchRelated,
    afterUpdate: touchRelated,
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateOptionsDependent(dependent: unknown): asserts dependent is 'destroy' | 'nullify' {
  if (dependent !== 'destroy' && dependent !== 'nullify') {
    throw new AssociationError('dependent must be "destroy" or "nullify"');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Declare a many-to-one relation on the given entity.
 *
 * The entity must already declare the relation through a TypeORM decorator
 * (`@ManyToOne`). This function bridges lifecycle behaviour via the existing
 * hook subscribers:
 *
 * - `touch: true` → wires {@link touch} so the referenced parent's `updated_at`
 *   is set when this entity is inserted, updated, or deleted.
 * - `dependent: 'destroy'` → destroys the referenced parent when this entity
 *   is deleted.
 *
 * @returns An array of hook definitions to pass to {@link createEntitySubscriber}.
 */
export function belongs_to<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  name: string,
  options?: BelongsToOptions,
): readonly EntityHooksDefinition<ObjectLiteral>[] {
  const result: EntityHooksDefinition<ObjectLiteral>[] = [];
  const parentFn = entityConstructor(entity, 'belongs_to');

  // Validate the relation exists and is a many-to-one.
  const { relationType } = findRelationArg(parentFn, name);
  if (relationType !== 'many-to-one') {
    throw new AssociationError('belongs_to: relation must be a many-to-one');
  }

  if (options?.touch) {
    result.push(touch(entity, { relation: name, column: 'updated_at' }));
  }

  if (options?.dependent !== undefined) {
    validateOptionsDependent(options.dependent);
    if (options.dependent === 'destroy') {
      result.push(buildBelongsToDependentDestroyHook(entity, name));
    }
    // nullify is a no-op: the FK is on the destroyed entity.
  }

  return result;
}

/**
 * Declare a one-to-many relation on the given entity.
 *
 * The entity must already declare the relation through a TypeORM decorator
 * (`@OneToMany`). The child's many-to-one property is auto-detected or
 * supplied via `options.inverse`.
 *
 * @param options.counter_cache — `true` uses `<name>_count`; a string names the column.
 * @param options.touch — touch the parent's `updated_at` when a child changes.
 * @param options.dependent — `'destroy'` or `'nullify'` children when the parent is removed.
 *
 * @returns An array of hook definitions to pass to {@link createEntitySubscriber}.
 */
export function has_many<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  name: string,
  options?: HasManyOptions,
): readonly EntityHooksDefinition<ObjectLiteral>[] {
  const result: EntityHooksDefinition<ObjectLiteral>[] = [];
  const parentFn = entityConstructor(entity, 'has_many');

  // Resolve the parent-side relation metadata.
  const { relationType, targetEntity: childEntity } = findRelationArg(parentFn, name);
  if (relationType !== 'one-to-many') {
    throw new AssociationError('has_many: relation must be a one-to-many');
  }

  const childFkProp = resolveChildInverse(parentFn, name, childEntity, options?.inverse);

  // counter_cache
  if (options?.counter_cache !== undefined) {
    if (typeof options.counter_cache !== 'boolean' && typeof options.counter_cache !== 'string') {
      throw new AssociationError(
        'has_many: counter_cache must be a boolean or a string column name',
      );
    }
    const column =
      typeof options.counter_cache === 'string' ? options.counter_cache : `${name}_count`;

    result.push(
      counterCache(childEntity as EntityTarget<ObjectLiteral>, {
        relation: childFkProp,
        column,
        incrementOn: 'afterInsert',
      }),
    );
    result.push(
      counterCache(childEntity as EntityTarget<ObjectLiteral>, {
        relation: childFkProp,
        column,
        incrementOn: 'afterDelete',
      }),
    );
  }

  // touch
  if (options?.touch) {
    result.push(
      touch(childEntity as EntityTarget<ObjectLiteral>, {
        relation: childFkProp,
        column: 'updated_at',
      }),
    );
  }

  // dependent
  if (options?.dependent !== undefined) {
    validateOptionsDependent(options.dependent);
    const buildHook =
      options.dependent === 'destroy' ? buildDependentDestroyHook : buildDependentNullifyHook;
    result.push(buildHook(entity, parentFn, name, childEntity, childFkProp));
  }

  // through — validate it exists (resolved lazily at query time, but the name must be valid)
  if (options?.through !== undefined) {
    findRelationArg(parentFn, options.through); // validates it exists
  }

  return result;
}

/**
 * Declare a one-to-one relation on the given entity.
 *
 * The entity must already declare the relation through a TypeORM decorator
 * (`@OneToOne`).
 *
 * @param options.touch — touch the child entity when the parent saves.
 * @param options.dependent — `'destroy'` or `'nullify'` the child when the parent is removed.
 *
 * @returns An array of hook definitions to pass to {@link createEntitySubscriber}.
 */
export function has_one<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  name: string,
  options?: HasOneOptions,
): readonly EntityHooksDefinition<ObjectLiteral>[] {
  const result: EntityHooksDefinition<ObjectLiteral>[] = [];
  const parentFn = entityConstructor(entity, 'has_one');

  const { relationType, targetEntity: childEntity } = findRelationArg(parentFn, name);
  if (relationType !== 'one-to-one') {
    throw new AssociationError('has_one: relation must be a one-to-one');
  }

  // touch — fires on the parent and touches the child entity.
  if (options?.touch) {
    result.push(buildHasOneTouchHook(entity, parentFn, name, childEntity, options?.inverse));
  }

  // dependent — fires on the parent's beforeDelete.
  if (options?.dependent !== undefined) {
    validateOptionsDependent(options.dependent);
    const childFkProp = resolveHasOneInverse(parentFn, name, childEntity, options?.inverse);
    const buildHook =
      options.dependent === 'destroy' ? buildDependentDestroyHook : buildDependentNullifyHook;
    result.push(buildHook(entity, parentFn, name, childEntity, childFkProp));
  }

  // through
  if (options?.through !== undefined) {
    findRelationArg(parentFn, options.through); // validates it exists
  }

  return result;
}

/**
 * Wire nested-attribute persistence for a relation.
 *
 * Calls {@link nestedAttributes} so child entities are persisted when the
 * parent saves, with field whitelisting.
 *
 * @returns A single-element hook-definition array.
 */
export function accepts_nested_attributes_for<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  name: string,
  options?: { readonly fields?: readonly string[] },
): readonly EntityHooksDefinition<ObjectLiteral>[] {
  const fields = options?.fields ?? [];

  if (fields.length === 0) {
    throw new AssociationError('accepts_nested_attributes_for: "fields" must be a non-empty array');
  }

  // Validate that the relation exists.
  const parentFn = entityConstructor(entity, 'accepts_nested_attributes_for');
  findRelationArg(parentFn, name); // throws if not found

  return [nestedAttributes(entity, { relation: name, fields })];
}
