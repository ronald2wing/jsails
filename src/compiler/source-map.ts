/**
 * Source-map construction for the component compiler.
 *
 * The compiler lowers a component (a `.jsails` single-file component or a
 * `#region` `.tsx`) into a plain `.tsx` module. Because the emitted module is
 * consumed by TypeScript and the browser, a stack trace, a Vite overlay, or a
 * devtools "jump to source" must resolve a generated position back to the
 * author's original position. This module builds that map.
 *
 * Why hand-rolled: MagicString ships a source-map generator, but the bundled
 * `rolldown` fork's `RolldownMagicString.generateMap`/`generateDecodedMap`
 * return an empty object (verified against rolldown 1.2.12), so they cannot
 * produce a map. The builder here is self-contained and dependency-free.
 *
 * Fidelity is line-granular, and that is exact for this emitter rather than an
 * approximation: the directive lowering (`emit.ts`'s regex replace) rewrites
 * within a line, and the template lowerer concatenates fragments that contain no
 * newlines, so both preserve the source's line structure. Each emitted line that
 * carries a verbatim source line maps to that line; every synthesized line
 * (imports, region markers, the `defineComponent` skeleton, indentation-only
 * wrappers) is emitted explicitly unmapped instead of being lied onto a nearby
 * line. `sourcesContent` always carries the original file, so any mapping that
 * does resolve lands in the author's real source.
 *
 * Generated lines and columns are 0-based (the source-map convention); the
 * compiler's own positions are 1-based, so callers subtract one when they
 * convert an `offsetToPoint` result.
 */

/**
 * The map object a bundler transform hook accepts (`ExistingRawSourceMap`):
 * `mappings` is a VLQ-encoded string, and `sources`/`sourcesContent`/`names`
 * accompany it.
 */
export interface ComponentSourceMap {
  readonly version: 3;
  readonly file: string;
  readonly sources: readonly string[];
  readonly sourcesContent: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
  readonly toString: () => string;
}

/** Options for {@link SourceMapBuilder.build}. */
export interface SourceMapBuildOptions {
  /** The generated module's filename, recorded as the map's `file`. */
  readonly file: string;
}

interface Segment {
  readonly genLine: number;
  readonly genCol: number;
  /** `null` marks a generated position with no source origin (unmapped). */
  readonly src: { readonly line: number; readonly col: number } | null;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VLQ_SHIFT = 5;
const VLQ_CONTINUATION = 1 << VLQ_SHIFT;
const VLQ_MASK = VLQ_CONTINUATION - 1;

/**
 * Encode one integer as a base64 VLQ string (the source-map encoding). Negative
 * values carry their sign in the low bit, and each 6-bit group reserves its
 * high bit for continuation.
 */
function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = vlq & VLQ_MASK;
    vlq >>>= VLQ_SHIFT;
    if (vlq > 0) {
      digit |= VLQ_CONTINUATION;
    }
    out += BASE64[digit];
  } while (vlq > 0);
  return out;
}

/**
 * Accumulates generated→source mappings and renders them as a component source
 * map. Mappings are added in generated order (non-decreasing line, then column);
 * `build` groups them into the per-line `mappings` string the format requires.
 */
export class SourceMapBuilder {
  private readonly segments: Segment[] = [];
  private readonly sourceLines: readonly number[];

  constructor(
    private readonly sourceContent: string,
    private readonly sourceName: string,
    sourceLineStarts: readonly number[],
  ) {
    this.sourceLines = sourceLineStarts;
  }

  /**
   * Map generated `(genLine, genCol)` to original `(srcLine, srcCol)`, all
   * 0-based. Callers convert a 1-based `offsetToPoint` result by subtracting one.
   */
  addMapping(genLine: number, genCol: number, srcLine: number, srcCol: number): void {
    this.segments.push({ genLine, genCol, src: { line: srcLine, col: srcCol } });
  }

  /**
   * Record that generated `(genLine, genCol)` has no source origin. Emitting an
   * explicit unmapped segment prevents a consumer from attributing synthesized
   * output to whatever mapping preceded it.
   */
  markUnmapped(genLine: number, genCol: number): void {
    this.segments.push({ genLine, genCol, src: null });
  }

  /**
   * Map each line of a verbatim block one-to-one. `genStartLine` is the 0-based
   * generated line where the block's first line lands; `srcStartLine` is the
   * 0-based source line of the block's first line. An optional generated column
   * offsets every mapping (used when the emitter indents a block).
   *
   * A block whose text is empty adds nothing. A block whose source start offset
   * is unknown (`srcStartLine` negative) is emitted unmapped line-by-line so the
   * output still cannot be mis-attributed.
   */
  addVerbatimBlock(text: string, genStartLine: number, srcStartLine: number, genCol = 0): number {
    const lineCount = text.split('\n').length;
    for (let index = 0; index < lineCount; index += 1) {
      const genLine = genStartLine + index;
      if (srcStartLine < 0) {
        this.markUnmapped(genLine, genCol);
        continue;
      }
      this.addMapping(genLine, genCol, srcStartLine + index, 0);
    }
    return genStartLine + lineCount;
  }

  /** The 0-based source line containing `offset`, per the supplied line starts. */
  sourceLineAt(offset: number): number {
    let low = 0;
    let high = this.sourceLines.length - 1;
    if (high < 0) {
      return 0;
    }
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.sourceLines[mid] ?? 0) <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }

  /**
   * Render the accumulated mappings as a component source map, or `null` when no
   * mapping was recorded (a caller that produced no code has no map to emit).
   */
  build(options: SourceMapBuildOptions): ComponentSourceMap | null {
    if (this.segments.length === 0) {
      return null;
    }
    const ordered = [...this.segments].sort((a, b) =>
      a.genLine === b.genLine ? a.genCol - b.genCol : a.genLine - b.genLine,
    );

    const mappings = renderMappings(ordered);
    const map: ComponentSourceMap = {
      version: 3,
      file: options.file,
      sources: [this.sourceName],
      sourcesContent: [this.sourceContent],
      names: [],
      mappings,
      toString: () => JSON.stringify(map),
    };
    return map;
  }
}

/**
 * Group ordered segments into the source-map `mappings` string.
 *
 * The VLQ fields are deltas: generated column resets per line and is relative
 * within a line; source index, source line, and source column are relative to the
 * previous *mapped* segment across the whole map. An unmapped segment emits a
 * single empty field (the format's way to say "no source here").
 */
function renderMappings(segments: readonly Segment[]): string {
  let out = '';
  let prevGenLine = 0;
  let prevGenCol = 0;
  let prevSrcIndex = 0;
  let prevSrcLine = 0;
  let prevSrcCol = 0;
  let firstInLine = true;

  for (const segment of segments) {
    while (prevGenLine < segment.genLine) {
      out += ';';
      prevGenLine += 1;
      prevGenCol = 0;
      firstInLine = true;
    }
    if (!firstInLine) {
      out += ',';
    }
    firstInLine = false;

    out += encodeVlq(segment.genCol - prevGenCol);
    prevGenCol = segment.genCol;

    if (segment.src !== null) {
      // Source index is always 0 (one source per map), so its delta is 0.
      out += encodeVlq(0 - prevSrcIndex);
      prevSrcIndex = 0;
      out += encodeVlq(segment.src.line - prevSrcLine);
      prevSrcLine = segment.src.line;
      out += encodeVlq(segment.src.col - prevSrcCol);
      prevSrcCol = segment.src.col;
    }
  }
  return out;
}
