/**
 * The runtime `jsails` decorator namespace.
 *
 * A model author writes `@jsails.maxLength(200) declare title: string` with no
 * import. TypeScript type-checks that against the ambient `declare namespace
 * jsails` in the generated `.jsails/framework-symbols.d.ts`, but it **emits the
 * decorator call as a runtime expression** — `jsails.maxLength(200)` inside
 * `__decorate([...])`. The name `jsails` must therefore resolve to a value at
 * module-evaluation time, or the model throws `ReferenceError` on import.
 *
 * This module supplies that value. Importing it installs `globalThis.jsails`
 * as a side effect; because ESM evaluates an imported module before the
 * importing module's body, any module that reaches this one (directly or
 * transitively) has the global set before its own `__decorate` calls run. The
 * install choke point is {@link ApplicationRecord} — every model extends it, so
 * importing a model always installs the global first.
 *
 * The decorator factories here are **inert**: they return a no-op
 * `PropertyDecorator`. The real work is done by the compiler, which reads the
 * decorator AST and folds it into the model spec; the runtime call exists only
 * so the emitted expression does not throw. This keeps the generated surface
 * stable and the runtime dependency-free.
 *
 * This module is a leaf: it imports nothing, so it is safe to reach from any
 * layer.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** A class constructor usable as a relation target. */
export type JsailsRelationTarget = new (...args: never[]) => object;

/** Options accepted by the relation decorators. */
export interface JsailsRelationOptions {
  /** Update the parent's timestamp when the related row changes. */
  readonly touch?: boolean;
  /** Maintain a counter column on the parent. */
  readonly counter_cache?: boolean;
  /** The inverse property name on the target, when inference is ambiguous. */
  readonly inverse?: string;
}

/**
 * The shape of the `jsails` decorator namespace. The generated ambient
 * declaration mirrors this interface; a test asserts the two stay in sync.
 */
export interface JsailsNamespace {
  maxLength(length: number): PropertyDecorator;
  unique(): PropertyDecorator;
  nullable(): PropertyDecorator;
  encrypts(): PropertyDecorator;
  /**
   * Declares that the column (or, for a many-to-one relation, its derived FK
   * column) was previously stored under `previousName`. The schema reconciler
   * consumes this marker so the rename emits a data-preserving `rename_column`
   * instead of a drop+add.
   */
  renamedFrom(previousName: string): PropertyDecorator;
  belongsTo(target: JsailsRelationTarget, options?: JsailsRelationOptions): PropertyDecorator;
  hasMany(target: JsailsRelationTarget, options?: JsailsRelationOptions): PropertyDecorator;
  hasOne(target: JsailsRelationTarget, options?: JsailsRelationOptions): PropertyDecorator;
  /**
   * Declares an enum column: a closed-set string/integer column with a `CHECK`
   * constraint and value predicates. The value set is a closed list of strings
   * or integers; the compiler derives the column kind and the check expression.
   */
  ['enum'](values: readonly (string | number)[]): PropertyDecorator;
}

/* ------------------------------------------------------------------ */
/*  Runtime value                                                      */
/* ------------------------------------------------------------------ */

/** A no-op property decorator; the compiler does the real lowering. */
const inert: PropertyDecorator = () => {
  // Intentionally empty: the decorator is a compile-time marker.
};

/**
 * The runtime `jsails` namespace. Every factory returns the same inert
 * decorator; parameters are accepted (and ignored) so the emitted call shape
 * matches the ambient declaration.
 */
export const jsails: JsailsNamespace = {
  maxLength: () => inert,
  unique: () => inert,
  nullable: () => inert,
  encrypts: () => inert,
  renamedFrom: () => inert,
  belongsTo: () => inert,
  hasMany: () => inert,
  hasOne: () => inert,
  enum: () => inert,
};

/* ------------------------------------------------------------------ */
/*  Global installation                                                */
/* ------------------------------------------------------------------ */

/**
 * Install the `jsails` namespace on `globalThis`. Idempotent: a repeated call
 * reassigns the same object. Called at module load so importing this module is
 * sufficient to make `@jsails.*` decorators resolve.
 */
export function installJsailsGlobal(): void {
  (globalThis as { jsails?: JsailsNamespace }).jsails = jsails;
}

installJsailsGlobal();
