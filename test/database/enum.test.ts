/**
 * Enums: `defineEnum` closed-set columns with value predicates, a scope, and a
 * `CHECK` constraint folded into the schema.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { ApplicationRecord } from '../../src/database/application-record.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import {
  applyEnumChecks,
  defineEnum,
  enumIs,
  enumIn,
  enumScope,
  enumWhere,
  enumWhereIn,
  EnumError,
} from '../../src/database/enum.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';
import { query } from '../../src/database/model-query.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'enum-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makePost() {
  @Entity('posts')
  class Post extends ApplicationRecord {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200 })
    title!: string;
  }
  return Post;
}

let dbSeq = 0;

async function createDataSource(
  Post: ReturnType<typeof makePost>,
  definition: ReturnType<typeof defineEnum>,
): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location: join(tmpRoot, `db-${dbSeq++}.sqlite`),
    entities: [Post],
  });
  await dataSource.initialize();
  const schema = applyEnumChecks(await dataSource.getModelSchema(), definition);
  const operations = diffSchemaStates({ tables: [] }, schema);
  await executeSchemaPlan(dataSource, operations);
  return dataSource;
}

describe('defineEnum', () => {
  it('adds a varchar column + CHECK, and exposes Is/In predicates and a scope', async () => {
    const Post = makePost();
    const definition = defineEnum(Post, 'status', ['draft', 'published'], { nullable: true });

    assert.equal(definition.type, 'varchar');
    assert.equal(definition.check.expression, "status IN ('draft', 'published')");

    const dataSource = await createDataSource(Post, definition);

    const post = await Post.create({ title: 't' }).save();
    Object.assign(post, { status: 'draft' });
    await post.save();
    assert.equal(enumIs(definition, post as unknown as Record<string, unknown>, 'draft'), true);
    assert.equal(
      enumIs(definition, post as unknown as Record<string, unknown>, 'published'),
      false,
    );
    assert.equal(
      enumIn(definition, post as unknown as Record<string, unknown>, ['draft', 'published']),
      true,
    );
    assert.equal(
      enumIn(definition, post as unknown as Record<string, unknown>, ['published']),
      false,
    );

    // The CHECK rejects an out-of-set value at the SQLite level.
    const bad = await Post.create({ title: 'b' }).save();
    Object.assign(bad, { status: 'unknown' });
    await assert.rejects(bad.save());

    await dataSource.destroy();
  });

  it('builds a scoped query via enumScope/enumWhere/enumWhereIn', async () => {
    const Post = makePost();
    const definition = defineEnum(Post, 'status', ['draft', 'published'], { nullable: true });
    const dataSource = await createDataSource(Post, definition);

    const a = await Post.create({ title: 'a' }).save();
    Object.assign(a, { status: 'draft' });
    await a.save();
    const b = await Post.create({ title: 'b' }).save();
    Object.assign(b, { status: 'published' });
    await b.save();

    const published = await enumScope(definition, 'published').getMany();
    assert.deepEqual(
      published.map((p) => (p as { title: string }).title),
      ['b'],
    );

    const draft = await query(Post).where(enumWhere(definition, 'draft')).getMany();
    assert.deepEqual(
      draft.map((p) => (p as { title: string }).title),
      ['a'],
    );

    const both = await query(Post)
      .where(enumWhereIn(definition, ['draft', 'published']))
      .getMany();
    assert.equal(both.length, 2);

    await dataSource.destroy();
  });

  it('rejects an out-of-set value value-free', () => {
    const Post = makePost();
    const definition = defineEnum(Post, 'status', ['draft', 'published']);
    assert.throws(
      () => enumIs(definition, { status: 'unknown' }, 'unknown'),
      (e: unknown) =>
        e instanceof EnumError && e.message === 'value is not in the enum set for "status"',
    );
  });

  it('rejects an empty or duplicate value list', () => {
    const Post = makePost();
    assert.throws(() => defineEnum(Post, 'status', []), EnumError);
    assert.throws(() => defineEnum(Post, 'status', ['a', 'a']), EnumError);
  });

  it('rejects integer values mixed with strings', () => {
    const Post = makePost();
    assert.throws(() => defineEnum(Post, 'status', ['a', 1]), EnumError);
  });

  it('supports integer enums', () => {
    const Post = makePost();
    const definition = defineEnum(Post, 'level', [1, 2, 3]);
    assert.equal(definition.type, 'integer');
    assert.equal(definition.check.expression, 'level IN (1, 2, 3)');
  });

  it('rejects an unknown table/column in applyEnumChecks', async () => {
    const Post = makePost();
    const definition = defineEnum(Post, 'status', ['draft']);
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, `db-${dbSeq++}.sqlite`),
      entities: [Post],
    });
    await dataSource.initialize();
    const schema = await dataSource.getModelSchema();
    // A definition for a table that does not exist must fail value-free.
    const bogus = { ...definition, table: 'missing_table' } as unknown as ReturnType<
      typeof defineEnum
    >;
    assert.throws(() => applyEnumChecks(schema, bogus), EnumError);
    await dataSource.destroy();
  });

  it('does not apply the column decorator twice (idempotent)', () => {
    const Post = makePost();
    const first = defineEnum(Post, 'status', ['draft', 'published']);
    const second = defineEnum(Post, 'status', ['draft', 'published']);
    assert.equal(first.check.name, second.check.name);
  });
});
