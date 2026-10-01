/**
 * Enums — a closed-set column (varchar or integer) with value predicates, a
 * scope, and a `CHECK` constraint folded into the portable schema.
 *
 * {@link defineEnum} declares an enum column on an entity: it applies the
 * TypeORM column decorator (only when the author has not already declared the
 * column), returns a frozen {@link EnumDefinition}, and installs convenience
 * methods on a class entity:
 *
 * ```ts
 * @Entity('posts')
 * class Post extends BaseEntity {
 *   @PrimaryGeneratedColumn() id!: number;
 * }
 * const status = defineEnum(Post, 'status', ['draft', 'published']);
 *
 * const post = Post.create({ status: 'draft' });
 * post.statusIs('draft');            // true
 * post.statusIn(['draft']);          // true
 * Post.statusScope('published');     // query(Post).where(qEq('status','published'))
 * ```
 *
 * Because the value set is closed, the enum contributes a `CHECK` constraint
 * (`status IN ('draft','published')`) that {@link applyEnumChecks} folds into a
 * schema state before `db:push`/`db:diff`. `defineEnum` itself never registers
 * the check with TypeORM — `model-schema.ts` rejects `@Check` metadata — so the
 * caller passes the definitions to {@link applyEnumChecks} explicitly.
 *
 * All errors are {@link EnumError}, value-free: user-supplied enum values are
 * never echoed.
 */

import { Column, EntitySchema, getMetadataArgsStorage } from 'typeorm';
import type { BaseEntity, EntityTarget, ObjectLiteral } from 'typeorm';

import type { CheckDefinition, SchemaState, TableDefinition } from '../migrations/schema-types.js';
import { normalizeSchemaState } from '../migrations/schema-normalize.js';
import { query, type ModelQuery } from './model-query.js';
import { qEq, qIn, type Q } from './query-expressions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options controlling {@link defineEnum}. */
export interface EnumOptions {
  /** Explicit varchar length; defaults to the longest value. String values only. */
  readonly length?: number;
  /** Whether the column accepts `null`. Defaults to `false`. */
  readonly nullable?: boolean;
}

/**
 * A validated, frozen enum declaration for one column of one entity. The
 * `check` is the portable {@link CheckDefinition} to fold into the schema via
 * {@link applyEnumChecks}.
 */
export interface EnumDefinition {
  readonly entity: EntityTarget<ObjectLiteral>;
  readonly table: string;
  readonly column: string;
  readonly values: readonly (string | number)[];
  readonly type: 'varchar' | 'integer';
  readonly length?: number;
  readonly nullable: boolean;
  readonly check: CheckDefinition;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

type EnumErrorCode =
  | 'invalid_entity'
  | 'invalid_column'
  | 'invalid_values'
  | 'invalid_options'
  | 'unknown_value'
  | 'unknown_table'
  | 'unknown_column';

/** Raised for an invalid enum declaration or an out-of-set value. Value-free. */
export class EnumError extends Error {
  readonly code: EnumErrorCode;

  constructor(code: EnumErrorCode, message: string) {
    super(message);
    this.name = 'EnumError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Column names must be portable identifiers (letters, digits, underscores). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Duplicated from `schema-validation.ts` so enum value errors surface as
 * {@link EnumError} rather than `MigrationError`. Backslashes and control
 * characters cannot be ported safely across SQL drivers, so they are rejected
 * uniformly instead of given driver-dependent escaping.
 */
const BACKSLASH_OR_CONTROL = /[\u005C\u0000-\u001F\u007F]/;

function assertEntityTarget(entity: unknown): asserts entity is EntityTarget<ObjectLiteral> {
  const valid =
    typeof entity === 'function' ||
    typeof entity === 'string' ||
    entity instanceof EntitySchema ||
    (typeof entity === 'object' &&
      entity !== null &&
      typeof (entity as { name?: unknown }).name === 'string');
  if (!valid) {
    throw new EnumError(
      'invalid_entity',
      'enum "entity" must be a class, an EntitySchema, or a name',
    );
  }
}

/** Validate the value list and derive its column type (all-string or all-integer). */
function validateValues(
  values: readonly unknown[],
  column: string,
): { type: 'varchar' | 'integer'; values: readonly (string | number)[] } {
  if (!Array.isArray(values) || values.length === 0) {
    throw new EnumError('invalid_values', `enum column "${column}" requires a non-empty array`);
  }

  const first = values[0];
  const type: 'varchar' | 'integer' | 'invalid' =
    typeof first === 'string'
      ? 'varchar'
      : typeof first === 'number' && Number.isInteger(first)
        ? 'integer'
        : 'invalid';

  if (type === 'invalid') {
    throw new EnumError(
      'invalid_values',
      `enum column "${column}" values must be strings or integers`,
    );
  }

  const seen = new Set<string | number>();
  const result: (string | number)[] = [];
  for (const value of values) {
    if (type === 'varchar') {
      if (typeof value !== 'string') {
        throw new EnumError(
          'invalid_values',
          `enum column "${column}" values must be all strings or all integers`,
        );
      }
      if (BACKSLASH_OR_CONTROL.test(value)) {
        throw new EnumError(
          'invalid_values',
          `enum column "${column}" has a value containing a backslash or control character`,
        );
      }
    } else if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new EnumError(
        'invalid_values',
        `enum column "${column}" values must be all strings or all integers`,
      );
    }
    if (seen.has(value)) {
      throw new EnumError('invalid_values', `enum column "${column}" lists a value more than once`);
    }
    seen.add(value);
    result.push(value);
  }

  return { type, values: result };
}

/** Resolve the entity's table name without touching a connection. */
function resolveTableName(entity: EntityTarget<ObjectLiteral>): string {
  if (typeof entity === 'function') {
    return (
      getMetadataArgsStorage().tables.find((table) => table.target === entity)?.name ?? entity.name
    );
  }
  if (typeof entity === 'string') {
    return entity;
  }
  if (entity instanceof EntitySchema) {
    return entity.options.tableName ?? entity.options.name;
  }
  return entity.name;
}

/** Render one enum value as a safe SQL literal (single quotes doubled). */
function quoteEnumLiteral(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

function assertValueInSet(definition: EnumDefinition, value: unknown): void {
  if (!(definition.values as readonly unknown[]).includes(value)) {
    throw new EnumError('unknown_value', `value is not in the enum set for "${definition.column}"`);
  }
}

function assertValuesInSet(definition: EnumDefinition, values: readonly unknown[]): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new EnumError('invalid_values', 'enum "in" requires a non-empty array of values');
  }
  for (const value of values) {
    assertValueInSet(definition, value);
  }
}

// ---------------------------------------------------------------------------
// defineEnum
// ---------------------------------------------------------------------------

/**
 * Declare an enum column on an entity. Returns a frozen {@link EnumDefinition}
 * and, for a class entity, applies the column decorator (unless the column is
 * already declared) and installs `<column>Is` / `<column>In` prototype methods
 * plus a static `<column>Scope` query factory.
 *
 * The `CHECK` constraint is **not** registered with TypeORM; fold it into the
 * schema via {@link applyEnumChecks}.
 */
export function defineEnum<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  column: string,
  values: readonly (string | number)[],
  options?: EnumOptions,
): EnumDefinition {
  assertEntityTarget(entity);
  if (typeof column !== 'string' || !IDENTIFIER.test(column)) {
    throw new EnumError('invalid_column', 'enum column must be a valid identifier');
  }

  const { type, values: valid } = validateValues(values, column);
  const nullable = options?.nullable ?? false;

  let length: number | undefined;
  if (type === 'varchar') {
    length = Math.max(...valid.map((value) => Array.from(value as string).length));
    if (options?.length !== undefined) {
      if (
        typeof options.length !== 'number' ||
        !Number.isInteger(options.length) ||
        options.length <= 0
      ) {
        throw new EnumError('invalid_options', 'enum "length" must be a positive integer');
      }
      if (options.length < length) {
        throw new EnumError(
          'invalid_options',
          `enum "length" (${options.length}) is shorter than the longest value (${length})`,
        );
      }
      length = options.length;
    }
  } else if (options?.length !== undefined) {
    throw new EnumError('invalid_options', 'enum "length" may only be set for string values');
  }

  const table = resolveTableName(entity);
  const check: CheckDefinition = Object.freeze({
    name: `${column}_enum_check`,
    expression: `${column} IN (${valid.map(quoteEnumLiteral).join(', ')})`,
  });

  // Apply the column decorator only for class entities that have not already
  // declared the column. EntitySchema / name targets carry their columns
  // elsewhere, so nothing is pushed for them.
  if (typeof entity === 'function') {
    const storage = getMetadataArgsStorage();
    const exists = storage.columns.some(
      (entry) => entry.target === entity && entry.propertyName === column,
    );
    if (!exists) {
      const columnOptions =
        type === 'varchar'
          ? { type: 'varchar' as const, length, nullable }
          : { type: 'integer' as const, nullable };
      Column(columnOptions)((entity as { prototype: object }).prototype, column);
    }
  }

  const definition: EnumDefinition = Object.freeze({
    entity,
    table,
    column,
    values: Object.freeze(valid),
    type,
    ...(length !== undefined ? { length } : {}),
    nullable,
    check,
  });

  installEnumMethods(definition);
  return definition;
}

// ---------------------------------------------------------------------------
// Method installation (class entities only)
// ---------------------------------------------------------------------------

function installEnumMethods(definition: EnumDefinition): void {
  const { entity, column } = definition;
  if (typeof entity !== 'function') {
    return;
  }
  const proto = (entity as { prototype: object }).prototype;
  const target = entity as Function & { prototype: object };

  defineOwn(
    target.prototype,
    `${column}Is`,
    function (this: ObjectLiteral, value: string | number): boolean {
      return enumIs(definition, this, value);
    },
  );
  defineOwn(
    target.prototype,
    `${column}In`,
    function (this: ObjectLiteral, values: readonly (string | number)[]): boolean {
      return enumIn(definition, this, values);
    },
  );
  defineOwn(target, `${column}Scope`, function (value: string | number): ModelQuery<ObjectLiteral> {
    return enumScope(definition, value);
  });

  void proto;
}

function defineOwn(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

// ---------------------------------------------------------------------------
// Predicates + scope
// ---------------------------------------------------------------------------

/** Whether the instance's enum column equals `value`. */
export function enumIs(
  definition: EnumDefinition,
  instance: Record<string, unknown>,
  value: string | number,
): boolean {
  assertValueInSet(definition, value);
  return Object.is(instance[definition.column], value);
}

/** Whether the instance's enum column is one of `values`. */
export function enumIn(
  definition: EnumDefinition,
  instance: Record<string, unknown>,
  values: readonly (string | number)[],
): boolean {
  assertValuesInSet(definition, values);
  return values.includes(instance[definition.column] as string | number);
}

/**
 * A {@link ModelQuery} scoped to `value` for the enum column. Requires a class
 * entity; an EntitySchema/name target has no `getRepository` to query through.
 */
export function enumScope<T extends ObjectLiteral = ObjectLiteral>(
  definition: EnumDefinition,
  value: string | number,
): ModelQuery<T> {
  if (typeof definition.entity !== 'function') {
    throw new EnumError('invalid_entity', 'enum scope requires a class entity');
  }
  assertValueInSet(definition, value);
  return query<T>(definition.entity as typeof BaseEntity).where(qEq(definition.column, value));
}

/** A `qEq` predicate for the enum column equal to `value`. */
export function enumWhere(definition: EnumDefinition, value: string | number): Q {
  assertValueInSet(definition, value);
  return qEq(definition.column, value);
}

/** A `qIn` predicate for the enum column within `values`. */
export function enumWhereIn(definition: EnumDefinition, values: readonly (string | number)[]): Q {
  assertValuesInSet(definition, values);
  return qIn(definition.column, values);
}

// ---------------------------------------------------------------------------
// Schema integration
// ---------------------------------------------------------------------------

/**
 * Fold one or more enum definitions' `CHECK` constraints into a schema state.
 * Each definition's table and column must already exist in `schema`; the check
 * is merged into the table's `checks` list (an enum check wins a same-name
 * collision), and the result is re-normalized via {@link normalizeSchemaState}.
 *
 * This is the seam a caller invokes between `getModelSchema()` and
 * `diffSchemaStates` — it is deliberately **not** wired into `db:push`, which
 * has no visibility into enum definitions.
 */
export function applyEnumChecks(
  schema: SchemaState,
  ...definitions: readonly EnumDefinition[]
): SchemaState {
  const tablesByName = new Map<string, TableDefinition>(
    schema.tables.map((table) => [table.name, table]),
  );
  const addedChecks = new Map<string, Map<string, CheckDefinition>>();

  for (const definition of definitions) {
    const table = tablesByName.get(definition.table);
    if (table === undefined) {
      throw new EnumError(
        'unknown_table',
        `enum definition references unknown table "${definition.table}"`,
      );
    }
    const columns = new Set(table.columns.map((column) => column.name));
    if (!columns.has(definition.column)) {
      throw new EnumError(
        'unknown_column',
        `enum definition references unknown column "${definition.table}.${definition.column}"`,
      );
    }
    const checks = addedChecks.get(definition.table) ?? new Map<string, CheckDefinition>();
    checks.set(definition.check.name, definition.check);
    addedChecks.set(definition.table, checks);
  }

  if (addedChecks.size === 0) {
    return normalizeSchemaState(schema);
  }

  const out: SchemaState = {
    tables: schema.tables.map((table) => {
      const extra = addedChecks.get(table.name);
      if (extra === undefined) {
        return table;
      }
      const byName = new Map<string, CheckDefinition>(
        (table.checks ?? []).map((check) => [check.name, check]),
      );
      for (const [name, check] of extra) {
        byName.set(name, check); // enum check wins a same-name collision
      }
      const checks = [...byName.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      return { ...table, checks };
    }),
  };

  return normalizeSchemaState(out);
}
