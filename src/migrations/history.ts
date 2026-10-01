/**
 * Migration history model and replay.
 *
 * The MVP supports exactly one connected, linear chain of migrations: a single
 * root (no dependencies), every other migration depending on exactly one
 * predecessor, and no branching or merge nodes. Multiple heads, branches, and
 * DAGs are rejected rather than half-supported.
 */

import {
  MigrationError,
  type SchemaState,
  emptySchema,
  normalizeSchemaState,
  validateIdentifier,
} from './schema-state.js';
import { type Operation, applyOperations, validateOperation } from './operations.js';

export interface MigrationDefinition {
  /** Unique migration name, also used as a dependency reference. */
  name: string;
  /** Names of migrations that must be applied before this one. */
  dependencies: string[];
  operations: Operation[];
}

export type MigrationHistory = MigrationDefinition[];

function normalizeMigration(migration: unknown): MigrationDefinition {
  if (typeof migration !== 'object' || migration === null) {
    throw new MigrationError('migration must be an object');
  }
  const m = migration as Record<string, unknown>;
  const name = validateIdentifier(m.name);
  if (!Array.isArray(m.dependencies)) {
    throw new MigrationError(`migration "${name}" "dependencies" must be an array`);
  }
  const dependencies = m.dependencies.map((dep) => validateIdentifier(dep));
  if (!Array.isArray(m.operations)) {
    throw new MigrationError(`migration "${name}" "operations" must be an array`);
  }
  const operations = m.operations.map((op) => validateOperation(op));
  return { name, dependencies, operations };
}

/**
 * Validate a migration history and return it in deterministic linear order.
 *
 * Rejects: duplicate names, self/unknown dependencies, cycles, more than one
 * root, branching (a migration with multiple dependents), and merge nodes
 * (a migration with multiple dependencies).
 */
export function resolveMigrationOrder(history: MigrationHistory): MigrationDefinition[] {
  if (!Array.isArray(history)) {
    throw new MigrationError('migration history must be an array');
  }

  const migrations = history.map((migration) => normalizeMigration(migration));
  if (migrations.length === 0) {
    return [];
  }
  const byName = new Map<string, MigrationDefinition>();

  for (const migration of migrations) {
    if (byName.has(migration.name)) {
      throw new MigrationError(`duplicate migration name "${migration.name}"`);
    }
    byName.set(migration.name, migration);
  }

  // Dependency validation: unknown or self-references.
  for (const migration of migrations) {
    for (const dep of migration.dependencies) {
      if (dep === migration.name) {
        throw new MigrationError(`migration "${migration.name}" cannot depend on itself`);
      }
      if (!byName.has(dep)) {
        throw new MigrationError(
          `migration "${migration.name}" depends on unknown migration "${dep}"`,
        );
      }
    }
  }

  // Linear chain constraints: one root, single dependency per node, no merges,
  // no branching.
  const roots = migrations.filter((migration) => migration.dependencies.length === 0);
  if (roots.length === 0) {
    throw new MigrationError(
      'migration history has no root (every migration depends on another, implying a cycle)',
    );
  }
  if (roots.length > 1) {
    throw new MigrationError(
      'migration history has multiple roots; only a single linear chain is supported',
    );
  }

  const children = new Map<string, string>();
  for (const migration of migrations) {
    if (migration.dependencies.length === 0) {
      continue;
    }
    if (migration.dependencies.length > 1) {
      throw new MigrationError(
        `migration "${migration.name}" has multiple dependencies; merge nodes are not supported`,
      );
    }
    const parent = migration.dependencies[0] as string;
    if (children.has(parent)) {
      throw new MigrationError(
        `migration "${parent}" has multiple dependents; branching is not supported`,
      );
    }
    children.set(parent, migration.name);
  }

  // Walk the single chain from the root. A stop short of the full set means a
  // cycle (which is otherwise impossible given the constraints above).
  const ordered: MigrationDefinition[] = [];
  const visited = new Set<string>();
  let current: MigrationDefinition | undefined = roots[0];
  while (current) {
    if (visited.has(current.name)) {
      throw new MigrationError('migration history contains a cycle');
    }
    visited.add(current.name);
    ordered.push(current);
    const next = children.get(current.name);
    current = next ? byName.get(next) : undefined;
  }
  if (ordered.length !== migrations.length) {
    throw new MigrationError('migration history contains a cycle or disconnected migrations');
  }

  return ordered;
}

/**
 * Replay an already-ordered history (as returned by {@link resolveMigrationOrder})
 * onto the empty schema. Operations are applied with full precondition checks.
 */
export function replayOrderedHistory(ordered: MigrationHistory): SchemaState {
  let state = emptySchema();
  for (const migration of ordered) {
    state = applyOperations(state, migration.operations);
  }
  return normalizeSchemaState(state);
}

/**
 * Validate, order, and replay a migration history, returning the resulting
 * canonical schema state. This is the single entry point for materializing a
 * schema from a history of migrations.
 */
export function replayMigrationHistory(history: MigrationHistory): SchemaState {
  return replayOrderedHistory(resolveMigrationOrder(history));
}
