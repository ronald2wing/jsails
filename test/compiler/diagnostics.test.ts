import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DiagnosticBag } from '../../src/compiler/diagnostics.js';
import type { SourceRange } from '../../src/compiler/errors.js';

function range(
  startLine: number,
  startCol: number,
  endLine = startLine,
  endCol = startCol + 1,
): SourceRange {
  return { start: { line: startLine, column: startCol }, end: { line: endLine, column: endCol } };
}

describe('DiagnosticBag', () => {
  it('starts empty with no errors', () => {
    const bag = new DiagnosticBag();
    assert.equal(bag.hasErrors, false);
    assert.deepEqual(bag.toList(), []);
  });

  it('reports hasErrors only for error severity', () => {
    const warnOnly = new DiagnosticBag();
    warnOnly.warn('unsupported_position', 'a warning', range(1, 1));
    assert.equal(warnOnly.hasErrors, false);

    const withError = new DiagnosticBag();
    withError.error('unparseable', 'bad', range(1, 1));
    assert.equal(withError.hasErrors, true);
  });

  it('orders diagnostics by source position regardless of insertion order', () => {
    const bag = new DiagnosticBag();
    bag.error('unparseable', 'second', range(3, 1));
    bag.error('unparseable', 'first', range(1, 1));
    bag.error('unparseable', 'middle', range(2, 5));
    const list = bag.toList();
    assert.deepEqual(
      list.map((d) => d.message),
      ['first', 'middle', 'second'],
    );
  });

  it('carries severity, code, message, and range', () => {
    const bag = new DiagnosticBag();
    bag.error('unknown_directive', 'no such directive', range(2, 3), [
      { message: 'declared here', range: range(1, 1) },
    ]);
    const [diagnostic] = bag.toList();
    assert.ok(diagnostic !== undefined);
    assert.equal(diagnostic.severity, 'error');
    assert.equal(diagnostic.code, 'unknown_directive');
    assert.equal(diagnostic.message, 'no such directive');
    assert.deepEqual(diagnostic.range, range(2, 3));
    assert.equal(diagnostic.related?.length, 1);
    assert.equal(diagnostic.related?.[0]?.message, 'declared here');
  });

  it('returns a frozen list of frozen diagnostics', () => {
    const bag = new DiagnosticBag();
    bag.error('unparseable', 'x', range(1, 1));
    const list = bag.toList();
    assert.ok(Object.isFrozen(list));
    assert.ok(Object.isFrozen(list[0]));
  });

  it('renders a code frame from the source', () => {
    const source = ['const a = 1;', 'const b = ;', 'const c = 3;'].join('\n');
    const bag = new DiagnosticBag({ source, frameContext: 1 });
    bag.error('unparseable', 'bad line', range(2, 10));
    const [diagnostic] = bag.toList();
    assert.ok(diagnostic !== undefined);
    assert.ok(diagnostic.frame.includes('const b = ;'));
    assert.ok(diagnostic.frame.includes('^'));
  });

  it('renders no frame when frames are disabled', () => {
    const source = 'bad';
    const bag = new DiagnosticBag({ source, frames: false });
    bag.error('unparseable', 'x', range(1, 1));
    assert.equal(bag.toList()[0]?.frame, '');
  });

  it('renders an empty frame when no source is available', () => {
    const bag = new DiagnosticBag();
    bag.error('unparseable', 'x', range(1, 1));
    assert.equal(bag.toList()[0]?.frame, '');
  });

  it('keeps value-free messages intact through a frame render', () => {
    // The frame may contain source, but the message must never be rewritten.
    const source = 'SECRET_TOKEN';
    const bag = new DiagnosticBag({ source });
    bag.error('unparseable', 'a value-free message', range(1, 1, 1, 13));
    const diagnostic = bag.toList()[0];
    assert.ok(diagnostic !== undefined);
    assert.equal(diagnostic.message, 'a value-free message');
    assert.ok(!diagnostic.message.includes('SECRET_TOKEN'));
  });

  it('converts absolute offsets into a 1-based range', () => {
    const source = 'line one\nline two';
    const bag = new DiagnosticBag({ source });
    // Offset 9 is the first character of the second line.
    const rangeFromOffsets = bag.range(9, 13);
    assert.deepEqual(rangeFromOffsets, {
      start: { line: 2, column: 1 },
      end: { line: 2, column: 5 },
    });
  });

  it('treats a zero-width offset span as a one-character caret', () => {
    const bag = new DiagnosticBag({ source: 'abc' });
    const rangeFromOffsets = bag.range(1, 1);
    assert.deepEqual(rangeFromOffsets, {
      start: { line: 1, column: 2 },
      end: { line: 1, column: 3 },
    });
  });

  it('records a diagnostic from offsets via errorAt', () => {
    const source = 'hello world';
    const bag = new DiagnosticBag({ source });
    bag.errorAt('unknown_directive', 'bad', 6, 11);
    const diagnostic = bag.toList()[0];
    assert.ok(diagnostic !== undefined);
    assert.deepEqual(diagnostic.range, {
      start: { line: 1, column: 7 },
      end: { line: 1, column: 12 },
    });
  });

  it('records a warning from offsets via warnAt', () => {
    const bag = new DiagnosticBag({ source: 'x' });
    bag.warnAt('unsupported_position', 'heads up', 0, 1);
    const diagnostic = bag.toList()[0];
    assert.ok(diagnostic !== undefined);
    assert.equal(diagnostic.severity, 'warning');
    assert.equal(bag.hasErrors, false);
  });
});
