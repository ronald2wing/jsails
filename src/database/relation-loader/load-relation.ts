/**
 * Batch relation loader public API and orchestrator.
 *
 * Dispatches to per-kind loaders in {@link ./loaders.js}, resolves relation
 * metadata through {@link resolveRelation}, and recurses into nested paths
 * level-by-level via IN-clause batching.
 */

import {
  type ResolvedRelation,
  MAX_NESTING_DEPTH,
  RelationError,
  resolveRelation,
} from '../relation-metadata.js';
import { resolvePolymorphicDescriptor } from '../polymorphic.js';
import type { RelationLoadOptions, LoadRelationsOptions } from './types.js';
import {
  hasJoinColumnOnEntity,
  hasPolymorphicInverseProperty,
  tryResolvePolymorphicInverse,
} from './helpers.js';
import {
  loadManyToOne,
  loadManyToMany,
  loadOneToMany,
  loadOneToOneInverse,
  loadPolymorphicForward,
  loadPolymorphicInverseBatched,
  loadThroughRelation,
} from './loaders.js';

// Re-export so callers can catch load-time errors from a single import.
export { RelationError } from '../relation-metadata.js';

// ---------------------------------------------------------------------------
// Single-parent convenience
// ---------------------------------------------------------------------------

export async function loadRelation<T extends object>(
  parent: T,
  options: LoadRelationsOptions,
): Promise<T> {
  const results = await loadRelations([parent], options);
  return results[0]!;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function loadRelations<T extends object>(
  parents: readonly T[],
  options: LoadRelationsOptions,
): Promise<T[]> {
  return loadRelationsRecursive(parents, options, 0);
}

// ---------------------------------------------------------------------------
// Recursive orchestrator
// ---------------------------------------------------------------------------

/**
 * Recursive implementation that tracks nesting depth so we never exceed
 * {@link MAX_NESTING_DEPTH} across `with`-driven levels.
 */
async function loadRelationsRecursive<T extends object>(
  parents: readonly T[],
  options: LoadRelationsOptions,
  depth: number,
): Promise<T[]> {
  if (parents.length === 0) {
    return parents as T[];
  }

  if (depth >= MAX_NESTING_DEPTH) {
    throw new RelationError('A relation path exceeds the maximum nesting depth');
  }

  const entityClass = parents[0]!.constructor;
  const strategy = options.strategy ?? 'batch';

  if (strategy === 'join') {
    throw new RelationError('Join strategy is not yet supported');
  }

  for (const [propertyName, loadSpec] of Object.entries(options.with)) {
    if (!loadSpec) continue;

    const relationOpts: RelationLoadOptions = typeof loadSpec === 'object' ? loadSpec : {};

    // Resolve the relation. For polymorphic inverse (e.g. Post.comments),
    // resolveRelation fails because the parent has no @PolymorphicRelation
    // decorator — the descriptor lives on the child. Fall back to scanning
    // all registered entities for a matching polymorphic descriptor.
    let relation: ResolvedRelation;
    try {
      relation = resolveRelation(entityClass, propertyName);
    } catch (e) {
      if (e instanceof RelationError) {
        // resolveRelation failed — try polymorphic inverse. This handles two
        // distinct cases:
        // 1. A child entity's polymorphic descriptor targets this parent's
        //    table with the matching relatedName → load normally.
        // 2. A descriptor exists with this relatedName but does NOT target
        //    this parent → assign empty arrays (plausible inverse, no match).
        // 3. No descriptor anywhere uses this relatedName → re-throw (the
        //    property genuinely does not exist).
        const inverse = tryResolvePolymorphicInverse(entityClass, propertyName);
        if (inverse) {
          relation = inverse;
        } else if (hasPolymorphicInverseProperty(propertyName)) {
          for (const parent of parents) {
            (parent as unknown as Record<string, unknown>)[propertyName] = [];
          }
          continue;
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    switch (relation.kind) {
      case 'many-to-one':
        await loadManyToOne(
          parents,
          entityClass,
          relation,
          relationOpts,
          options.maxRowsPerRelation,
        );
        break;

      case 'one-to-one': {
        const owning = hasJoinColumnOnEntity(entityClass, propertyName);
        if (owning) {
          await loadManyToOne(
            parents,
            entityClass,
            relation,
            relationOpts,
            options.maxRowsPerRelation,
          );
        } else {
          await loadOneToOneInverse(
            parents,
            entityClass,
            relation,
            relationOpts,
            options.maxRowsPerRelation,
          );
        }
        break;
      }

      case 'many-to-many':
        await loadManyToMany(
          parents,
          entityClass,
          relation,
          relationOpts,
          options.maxRowsPerRelation,
        );
        break;

      case 'one-to-many': {
        // A one-to-many carrying a `through` descriptor is a "has_many :through"
        // relation — load the final target entities through the intermediate entity.
        if (relation.through) {
          await loadThroughRelation(
            parents,
            entityClass,
            relation,
            relationOpts,
            options.maxRowsPerRelation,
          );
        } else {
          await loadOneToMany(
            parents,
            entityClass,
            relation,
            relationOpts,
            options.maxRowsPerRelation,
          );
        }
        break;
      }

      case 'polymorphic': {
        // Forward: the entity class itself carries the polymorphic descriptor
        // (e.g. Comment.target). Inverse: the descriptor was resolved via
        // tryResolvePolymorphicInverse and the owning entity is the child.
        const ownDescriptor = resolvePolymorphicDescriptor(entityClass);
        if (ownDescriptor && ownDescriptor.propertyName === propertyName) {
          await loadPolymorphicForward(
            parents,
            entityClass,
            relation,
            relationOpts,
            options.maxRowsPerRelation,
          );
        } else {
          await loadPolymorphicInverseBatched(
            parents,
            entityClass,
            relation,
            relationOpts,
            options.maxRowsPerRelation,
          );
        }
        break;
      }

      default:
        throw new RelationError('Relation kind is not yet supported by the batch loader');
    }

    // After loading the current level, recurse into nested relations using the
    // flattened set of newly-loaded children as the parent array. This keeps
    // one query per level, never per parent.
    if (relationOpts.with) {
      const children = collectLoadedChildren(
        parents as readonly Record<string, unknown>[],
        relation.propertyName,
      );
      if (children.length > 0) {
        await loadRelationsRecursive(children, { ...options, with: relationOpts.with }, depth + 1);
      }
    }
  }

  return parents as T[];
}

// ---------------------------------------------------------------------------
// Nested-loading helper
// ---------------------------------------------------------------------------

/**
 * Collect the set of loaded children from every parent so they can serve as
 * the parent array for the next level of nested relation loading. For O2M/M2M
 * the value is an array (flattened), for M2O/O2O a single object (or null).
 * Null/undefined values are skipped.
 */
function collectLoadedChildren(
  parents: readonly Record<string, unknown>[],
  propertyName: string,
): Record<string, unknown>[] {
  const children: Record<string, unknown>[] = [];
  for (const parent of parents) {
    const value = parent[propertyName];
    if (Array.isArray(value)) {
      for (const item of value) {
        children.push(item as Record<string, unknown>);
      }
    } else if (value != null && typeof value === 'object') {
      children.push(value as Record<string, unknown>);
    }
  }
  return children;
}
