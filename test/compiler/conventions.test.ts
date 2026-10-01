import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CLIENT_COMPONENT_EXTENSIONS,
  CONVENTION_DIRS,
  GENERATOR_LAYOUT,
  MAKE_COMMAND_TYPES,
  MODEL_EXTENSIONS,
  camelCase,
  classNameFromFile,
  kebabCase,
  pascalCase,
  probeConventionFile,
  snakeCase,
  toWords,
} from '../../src/compiler/conventions.js';

test('toWords splits camelCase boundaries', () => {
  assert.deepEqual(toWords('BlogPost'), ['Blog', 'Post']);
  assert.deepEqual(toWords('blogPost'), ['blog', 'Post']);
  assert.deepEqual(toWords('TaskList'), ['Task', 'List']);
});

test('toWords splits acronym runs', () => {
  assert.deepEqual(toWords('HTMLParser'), ['HTML', 'Parser']);
  assert.deepEqual(toWords('getHTMLId'), ['get', 'HTML', 'Id']);
  assert.deepEqual(toWords('OAuthToken'), ['O', 'Auth', 'Token']);
});

test('toWords splits kebab and snake separators', () => {
  assert.deepEqual(toWords('blog-post'), ['blog', 'post']);
  assert.deepEqual(toWords('blog_post'), ['blog', 'post']);
  assert.deepEqual(toWords('blog post'), ['blog', 'post']);
});

test('toWords drops empty segments', () => {
  assert.deepEqual(toWords('--foo__bar--'), ['foo', 'bar']);
  assert.deepEqual(toWords(''), []);
});

test('pascalCase joins words with capitalized heads', () => {
  assert.equal(pascalCase('blog-post'), 'BlogPost');
  assert.equal(pascalCase('task_list'), 'TaskList');
  assert.equal(pascalCase('HTMLParser'), 'HtmlParser');
});

test('camelCase lowercases the first word', () => {
  assert.equal(camelCase('task-list'), 'taskList');
  assert.equal(camelCase('BlogPost'), 'blogPost');
  assert.equal(camelCase(''), '');
});

test('kebabCase and snakeCase lowercase every word', () => {
  assert.equal(kebabCase('BlogPost'), 'blog-post');
  assert.equal(snakeCase('BlogPost'), 'blog_post');
  assert.equal(kebabCase('HTMLParser'), 'html-parser');
});

test('classNameFromFile derives a PascalCase class from a kebab filename', () => {
  assert.equal(classNameFromFile('models/blog-post.ts'), 'BlogPost');
  assert.equal(classNameFromFile('blog-post.tsx'), 'BlogPost');
  assert.equal(classNameFromFile('task-list.mts'), 'TaskList');
});

test('CONVENTION_DIRS keeps client and server component dirs distinct', () => {
  assert.equal(CONVENTION_DIRS.serverComponents, 'components');
  assert.equal(CONVENTION_DIRS.clientComponents, 'app/components');
});

test('GENERATOR_LAYOUT covers every make command type', () => {
  for (const type of MAKE_COMMAND_TYPES) {
    const layout = GENERATOR_LAYOUT[type];
    assert.ok(layout.dir.length > 0, `${type} has a dir`);
    assert.ok(layout.extension.startsWith('.'), `${type} has an extension`);
  }
  assert.equal(GENERATOR_LAYOUT.model.dir, CONVENTION_DIRS.models);
  assert.equal(GENERATOR_LAYOUT['server-component'].dir, CONVENTION_DIRS.serverComponents);
});

test('probeConventionFile returns the first existing candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-conventions-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'blog-post.ts'), 'export class BlogPost {}\n');

  assert.equal(probeConventionFile(dir, 'blog-post', MODEL_EXTENSIONS), join(dir, 'blog-post.ts'));
  assert.equal(probeConventionFile(dir, 'missing', MODEL_EXTENSIONS), undefined);
});

test('probeConventionFile honors extension order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-conventions-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'card.tsx'), 'export const Card = () => null;\n');
  writeFileSync(join(dir, 'card.ts'), 'export const Card = () => null;\n');

  assert.equal(
    probeConventionFile(dir, 'card', CLIENT_COMPONENT_EXTENSIONS),
    join(dir, 'card.tsx'),
  );
});
