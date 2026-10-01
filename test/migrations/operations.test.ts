import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CheckDefinition, emptySchema } from '../../src/migrations/schema-state.js';
import {
  type AddCheckOperation,
  type DropCheckOperation,
  applyOperation,
  invertOperation,
} from '../../src/migrations/operations.js';

function makeSchema(check?: CheckDefinition) {
  const state = emptySchema();
  const tableResult = applyOperation(state, {
    kind: 'create_table',
    table: {
      name: 't',
      columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
      ...(check ? { checks: [check] } : {}),
    },
  });
  return tableResult;
}

describe('check constraint operations', () => {
  it('add_check applies to schema state', () => {
    const state = makeSchema();
    const result = applyOperation(state, {
      kind: 'add_check',
      table: 't',
      check: { name: 'positive', expression: 'id > 0' },
    });
    const table = result.tables.find((t) => t.name === 't');
    assert.ok(table);
    assert.ok(table.checks);
    assert.equal(table.checks.length, 1);
    assert.equal(table.checks[0]?.name, 'positive');
    assert.equal(table.checks[0]?.expression, 'id > 0');
  });

  it('add_check preserves raw SQL expression verbatim', () => {
    const state = makeSchema();
    const rawExpression = "col BETWEEN 1 AND 10 AND status != 'deleted'";
    const result = applyOperation(state, {
      kind: 'add_check',
      table: 't',
      check: { name: 'raw_sql', expression: rawExpression },
    });
    const table = result.tables.find((t) => t.name === 't');
    assert.ok(table);
    assert.ok(table.checks);
    assert.equal(table.checks[0]?.expression, rawExpression);
  });

  it('rejects add_check on nonexistent table', () => {
    const state = emptySchema();
    assert.throws(
      () =>
        applyOperation(state, {
          kind: 'add_check',
          table: 'missing',
          check: { name: 'chk', expression: 'x > 0' },
        }),
      /cannot add check constraint to table "missing": it does not exist/,
    );
  });

  it('rejects duplicate check name', () => {
    const state = makeSchema({ name: 'chk', expression: 'x > 0' });
    assert.throws(
      () =>
        applyOperation(state, {
          kind: 'add_check',
          table: 't',
          check: { name: 'chk', expression: 'x < 10' },
        }),
      /cannot add check constraint "chk" to table "t": it already exists/,
    );
  });

  it('drop_check applies to schema state', () => {
    const state = makeSchema({ name: 'chk', expression: 'id > 0' });
    const result = applyOperation(state, {
      kind: 'drop_check',
      table: 't',
      check: { name: 'chk', expression: 'id > 0' },
    });
    const table = result.tables.find((t) => t.name === 't');
    assert.ok(table);
    assert.equal(table.checks, undefined);
  });

  it('rejects drop_check on nonexistent table', () => {
    const state = emptySchema();
    assert.throws(
      () =>
        applyOperation(state, {
          kind: 'drop_check',
          table: 'missing',
          check: { name: 'chk', expression: 'x > 0' },
        }),
      /cannot drop check constraint from table "missing": it does not exist/,
    );
  });

  it('rejects drop_check on nonexistent check', () => {
    const state = makeSchema();
    assert.throws(
      () =>
        applyOperation(state, {
          kind: 'drop_check',
          table: 't',
          check: { name: 'nonexistent', expression: 'x > 0' },
        }),
      /cannot drop check constraint "nonexistent" from table "t": it does not exist/,
    );
  });

  it('rejects drop_check with mismatched definition', () => {
    const state = makeSchema({ name: 'chk', expression: 'id > 0' });
    assert.throws(
      () =>
        applyOperation(state, {
          kind: 'drop_check',
          table: 't',
          check: { name: 'chk', expression: 'id > 1' },
        }),
      /recorded definition does not match state/,
    );
  });

  it('inverts add_check to drop_check', () => {
    const add: AddCheckOperation = {
      kind: 'add_check',
      table: 't',
      check: { name: 'chk', expression: 'x > 0' },
    };
    const inverted = invertOperation(add);
    assert.equal(inverted.kind, 'drop_check');
    assert.equal(inverted.table, 't');
    assert.deepEqual(inverted.check, { name: 'chk', expression: 'x > 0' });
  });

  it('inverts drop_check to add_check', () => {
    const drop: DropCheckOperation = {
      kind: 'drop_check',
      table: 't',
      check: { name: 'chk', expression: 'x > 0' },
    };
    const inverted = invertOperation(drop);
    assert.equal(inverted.kind, 'add_check');
    assert.equal(inverted.table, 't');
    assert.deepEqual(inverted.check, { name: 'chk', expression: 'x > 0' });
  });

  it('add_check then invert then apply returns to original state', () => {
    const state = makeSchema();
    const addOp: AddCheckOperation = {
      kind: 'add_check',
      table: 't',
      check: { name: 'chk', expression: 'x > 0' },
    };
    const afterAdd = applyOperation(state, addOp);
    assert.equal(afterAdd.tables.find((t) => t.name === 't')!.checks!.length, 1);

    const inverted = invertOperation(addOp);
    const afterUndo = applyOperation(afterAdd, inverted);
    assert.equal(afterUndo.tables.find((t) => t.name === 't')!.checks, undefined);
  });
});
