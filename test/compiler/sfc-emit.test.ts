import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSync } from 'rolldown/utils';

import { CompilerError } from '../../src/compiler/errors.js';
import { emitSfc } from '../../src/compiler/sfc-emit.js';

const OPTIONS = { name: 'widget', fromDir: '.', rootDir: '.' } as const;

/** Assert the emitted module parses as valid TSX. */
function assertValidTsx(code: string): void {
  const result = parseSync('widget.tsx', code, { sourceType: 'module' });
  const errors = result.errors.filter((error) => error.severity === 'Error');
  assert.equal(errors.length, 0, `emitted module did not parse:\n${code}`);
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode a VLQ value at `index`, returning the value and the next index. */
function readVlq(segment: string, index: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let cursor = index;
  for (;;) {
    const digit = BASE64.indexOf(segment[cursor] ?? '');
    assert.ok(digit >= 0, `invalid VLQ digit at ${cursor}`);
    cursor += 1;
    result += (digit & 31) << shift;
    if ((digit & 32) === 0) {
      break;
    }
    shift += 5;
  }
  const negative = (result & 1) === 1;
  const magnitude = result >> 1;
  return { value: negative ? -magnitude : magnitude, next: cursor };
}

/** Decode a `mappings` string into `generatedLine → { sourceLine }`. */
function decodeMappings(mappings: string): Map<number, { sourceLine: number }> {
  const result = new Map<number, { sourceLine: number }>();
  let sourceLine = 0;
  const generatedLines = mappings.split(';');
  for (let genLine = 0; genLine < generatedLines.length; genLine += 1) {
    const line = generatedLines[genLine] ?? '';
    if (line.length === 0) {
      continue;
    }
    for (const segment of line.split(',')) {
      let cursor = readVlq(segment, 0).next; // skip genCol
      if (cursor >= segment.length) {
        continue;
      }
      cursor = readVlq(segment, cursor).next; // skip sourceIndex
      const srcLine = readVlq(segment, cursor);
      cursor = srcLine.next;
      sourceLine += srcLine.value;
      result.set(genLine, { sourceLine });
    }
  }
  return result;
}

function sfc(parts: { script: string; template: string; style?: string; server?: string }): string {
  const blocks = [
    `<script>\n${parts.script}\n</script>`,
    `<template>\n${parts.template}\n</template>`,
  ];
  if (parts.style !== undefined) {
    blocks.push(`<style>\n${parts.style}\n</style>`);
  }
  if (parts.server !== undefined) {
    blocks.push(`<server>\n${parts.server}\n</server>`);
  }
  return blocks.join('\n');
}

describe('emitSfc', () => {
  it('assembles a defineComponent module from the script and template', () => {
    const source = sfc({
      script: [
        "import { z } from 'zod';",
        'export const stateSchema = z.object({ title: z.string() });',
        "export const writableKeys = ['title'];",
        "export const initialState = () => ({ title: '' });",
        'export const authorize = () => true;',
      ].join('\n'),
      template: '<p>{{ title }}</p>',
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.match(out.code, /import \{ defineComponent \} from 'jsails\/server-components';/);
    assert.match(out.code, /export const widget = defineComponent\(\{/);
    assert.match(out.code, /name: 'widget',/);
    assert.match(out.code, /render\(state, tools\) \{/);
    assert.match(out.code, /<p>\{title\}<\/p>/);
    assertValidTsx(out.code);
    assert.ok(Array.isArray(out.diagnostics));
    assert.equal(out.diagnostics.length, 0);
  });

  it('emits only the config keys the script declared', () => {
    const source = sfc({
      script: [
        "import { z } from 'zod';",
        'export const stateSchema = z.object({});',
        'export const authorize = () => true;',
      ].join('\n'),
      template: '<p>hi</p>',
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.match(out.code, /^ {2}stateSchema,$/m);
    assert.match(out.code, /^ {2}authorize,$/m);
    assert.doesNotMatch(out.code, /^ {2}actions,$/m);
    assert.doesNotMatch(out.code, /^ {2}derived,$/m);
    assert.doesNotMatch(out.code, /^ {2}staticFallback,$/m);
    assert.doesNotMatch(out.code, /^ {2}urlBinding,$/m);
    assertValidTsx(out.code);
  });

  it('recognizes a re-exported config key', () => {
    const source = sfc({
      script: [
        "import { z } from 'zod';",
        'const stateSchema = z.object({});',
        'const authorize = () => true;',
        'export { stateSchema, authorize };',
      ].join('\n'),
      template: '<p>hi</p>',
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.match(out.code, /^ {2}stateSchema,$/m);
    assert.match(out.code, /^ {2}authorize,$/m);
    assertValidTsx(out.code);
  });

  it('returns the <style> body in the css band', () => {
    const source = sfc({
      script: 'export const authorize = () => true;',
      template: '<p>hi</p>',
      style: '.card { @apply card bg-base-100; }',
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.equal(out.css, '.card { @apply card bg-base-100; }');
    assert.doesNotMatch(out.code, /@apply/);
  });

  it('returns an empty css band when there is no <style> block', () => {
    const source = sfc({
      script: 'export const authorize = () => true;',
      template: '<p>hi</p>',
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.equal(out.css, '');
  });

  it('lowers js-* directives in the template', () => {
    const source = sfc({
      script: [
        "import { z } from 'zod';",
        'export const stateSchema = z.object({ title: z.string(), tasks: z.array(z.string()) });',
        "export const writableKeys = ['title'];",
        'export const authorize = () => true;',
      ].join('\n'),
      template: [
        '<form js-on:submit.prevent="add">',
        '  <input js-model="title" />',
        '  <button js-if="title">Add</button>',
        '</form>',
        '<ul><li js-for="task in tasks">{{ task }}</li></ul>',
      ].join('\n'),
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.match(out.code, /onSubmit=\{\(e\) => \{ e\.preventDefault\(\); add\(e\); \}\}/);
    assert.match(out.code, /\{\.\.\.bind\('title'\)\}/);
    assert.match(out.code, /\{title \? \(<button>Add<\/button>\) : null\}/);
    assert.match(out.code, /\{tasks\.map\(\(task\) => \(<li>\{task\}<\/li>\)\)\}/);
    assertValidTsx(out.code);
  });

  it('injects the preact h import for a dynamic component', () => {
    const source = sfc({
      script: 'export const authorize = () => true;',
      template: '<component js-is="X" />',
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.match(out.code, /import \{ h \} from 'preact';/);
    assert.match(out.code, /\{h\(X, \{\}\)\}/);
    assertValidTsx(out.code);
  });

  it('does not inject the h import when no dynamic component is used', () => {
    const source = sfc({
      script: 'export const authorize = () => true;',
      template: '<p>hi</p>',
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.doesNotMatch(out.code, /from 'preact'/);
  });

  it('appends the <server> body to the module', () => {
    const source = sfc({
      script: 'export const authorize = () => true;',
      template: '<p>hi</p>',
      server: "'use server';\nexport async function load() { return 1; }",
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.match(out.code, /'use server';/);
    assert.match(out.code, /export async function load\(\)/);
    assertValidTsx(out.code);
  });

  it('rejects a file missing the template block', () => {
    const source = ['<script>', 'export const authorize = () => true;', '</script>'].join('\n');
    let thrown: unknown;
    try {
      emitSfc(source, 'widget.jsails', OPTIONS);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof CompilerError);
    assert.equal(thrown.code, 'missing_region');
    assert.equal(thrown.subject, 'template');
  });

  it('returns a real, resolvable source map', () => {
    const source = sfc({
      script: 'export const authorize = () => true;',
      template: '<p>hi</p>',
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.ok(out.map !== null, 'expected a source map');
    assert.equal(out.map.version, 3);
    assert.equal(out.map.sources.length, 1);
    assert.equal(out.map.sourcesContent[0], source);

    // The `<template>` body (`<p>hi</p>`) sits on line 5 (0-based: 4). The
    // emitted `return (<>…</>)` line must resolve back to it.
    const decoded = decodeMappings(out.map.mappings);
    const generated = out.code.split('\n');
    const templateGenLine = generated.findIndex(
      (line) => line.includes('return (') && line.includes('<>'),
    );
    assert.ok(templateGenLine >= 0, 'expected the rendered template line');
    const resolved = decoded.get(templateGenLine);
    assert.ok(resolved !== undefined, 'expected the template line to be mapped');
    assert.equal(resolved.sourceLine, 4);
  });

  it('error in template: returns code="" and non-empty diagnostics', () => {
    const source = sfc({
      script: 'export const authorize = () => true;',
      template: '<p js-frob="x">bad</p>',
    });

    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.equal(out.code, '');
    assert.ok(out.diagnostics.length >= 1, 'should have at least one diagnostic');
    const d = out.diagnostics.find((d) => d.code === 'unknown_directive');
    assert.ok(d !== undefined, 'should have unknown_directive error');
  });
});
