/**
 * Database subpath (`jsails/database`): the TypeORM Active Record data layer
 * plus the first-party `database` plugin.
 *
 * This barrel re-exports the entire data surface — entity hooks/subscribers,
 * factories, polymorphic relations, relation metadata/loader/query helpers, and
 * seeders — so `jsails/database` is self-contained. A consumer importing only
 * this subpath (not the root entry) gets decorator metadata through the
 * `reflect-metadata` side-effect import below.
 */
import 'reflect-metadata';

export { BaseEntity } from 'typeorm';

export {
  JsailsDataSource,
  type JsailsDataSourceOptions,
  type JsailsSupportedDriver,
} from './data-source.js';

export { databasePlugin, databaseToken, type DatabasePluginOptions } from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { databasePlugin as default } from './plugin.js';

export { UnsupportedSchemaError } from './model-schema.js';

export {
  FileDataSource,
  FileDataSourceError,
  type FileDataSourceEntity,
  type FileDataSourceModel,
  type FileDataSourceOptions,
} from './file-data-source.js';

export {
  createEntitySubscriber,
  defineEntityHooks,
  EntityHooksError,
  type EntityHook,
  type EntityHookContext,
  type EntityHookEvent,
  type EntityHooks,
  type EntityHooksDefinition,
  type EntitySubscriberClass,
} from './entity-subscribers.js';

export {
  assertEntityValid,
  defineEntityValidation,
  entityValidationHooks,
  EntityValidationError,
  validateEntity,
  type EntityValidation,
} from './entity-validation.js';

export {
  defineFactory,
  FactoryError,
  type EntityFactory,
  type EntityFactoryCreateOptions,
  type FactoryGenerator,
} from './factories.js';

export {
  PolymorphicRelation,
  loadPolymorphic,
  loadPolymorphicInverse,
  resolvePolymorphicTarget,
  resolvePolymorphicInverse,
  type PolymorphicDescriptor,
} from './polymorphic.js';

export {
  RelationError,
  resolveRelation,
  resolveRelationPath,
  type ResolvedRelation,
} from './relation-metadata.js';

export {
  loadRelation,
  loadRelations,
  type RelationLoadOptions,
  type LoadRelationsOptions,
  type RelationLoadSpec,
} from './relation-loader/index.js';

export {
  whereHas,
  has,
  exists,
  relationCount,
  relationAggregate,
  type RelationPredicate,
  type RelationQuery,
  type RelationAggregate,
} from './relation-query.js';

export {
  addCaseSelect,
  and,
  applyQ,
  Case,
  caseWhen,
  F,
  not,
  or,
  q,
  qEq,
  qGt,
  qGte,
  qIn,
  qIsNull,
  qLike,
  qLt,
  qLte,
  qNe,
  qNotIn,
  qNotNull,
  QueryExpressionError,
  when,
  type Q,
  type QLeaf,
  type QNode,
  type QOperator,
  type When,
} from './query-expressions.js';

export { ModelQuery, ModelQueryError, query, type ModelQueryOptions } from './model-query.js';

export {
  defineSeeder,
  createSeederRegistry,
  runSeeders,
  SeederError,
  type Seeder,
  type SeederContext,
  type SeederRegistry,
  type SeederRun,
  type SeederRunOptions,
} from './seeders.js';

export {
  transaction,
  TransactionError,
  type TransactionBody,
  type TransactionCallback,
  type TransactionHandle,
} from './transaction.js';

// Data-layer breadth: Rails-style declarative model DSL.
export {
  accepts_nested_attributes_for,
  belongs_to,
  has_many,
  has_one,
  AssociationError,
  type BelongsToOptions,
  type HasManyOptions,
  type HasOneOptions,
} from './associations.js';

// Data-layer breadth: Rails-style `delegate` — forward properties through a relation.
export { delegate, DelegateError, type DelegateMethods, type DelegateOptions } from './delegate.js';

// Data-layer breadth: hook bridges over the entity-subscriber seam.
export { encrypts, type EncryptsOptions } from './attribute-encryption.js';

export {
  counterCache,
  touch,
  autosave,
  nestedAttributes,
  CounterCacheError,
} from './counter-cache.js';

// Data-layer breadth: has_many/has_one :through resolution.
export { resolveThroughRelation, type ThroughRelation } from './through-relations.js';

// Data-layer breadth: Active Storage attachments over the filesystem Disk seam.
export {
  hasOneAttached,
  ActiveStorageError,
  JsailsAttachment,
  activeStorageEntities,
  type Attachment,
  type HasOneAttachedOptions,
} from './active-storage.js';

// Data-layer breadth: fixtures + transactional test rollback.
export {
  defineFixture,
  loadFixtures,
  withRollback,
  FixtureError,
  type Fixture,
} from './fixtures.js';

// Data-layer breadth: connectionless system-checks framework (Django `check`).
export {
  createSystemCheckRegistry,
  defineSystemCheck,
  SystemCheckError,
  type CheckSeverity,
  type SystemCheck,
  type SystemCheckContext,
  type SystemCheckFn,
  type SystemCheckRegistry,
} from './system-checks.js';
