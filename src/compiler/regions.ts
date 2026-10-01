/**
 * Region extraction for single-file components.
 *
 * Components separate model/server/style/view concerns with line-comment
 * markers (`// #region name` ... `// #endregion name`). The scanner is a plain
 * line walk rather than an AST pass: the markers are comments, so they are not
 * part of the syntax tree, and a line scanner stays independent of the parser.
 */

import { CompilerError } from './errors.js';
import { lineStartOffsets } from './source-lines.js';

export type RegionName = 'model' | 'server' | 'style' | 'view';

export interface ComponentRegions {
  /**
   * Source text before the first region marker: the file-level doc comment and
   * the import block. It is part of the component (the regions reference the
   * imports), so the emitter must re-emit it or the output will not compile.
   */
  readonly preamble: string;
  readonly model: string;
  readonly server: string;
  readonly style: string;
  readonly view: string;
  /**
   * The absolute character offset of each region's first content character (the
   * first non-blank line after the `#region` marker). Used to convert a
   * template-relative offset into a file-relative `line:column` for diagnostics.
   */
  readonly offsets: Readonly<Record<RegionName | 'preamble', number>>;
}

const REGION_NAMES: readonly RegionName[] = ['model', 'server', 'style', 'view'];

const REGION_START = /^\s*\/\/\s*#region\s+(\w+)\s*$/;
const REGION_END = /^\s*\/\/\s*#endregion\s+(\w+)\s*$/;

/**
 * Trim only blank lines from the edges of a region body, preserving the
 * internal indentation and spacing of the remaining lines verbatim. Returns the
 * kept text and the index of its first kept line within `lines` (so the caller
 * can map it to an absolute offset); `startIndex` is `lines.length` for an
 * all-blank body.
 */
function trimBlankLines(lines: readonly string[]): { text: string; startIndex: number } {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === '') {
    end -= 1;
  }
  return { text: lines.slice(start, end).join('\n'), startIndex: start };
}

/**
 * Extract the four required regions from a component source string. Bodies are
 * returned in declaration-agnostic order (the returned object is fixed by
 * region name), verbatim apart from edge blank-line trimming.
 */
export function extractRegions(code: string, _fileName: string): ComponentRegions {
  const lines = code.split(/\r?\n/);
  const lineStarts = lineStartOffsets(code);
  const bodies = new Map<RegionName, string[]>();
  // Raw first-line index of each region body (the line after its `#region`).
  const bodyStartLine = new Map<RegionName, number>();
  const preambleLines: string[] = [];

  let open: { name: RegionName; lines: string[]; startLine: number } | undefined;
  let seenFirstRegion = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const start = REGION_START.exec(line);
    if (start) {
      seenFirstRegion = true;
      const name = start[1];
      if (open !== undefined) {
        // A new region opens before the previous one closed.
        throw new CompilerError(`Region '${open.name}' is not closed`, 'invalid_region', open.name);
      }
      if (bodies.has(name as RegionName)) {
        throw new CompilerError(`Duplicate region '${name}'`, 'invalid_region', name);
      }
      open = { name: name as RegionName, lines: [], startLine: lineIndex + 1 };
      continue;
    }

    const end = REGION_END.exec(line);
    if (end) {
      const name = end[1];
      if (open === undefined) {
        throw new CompilerError(
          `Region '${name}' closed without an open region`,
          'invalid_region',
          name,
        );
      }
      if (open.name !== name) {
        throw new CompilerError(
          `Region '${open.name}' closed by '#endregion ${name}'`,
          'invalid_region',
          open.name,
        );
      }
      bodies.set(open.name, open.lines);
      bodyStartLine.set(open.name, open.startLine);
      open = undefined;
      continue;
    }

    if (open !== undefined) {
      open.lines.push(line);
    } else if (!seenFirstRegion) {
      // Text before the first region marker is the file preamble (doc comment
      // and imports). It is part of the component and must be preserved.
      preambleLines.push(line);
    }
  }

  if (open !== undefined) {
    throw new CompilerError(`Region '${open.name}' is not closed`, 'invalid_region', open.name);
  }

  for (const name of REGION_NAMES) {
    if (!bodies.has(name)) {
      throw new CompilerError(`Missing required region '${name}'`, 'missing_region', name);
    }
  }

  const offsetOf = (name: RegionName): number => {
    const trimmed = trimBlankLines(bodies.get(name) ?? []);
    const rawStart = bodyStartLine.get(name) ?? 0;
    return lineStarts[rawStart + trimmed.startIndex] ?? 0;
  };

  const get = (name: RegionName): string => trimBlankLines(bodies.get(name) ?? []).text;
  const preamble = trimBlankLines(preambleLines);
  return {
    preamble: preamble.text,
    model: get('model'),
    server: get('server'),
    style: get('style'),
    view: get('view'),
    offsets: Object.freeze({
      preamble: lineStarts[preamble.startIndex] ?? 0,
      model: offsetOf('model'),
      server: offsetOf('server'),
      style: offsetOf('style'),
      view: offsetOf('view'),
    }),
  };
}
