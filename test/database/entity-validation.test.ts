import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, EntitySchema, PrimaryGeneratedColumn } from 'typeorm';
import { z } from 'zod';

import { JsailsDataSource } from '../../src/database/data-source.js';
import {
  assertEntityValid,
  defineEntityValidation,
  entityValidationHooks,
  EntityValidationError,
  validateEntity,
} from '../../src/database/entity-validation.js';
import { createEntitySubscriber } from '../../src/database/entity-subscribers.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { migrate, type MigrationDataSource } from '../../src/migrations/migrator.js';
import { transaction } from '../../src/database/transaction.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A minimal entity class for use as an `entity` target. */
class User {
  id!: number;
  name!: string;
}

/** The schema paired with `User` in tests. */
const userSchema = z.object({
  id: z.number(),
  name: z.string().min(1, 'Name is required'),
});

// ---------------------------------------------------------------------------
// defineEntityValidation
// ---------------------------------------------------------------------------

describe('defineEntityValidation', () => {
  it('returns a frozen descriptor with the entity and schema', () => {
    const validation = defineEntityValidation(User, userSchema);
    assert.ok(Object.isFrozen(validation));
    assert.equal(validation.entity, User);
    assert.equal(validation.schema, userSchema);
  });

  it('accepts a function/class as the entity', () => {
    const validation = defineEntityValidation(User, userSchema);
    assert.equal(validation.entity, User);
  });

  it('accepts an EntitySchema as the entity', () => {
    const schema = new EntitySchema({
      name: 'User',
      target: User,
      columns: {},
    });
    const validation = defineEntityValidation(schema, userSchema);
    assert.equal(validation.entity, schema);
  });

  it('accepts a plain string name as the entity', () => {
    const validation = defineEntityValidation('User', userSchema);
    assert.equal(validation.entity, 'User');
  });

  it('accepts a plain object with a name property as the entity', () => {
    // Runtime guard (same as entity-subscribers.ts) accepts a plain object with
    // a `name` property. The TypeORM EntityTarget type is stricter, so we
    // bypass the type check with a cast — the runtime guard is tested below.
    const target = { name: 'User' };
    // The plain-object form is accepted by the runtime guard but not by the
    // TypeScript type.  Suppress the compile error; the runtime behavior is
    // tested by the `assertValidEntityTarget` branch.
    // @ts-expect-error — plain object is a valid runtime entity target form
    const validation = defineEntityValidation(target, userSchema);
    assert.equal(validation.entity, target);
  });

  it('rejects a null entity with a value-free EntityValidationError', () => {
    assert.throws(
      () => defineEntityValidation(null as unknown as typeof User, userSchema),
      (err: unknown) => {
        assert.ok(err instanceof EntityValidationError);
        // Message must be value-free — the raw argument is never echoed.
        assert.ok(!String((err as Error).message).includes('null'));
        return true;
      },
    );
  });

  it('rejects a non-entity primitive (number) with a value-free EntityValidationError', () => {
    assert.throws(
      () => defineEntityValidation(42 as unknown as typeof User, userSchema),
      (err: unknown) => {
        assert.ok(err instanceof EntityValidationError);
        assert.ok(!String((err as Error).message).includes('42'));
        return true;
      },
    );
  });

  it('rejects a null schema with a value-free EntityValidationError', () => {
    assert.throws(
      () => defineEntityValidation(User, null as unknown as z.ZodObject<z.ZodRawShape>),
      (err: unknown) => {
        assert.ok(err instanceof EntityValidationError);
        assert.ok(!String((err as Error).message).includes('null'));
        return true;
      },
    );
  });

  it('rejects a plain object without safeParse as a schema', () => {
    assert.throws(
      () => defineEntityValidation(User, {} as unknown as z.ZodObject<z.ZodRawShape>),
      (err: unknown) => {
        assert.ok(err instanceof EntityValidationError);
        assert.ok(String((err as Error).message).includes('safeParse'));
        return true;
      },
    );
  });

  it('rejects an array as a schema', () => {
    assert.throws(
      () => defineEntityValidation(User, [] as unknown as z.ZodObject<z.ZodRawShape>),
      EntityValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// validateEntity
// ---------------------------------------------------------------------------

describe('validateEntity', () => {
  it('returns an empty array for valid data', () => {
    const validation = defineEntityValidation(User, userSchema);
    const errors = validateEntity(validation, { id: 1, name: 'Alice' });
    assert.deepEqual(errors, []);
  });

  it('returns one FieldError per issue with the correct dotted field path', () => {
    const schema = z.object({
      user: z.object({
        name: z.string().min(3, 'Name is too short'),
      }),
    });
    const validation = defineEntityValidation(User, schema);
    const errors = validateEntity(validation, { user: { name: 'ab' } });

    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.field, 'user.name');
    assert.equal(errors[0]!.message, 'Name is too short');
  });

  it('uses the authored Zod message, not a generic description', () => {
    // The message policy: issue.message is surfaced directly, never a generic
    // mapped message. Use a distinctive authored message to prove it.
    const schema = z.object({
      email: z.string().min(5, 'Email is way too short for this app'),
    });
    const validation = defineEntityValidation(User, schema);
    const errors = validateEntity(validation, { email: 'a@b' });

    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message, 'Email is way too short for this app');
  });

  it('uses "_root" for a root-level failure (empty issue path)', () => {
    // A primitive passed where an object is expected produces a root-level issue.
    const validation = defineEntityValidation(User, userSchema);
    const errors = validateEntity(validation, 'not an object');

    // There should be at least one root-level issue.
    const rootErrors = errors.filter((e) => e.field === '_root');
    assert.ok(rootErrors.length > 0, 'expected at least one _root field error');
  });

  it('never echoes input values in error messages', () => {
    // Pass a distinctive value and assert every message is free of it.
    const validation = defineEntityValidation(User, userSchema);
    const errors = validateEntity(validation, { id: 'SECRETVALUE', name: 'SECRETVALUE' });

    for (const error of errors) {
      assert.ok(
        !error.message.includes('SECRETVALUE'),
        `message "${error.message}" must not contain the input value`,
      );
    }
  });

  it('never echoes input values in the field property', () => {
    const validation = defineEntityValidation(User, userSchema);
    const errors = validateEntity(validation, { id: 'SECRETVALUE', name: 'SECRETVALUE' });

    for (const error of errors) {
      assert.ok(
        !error.field.includes('SECRETVALUE'),
        `field "${error.field}" must not contain the input value`,
      );
    }
  });

  it('handles a schema with multiple field failures', () => {
    const schema = z.object({
      email: z.string().email('Invalid email format'),
      age: z.number().min(18, 'Must be at least 18'),
    });
    const validation = defineEntityValidation(User, schema);
    const errors = validateEntity(validation, { email: 'not-email', age: 'twelve' });

    // age is wrong type + email is wrong format — at least 2 issues.
    assert.ok(errors.length >= 2, `expected at least 2 errors, got ${errors.length}`);

    const fields = errors.map((e) => e.field);
    assert.ok(fields.includes('email'));
    assert.ok(fields.includes('age'));
  });
});

// ---------------------------------------------------------------------------
// assertEntityValid
// ---------------------------------------------------------------------------

describe('assertEntityValid', () => {
  it('does not throw for valid data', () => {
    const validation = defineEntityValidation(User, userSchema);
    assert.doesNotThrow(() => assertEntityValid(validation, { id: 1, name: 'Alice' }));
  });

  it('throws EntityValidationError for invalid data', () => {
    const validation = defineEntityValidation(User, userSchema);
    assert.throws(
      () => assertEntityValid(validation, { id: 'not-a-number' }),
      EntityValidationError,
    );
  });

  it('the thrown error carries .errors matching validateEntity result', () => {
    const validation = defineEntityValidation(User, userSchema);
    const data = { id: 'not-a-number' };
    const expectedErrors = validateEntity(validation, data);

    assert.throws(
      () => assertEntityValid(validation, data),
      (err: unknown) => {
        assert.ok(err instanceof EntityValidationError);
        assert.deepEqual(err.errors, expectedErrors);
        return true;
      },
    );
  });

  it('the thrown error message is a fixed summary, never containing input values', () => {
    const validation = defineEntityValidation(User, userSchema);
    assert.throws(
      () => assertEntityValid(validation, { id: 'SECRETDATA', name: 12345 }),
      (err: unknown) => {
        assert.ok(err instanceof EntityValidationError);
        const msg = err.message;
        assert.ok(!msg.includes('SECRETDATA'));
        assert.ok(!msg.includes('12345'));
        // Must not contain any field-level issue text either.
        return true;
      },
    );
  });

  it('the thrown error name is EntityValidationError', () => {
    const validation = defineEntityValidation(User, userSchema);
    assert.throws(
      () => assertEntityValid(validation, { id: 'bad' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'EntityValidationError');
        return true;
      },
    );
  });

  it('.errors is a frozen array', () => {
    const validation = defineEntityValidation(User, userSchema);
    assert.throws(
      () => assertEntityValid(validation, { id: 'bad' }),
      (err: unknown) => {
        assert.ok(err instanceof EntityValidationError);
        assert.ok(Object.isFrozen(err.errors));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// entityValidationHooks — end-to-end save gate (sqljs harness)
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'entity-validation-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeAccount() {
  @Entity('accounts')
  class Account extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;

    @Column({ type: 'integer', nullable: true })
    age!: number | null;
  }
  return Account;
}

function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

const accountSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  age: z.number().min(0, 'Age must be at least 0').max(150, 'Age must be at most 150'),
});

let dbSeq = 0;

async function createValidationDataSource(
  Account: ReturnType<typeof makeAccount>,
): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${dbSeq++}.sqlite`);
  const validation = defineEntityValidation(Account, accountSchema);
  const hooks = entityValidationHooks(validation);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [Account],
    subscribers: [createEntitySubscriber(hooks)],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const migration = generateMigration('create_accounts', [], schema);
  assert.ok(migration, 'expected a create migration for the fixture schema');
  await migrate(asMigrationDataSource(dataSource), [migration]);
  return dataSource;
}

describe('entityValidationHooks end-to-end', () => {
  it('a valid save() succeeds and the row persists', async () => {
    const Account = makeAccount();
    const dataSource = await createValidationDataSource(Account);

    const account = await Account.create({ name: 'Alice', age: 30 }).save();
    assert.equal(typeof account.id, 'number');
    assert.equal(account.name, 'Alice');
    assert.equal(account.age, 30);

    assert.equal(await Account.count(), 1);
    await dataSource.destroy();
  });

  it('an invalid save() rejects with EntityValidationError and writes no row', async () => {
    const Account = makeAccount();
    const dataSource = await createValidationDataSource(Account);

    await assert.rejects(Account.create({ name: '', age: -5 }).save(), (err: unknown) => {
      assert.ok(err instanceof EntityValidationError);
      // The field errors carry the invalid field names.
      const fields = err.errors.map((e: { field: string }) => e.field);
      assert.ok(fields.includes('name'), 'expected a name field error');
      assert.ok(fields.includes('age'), 'expected an age field error');
      return true;
    });

    // No rows were written.
    assert.equal(await Account.count(), 0);
    await dataSource.destroy();
  });

  it('the update path is gated: invalid change rejects and DB row is unchanged', async () => {
    const Account = makeAccount();
    const dataSource = await createValidationDataSource(Account);

    // Persist a valid row.
    const account = await Account.create({ name: 'Bob', age: 42 }).save();

    // Attempt an invalid update — blank name, out-of-range age.
    account.name = '';
    account.age = 200;
    await assert.rejects(account.save(), EntityValidationError);

    // The row in the database must be unchanged from the original valid values.
    const reloaded = await Account.findOneByOrFail({ id: account.id });
    assert.equal(reloaded.name, 'Bob');
    assert.equal(reloaded.age, 42);
    await dataSource.destroy();
  });

  it('an EntitySchema-defined entity validates equally through the hooks', async () => {
    // Fixture: a plain class target with an EntitySchema that defines its
    // columns, wired into the same subscriber pattern.
    class Task {
      id!: number;
      title!: string;
    }

    const TaskSchema = new EntitySchema({
      name: 'Task',
      target: Task,
      columns: {
        id: { type: Number, primary: true, generated: true },
        title: { type: String, length: 200, nullable: false },
      },
    });

    const taskSchema = z.object({
      title: z.string().min(1, 'Title is required'),
    });

    const validation = defineEntityValidation(TaskSchema, taskSchema);
    const hooks = entityValidationHooks(validation);

    const location = join(tmpRoot, `db-${dbSeq++}.sqlite`);
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location,
      entities: [TaskSchema],
      subscribers: [createEntitySubscriber(hooks)],
    });
    await dataSource.initialize();
    const schema = await dataSource.getModelSchema();
    const migration = generateMigration('create_tasks', [], schema);
    assert.ok(migration);
    await migrate(asMigrationDataSource(dataSource), [migration]);

    // Valid save through EntitySchema.
    // TypeORM's entity-schema Active Record path: use the repository directly
    // since BaseEntity bindings require a class target.
    const repo = dataSource.getRepository(Task);
    const task = await repo.save(repo.create({ title: 'Write tests' }));
    assert.equal(typeof task.id, 'number');
    assert.equal(task.title, 'Write tests');

    // Invalid save rejects with the validation error.
    await assert.rejects(repo.save(repo.create({ title: '' })), (err: unknown) => {
      assert.ok(err instanceof EntityValidationError);
      const fields = err.errors.map((e: { field: string }) => e.field);
      assert.ok(fields.includes('title'));
      return true;
    });

    assert.equal(await repo.count(), 1);
    await dataSource.destroy();
  });

  it('a validation failure inside transaction() rolls back and fires afterRollback', async () => {
    const Account = makeAccount();
    const dataSource = await createValidationDataSource(Account);

    let rollbackFired = false;
    let commitFired = false;

    await assert.rejects(
      transaction(dataSource, async (handle) => {
        handle.afterCommit(() => {
          commitFired = true;
        });
        handle.afterRollback(() => {
          rollbackFired = true;
        });

        // First save: valid, through the transaction-scoped manager.
        const account1 = Account.create({ name: 'Cathy', age: 25 });
        await handle.manager.save(account1);

        // Second save: invalid — this must roll back the whole transaction.
        const account2 = Account.create({ name: '', age: -1 });
        await handle.manager.save(account2);
      }),
      EntityValidationError,
    );

    // The afterRollback callback must have fired; afterCommit must not.
    assert.ok(rollbackFired, 'expected afterRollback to fire');
    assert.ok(!commitFired, 'expected afterCommit not to fire');

    // Neither row was persisted — transaction rolled back entirely.
    assert.equal(await Account.count(), 0);
    await dataSource.destroy();
  });
});
