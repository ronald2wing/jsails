/**
 * `'use server'` source-transform tests (Node-import safe).
 *
 * These tests exercise the pure `source -> source` rewrite. The compiler API is
 * the only dependency; no bundler is loaded, so the suite runs under plain Node.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ServerDirectiveError,
  serverDirectivePlugin,
  stripServerDirectives,
} from '../../src/build/index.js';

describe('stripServerDirectives', () => {
  it('leaves a module with no directive byte-identical', () => {
    const source = 'export const value = 1;\n';
    const result = stripServerDirectives(source, 'plain.ts');

    assert.equal(result.code, source);
    assert.equal(result.hadDirective, false);
    assert.deepEqual(result.stubbed, []);
  });

  it('strips a function-level directive and keeps the signature', () => {
    const source = [
      "import { Task } from './task.js';",
      '',
      'export async function persist(title: string): Promise<void> {',
      "  'use server';",
      '  await Task.create({ title });',
      '}',
      '',
      'export function clientSafe(x: number): number { return x + 1; }',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'mixed.tsx');

    assert.equal(result.hadDirective, true);
    assert.deepEqual(result.stubbed, ['persist']);
    assert.match(result.code, /export async function persist\(title: string\): Promise<void> \{/);
    assert.match(result.code, /server-only function \\?"persist\\?"/);
    assert.doesNotMatch(result.code, /Task\.create/);
    assert.match(
      result.code,
      /export function clientSafe\(x: number\): number \{ return x \+ 1; \}/,
    );
  });

  it('strips an exported const-arrow directive', () => {
    const source = [
      'export const add = async (title: string): Promise<void> => {',
      "  'use server';",
      '  await save(title);',
      '};',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'arrow.ts');

    assert.deepEqual(result.stubbed, ['add']);
    assert.match(result.code, /server-only function \\?"add\\?"/);
    assert.doesNotMatch(result.code, /save\(title\)/);
  });

  it('strips an exported function-expression directive', () => {
    const source = [
      'export const persist = async function (title: string): Promise<void> {',
      "  'use server';",
      '  await save(title);',
      '};',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'expr.ts');

    assert.deepEqual(result.stubbed, ['persist']);
    assert.match(result.code, /server-only function \\?"persist\\?"/);
    assert.doesNotMatch(result.code, /save\(title\)/);
  });

  it('stubs every exported function on a file-level directive', () => {
    const source = [
      "'use server';",
      'export async function a() { return read(); }',
      'export const b = async () => { return read2(); };',
      'export function c() { return 3; }',
      'export const notAFunction = 42;',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'server.ts');

    assert.equal(result.hadDirective, true);
    assert.deepEqual(result.stubbed, ['a', 'b', 'c']);
    assert.doesNotMatch(result.code, /read\(\)|read2\(\)/);
    assert.match(result.code, /export const notAFunction = 42;/);
  });

  it('fails closed on a marked non-exported function (un-stubable, would leak)', () => {
    const source = [
      "function helper() { 'use server'; return secret(); }",
      'export const value = helper;',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'private.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('is pure: the same input yields the same output', () => {
    const source = "export const a = async () => { 'use server'; await x(); };\n";
    const first = stripServerDirectives(source, 'p.ts');
    const second = stripServerDirectives(source, 'p.ts');

    assert.deepEqual(first, second);
  });

  it('throws on a directive attached to a class method', () => {
    const source = [
      'class Service {',
      "  async run() { 'use server'; await x(); }",
      '}',
      'export { Service };',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'method.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive attached to an object property', () => {
    const source = [
      'export const handlers = {',
      "  run: async () => { 'use server'; await x(); },",
      '};',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'prop.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive inside a nested closure', () => {
    const source = [
      'export function outer() {',
      "  return () => { 'use server'; return 1; };",
      '}',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'nested.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive inside an immediately-invoked function expression', () => {
    const source = ["(function () { 'use server'; })();", ''].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'iife.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive inside a bare block statement', () => {
    const source = ['export function f() {', "  { 'use server'; }", '  return 1;', '}', ''].join(
      '\n',
    );

    assert.throws(
      () => stripServerDirectives(source, 'block.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a top-level directive that is not the module prologue', () => {
    const source = [
      'export const x = 1;',
      "'use server';",
      'export function f() { return 1; }',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'midfile.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive that is not the first statement of a function body', () => {
    const source = [
      'export function f() {',
      '  const a = 1;',
      "  'use server';",
      '  return a;',
      '}',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'midbody.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('does not flag an inert use-server string literal', () => {
    const source = [
      'export function f() {',
      "  const s = 'use server';",
      '  return s;',
      '}',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'literal.ts');
    assert.equal(result.hadDirective, false);
    assert.deepEqual(result.stubbed, []);
  });

  it('throws on a re-export inside a server module', () => {
    const source = ["'use server';", "export { persist } from './persist.js';", ''].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'reexport.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on unparseable source', () => {
    assert.throws(
      () => stripServerDirectives('export function (', 'broken.ts'),
      (error: unknown) => error instanceof ServerDirectiveError && error.code === 'unparseable',
    );
  });

  it('carries no source text in the error message', () => {
    const source = ["'use server';", "export { persist } from './persist.js';", ''].join('\n');
    try {
      stripServerDirectives(source, 'reexport.ts');
      assert.fail('expected ServerDirectiveError');
    } catch (error) {
      assert.ok(error instanceof ServerDirectiveError);
      assert.doesNotMatch(error.message, /persist/);
    }
  });
});

describe('serverDirectivePlugin', () => {
  it('reports the bundler shape: name, enforce pre, transform', () => {
    const plugin = serverDirectivePlugin();

    assert.equal(plugin.name, 'jsails-use-server-directive');
    assert.equal(plugin.enforce, 'pre');
    assert.equal(typeof plugin.transform, 'function');
  });

  it('returns null when the module carries no directive', () => {
    const plugin = serverDirectivePlugin();

    assert.equal(plugin.transform('export const x = 1;', '/app/plain.ts'), null);
  });

  it('returns rewritten code when a function is marked', () => {
    const plugin = serverDirectivePlugin();
    const source = "export const a = async () => { 'use server'; await x(); };\n";

    const result = plugin.transform(source, '/app/mixed.ts');

    assert.ok(result !== null);
    assert.match(result.code, /server-only function \\?"a\\?"/);
    assert.equal(result.map, null);
  });

  it('skips CSS and non-source modules', () => {
    const plugin = serverDirectivePlugin();
    const source = "export const a = async () => { 'use server'; await x(); };\n";

    assert.equal(plugin.transform(source, '/app/styles.css'), null);
    assert.equal(plugin.transform(source, '/app/file.json'), null);
  });

  it('skips everything when configured as a server build', () => {
    const plugin = serverDirectivePlugin({ server: true });
    const source = "export const a = async () => { 'use server'; await x(); };\n";

    assert.equal(plugin.transform(source, '/app/mixed.ts'), null);
  });

  it('honors a custom include list', () => {
    const plugin = serverDirectivePlugin({ include: ['.tsx'] });
    const source = "export const a = async () => { 'use server'; await x(); };\n";

    assert.equal(plugin.transform(source, '/app/mixed.ts'), null);
    assert.ok(plugin.transform(source, '/app/mixed.tsx') !== null);
  });
});
