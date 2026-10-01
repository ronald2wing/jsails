/**
 * Relation predicates for the JSails data layer: compile relation conditions
 * into portable EXISTS subqueries via TypeORM's SelectQueryBuilder.
 *
 * Every predicate composes with TypeORM — callers chain `.leftJoinAndSelect`,
 * `.getMany()`, `.getManyAndCount()`, etc. after the predicate.
 *
 * Polymorphic relations are REJECTED with a value-free {@link RelationError}
 * in v1 because the target table is ambiguous at the SQL level.
 *
 * Portability: all identifier quoting is delegated to the driver through
 * QueryBuilder. No hand-built SQL strings. EXISTS correlated subqueries are
 * standard SQL on SQLite, Postgres, MySQL, and MariaDB.
 */

import { BaseEntity, SelectQueryBuilder, getMetadataArgsStorage } from 'typeorm';

import {
  type ResolvedRelation,
  RelationError,
  resolveRelation,
  resolveRelationPath,
} from './relation-metadata.js';
import type { ThroughRelation } from './through-relations.js';

export { RelationError } from './relation-metadata.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A predicate applied to a correlated subquery targeting a related entity.
 *
 * The predicate composes with {@link applyQ} from `query-expressions.ts`:
 * `(rq) => { applyQ(rq.builder, predicate); return rq; }` adds a portable
 * expression condition to the correlated subquery.
 */
export type RelationPredicate = (query: RelationQuery) => RelationQuery;

/** Fluent API for adding conditions, ordering, and limits to a related-entity subquery. */
export interface RelationQuery {
  where(column: string, value: unknown): RelationQuery;
  whereIn(column: string, values: readonly unknown[]): RelationQuery;
  whereNull(column: string): RelationQuery;
  whereNotNull(column: string): RelationQuery;
  orderBy(column: string, direction?: 'ASC' | 'DESC'): RelationQuery;
  limit(n: number): RelationQuery;
  readonly builder: SelectQueryBuilder<object>;
}

// ---------------------------------------------------------------------------
// RelationQuery implementation
// ---------------------------------------------------------------------------

class RelationQueryImpl implements RelationQuery {
  readonly builder: SelectQueryBuilder<object>;

  constructor(builder: SelectQueryBuilder<object>) {
    this.builder = builder;
  }

  where(column: string, value: unknown): RelationQuery {
    // Scope the parameter key under the builder alias so it never collides
    // with the same column name in a different subquery level.
    const key = `rq_${this.builder.alias}_${column}`;
    this.builder.andWhere(`${this.builder.alias}.${column} = :${key}`, { [key]: value });
    return this;
  }

  whereIn(column: string, values: readonly unknown[]): RelationQuery {
    const key = `rq_${this.builder.alias}_${column}`;
    this.builder.andWhere(`${this.builder.alias}.${column} IN (:...${key})`, {
      [key]: values,
    });
    return this;
  }

  whereNull(column: string): RelationQuery {
    this.builder.andWhere(`${this.builder.alias}.${column} IS NULL`);
    return this;
  }

  whereNotNull(column: string): RelationQuery {
    this.builder.andWhere(`${this.builder.alias}.${column} IS NOT NULL`);
    return this;
  }

  orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC'): RelationQuery {
    this.builder.addOrderBy(`${this.builder.alias}.${column}`, direction);
    return this;
  }

  limit(n: number): RelationQuery {
    this.builder.limit(n);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Mutating helpers (for ModelQuery and other callers that already own a builder)
// ---------------------------------------------------------------------------

/**
 * Add a `WHERE EXISTS` condition to an existing builder for the given relation.
 *
 * Validates the relation connectionlessly before touching the builder. The
 * builder's alias is used for correlation so it must match the alias used in
 * the subquery's entity reference — the default `'entity_'` is required.
 *
 * Throws {@link RelationError} when the builder alias is not `'entity_'`
 * (custom aliases cause silent correlation failures) or when the relation is
 * polymorphic.
 */
export function applyWhereHas<T extends object>(
  builder: SelectQueryBuilder<T>,
  entity: typeof BaseEntity,
  relation: string,
  predicate?: RelationPredicate,
): void {
  assertCorrelatableAlias(builder.alias);

  // Validate the relation BEFORE touching the builder so callers get
  // a clear, connectionless error for unsupported relation kinds.
  if (relation.includes('.')) {
    resolveRelationPath(entity, relation);
  } else {
    assertNotPolymorphic(resolveRelation(entity, relation));
  }

  if (relation.includes('.')) {
    builder.andWhere(buildNestedExistsCallback(builder.alias, entity, relation, predicate));
  } else {
    const rel = resolveRelation(entity, relation);
    builder.andWhere((qb) => buildExistsExpr(qb, builder.alias, entity, rel, predicate));
  }
}

/**
 * Add a `WHERE (SELECT COUNT(1) ...) <op> <count>` condition to an existing
 * builder for the given relation.
 *
 * Nested paths are rejected — counting across multiple hops does not map
 * cleanly to a scalar subquery.
 */
export function applyHas<T extends object>(
  builder: SelectQueryBuilder<T>,
  entity: typeof BaseEntity,
  relation: string,
  operator: '>' | '>=' | '=' | '<' | '<=',
  count: number,
): void {
  assertCorrelatableAlias(builder.alias);

  if (relation.includes('.')) {
    throw new RelationError('The "has" operator is not supported for nested relation paths');
  }

  assertNotPolymorphic(resolveRelation(entity, relation));
  const rel = resolveRelation(entity, relation);

  builder.andWhere((qb) => buildCountExpr(qb, builder.alias, entity, rel, operator, count));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Filter `entity` rows to those that have at least one related row matching
 * the optional predicate. Compiles to `WHERE EXISTS (SELECT 1 FROM <related>
 * WHERE <correlation> AND <predicate>)`.
 *
 * Supports nested paths (`a.b`): each hop adds a nested EXISTS subquery.
 * Polymorphic relations are rejected.
 */
export function whereHas<T extends object>(
  entity: typeof BaseEntity,
  relation: string,
  predicate?: RelationPredicate,
): SelectQueryBuilder<T> {
  // Validate BEFORE opening a repository so callers get a clear,
  // connectionless error — an unconnected entity (e.g. a polymorphic
  // relation without a DataSource) throws before getRepository().
  if (relation.includes('.')) {
    resolveRelationPath(entity, relation);
  } else {
    assertNotPolymorphic(resolveRelation(entity, relation));
  }

  const alias = 'entity_';
  const repo = entity.getRepository();
  const builder = repo.createQueryBuilder(alias) as SelectQueryBuilder<T>;
  applyWhereHas(builder, entity, relation, predicate);
  return builder;
}

/**
 * Filter `entity` rows where the COUNT of related rows satisfies a numeric
 * comparison. Compiles to `WHERE (SELECT COUNT(1) FROM <related> WHERE
 * <correlation>) <op> <count>`.
 *
 * Nested paths are rejected for `has` — the semantics of counting across
 * multiple hops do not map cleanly to a scalar subquery.
 */
export function has<T extends object>(
  entity: typeof BaseEntity,
  relation: string,
  operator: '>' | '>=' | '=' | '<' | '<=',
  count: number,
): SelectQueryBuilder<T> {
  if (relation.includes('.')) {
    throw new RelationError('The "has" operator is not supported for nested relation paths');
  }
  assertNotPolymorphic(resolveRelation(entity, relation));

  const alias = 'entity_';
  const repo = entity.getRepository();
  const builder = repo.createQueryBuilder(alias) as SelectQueryBuilder<T>;
  applyHas(builder, entity, relation, operator, count);
  return builder;
}

/**
 * Alias of `whereHas` with no predicate, for readability:
 * `exists(Post, 'comments')` is equivalent to `whereHas(Post, 'comments')`.
 */
export function exists<T extends object>(
  entity: typeof BaseEntity,
  relation: string,
  predicate?: RelationPredicate,
): SelectQueryBuilder<T> {
  return whereHas(entity, relation, predicate);
}

// ---------------------------------------------------------------------------
// Single-hop expression builders (called inside `.andWhere(callback)`)
// ---------------------------------------------------------------------------

const REL_ALIAS = '_rel';
const JT_ALIAS = 'jt';

function buildExistsExpr(
  rootQb: SelectQueryBuilder<any>,
  entityAlias: string,
  entity: typeof BaseEntity,
  rel: ResolvedRelation,
  predicate?: RelationPredicate,
): string {
  if (rel.through) {
    return buildThroughExistsExpr(rootQb, entityAlias, entity, rel, predicate);
  }

  if (rel.kind === 'many-to-many') {
    return buildM2mExistsExpr(rootQb, entityAlias, entity, rel, predicate);
  }

  const related = rel.targetEntity as typeof BaseEntity;
  const sub = rootQb.subQuery().select('1').from(related, REL_ALIAS);

  correlate(entityAlias, REL_ALIAS, entity, rel, sub);

  if (predicate) {
    predicate(new RelationQueryImpl(sub));
  }

  return `EXISTS ${sub.getQuery()}`;
}

function buildCountExpr(
  rootQb: SelectQueryBuilder<any>,
  entityAlias: string,
  entity: typeof BaseEntity,
  rel: ResolvedRelation,
  operator: string,
  count: number,
): string {
  if (rel.through) {
    return buildThroughCountExpr(rootQb, entityAlias, entity, rel, operator, count);
  }

  if (rel.kind === 'many-to-many') {
    return buildM2mCountExpr(rootQb, entityAlias, entity, rel, operator, count);
  }

  const related = rel.targetEntity as typeof BaseEntity;
  const sub = rootQb.subQuery().select('COUNT(1)').from(related, REL_ALIAS);

  correlate(entityAlias, REL_ALIAS, entity, rel, sub);

  return `(${sub.getQuery()}) ${operator} ${count}`;
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/**
 * Add the correlation WHERE clause to a subquery builder.
 * - M2O / O2O-owner: FK on entity → `related.<pk> = entity.<fk>`.
 * - O2M / O2O-inverse: FK on related → `related.<fk> = entity.<pk>`.
 */
function correlate(
  entityAlias: string,
  relatedAlias: string,
  entity: typeof BaseEntity,
  rel: ResolvedRelation,
  sub: SelectQueryBuilder<any>,
): void {
  const entityRepo = entity.getRepository();
  const entityPk = entityRepo.metadata.primaryColumns[0]!.propertyName;
  const relatedRepo = (rel.targetEntity as typeof BaseEntity).getRepository();
  const relatedPk = relatedRepo.metadata.primaryColumns[0]!.propertyName;

  if (rel.kind === 'many-to-one' || isOwningOneToOne(entity, rel)) {
    // FK is on the owning entity.
    const fkProp = dbColToProp(entityRepo, rel.joinColumn!);
    sub.where(`${relatedAlias}.${relatedPk} = ${entityAlias}.${fkProp}`);
  } else {
    // FK is on the related entity (O2M uses inverseJoinColumn;
    // O2O-inverse uses joinColumn resolved from the owning side).
    const fkDbName = rel.kind === 'one-to-many' ? rel.inverseJoinColumn! : rel.joinColumn!;
    const fkProp = dbColToProp(relatedRepo, fkDbName);
    sub.where(`${relatedAlias}.${fkProp} = ${entityAlias}.${entityPk}`);
  }
}

// ---------------------------------------------------------------------------
// M2M subquery builders
// ---------------------------------------------------------------------------

function buildM2mExistsExpr(
  rootQb: SelectQueryBuilder<any>,
  entityAlias: string,
  entity: typeof BaseEntity,
  rel: ResolvedRelation,
  predicate?: RelationPredicate,
): string {
  const jt = buildM2mSubquery(rootQb, entityAlias, entity, rel, '1');

  if (predicate) {
    predicate(new RelationQueryImpl(jt as SelectQueryBuilder<object>));
  }

  return `EXISTS ${jt.getQuery()}`;
}

function buildM2mCountExpr(
  rootQb: SelectQueryBuilder<any>,
  entityAlias: string,
  entity: typeof BaseEntity,
  rel: ResolvedRelation,
  operator: string,
  count: number,
): string {
  const jt = buildM2mSubquery(rootQb, entityAlias, entity, rel, 'COUNT(1)');
  return `(${jt.getQuery()}) ${operator} ${count}`;
}

/** Build the shared M2M subquery with a junction-table INNER JOIN. */
function buildM2mSubquery(
  rootQb: SelectQueryBuilder<any>,
  entityAlias: string,
  entity: typeof BaseEntity,
  rel: ResolvedRelation,
  sel: string,
): SelectQueryBuilder<any> {
  const junction = rel.junction!;
  const related = rel.targetEntity as typeof BaseEntity;
  const entityPk = entity.getRepository().metadata.primaryColumns[0]!.propertyName;
  const relatedPk = related.getRepository().metadata.primaryColumns[0]!.propertyName;

  return rootQb
    .subQuery()
    .select(sel)
    .from(related, REL_ALIAS)
    .innerJoin(
      junction.table,
      JT_ALIAS,
      `${REL_ALIAS}.${relatedPk} = ${JT_ALIAS}.${junction.inverseColumn}`,
    )
    .where(`${JT_ALIAS}.${junction.ownerColumn} = ${entityAlias}.${entityPk}`);
}

// ---------------------------------------------------------------------------
// Through-relation subquery builders ("has_many :through")
// ---------------------------------------------------------------------------

/**
 * Build an EXISTS subquery for a through relation. Treats the through entity's
 * table as a junction — the subquery joins target ─INNER JOIN─ through_table
 * ─WHERE through.sourceKey = entity.sourcePk.
 *
 * This is structurally identical to {@link buildM2mExistsExpr} but the
 * "junction" table is a real entity.
 */
function buildThroughExistsExpr(
  rootQb: SelectQueryBuilder<any>,
  entityAlias: string,
  entity: typeof BaseEntity,
  rel: ResolvedRelation,
  predicate?: RelationPredicate,
): string {
  const sub = buildThroughSubquery(rootQb, entityAlias, entity, rel, '1');

  if (predicate) {
    predicate(new RelationQueryImpl(sub as SelectQueryBuilder<object>));
  }

  return `EXISTS ${sub.getQuery()}`;
}

function buildThroughCountExpr(
  rootQb: SelectQueryBuilder<any>,
  entityAlias: string,
  entity: typeof BaseEntity,
  rel: ResolvedRelation,
  operator: string,
  count: number,
): string {
  const sub = buildThroughSubquery(rootQb, entityAlias, entity, rel, 'COUNT(1)');
  return `(${sub.getQuery()}) ${operator} ${count}`;
}

/** Build the shared through-relation subquery with an INNER JOIN on the through entity's table. */
function buildThroughSubquery(
  rootQb: SelectQueryBuilder<any>,
  entityAlias: string,
  entity: typeof BaseEntity,
  rel: ResolvedRelation,
  sel: string,
): SelectQueryBuilder<any> {
  const through = rel.through!;
  const related = rel.targetEntity as typeof BaseEntity;
  const entityPk = entity.getRepository().metadata.primaryColumns[0]!.propertyName;
  const relatedPk = related.getRepository().metadata.primaryColumns[0]!.propertyName;

  // Resolve the through entity's table name from TypeORM metadata.
  const throughTable = getThroughTableName(through);

  return rootQb
    .subQuery()
    .select(sel)
    .from(related, REL_ALIAS)
    .innerJoin(
      throughTable,
      JT_ALIAS,
      `${REL_ALIAS}.${relatedPk} = ${JT_ALIAS}.${through.targetKey}`,
    )
    .where(`${JT_ALIAS}.${through.sourceKey} = ${entityAlias}.${entityPk}`);
}

/**
 * Resolve the through entity's database table name from its class name via
 * TypeORM metadata storage. ThroughRelation.through stores the entity class
 * name, not the database table name.
 */
function getThroughTableName(through: ThroughRelation): string {
  const storage = getMetadataArgsStorage();
  const tableArg = storage.tables.find(
    (t) => typeof t.target === 'function' && t.target.name === through.through,
  );
  if (!tableArg) {
    throw new RelationError('Through entity table name could not be resolved');
  }

  const repo = (tableArg.target as typeof BaseEntity).getRepository();
  return repo.metadata.tableName;
}

// ---------------------------------------------------------------------------
// Nested path support
// ---------------------------------------------------------------------------

/**
 * Build a nested EXISTS expression callback for a dotted path (e.g.
 * `comments.author`). Returns a callback suitable for
 * `builder.andWhere(callback)`. Inside, recursively builds nested EXISTS
 * subqueries that correlate each hop to its parent alias.
 */
function buildNestedExistsCallback(
  entityAlias: string,
  entity: typeof BaseEntity,
  path: string,
  predicate?: RelationPredicate,
): (qb: SelectQueryBuilder<any>) => string {
  const segments = resolveRelationPath(entity, path);

  // Validate all segments upfront — each must be a supported, non-polymorphic
  // single-hop relation. M2M inside nested paths is rejected in v1.
  for (const seg of segments) {
    if (seg.kind === 'polymorphic') {
      throw new RelationError('Polymorphic relations are not supported by relation predicates');
    }
    if (seg.kind === 'many-to-many') {
      throw new RelationError('Many-to-many relations in nested paths are not yet supported');
    }
  }

  // The rootQb is the parent query builder passed by `.andWhere(callback)`.
  // All subQuery() calls from this function (and its recursive calls) share
  // the same rootQb's parameter collection, so nested subquery parameters
  // are correctly scoped.
  return (rootQb: SelectQueryBuilder<any>): string => {
    // buildHop returns the raw subquery expression; wrap it in EXISTS
    // so the outer condition is a proper boolean expression.
    return `EXISTS ${buildHop(rootQb, entityAlias, entity, segments, 0, predicate)}`;
  };
}

/**
 * Recursively build one level of the nested EXISTS chain.
 *
 * Each level creates a subquery that correlates to `outerAlias`. The leaf
 * applies the predicate; intermediate levels add a nested EXISTS subcondition.
 *
 * Returns the bare `getQuery()` string of the subquery (not wrapped with
 * `EXISTS` at this level — the caller at depth 0 wraps with `EXISTS`).
 * Inside intermediate hops, the result is passed to `sub.andWhere(nextExpr)`,
 * where TypeORM sees it as a raw subquery expression.
 */
function buildHop(
  rootQb: SelectQueryBuilder<any>,
  outerAlias: string,
  outerEntity: typeof BaseEntity,
  segments: ResolvedRelation[],
  depth: number,
  predicate?: RelationPredicate,
): string {
  const seg = segments[depth]!;
  const isLeaf = depth === segments.length - 1;
  const innerAlias = `_rel_d${depth}`;
  const related = seg.targetEntity as typeof BaseEntity;

  const sub = rootQb.subQuery().select('1').from(related, innerAlias);

  // Correlate to the parent alias.
  correlate(outerAlias, innerAlias, outerEntity, seg, sub);

  if (isLeaf) {
    if (predicate) {
      predicate(new RelationQueryImpl(sub));
    }
  } else {
    // Add a nested EXISTS: the inner hop's subquery becomes a WHERE
    // condition on this level's subquery. The inner hop returns its own
    // `getQuery()` string (SELECT 1 FROM ..., already correlated), which
    // this level wraps in EXISTS.
    const innerExpr = buildHop(rootQb, innerAlias, related, segments, depth + 1, predicate);
    sub.andWhere(`EXISTS ${innerExpr}`);
  }

  return sub.getQuery();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Translate a database column name (from `@JoinColumn`) to the ORM property name. */
function dbColToProp(
  repo: {
    metadata: { findColumnWithDatabaseName(n: string): { propertyName: string } | undefined };
  },
  dbName: string,
): string {
  const col = repo.metadata.findColumnWithDatabaseName(dbName);
  if (!col) {
    throw new RelationError('A relation foreign-key column could not be resolved');
  }
  return col.propertyName;
}

/** Whether a one-to-one is the owning side (has @JoinColumn on the entity table). */
function isOwningOneToOne(entity: typeof BaseEntity, rel: ResolvedRelation): boolean {
  if (rel.kind !== 'one-to-one') return false;
  try {
    return (
      entity.getRepository().metadata.findColumnWithDatabaseName(rel.joinColumn!) !== undefined
    );
  } catch {
    return false;
  }
}

function assertNotPolymorphic(rel: ResolvedRelation): void {
  if (rel.kind === 'polymorphic') {
    throw new RelationError('Polymorphic relations are not supported by relation predicates');
  }
}

/**
 * The EXISTS/COUNT subqueries correlate against the outer builder's alias, so
 * a custom alias would silently produce a subquery that references the wrong
 * table. Fail loud instead: only the default `'entity_'` alias is correlatable.
 */
function assertCorrelatableAlias(alias: string): void {
  if (alias !== 'entity_') {
    throw new RelationError('Relation predicates require the default query alias');
  }
}

// ---------------------------------------------------------------------------
// Relation aggregates (relationCount / relationAggregate)
// ---------------------------------------------------------------------------

/** Supported aggregate functions for relationAggregate. */
export type RelationAggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * Count related rows per parent. Returns a Map keyed by the parent's primary
 * key (serialized for composite keys) to the count. Parents with zero related
 * rows are absent from the map (callers default to 0).
 *
 * Issues exactly ONE GROUP BY query. Uses a LEFT JOIN so the `where` filter
 * applied to the relation does not exclude parents with no matching related
 * rows (they get count 0).
 *
 * Polymorphic relations and nested paths are rejected value-free.
 */
export async function relationCount(
  entity: typeof BaseEntity,
  relation: string,
  options?: { where?: Record<string, unknown> },
): Promise<Map<string, number>> {
  const rawRows = await runAggregateQuery(entity, relation, 'count', undefined, options);
  const map = new Map<string, number>();
  for (const row of rawRows) {
    const val = Number(row._val ?? 0);
    // COUNT on a LEFT JOIN returns 0 when the parent has no related rows.
    // Skip those entries so callers can distinguish "no rows" from "count is 0"
    // (the latter is impossible for COUNT but the semantic is useful for
    // general aggregate consistency).
    if (val !== 0) {
      map.set(row._key, val);
    }
  }
  return map;
}

/**
 * Aggregate a column over related rows per parent. `column` is required for
 * sum/avg/min/max; ignored for count.
 *
 * Issues exactly ONE GROUP BY query per call. Same LEFT JOIN semantics as
 * {@link relationCount}.
 *
 * Polymorphic relations and nested paths are rejected value-free.
 */
export async function relationAggregate(
  entity: typeof BaseEntity,
  relation: string,
  aggregate: RelationAggregate,
  column?: string,
  options?: { where?: Record<string, unknown> },
): Promise<Map<string, number>> {
  if (aggregate !== 'count' && !column) {
    throw new RelationError('A column name is required for sum, avg, min, and max aggregates');
  }

  const rawRows = await runAggregateQuery(entity, relation, aggregate, column, options);
  const map = new Map<string, number>();
  for (const row of rawRows) {
    // SUM/AVG/MIN/MAX return NULL on a LEFT JOIN when the parent has no related
    // rows. Skip those entries so parents with no related rows are absent from
    // the map, matching the relationCount contract.
    if (row._val != null) {
      map.set(row._key, Number(row._val));
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Aggregate query builder (internal)
// ---------------------------------------------------------------------------

interface AggregateRow {
  _key: string;
  _val: number | null;
}

/**
 * Build and execute a single GROUP BY query that computes an aggregate over
 * related rows, keyed by the parent entity's primary key.
 *
 * Strategy: query FROM the parent entity, LEFT JOIN the related entity (and
 * junction table for M2M), GROUP BY all parent PK columns, and SELECT the
 * aggregate expression. The LEFT JOIN ensures parents with no related rows
 * still appear in the result (with a NULL aggregate value, which is coerced
 * to 0 by the callers).
 *
 * When `where` is provided, the filter clauses are added as AND conditions
 * on the LEFT JOIN's ON clause so they only restrict which related rows are
 * counted, rather than excluding parent rows entirely.
 */
async function runAggregateQuery(
  entity: typeof BaseEntity,
  relation: string,
  aggregate: RelationAggregate,
  column: string | undefined,
  options?: { where?: Record<string, unknown> },
): Promise<AggregateRow[]> {
  if (relation.includes('.')) {
    throw new RelationError('Nested relation paths are not supported by relation aggregates');
  }

  const rel = resolveRelation(entity, relation);
  assertNotPolymorphic(rel);

  const parentRepo = entity.getRepository();
  const parentPkCols = parentRepo.metadata.primaryColumns.map((c) => c.propertyName);
  const relatedRepo = (rel.targetEntity as typeof BaseEntity).getRepository();
  const relatedPkCol = relatedRepo.metadata.primaryColumns[0]!.propertyName;

  const builder = parentRepo.createQueryBuilder('_p');

  // SELECT all parent PK columns (aliased for stable extraction) and the
  // aggregate expression.
  for (let i = 0; i < parentPkCols.length; i += 1) {
    builder.addSelect(`_p.${parentPkCols[i]!}`, `_pk${i}`);
    builder.addGroupBy(`_p.${parentPkCols[i]!}`);
  }

  const aggExpr = buildAggExpr('_r', aggregate, column, relatedPkCol);
  builder.addSelect(aggExpr, '_val');

  // Build LEFT JOIN and WHERE parameters based on relation kind.
  const whereClauses: string[] = [];
  const whereParams: Record<string, unknown> = {};

  if (options?.where) {
    for (const [key, value] of Object.entries(options.where)) {
      const paramName = `w_${key}`;
      whereClauses.push(`_r.${key} = :${paramName}`);
      whereParams[paramName] = value;
    }
  }

  const whereSuffix = whereClauses.length > 0 ? ` AND ${whereClauses.join(' AND ')}` : '';

  switch (rel.kind) {
    case 'many-to-one':
    case 'one-to-one': {
      // FK is on the parent entity. Correlate: _r.relatedPk = _p.fkProp.
      const owning = rel.kind === 'many-to-one' || isOwningOneToOne(entity, rel);
      if (owning) {
        const fkProp = dbColToProp(parentRepo, rel.joinColumn!);
        builder.leftJoin(
          rel.targetEntity as typeof BaseEntity,
          '_r',
          `_r.${relatedPkCol} = _p.${fkProp}${whereSuffix}`,
        );
      } else {
        // O2O inverse: FK column name on related entity.
        const fkProp = dbColToProp(relatedRepo, rel.joinColumn!);
        builder.leftJoin(
          rel.targetEntity as typeof BaseEntity,
          '_r',
          `_r.${fkProp} = _p.${parentPkCols[0]!}${whereSuffix}`,
        );
      }
      break;
    }

    case 'one-to-many': {
      // FK is on the related entity. Correlate: _r.fkProp = _p.parentPk.
      const fkProp = dbColToProp(relatedRepo, rel.inverseJoinColumn!);
      builder.leftJoin(
        rel.targetEntity as typeof BaseEntity,
        '_r',
        `_r.${fkProp} = _p.${parentPkCols[0]!}${whereSuffix}`,
      );
      break;
    }

    case 'many-to-many': {
      // Two LEFT JOINs: parent → junction → related.
      const junction = rel.junction!;
      // Junction table has no entity class, so we join on the raw table name
      // and use DB column names directly. The QueryBuilder quotes identifiers
      // per driver, making this portable.
      builder.leftJoin(
        junction.table,
        '_jt',
        `_jt.${junction.ownerColumn} = _p.${parentPkCols[0]!}`,
      );
      builder.leftJoin(
        rel.targetEntity as typeof BaseEntity,
        '_r',
        `_r.${relatedPkCol} = _jt.${junction.inverseColumn}${whereSuffix}`,
      );
      break;
    }

    default:
      throw new RelationError('Unsupported relation kind for aggregate queries');
  }

  if (Object.keys(whereParams).length > 0) {
    builder.setParameters(whereParams);
  }

  const rawRows: Record<string, unknown>[] = await builder.getRawMany();

  // Serialize each row's PK values into the map key using the same convention
  // as relation-loader.ts (String for single PK, JSON.stringify for composite).
  return rawRows.map((row) => {
    const pkValues: unknown[] = [];
    for (let i = 0; i < parentPkCols.length; i += 1) {
      pkValues.push(row[`_pk${i}`]);
    }
    return {
      _key: serializeValues(pkValues),
      _val: row._val as number | null,
    };
  });
}

/** Build a portable aggregate expression for the given function and column. */
function buildAggExpr(
  alias: string,
  aggregate: RelationAggregate,
  column: string | undefined,
  defaultColumn: string,
): string {
  const col = aggregate === 'count' ? defaultColumn : column!;
  return `${aggregate.toUpperCase()}(${alias}.${col})`;
}

/** Serialize single or composite PK values into a stable map key. */
function serializeValues(values: unknown[]): string {
  if (values.length === 1) {
    return String(values[0]);
  }
  return JSON.stringify(values);
}
