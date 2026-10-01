// Declarative desired-state schema engine: portable schema state, operations,
// autodetection, reconciliation, and the schema-plan executor.
export {
  MigrationError,
  type ScalarColumnType,
  type ScalarLiteral,
  type ColumnDefinition,
  type Deferrable,
  type ForeignKeyAction,
  type ForeignKeyDefinition,
  type IndexDefinition,
  type TableDefinition,
  type UniqueDefinition,
  type SchemaState,
} from '../migrations/schema-types.js';

export type {
  CreateTableOperation,
  DropTableOperation,
  AddColumnOperation,
  DropColumnOperation,
  RenameColumnOperation,
  RenameTableOperation,
  AlterColumnOperation,
  AlterInheritanceOperation,
  AlterPolymorphicOperation,
  AddIndexOperation,
  DropIndexOperation,
  AddUniqueOperation,
  DropUniqueOperation,
  AddForeignKeyOperation,
  DropForeignKeyOperation,
  Operation,
} from '../migrations/operations.js';

export {
  diffSchemaStates,
  type AutodetectOptions,
  type ColumnRenameHint,
  type TableRenameHint,
} from '../migrations/autodetector.js';

export { buildSchemaPlan, reconcileDataSource, type SchemaPlan } from '../migrations/reconciler.js';

export { executeSchemaPlan } from '../migrations/schema-executor.js';

export {
  defineDataMigration,
  createDataMigrationRegistry,
  type DataMigration,
  type DataMigrationContext,
} from '../migrations/data.js';
