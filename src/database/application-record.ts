/**
 * The JSails-owned Active Record base class.
 *
 * A model extends `ApplicationRecord` and declares only the shape of its data:
 *
 * ```ts
 * export class Post extends ApplicationRecord {
 *   declare title: string;
 *   declare author: Author;
 * }
 * ```
 *
 * The class is a TypeORM entity target (it extends TypeORM's `BaseEntity`, so
 * `Post.find()`, `post.save()`, and the rest of the Active Record surface are
 * available), but the user never imports TypeORM: the compiler derives the
 * entity, columns, relations, and hooks from the class shape and registers them
 * through {@link registerModel}.
 *
 * Registration is **explicit**, not implicit in the base class: a JavaScript
 * `static {}` block runs only for the class it is declared in, so a base class
 * cannot observe its subclasses. The compiler emits a `registerModel(Post, …)`
 * call per model; a hand-written model without a compiler run calls
 * {@link registerModel} itself. {@link JsailsDataSource} harvests the registry
 * into its `entities` and `subscribers` options.
 *
 * This module is server-only: it reaches TypeORM and `reflect-metadata`.
 */

import 'reflect-metadata';
// Installs `globalThis.jsails` before any model's `__decorate` calls run. Every
// model extends `ApplicationRecord`, so this import is the single choke point
// that guarantees the runtime decorator namespace exists at model-eval time.
import '../internal/jsails-namespace.js';

import { BaseEntity } from 'typeorm';

import {
  changed as dirtyChanged,
  was as dirtyWas,
  savedChanges as dirtySavedChanges,
} from './dirty.js';

/**
 * Base class for a JSails model. Extending it makes a class a model; the class
 * is registered through {@link registerModel} (compiler-emitted, or explicit).
 *
 * It also carries the dirty-tracking read surface. Tracking itself is opt-in:
 * these methods answer against the per-instance snapshot that
 * {@link defineDirtyTracking} (wired through a data source's subscribers)
 * maintains. Without that wiring an entity is untracked and answers `[]` /
 * `false` / `undefined` rather than throwing.
 */
export abstract class ApplicationRecord extends BaseEntity {
  /** The scalar columns whose current value differs from the tracked baseline. */
  changed(): string[];
  /** Whether `column`'s current value differs from the tracked baseline. */
  changed(column: string): boolean;
  changed(column?: string): string[] | boolean {
    return column === undefined ? dirtyChanged(this) : dirtyChanged(this, column);
  }

  /** The tracked baseline value for a column (before any in-memory edits). */
  was(column: string): unknown {
    return dirtyWas(this, column);
  }

  /** The before/after pairs recorded by the most recent save, keyed by column. */
  savedChanges(): Record<string, readonly [unknown, unknown]> {
    return dirtySavedChanges(this);
  }
}
