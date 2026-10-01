/**
 * First-party `database` plugin: exposes an application {@link JsailsDataSource}
 * under a typed service token without owning the connection lifecycle by
 * default.
 *
 * `databasePlugin({ dataSource, initialize? })` builds a {@link JsailsPlugin}
 * named `database` whose `setup` provides the data source under
 * {@link databaseToken}. By default it does **not** connect at setup: the
 * caller (an API handler, a migration step, another extension) initializes the
 * data source lazily through `dataSource.initialize()`. Set `initialize: true`
 * to connect during setup instead.
 *
 * The teardown destroys the data source only when it is initialized, and is
 * idempotent: an already-destroyed (or never-initialized) source is left
 * untouched, and a second teardown is a no-op. A data source that was never
 * provided is rejected at construction with a value-free `TypeError`.
 *
 * Only the data source type is imported (`import type`), so this module pulls
 * in no TypeORM runtime — TypeORM's `DataSource` is already loaded by whichever
 * module constructed the injected source.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { JsailsDataSource } from './data-source.js';

/**
 * Opaque token for the application {@link JsailsDataSource}. Defined once here
 * and shared by the provider (`databasePlugin`) and any consumer.
 */
export const databaseToken: ServiceToken<JsailsDataSource> =
  createServiceToken<JsailsDataSource>('database');

/** Options accepted by {@link databasePlugin}. */
export interface DatabasePluginOptions {
  /** The application data source to expose; never constructed by the plugin. */
  readonly dataSource: JsailsDataSource;
  /** Connect during `setup`. Defaults to `false` (callers initialize lazily). */
  readonly initialize?: boolean;
}

/**
 * Build the first-party `database` plugin. Nothing connects at construction;
 * whether `setup` connects depends on `initialize`.
 */
export function databasePlugin(options: DatabasePluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('databasePlugin requires an options object');
  }
  const dataSource = options.dataSource;
  if (dataSource === null || dataSource === undefined) {
    throw new TypeError('databasePlugin requires a dataSource');
  }

  return definePlugin({
    name: 'database',
    async setup({ services }) {
      if (options.initialize === true) {
        await dataSource.initialize();
      }
      services.provide(databaseToken, dataSource);

      let destroyed = false;
      return async () => {
        if (destroyed || !dataSource.isInitialized) {
          return;
        }
        destroyed = true;
        await dataSource.destroy();
      };
    },
  });
}
