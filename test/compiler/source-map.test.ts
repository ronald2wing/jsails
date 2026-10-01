import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourceMapBuilder } from '../../src/compiler/source-map.js';
import { lineStartOffsets } from '../../src/compiler/source-lines.js';

/** Build a map over `source` with a single char mapping and return its `mappings`. */
function singleMapping(
  source: string,
  genLine: number,
  genCol: number,
  srcLine: number,
  srcCol: number,
): string {
  const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
  builder.addMapping(genLine, genCol, srcLine, srcCol);
  const map = builder.build({ file: 'out.js' });
  assert.ok(map !== null);
  return map.mappings;
}

describe('SourceMapBuilder', () => {
  it('returns null when no mapping was added', () => {
    const builder = new SourceMapBuilder(
      'const a = 1;\n',
      'a.tsx',
      lineStartOffsets('const a = 1;\n'),
    );
    assert.equal(builder.build({ file: 'out.js' }), null);
  });

  it('records file, version, source name, and sourcesContent', () => {
    const source = 'const a = 1;\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    builder.addMapping(0, 0, 0, 0);
    const map = builder.build({ file: 'out.js' });
    assert.ok(map !== null);
    assert.equal(map.version, 3);
    assert.equal(map.file, 'out.js');
    assert.deepEqual(map.sources, ['a.tsx']);
    assert.deepEqual(map.sourcesContent, [source]);
    assert.deepEqual(map.names, []);
  });

  it('encodes a zero delta segment as "AAAA"', () => {
    // genCol 0, srcIndex 0, srcLine 0, srcCol 0 → four zero VLQs.
    assert.equal(singleMapping('x\n', 0, 0, 0, 0), 'AAAA');
  });

  it('increments the generated column within a line with a comma separator', () => {
    const source = 'abcdef\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    builder.addMapping(0, 0, 0, 0);
    builder.addMapping(0, 3, 0, 3);
    const map = builder.build({ file: 'out.js' });
    assert.ok(map !== null);
    // Second segment: genCol delta 3 → 'G', source deltas 0,0,3 → 'A','A','G'.
    assert.equal(map.mappings, 'AAAA,GAAG');
  });

  it('separates generated lines with a semicolon and resets the column delta', () => {
    const source = 'a\nb\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    builder.addMapping(0, 0, 0, 0);
    builder.addMapping(1, 0, 1, 0);
    const map = builder.build({ file: 'out.js' });
    assert.ok(map !== null);
    // Line 1 col 0, source line delta 1 → genCol 'A', srcIndex 'A', srcLine 'C', srcCol 'A'.
    assert.equal(map.mappings, 'AAAA;AACA');
  });

  it('emits an empty segment for an unmapped position', () => {
    const source = 'a\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    builder.addMapping(0, 0, 0, 0);
    builder.markUnmapped(1, 0);
    const map = builder.build({ file: 'out.js' });
    assert.ok(map !== null);
    // Line 1 has a single field (genCol 0) with no source fields → 'A'.
    assert.equal(map.mappings, 'AAAA;A');
  });

  it('sorts mappings by generated position before rendering', () => {
    const source = 'a\nb\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    builder.addMapping(1, 0, 1, 0);
    builder.addMapping(0, 0, 0, 0);
    const map = builder.build({ file: 'out.js' });
    assert.ok(map !== null);
    assert.equal(map.mappings, 'AAAA;AACA');
  });

  it('maps each line of a verbatim block one-to-one', () => {
    const source = 'HEAD\none\ntwo\nthree\nTAIL\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    // A block whose first line is source line 1 (0-based), placed at generated line 2.
    const next = builder.addVerbatimBlock('one\ntwo\nthree', 2, 1);
    assert.equal(next, 5);
    const map = builder.build({ file: 'out.js' });
    assert.ok(map !== null);
    // Generated line 2 → source line 1, line 3 → 2, line 4 → 3.
    assert.equal(map.mappings, ';;AACA;AACA;AACA');
  });

  it('emits an indented verbatim block with a generated column offset', () => {
    const source = 'one\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    builder.addVerbatimBlock('one', 0, 0, 6);
    const map = builder.build({ file: 'out.js' });
    assert.ok(map !== null);
    // genCol 6 → 'M', then source deltas 0,0,0 → 'AAA'.
    assert.equal(map.mappings, 'MAAA');
  });

  it('emits an unmapped block when the source line is unknown', () => {
    const source = 'a\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    builder.addVerbatimBlock('x\ny', 0, -1);
    const map = builder.build({ file: 'out.js' });
    assert.ok(map !== null);
    assert.equal(map.mappings, 'A;A');
  });

  it('resolves a source offset to its 0-based line', () => {
    const source = 'aa\nbb\ncc\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    assert.equal(builder.sourceLineAt(2), 0);
    assert.equal(builder.sourceLineAt(3), 1);
    assert.equal(builder.sourceLineAt(6), 2);
    // `'aa\nbb\ncc\n'` has a trailing empty line 3 (offset 9), so a past-the-end
    // offset clamps to it, matching `offsetToPoint`.
    assert.equal(builder.sourceLineAt(9), 3);
    assert.equal(builder.sourceLineAt(999), 3);
  });

  it('serializes to JSON via toString', () => {
    const source = 'a\n';
    const builder = new SourceMapBuilder(source, 'a.tsx', lineStartOffsets(source));
    builder.addMapping(0, 0, 0, 0);
    const map = builder.build({ file: 'out.js' });
    assert.ok(map !== null);
    const parsed = JSON.parse(map.toString()) as { mappings: string; version: number };
    assert.equal(parsed.mappings, 'AAAA');
    assert.equal(parsed.version, 3);
  });
});
