import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DiagnosticBag } from '../../src/compiler/diagnostics.js';
import { lowerTemplateRegion } from '../../src/compiler/template.js';

/** Lower a view region with a fresh bag and assert no diagnostic was recorded. */
function lower(view: string, baseOffset = 0) {
  const bag = new DiagnosticBag({ source: view, frames: false });
  const lowered = lowerTemplateRegion(view, baseOffset, bag);
  assert.deepEqual(bag.toList(), []);
  return lowered;
}

test('returns a raw-JSX view region unchanged', () => {
  const view = 'export const x = defineComponent({ render: () => <p>hi</p> });';
  const lowered = lower(view, 100);
  assert.equal(lowered.code, view);
  // Raw JSX lowers to itself, so the offset is the region's own start.
  assert.equal(lowered.offset, 100);
  assert.equal(lowered.wasTemplate, false);
});

test('returns a region with a non-leading <template> string unchanged', () => {
  const view = 'const s = "<template>";\nexport const x = 1;';
  assert.equal(lower(view).code, view);
});

test('lowers a leading <template> block to JSX', () => {
  const view = '<template><p>{name}</p></template>';
  const lowered = lower(view);
  assert.equal(lowered.code, '<p>{name}</p>');
  // The body starts right after `<template>`.
  assert.equal(lowered.offset, '<template>'.length);
  assert.equal(lowered.wasTemplate, true);
});

test('lowers a <template> block with surrounding whitespace', () => {
  const view = '\n  <template><p js-if="ok">yes</p></template>\n';
  const lowered = lower(view);
  assert.equal(lowered.code, '{ok ? (<p>yes</p>) : null}');
  assert.equal(lowered.offset, view.indexOf('<template>') + '<template>'.length);
});

test('lowers the spec §2.5 example to the expected JSX shape', () => {
  const view = [
    '<template>',
    '  <form js-submit="add">',
    '    <input js-model="title" />',
    '    <button js-if="title">Add</button>',
    '  </form>',
    '</template>',
  ].join('\n');
  const lowered = lower(view);
  assert.match(lowered.code, /\{\.\.\.submit\('add'\)\}/);
  assert.match(lowered.code, /\{\.\.\.bind\('title'\)\}/);
  assert.match(lowered.code, /\{title \? \(<button>Add<\/button>\) : null\}/);
});

test('a <template> block with a parse error reports a positioned diagnostic', () => {
  const view = '<template><div></template>';
  const bag = new DiagnosticBag({ source: view, frames: false });
  const lowered = lowerTemplateRegion(view, 0, bag);
  assert.equal(lowered.code, '');
  assert.equal(lowered.wasTemplate, true);
  const [diag] = bag.toList();
  assert.ok(diag !== undefined);
  assert.equal(diag.code, 'unparseable');
});

test("carries the template's capitalized tags with source-absolute positions", () => {
  const view = '<template><div><Counter /></div></template>';
  const lowered = lower(view);
  assert.deepEqual(
    lowered.components?.map((c) => c.tag),
    ['Counter'],
  );
  const counter = lowered.components?.[0];
  assert.ok(counter !== undefined);
  assert.equal(view.slice(counter.start, counter.end), '<Counter />');
});
