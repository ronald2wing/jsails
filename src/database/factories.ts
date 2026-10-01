/**
 * Deterministic attribute factories for seeding entities.
 *
 * {@link defineFactory} pairs an entity with a generator that turns a 1-based
 * sequence counter (and any overrides) into partial attributes. {@link
 * EntityFactory.build} assembles those attributes without touching the
 * database; {@link EntityFactory.create} persists them through the entity's
 * repository on an explicitly supplied, initialized data source.
 *
 * ```ts
 * import { defineFactory } from 'jsails';
 *
 * const users = defineFactory(User, (sequence, overrides) => ({
 *   name: `user-${sequence}`,
 *   active: true,
 * }));
 *
 * users.build(3);                                   // three un-persisted objects
 * await users.create(3, { active: false }, { dataSource }); // three saved rows
 * ```
 *
 * Sequences are deterministic and stateless: every `build`/`create` call runs
 * the generator once per produced entity with counters `1..count`, independent
 * of any previous call. Overrides are applied on top of the generated
 * attributes (so an override always wins) and are also passed to the generator,
 * which may derive a value from an overridden field (e.g. an email from a
 * name). All validation failures raise value-free {@link FactoryError}s.
 */

import { DataSource, EntitySchema } from 'typeorm';
import type { DeepPartial, EntityTarget, ObjectLiteral } from 'typeorm';

/** Raised for an invalid factory declaration, count, overrides, or data source. */
export class FactoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryError';
  }
}

/**
 * Produces the base partial attributes for one entity at the given 1-based
 * sequence position. `overrides` is the same object passed to `build`/`create`,
 * so a generator may derive one field from an overridden one; the factory
 * applies the overrides again on top, so they always win.
 */
export type FactoryGenerator<Entity extends ObjectLiteral> = (
  sequence: number,
  overrides: Partial<Entity>,
) => Partial<Entity>;

/** Options for {@link EntityFactory.create}. */
export interface EntityFactoryCreateOptions {
  /** The initialized data source whose repository persists the built entities. */
  dataSource: DataSource;
}

/**
 * A bound factory: an entity plus its generator, exposing the stateless
 * `build` (no database) and `create` (persists) operations.
 */
export interface EntityFactory<Entity extends ObjectLiteral> {
  /** The entity target the factory builds. */
  readonly entity: EntityTarget<Entity>;

  /**
   * Assemble `count` attribute objects (default 1) without touching the
   * database. The returned objects are plain data, not bound entity instances:
   * they carry no generated id and are never persisted.
   */
  build(count?: number, overrides?: Partial<Entity>): Partial<Entity>[];

  /**
   * Build and persist `count` entities through the data source's repository
   * (which fires the entity's insert hooks). Requires an initialized data
   * source, passed explicitly; a missing or uninitialized source is rejected
   * with a {@link FactoryError}.
   */
  create(
    count?: number,
    overrides?: Partial<Entity>,
    options?: EntityFactoryCreateOptions,
  ): Promise<Entity[]>;
}

/**
 * Define a factory for one entity. The generator runs once per produced entity
 * and must return a plain object of partial attributes; the caller supplies any
 * remaining required columns through overrides (or the generator itself).
 */
export function defineFactory<Entity extends ObjectLiteral>(
  entity: EntityTarget<Entity>,
  generator: FactoryGenerator<Entity>,
): EntityFactory<Entity> {
  assertEntityTarget(entity);
  if (typeof generator !== 'function') {
    throw new FactoryError('defineFactory: "generator" must be a function');
  }

  return {
    entity,

    build(count = 1, overrides = {}): Partial<Entity>[] {
      return assemble(count, overrides, generator);
    },

    async create(
      count = 1,
      overrides = {},
      options?: EntityFactoryCreateOptions,
    ): Promise<Entity[]> {
      const attributes = assemble(count, overrides, generator);
      const dataSource = assertInitializedDataSource(options?.dataSource);
      const saved = await dataSource
        .getRepository(entity)
        .save(attributes as DeepPartial<Entity>[]);
      return saved as Entity[];
    },
  };
}

/** Run the generator `count` times, applying overrides last on each result. */
function assemble<Entity extends ObjectLiteral>(
  count: number,
  overrides: Partial<Entity>,
  generator: FactoryGenerator<Entity>,
): Partial<Entity>[] {
  assertCount(count);
  assertOverrides(overrides);
  const built: Partial<Entity>[] = [];
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const generated = generator(sequence, overrides);
    if (generated === null || typeof generated !== 'object' || Array.isArray(generated)) {
      throw new FactoryError(
        `factory generator returned ${describe(generated)}; expected a plain object of attributes`,
      );
    }
    built.push({ ...generated, ...overrides });
  }
  return built;
}

function assertCount(count: unknown): asserts count is number {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new FactoryError(`factory count must be a non-negative integer, got ${describe(count)}`);
  }
}

function assertOverrides(overrides: unknown): void {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new FactoryError('factory overrides must be a plain object');
  }
}

function assertInitializedDataSource(dataSource: unknown): DataSource {
  if (!(dataSource instanceof DataSource)) {
    throw new FactoryError('factory.create requires an initialized TypeORM DataSource');
  }
  if (!dataSource.isInitialized) {
    throw new FactoryError(
      'factory.create requires an initialized data source (call initialize() first)',
    );
  }
  return dataSource;
}

function assertEntityTarget(entity: unknown): asserts entity is EntityTarget<ObjectLiteral> {
  const valid =
    typeof entity === 'function' ||
    typeof entity === 'string' ||
    entity instanceof EntitySchema ||
    (typeof entity === 'object' &&
      entity !== null &&
      typeof (entity as { name?: unknown }).name === 'string');
  if (!valid) {
    throw new FactoryError(
      'defineFactory: "entity" must be a class, an EntitySchema, or an entity name',
    );
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.prototype.toString.call(value);
  }
  return String(value);
}
