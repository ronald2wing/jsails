import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { parseSync } from 'rolldown/utils';

import { emitComponent } from '../../src/compiler/emit.js';
import { extractRegions } from '../../src/compiler/regions.js';

// Resolve the real fixture from the repo root.
const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const taskListFixture = readFileSync(
  join(packageRoot, 'templates/starter/components/task-list.tsx'),
  'utf-8',
);

/**
 * A synthetic view region with `js-*` attribute directives that should be
 * lowered to render-tool spread calls. This is a standalone view region body
 * (no surrounding region markers) — `emitComponent` lowers directives in the
 * view region before reassembly.
 */
const viewWithDirectives = `<form js-submit="add">\n  <input js-ignore />\n</form>\n`;

/**
 * Build a `ComponentRegions` fixture with zeroed offsets. `emitComponent`
 * consumes only the region strings; offsets are relevant to diagnostics only.
 */
function testRegions(view: string, preamble = ''): Parameters<typeof emitComponent>[0]['regions'] {
  return {
    preamble,
    model: '',
    server: '',
    style: '',
    view,
    offsets: { preamble: 0, model: 0, server: 0, style: 0, view: 0 },
  };
}

/**
 * A synthetic component suitable for Shape 3 (multi-file) splitting. Imports
 * are placed inside the model region so `extractRegions` captures them, and
 * the reassembled source carries valid import declarations for `planSplit`.
 * The server region carries a `'use server'` function that references only
 * imports (`z`). No unmigratable references.
 */
const shape3Clean = `// #region model
import { z } from 'zod';
import { defineComponent } from '../app/application-component.js';

const stateSchema = z.object({ title: z.string() }).strict();
type WidgetState = z.infer<typeof stateSchema>;
const initialState = () => ({ title: '' });
// #endregion model

// #region server
function doWork() {
  'use server';
  return z.object({}).parse({});
}
// #endregion server

// #region style
// #endregion style

// #region view
export const widget = defineComponent<WidgetState>({
  name: 'widget',
  stateSchema,
  initialState,
  render(state) {
    return null;
  },
});
// #endregion view
`;

/**
 * A synthetic component whose server region references a non-imported,
 * non-migrated helper from the model region. The closure rule in `planSplit`
 * must reject it with `unmigratable_reference`, subject `helper`.
 */
const shape3Refusal = `// #region model
import { z } from 'zod';
import { defineComponent } from '../app/application-component.js';

const helper = 42;
const stateSchema = z.object({ title: z.string() }).strict();
type WidgetState = z.infer<typeof stateSchema>;
const initialState = () => ({ title: '' });
// #endregion model

// #region server
function doWork() {
  'use server';
  return helper;
}
// #endregion server

// #region style
// #endregion style

// #region view
export const widget = defineComponent<WidgetState>({
  name: 'widget',
  stateSchema,
  initialState,
  render(state) {
    return null;
  },
});
// #endregion view
`;

function assertParseOk(code: string, fileName: string): void {
  const result = parseSync(fileName, code, { sourceType: 'module' });
  const hasError = result.errors.some((e: { severity: string }) => e.severity === 'Error');
  assert.equal(hasError, false, `parse errors: ${JSON.stringify(result.errors)}`);
}

describe('emitComponent', () => {
  it('Shape 1 round-trip: extracts, reassembles and re-extracts matching regions', () => {
    const regions = extractRegions(taskListFixture, 'task-list.tsx');
    const emitted = emitComponent({
      name: 'task-list',
      regions,
      shape: 'single',
    });

    // Must contain all four region markers and the component definition.
    assert.match(emitted.entry, /\/\/ #region model/);
    assert.match(emitted.entry, /\/\/ #region server/);
    assert.match(emitted.entry, /\/\/ #region style/);
    assert.match(emitted.entry, /\/\/ #region view/);
    assert.match(emitted.entry, /defineComponent/);

    // Idempotence: re-extracting returns the same region text. Offsets are
    // source-relative and legitimately differ from the original fixture.
    const reExtracted = extractRegions(emitted.entry, 'task-list.tsx');
    for (const name of ['preamble', 'model', 'server', 'style', 'view'] as const) {
      assert.equal(reExtracted[name], regions[name]);
    }
  });

  it('Shape 1 validity: emitted entry parses cleanly (0 errors)', () => {
    const regions = extractRegions(taskListFixture, 'task-list.tsx');
    const emitted = emitComponent({
      name: 'task-list',
      regions,
      shape: 'single',
    });

    // Use a .tsx filename so parseSync treats the input as TypeScript JSX.
    assertParseOk(emitted.entry, 'task-list.tsx');
  });

  it('result carries diagnostics field', () => {
    const regions = extractRegions(taskListFixture, 'task-list.tsx');
    const emitted = emitComponent({
      name: 'task-list',
      regions,
      shape: 'single',
    });
    assert.ok(Array.isArray(emitted.diagnostics));
    assert.equal(emitted.diagnostics.length, 0);
  });

  it('Shape 1 preserves the preamble (file doc comment and imports)', () => {
    const regions = extractRegions(taskListFixture, 'task-list.tsx');
    const emitted = emitComponent({
      name: 'task-list',
      regions,
      shape: 'single',
    });

    // The imports live above the first region marker; dropping them would emit
    // a component that does not compile.
    assert.match(emitted.entry, /from 'zod'/);
    assert.match(emitted.entry, /application-component/);
  });

  it('directive lowering: js-submit="add" and js-ignore lowered to render-tool calls', () => {
    const emitted = emitComponent({
      name: 'widget',
      regions: testRegions(viewWithDirectives),
      shape: 'single',
    });

    assert.match(emitted.entry, /\{\.\.\.submit\(add\)\}/);
    assert.match(emitted.entry, /\{\.\.\.ignore\(\)\}/);
  });

  it('unknown directive: collects diagnostic instead of throwing, entry is empty', () => {
    const view = `<input js-frobnicate="x" />\n`;

    const emitted = emitComponent({
      name: 'widget',
      regions: testRegions(view),
      shape: 'single',
      frames: false,
    });

    // No throw — the error is reported and entry is empty.
    assert.equal(emitted.entry, '');
    assert.ok(emitted.diagnostics.length >= 1);
    const d = emitted.diagnostics.find((d) => d.code === 'unknown_directive');
    assert.ok(d !== undefined, 'should have unknown_directive error');
  });

  it('Shape 3: splits a clean component and returns an entry and a server part', () => {
    const regions = extractRegions(shape3Clean, 'widget.tsx');
    const emitted = emitComponent({
      name: 'widget',
      regions,
      shape: 'multi-file',
    });

    // The entry must NOT contain the migrated server function or model bindings.
    assert.doesNotMatch(emitted.entry, /function doWork/);
    assert.doesNotMatch(emitted.entry, /const stateSchema/);

    // The entry must still carry the component definition.
    assert.match(emitted.entry, /export const widget = defineComponent/);

    // The server part must exist and carry the migrated function.
    assert.ok(emitted.server !== undefined, 'expected a server part');
    assert.match(emitted.server ?? '', /function doWork/);

    // The model part must be forwarded too — dropping it would emit an
    // incomplete component (the entry imports from it).
    assert.ok(emitted.model !== undefined, 'expected a model part');
    assert.match(emitted.model ?? '', /const stateSchema/);
  });

  it('Shape 3 refusal: an unmigratable reference becomes a diagnostic, not a throw', () => {
    const regions = extractRegions(shape3Refusal, 'widget.tsx');
    const emitted = emitComponent({ name: 'widget', regions, shape: 'multi-file' });

    assert.equal(emitted.entry, '');
    const diag = emitted.diagnostics.find((d) => d.code === 'unmigratable_reference');
    assert.ok(diag !== undefined, 'expected an unmigratable_reference diagnostic');
    assert.equal(diag.severity, 'error');
  });

  it('result is frozen', () => {
    const regions = extractRegions(taskListFixture, 'task-list.tsx');
    const emitted = emitComponent({
      name: 'task-list',
      regions,
      shape: 'single',
    });

    assert.ok(Object.isFrozen(emitted));
  });

  it('template dialect: a <template> view region lowers to JSX and parses cleanly', () => {
    const view = [
      '<template>',
      '  <form js-submit="add">',
      '    <input js-model="title" />',
      '    <button js-if="title">Add</button>',
      '  </form>',
      '</template>',
    ].join('\n');

    const emitted = emitComponent({
      name: 'widget',
      regions: testRegions(view),
      shape: 'single',
    });

    assert.match(emitted.entry, /\{\.\.\.submit\('add'\)\}/);
    assert.match(emitted.entry, /\{\.\.\.bind\('title'\)\}/);
    assert.match(emitted.entry, /\{title \? \(<button>Add<\/button>\) : null\}/);
    assertParseOk(emitted.entry, 'widget.tsx');
  });

  it('regression: the shipped raw-JSX fixture is emitted unchanged', () => {
    const regions = extractRegions(taskListFixture, 'task-list.tsx');
    const emitted = emitComponent({
      name: 'task-list',
      regions,
      shape: 'single',
    });

    // The shipped dialect has no <template> block, so the U5 seam is a no-op
    // and the emitted entry must still carry the raw JSX render body.
    assert.match(emitted.entry, /defineComponent/);
    assert.doesNotMatch(emitted.entry, /<template>/);
  });
});

describe('emitComponent component resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'emit-resolve-'));
  const componentsDir = join(root, 'app', 'components');
  mkdirSync(componentsDir, { recursive: true });
  writeFileSync(join(componentsDir, 'counter.tsx'), 'export const Counter = 1;');

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const viewWithComponent = `const x = () => <Counter />;\n`;

  it('prepends an import for a capitalized tag when resolve is configured', () => {
    const emitted = emitComponent({
      name: 'widget',
      regions: testRegions(viewWithComponent),
      shape: 'single',
      resolve: { fromDir: componentsDir, rootDir: root },
    });

    assert.match(emitted.entry, /import \{ Counter \} from '\.\/counter\.js';/);
    assertParseOk(emitted.entry, 'widget.tsx');
  });

  it('does not resolve tags when resolve is absent', () => {
    const emitted = emitComponent({
      name: 'widget',
      regions: testRegions(viewWithComponent),
      shape: 'single',
    });

    assert.doesNotMatch(emitted.entry, /import \{ Counter \}/);
  });

  it('is idempotent: an already-imported tag is not duplicated', () => {
    const preamble = `import { Counter } from './counter.js';\n`;
    const emitted = emitComponent({
      name: 'widget',
      regions: testRegions(viewWithComponent, preamble),
      shape: 'single',
      resolve: { fromDir: componentsDir, rootDir: root },
    });

    const matches = emitted.entry.match(/import \{ Counter \}/g) ?? [];
    assert.equal(matches.length, 1);
  });

  it('reports a positioned unresolved_component diagnostic for a missing module', () => {
    const view = `const x = () => <Missing />;\n`;

    const emitted = emitComponent({
      name: 'widget',
      regions: testRegions(view),
      shape: 'single',
      resolve: { fromDir: componentsDir, rootDir: root },
    });

    assert.equal(emitted.entry, '');
    const diag = emitted.diagnostics.find((d) => d.code === 'unresolved_component');
    assert.ok(diag !== undefined, 'expected an unresolved_component diagnostic');
    assert.equal(diag.severity, 'error');
  });
});
