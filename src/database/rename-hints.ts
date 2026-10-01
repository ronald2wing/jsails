/**
 * Column-rename hint derivation from model specs.
 *
 * `@jsails.renamedFrom('old_name')` marks a field whose column (or, for a
 * many-to-one relation, its derived FK column) was previously stored under a
 * different name. That marker must NOT live on the column definition itself — a
 * stray field there would make the autodetector's `columnsEqual` comparison
 * report a phantom diff — so it travels as a separate side-channel, a
 * {@link ColumnRenameHint} list, exactly like the existing CLI `--rename`
 * mechanism consumed by {@link resolveRenames} in the autodetector.
 *
 * This module is pure and total: it reads frozen specs and returns hints with
 * no validation or dedup. Ambiguity refusal is the differ's job.
 */

import type { ColumnRenameHint } from '../migrations/autodetector.js';
import type { ModelSpec } from '../models/define-model.js';
import { registeredModels } from './model-registry.js';

/**
 * Build column-rename hints from model specs carrying `renamedFrom` markers.
 *
 * Each marked field produces `{ table: spec.table, from: renamedFrom, to }`.
 * For a column, `to` is `column.name`; for a many-to-one relation, `to` is the
 * derived FK column (`<name>_id`). A one-to-many relation owns no column on its
 * own table, so a `renamedFrom` there is skipped. Deterministic order: specs in
 * input order, columns then relations.
 */
export function buildRenameHints(specs: readonly ModelSpec[]): ColumnRenameHint[] {
  const hints: ColumnRenameHint[] = [];
  for (const spec of specs) {
    for (const column of spec.columns) {
      if (column.renamedFrom !== undefined) {
        hints.push({ table: spec.table, from: column.renamedFrom, to: column.name });
      }
    }
    for (const relation of spec.relations) {
      // Only a many-to-one relation has a physical FK column on this table; a
      // one-to-many column lives on the target table and cannot be renamed here.
      if (relation.kind !== 'many-to-one' || relation.renamedFrom === undefined) {
        continue;
      }
      hints.push({
        table: spec.table,
        from: relation.renamedFrom,
        to: relation.joinColumn ?? `${relation.name}_id`,
      });
    }
  }
  return hints;
}

/** Rename hints for every currently registered model's spec. */
export function buildRenameHintsFromRegistry(): ColumnRenameHint[] {
  return buildRenameHints(registeredModels().map((model) => model.spec));
}
