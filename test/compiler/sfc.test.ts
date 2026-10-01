import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CompilerError } from '../../src/compiler/errors.js';
import { parseSfc } from '../../src/compiler/sfc.js';

function expectCompilerError(fn: () => unknown, code: string, subject?: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CompilerError, 'expected a CompilerError');
  assert.equal(error.code, code);
  if (subject !== undefined) {
    assert.equal(error.subject, subject);
  }
}

describe('parseSfc', () => {
  it('extracts all four blocks', () => {
    const source = [
      '<script>',
      "import { z } from 'zod';",
      'export const stateSchema = z.object({});',
      '</script>',
      '',
      '<template>',
      '<p>hi</p>',
      '</template>',
      '',
      '<style>',
      '.card { @apply card; }',
      '</style>',
      '',
      '<server>',
      "'use server';",
      '</server>',
    ].join('\n');

    const blocks = parseSfc(source);
    assert.match(blocks.script, /import \{ z \} from 'zod';/);
    assert.equal(blocks.template, '<p>hi</p>');
    assert.equal(blocks.style, '.card { @apply card; }');
    assert.equal(blocks.server, "'use server';");
  });

  it('is order-independent', () => {
    const source = [
      '<template>',
      '<p>hi</p>',
      '</template>',
      '<script>',
      'export const x = 1;',
      '</script>',
    ].join('\n');

    const blocks = parseSfc(source);
    assert.equal(blocks.template, '<p>hi</p>');
    assert.equal(blocks.script, 'export const x = 1;');
  });

  it('concatenates multiple style blocks in order', () => {
    const source = [
      '<script>',
      'export const x = 1;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
      '<style>',
      '.a { @apply a; }',
      '</style>',
      '<style>',
      '.b { @apply b; }',
      '</style>',
    ].join('\n');

    const blocks = parseSfc(source);
    assert.equal(blocks.style, '.a { @apply a; }\n.b { @apply b; }');
  });

  it('ignores custom blocks', () => {
    const source = [
      '<script>',
      'export const x = 1;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
      '<docs>',
      'some prose',
      '</docs>',
    ].join('\n');

    const blocks = parseSfc(source);
    assert.equal(blocks.script, 'export const x = 1;');
  });

  it('does not mistake a <template> inside a script string for the template block', () => {
    const source = [
      '<script>',
      "const s = '<template>not a block</template>';",
      'export const x = s;',
      '</script>',
      '<template>',
      '<p>real</p>',
      '</template>',
    ].join('\n');

    const blocks = parseSfc(source);
    assert.match(blocks.script, /not a block/);
    assert.equal(blocks.template, '<p>real</p>');
  });

  it('rejects a duplicate block', () => {
    const source = [
      '<script>',
      'export const x = 1;',
      '</script>',
      '<script>',
      'export const y = 2;',
      '</script>',
    ].join('\n');

    expectCompilerError(() => parseSfc(source), 'invalid_region', 'script');
  });

  it('rejects an unclosed block', () => {
    const source = ['<script>', 'export const x = 1;'].join('\n');
    expectCompilerError(() => parseSfc(source), 'unparseable', 'script');
  });

  it('rejects a mismatched close tag', () => {
    const source = ['<script>', 'export const x = 1;', '</template>'].join('\n');
    expectCompilerError(() => parseSfc(source), 'unparseable', 'script');
  });

  it('rejects text outside any block', () => {
    const source = ['stray text', '<script>', 'export const x = 1;', '</script>'].join('\n');
    expectCompilerError(() => parseSfc(source), 'unparseable', 'sfc');
  });

  it('rejects a file with neither script nor template', () => {
    const source = ['<style>', '.a { @apply a; }', '</style>'].join('\n');
    expectCompilerError(() => parseSfc(source), 'missing_region', 'script');
  });

  it('rejects a script-only file (template is required)', () => {
    const source = ['<script>', 'export const x = 1;', '</script>'].join('\n');
    expectCompilerError(() => parseSfc(source), 'missing_region', 'template');
  });

  it('returns empty strings for absent optional blocks (style and server)', () => {
    const source = [
      '<script>',
      'export const x = 1;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
    ].join('\n');
    const blocks = parseSfc(source);
    assert.equal(blocks.template, '<p>hi</p>');
    assert.equal(blocks.style, '');
    assert.equal(blocks.server, '');
  });

  it('reports the offset of each block body in the original source', () => {
    const source = [
      '<script>',
      'export const x = 1;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
    ].join('\n');
    const blocks = parseSfc(source);
    assert.equal(source.slice(blocks.offsets.script, blocks.offsets.script + 6), 'export');
    assert.equal(source.slice(blocks.offsets.template, blocks.offsets.template + 3), '<p>');
  });
});
