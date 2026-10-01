import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { compilerPlugin, surfaceDiagnostics } from '../../src/compiler/compiler-plugin.js';
import {
  CompilerBuildError,
  CompilerError,
  type CompileDiagnostic,
} from '../../src/compiler/errors.js';

/** A warning-severity diagnostic fixture for the diagnostic-routing tests. */
const WARNING_DIAGNOSTIC: CompileDiagnostic = Object.freeze({
  severity: 'warning',
  code: 'unknown_directive',
  message: 'a warning',
  range: {
    start: { line: 1, column: 1 },
    end: { line: 1, column: 1 },
  },
  frame: '',
});

/** An error-severity diagnostic fixture for the diagnostic-routing tests. */
const ERROR_DIAGNOSTIC: CompileDiagnostic = Object.freeze({
  severity: 'error',
  code: 'unresolved_component',
  message: 'a failure',
  range: {
    start: { line: 2, column: 3 },
    end: { line: 2, column: 3 },
  },
  frame: '',
});

// Resolve the fixture from the repo root: templates are not copied into dist/.
const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const taskListFixture = readFileSync(
  join(packageRoot, 'templates/starter/components/task-list.tsx'),
  'utf-8',
);

const SYNTHETIC_COMPONENT = `// #region model
const stateSchema = 1;
// #endregion model

// #region server
// #endregion server

// #region style
const style = 1;
// #endregion style

// #region view
export const view = <form js-submit="add" />;
// #endregion view
`;

const MALFORMED_COMPONENT = `// #region model
// #endregion model
// #region model
// #endregion model
// #region server
// #endregion server
// #region style
// #endregion style
// #region view
// #endregion view
`;

describe('compilerPlugin', () => {
  it('has the expected plugin shape', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.name, 'jsails-component-compiler');
    assert.equal(plugin.enforce, 'pre');
    assert.equal(typeof plugin.transform, 'function');
    assert.equal(typeof plugin.resolveId, 'function');
    assert.equal(typeof plugin.load, 'function');
  });

  it('returns null for a .tsx id with no region markers', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.transform('export const x = 1;\n', 'plain.tsx'), null);
  });

  it('returns null for a CSS id', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.transform('// #region model\n', 'styles.css'), null);
  });

  it('returns null for a .ts id outside the default include', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.transform(SYNTHETIC_COMPONENT, 'component.ts'), null);
  });

  it('returns null for the shipped task-list fixture (no js-* directives)', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.transform(taskListFixture, 'task-list.tsx'), null);
  });

  it('lowers a js-submit directive in the view region', () => {
    const plugin = compilerPlugin();
    const result = plugin.transform(SYNTHETIC_COMPONENT, 'synthetic.tsx');
    assert.ok(result !== null);
    assert.ok(result.map !== null, 'expected a source map');
    assert.ok(result.code.includes('{...submit(add)}'));
  });

  it('throws invalid_region for a malformed component', () => {
    const plugin = compilerPlugin();
    try {
      plugin.transform(MALFORMED_COMPONENT, 'malformed.tsx');
    } catch (error) {
      assert.ok(error instanceof CompilerError, `expected CompilerError, got ${String(error)}`);
      assert.equal(error.code, 'invalid_region');
      return;
    }
    assert.fail('expected CompilerError to be thrown');
  });

  it('resolves a capitalized tag to an import using rootDir', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-resolve-'));
    const componentsDir = join(root, 'app', 'components');
    mkdirSync(componentsDir, { recursive: true });
    writeFileSync(join(componentsDir, 'counter.tsx'), 'export const Counter = 1;');

    const component = `// #region model
// #endregion model

// #region server
// #endregion server

// #region style
// #endregion style

// #region view
export const view = <Counter />;
// #endregion view
`;

    try {
      const plugin = compilerPlugin({ rootDir: root });
      const result = plugin.transform(component, join(componentsDir, 'widget.tsx'));
      assert.ok(result !== null);
      assert.match(result.code, /import \{ Counter \} from '\.\/counter\.js';/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a .jsails specifier to a virtual .jsails.tsx id', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.resolveId('./widget.jsails'), './widget.jsails.tsx');
    assert.equal(plugin.resolveId('./widget.tsx'), null);
  });

  it('loads the real .jsails file for its virtual id', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-sfc-load-'));
    const file = join(root, 'widget.jsails');
    writeFileSync(file, '<script>export const x = 1;\n</script>\n<template><p>hi</p></template>');

    try {
      const plugin = compilerPlugin();
      assert.equal(
        plugin.load(`${file}.tsx`),
        '<script>export const x = 1;\n</script>\n<template><p>hi</p></template>',
      );
      assert.equal(plugin.load(file), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('compiles a .jsails single-file component', () => {
    const sfc = [
      '<script>',
      "import { z } from 'zod';",
      'export const stateSchema = z.object({ title: z.string() });',
      'export const authorize = () => true;',
      '</script>',
      '<template>',
      '<p js-if="title">{{ title }}</p>',
      '</template>',
    ].join('\n');

    const plugin = compilerPlugin();
    const result = plugin.transform(sfc, 'widget.jsails.tsx');
    assert.ok(result !== null);
    assert.ok(result.map !== null, 'expected a source map');
    assert.match(result.code, /export const widget = defineComponent\(\{/);
    assert.match(result.code, /\{title \? \(<p>\{title\}<\/p>\) : null\}/);
  });

  it('returns the <style> body on the css side-channel for a .jsails component', () => {
    const sfc = [
      '<script>',
      'export const authorize = () => true;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
      '<style>',
      '.card { @apply card; }',
      '</style>',
    ].join('\n');

    const plugin = compilerPlugin();
    const result = plugin.transform(sfc, 'widget.jsails.tsx');
    assert.ok(result !== null);
    assert.equal(result.css, '.card { @apply card; }');
  });

  it('omits the css side-channel when a .jsails component has no <style>', () => {
    const sfc = [
      '<script>',
      'export const authorize = () => true;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
    ].join('\n');

    const plugin = compilerPlugin();
    const result = plugin.transform(sfc, 'widget.jsails.tsx');
    assert.ok(result !== null);
    assert.equal(result.css, undefined);
  });

  it('throws a value-free CompilerError for a malformed .jsails component', () => {
    const plugin = compilerPlugin();
    try {
      plugin.transform('<script>export const x = 1;\n</script>', 'widget.jsails.tsx');
    } catch (error) {
      assert.ok(error instanceof CompilerError, `expected CompilerError, got ${String(error)}`);
      assert.equal(error.code, 'missing_region');
      assert.equal(error.subject, 'template');
      return;
    }
    assert.fail('expected CompilerError to be thrown');
  });

  it('aborts the build with a positioned CompilerBuildError on error diagnostics', () => {
    const component = `// #region model
// #endregion model

// #region server
// #endregion server

// #region style
// #endregion style

// #region view
export const view = <Counter />;
// #endregion view
`;

    const plugin = compilerPlugin({ rootDir: tmpdir() });
    try {
      plugin.transform(component, join(tmpdir(), 'widget.tsx'));
    } catch (error) {
      assert.ok(
        error instanceof CompilerBuildError,
        `expected CompilerBuildError, got ${String(error)}`,
      );
      assert.equal(error.code, 'unresolved_component');
      assert.equal(error.loc.file, join(tmpdir(), 'widget.tsx'));
      assert.ok(error.loc.line >= 1);
      assert.ok(error.loc.column >= 1);
      assert.equal(error.diagnostics.length, 1);
      const [first] = error.diagnostics;
      assert.ok(first !== undefined);
      assert.equal(first.severity, 'error');
      assert.equal(first.code, 'unresolved_component');
      return;
    }
    assert.fail('expected CompilerBuildError to be thrown');
  });

  it('surfaces warnings through the warn callback without aborting', () => {
    const reported: string[] = [];
    surfaceDiagnostics('widget.tsx', [WARNING_DIAGNOSTIC], (message) => reported.push(message));
    assert.equal(reported.length, 1);
    assert.match(reported[0] ?? '', /widget\.tsx:1:1: warning\[unknown_directive\]: a warning/);
  });

  it('throws CompilerBuildError only for error-severity diagnostics', () => {
    assert.throws(
      () => surfaceDiagnostics('widget.tsx', [WARNING_DIAGNOSTIC, ERROR_DIAGNOSTIC]),
      (error: unknown) => {
        assert.ok(error instanceof CompilerBuildError);
        assert.equal(error.diagnostics.length, 1);
        assert.equal(error.diagnostics[0]?.severity, 'error');
        return true;
      },
    );
  });
});
