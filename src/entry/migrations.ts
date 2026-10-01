// Scalar, linear schema-history migrations: portable schema state, operation
// metadata, history replay, autodetection, and the apply/rollback runner.
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
} from '../migrations/schema-state.js';

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
  replayMigrationHistory,
  type MigrationDefinition,
  type MigrationHistory,
} from '../migrations/history.js';

export {
  generateMigration,
  type AutodetectOptions,
  type ColumnRenameHint,
  type TableRenameHint,
} from '../migrations/autodetector.js';

export {
  migrate,
  getMigrationStatus,
  rollbackTo,
  type MigrationDataSource,
  type MigrationRunResult,
  type MigrationRollbackResult,
  type MigrationStatus,
  type RollbackOptions,
} from '../migrations/migrator.js';

export {
  defineDataMigration,
  createDataMigrationRegistry,
  type DataMigration,
  type DataMigrationContext,
} from '../migrations/data.js';

export { squashMigrations, type SquashOptions } from '../migrations/squash.js';
