import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  extractModel,
  resolveModelFile,
  type ExtractedColumn,
  type ExtractedRelation,
  type ModelReporter,
} from '../../src/compiler/model-extract.js';
import type { CompilerErrorCode } from '../../src/compiler/errors.js';

interface Recorded {
  readonly code: CompilerErrorCode;
  readonly subject: string;
}

function recorder(): { report: ModelReporter; diagnostics: Recorded[] } {
  const diagnostics: Recorded[] = [];
  const report: ModelReporter = (code, _message, subject) => {
    diagnostics.push({ code, subject });
  };
  return { report, diagnostics };
}

function column(model: ReturnType<typeof extractModel>, name: string): ExtractedColumn {
  const field = model?.fields.find((candidate) => candidate.name === name);
  if (field === undefined || field.field !== 'column') {
    assert.fail(`column ${name} missing`);
  }
  return field;
}

function relation(model: ReturnType<typeof extractModel>, name: string): ExtractedRelation {
  const field = model?.fields.find((candidate) => candidate.name === name);
  if (field === undefined || field.field !== 'relation') {
    assert.fail(`relation ${name} missing`);
  }
  return field;
}

describe('extractModel', () => {
  it('returns undefined for a non-model source', () => {
    const { report, diagnostics } = recorder();
    const model = extractModel('export const x = 1;', 'models/x.ts', report);
    assert.equal(model, undefined);
    assert.deepEqual(diagnostics, []);
  });

  it('reports unparseable and returns undefined on a syntax error', () => {
    const { report, diagnostics } = recorder();
    const model = extractModel('export class Post extends {', 'models/post.ts', report);
    assert.equal(model, undefined);
    assert.equal(diagnostics[0]?.code, 'unparseable');
  });

  it('derives the class name and table name', () => {
    const { report } = recorder();
    const model = extractModel(
      'export class BlogPost extends ApplicationRecord { declare title: string; }',
      'models/blog-post.ts',
      report,
    );
    assert.equal(model?.className, 'BlogPost');
    assert.equal(model?.tableName, 'blog_post');
  });

  it('infers scalar columns from primitive types', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        declare title: string;
        declare views: number;
        declare published: boolean;
        declare publishedAt: Date;
      }`,
      'models/post.ts',
      report,
    );
    assert.equal(column(model, 'title').kind, 'varchar');
    assert.equal(column(model, 'views').kind, 'integer');
    assert.equal(column(model, 'published').kind, 'boolean');
    assert.equal(column(model, 'publishedAt').kind, 'datetime');
  });

  it('infers a many-to-one relation with a derived FK column', () => {
    const { report } = recorder();
    const model = extractModel(
      'export class Post extends ApplicationRecord { declare author: Author; }',
      'models/post.ts',
      report,
    );
    const author = relation(model, 'author');
    assert.equal(author.kind, 'many-to-one');
    assert.equal(author.target, 'Author');
    assert.equal(author.foreignKey, 'author_id');
  });

  it('infers a one-to-many relation from an array type', () => {
    const { report } = recorder();
    const model = extractModel(
      'export class Post extends ApplicationRecord { declare comments: Comment[]; }',
      'models/post.ts',
      report,
    );
    const comments = relation(model, 'comments');
    assert.equal(comments.kind, 'one-to-many');
    assert.equal(comments.target, 'Comment');
  });

  it('disambiguates two relations to the same target by field name', () => {
    const { report, diagnostics } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        declare author: User;
        declare editor: User;
      }`,
      'models/post.ts',
      report,
    );
    assert.equal(relation(model, 'author').foreignKey, 'author_id');
    assert.equal(relation(model, 'editor').foreignKey, 'editor_id');
    assert.deepEqual(diagnostics, []);
  });

  it('reports a self-referential one-to-many as ambiguous', () => {
    const { report, diagnostics } = recorder();
    const model = extractModel(
      `export class Category extends ApplicationRecord {
        declare parent: Category;
        declare children: Category[];
      }`,
      'models/category.ts',
      report,
    );
    // The many-to-one `parent` is inferred; the inverse `children` is not.
    assert.equal(relation(model, 'parent').kind, 'many-to-one');
    assert.equal(
      model?.fields.some((field) => field.name === 'children'),
      false,
    );
    assert.deepEqual(diagnostics, [{ code: 'ambiguous_relation', subject: 'children' }]);
  });

  it('accepts a self-referential one-to-many with an explicit inverse', () => {
    const { report, diagnostics } = recorder();
    const model = extractModel(
      `export class Category extends ApplicationRecord {
        declare parent: Category;
        @jsails.hasMany(Category, { inverse: 'parent' })
        declare children: Category[];
      }`,
      'models/category.ts',
      report,
    );
    assert.equal(relation(model, 'children').kind, 'one-to-many');
    assert.deepEqual(diagnostics, []);
  });

  it('reports a union type as unresolved', () => {
    const { report, diagnostics } = recorder();
    const model = extractModel(
      'export class Post extends ApplicationRecord { declare author: Author | null; }',
      'models/post.ts',
      report,
    );
    assert.equal(model?.fields.length, 0);
    assert.deepEqual(diagnostics, [{ code: 'unresolved_model', subject: 'author' }]);
  });

  it('reports a generic array type as unresolved', () => {
    const { report, diagnostics } = recorder();
    const model = extractModel(
      'export class Post extends ApplicationRecord { declare comments: Array<Comment>; }',
      'models/post.ts',
      report,
    );
    assert.equal(model?.fields.length, 0);
    assert.deepEqual(diagnostics, [{ code: 'unresolved_model', subject: 'comments' }]);
  });

  it('reports a field with no type annotation as unresolved', () => {
    const { report, diagnostics } = recorder();
    const model = extractModel(
      'export class Post extends ApplicationRecord { declare title; }',
      'models/post.ts',
      report,
    );
    assert.equal(model?.fields.length, 0);
    assert.deepEqual(diagnostics, [{ code: 'unresolved_model', subject: 'title' }]);
  });

  it('parses inline field decorators with their arguments', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        @jsails.maxLength(200)
        @jsails.unique()
        declare slug: string;
      }`,
      'models/post.ts',
      report,
    );
    const slug = column(model, 'slug');
    assert.deepEqual(
      slug.decorators.map((decorator) => decorator.name),
      ['maxLength', 'unique'],
    );
    assert.deepEqual(slug.decorators[0]?.args, [200]);
  });

  it('lets an explicit relation decorator replace inference', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        @jsails.belongsTo(Author, { touch: true })
        declare editor: User;
      }`,
      'models/post.ts',
      report,
    );
    const editor = relation(model, 'editor');
    assert.equal(editor.target, 'Author');
    assert.equal(editor.kind, 'many-to-one');
    assert.deepEqual(editor.decorators[0]?.args[1], { touch: true });
  });

  it('defaults a varchar column to length 255', () => {
    const { report } = recorder();
    const model = extractModel(
      'export class Post extends ApplicationRecord { declare title: string; }',
      'models/post.ts',
      report,
    );
    assert.equal(column(model, 'title').length, 255);
  });

  it('folds @jsails.maxLength into the resolved column length', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        @jsails.maxLength(200)
        declare slug: string;
      }`,
      'models/post.ts',
      report,
    );
    assert.equal(column(model, 'slug').length, 200);
  });

  it('folds @jsails.unique and @jsails.nullable into column flags', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        @jsails.unique()
        declare slug: string;
        @jsails.nullable()
        declare subtitle: string;
      }`,
      'models/post.ts',
      report,
    );
    assert.equal(column(model, 'slug').unique, true);
    assert.equal(column(model, 'slug').nullable, undefined);
    assert.equal(column(model, 'subtitle').nullable, true);
    assert.equal(column(model, 'subtitle').unique, undefined);
  });

  it('collects @jsails.encrypts fields into the model encrypted set', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class User extends ApplicationRecord {
        @jsails.encrypts()
        declare ssn: string;
        declare name: string;
      }`,
      'models/user.ts',
      report,
    );
    assert.deepEqual(model?.encrypted, ['ssn']);
  });

  it('extracts @jsails.renamedFrom into a column field', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        @jsails.renamedFrom('headline')
        declare title: string;
      }`,
      'models/post.ts',
      report,
    );
    assert.equal(column(model, 'title').renamedFrom, 'headline');
  });

  it('extracts @jsails.renamedFrom into a relation field', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        @jsails.renamedFrom('writer_id')
        declare author: Author;
      }`,
      'models/post.ts',
      report,
    );
    assert.equal(relation(model, 'author').renamedFrom, 'writer_id');
  });

  it('folds relation behaviour flags from the decorator options', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        @jsails.belongsTo(Author, { touch: true })
        declare author: Author;
        @jsails.hasMany(Comment, { counter_cache: true })
        declare comments: Comment[];
        @jsails.hasMany(Category, { inverse: 'parent' })
        declare categories: Category[];
      }`,
      'models/post.ts',
      report,
    );
    assert.equal(relation(model, 'author').touch, true);
    assert.equal(relation(model, 'comments').counterCache, true);
    assert.equal(relation(model, 'categories').inverse, 'parent');
  });

  it('folds a standalone @jsails.nullable on a relation into the FK nullable flag', () => {
    const { report } = recorder();
    const model = extractModel(
      `export class Post extends ApplicationRecord {
        @jsails.nullable()
        declare author: Author;
      }`,
      'models/post.ts',
      report,
    );
    assert.equal(relation(model, 'author').nullable, true);
  });

  it('leaves inferred fields without decorator flags undefined', () => {
    const { report } = recorder();
    const model = extractModel(
      'export class Post extends ApplicationRecord { declare title: string; declare views: number; }',
      'models/post.ts',
      report,
    );
    assert.equal(column(model, 'title').unique, undefined);
    assert.equal(column(model, 'title').nullable, undefined);
    assert.deepEqual(model?.encrypted, []);
    assert.equal(column(model, 'views').length, undefined);
  });
});

describe('resolveModelFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-models-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves a class name to models/<kebab>.ts by convention', () => {
    mkdirSync(join(dir, 'models'), { recursive: true });
    writeFileSync(join(dir, 'models', 'blog-post.ts'), '');
    assert.equal(resolveModelFile(dir, 'BlogPost'), join(dir, 'models', 'blog-post.ts'));
  });

  it('returns undefined when no file exists', () => {
    assert.equal(resolveModelFile(dir, 'Missing'), undefined);
  });
});
