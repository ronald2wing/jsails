/**
 * The framework-owned entity for database-backed feature flags, plus the
 * database-backed {@link FeatureStore}.
 *
 * {@link JsailsFeatureFlag} is the single source of truth for the
 * `jsails_feature_flag` table JSails reserves for persisted flags. It is a plain
 * Active Record entity — a generated integer primary key plus four scalar
 * columns — that the portable schema model accepts, so an app registers it with
 * its `JsailsDataSource` and creates the table through the normal
 * `makemigrations`/`migrate` history, never through runtime DDL.
 *
 * `scope` is stored as the empty string for the global scope (so every lookup
 * is a plain equality, never an `IS NULL`), and `value` holds the boolean
 * active/inactive state. `updatedAt` has no database default and no
 * `@CreateDateColumn`; the store sets it from application code on every write.
 *
 * {@link createDatabaseFeatureFlagStore} persists flags through the injected
 * TypeORM `DataSource`'s repository — no raw SQL and no runtime DDL. The table
 * must already exist: a missing table fails with a clear, value-free
 * {@link FeatureFlagError} telling the caller to run those commands; the store
 * never creates it. A data source that is not initialized fails with a clear
 * error before any repository query runs.
 */

import type { DataSource } from 'typeorm';
import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import {
  FeatureFlagError,
  FLAG_KEY_MAX_LENGTH,
  FLAG_SCOPE_MAX_LENGTH,
  assertFlagKey,
  assertFlagScope,
  type FeatureStore,
} from './flags.js';

/** Table JSails reserves for database-backed feature flags. */
export const FEATURE_FLAG_TABLE = 'jsails_feature_flag';

@Entity(FEATURE_FLAG_TABLE)
export class JsailsFeatureFlag extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: FLAG_KEY_MAX_LENGTH, nullable: false })
  key!: string;

  @Column({ type: 'varchar', length: FLAG_SCOPE_MAX_LENGTH, nullable: false })
  scope!: string;

  @Column({ type: 'boolean', nullable: false })
  value!: boolean;

  @Column({ type: 'datetime', nullable: false })
  updatedAt!: Date;
}

/**
 * The entities an app must include in its `JsailsDataSource` `entities` list
 * when it persists feature flags in the database.
 */
export const featureFlagEntities = [JsailsFeatureFlag];

/** Options for {@link createDatabaseFeatureFlagStore}. */
export interface DatabaseFeatureFlagStoreOptions {
  /** The initialized TypeORM data source backing feature flags. */
  readonly dataSource: DataSource;
}

/** The column value for the global scope: the empty string, never `null`. */
function scopeColumn(scope: string | undefined): string {
  return scope ?? '';
}

/**
 * Build a database-backed {@link FeatureStore} over an initialized TypeORM data
 * source. The `jsails_feature_flag` table must already exist (created by the
 * migration history). See the module doc for the exact contract.
 */
export function createDatabaseFeatureFlagStore(
  options: DatabaseFeatureFlagStoreOptions,
): FeatureStore {
  const dataSource = options.dataSource;
  const repository = dataSource.getRepository(JsailsFeatureFlag);

  /** Fail with a clear error when the table is missing; never create it. */
  async function assertTableExists(): Promise<void> {
    if (!dataSource.isInitialized) {
      throw new FeatureFlagError('the feature flag data source must be initialized');
    }
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      if (!(await queryRunner.hasTable(FEATURE_FLAG_TABLE))) {
        throw new FeatureFlagError(
          'the jsails_feature_flag table does not exist; run makemigrations and migrate to create it',
        );
      }
    } finally {
      await queryRunner.release();
    }
  }

  async function get(key: string, scope?: string): Promise<boolean | null> {
    assertFlagKey(key);
    assertFlagScope(scope);
    await assertTableExists();
    const row = await repository.findOneBy({ key, scope: scopeColumn(scope) });
    return row === null ? null : row.value;
  }

  async function set(key: string, value: boolean, scope?: string): Promise<void> {
    assertFlagKey(key);
    assertFlagScope(scope);
    if (typeof value !== 'boolean') {
      throw new FeatureFlagError('a feature flag value must be a boolean');
    }
    await assertTableExists();
    const columnScope = scopeColumn(scope);
    await dataSource.transaction(async (manager) => {
      const transactionRepository = manager.getRepository(JsailsFeatureFlag);
      const existing = await transactionRepository.findOneBy({ key, scope: columnScope });
      if (existing !== null) {
        existing.value = value;
        existing.updatedAt = new Date();
        await transactionRepository.save(existing);
        return;
      }
      await transactionRepository.save(
        transactionRepository.create({ key, scope: columnScope, value, updatedAt: new Date() }),
      );
    });
  }

  async function remove(key: string, scope?: string): Promise<void> {
    assertFlagKey(key);
    assertFlagScope(scope);
    await assertTableExists();
    await repository.delete({ key, scope: scopeColumn(scope) });
  }

  async function all(scope?: string): Promise<Record<string, boolean>> {
    assertFlagScope(scope);
    await assertTableExists();
    const rows = await repository.findBy({ scope: scopeColumn(scope) });
    const result: Record<string, boolean> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  return { get, set, delete: remove, all };
}
