/**
 * `defineModel` — the single place JSails lowers a model spec onto TypeORM.
 *
 * A JSails model is authored as a plain class that declares only its shape. The
 * compiler derives a {@link ModelSpec} from that shape and emits a
 * `defineModel(Class, spec)` call into a generated registry. This function is
 * the **only** code that knows TypeORM exists: it applies TypeORM's own
 * decorator factories programmatically (the mechanism proven in the model
 * spike), then records the class and its derived lifecycle hooks in the JSails
 * model registry.
 *
 * Why invoke the decorator factories rather than hand-push metadata: the
 * factories are TypeORM's public, version-stable surface. They write into
 * TypeORM's global metadata storage exactly as a hand-written `@Column` would,
 * so migrations and `getModelSchema()` see a byte-identical portable schema.
 * Reverse-engineering the storage internals would break on any TypeORM bump.
 *
 * The spec is **pure data** — no TypeORM types, no class references except the
 * relation targets, which are the real classes the compiler imported. That keeps
 * the generated registry a plain data file and keeps every TypeORM decision
 * here, where it can be tested once.
 *
 * Server-only: reaches `reflect-metadata` and TypeORM.
 */

import 'reflect-metadata';

import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { belongs_to, has_many } from '../database/associations.js';
import { encrypts } from '../database/attribute-encryption.js';
import { registerModel } from '../database/model-registry.js';
import { resolveModelEncrypter } from '../encryption/model-encrypter.js';

import type { EntityHooksDefinition } from '../database/entity-subscribers.js';
import type { ObjectLiteral } from 'typeorm';

/** A scalar column kind, in portable TypeORM column-type terms. */
export type ModelColumnType = 'varchar' | 'text' | 'integer' | 'boolean' | 'datetime' | 'json';

/** A column in a {@link ModelSpec}. */
export interface ModelColumnSpec {
  /** The property name, e.g. `title`. */
  readonly name: string;
  readonly type: ModelColumnType;
  /** For `varchar`, the explicit length. */
  readonly length?: number;
  /** Whether the column accepts `null`. Defaults to `false`. */
  readonly nullable?: boolean;
  /** Whether the column carries a unique constraint. Defaults to `false`. */
  readonly unique?: boolean;
  /**
   * A prior column name (`@jsails.renamedFrom('old_name')`), carried as a
   * side-channel so the schema reconciler can emit a rename instead of drop+add.
   * Not part of the lowered TypeORM column — defineModel ignores it.
   */
  readonly renamedFrom?: string;
}

/** A relation in a {@link ModelSpec}. */
export interface ModelRelationSpec {
  readonly kind: 'many-to-one' | 'one-to-many';
  /** The property name, e.g. `author`. */
  readonly name: string;
  /** The related class. */
  readonly target: new () => ObjectLiteral;
  /** For `many-to-one`, the FK column name, e.g. `author_id`. */
  readonly joinColumn?: string;
  /** For `many-to-one`, whether the FK accepts `null`. Defaults to `false`. */
  readonly nullable?: boolean;
  /** For `one-to-many`, the inverse property name on the target. */
  readonly inverse?: string;
  /** For `many-to-one`, touch the parent's `updated_at` on child change. */
  readonly touch?: boolean;
  /** For `one-to-many`, maintain a `<name>_count` counter cache. */
  readonly counterCache?: boolean;
  /**
   * A prior FK column name (`@jsails.renamedFrom('old_name')`); applies to the
   * derived FK column, not the relation property.
   */
  readonly renamedFrom?: string;
}

/** The primary key of a {@link ModelSpec}. */
export interface ModelPrimaryKeySpec {
  /** The property name, e.g. `id`. */
  readonly name: string;
  /** Only a generated integer key is supported in v1. */
  readonly kind: 'integer';
}

/** The full shape of a model, as derived by the compiler. */
export interface ModelSpec {
  /** The table name, e.g. `post`. */
  readonly table: string;
  readonly primaryKey: ModelPrimaryKeySpec;
  readonly columns: readonly ModelColumnSpec[];
  readonly relations: readonly ModelRelationSpec[];
  /**
   * The names of fields marked `@jsails.encrypts()`. When non-empty,
   * `defineModel` wires the encryption hook for exactly this set, resolving the
   * encrypter from the environment (`JSAILS_ENCRYPTION_KEY`).
   */
  readonly encrypted?: readonly string[];
}

/** Raised for an invalid model spec. Messages are value-free. */
export class ModelDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDefinitionError';
  }
}

/**
 * Lower a model spec onto TypeORM and register the class.
 *
 * Applies the entity, primary-key, column, and relation decorators in the order
 * TypeORM requires (relations before the hook factories that validate them),
 * derives the lifecycle hooks from relation behaviour flags, and records the
 * class in the JSails model registry. Idempotent per class via
 * {@link registerModel}.
 */
export function defineModel<T extends ObjectLiteral>(entity: new () => T, spec: ModelSpec): void {
  assertSpec(spec);

  Entity(spec.table)(entity);
  PrimaryGeneratedColumn()(entity.prototype, spec.primaryKey.name);

  for (const column of spec.columns) {
    Column(columnOptions(column))(entity.prototype, column.name);
  }

  const hooks: EntityHooksDefinition<ObjectLiteral>[] = [];

  for (const relation of spec.relations) {
    if (relation.kind === 'many-to-one') {
      ManyToOne(() => relation.target, { nullable: relation.nullable ?? false })(
        entity.prototype,
        relation.name,
      );
      JoinColumn({ name: relation.joinColumn ?? `${relation.name}_id` })(
        entity.prototype,
        relation.name,
      );
      if (relation.touch === true) {
        hooks.push(...belongs_to(entity, relation.name, { touch: true }));
      }
    } else {
      OneToMany(() => relation.target, relation.inverse ?? defaultInverse(relation.name))(
        entity.prototype,
        relation.name,
      );
      if (relation.counterCache === true) {
        hooks.push(...has_many(entity, relation.name, { counter_cache: true }));
      }
    }
  }

  // Encryption is a declaration on the model; the encrypter is resolved from the
  // environment because this runs before any extension `setup`. A keyless
  // deployment gets a sentinel that fails at first use, never a plaintext write.
  if (spec.encrypted !== undefined && spec.encrypted.length > 0) {
    hooks.push(encrypts(entity, resolveModelEncrypter(), spec.encrypted));
  }

  registerModel(entity, hooks, spec);
}

/** Build the TypeORM column options for a spec column. */
function columnOptions(column: ModelColumnSpec): {
  type: ModelColumnType;
  length?: number;
  nullable: boolean;
  unique: boolean;
} {
  const options: {
    type: ModelColumnType;
    length?: number;
    nullable: boolean;
    unique: boolean;
  } = {
    type: column.type,
    nullable: column.nullable ?? false,
    unique: column.unique ?? false,
  };
  if (column.type === 'varchar' && column.length !== undefined) {
    options.length = column.length;
  }
  return options;
}

/**
 * The conventional inverse property name for a one-to-many relation: the
 * singular of the relation name (`comments` → `comment`). The compiler always
 * emits an explicit `inverse` when it can resolve one; this is the fallback.
 */
function defaultInverse(name: string): string {
  return name.endsWith('s') ? name.slice(0, -1) : name;
}

/** Reject a malformed spec before any decorator runs. */
function assertSpec(spec: ModelSpec): void {
  if (typeof spec.table !== 'string' || spec.table.length === 0) {
    throw new ModelDefinitionError('defineModel: table name is required');
  }
  if (spec.primaryKey.kind !== 'integer') {
    throw new ModelDefinitionError(
      'defineModel: only a generated integer primary key is supported',
    );
  }
  const columnNames = new Set(spec.columns.map((column) => column.name));
  for (const column of spec.columns) {
    if (column.type === 'varchar' && column.length === undefined) {
      throw new ModelDefinitionError('defineModel: varchar columns require an explicit length');
    }
  }
  for (const field of spec.encrypted ?? []) {
    // An encrypted field names a scalar column; a typo would otherwise build a
    // hook that silently never fires.
    if (!columnNames.has(field)) {
      throw new ModelDefinitionError(
        `defineModel: encrypted field '${field}' is not a column of '${spec.table}'`,
      );
    }
  }
  for (const relation of spec.relations) {
    if (relation.kind === 'many-to-one' && relation.joinColumn === undefined) {
      // The FK column is derived; a missing one is fine, but the target must exist.
      if (typeof relation.target !== 'function') {
        throw new ModelDefinitionError('defineModel: relation target must be a class');
      }
    }
  }
}
