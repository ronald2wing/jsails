import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseTemplate,
  type TemplateNode,
  type TemplateParseReporter,
} from '../../src/compiler/template-ast.js';

/** A single raw report captured by {@link recorder}. */
interface CapturedReport {
  readonly code: string;
  readonly message: string;
  readonly subject: string;
  readonly start: number;
  readonly end: number;
}

/** A reporter that records raw reports (offsets in) for assertions. */
function recorder(): { report: TemplateParseReporter; reports: CapturedReport[] } {
  const reports: CapturedReport[] = [];
  return {
    report: (code, message, subject, start, end) => {
      reports.push({ code, message, subject, start, end });
    },
    reports,
  };
}

/** Parse `source`, returning both the tree and any recorded reports. */
function parse(source: string): { nodes: readonly TemplateNode[]; reports: CapturedReport[] } {
  const { report, reports } = recorder();
  return { nodes: parseTemplate(source, report), reports };
}

/** Parse valid source, asserting no report was recorded. */
function ok(source: string): readonly TemplateNode[] {
  const { nodes, reports } = parse(source);
  assert.deepEqual(reports, []);
  return nodes;
}

test('parses a single element with text', () => {
  const nodes = ok('<p>hello</p>');
  assert.equal(nodes.length, 1);
  const el = nodes[0] as Extract<TemplateNode, { kind: 'element' }>;
  assert.equal(el.kind, 'element');
  assert.equal(el.tag, 'p');
  assert.equal(el.children.length, 1);
  const text = el.children[0] as Extract<TemplateNode, { kind: 'text' }>;
  assert.equal(text.kind, 'text');
  assert.equal(text.value, 'hello');
});

test('a node spans its exact source slice', () => {
  const source = '<p class="x">hi</p>';
  const el = ok(source)[0] as Extract<TemplateNode, { kind: 'element' }>;
  assert.equal(source.slice(el.start, el.end), source);
  const text = el.children[0] as Extract<TemplateNode, { kind: 'text' }>;
  assert.equal(source.slice(text.start, text.end), 'hi');
});

test('parses a self-closing element', () => {
  const nodes = ok('<br />');
  const el = nodes[0] as Extract<TemplateNode, { kind: 'element' }>;
  assert.equal(el.tag, 'br');
  assert.equal(el.children.length, 0);
});

test('parses nested elements', () => {
  const nodes = ok('<div><span>a</span></div>');
  const div = nodes[0] as Extract<TemplateNode, { kind: 'element' }>;
  assert.equal(div.tag, 'div');
  const span = div.children[0] as Extract<TemplateNode, { kind: 'element' }>;
  assert.equal(span.tag, 'span');
});

test('parses an interpolation', () => {
  const source = '{count}';
  const node = ok(source)[0] as Extract<TemplateNode, { kind: 'interpolation' }>;
  assert.equal(node.expr, 'count');
  assert.equal(source.slice(node.start, node.end), source);
});

test('parses a nested-brace interpolation', () => {
  const node = ok('{ { a: 1 } }')[0] as Extract<TemplateNode, { kind: 'interpolation' }>;
  assert.equal(node.expr, ' { a: 1 } ');
});

test('parses bare, quoted, and brace attributes', () => {
  const source = '<input disabled class="x" :value={v} />';
  const el = ok(source)[0] as Extract<TemplateNode, { kind: 'element' }>;
  const attrs = el.attrs;
  assert.equal(attrs[0]?.name, 'disabled');
  assert.equal(attrs[0]?.value, null);
  assert.equal(attrs[0]?.valueKind, null);
  assert.equal(attrs[1]?.name, 'class');
  assert.equal(attrs[1]?.value, 'x');
  assert.equal(attrs[1]?.valueKind, 'quoted');
  assert.equal(attrs[2]?.name, ':value');
  assert.equal(attrs[2]?.value, 'v');
  assert.equal(attrs[2]?.valueKind, 'expr');
  const first = attrs[0];
  assert.ok(first !== undefined);
  assert.equal(source.slice(first.start, first.end), 'disabled');
});

test('parses single-quoted attribute values', () => {
  const el = ok("<a href='/x'>y</a>")[0] as Extract<TemplateNode, { kind: 'element' }>;
  const attr = el.attrs[0];
  assert.equal(attr?.name, 'href');
  assert.equal(attr?.value, '/x');
  assert.equal(attr?.valueKind, 'quoted');
});

/** Assert a parse reports exactly one `unparseable` diagnostic. */
function expectUnparseable(source: string, subject: string): CapturedReport {
  const { nodes, reports } = parse(source);
  assert.deepEqual(nodes, [], 'no tree is returned after a parse error');
  assert.equal(reports.length, 1);
  const [report] = reports;
  assert.ok(report !== undefined);
  assert.equal(report.code, 'unparseable');
  assert.equal(report.subject, subject);
  assert.ok(report.end > report.start, 'the range is non-empty');
  return report;
}

test('reports unparseable for an unclosed tag', () => {
  expectUnparseable('<div>', 'div');
});

test('reports unparseable for a mismatched close tag', () => {
  expectUnparseable('<div></span>', 'div');
});

test('reports unparseable for an empty template', () => {
  expectUnparseable('   ', 'template');
});

test('reports unparseable for an unterminated interpolation', () => {
  expectUnparseable('{count', 'template');
});

test('reports unparseable for an unterminated attribute value', () => {
  expectUnparseable('<a href="x>y</a>', 'href');
});

test('error messages never echo source text', () => {
  const report = expectUnparseable('<div>SECRET_TOKEN', 'div');
  assert.ok(!report.message.includes('SECRET_TOKEN'));
});
