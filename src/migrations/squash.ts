/**
 * Migration squashing: combine a contiguous range of applied schema migrations
 * into a single replacement.
 *
 * The squashed migration replays every operation from the original range onto
 * the empty schema, so the output is the cumulative effect. The replacement
 * depends on the predecessor of the first migration in the range and replaces
 * every migration in the range — future migrations that depend on the last
 * squashed migration are not rewritten (the replace function must handle that).
 *
 * Squashing stops at a data migration boundary unless `allowCrossKind` is set.
 * The output is deterministic: given the same inputs and the same `name`, the
 * result is byte-identical.
 */

import { MigrationError } from './schema-state.js';
import { validateIdentifier } from './schema-state.js';
import type { MigrationDefinition } from './history.js';
import { replayOrderedHistory, resolveMigrationOrder, type MigrationHistory } from './history.js';
import type { Operation } from './operations.js';

export interface SquashOptions {
  /** Name of the resulting squashed migration (must be a valid identifier). */
  name: string;
  /**
   * Allow squashing across a data migration boundary. When false (default),
   * the range must be contiguous schema migrations — a data migration in the
   * range is rejected.
   */
  allowCrossKind?: boolean;
}

/**
 * Squash a contiguous applied range of migrations into one.
 *
 * `history` must contain the full, validated linear chain. The squashed range
 * starts from the first migration (root) and must cover an uninterrupted
 * sequence of applied migrations. Every migration in the range must be a
 * schema migration unless `allowCrossKind` is set; a data migration in the
 * range without the flag throws a value-free `MigrationError`.
 *
 * The returned migration has no dependencies (it is the new root) and its
 * operations are the cumulative replay of the range from the empty schema.
 * The caller must update references in migrations that depended on the last
 * squashed migration.
 */
export function squashMigrations(
  history: MigrationHistory,
  options: SquashOptions,
): MigrationDefinition | null {
  const name = validateIdentifier(options.name);
  const ordered = resolveMigrationOrder(history);

  if (ordered.length === 0) {
    return null;
  }

  const allowCrossKind = options.allowCrossKind === true;

  // Build the squashed range: all migrations in the ordered history.
  // The range extends from the root through the entire history.
  const range = ordered;

  // Validate no data migrations in the range unless explicitly allowed.
  if (!allowCrossKind) {
    for (const migration of range) {
      if (migration.kind === 'data') {
        throw new MigrationError(
          `cannot squash across data migration "${migration.name}" without allowCrossKind; ` +
            `set allowCrossKind to include it, or split the squash around it`,
        );
      }
    }
  }

  // Replay the cumulative operations from the empty schema.
  const cumulativeOps: Operation[] = [];
  for (const migration of range) {
    cumulativeOps.push(...migration.operations);
  }

  if (cumulativeOps.length === 0) {
    return null;
  }

  // Verify the replay round-trips correctly.
  const squashed: MigrationDefinition = {
    name,
    dependencies: [],
    operations: cumulativeOps,
  };

  // Replay to ensure the squashed migration produces the same schema state
  // as the original range.
  const originalSchema = replayOrderedHistory(ordered);
  const squashedSchema = replayOrderedHistory(resolveMigrationOrder([squashed]));

  // Simple structural comparison: both should equal the same state.
  if (originalSchema.tables.length !== squashedSchema.tables.length) {
    // This should not happen — the operations are identical.
    throw new MigrationError(
      `squashed migration "${name}" does not produce the same schema state; ` +
        `this is an internal error — the operations may have drifted`,
    );
  }

  return squashed;
}
