/**
 * Portable query expressions for the JSails data layer: a typed expression
 * language that compiles through TypeORM's SelectQueryBuilder. Every
 * condition is emitted with bound parameters or column references — never
 * hand-built SQL with inlined literals or quoted identifiers.
 *
 * Boolean combinators (`and`/`or`/`not`) are compiled through TypeORM's
 * `Brackets` and `NotBrackets` for portable, parenthesized rendering with
 * bound parameters — no hand-built SQL.
 */

import {
  Brackets,
  NotBrackets,
  type SelectQueryBuilder,
  type WhereExpressionBuilder,
} from 'typeorm';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Raised for expression-compilation failures. Value-free. */
export class QueryExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryExpressionError';
  }
}

// ---------------------------------------------------------------------------
// F — column reference
// ---------------------------------------------------------------------------

/**
 * A column reference on a specific table alias. Use as a comparison value
 * to produce column-to-column comparisons instead of bound parameters.
 */
export class F {
  readonly column: string;

  constructor(column: string) {
    if (!isValidIdentifier(column)) {
      throw new QueryExpressionError('Invalid column identifier');
    }
    this.column = column;
  }

  /** Emit a portable qualified column reference: `alias.column`. */
  toSql(alias: string): string {
    return `${alias}.${this.column}`;
  }
}

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

/** Non-empty, starts with letter/underscore, alphanumeric/underscore thereafter. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isValidIdentifier(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && IDENTIFIER_RE.test(s);
}

export function assertValidColumn(column: string): void {
  if (!isValidIdentifier(column)) {
    throw new QueryExpressionError('Invalid column identifier');
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Recognised comparison operators. */
export type QOperator =
  'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'isNull' | 'notNull' | 'like';

/** A single comparison condition. */
export interface QLeaf {
  readonly kind: 'leaf';
  readonly column: string;
  readonly operator: QOperator;
  readonly value?: unknown;
}

/** A compound condition (and/or/not). Slice 2. */
export interface QNode {
  readonly kind: 'and' | 'or' | 'not';
  readonly children: readonly Q[];
}

export type Q = QLeaf | QNode;

// ---------------------------------------------------------------------------
// Generic leaf constructor
// ---------------------------------------------------------------------------

export function q(column: string, operator: QOperator, value?: unknown): Q {
  assertValidColumn(column);
  validateOperator(operator, value);
  return { kind: 'leaf', column, operator, value };
}

// ---------------------------------------------------------------------------
// Typed leaf constructors
// ---------------------------------------------------------------------------

export function qEq(column: string, value: unknown): Q {
  return q(column, 'eq', value);
}

export function qNe(column: string, value: unknown): Q {
  return q(column, 'ne', value);
}

export function qGt(column: string, value: unknown): Q {
  return q(column, 'gt', value);
}

export function qGte(column: string, value: unknown): Q {
  return q(column, 'gte', value);
}

export function qLt(column: string, value: unknown): Q {
  return q(column, 'lt', value);
}

export function qLte(column: string, value: unknown): Q {
  return q(column, 'lte', value);
}

export function qIn(column: string, values: readonly unknown[]): Q {
  assertValidColumn(column);
  if (!Array.isArray(values) || values.length === 0) {
    throw new QueryExpressionError('The "in" operator requires a non-empty array of values');
  }
  if (values.some((v) => v instanceof F)) {
    throw new QueryExpressionError('F references are not supported with the "in" operator');
  }
  return { kind: 'leaf', column, operator: 'in', value: values };
}

export function qNotIn(column: string, values: readonly unknown[]): Q {
  assertValidColumn(column);
  if (!Array.isArray(values) || values.length === 0) {
    throw new QueryExpressionError('The "notIn" operator requires a non-empty array of values');
  }
  if (values.some((v) => v instanceof F)) {
    throw new QueryExpressionError('F references are not supported with the "notIn" operator');
  }
  return { kind: 'leaf', column, operator: 'notIn', value: values };
}

export function qIsNull(column: string): Q {
  assertValidColumn(column);
  return { kind: 'leaf', column, operator: 'isNull' };
}

export function qNotNull(column: string): Q {
  assertValidColumn(column);
  return { kind: 'leaf', column, operator: 'notNull' };
}

export function qLike(column: string, pattern: string): Q {
  assertValidColumn(column);
  // The param is typed `string`, so F is rejected at compile time. The
  // generic `q()` path validates F for `like` via validateOperator.
  if (typeof pattern !== 'string') {
    throw new QueryExpressionError('The "like" operator requires a string pattern');
  }
  return { kind: 'leaf', column, operator: 'like', value: pattern };
}

// ---------------------------------------------------------------------------
// Operator validation (for the generic q() path)
// ---------------------------------------------------------------------------

function validateOperator(operator: string, value: unknown): void {
  switch (operator) {
    case 'eq':
    case 'ne':
      if (value == null) {
        throw new QueryExpressionError(
          'Equality comparisons against missing values are not supported',
        );
      }
      return;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      // F is a valid value here (column-to-column comparison). No other
      // validation needed — TypeORM will parameterise or reference accordingly.
      return;
    case 'in':
    case 'notIn':
      if (!Array.isArray(value) || (value as readonly unknown[]).length === 0) {
        throw new QueryExpressionError('The "in" operator requires a non-empty array of values');
      }
      if ((value as readonly unknown[]).some((v) => v instanceof F)) {
        throw new QueryExpressionError('F references are not supported with the "in" operator');
      }
      return;
    case 'isNull':
    case 'notNull':
      if (value !== undefined) {
        throw new QueryExpressionError('isNull and notNull operators do not accept a value');
      }
      return;
    case 'like':
      if (value instanceof F) {
        throw new QueryExpressionError('F references are not supported with the "like" operator');
      }
      if (typeof value !== 'string') {
        throw new QueryExpressionError('The "like" operator requires a string pattern');
      }
      return;
    default:
      throw new QueryExpressionError('Unknown query operator');
  }
}

// ---------------------------------------------------------------------------
// Case / When — conditional value expression
// ---------------------------------------------------------------------------

/** A single branch of a CASE expression: WHEN <condition> THEN <value>. */
export interface When {
  readonly condition: Q;
  readonly then: unknown;
}

/**
 * A portable `CASE WHEN ... THEN ... ELSE ... END` expression.
 *
 * Conditions are restricted to single leaves in this version because
 * TypeORM's `Brackets` provides no public SQL-extraction API — extracting a
 * compound condition into a standalone SQL fragment is not cleanly possible
 * without hand-building identifier quoting. Compound conditions in a when
 * clause are rejected with a value-free error.
 */
export class Case {
  constructor(
    readonly whens: readonly When[],
    readonly defaultValue?: unknown,
  ) {}

  /**
   * Render a `CASE WHEN ... THEN ... ELSE ... END` expression.
   *
   * Every branch value and the default is a bound parameter (never inlined).
   * Column references (`F`) in `then`/`defaultValue` are emitted as qualified
   * column references. The caller must register the returned params on the
   * query builder.
   */
  toSql(
    alias: string,
    counter: { next: number },
  ): { sql: string; params: Record<string, unknown> } {
    const params: Record<string, unknown> = {};
    const whenClauses: string[] = [];

    for (const w of this.whens) {
      // Safe cast: isWhen validates condition is a leaf at construction time.
      const { sql: condSql, params: condParams } = renderLeafCondition(
        w.condition as QLeaf,
        alias,
        counter,
      );
      Object.assign(params, condParams);

      if (w.then instanceof F) {
        whenClauses.push(`WHEN ${condSql} THEN ${w.then.toSql(alias)}`);
      } else {
        const thenKey = `qe_case_${counter.next++}`;
        whenClauses.push(`WHEN ${condSql} THEN :${thenKey}`);
        params[thenKey] = w.then;
      }
    }

    let elseClause: string;
    if (this.defaultValue === undefined || this.defaultValue === null) {
      elseClause = 'ELSE NULL';
    } else if (this.defaultValue instanceof F) {
      elseClause = `ELSE ${this.defaultValue.toSql(alias)}`;
    } else {
      const elseKey = `qe_case_${counter.next++}`;
      elseClause = `ELSE :${elseKey}`;
      params[elseKey] = this.defaultValue;
    }

    const sql = `CASE ${whenClauses.join(' ')} ${elseClause} END`;
    return { sql, params };
  }
}

/**
 * Construct a single CASE branch.
 *
 * The condition must be a leaf predicate (compound conditions are rejected
 * in this version — see `Case`). The `then` value may be a literal or a
 * column reference (`F`).
 */
export function when(condition: Q, then: unknown): When {
  if (!isQ(condition)) {
    throw new QueryExpressionError('A "when" condition must be a query predicate');
  }
  if (condition.kind !== 'leaf') {
    throw new QueryExpressionError('Only single leaf conditions are supported in "when" clauses');
  }
  return Object.freeze({ condition, then });
}

/**
 * Construct a CASE expression from one or more WHEN branches and an optional
 * ELSE default. Rejects zero branches — a CASE with no branches is meaningless.
 */
export function caseWhen(whens: readonly When[], defaultValue?: unknown): Case {
  if (whens.length === 0) {
    throw new QueryExpressionError('A "case" expression requires at least one "when" clause');
  }
  for (const w of whens) {
    if (!isWhen(w)) {
      throw new QueryExpressionError('Invalid "when" clause');
    }
  }
  return new Case(whens, defaultValue);
}

/** Structural check: does the value have the expected When shape? */
function isWhen(value: unknown): value is When {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  // Must carry the 'then' property — a When without 'then' is a programming
  // error, not a valid NULL THEN.
  return 'then' in obj && isQ(obj.condition) && obj.condition.kind === 'leaf';
}

/**
 * Render a single leaf condition into a portable SQL fragment with bound
 * parameters. Parallels `renderLeaf` but outputs strings instead of writing
 * into a `WhereExpressionBuilder`, for use in CASE WHEN condition rendering.
 */
function renderLeafCondition(
  leaf: QLeaf,
  alias: string,
  counter: { next: number },
): { sql: string; params: Record<string, unknown> } {
  const { column, operator, value } = leaf;
  const sql = OPERATOR_SQL[operator];
  const params: Record<string, unknown> = {};

  if (operator === 'isNull' || operator === 'notNull') {
    return { sql: `${alias}.${column} ${sql}`, params };
  }

  if (value instanceof F) {
    return { sql: `${alias}.${column} ${sql} ${value.toSql(alias)}`, params };
  }

  if (operator === 'in' || operator === 'notIn') {
    const paramKey = `qe_${alias}_${column}_${counter.next++}`;
    params[paramKey] = value;
    return { sql: `${alias}.${column} ${sql} (:...${paramKey})`, params };
  }

  const paramKey = `qe_${alias}_${column}_${counter.next++}`;
  params[paramKey] = value;
  return { sql: `${alias}.${column} ${sql} :${paramKey}`, params };
}

/**
 * Add a Case expression to the SELECT list under a selection alias.
 * Registers every bound parameter from the expression on the query builder.
 * Returns the same builder for chaining.
 */
export function addCaseSelect<T extends object>(
  qb: SelectQueryBuilder<T>,
  expression: Case,
  selectionAlias: string,
  alias?: string,
): SelectQueryBuilder<T> {
  const counter = { next: 0 };
  const { sql, params } = expression.toSql(alias ?? qb.alias, counter);
  qb.addSelect(sql, selectionAlias);
  if (Object.keys(params).length > 0) {
    qb.setParameters(params);
  }
  return qb;
}

// ---------------------------------------------------------------------------
// Boolean combinators — and / or / not
// ---------------------------------------------------------------------------

/**
 * Logical AND of zero or more predicates. Rejects zero predicates — an empty
 * AND is ambiguous rather than a meaningful identity value.
 */
export function and(...predicates: readonly Q[]): QNode {
  if (predicates.length === 0) {
    throw new QueryExpressionError('An "and" group requires at least one condition');
  }
  for (const p of predicates) {
    if (!isQ(p)) {
      throw new QueryExpressionError('Invalid query predicate');
    }
  }
  return Object.freeze({ kind: 'and', children: predicates });
}

/**
 * Logical OR of zero or more predicates. Rejects zero predicates — an empty
 * OR is ambiguous rather than a meaningful identity value.
 */
export function or(...predicates: readonly Q[]): QNode {
  if (predicates.length === 0) {
    throw new QueryExpressionError('An "or" group requires at least one condition');
  }
  for (const p of predicates) {
    if (!isQ(p)) {
      throw new QueryExpressionError('Invalid query predicate');
    }
  }
  return Object.freeze({ kind: 'or', children: predicates });
}

/** Logical NOT of a single predicate. */
export function not(predicate: Q): QNode {
  if (!isQ(predicate)) {
    throw new QueryExpressionError('Invalid query predicate');
  }
  return Object.freeze({ kind: 'not', children: [predicate] });
}

/** Structural check: does the value have a recognised Q discriminant? */
function isQ(value: unknown): value is Q {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  // Narrowed by `in` above; TS infers `kind` as `unknown`.
  const { kind } = value;
  return kind === 'leaf' || kind === 'and' || kind === 'or' || kind === 'not';
}

// ---------------------------------------------------------------------------
// applyQ — integration seam
// ---------------------------------------------------------------------------

/**
 * Apply a query predicate to a TypeORM SelectQueryBuilder.
 *
 * Wraps the compiled expression in `andWhere(new Brackets(...))` so the
 * predicate composes naturally with any pre-existing WHERE condition on
 * the builder. The alias defaults to `qb.alias`; pass an explicit alias
 * when the builder's own alias differs from the intended table reference.
 */
export function applyQ<T extends object>(
  qb: SelectQueryBuilder<T>,
  predicate: Q,
  alias?: string,
): SelectQueryBuilder<T> {
  // A per-call counter makes every bound parameter key unique. Keying only on
  // alias+column would collide when a compound predicate compares the same
  // column twice (e.g. `and(qGt('likes', 4), qLt('likes', 10))`), silently
  // overwriting the first binding with the second.
  const counter = { next: 0 };
  return qb.andWhere(new Brackets((w) => renderQ(w, predicate, alias ?? qb.alias, counter)));
}

// ---------------------------------------------------------------------------
// renderQ — internal compiler (leaf + compound)
// ---------------------------------------------------------------------------

/** SQL keyword for each operator. */
const OPERATOR_SQL: Record<QOperator, string> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  in: 'IN',
  notIn: 'NOT IN',
  isNull: 'IS NULL',
  notNull: 'IS NOT NULL',
  like: 'LIKE',
};

function renderQ(
  w: WhereExpressionBuilder,
  predicate: Q,
  alias: string,
  counter: { next: number },
): void {
  if (predicate.kind === 'leaf') {
    renderLeaf(w, predicate, alias, counter);
    return;
  }

  switch (predicate.kind) {
    case 'and':
      w.andWhere(
        new Brackets((inner) => {
          for (const child of predicate.children) {
            renderQ(inner, child, alias, counter);
          }
        }),
      );
      break;
    case 'or':
      // Non-null assertion is safe: the constructor guarantees at least one
      // child, so children[0] always exists at runtime.
      w.andWhere(
        new Brackets((inner) => {
          inner.where(new Brackets((cb) => renderQ(cb, predicate.children[0]!, alias, counter)));
          for (let i = 1; i < predicate.children.length; i++) {
            inner.orWhere(
              new Brackets((cb) => renderQ(cb, predicate.children[i]!, alias, counter)),
            );
          }
        }),
      );
      break;
    case 'not':
      // NotBrackets extends Brackets; TypeORM renders it as NOT (...).
      w.andWhere(
        new NotBrackets((inner) => renderQ(inner, predicate.children[0]!, alias, counter)),
      );
      break;
  }
}

function renderLeaf(
  w: WhereExpressionBuilder,
  predicate: QLeaf,
  alias: string,
  counter: { next: number },
): void {
  const { column, operator, value } = predicate;
  const sql = OPERATOR_SQL[operator];

  // isNull / notNull: no parameter, no value.
  if (operator === 'isNull' || operator === 'notNull') {
    w.andWhere(`${alias}.${column} ${sql}`);
    return;
  }

  // Column-to-column comparison: value is an F reference rather than a
  // literal. Emit a direct column reference instead of a bound parameter.
  if (value instanceof F) {
    w.andWhere(`${alias}.${column} ${sql} ${value.toSql(alias)}`);
    return;
  }

  // Case expression as a comparison value: inline the CASE expression and
  // register its bound parameters on the WHERE builder.
  if (value instanceof Case) {
    const { sql: caseSql, params } = value.toSql(alias, counter);
    w.andWhere(`${alias}.${column} ${sql} (${caseSql})`, params);
    return;
  }

  // in / notIn: array parameter with spread binding.
  if (operator === 'in' || operator === 'notIn') {
    const paramKey = `qe_${alias}_${column}_${counter.next++}`;
    w.andWhere(`${alias}.${column} ${sql} (:...${paramKey})`, { [paramKey]: value });
    return;
  }

  // Scalar comparison: bound parameter. The counter suffix keeps the key
  // unique across repeated columns in one predicate tree.
  const paramKey = `qe_${alias}_${column}_${counter.next++}`;
  w.andWhere(`${alias}.${column} ${sql} :${paramKey}`, { [paramKey]: value });
}
