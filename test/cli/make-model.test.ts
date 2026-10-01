import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { runMakeCommand } from '../../src/cli/make-commands.js';
import type { CompilerErrorCode } from '../../src/compiler/errors.js';
import { extractModel } from '../../src/compiler/model-extract.js';

/**
 * The `make:model` generator must emit a model the compiler can consume
 * unchanged: the generated text is fed back through the same `extractModel`
 * pass `jsails build:meta` runs, so a scaffolded model is proven to lower to a
 * table/column spec with no diagnostics — not merely to look right.
 */

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'make-model-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let dirSeq = 0;

function freshDir(): string {
  return join(tmpRoot, `model-${dirSeq++}`);
}

interface Diagnostic {
  code: CompilerErrorCode;
  message: string;
}

function extract(source: string, fileName: string) {
  const diagnostics: Diagnostic[] = [];
  const model = extractModel(source, fileName, (code, message) => {
    diagnostics.push({ code, message });
  });
  return { model, diagnostics };
}

describe('make:model: generated model lowers through the compiler', () => {
  it('extracts the scaffolded model into a table/column spec with no diagnostics', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('model', ['blog_post', '--dir', dir]);
    assert.equal(code, 0);

    const source = readFileSync(join(dir, 'models/blog-post.ts'), 'utf8');
    const { model, diagnostics } = extract(source, 'models/blog-post.ts');

    assert.deepEqual(diagnostics, []);
    assert.ok(model, 'the generated model must be recognized as a model');
    assert.equal(model.className, 'BlogPost');
    assert.equal(model.tableName, 'blog_post');
    assert.equal(model.encrypted.length, 0);

    const name = model.fields.find((field) => field.name === 'name');
    assert.ok(name, 'the scaffolded `name` field must be extracted');
    assert.equal(name.field, 'column');
    if (name.field === 'column') {
      assert.equal(name.kind, 'varchar');
      assert.equal(name.length, 255);
    }
  });

  it('emits no TypeORM or subscriber symbols', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('model', ['post', '--dir', dir]);
    assert.equal(code, 0);

    const source = readFileSync(join(dir, 'models/post.ts'), 'utf8');
    assert.doesNotMatch(source, /from 'typeorm'/);
    assert.doesNotMatch(source, /createEntitySubscriber/);
    assert.doesNotMatch(source, /@Entity|@Column|@PrimaryGeneratedColumn/);
    // The base class is the only import; the PK is supplied by `defineModel`.
    assert.doesNotMatch(source, /declare id\b/);
  });
});
