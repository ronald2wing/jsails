/**
 * Models subpath (`jsails/models`): the one-import surface for authoring a
 * JSails model.
 *
 * A model is a class that declares only the shape of its data. The compiler
 * derives the table, columns, foreign keys, and migrations from that shape, so
 * the user writes no TypeORM:
 *
 * ```ts
 * import { ApplicationRecord } from 'jsails/models';
 *
 * export class Post extends ApplicationRecord {
 *   declare title: string;
 *   declare published: boolean;
 *   declare author: Author;      // -> many-to-one; column author_id -> author
 *   declare comments: Comment[]; // -> one-to-many (inverse)
 * }
 * ```
 *
 * Customize a field with an inline `@jsails.*` decorator when inference cannot
 * know the intent (`@jsails.maxLength(200)`, `@jsails.unique()`,
 * `@jsails.nullable()`, `@jsails.encrypts()`, or a relation behaviour such as
 * `@jsails.belongsTo(Author, { touch: true })`). The compiler folds the class
 * shape into a spec and emits a `defineModel(Class, spec)` call into a generated
 * registry; `defineModel` is the only place the TypeORM factory sequence lives.
 *
 * This barrel is deliberately a **convenience re-export**, not a wrapper: every
 * value re-exported here is the *same* function reference the originating
 * library (`typeorm`) or module (the `jsails/database` internals) exports, with
 * no added semantics and no behavior change. It is server-only — it reaches
 * `reflect-metadata` and TypeORM, so it must never be imported by a
 * browser-safe entry (`jsails/api`, `jsails/client`, `jsails/theme`).
 *
 * Note: JSails is therefore semver-coupled to TypeORM's decorator surface. A
 * breaking TypeORM decorator change is a breaking JSails change; track TypeORM's
 * changelog when bumping it.
 */
import 'reflect-metadata';

// --- Active Record base ------------------------------------------------------

export { BaseEntity } from 'typeorm';
export { ApplicationRecord } from '../database/application-record.js';
export {
  registerModel,
  registeredModels,
  clearModelRegistry,
  type RegisteredModel,
} from '../database/model-registry.js';

// --- Compiler-emitted model lowering -----------------------------------------

export {
  defineModel,
  ModelDefinitionError,
  type ModelColumnSpec,
  type ModelColumnType,
  type ModelPrimaryKeySpec,
  type ModelRelationSpec,
  type ModelSpec,
} from './define-model.js';

export { bootstrapModels, type BootstrapModelsOptions } from './bootstrap.js';

// --- TypeORM value decorators (same references, no wrapper) ------------------

// Column kinds. The option *interfaces* are re-exported as types below so this
// barrel stays clean under `verbatimModuleSyntax` / `isolatedModules`.
export { Column, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
export { CreateDateColumn, UpdateDateColumn, DeleteDateColumn } from 'typeorm';
export { Entity, ChildEntity, ViewEntity } from 'typeorm';
export { OneToOne, OneToMany, ManyToOne, ManyToMany, JoinColumn, JoinTable } from 'typeorm';

// --- TypeORM option types (type-only; no runtime value) ----------------------

export type { ColumnOptions, ColumnType, EntityOptions } from 'typeorm';

// --- JSails declarative model DSL --------------------------------------------

export {
  belongs_to,
  has_many,
  has_one,
  accepts_nested_attributes_for,
  type BelongsToOptions,
  type HasManyOptions,
  type HasOneOptions,
} from '../database/associations.js';

export {
  delegate,
  DelegateError,
  type DelegateMethods,
  type DelegateOptions,
} from '../database/delegate.js';

export { encrypts, type EncryptsOptions } from '../database/attribute-encryption.js';

// Active Record ergonomics.
export { changed, was, savedChanges, defineDirtyTracking } from '../database/dirty.js';
export {
  defineEnum,
  enumIs,
  enumIn,
  enumScope,
  enumWhere,
  enumWhereIn,
  applyEnumChecks,
  EnumError,
  type EnumDefinition,
  type EnumOptions,
} from '../database/enum.js';
export {
  scope,
  resolveScope,
  applyScope,
  ScopeError,
  type ScopeFunction,
} from '../database/scopes.js';

// --- Runtime `jsails` decorator namespace ------------------------------------

// Importing this re-export installs `globalThis.jsails`, so the ambient
// `@jsails.*` decorators a model author writes with no import resolve at
// runtime. The factories are inert markers; the compiler does the lowering.
export {
  jsails,
  installJsailsGlobal,
  type JsailsNamespace,
  type JsailsRelationOptions,
  type JsailsRelationTarget,
} from '../internal/jsails-namespace.js';
