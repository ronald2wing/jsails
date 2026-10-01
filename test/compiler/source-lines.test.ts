import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lineStartOffsets, offsetToPoint } from '../../src/compiler/source-lines.js';

describe('lineStartOffsets', () => {
  it('starts the first line at offset 0', () => {
    assert.deepEqual(lineStartOffsets('abc'), [0]);
  });

  it('records the offset after each newline', () => {
    assert.deepEqual(lineStartOffsets('a\nbb\nccc'), [0, 2, 5]);
  });

  it('treats a trailing newline as opening a final empty line', () => {
    assert.deepEqual(lineStartOffsets('a\n'), [0, 2]);
  });

  it('counts a CRLF separator as part of the previous line', () => {
    assert.deepEqual(lineStartOffsets('a\r\nb'), [0, 3]);
  });

  it('returns a frozen array', () => {
    assert.ok(Object.isFrozen(lineStartOffsets('a\nb')));
  });
});

describe('offsetToPoint', () => {
  const source = 'abc\ndef\nghi';
  const offsets = lineStartOffsets(source);

  it('converts an offset on the first line', () => {
    assert.deepEqual(offsetToPoint(offsets, 1), { line: 1, column: 2 });
  });

  it('converts the first character of a line to column 1', () => {
    assert.deepEqual(offsetToPoint(offsets, 4), { line: 2, column: 1 });
    assert.deepEqual(offsetToPoint(offsets, 8), { line: 3, column: 1 });
  });

  it('converts an offset mid-line', () => {
    assert.deepEqual(offsetToPoint(offsets, 6), { line: 2, column: 3 });
  });

  it('resolves an offset at end of source', () => {
    assert.deepEqual(offsetToPoint(offsets, source.length), { line: 3, column: 4 });
  });

  it('returns line 1 column 1 for an empty offset table', () => {
    assert.deepEqual(offsetToPoint([], 5), { line: 1, column: 1 });
  });

  it('returns a frozen point', () => {
    assert.ok(Object.isFrozen(offsetToPoint(offsets, 0)));
  });
});
