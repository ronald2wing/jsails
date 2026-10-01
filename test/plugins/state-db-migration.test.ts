import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { applyOperations } from '../../src/migrations/operations.js';
import {
  JsailsPluginState,
  PLUGIN_STATE_TABLE,
  pluginStateEntities,
} from '../../src/plugins/database-state-entity.js';

/**
 * The `JsailsPluginState` entity must map to the portable schema model and
 * produce a schema plan that creates `jsails_plugin_state` with exactly
 * the expected scalar columns — no relations, uniques, or function defaults.
 */

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'plugins-state-db-migration-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function dataSourceAt(location: string): JsailsDataSource {
  return new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [JsailsPluginState],
  });
}

describe('JsailsPluginState: portable schema', () => {
  it('builds the expected portable schema offline without connecting', async () => {
    const dataSource = dataSourceAt(join(tmpRoot, 'schema.db'));
    const schema = await dataSource.getModelSchema();

    assert.equal(dataSource.isInitialized, false);
    assert.deepEqual(schema, {
      tables: [
        {
          name: PLUGIN_STATE_TABLE,
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'activeVersion', type: 'varchar', length: 64, nullable: false },
            { name: 'enabled', type: 'boolean', nullable: false },
            { name: 'pluginId', type: 'varchar', length: 190, nullable: false },
            { name: 'settings', type: 'text', nullable: true },
            { name: 'updatedAt', type: 'datetime', nullable: false },
          ],
        },
      ],
    });
  });
});

describe('JsailsPluginState: generated schema plan', () => {
  it('emits a single create_table operation with the expected scalar columns', async () => {
    const schema = await dataSourceAt(join(tmpRoot, 'migration.db')).getModelSchema();
    const operations = diffSchemaStates({ tables: [] }, schema);

    assert.equal(operations.length, 1);

    const operation = operations[0];
    assert.ok(operation, 'expected a create_table operation');
    if (operation.kind !== 'create_table') {
      throw new Error('unreachable: operation is not create_table');
    }
    assert.equal(operation.table.name, PLUGIN_STATE_TABLE);
    assert.deepEqual(operation.table.columns, [
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      { name: 'activeVersion', type: 'varchar', length: 64, nullable: false },
      { name: 'enabled', type: 'boolean', nullable: false },
      { name: 'pluginId', type: 'varchar', length: 190, nullable: false },
      { name: 'settings', type: 'text', nullable: true },
      { name: 'updatedAt', type: 'datetime', nullable: false },
    ]);

    // Applying the plan replays back to the entity's schema, so an execution
    // run materializes exactly this table.
    assert.deepEqual(applyOperations({ tables: [] }, operations), schema);
  });

  it('is the only entity in pluginStateEntities', () => {
    assert.deepEqual(pluginStateEntities, [JsailsPluginState]);
  });
});
