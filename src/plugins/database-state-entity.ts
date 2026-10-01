/**
 * The framework-owned entity for database-managed plugin state.
 *
 * {@link JsailsPluginState} is the single source of truth for the
 * `jsails_plugin_state` table JSails reserves for managed plugin state. It is a
 * plain Active Record entity — a generated integer primary key plus five scalar
 * columns — that the portable schema model accepts, so an app registers it with
 * its `JsailsDataSource` and creates the table through the normal
 * `makemigrations`/`migrate` history, never through runtime DDL.
 *
 * `updatedAt` has no database default and no `@CreateDateColumn`; the database
 * store sets it from application code on every write. `settings` is a nullable
 * text column holding the plugin's JSON-encoded settings object (`null` when
 * unset); the database store owns its parse/serialize round-trip.
 */

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Table JSails reserves for database-managed plugin state. */
export const PLUGIN_STATE_TABLE = 'jsails_plugin_state';

/** `jsails_plugin_state.pluginId` column width. */
export const PLUGIN_ID_COLUMN_LENGTH = 190;

/** `jsails_plugin_state.activeVersion` column width. */
export const ACTIVE_VERSION_COLUMN_LENGTH = 64;

@Entity(PLUGIN_STATE_TABLE)
export class JsailsPluginState extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: PLUGIN_ID_COLUMN_LENGTH, nullable: false })
  pluginId!: string;

  @Column({ type: 'varchar', length: ACTIVE_VERSION_COLUMN_LENGTH, nullable: false })
  activeVersion!: string;

  @Column({ type: 'boolean', nullable: false })
  enabled!: boolean;

  @Column({ type: 'text', nullable: true })
  settings!: string | null;

  @Column({ type: 'datetime', nullable: false })
  updatedAt!: Date;
}

/**
 * The entities an app must include in its `JsailsDataSource` `entities` list
 * when it manages plugin state in the database.
 */
export const pluginStateEntities = [JsailsPluginState];
