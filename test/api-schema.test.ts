import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ValidationError,
  array,
  boolean,
  integer,
  object,
  optional,
  string,
} from '../src/api/validation.js';
import type { Infer } from '../src/api/validation.js';
import { defineSerializer } from '../src/api/serialization.js';
import { paginateArray, paginate, normalizePagination } from '../src/api/pagination.js';
import type { QueryAdapter } from '../src/api/pagination.js';

describe('field validation', () => {
  it('validates a string with trim and bounds', () => {
    const name = string({ min: 2, max: 10, trim: true });
    assert.equal(name.validate('  Ada  '), 'Ada');
    assert.equal(name.validate('Ada'), 'Ada');
    assert.throws(() => name.validate('A'), ValidationError);
    assert.throws(() => name.validate('  '), ValidationError); // trimmed to empty
  });

  it('rejects non-strings without coercing', () => {
    const name = string();
    assert.throws(() => name.validate(42), ValidationError);
    assert.throws(() => name.validate(true), ValidationError);
    assert.throws(() => name.validate(['x']), ValidationError);
  });

  it('validates integers with bounds and rejects floats and strings', () => {
    const age = integer({ min: 0, max: 150 });
    assert.equal(age.validate(30), 30);
    assert.equal(age.validate(0), 0);
    assert.throws(() => age.validate(151), ValidationError);
    assert.throws(() => age.validate(-1), ValidationError);
    assert.throws(() => age.validate(1.5), ValidationError);
    assert.throws(() => age.validate('30'), ValidationError);
    assert.throws(() => age.validate(NaN), ValidationError);
  });

  it('treats booleans strictly with no coercion', () => {
    const flag = boolean();
    assert.equal(flag.validate(true), true);
    assert.equal(flag.validate(false), false);
    assert.throws(() => flag.validate(1), ValidationError);
    assert.throws(() => flag.validate(0), ValidationError);
    assert.throws(() => flag.validate('true'), ValidationError);
  });

  it('honors optional, default, and nullable explicitly', () => {
    const optionalName = string({ optional: true });
    assert.equal(optionalName.validate(undefined), undefined);

    const defaultName = string({ default: 'anon' });
    assert.equal(defaultName.validate(undefined), 'anon');
    assert.equal(defaultName.validate('Ada'), 'Ada');

    const nullableName = string({ nullable: true });
    assert.equal(nullableName.validate(null), null);
    assert.throws(() => string().validate(null), ValidationError);
  });

  it('rejects unknown object keys by default and allows opt-in', () => {
    const strict = object({ name: string() });
    assert.throws(() => strict.validate({ name: 'a', extra: true }), ValidationError);

    const loose = object({ name: string() }, { allowUnknown: true });
    assert.deepEqual(loose.validate({ name: 'a', extra: true }), { name: 'a' });
  });

  it('validates arrays with a maximum length', () => {
    const tags = array(string({ max: 20 }), { max: 3 });
    assert.deepEqual(tags.validate(['a', 'b']), ['a', 'b']);
    assert.throws(() => tags.validate(['a', 'b', 'c', 'd']), ValidationError);
    assert.throws(() => tags.validate('nope'), ValidationError);
  });
});

describe('error reporting', () => {
  const schema = object({
    user: object({
      email: string({ min: 1 }),
      tags: array(string({ min: 1 }), { max: 5 }),
    }),
  });

  it('reports nested unknown keys with structured paths', () => {
    try {
      schema.validate({ user: { email: 'a@b.c', tags: ['ok'], passwordHash: 'secret' } });
      assert.fail('expected a ValidationError');
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      const err = error;
      const issue = err.issues.find((item) => item.code === 'unknown_field');
      assert.deepEqual(issue?.path, ['user', 'passwordHash']);
      assert.equal(issue?.code, 'unknown_field');
      assert.ok(err.paths.includes('user.passwordHash'));
    }
  });

  it('reports element paths for array failures', () => {
    try {
      schema.validate({ user: { email: 'a@b.c', tags: ['ok', ''] } });
      assert.fail('expected a ValidationError');
    } catch (error) {
      const err = error as ValidationError;
      assert.deepEqual(err.issues[0]?.path, ['user', 'tags', 1]);
      assert.equal(err.issues[0]?.code, 'min_length');
    }
  });

  it('never echoes input values in messages', () => {
    const secret = 'hunter2-very-secret-value';
    let caught: unknown = null;
    try {
      object({ name: string() }).validate({ name: 'a', token: secret });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ValidationError);
    const text = JSON.stringify(caught.issues);
    assert.ok(!text.includes(secret));
  });

  it('exposes issue codes and paths on the error', () => {
    try {
      integer({ min: 0 }).validate(-5);
      assert.fail('expected a ValidationError');
    } catch (error) {
      const err = error as ValidationError;
      assert.equal(err.issues[0]?.code, 'min_value');
      assert.deepEqual(err.issues[0]?.path, []);
    }
  });
});

describe('zod-backed regression', () => {
  it('maps deeply nested Zod issues to structured paths without leaking values', () => {
    const secret = 'hunter2';
    const schema = object({
      rows: array(
        object({
          label: string({ min: 8 }),
          meta: object({ score: integer({ min: 0 }) }),
        }),
      ),
    });

    let caught: unknown;
    try {
      schema.validate({
        rows: [{ label: secret, meta: { score: -1 } }],
      });
      assert.fail('expected a ValidationError');
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof ValidationError);
    const err = caught;
    const byLocation = new Map(err.issues.map((issue) => [issue.path.join('.'), issue.code]));
    assert.equal(byLocation.get('rows.0.label'), 'min_length');
    assert.equal(byLocation.get('rows.0.meta.score'), 'min_value');

    // Neither the failing string value nor the failing number value may leak.
    const text = JSON.stringify(err.issues);
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes('-1'));
  });

  it('rejects unknown keys and non-object/array containers via Zod', () => {
    const schema = object({ name: string() });
    const issue = (() => {
      try {
        schema.validate({ name: 'a', extra: 1 });
      } catch (error) {
        return error as ValidationError;
      }
      assert.fail('expected a ValidationError');
    })();
    assert.equal(issue.issues[0]?.code, 'unknown_field');
    assert.deepEqual(issue.issues[0]?.path, ['extra']);

    assert.throws(() => array(string()).validate({ 0: 'a' }), ValidationError);
    assert.throws(() => object({ name: string() }).validate([]), ValidationError);
  });
});

describe('type inference', () => {
  it('infers the validated output type from a schema', () => {
    const user = object({
      email: string({ min: 1 }),
      age: integer({ optional: true }),
      active: boolean({ default: true }),
      tags: array(string()),
    });

    const value = user.validate({ email: 'a@b.c', tags: ['x'] });
    // Compile-time assertions via satisfies: optional age is number | undefined,
    // defaulted active is boolean (not boolean | undefined).
    const typed: {
      email: string;
      age: number | undefined;
      active: boolean;
      tags: string[];
    } = value;
    assert.equal(typed.email, 'a@b.c');
    assert.equal(typed.active, true);
    assert.equal(typed.age, undefined);

    const inferred: Infer<typeof user> = value;
    assert.deepEqual(inferred, value);
  });

  it('infers the partial wrapper as optional', () => {
    const maybe = optional(integer());
    const v: number | undefined = maybe.validate(undefined);
    assert.equal(v, undefined);
  });
});

describe('serialization', () => {
  const userSerializer = defineSerializer({
    id: { schema: integer(), readOnly: true },
    email: string({ min: 1 }),
    password: { schema: string({ min: 8 }), writeOnly: true },
    name: string({ optional: true }),
  });

  it('whitelists fields and hides writeOnly password on output', () => {
    const representation = userSerializer.toRepresentation({
      id: 7,
      email: 'a@b.c',
      password: 'hunter2-secret',
      name: 'Ada',
      createdAt: '2020-01-01', // extra property must not leak
    });

    assert.deepEqual(representation, { id: 7, email: 'a@b.c', name: 'Ada' });
    assert.ok(!('password' in representation));
    assert.ok(!('createdAt' in representation));
  });

  it('rejects readOnly id on input as an unknown field', () => {
    assert.throws(
      () => userSerializer.validate({ id: 7, email: 'a@b.c', password: 'hunter2-secret' }),
      ValidationError,
    );
  });

  it('validates a full write payload', () => {
    const input = userSerializer.validate({ email: 'a@b.c', password: 'hunter2-secret' });
    assert.deepEqual(input, { email: 'a@b.c', password: 'hunter2-secret' });
  });

  it('requires write fields on full validation', () => {
    assert.throws(() => userSerializer.validate({ email: 'a@b.c' }), ValidationError);
  });

  it('supports PATCH partial updates without defaulting or overwriting', () => {
    const partial = userSerializer.validate({ name: 'Grace' }, { partial: true });
    assert.deepEqual(partial, { name: 'Grace' });
    // email/password were not defaulted or fabricated — absent stays absent.
    assert.ok(!('email' in partial));
    assert.ok(!('password' in partial));
  });

  it('does not apply defaults in partial mode', () => {
    const draft = defineSerializer({
      title: string(),
      published: boolean({ default: false }),
    });
    const partial = draft.validate({ title: 'hello' }, { partial: true });
    assert.deepEqual(partial, { title: 'hello' });
    assert.ok(!('published' in partial));
  });
});

describe('pagination', () => {
  it('returns empty metadata for empty datasets', () => {
    const page = paginateArray([], {});
    assert.deepEqual(page, {
      count: 0,
      results: [],
      page: 1,
      pageSize: 20,
      next: null,
      previous: null,
    });
  });

  it('caps a malicious pageSize at the bound', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const page = paginateArray(items, { page: 1, pageSize: 1_000_000 });
    assert.equal(page.pageSize, 100);
    assert.equal(page.results.length, 100);
    assert.equal(page.next, 2);
    assert.equal(page.previous, null);
  });

  it('handles a huge out-of-range page without allocating', () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const page = paginateArray(items, { page: 99_999_999, pageSize: 100 });
    assert.equal(page.results.length, 0);
    assert.equal(page.next, null);
    assert.equal(page.previous, 1);
  });

  it('computes numeric next/previous links', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const first = paginateArray(items, { page: 1, pageSize: 100 });
    assert.equal(first.next, 2);
    assert.equal(first.previous, null);

    const last = paginateArray(items, { page: 3, pageSize: 100 });
    assert.equal(last.next, null);
    assert.equal(last.previous, 2);
    assert.equal(last.results.length, 50);
  });

  it('rejects non-integer page/pageSize without coercion', () => {
    assert.throws(() => normalizePagination({ page: '2' }), ValidationError);
    assert.throws(() => normalizePagination({ pageSize: 2.5 }), ValidationError);
    assert.throws(() => normalizePagination({ page: 0 }), ValidationError);
    assert.throws(() => normalizePagination({ pageSize: -10 }), ValidationError);
  });

  it('paginates through a query adapter', async () => {
    const adapter: QueryAdapter<number> = {
      async count() {
        return 250;
      },
      async list(offset, limit) {
        return Array.from({ length: limit }, (_, i) => offset + i).filter((n) => n < 250);
      },
    };
    const page = await paginate(adapter, { page: 2, pageSize: 50 });
    assert.equal(page.count, 250);
    assert.equal(page.results[0], 50);
    assert.equal(page.results.length, 50);
    assert.equal(page.next, 3);
    assert.equal(page.previous, 1);
  });
});
