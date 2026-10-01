import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  collectComponentTags,
  collectTemplateComponents,
  resolveComponentTags,
  type ComponentReporter,
  type ComponentTagRef,
} from '../../src/compiler/resolve-components.js';
import { parseTemplate } from '../../src/compiler/template-ast.js';

/** A single raw report captured by {@link recordingReporter}. */
interface CapturedReport {
  readonly code: string;
  readonly message: string;
  readonly subject: string;
  readonly start: number;
  readonly end: number;
}

/**
 * A reporter that records raw reports, mirroring how the emitter threads a
 * `DiagnosticBag` (offsets in, bag converts to line/column). Returns the
 * recorded list so each test can assert on positions.
 */
function recordingReporter(): {
  report: ComponentReporter;
  reports: CapturedReport[];
} {
  const reports: CapturedReport[] = [];
  return {
    report: (code, message, subject, start, end) => {
      reports.push({ code, message, subject, start, end });
    },
    reports,
  };
}

describe('collectComponentTags', () => {
  it('collects capitalized tags with positions, de-duplicated and sorted', () => {
    const view = `const x = () => (
      <div>
        <Counter />
        <TaskList />
        <Counter />
      </div>
    );`;
    const refs = collectComponentTags(view, 0, () => {});
    assert.deepEqual(
      refs.map((r) => r.tag),
      ['Counter', 'TaskList'],
    );
    // The position spans the whole opening element (an honest highlight).
    const counter = refs.find((r) => r.tag === 'Counter');
    assert.ok(counter !== undefined);
    assert.equal(view.slice(counter.start, counter.end), '<Counter />');
  });

  it('offsets every position by the supplied base offset', () => {
    const view = `const x = () => <Counter />;`;
    const refs = collectComponentTags(view, 100, () => {});
    const counter = refs.find((r) => r.tag === 'Counter');
    assert.ok(counter !== undefined);
    assert.equal(view.slice(counter.start - 100, counter.end - 100), '<Counter />');
  });

  it('ignores intrinsic (lowercase) tags', () => {
    const view = `const x = () => <div><span>hi</span></div>;`;
    assert.deepEqual(
      collectComponentTags(view, 0, () => {}),
      [],
    );
  });

  it('records the root of a member-expression tag', () => {
    const view = `const x = () => <Foo.Bar />;`;
    const refs = collectComponentTags(view, 0, () => {});
    assert.deepEqual(
      refs.map((r) => r.tag),
      ['Foo'],
    );
  });

  it('returns a frozen array of frozen entries', () => {
    const refs = collectComponentTags(`const x = () => <Counter />;`, 0, () => {});
    assert.ok(Object.isFrozen(refs));
    assert.ok(refs.every((ref) => Object.isFrozen(ref)));
  });

  it('ignores a dynamic component lowered to an h call', () => {
    // `<component :is="X" />` lowers to `{h(X, {})}` — no capitalized JSX tag,
    // so the resolver must not treat `X` as a component to import.
    const view = `const x = () => <div>{h(X, {})}</div>;`;
    assert.deepEqual(
      collectComponentTags(view, 0, () => {}),
      [],
    );
  });

  it('reports a positioned unparseable diagnostic for invalid view source', () => {
    const { report, reports } = recordingReporter();
    const refs = collectComponentTags('const x = <div>', 42, report);
    assert.deepEqual(refs, []);
    assert.equal(reports.length, 1);
    const [diag] = reports;
    assert.ok(diag !== undefined);
    assert.equal(diag.code, 'unparseable');
    assert.equal(diag.start, 42);
  });
});

describe('collectTemplateComponents', () => {
  it('collects capitalized element tags from a parsed template tree', () => {
    const nodes = parseTemplate('<div><Counter /><TaskList /></div>', () => {});
    const refs = collectTemplateComponents(nodes, 0);
    assert.deepEqual(
      refs.map((r) => r.tag),
      ['Counter', 'TaskList'],
    );
  });

  it('records the source range of a nested capitalized tag', () => {
    const source = '<section><Counter /></section>';
    const nodes = parseTemplate(source, () => {});
    const refs = collectTemplateComponents(nodes, 0);
    const counter = refs.find((r) => r.tag === 'Counter');
    assert.ok(counter !== undefined);
    assert.equal(source.slice(counter.start, counter.end), '<Counter />');
  });

  it('offsets positions by the base offset and ignores intrinsic tags', () => {
    const source = '<div><span>hi</span></div>';
    const nodes = parseTemplate(source, () => {});
    assert.deepEqual(collectTemplateComponents(nodes, 50), []);
  });
});

describe('resolveComponentTags', () => {
  const root = mkdtempSync(join(tmpdir(), 'resolve-components-'));
  const componentsDir = join(root, 'app', 'components');
  mkdirSync(componentsDir, { recursive: true });
  writeFileSync(join(componentsDir, 'counter.tsx'), 'export const Counter = 1;');
  writeFileSync(join(componentsDir, 'task-list.tsx'), 'export const TaskList = 1;');

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ref = (tag: string): ComponentTagRef => Object.freeze({ tag, start: 0, end: tag.length });

  it('resolves a tag to its kebab-case module with a .js specifier', () => {
    const resolved = resolveComponentTags(
      [ref('Counter'), ref('TaskList')],
      {
        fromDir: componentsDir,
        rootDir: root,
      },
      () => {},
    );
    assert.equal(resolved.length, 2);
    const [counter, taskList] = resolved;
    assert.ok(counter !== undefined && taskList !== undefined);
    assert.equal(counter.tag, 'Counter');
    assert.equal(counter.specifier, './counter.js');
    assert.equal(taskList.tag, 'TaskList');
    assert.equal(taskList.specifier, './task-list.js');
  });

  it('builds a relative specifier from a different directory', () => {
    const resolved = resolveComponentTags(
      [ref('Counter')],
      {
        fromDir: join(root, 'app'),
        rootDir: root,
      },
      () => {},
    );
    const [counter] = resolved;
    assert.ok(counter !== undefined);
    assert.equal(counter.specifier, './components/counter.js');
  });

  it('returns a frozen list of frozen entries', () => {
    const resolved = resolveComponentTags(
      [ref('Counter')],
      { fromDir: componentsDir, rootDir: root },
      () => {},
    );
    const [counter] = resolved;
    assert.ok(counter !== undefined);
    assert.ok(Object.isFrozen(resolved));
    assert.ok(Object.isFrozen(counter));
  });

  it('reports a positioned unresolved_component and skips the missing tag', () => {
    const { report, reports } = recordingReporter();
    const resolved = resolveComponentTags(
      [Object.freeze({ tag: 'Missing', start: 7, end: 14 }), ref('Counter')],
      { fromDir: componentsDir, rootDir: root },
      report,
    );
    // The resolvable tag is still returned; the missing one is dropped.
    assert.deepEqual(
      resolved.map((r) => r.tag),
      ['Counter'],
    );
    assert.equal(reports.length, 1);
    const [diag] = reports;
    assert.ok(diag !== undefined);
    assert.equal(diag.code, 'unresolved_component');
    assert.equal(diag.subject, 'Missing');
    assert.equal(diag.start, 7);
    assert.equal(diag.end, 14);
  });
});
